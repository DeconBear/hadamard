export const PYTHON_KERNEL_PROGRAM = String.raw`
import ast
import json
import os
import sys
import threading
import time
import traceback

PROTOCOL_OUT = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
PROTOCOL_IN = sys.stdin
NAMESPACE = {"__name__": "__main__"}
CURRENT_EXECUTION = None
RPC_SEQUENCE = 0
SEND_LOCK = threading.Lock()

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

def host_call(method, input_value=None):
    global RPC_SEQUENCE
    RPC_SEQUENCE += 1
    request_id = str(RPC_SEQUENCE)
    send({"v": 1, "type": "host_rpc", "executionId": CURRENT_EXECUTION,
          "request": {"id": request_id, "method": method, "input": input_value}})
    response_line = PROTOCOL_IN.readline()
    if not response_line:
        raise RuntimeError("Host RPC channel closed")
    envelope = json.loads(response_line)
    if envelope.get("type") != "host_rpc_result" or envelope.get("executionId") != CURRENT_EXECUTION:
        raise RuntimeError("Host RPC response did not match the active execution")
    response = envelope.get("response") or {}
    if response.get("id") != request_id:
        raise RuntimeError("Host RPC response ID mismatch")
    if not response.get("ok"):
        raise RuntimeError(response.get("error") or "Host RPC failed")
    return response.get("result")

class HadamardHost:
    def call(self, method, input_value=None):
        return host_call(method, input_value)
    def tool(self, name, input_value=None):
        return host_call("tool.call", {"name": name, "input": input_value or {}})
    def read(self, file_path, offset=None, limit=None):
        input_value = {"file_path": file_path}
        if offset is not None: input_value["offset"] = offset
        if limit is not None: input_value["limit"] = limit
        return self.tool("Read", input_value)
    def write(self, file_path, content):
        return self.tool("Write", {"file_path": file_path, "content": content})
    def search(self, pattern, path=None):
        input_value = {"pattern": pattern}
        if path is not None: input_value["path"] = path
        return self.tool("Grep", input_value)
    def artifact(self, name, content, media_type="text/plain"):
        return host_call("artifact.put", {"name": name, "content": content, "mediaType": media_type})

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

def execute(execution_id, code):
    global CURRENT_EXECUTION
    CURRENT_EXECUTION = execution_id
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

send({"v": 1, "type": "ready", "pid": os.getpid()})
for line in PROTOCOL_IN:
    command = {}
    try:
        command = json.loads(line)
        if command.get("v") != 1:
            raise RuntimeError("Unsupported protocol version")
        if command.get("type") == "shutdown":
            break
        if command.get("type") == "execute":
            execute(command["executionId"], command["code"])
    except BaseException:
        send({"v": 1, "type": "result", "executionId": command.get("executionId", "unknown"),
              "ok": False, "error": traceback.format_exc(limit=20), "durationMs": 0})
`;
