#!/usr/bin/env python3
"""Hcanvas Python kernel sidecar (HKP 1.0, JSON-RPC over stdio).

Spawned by the Hcanvas sidecar broker for the python-kernel extension.
No third-party dependency is required. Matplotlib is never imported by the
kernel itself: when the user's code imports matplotlib.pyplot, figures created
by that execution are captured afterwards as image/png display_data.
"""

import ast
import base64
import inspect
import io
import json
import keyword
import os
import queue
import re
import rlcompleter
import sys
import threading
import time
import traceback

PROTOCOL_VERSION = "1.0"
PROTOCOL_OUT = sys.stdout.buffer
WRITE_LOCK = threading.Lock()
STOP = threading.Event()
INTERRUPT = threading.Event()
EXEC_QUEUE = queue.Queue()
CURRENT = {"executionId": ""}
NAMESPACE = {}


def send(message):
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with WRITE_LOCK:
        PROTOCOL_OUT.write(b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body)
        PROTOCOL_OUT.flush()


def respond(request_id, result):
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def respond_error(request_id, code, message):
    send({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


def chunks(text, size=60000):
    for index in range(0, len(text), size):
        yield text[index:index + size]


class OutputStream(io.TextIOBase):
    def __init__(self, name):
        self.name = name
        self.execution_id = ""

    def writable(self):
        return True

    def write(self, text):
        if not text:
            return 0
        if not isinstance(text, str):
            text = str(text)
        execution_id = CURRENT.get("executionId") or self.execution_id
        for chunk in chunks(text):
            notify("kernel/stream", {"executionId": execution_id, "name": self.name, "text": chunk})
        return len(text)

    def flush(self):
        return None


def hc_display(value):
    """Send a rich MIME bundle (or plain text) from user code."""
    execution_id = CURRENT.get("executionId", "")
    if isinstance(value, str):
        data = {"text/plain": value}
    elif isinstance(value, dict):
        data = value
    else:
        data = {"text/plain": repr(value)}
    notify("kernel/display_data", {"executionId": execution_id, "data": data})
    return None


def loaded_pyplot():
    """Return matplotlib.pyplot only when the user's code imported it."""
    module = sys.modules.get("matplotlib.pyplot")
    return module


def figure_numbers():
    pyplot = loaded_pyplot()
    if pyplot is None:
        return set()
    try:
        return set(pyplot.get_fignums())
    except Exception:
        return set()


def flush_figures(execution_id, before):
    pyplot = loaded_pyplot()
    if pyplot is None:
        return
    try:
        after = set(pyplot.get_fignums())
        for number in sorted(after - before):
            try:
                figure = pyplot.figure(number)
                buffer = io.BytesIO()
                figure.savefig(buffer, format="png", bbox_inches="tight", dpi=110)
                encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
                notify("kernel/display_data", {
                    "executionId": execution_id,
                    "data": {"text/plain": "<Figure>", "image/png": encoded},
                })
            except Exception:
                continue
            finally:
                try:
                    pyplot.close(figure)
                except Exception:
                    pass
    except Exception:
        return


def trace_function(frame, event, arg):
    if INTERRUPT.is_set():
        raise KeyboardInterrupt()
    # Only trace user cell frames: tracing import machinery is extremely slow.
    return trace_function if frame.f_code.co_filename == "<hcanvas-cell>" else None


def read_chunks():
    """Yield stdin chunks without holding the C stdin lock on Windows.

    A thread blocked in BufferedReader.read() keeps the CRT stdin lock while
    matplotlib/numpy load native DLLs, which can deadlock the import. On Windows
    we poll PeekNamedPipe with a short sleep instead; POSIX pipes can use the
    normal blocking read in a daemon thread.
    """
    if os.name == "nt":
        try:
            import ctypes
            import msvcrt
            handle = msvcrt.get_osfhandle(0)
            kernel32 = ctypes.windll.kernel32
            available = ctypes.c_uint32(0)
            while not STOP.is_set():
                try:
                    ok = kernel32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None)
                except Exception:
                    return
                if not ok:
                    return
                if available.value:
                    try:
                        chunk = os.read(0, min(65536, int(available.value)))
                    except Exception:
                        return
                    if not chunk:
                        return
                    yield chunk
                else:
                    time.sleep(0.01)
            return
        except Exception:
            pass
    stream = sys.stdin.buffer
    while not STOP.is_set():
        try:
            chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
        except Exception:
            return
        if not chunk:
            return
        yield chunk


def read_frames():
    buffer = b""
    for chunk in read_chunks():
        buffer += chunk
        while True:
            header_end = buffer.find(b"\r\n\r\n")
            if header_end < 0:
                break
            header = buffer[:header_end].decode("ascii", "replace")
            length = None
            for line in header.split("\r\n"):
                if line.lower().startswith("content-length:"):
                    try:
                        length = int(line.split(":", 1)[1].strip())
                    except ValueError:
                        length = None
            if length is None:
                buffer = buffer[header_end + 4:]
                break
            body_start = header_end + 4
            if len(buffer) < body_start + length:
                break
            body = buffer[body_start:body_start + length]
            buffer = buffer[body_start + length:]
            try:
                handle_message(body)
            except Exception:
                sys.stderr.write("hcanvas python kernel message error:\n" + traceback.format_exc())
                sys.stderr.flush()
    STOP.set()


def completion_prefix(code, cursor_pos):
    cursor_pos = max(0, min(len(code), int(cursor_pos)))
    match = re.search(r"[A-Za-z_][A-Za-z0-9_.]*$", code[:cursor_pos])
    return match.group(0) if match else "", cursor_pos


def complete_code(code, cursor_pos):
    prefix, cursor_pos = completion_prefix(code, cursor_pos)
    if not prefix:
        return {"matches": [], "cursorStart": cursor_pos, "cursorEnd": cursor_pos}
    matches = []
    try:
        completer = rlcompleter.Completer(NAMESPACE)
        for state in range(100):
            value = completer.complete(prefix, state)
            if value is None:
                break
            matches.append(value)
    except Exception:
        return {"matches": [], "cursorStart": cursor_pos - len(prefix), "cursorEnd": cursor_pos}
    return {"matches": sorted(set(matches))[:60], "cursorStart": cursor_pos - len(prefix), "cursorEnd": cursor_pos}


def inspect_code(code, cursor_pos):
    prefix, _ = completion_prefix(code, cursor_pos)
    if not prefix:
        return {}
    try:
        value = eval(prefix, NAMESPACE, NAMESPACE)
        try:
            signature = str(inspect.signature(value)) if callable(value) else repr(value)[:200]
        except (TypeError, ValueError):
            signature = repr(value)[:200]
        return {"name": prefix, "signature": signature, "documentation": inspect.getdoc(value) or ""}
    except Exception:
        return {}


def handle_message(body):
    try:
        message = json.loads(body.decode("utf-8"))
    except Exception:
        return
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}
    if method == "initialize":
        respond(request_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "language": "python",
            "languageVersion": sys.version.split()[0],
            "displayName": "Python " + sys.version.split()[0],
            "features": {"execute": True, "interrupt": True, "complete": True, "inspect": True, "variables": True},
            "mimeTypes": ["text/plain", "text/html", "image/png", "application/json", "text/markdown"],
        })
        return
    if method == "initialized":
        return
    if method == "kernel/interrupt":
        INTERRUPT.set()
        if request_id is not None:
            respond(request_id, {"ok": True})
        return
    if method == "kernel/shutdown":
        if request_id is not None:
            respond(request_id, {"ok": True})
        STOP.set()
        threading.Timer(0.05, lambda: os._exit(0)).start()
        return
    if method == "kernel/complete":
        respond(request_id, complete_code(params.get("code", ""), params.get("cursorPos", 0)))
        return
    if method == "kernel/inspect":
        respond(request_id, inspect_code(params.get("code", ""), params.get("cursorPos", 0)))
        return
    if method == "kernel/execute":
        EXEC_QUEUE.put((request_id, params))
        return
    if request_id is not None:
        respond_error(request_id, -32601, "Method not found: " + str(method))


