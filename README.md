# `rfw-plugin`

A VS Code extension for **running and debugging Robot Framework tests** directly from `.robot` files.

## ✨ Features

- Adds **`Run Test`** and **`Debug Test`** CodeLens actions above each Robot test case
- Lets you configure the **Python executable** used to run Robot Framework
- Runs individual tests with `python -m robot --test <name> <file>`
- Starts a **custom Robot debug session** and also attaches to Python code used by the test

## ✅ Requirements

Before using the extension, make sure you have:

- **VS Code** `1.113.0` or newer
- The **Python** extension installed: `ms-python.python`
- A Python environment with:
  - `robotframework`
  - `debugpy`

Example:

```bash
pip install robotframework debugpy
```

## 🚀 Getting started

1. Press `F5` to launch the **Extension Development Host**.
2. Open a `.robot` file.
3. Run **`Robot Framework: Set Python Path`** from the Command Palette.
4. Pick the Python executable that should run your tests.
5. Use **`Run Test`** or **`Debug Test`** above any test case.

## 🧭 Commands

- `Robot Framework: Set Python Path`
- `Robot Framework: Run Test`
- `Robot Framework: Debug Test`

## ⚙️ Settings

| Setting | Description |
|---|---|
| `rfw-plugin.pythonPath` | Python executable used to run and debug Robot Framework tests |
| `rfw-plugin.enableCodeLens` | Enables or disables the per-test `Run Test` / `Debug Test` actions |

## 🐞 Debugging behavior

- Breakpoints in `.robot` files are handled by the extension's custom debug adapter.
- Python breakpoints are attached through `debugpy` during the same debug flow.
- If no Python path is configured, the extension prompts for one.

> Note: this is a lightweight custom debugger implementation intended for Robot test workflows in this repo. Advanced Robot debugging features may still need future refinement.

## 🛠️ Development

Use the following commands from the extension folder:

- `npm run compile` — build the extension
- `npm run watch` — rebuild on changes
- `npm run lint` — run ESLint
- `npm test` — run extension tests

To create a package locally:

```bash
npx @vscode/vsce package
```

