import argparse
import json
import os
import socket
import sys
import threading
import time
import traceback
from queue import Queue
from typing import Any

from robot import run
from robot.api.interfaces import ListenerV3


def normalize_path(source: str | None) -> str:
    return os.path.normcase(os.path.abspath(source or ''))


def enable_debugpy(port: int) -> tuple[bool, str | None]:
    try:
        import debugpy  # type: ignore

        debugpy.listen(('127.0.0.1', port))
        return True, None
    except ModuleNotFoundError:  # pragma: no cover - best effort runtime support
        return False, (
            f'Unable to initialize debugpy on 127.0.0.1:{port}: '
            'debugpy is not installed in the selected Python environment. '
            'Install it with `pip install debugpy`.'
        )
    except Exception as error:  # pragma: no cover - best effort runtime support
        return False, f'Unable to initialize debugpy on 127.0.0.1:{port}: {error}'


def wait_for_debugpy_client(timeout_seconds: float) -> bool:
    try:
        import debugpy  # type: ignore

        deadline = time.monotonic() + max(timeout_seconds, 0.0)
        while time.monotonic() < deadline:
            if debugpy.is_client_connected():
                return True
            time.sleep(0.1)

        return debugpy.is_client_connected()
    except Exception:  # pragma: no cover - defensive attach polling
        return False


class DebugConnection:
    def __init__(self, port: int):
        self._socket = socket.create_connection(('127.0.0.1', port))
        self._reader = self._socket.makefile('r', encoding='utf-8')
        self._writer = self._socket.makefile('w', encoding='utf-8')
        self._resume_queue: Queue[dict[str, Any]] = Queue()
        self._breakpoints: dict[str, set[int]] = {}
        self._initialized = threading.Event()
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()

    def _read_loop(self) -> None:
        for raw_line in self._reader:
            line = raw_line.strip()
            if not line:
                continue
            payload = json.loads(line)
            command = payload.get('command')
            if command == 'setBreakpoints':
                self._breakpoints = {
                    normalize_path(source): {int(line_number) for line_number in lines}
                    for source, lines in payload.get('breakpoints', {}).items()
                }
                self._initialized.set()
                continue

            self._resume_queue.put(payload)

    def wait_for_breakpoints(self, timeout: float = 2.0) -> None:
        self._initialized.wait(timeout)

    def has_breakpoint(self, source: str | None, line: int | None) -> bool:
        if not source or not line:
            return False
        return int(line) in self._breakpoints.get(normalize_path(source), set())

    def send_event(self, payload: dict[str, Any]) -> None:
        self._writer.write(json.dumps(payload) + '\n')
        self._writer.flush()

    def wait_for_resume(self) -> dict[str, Any]:
        while True:
            payload = self._resume_queue.get()
            command = payload.get('command')
            if command in {'continue', 'next', 'stepIn', 'stepOut'}:
                return payload

    def close(self) -> None:
        try:
            self._socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._socket.close()