HELPER_NAMES = {"hc_get", "hc_set", "hc_vars", "hc_display"}


def valid_variable_name(name):
    return isinstance(name, str) and name.isidentifier() and not keyword.iskeyword(name) and not name.startswith("__") and name not in HELPER_NAMES


def json_value(value):
    if hasattr(value, "tolist") and callable(value.tolist):
        value = value.tolist()
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode("utf-8")) > 256 * 1024:
        raise ValueError("Shared variable exceeds the 256 KiB limit")
    return json.loads(encoded)


def build_globals():
    namespace = {"__name__": "__main__", "__builtins__": __builtins__}
    namespace["hc_display"] = hc_display
    shared = {}
    namespace["hc_vars"] = shared

    def hc_get(name, default=None):
        if not valid_variable_name(name):
            raise ValueError("Invalid shared variable name")
        return namespace.get(name, shared.get(name, default))

    def hc_set(name, value):
        if not valid_variable_name(name):
            raise ValueError("Use a portable identifier that is not a language keyword")
        shared[name] = json_value(value)
        namespace[name] = value

    namespace["hc_get"] = hc_get
    namespace["hc_set"] = hc_set
    return namespace


def publish_variables(namespace):
    shared = namespace["hc_vars"]
    for name, original in list(shared.items()):
        if not valid_variable_name(name):
            continue
        try:
            shared[name] = json_value(namespace.get(name, original))
        except Exception as error:
            notify("kernel/stream", {
                "executionId": CURRENT.get("executionId", ""),
                "name": "stderr",
                "text": "Shared variable " + name + " was not updated: " + str(error) + "\n",
            })
    if shared:
        notify("kernel/display_data", {
            "executionId": CURRENT.get("executionId", ""),
            "data": {"application/vnd.hcanvas.variables+json": shared},
        })


