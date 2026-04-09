"""
robot_debug_listener.py – Robot Framework debug listener.

This listener is injected via --listener and communicates with the VS Code
extension over a TCP socket using a simple JSON-based protocol.

Usage (injected automatically by the extension):
    robot --listener robot_debug_listener.py:<host>:<port> <suite>

Protocol (newline-delimited JSON):
  Extension → Listener  (commands)
    {"cmd": "continue"}
    {"cmd": "pause"}
    {"cmd": "step_over"}
    {"cmd": "step_in"}
    {"cmd": "step_out"}
    {"cmd": "set_breakpoints", "breakpoints": [{"file": "...", "line": N}, ...]}
    {"cmd": "evaluate", "expression": "..."}
    {"cmd": "variables", "frameId": N}
    {"cmd": "stack_trace"}

  Listener → Extension  (events)
    {"event": "stopped", "reason": "breakpoint"|"step"|"pause"|"entry",
     "file": "...", "line": N, "thread": 1}
    {"event": "continued"}
    {"event": "output", "category": "stdout"|"stderr", "output": "..."}
    {"event": "suite_started", "name": "...", "file": "..."}
    {"event": "suite_ended",   "name": "...", "status": "PASS"|"FAIL"}
    {"event": "test_started",  "name": "...", "file": "...", "line": N}
    {"event": "test_ended",    "name": "...", "status": "PASS"|"FAIL", "message": "..."}
    {"event": "keyword_started","name": "...", "type": "...", "file": "...", "line": N}
    {"event": "keyword_ended",  "name": "...", "type": "...", "status": "PASS"|"FAIL"}
    {"event": "variables",     "frameId": N, "variables": [{...}, ...]}
    {"event": "stack_trace",   "frames": [{...}, ...]}
    {"event": "terminated"}
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
from typing import Any, Dict, List, Optional


class RobotDebugListener:
    """Robot Framework listener v3 for VS Code debugging."""

    ROBOT_LISTENER_API_VERSION = 3

    # ------------------------------------------------------------------
    def __init__(self, host: str = "127.0.0.1", port: int = 6612) -> None:
        self._host = host
        self._port = int(port)
        self._sock: Optional[socket.socket] = None
        self._conn: Optional[socket.socket] = None
        self._lock = threading.Lock()
        self._step_event = threading.Event()
        self._pause_event = threading.Event()

        # Breakpoints: dict[normalized_path, set[int]]
        self._breakpoints: Dict[str, set] = {}

        # Execution state
        self._running = True
        self._pause_next = False
        self._step_over = False
        self._step_in = False
        self._step_out = False
        self._keyword_depth = 0
        self._depth_at_pause = 0

        # Call-stack frames
        self._stack: List[Dict[str, Any]] = []

        # Current robot execution context (set by listener callbacks)
        self._built_in: Any = None

        self._connect()
        self._start_command_thread()

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    def _connect(self) -> None:
        """Connect to the VS Code extension's debug server."""
        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._sock.connect((self._host, self._port))
            self._conn = self._sock
            self._send({"event": "connected", "protocol": "robotframework-debug/1"})
        except OSError as exc:
            print(
                f"[robot_debug_listener] Failed to connect to {self._host}:{self._port}: {exc}",
                file=sys.stderr,
            )
            self._conn = None

    def _send(self, msg: Dict[str, Any]) -> None:
        if self._conn is None:
            return
        try:
            data = json.dumps(msg) + "\n"
            with self._lock:
                self._conn.sendall(data.encode())
        except OSError:
            self._conn = None

    def _start_command_thread(self) -> None:
        t = threading.Thread(target=self._receive_loop, daemon=True)
        t.start()

    def _receive_loop(self) -> None:
        if self._conn is None:
            return
        buf = b""
        while self._running:
            try:
                chunk = self._conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    self._handle_command(line.decode().strip())
            except OSError:
                break

    def _handle_command(self, raw: str) -> None:
        if not raw:
            return
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return

        cmd = msg.get("cmd", "")
        if cmd == "continue":
            self._pause_next = False
            self._step_over = False
            self._step_in = False
            self._step_out = False
            self._step_event.set()
        elif cmd == "pause":
            self._pause_next = True
        elif cmd == "step_over":
            self._step_over = True
            self._step_in = False
            self._step_out = False
            self._depth_at_pause = self._keyword_depth
            self._step_event.set()
        elif cmd == "step_in":
            self._step_in = True
            self._step_over = False
            self._step_out = False
            self._step_event.set()
        elif cmd == "step_out":
            self._step_out = True
            self._step_over = False
            self._step_in = False
            self._depth_at_pause = self._keyword_depth
            self._step_event.set()
        elif cmd == "set_breakpoints":
            self._update_breakpoints(msg.get("breakpoints", []))
        elif cmd == "evaluate":
            self._handle_evaluate(msg)
        elif cmd == "variables":
            self._handle_variables(msg)
        elif cmd == "stack_trace":
            self._send(
                {
                    "event": "stack_trace",
                    "frames": list(reversed(self._stack)),
                }
            )

    def _update_breakpoints(
        self, breakpoints: List[Dict[str, Any]]
    ) -> None:
        self._breakpoints.clear()
        for bp in breakpoints:
            key = os.path.normcase(os.path.normpath(bp.get("file", "")))
            self._breakpoints.setdefault(key, set()).add(int(bp.get("line", 0)))

    def _handle_evaluate(self, msg: Dict[str, Any]) -> None:
        expr = msg.get("expression", "")
        result = "<evaluation not supported outside keyword scope>"
        try:
            if self._built_in is not None:
                # Try to resolve as a Robot variable first
                result = str(self._built_in.get_variable_value(f"${{{expr}}}"))
        except Exception:
            result = "<unknown>"
        self._send({"event": "evaluate_result", "result": result})

    def _handle_variables(self, msg: Dict[str, Any]) -> None:
        variables: List[Dict[str, Any]] = []
        try:
            if self._built_in is not None:
                for name, value in self._built_in.get_variables().items():
                    variables.append(
                        {
                            "name": name,
                            "value": repr(value),
                            "type": type(value).__name__,
                        }
                    )
        except Exception:
            pass
        self._send(
            {
                "event": "variables",
                "frameId": msg.get("frameId", 0),
                "variables": variables,
            }
        )

    # ------------------------------------------------------------------
    # Pause / step logic
    # ------------------------------------------------------------------

    def _maybe_pause(self, file: str, line: int, reason: str) -> None:
        """Block execution if we have hit a breakpoint or step condition."""
        norm = os.path.normcase(os.path.normpath(file))
        hit_bp = line in self._breakpoints.get(norm, set())

        should_stop = (
            hit_bp
            or self._pause_next
            or (self._step_in)
            or (self._step_over and self._keyword_depth <= self._depth_at_pause)
            or (self._step_out and self._keyword_depth < self._depth_at_pause)
        )

        if not should_stop:
            return

        stop_reason = "breakpoint" if hit_bp else reason
        self._pause_next = False
        self._step_in = False
        self._step_over = False
        self._step_out = False

        self._send(
            {
                "event": "stopped",
                "reason": stop_reason,
                "file": file,
                "line": line,
                "thread": 1,
            }
        )

        # Block until the extension sends a continue/step command
        self._step_event.clear()
        self._step_event.wait()

    # ------------------------------------------------------------------
    # Listener callbacks (Robot Framework Listener API v3)
    # ------------------------------------------------------------------

    def start_suite(self, data: Any, result: Any) -> None:
        self._send(
            {
                "event": "suite_started",
                "name": data.name,
                "file": getattr(data, "source", "") or "",
            }
        )

    def end_suite(self, data: Any, result: Any) -> None:
        self._send(
            {
                "event": "suite_ended",
                "name": data.name,
                "status": result.status,
            }
        )

    def start_test(self, data: Any, result: Any) -> None:
        source = str(getattr(data, "source", "") or "")
        line = getattr(data, "lineno", 0) or 0
        self._stack.append(
            {
                "id": len(self._stack),
                "name": data.name,
                "source": {"path": source},
                "line": line,
            }
        )
        self._send(
            {
                "event": "test_started",
                "name": data.name,
                "file": source,
                "line": line,
            }
        )

    def end_test(self, data: Any, result: Any) -> None:
        if self._stack:
            self._stack.pop()
        self._send(
            {
                "event": "test_ended",
                "name": data.name,
                "status": result.status,
                "message": result.message or "",
            }
        )

    def start_keyword(self, data: Any, result: Any) -> None:
        self._keyword_depth += 1
        source = str(getattr(data, "source", "") or "")
        line = getattr(data, "lineno", 0) or 0
        kw_type = getattr(data, "type", "kw") or "kw"
        name = getattr(data, "full_name", data.name)

        self._stack.append(
            {
                "id": len(self._stack),
                "name": name,
                "source": {"path": source},
                "line": line,
            }
        )
        self._send(
            {
                "event": "keyword_started",
                "name": name,
                "type": kw_type,
                "file": source,
                "line": line,
            }
        )

        if source and line:
            self._maybe_pause(source, line, "step")

    def end_keyword(self, data: Any, result: Any) -> None:
        self._keyword_depth = max(0, self._keyword_depth - 1)
        if self._stack:
            self._stack.pop()
        kw_type = getattr(data, "type", "kw") or "kw"
        self._send(
            {
                "event": "keyword_ended",
                "name": getattr(data, "full_name", data.name),
                "type": kw_type,
                "status": result.status,
            }
        )

    def log_message(self, message: Any) -> None:
        self._send(
            {
                "event": "output",
                "category": "stdout",
                "output": f"[{message.level}] {message.message}\n",
            }
        )

    def close(self) -> None:
        self._running = False
        self._step_event.set()
        self._send({"event": "terminated"})
        if self._conn:
            try:
                self._conn.close()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Entry point – also usable as a standalone script for quick testing
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("This file is a Robot Framework listener. Use it with --listener.")
