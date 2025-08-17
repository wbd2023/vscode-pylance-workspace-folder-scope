# Pylance Folder Guard

Scopes Pylance analysis to each workspace folder and **disables** it when a folder exceeds a file count threshold.

## What it does

- Sets `python.analysis.exclude` at the Workspace Folder level:
  - If the folder has **more than N** `.py` files (default 200) → `["**"]` which disables analysis for that folder.
  - Otherwise → `["**", "!**/*.py"]` plus any patterns you configure in `includePatterns`, which scopes analysis to that folder only.
- Optionally forces `python.analysis.typeCheckingMode = "strict"` per folder.

## Why

Multi-root workspaces can cause cross-folder crawling. Large folders can also slow you down. This guards both issues.

## Settings

- `pylancePerFolderGuard.enable` (default true)  
- `pylancePerFolderGuard.maxFiles` (default 200)  
- `pylancePerFolderGuard.includePatterns` (default `["!**/*.py"]`)  
  - Add more like `!**/*.pyi`, `!**/*.ipynb`
- `pylancePerFolderGuard.excludeDirs`  
  - Default: `.venv`, `venv`, `__pycache__`, `.git`, `.tox`, `.mypy_cache`, `.pytest_cache`, `site-packages`
- `pylancePerFolderGuard.keepStrict` (default true)  
- `pylancePerFolderGuard.showToasts` (default true)

## Activation

The extension activates only when there are Python files in the workspace or a Python file is opened:

```json
"activationEvents": [
  "workspaceContains:**/*.py",
  "onLanguage:python"
]
