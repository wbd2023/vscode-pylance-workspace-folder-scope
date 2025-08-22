'use strict';

import { workspace, window, StatusBarAlignment, languages, ConfigurationTarget, Uri, DiagnosticSeverity, Diagnostic, Range } from 'vscode';
import { readdirSync } from 'fs';
import { join } from 'path';

// ---------- utils ----------

function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function arrayShallowEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function countPyFiles(root, skipDirs) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.py')) {
        total++;
      }
    }
  }
  return total;
}

const STATE_KEY = 'pylance-workspace-folder-scope.prevSettings';
function getPrevMap(context) { return context.globalState.get(STATE_KEY) || {}; }
async function setPrevMap(context, map) { await context.globalState.update(STATE_KEY, map); }
function folderKey(folder) { return folder.uri.toString(); }

// ---------- globals for UI ----------

let statusItem; // status bar item
let diag;       // DiagnosticCollection
const lastToastAt = new Map(); // folderKey -> epoch ms

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const cfg = () => workspace.getConfiguration('pylanceWorkspaceFolderScope');
  const isEnabled = () => cfg().get('enable', true);

  // UI setup depending on mode
  function ensureUiForMode() {
    const mode = cfg().get('notificationMode', 'toast');
    if (mode === 'statusbar') {
      if (!statusItem) {
        statusItem = window.createStatusBarItem(StatusBarAlignment.Left, 10);
        statusItem.command = 'workbench.action.openSettings?%22pylanceWorkspaceFolderScope%22';
        context.subscriptions.push(statusItem);
      }
      statusItem.show();
      if (diag) diag.clear();
    } else if (mode === 'problems') {
      if (!diag) {
        diag = languages.createDiagnosticCollection('pylance-workspace-folder-scope');
        context.subscriptions.push(diag);
      }
      if (statusItem) statusItem.hide();
    } else {
      // toast or none
      if (statusItem) statusItem.hide();
      if (diag) diag.clear();
    }
  }
  ensureUiForMode();

  // Recreate UI when settings change
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('pylanceWorkspaceFolderScope')) ensureUiForMode();
    })
  );

  const applyForFolderDebounced = debounce(applyForFolder, 150);

  if (workspace.workspaceFolders) {
    workspace.workspaceFolders.forEach(f => applyForFolderDebounced(f));
  }

  context.subscriptions.push(
    window.onDidChangeActiveTextEditor(editor => {
      if (!editor || !editor.document) return;
      const folder = workspace.getWorkspaceFolder(editor.document.uri);
      if (folder) applyForFolderDebounced(folder);
    })
  );

  context.subscriptions.push(
    workspace.onDidChangeWorkspaceFolders(e => {
      e.added.forEach(f => applyForFolderDebounced(f));
    })
  );

  async function applyForFolder(folder) {
    try {
      if (!isEnabled()) return;

      const settings = cfg();
      const limit = settings.get('maxFiles', 200);
      const includePatterns = settings.get('includePatterns', ['!**/*.py']);
      const skipDirs = new Set(settings.get('excludeDirs', [
        '.venv', 'venv', '__pycache__', '.git', '.tox', '.mypy_cache', '.pytest_cache', 'site-packages'
      ]));
      const keepStrict = settings.get('keepStrict', true);
      const mode = settings.get('notificationMode', 'toast');
      const showEnableToast = settings.get('showEnableToast', true);
      const showDisableToast = settings.get('showDisableToast', true);
      const suppressMins = settings.get('toastSuppressForMinutes', 5);

      const pythonCfg = workspace.getConfiguration('python', folder.uri);

      // count files
      const count = countPyFiles(folder.uri.fsPath, skipDirs);

      let desiredExclude, action; // 'disable' | 'enable'
      if (count > limit) { desiredExclude = ['**']; action = 'disable'; }
      else { desiredExclude = ['**', ...includePatterns]; action = 'enable'; }

      const currentExclude = pythonCfg.get('analysis.exclude');
      const currentMode = pythonCfg.get('analysis.typeCheckingMode');
      const needUpdate = !arrayShallowEqual(currentExclude, desiredExclude);

      // Remember previous before we change it
      let prevMap = getPrevMap(context);
      const key = folderKey(folder);
      if (needUpdate || (keepStrict && currentMode !== 'strict')) {
        if (!prevMap[key]) {
          prevMap[key] = {
            exclude: currentExclude,
            typeCheckingMode: currentMode
          };
          await setPrevMap(context, prevMap);
        }
      }

      if (needUpdate) {
        await pythonCfg.update('analysis.exclude', desiredExclude, ConfigurationTarget.WorkspaceFolder);
      }
      if (keepStrict && currentMode !== 'strict') {
        await pythonCfg.update('analysis.typeCheckingMode', 'strict', ConfigurationTarget.WorkspaceFolder);
      }

      // Notify based on mode
      notify(folder, action, count, limit, mode, { showEnableToast, showDisableToast, suppressMins });
    } catch (err) {
      console.error('pylance-workspace-folder-scope error:', err);
    }
  }

  function notify(folder, action, count, limit, mode, opts) {
    const textEnable = `Pylance enabled for '${folder.name}'. Analysing ${count} Python files (limit ${limit}).`;
    const textDisable = `Pylance disabled for '${folder.name}' because it has ${count} Python files which exceeds the ${limit} limit.`;

    if (mode === 'none') return;

    if (mode === 'statusbar') {
      if (!statusItem) return;
      if (action === 'disable') {
        statusItem.text = `$(warning) Pylance disabled: ${count} > ${limit}`;
        statusItem.tooltip = textDisable + "\nClick to open settings.";
      } else {
        statusItem.text = `$(check) Pylance enabled (${count}/${limit})`;
        statusItem.tooltip = textEnable + "\nClick to open settings.";
      }
      return;
    }

    if (mode === 'problems') {
      if (!diag) return;
      // Attach a diagnostic to .vscode/settings.json inside the folder
      const settingsUri = Uri.joinPath(folder.uri, '.vscode', 'settings.json');
      const message = action === 'disable' ? textDisable : textEnable;
      const severity = action === 'disable' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information;
      const d = new Diagnostic(new Range(0, 0, 0, 1), message, severity);
      d.source = 'Pylance Workspace Folder Scope';
      diag.set(settingsUri, [d]);
      return;
    }

    // toast mode with throttling
    const now = Date.now();
    const key = folderKey(folder);
    const last = lastToastAt.get(key) || 0;
    const minGapMs = Math.max(0, (opts.suppressMins || 0)) * 60 * 1000;
    if (now - last < minGapMs) return;

    if (action === 'disable' && opts.showDisableToast) {
      window.showWarningMessage(textDisable);
      lastToastAt.set(key, now);
    } else if (action === 'enable' && opts.showEnableToast) {
      window.showInformationMessage(textEnable);
      lastToastAt.set(key, now);
    }
  }

  module.exports._context = context;
}

async function deactivate() {
  try {
    const context = _context;
    if (!context) return;

    const prevMap = getPrevMap(context);
    if (!prevMap || typeof prevMap !== 'object') return;

    const folders = workspace.workspaceFolders || [];
    for (const folder of folders) {
      const key = folderKey(folder);
      const prev = prevMap[key];
      if (!prev) continue;

      const pythonCfg = workspace.getConfiguration('python', folder.uri);

      if (Object.prototype.hasOwnProperty.call(prev, 'exclude')) {
        await pythonCfg.update('analysis.exclude', prev.exclude, ConfigurationTarget.WorkspaceFolder);
      }
      if (Object.prototype.hasOwnProperty.call(prev, 'typeCheckingMode')) {
        await pythonCfg.update('analysis.typeCheckingMode', prev.typeCheckingMode, ConfigurationTarget.WorkspaceFolder);
      }
      delete prevMap[key];
    }
    await setPrevMap(context, prevMap);
  } catch (err) {
    console.error('pylance-workspace-folder-scope deactivate error:', err);
  } finally {
    if (diag) diag.clear();
    if (statusItem) statusItem.text = '';
  }
}

export default { activate, deactivate };
