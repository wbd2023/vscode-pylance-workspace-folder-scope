# Pylance Workspace Folder Scope

Scopes Pylance analysis to each workspace folder and **disables** it when a folder exceeds a file count threshold.

## What it does

* Counts `.py` files in each workspace folder, skipping directories listed in **`excludeDirs`**.
* Applies settings **at the Workspace Folder level**:
  * **Over the threshold** (more than `N` `.py` files, default 200):
    * `python.analysis.exclude = ["**"]`
    * `python.analysis.include` is removed
    * Effect: analysis is disabled for that folder.

  * **At or under the threshold**:
    * `python.analysis.include` is set from **`includeDirs`** and expanded to Python globs, for example:
      * `["./"]` → `["./**/*.py"]`
      * `["src", "packages/*"]` → `["./src/**/*.py", "./packages/*/**/*.py"]`
    * `python.analysis.exclude` is set from **`excludeDirs`** as glob patterns, for example:
      * `[".venv", "__pycache__"]` → `["**/.venv/**", "**/__pycache__/**"]`
    * Effect: analysis is scoped to Python files in your chosen areas while ignoring common noise.
* Remembers the previous `python.analysis.include` and `python.analysis.exclude` per folder and **restores them on deactivate**.
* No changes are made to `python.analysis.typeCheckingMode`.

> Note: In Pyright/Pylance, **`exclude` takes precedence** over `include`. This extension avoids negated patterns and uses explicit include and exclude lists accordingly.

## Why

Multi-root workspaces and large repositories can cause unnecessary crawling and slow analysis. This extension:

* Limits analysis to the folders you care about when under the threshold.
* Fully disables analysis in very large folders where it would be costly.
* Keeps the scope independent per workspace folder.

## Settings

* `pylanceWorkspaceFolderScope.enable` (boolean, default `true`)
  Turn the behaviour on or off.

* `pylanceWorkspaceFolderScope.maxFiles` (number, default `200`)
  If a folder has more than this many `.py` files, analysis is disabled for that folder.

* `pylanceWorkspaceFolderScope.includeDirs` (string\[], default `["./"]`)
  Directories or glob-like entries to include when analysis is enabled. Each entry is expanded to Python files.
  Examples: `"./"`, `"src"`, `"packages/*"`.

* `pylanceWorkspaceFolderScope.excludeDirs` (string\[], default
  `[".venv","venv","__pycache__",".git",".tox",".mypy_cache",".pytest_cache","site-packages"]`)
  Directory names to skip when counting and to exclude when analysis is enabled.

* `pylanceWorkspaceFolderScope.notificationMode` (string, default `"toast"`)
  One of `"toast"`, `"statusbar"`, `"problems"`, `"none"`.

* `pylanceWorkspaceFolderScope.showEnableToast` (boolean, default `true`)
  Show a toast when a folder is enabled.

* `pylanceWorkspaceFolderScope.showDisableToast` (boolean, default `true`)
  Show a toast when a folder is disabled.

* `pylanceWorkspaceFolderScope.toastSuppressForMinutes` (number, default `5`)
  Minimum minutes between repeated toasts for the same folder.

## Behaviour examples

### **Under or equal to the threshold**

```jsonc
// For a folder with <= 200 .py files
"python.analysis.include": ["./**/*.py"],
"python.analysis.exclude": ["**/.venv/**", "**/__pycache__/**", "..."]
```

### **Over the threshold**

```jsonc
// For a folder with > 200 .py files
"python.analysis.exclude": ["**"]
// analysis.include is removed
```

## Customisation tips

Scope analysis to common source roots:

```json
{
  "pylanceWorkspaceFolderScope.includeDirs": [
    "src",
    "apps/*",
    "./"
  ],
  "pylanceWorkspaceFolderScope.excludeDirs": [
    ".venv",
    "__pycache__",
    ".git"
  ]
}
```

## Activation

The extension activates only when there are Python files in the workspace or when a Python file is opened:

```json
"activationEvents": [
  "workspaceContains:**/*.py",
  "onLanguage:python"
]
```