def execute_user_code(code, namespace):
    tree = ast.parse(code or "", filename="<hcanvas-cell>", mode="exec")
    if not tree.body or not isinstance(tree.body[-1], ast.Expr):
        exec(compile(tree, "<hcanvas-cell>", "exec"), namespace, namespace)
        return
    last = tree.body.pop()
    exec(compile(tree, "<hcanvas-cell>", "exec"), namespace, namespace)
    expression = ast.Expression(last.value)
    ast.fix_missing_locations(expression)
    value = eval(compile(expression, "<hcanvas-cell>", "eval"), namespace, namespace)
    if value is not None:
        notify("kernel/execute_result", {
            "executionId": CURRENT.get("executionId", ""),
            "data": {"text/plain": repr(value)},
        })


def run_execution(request_id, params, namespace):
    code = params.get("code", "")
    execution_id = params.get("executionId") or "exec_" + str(int(time.time() * 1000))
    cell_id = params.get("cellId")
    CURRENT["executionId"] = execution_id
    started = time.time()
    variables = params.get("variables")
    if isinstance(variables, dict):
        for name in list(namespace["hc_vars"]):
            if name not in variables:
                namespace["hc_vars"].pop(name, None)
                namespace.pop(name, None)
        for name, value in variables.items():
            if not valid_variable_name(name):
                continue
            try:
                normalized = json_value(value)
                namespace["hc_vars"][name] = normalized
                namespace[name] = normalized
            except Exception:
                continue
    notify("kernel/execution_started", {"executionId": execution_id, **({"cellId": cell_id} if cell_id else {})})
    notify("kernel/status", {"state": "busy"})
    status = "ok"
    old_stdout, old_stderr, old_stdin = sys.stdout, sys.stderr, sys.stdin
    output = OutputStream("stdout")
    errors = OutputStream("stderr")
    before = figure_numbers()
    INTERRUPT.clear()
    try:
        sys.stdout = output
        sys.stderr = errors
        sys.stdin = io.StringIO("")
        sys.settrace(trace_function)
        try:
            execute_user_code(code, namespace)
        except KeyboardInterrupt:
            status = "aborted"
        except BaseException as error:
            status = "error"
            traceback_lines = traceback.format_exception(type(error), error, error.__traceback__)
            notify("kernel/error", {
                "executionId": execution_id,
                "ename": type(error).__name__,
                "evalue": str(error),
                "traceback": [line.rstrip("\n") for line in traceback_lines],
            })
        finally:
            sys.settrace(None)
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        sys.stdin = old_stdin
        publish_variables(namespace)
        flush_figures(execution_id, before)
        notify("kernel/execution_finished", {"executionId": execution_id, "status": status})
        notify("kernel/status", {"state": "idle"})
        CURRENT["executionId"] = ""
        duration_ms = int((time.time() - started) * 1000)
        respond(request_id, {"executionId": execution_id, "status": status, "durationMs": duration_ms})


def main():
    global NAMESPACE
    NAMESPACE = build_globals()
    namespace = NAMESPACE
    reader = threading.Thread(target=read_frames, daemon=True)
    reader.start()
    while not STOP.is_set():
        try:
            item = EXEC_QUEUE.get(timeout=0.2)
        except queue.Empty:
            continue
        request_id, params = item
        try:
            run_execution(request_id, params, namespace)
        except Exception as error:
            sys.stderr.write("hcanvas python kernel execution error:\n" + traceback.format_exc())
            sys.stderr.flush()
            respond_error(request_id, -32603, str(error))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    finally:
        STOP.set()