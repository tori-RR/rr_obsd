'use strict';
// Invoke from Obsidian's developer CLI only after explicitly authorizing a
// scratch parent. This script writes only its newly-created child directory.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
let report = { state: 'not-started' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function until(predicate, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(50); }
  throw new Error(`Timed out: ${label}`);
}

async function run(app, options) {
  check(options.allowWrites === true, 'Explicit scratch-write authorization is required.');
  const vaultRoot = path.resolve(app.vault.adapter.getBasePath());
  check(vaultRoot === path.resolve(options.expectedVaultRoot), 'Unexpected active vault.');
  const parent = path.resolve(vaultRoot, options.scratchParent);
  const parentRelative = path.relative(vaultRoot, parent);
  check(parentRelative && !parentRelative.startsWith('..') && !path.isAbsolute(parentRelative), 'Invalid scratch parent.');
  check((await fs.lstat(parent)).isDirectory() && !(await fs.lstat(parent)).isSymbolicLink(), 'Scratch parent must be an existing directory.');
  const name = `rr-obsd-qa-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const root = path.join(parent, name);
  const relativeRoot = path.relative(vaultRoot, root).replace(/\\/g, '/');
  const owned = relative => relative === relativeRoot || relative?.startsWith(`${relativeRoot}/`);
  const absolute = relative => {
    check(owned(relative), 'Operation escaped the test directory.');
    const result = path.resolve(vaultRoot, ...relative.split('/'));
    check(result === root || result.startsWith(root + path.sep), 'Invalid absolute test path.');
    return result;
  };
  const current = () => app.plugins.plugins.rr_obsd;
  check(current()?.manifest.version === '0.3.0', 'Install the expected repair before testing.');
  const beforeLeaf = app.workspace.getMostRecentLeaf();
  const originalSettings = JSON.parse(JSON.stringify(current().settings));
  const restores = [];
  let leaf;
  await fs.mkdir(root); // No recursive creation: never claim an existing folder.
  report.scratchRelative = relativeRoot;
  report.cleanup = 'pending';
  const A = `${relativeRoot}/A.md`, B = `${relativeRoot}/B.md`;
  const baseA = '# Test A\n\nBaseline A.\n', baseB = '# Test B\n\nBaseline B.\n';
  const record = async (label, operation) => {
    report.current = label;
    const started = Date.now();
    await operation();
    report.checks.push({ label, passed: true, milliseconds: Date.now() - started });
  };
  const open = async relative => {
    check(owned(relative), 'Refusing to open a non-test note.');
    const file = app.vault.getAbstractFileByPath(relative);
    check(file && !file.children, 'Test note must be indexed.');
    await leaf.openFile(file, { active: true, state: { mode: 'source' } });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await until(() => leaf.view?.file?.path === relative && leaf.view.getMode?.() === 'source', 'test editor opening');
    leaf.view.editor.focus();
    await until(() => !leaf.view.dirty && !leaf.view.saving && leaf.view.editor.getValue() === leaf.view.lastSavedData, 'clean test editor');
    return leaf.view;
  };
  const gatedRead = async relative => {
    const module = current().vw;
    module.stopTimers();
    const refresh = module.editorRefresh;
    refresh.setOnline(false);
    refresh.setOnline(true);
    const previousApp = refresh.app;
    const gate = deferred(), entered = deferred();
    refresh.app = {
      workspace: app.workspace,
      vault: {
        getAbstractFileByPath: app.vault.getAbstractFileByPath.bind(app.vault),
        read: async file => {
          const contents = await app.vault.read(file);
          if (file.path === relative) { entered.resolve(); await gate.promise; }
          return contents;
        }
      }
    };
    const restore = () => { gate.resolve(); refresh.app = previousApp; };
    restores.push(restore);
    const pending = refresh.refreshNow(relative);
    await entered.promise;
    return { module, refresh, gate, pending, restore };
  };
  try {
    await record('native creation reaches the vault index', async () => {
      await until(() => current().vw.online, 'native watcher ready', 60000);
      await fs.writeFile(absolute(A), baseA, { flag: 'wx' });
      await fs.writeFile(absolute(B), baseB, { flag: 'wx' });
      await until(() => app.vault.getAbstractFileByPath(A) && app.vault.getAbstractFileByPath(B), 'created files indexed');
      leaf = app.workspace.getLeaf('tab');
      check(leaf !== beforeLeaf, 'A separate test tab is required.');
      await open(A);
    });
    await record('focused editor and rendered DOM show an external SMB edit', async () => {
      const view = await open(A);
      const expected = '# Test A\n\nEXTERNAL_REFRESH_VISIBLE.\n';
      await fs.writeFile(absolute(A), expected);
      await until(() => view.editor.getValue() === expected, 'focused editor refreshed');
      await until(() => view.contentEl.querySelector('.cm-content')?.textContent.includes('EXTERNAL_REFRESH_VISIBLE'), 'editor DOM refreshed');
      check(view.lastSavedData === expected && !view.dirty, 'External load should establish a clean saved baseline.');
      await sleep(1500);
      check(await fs.readFile(absolute(A), 'utf8') === expected, 'External content changed unexpectedly.');
    });
    await record('active-note fallback works when this plugin receives no events for that file', async () => {
      const module = current().vw, refresh = module.editorRefresh, engine = module.reconciler;
      const originalEvent = engine.handleEvent, originalRequest = refresh.request, originalActive = refresh.refreshActive;
      let applied = false;
      engine.handleEvent = function(event) { return owned(event.path) ? false : originalEvent.call(this, event); };
      refresh.request = function(relative) { if (!owned(relative)) return originalRequest.call(this, relative); };
      refresh.refreshActive = async function() { const result = await originalActive.call(this); applied ||= result; return result; };
      const restore = () => { engine.handleEvent = originalEvent; refresh.request = originalRequest; refresh.refreshActive = originalActive; };
      restores.push(restore);
      try {
        const view = await open(A);
        await sleep(500);
        const expected = '# Test A\n\nFALLBACK_REFRESH_VISIBLE.\n';
        await fs.writeFile(absolute(A), expected);
        await until(() => applied && view.editor.getValue() === expected, 'active fallback application', 20000);
      } finally { restore(); }
    });
    await record('switching A to B while a real view read is pending preserves B', async () => {
      await open(A);
      const held = await gatedRead(A);
      await open(B);
      held.gate.resolve();
      await held.pending;
      held.restore();
      check(leaf.view.editor.getValue() === baseB, 'A data appeared in B.');
      check(await fs.readFile(absolute(B), 'utf8') === baseB, 'B disk content changed.');
    });
    await record('typing during a pending read preserves actual editor input', async () => {
      const view = await open(A);
      const held = await gatedRead(A);
      const before = view.editor.getValue();
      view.editor.replaceRange('LOCAL_INPUT_KEPT\n', { line: 0, ch: 0 });
      held.gate.resolve();
      await held.pending;
      held.restore();
      check(view.editor.getValue() === 'LOCAL_INPUT_KEPT\n' + before, 'Local input was overwritten.');
      await view.save(false); // Flush only this disposable note before closing it.
    });
    await record('pausing the module invalidates a pending read and releases its helper', async () => {
      const view = await open(A), before = view.editor.getValue();
      const held = await gatedRead(A), oldBridge = held.module.bridge;
      held.module.settings.enabled = false;
      await held.module.restart();
      held.gate.resolve();
      await held.pending;
      held.restore();
      check(view.editor.getValue() === before, 'Paused read changed the view.');
      check(oldBridge.child === null && held.module.bridge === null, 'Paused helper is still attached.');
      held.module.settings.enabled = originalSettings.vw.enabled;
      await held.module.restart();
      await until(() => held.module.online, 'watcher restarted', 60000);
    });
    await record('plugin unload invalidates a pending read and reloads cleanly', async () => {
      const view = await open(A), before = view.editor.getValue();
      const held = await gatedRead(A), oldBridge = held.module.bridge;
      await app.plugins.unloadPlugin('rr_obsd');
      held.gate.resolve();
      await held.pending;
      held.restore();
      check(view.editor.getValue() === before, 'Unloaded plugin changed the editor.');
      await until(() => oldBridge.child === null, 'old helper released');
      await app.plugins.loadPlugin('rr_obsd');
      await until(() => current()?.vw.online, 'plugin reloaded', 60000);
    });
    await record('directory rename and deletion reach the file explorer', async () => {
      const nested = `${relativeRoot}/nested`, moved = `${relativeRoot}/moved`;
      await fs.mkdir(absolute(nested));
      await fs.writeFile(absolute(`${nested}/child.md`), '# Nested test\n', { flag: 'wx' });
      await until(() => app.vault.getAbstractFileByPath(`${nested}/child.md`), 'nested creation');
      // Both final absolute paths are checked by absolute() before the move.
      await fs.rename(absolute(nested), absolute(moved));
      await until(() => !app.vault.getAbstractFileByPath(nested) && app.vault.getAbstractFileByPath(`${moved}/child.md`), 'renamed subtree');
      const explorer = app.workspace.getLeavesOfType('file-explorer')[0]?.view;
      const item = explorer?.fileItems?.[`${moved}/child.md`] || explorer?.fileItems?.get?.(`${moved}/child.md`);
      check(item, 'The actual file explorer has no renamed child item.');
      await fs.unlink(absolute(`${moved}/child.md`));
      await fs.rmdir(absolute(moved));
      await until(() => !app.vault.getAbstractFileByPath(moved), 'deleted subtree');
    });
    await record('floating new-note button creates beside the active test note', async () => {
      await open(A);
      const module = current().fnn;
      module.settings.enabled = true;
      module.settings.targetFolderMode = 'active';
      module.injectAll();
      check(app.workspace.getActiveFile()?.path === A, 'The active file escaped the test directory.');
      const button = leaf.containerEl.querySelector('.fab-container .fab-btn');
      check(button, 'New-note button missing from the test tab.');
      button.click();
      await until(() => app.vault.getAbstractFileByPath(`${relativeRoot}/Untitled.md`), 'new sibling note');
      check(owned(app.workspace.getActiveFile()?.path), 'New note was created outside the scratch directory.');
    });
  } finally {
    report.current = 'cleanup';
    for (const restore of restores.reverse()) restore();
    if (!current()) await app.plugins.loadPlugin('rr_obsd');
    const plugin = current();
    if (plugin) {
      for (const key of ['trn', 'fnn', 'vw']) Object.assign(plugin.settings[key], originalSettings[key]);
      await plugin.vw.restart();
      plugin.fnn.injectAll();
    }
    // Flush and detach only tabs still displaying this test's own notes.
    for (const item of app.workspace.getLeavesOfType('markdown')) {
      if (owned(item.view?.file?.path)) {
        if (item.view.dirty) await item.view.save(false);
        item.detach();
      }
    }
    if (beforeLeaf?.containerEl?.isConnected) app.workspace.setActiveLeaf(beforeLeaf, { focus: true });
    await sleep(400);
    const resolved = await fs.realpath(root);
    const resolvedParent = await fs.realpath(parent);
    check(path.dirname(resolved).toLowerCase() === resolvedParent.toLowerCase() && path.basename(resolved) === name,
      'Refusing cleanup outside the uniquely created test directory.');
    await fs.rm(resolved, { recursive: true, force: false });
    await app.vault.adapter.queue(() => app.vault.adapter.reconcileFile(relativeRoot, relativeRoot, true));
    report.cleanup = 'removed scratch directory and its index; restored settings and original tab';
  }
}

exports.start = (app, options) => {
  if (report.state === 'running') throw new Error('Acceptance is already running.');
  report = { state: 'running', startedAt: new Date().toISOString(), checks: [] };
  run(app, options).then(() => { report.state = 'passed'; report.finishedAt = new Date().toISOString(); },
    error => { report.state = 'failed'; report.error = error.message; report.finishedAt = new Date().toISOString(); });
  return { state: report.state };
};
exports.status = () => report;
