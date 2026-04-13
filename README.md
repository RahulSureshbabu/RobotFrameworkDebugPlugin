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

## 📦 Distribution

### Option 1: GitHub Releases (VSIX download)

This repository includes a workflow at `.github/workflows/release-vsix.yml`.

How it works:

1. Push a version tag like `v0.0.1`.
2. GitHub Actions compiles the extension and builds a `.vsix` package.
3. A GitHub Release is created and the `.vsix` file is attached.

Users can then download the `.vsix` and install it from VS Code using **Extensions > ... > Install from VSIX...**.

### Option 2: VS Code Marketplace

This repository includes a workflow at `.github/workflows/publish-marketplace.yml`.

Prerequisites:

1. Create a Marketplace publisher.
2. Ensure `publisher` in `package.json` matches your publisher ID.
3. Create a repository secret named `VSCE_PAT` with your Marketplace Personal Access Token.

Publish:

1. Open **GitHub Actions**.
2. Run **Publish to VS Code Marketplace** (manual workflow).
3. The workflow executes `npx @vscode/vsce publish -p "$VSCE_PAT"`.

After completion, the extension is installable directly from the VS Code Extensions Marketplace.

## ✅ Release Checklist

Use this checklist for each release:

1. Ensure version in `package.json` is correct.
2. Push changes to `main`.
3. Create and push a Git tag (example: `v0.0.2`).
4. Confirm GitHub workflow **Build and Attach VSIX** succeeds.
5. Verify the generated `.vsix` is attached to the GitHub Release.
6. Confirm repository secret `VSCE_PAT` exists:
  - GitHub repo -> **Settings** -> **Secrets and variables** -> **Actions** -> **Repository secrets**
7. Run workflow **Publish to VS Code Marketplace** manually:
  - GitHub repo -> **Actions** -> **Publish to VS Code Marketplace** -> **Run workflow**
8. Confirm the extension appears in Marketplace search.

Quick commands for local tagging:

```bash
git tag -a v0.0.2 -m "Release v0.0.2"
git push origin v0.0.2
```