class RobotBreakpointListener(ListenerV3):
    def __init__(self, connection: DebugConnection):
        self._connection = connection
        self._current_test_name = ''
        self._current_test_source = ''
        self._current_test_line = 1
        self._keyword_depth = 0
        self._resume_mode: str | None = None
        self._resume_depth = 0
        self._stop_on_entry = True

    def start_test(self, data, result) -> None:
        self._current_test_name = str(getattr(data, 'name', 'Robot Test'))
        self._current_test_source = str(getattr(data, 'source', '') or '')
        self._current_test_line = int(getattr(data, 'lineno', 1) or 1)
        self._connection.send_event({
            'event': 'output',
            'category': 'console',
            'output': f"Starting test: {self._current_test_name}\n",
        })

    def start_keyword(self, data, result) -> None:
        event_depth = self._keyword_depth + 1
        line = int(getattr(data, 'lineno', 1) or 1)
        source = str(getattr(data, 'source', '') or self._current_test_source)

        reason: str | None = None
        if self._stop_on_entry:
            reason = 'entry'
            self._stop_on_entry = False
        elif self._connection.has_breakpoint(source, line):
            reason = 'breakpoint'
        elif self._resume_mode == 'stepIn':
            reason = 'step'
        elif self._resume_mode == 'next' and event_depth <= self._resume_depth:
            reason = 'step'
        elif self._resume_mode == 'stepOut' and event_depth < self._resume_depth:
            reason = 'step'

        self._keyword_depth = event_depth

        if reason:
            self._pause(data, source, line, event_depth, reason)

    def end_keyword(self, data, result) -> None:
        self._keyword_depth = max(0, self._keyword_depth - 1)

    def _pause(self, data, source: str, line: int, event_depth: int, reason: str) -> None:
        variables = [
            {
                'name': 'test',
                'value': self._current_test_name,
                'type': 'str',
            },
            {
                'name': 'keyword',
                'value': getattr(data, 'name', ''),
                'type': 'str',
            },
            {
                'name': 'args',
                'value': repr(list(getattr(data, 'args', []))),
                'type': 'list',
            },
        ]
        stack = [
            {
                'id': 1,
                'name': str(getattr(data, 'name', 'Robot Keyword')),
                'source': source,
                'line': line,
                'column': 1,
            },
            {
                'id': 2,
                'name': self._current_test_name or 'Robot Test',
                'source': self._current_test_source or source,
                'line': self._current_test_line,
                'column': 1,
            },
        ]
        self._connection.send_event({
            'event': 'stopped',
            'reason': reason,
            'description': f"Paused at {str(getattr(data, 'name', 'Robot Keyword'))}",
            'stack': stack,
            'variables': variables,
        })

        command = self._connection.wait_for_resume().get('command', 'continue')
        if command in {'next', 'stepIn', 'stepOut'}:
            self._resume_mode = command
            self._resume_depth = event_depth
        else:
            self._resume_mode = None
            self._resume_depth = 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--event-port', required=True, type=int)
    parser.add_argument('--debugpy-port', required=False, type=int)
    parser.add_argument('--wait-for-client', action='store_true')
    parser.add_argument('--wait-for-client-timeout', required=False, type=float, default=10.0)
    parser.add_argument('--target', required=True)
    parser.add_argument('--test', required=False)
    arguments = parser.parse_args()

    debugpy_enabled = False
    debugpy_message: str | None = None
    if arguments.debugpy_port:
        debugpy_enabled, debugpy_message = enable_debugpy(arguments.debugpy_port)

    connection = DebugConnection(arguments.event_port)
    if arguments.debugpy_port and not debugpy_message:
        connection.send_event({
            'event': 'output',
            'category': 'console',
            'output': f"Python debugger listening on 127.0.0.1:{arguments.debugpy_port}\n",
        })
    elif debugpy_message:
        connection.send_event({
            'event': 'output',
            'category': 'stderr',
            'output': f'{debugpy_message}\n',
        })

    connection.wait_for_breakpoints()

    if arguments.wait_for_client and arguments.debugpy_port and debugpy_enabled:
        connection.send_event({
            'event': 'output',
            'category': 'console',
            'output': (
                f'Waiting up to {arguments.wait_for_client_timeout:.1f}s '
                'for Python debugger attach before running Robot tests...\n'
            ),
        })
        if wait_for_debugpy_client(arguments.wait_for_client_timeout):
            connection.send_event({
                'event': 'output',
                'category': 'console',
                'output': 'Python debugger client attached. Pausing before Robot execution so Python breakpoints are active.\n',
            })
            try:
                import debugpy  # type: ignore

                debugpy.breakpoint()
            except Exception as error:  # pragma: no cover - defensive runtime support
                connection.send_event({
                    'event': 'output',
                    'category': 'stderr',
                    'output': f'Unable to trigger initial Python breakpoint: {error}\n',
                })
        else:
            connection.send_event({
                'event': 'output',
                'category': 'console',
                'output': 'Timed out waiting for Python debugger attach; continuing Robot execution.\n',
            })

    listener = RobotBreakpointListener(connection)

    try:
        robot_options: dict[str, Any] = {
            'listener': listener,
        }
        if arguments.test:
            robot_options['test'] = arguments.test

        exit_code = int(run(arguments.target, **robot_options))
        connection.send_event({
            'event': 'terminated',
            'exitCode': exit_code,
        })
        return exit_code
    except Exception as error:  # pragma: no cover - defensive runtime reporting
        connection.send_event({
            'event': 'output',
            'category': 'stderr',
            'output': f'{error}\n{traceback.format_exc()}\n',
        })
        connection.send_event({
            'event': 'terminated',
            'exitCode': 1,
        })
        return 1
    finally:
        connection.close()


if __name__ == '__main__':
    sys.exit(main())
