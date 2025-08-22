# Pylance Workspace Folder Scope

Scopes Pylance analysis to each workspace folder and **disables** it when a folder exceeds a file count threshold.

## What it does

- Sets `python.analysis.exclude` at the Workspace Folder level:
  - If the folder has **more than N** `.py` files (default 200) → `["**"]` which disables analysis for that folder.
  - Otherwise → `["**", "!**/*.py"]` plus any patterns you configure in `includePatterns`, which scopes analysis to that folder only.
- Optionally forces `python.analysis.typeCheckingMode = "strict"` per folder.

## Why

Multi-root workspaces can cause cross-folder crawling. Large folders can also slow you down. This guards both issues.

## Settings

- `pylanceWorkspaceFolderScope.enable` (default true)  
- `pylanceWorkspaceFolderScope.maxFiles` (default 200)  
- `pylanceWorkspaceFolderScope.includePatterns` (default `["!**/*.py"]`)  
  - Add more like `!**/*.pyi`, `!**/*.ipynb`
- `pylanceWorkspaceFolderScope.excludeDirs`  
  - Default: `.venv`, `venv`, `__pycache__`, `.git`, `.tox`, `.mypy_cache`, `.pytest_cache`, `site-packages`
- `pylanceWorkspaceFolderScope.keepStrict` (default true)  
- `pylanceWorkspaceFolderScope.notificationMode` (default `toast`)  
  - Options: `toast`, `statusbar`, `problems`, `none`
- `pylanceWorkspaceFolderScope.showEnableToast` (default true)  
- `pylanceWorkspaceFolderScope.showDisableToast` (default true)  
- `pylanceWorkspaceFolderScope.toastSuppressForMinutes` (default 5)  

## Activation

The extension activates only when there are Python files in the workspace or a Python file is opened:

```json
"activationEvents": [
  "workspaceContains:**/*.py",
  "onLanguage:python"
]
