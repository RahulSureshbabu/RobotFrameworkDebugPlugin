# RobotFrameworkDebugPlugin

A VS Code extension for **running and debugging Robot Framework tests** with full Test Explorer integration.

---

## Features

- **Test Discovery** – automatically finds `.robot` files in your workspace and populates the VS Code Test Explorer tree with suites and individual test cases.
- **Run Tests** – run a single test, an entire suite, or all tests in the workspace from the Test Explorer, editor title bar, or right-click context menu.
- **Debug Tests** – set breakpoints in `.robot` files and debug them using the bundled `robot_debug_listener.py`. Inspect variables, step through keywords, and view the call stack.
- **Output Channel** – live output from the `robot` process is streamed to the *Robot Framework* output channel.
- **Configurable** – all aspects (Python path, robot command, output directory, discover patterns, debug port, etc.) are controlled via VS Code settings.

---

## Requirements

- [Robot Framework](https://robotframework.org/) installed in your Python environment (`pip install robotframework`).
- The `robot` command available on your `PATH` (or configure `robotframework.robotCommand` in settings).
- VS Code 1.80 or later.

---

## Getting Started

1. Open a workspace that contains `.robot` files.
2. The extension activates automatically and discovers your tests in the Test Explorer (`Ctrl+Shift+T`).
3. Click ▶ next to a suite or test to **run** it, or click the debug icon (🐛) to **debug** it.

### Running a test from the editor

With a `.robot` file open, use the run/debug buttons in the editor title bar:

- **▶ Run Robot Framework Test** – runs the current file.
- **🐛 Debug Robot Framework Test** – debugs the current file.

### Debugging

1. Set a breakpoint on any line inside a `*** Test Cases ***` block.
2. Click the debug icon in the Test Explorer or use **Debug Robot Framework Test**.
3. The listener connects to VS Code and pauses at your breakpoint. Use the standard VS Code debug controls (Continue, Step Over, Step Into, Step Out) to navigate.

---

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `robotframework.pythonPath` | `python` | Path to the Python interpreter. |
| `robotframework.robotCommand` | `robot` | Command used to invoke robot. |
| `robotframework.outputDir` | `${workspaceFolder}/results` | Directory for robot output files. |
| `robotframework.extraArgs` | `[]` | Additional arguments passed to robot. |
| `robotframework.debugPort` | `6612` | TCP port for the debug listener. |
| `robotframework.debugHost` | `127.0.0.1` | Host for the debug listener. |
| `robotframework.discoverPatterns` | `["**/*.robot"]` | Glob patterns for test discovery. |
| `robotframework.excludePatterns` | `["**/node_modules/**", "**/.venv/**", "**/venv/**"]` | Patterns to exclude from discovery. |

---

## Launch Configuration

Add a `robotframework` launch configuration to `.vscode/launch.json` for full debug control:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "robotframework",
      "request": "launch",
      "name": "Robot Framework: Debug Current File",
      "target": "${file}"
    },
    {
      "type": "robotframework",
      "request": "launch",
      "name": "Robot Framework: Debug Suite",
      "target": "${workspaceFolder}/tests",
      "args": ["--variable", "ENV:staging"]
    }
  ]
}
```

---

## Architecture

```
src/
  extension.ts        – Activation entry point; registers commands, test controller, debug provider.
  testController.ts   – VS Code Test API integration: discovers tests, runs/debugs them.
  robotParser.ts      – Parses .robot files to extract suite name and test-case list.
  robotRunner.ts      – Spawns robot sub-processes and builds debug launch arguments.
  debugProvider.ts    – Resolves debug configurations; launches robot with the debug listener.

resources/
  robot_debug_listener.py  – Robot Framework Listener v3 that bridges execution events to VS Code
                             over a TCP socket using a JSON protocol.
  icon.png                 – Extension icon.
```

---

## Contributing

Pull requests are welcome. Please open an issue first to discuss what you would like to change.

## License

MIT
