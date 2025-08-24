'use strict';

import {
  workspace,
  window,
  StatusBarAlignment,
  languages,
  ConfigurationTarget,
  Uri,
  DiagnosticSeverity,
  Diagnostic,
  Range
} from 'vscode';
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
  if (a === undefined && b === undefined) return true;
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

function toIncludeGlobs(folderRelEntries) {
  // Turn includeDirs entries into globs of Python files.
  // If an entry already looks like a glob containing '*' or ends with '.py',
  // use it as-is. Otherwise, treat it as a directory and append '/**/*.py'.
  const out = [];
  for (const raw of folderRelEntries || []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let s = raw.trim();

    // Normalise leading './' for workspace-relative globs
    if (!s.startsWith('./') && !s.startsWith('/')) {
      s = './' + s;
    }

    const hasWildcard = /[*?\[]/.test(s);
    const looksLikeFileGlob = /\.py(i|d)?$/.test(s) || /\/\*\*\/\*\.py(i|d)?$/.test(s);

    if (hasWildcard || looksLikeFileGlob) {
      out.push(s);
    } else {
      // treat as directory root
      if (s.endsWith('/')) s = s.slice(0, -1);
      out.push(`${s}/**/*.py`);
    }
  }
  // Fallback to all Python files if nothing valid supplied
  return out.length ? out : ['./**/*.py'];
}

function toExcludeGlobs(dirNames) {
  // Build "**/<name>/**" patterns for each directory name
  const out = [];
  for (const raw of dirNames || []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const name = raw.trim();
    out.push(`**/${name}/**`);
  }
  return out;
}

const STATE_KEY = 'pylance-workspace-folder-scope.prevSettings';
function getPrevMap(context) {
  const v = context.globalState.get(STATE_KEY);
  return v && typeof v === 'object' ? v : {};
}
async function setPrevMap(context, map) {
  await context.globalState.update(STATE_KEY, map);
}
function folderKey(folder) { return folder.uri.toString(); }

// ---------- globals for UI ----------

let statusItem; // status bar item
let diag;       // DiagnosticCollection
let _context;   // saved for deactivate
const lastToastAt = new Map(); // folderKey -> epoch ms

// ---------- extension entry points ----------

/**
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
  _context = context;

  const cfg = () => workspace.getConfiguration('pylanceWorkspaceFolderScope');
  const isEnabled = () => cfg().get('enable', true);

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
      if (statusItem) statusItem.hide();
      if (diag) diag.clear();
    }
  }
  ensureUiForMode();

  // Recreate UI and re-apply when settings change
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('pylanceWorkspaceFolderScope')) {
        ensureUiForMode();
        const folders = workspace.workspaceFolders || [];
        folders.forEach(f => applyForFolderDebounced(f));
      }
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
      const includeDirs = settings.get('includeDirs', ['./']);
      const excludeDirs = settings.get('excludeDirs', [
        '.venv', 'venv', '__pycache__', '.git', '.tox', '.mypy_cache', '.pytest_cache', 'site-packages'
      ]);

      const mode = settings.get('notificationMode', 'toast');
      const showEnableToast = settings.get('showEnableToast', true);
      const showDisableToast = settings.get('showDisableToast', true);
      const suppressMins = settings.get('toastSuppressForMinutes', 5);

      const pythonCfg = workspace.getConfiguration('python', folder.uri);

      // Count files, skipping configured dirs
      const count = countPyFiles(folder.uri.fsPath, new Set(excludeDirs));

      // Default: exclude everything
      // Override when under threshold: include user-selected dirs (as Python globs)
      // and exclude the configured excludeDirs inside that enabled scope.
      let desiredInclude, desiredExclude, action;

      if (count > limit) {
        desiredInclude = undefined;     // remove include so we do not fight user's prior value
        desiredExclude = ['**'];        // exclude everything by default
        action = 'disable';
      } else {
        desiredInclude = toIncludeGlobs(includeDirs);
        desiredExclude = toExcludeGlobs(excludeDirs); // e.g. **/.venv/**, **/__pycache__/**
        action = 'enable';
      }

      const currentInclude = pythonCfg.get('analysis.include');
      const currentExclude = pythonCfg.get('analysis.exclude');

      const includeChanged =
        (desiredInclude === undefined && currentInclude !== undefined) ||
        (desiredInclude !== undefined && !arrayShallowEqual(currentInclude, desiredInclude));

      const excludeChanged =
        (Array.isArray(desiredExclude) && !arrayShallowEqual(currentExclude, desiredExclude)) ||
        (!Array.isArray(desiredExclude) && currentExclude !== undefined);

      // Save previous per folder before changing
      let prevMap = getPrevMap(context);
      const key = folderKey(folder);
      if ((includeChanged || excludeChanged) && !prevMap[key]) {
        prevMap[key] = {
          include: currentInclude,
          exclude: currentExclude
        };
        await setPrevMap(context, prevMap);
      }

      // Apply updates
      if (includeChanged) {
        await pythonCfg.update('analysis.include', desiredInclude, ConfigurationTarget.WorkspaceFolder);
      }
      if (excludeChanged) {
        await pythonCfg.update(
          'analysis.exclude',
          Array.isArray(desiredExclude) ? desiredExclude : undefined,
          ConfigurationTarget.WorkspaceFolder
        );
      }

      notify(folder, action, count, limit, mode, { showEnableToast, showDisableToast, suppressMins });
    } catch (err) {
      console.error('pylance-workspace-folder-scope error:', err);
    }
  }

  function notify(folder, action, count, limit, mode, opts) {
    const textEnable = `Pylance enabled for '${folder.name}'. Scope: include Python in configured directories. Analysing ${count} files (limit ${limit}).`;
    const textDisable = `Pylance disabled for '${folder.name}'. ${count} Python files exceed the ${limit} limit.`;

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
    const context = _context || module.exports._context;
    if (!context) return;

    const prevMap = getPrevMap(context);
    if (!prevMap || typeof prevMap !== 'object') return;

    const folders = workspace.workspaceFolders || [];
    for (const folder of folders) {
      const key = folderKey(folder);
      const prev = prevMap[key];
      if (!prev) continue;

      const pythonCfg = workspace.getConfiguration('python', folder.uri);

      if (Object.prototype.hasOwnProperty.call(prev, 'include')) {
        await pythonCfg.update('analysis.include', prev.include, ConfigurationTarget.WorkspaceFolder);
      }
      if (Object.prototype.hasOwnProperty.call(prev, 'exclude')) {
        await pythonCfg.update('analysis.exclude', prev.exclude, ConfigurationTarget.WorkspaceFolder);
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

// Support both import and CommonJS styles
export default { activate, deactivate };
module.exports = { activate, deactivate };
