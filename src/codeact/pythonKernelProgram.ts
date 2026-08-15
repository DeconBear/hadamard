export const PYTHON_KERNEL_PROGRAM = String.raw`
import ast
import json
import os
import queue
import sys
import threading
import time
import traceback

PROTOCOL_OUT = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
PROTOCOL_IN = sys.stdin
try:
    # The host-RPC router holds a pending read on this pipe for the kernel's
    # whole lifetime. A child process inheriting that read handle can hang on
    # Windows, so cell-spawned subprocesses must not inherit stdin.
    os.set_inheritable(sys.stdin.fileno(), False)
except Exception:
    pass
NAMESPACE = {"__name__": "__main__"}
CURRENT_EXECUTION = None
RPC_SEQUENCE = 0
SEND_LOCK = threading.Lock()
RPC_PENDING = {}
RPC_PENDING_LOCK = threading.Lock()
COMMAND_QUEUE = None

def send(message):
    with SEND_LOCK:
        PROTOCOL_OUT.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
        PROTOCOL_OUT.flush()

def drain_stream(read_fd, stream_name, execution_id):
    with os.fdopen(read_fd, "rb", buffering=0) as source:
        while True:
            chunk = source.read(8192)
            if not chunk:
                break
            send({"v": 1, "type": "stream", "executionId": execution_id,
                  "stream": stream_name, "delta": chunk.decode("utf-8", errors="replace")})

def begin_capture(execution_id):
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    saved_stdout = os.dup(1)
    saved_stderr = os.dup(2)
    stdout_read, stdout_write = os.pipe()
    stderr_read, stderr_write = os.pipe()
    stdout_thread = threading.Thread(target=drain_stream,
        args=(stdout_read, "stdout", execution_id), daemon=True)
    stderr_thread = threading.Thread(target=drain_stream,
        args=(stderr_read, "stderr", execution_id), daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    os.dup2(stdout_write, 1)
    os.dup2(stderr_write, 2)
    os.close(stdout_write)
    os.close(stderr_write)
    return saved_stdout, saved_stderr, stdout_thread, stderr_thread

def end_capture(capture):
    saved_stdout, saved_stderr, stdout_thread, stderr_thread = capture
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    os.dup2(saved_stdout, 1)
    os.dup2(saved_stderr, 2)
    os.close(saved_stdout)
    os.close(saved_stderr)
    stdout_thread.join(timeout=2.0)
    stderr_thread.join(timeout=2.0)

class HadamardToolError(RuntimeError):
    def __init__(self, tool_name, message):
        super().__init__(message)
        self.tool_name = tool_name

NAMESPACE["HadamardToolError"] = HadamardToolError

def host_call(method, input_value=None):
    global RPC_SEQUENCE
    with RPC_PENDING_LOCK:
        RPC_SEQUENCE += 1
        request_id = str(RPC_SEQUENCE)
        holder = {"event": threading.Event(), "response": None}
        RPC_PENDING[request_id] = holder
    send({"v": 1, "type": "host_rpc", "executionId": CURRENT_EXECUTION,
          "request": {"id": request_id, "method": method, "input": input_value}})
    holder["event"].wait()
    response = holder.get("response")
    if response is None:
        raise RuntimeError("Host RPC channel closed before the response arrived")
    if not response.get("ok"):
        raise RuntimeError(response.get("error") or "Host RPC failed")
    return response.get("result")

def _stdin_has_data():
    if os.name != "nt":
        return True
    try:
        import msvcrt
        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
    except Exception:
        return True
    try:
        import ctypes
        from ctypes import wintypes
        available = wintypes.DWORD()
        if ctypes.windll.kernel32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
            return available.value > 0
    except Exception:
        pass
    return True

def stdin_router():
    if os.name != "nt":
        for line in PROTOCOL_IN:
            _route_line(line)
        return
    # Windows: poll with PeekNamedPipe instead of holding a permanently
    # pending read on the stdin pipe. A blocking read outstanding while a
    # cell spawns child processes can wedge python.exe children that inherit
    # the handle, so only read when data is actually available. Read the raw
    # fd (never the text wrapper, which may buffer ahead past a line we are
    # not ready to route) and split lines ourselves.
    pending = b""
    while True:
        if _stdin_has_data():
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                _route_line(line.decode("utf-8", errors="replace"))
        else:
            time.sleep(0.01)

def _route_line(line):
    try:
        envelope = json.loads(line)
    except Exception:
        return
    if not isinstance(envelope, dict):
        return
    if envelope.get("type") == "host_rpc_result":
        response = envelope.get("response") or {}
        request_id = str(response.get("id"))
        with RPC_PENDING_LOCK:
            holder = RPC_PENDING.pop(request_id, None)
        if holder is not None:
            holder["response"] = response
            holder["event"].set()
        return
    COMMAND_QUEUE.put(envelope)

def parallel(callables, max_workers=8):
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(fn) for fn in callables]
        return [future.result() for future in futures]

class HadamardHost:
    def call(self, method, input_value=None):
        return host_call(method, input_value)
    def tool(self, name, input_value=None):
        try:
            return host_call("tool.call", {"name": name, "input": input_value or {}})
        except HadamardToolError:
            raise
        except RuntimeError as error:
            raise HadamardToolError(name, str(error)) from error
    def parallel(self, callables, max_workers=8):
        return parallel(callables, max_workers=max_workers)
    def read(self, file_path, offset=None, limit=None, **kwargs):
        input_value = {"file_path": file_path}
        if offset is not None: input_value["offset"] = offset
        if limit is not None: input_value["limit"] = limit
        input_value.update({key: value for key, value in kwargs.items() if value is not None})
        return self.tool("Read", input_value)
    def write(self, file_path, content, **kwargs):
        input_value = {"file_path": file_path, "content": content}
        input_value.update({key: value for key, value in kwargs.items() if value is not None})
        return self.tool("Write", input_value)
    def search(self, pattern, path=None, **kwargs):
        input_value = {"pattern": pattern}
        if path is not None: input_value["path"] = path
        input_value.update({key: value for key, value in kwargs.items() if value is not None})
        return self.tool("Grep", input_value)
    def artifact(self, name, content, media_type="text/plain"):
        return host_call("artifact.put", {"name": name, "content": content, "mediaType": media_type})
    def __getattr__(self, name):
        mapping = NAMESPACE.get("TOOL_NAME_MAP") or {}
        real_name = mapping.get(name)
        if real_name is None:
            raise AttributeError(name)
        def dispatch(**kwargs):
            try:
                return host_call("tool.call", {"name": real_name, "input": kwargs})
            except HadamardToolError:
                raise
            except RuntimeError as error:
                raise HadamardToolError(real_name, str(error)) from error
        return dispatch

NAMESPACE["hadamard"] = HadamardHost()

def structured(value):
    if value is None:
        return {"type": "none", "value": None, "repr": "None"}
    value_type = type(value).__name__
    try:
        json.dumps(value)
        return {"type": value_type, "value": value, "repr": repr(value)}
    except Exception:
        return {"type": value_type, "repr": repr(value)}

def resource_usage():
    try:
        import resource
        usage = resource.getrusage(resource.RUSAGE_SELF)
        return {"userCpuMs": usage.ru_utime * 1000.0,
                "systemCpuMs": usage.ru_stime * 1000.0,
                "maxRssKb": float(usage.ru_maxrss)}
    except Exception:
        return {}

def execute(execution_id, code, tool_name_map=None):
    global CURRENT_EXECUTION
    CURRENT_EXECUTION = execution_id
    NAMESPACE["TOOL_NAME_MAP"] = tool_name_map or {}
    started = time.monotonic()
    capture = begin_capture(execution_id)
    try:
        tree = ast.parse(code, mode="exec")
        last_value = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            expression = ast.Expression(tree.body.pop().value)
            ast.fix_missing_locations(expression)
            if tree.body:
                ast.fix_missing_locations(tree)
                exec(compile(tree, "<hadamard-codecell>", "exec"), NAMESPACE, NAMESPACE)
            last_value = eval(compile(expression, "<hadamard-codecell>", "eval"), NAMESPACE, NAMESPACE)
        else:
            exec(compile(tree, "<hadamard-codecell>", "exec"), NAMESPACE, NAMESPACE)
        envelope = {"v": 1, "type": "result", "executionId": execution_id, "ok": True,
                    "result": structured(last_value),
                    "durationMs": int((time.monotonic() - started) * 1000),
                    "resourceUsage": resource_usage()}
    except BaseException:
        envelope = {"v": 1, "type": "result", "executionId": execution_id, "ok": False,
                    "error": traceback.format_exc(limit=20),
                    "durationMs": int((time.monotonic() - started) * 1000),
                    "resourceUsage": resource_usage()}
    finally:
        end_capture(capture)
        send(envelope)
        CURRENT_EXECUTION = None

COMMAND_QUEUE = queue.Queue()
ROUTER_THREAD = threading.Thread(target=stdin_router, daemon=True)
ROUTER_THREAD.start()
send({"v": 1, "type": "ready", "pid": os.getpid()})
while True:
    command = COMMAND_QUEUE.get()
    try:
        if command.get("v") != 1:
            raise RuntimeError("Unsupported protocol version")
        if command.get("type") == "shutdown":
            break
        if command.get("type") == "execute":
            execute(command["executionId"], command["code"], command.get("toolNameMap"))
    except BaseException:
        send({"v": 1, "type": "result", "executionId": command.get("executionId", "unknown"),
              "ok": False, "error": traceback.format_exc(limit=20), "durationMs": 0})
`;
