'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Reconciler } = require('../lib/reconciler');
const { createApplyPath } = require('../lib/obsidian-adapter');

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** Load the actual vault-watch module with an entirely in-memory vault. */
async function createHarness(t, { manifestDir, configDir = '.obsidian', stored = {} } = {}) {
  const root = path.resolve('entry-fixture-never-created-on-disk');
  const disk = new Map([['', { kind: 'directory' }]]);
  const index = new Map();
  const applied = [];
  const bridges = [];
  const notices = [];
  const saved = [];
  const controls = new Map();
  const gates = [];
  let ready;
  let nextGate;
  let adapterTail = Promise.resolve();

  const relativeOf = (target) => {
    const relative = path.relative(root, target).replace(/\\/g, '/');
    assert.ok(relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative));
    return relative;
  };
  const lookup = (relative) => {
    const value = disk.get(relative);
    if (!value) throw Object.assign(new Error('In-memory path absent.'), { code: 'ENOENT' });
    return value;
  };
  const fakeFs = {
    async lstat(target) {
      const value = lookup(relativeOf(target));
      return {
        isDirectory: () => value.kind === 'directory',
        isFile: () => value.kind === 'file',
        isSymbolicLink: () => false,
      };
    },
    async readdir(target) {
      const relative = relativeOf(target);
      assert.equal(lookup(relative).kind, 'directory');
      const prefix = relative ? `${relative}/` : '';
      return [...disk.entries()].filter(([key]) => key.startsWith(prefix) &&
        key !== relative && !key.slice(prefix.length).includes('/')).map(([key, value]) => ({
        name: key.slice(prefix.length),
        isDirectory: () => value.kind === 'directory',
        isFile: () => value.kind === 'file',
        isSymbolicLink: () => false,
      }));
    },
  };

  function put(relative, content) {
    const segments = relative.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      disk.set(segments.slice(0, length).join('/'), { kind: 'directory' });
    }
    disk.set(relative, { kind: 'file', content });
  }
  function rename(before, after) {
    const entries = [...disk.entries()].filter(([key]) => key === before || key.startsWith(`${before}/`));
    assert.ok(entries.length);
    for (const [key] of entries) disk.delete(key);
    for (const [key, value] of entries) disk.set(after + key.slice(before.length), value);
  }

  const adapter = {
    getBasePath: () => root,
    queue(operation) {
      const gate = nextGate;
      nextGate = null;
      const queued = adapterTail.then(async () => {
        if (gate) { gate.entered.resolve(); await gate.release.promise; }
        return operation();
      });
      adapterTail = queued.catch(() => {});
      return queued;
    },
    async reconcileFile(realRelative, normalizedRelative, insensitive) {
      applied.push([realRelative, normalizedRelative, insensitive]);
      const value = disk.get(realRelative);
      if (value) index.set(normalizedRelative, { ...value });
      else {
        for (const key of index.keys()) {
          if (key === normalizedRelative || key.startsWith(`${normalizedRelative}/`)) index.delete(key);
        }
      }
    },
  };
  const app = {
    vault: { adapter, configDir, getAllLoadedFiles: () => [{ path: '/' }, ...[...index.keys()].map((key) => ({ path: key }))] },
    workspace: { onLayoutReady(callback) { ready = callback; } },
  };
  class FakeHost {
    constructor(currentApp, manifest) { this.app = currentApp; this.manifest = manifest; this.commands = new Map(); }
    addStatusBarItem() { return { style: {}, textContent: '', title: '' }; }
    addCommand(command) { this.commands.set(command.id, command); }
  }
  class Setting {
    setName(name) { this.name = name; return this; }
    setDesc() { return this; }
    control(configure) {
      const control = {
        setValue(value) { this.value = value; return this; },
        onChange(callback) { this.change = callback; return this; },
        setLimits() { return this; },
        setDynamicTooltip() { return this; },
        setButtonText() { return this; },
        onClick(callback) { this.click = callback; return this; },
      };
      configure(control);
      controls.set(this.name, control);
      return this;
    }
    addToggle(configure) { return this.control(configure); }
    addSlider(configure) { return this.control(configure); }
    addButton(configure) { return this.control(configure); }
  }
  class Notice { constructor(message) { notices.push(message); } }
  class StubBridge extends EventEmitter {
    constructor(options) { super(); this.options = options; this.stopped = false; bridges.push(this); }
    async start() { this.started = true; }
    async stop() { this.stopped = true; }
  }
  class MemoryReconciler extends Reconciler {
    constructor(options) { super({ ...options, fs: fakeFs }); }
  }
  const dependencies = {
    obsidian: { Plugin: class {}, PluginSettingTab: class {}, Setting, Notice, normalizePath: (value) => value.replace(/\\/g, '/').normalize('NFC') },
    'node:path': path,
    '../../lib/native-bridge': { NativeBridge: StubBridge },
    '../../lib/reconciler': { Reconciler: MemoryReconciler },
    '../../lib/obsidian-adapter': { createApplyPath },
  };
  const loaded = { exports: {} };
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'modules', 'vault-watch.js'), 'utf8');
  vm.runInNewContext(source, {
    module: loaded,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected module dependency: ${name}`);
      return dependencies[name];
    },
    process: { platform: 'win32' },
    Date,
  }, { filename: 'src/modules/vault-watch.js' });
  const manifest = { id: 'rr_obsd', ...(manifestDir ? { dir: manifestDir } : {}) };
  const settings = { ...loaded.exports.VAULT_WATCH_DEFAULTS, ...stored };
  const persist = async () => { saved.push(JSON.parse(JSON.stringify(settings))); };
  const host = new FakeHost(app, manifest);
  const plugin = new loaded.exports.VaultWatchModule(host, settings, persist);
  const containerEl = { empty: () => controls.clear(), createEl: () => {} };
  t.after(async () => {
    plugin.onunload();
    for (const gate of gates) gate.release.resolve();
    await adapterTail;
  });
  await plugin.onload();

  async function launch() {
    ready();
    const bridge = bridges.at(-1);
    assert.ok(bridge?.started, 'layout readiness starts the native bridge');
    bridge.emit('message', { type: 'ready' });
    await plugin.reconciler.flush();
    return bridge;
  }
  function blockNextAdapterCall() {
    const gate = { entered: deferred(), release: deferred() };
    gates.push(gate);
    nextGate = gate;
    return gate;
  }
  return { root, plugin, host, app, adapter, disk, index, applied, bridges, notices, saved, controls,
    put, rename, launch, ready: () => ready(), blockNextAdapterCall,
    displaySettings: () => plugin.renderSettings(containerEl) };
}

test('the vault-watch module wires ready, file events, offline and reconnect into the real reconciliation engine', async (t) => {
  const h = await createHarness(t, { manifestDir: 'custom-config/plugins/installed-folder', configDir: '.ignored-fallback' });
  h.put('existing/startup.md', 'startup');
  assert.equal(h.bridges.length, 0, 'do not start a watcher before layout readiness');
  h.ready();
  const bridge = h.bridges[0];
  assert.equal(bridge.options.root, h.root);
  assert.equal(bridge.options.helperPath, path.join(h.root, 'custom-config/plugins/installed-folder', 'native', 'watch.ps1'));
  assert.equal(h.index.size, 0, 'do not scan until the native watcher is attached');
  bridge.emit('message', { type: 'ready' });
  await h.plugin.reconciler.flush();
  assert.equal(h.index.get('existing/startup.md')?.content, 'startup');
  assert.equal(h.plugin.status, 'watching');

  h.put('external.md', 'first');
  bridge.emit('message', { type: 'change', kind: 'create', path: 'external.md' });
  await h.plugin.reconciler.flush();
  assert.equal(h.index.get('external.md')?.content, 'first');
  h.put('external.md', 'updated');
  bridge.emit('message', { type: 'change', kind: 'update', path: 'external.md' });
  await h.plugin.reconciler.flush();
  assert.equal(h.index.get('external.md')?.content, 'updated');

  h.rename('existing', 'moved');
  bridge.emit('message', { type: 'change', kind: 'rename', oldPath: 'existing', path: 'moved' });
  await h.plugin.reconciler.flush();
  assert.equal(h.index.has('existing/startup.md'), false);
  assert.equal(h.index.get('moved/startup.md')?.content, 'startup');

  bridge.emit('message', { type: 'offline', reason: 'disconnected' });
  assert.equal(h.plugin.status, 'offline');
  const beforeOffline = h.applied.length;
  h.put('offline.md', 'created while disconnected');
  bridge.emit('message', { type: 'change', kind: 'create', path: 'offline.md' });
  await h.plugin.reconciler.flush();
  assert.equal(h.applied.length, beforeOffline);
  assert.equal(h.index.has('offline.md'), false);
  bridge.emit('message', { type: 'rescan', reason: 'reconnected' });
  await h.plugin.reconciler.flush();
  assert.equal(h.index.get('offline.md')?.content, 'created while disconnected');
  assert.equal(h.plugin.status, 'watching');
  assert.ok(h.applied.every(([real, normalized, insensitive]) => real === normalized && insensitive === true));
  assert.equal(h.plugin.changeCount, h.applied.length);
});

test('settings apply immediately and the fallback helper path respects a custom config directory', async (t) => {
  const h = await createHarness(t, { configDir: '.alternate-settings' });
  const original = await h.launch();
  assert.equal(original.options.helperPath, path.join(h.root, '.alternate-settings/plugins/rr_obsd/native/watch.ps1'));
  h.displaySettings();

  await h.controls.get('状态栏').change(false);
  assert.equal(h.plugin.statusEl.style.display, 'none');
  assert.equal(h.bridges.length, 1, 'status visibility does not restart native monitoring');
  assert.equal(h.saved.at(-1).showStatus, false);

  await h.controls.get('原生文件监听').change(false);
  assert.equal(h.plugin.settings.enabled, false);
  assert.equal(h.plugin.reconciler, null);
  assert.equal(original.stopped, true);
  assert.equal(h.plugin.status, 'stopped');
  h.put('while-paused.md', 'pause fixture');
  original.emit('message', { type: 'change', kind: 'create', path: 'while-paused.md' });
  assert.equal(h.index.has('while-paused.md'), false);

  await h.controls.get('原生文件监听').change(true);
  const resumed = h.bridges.at(-1);
  assert.notEqual(resumed, original);
  assert.equal(h.saved.at(-1).enabled, true);
  resumed.emit('message', { type: 'ready' });
  await h.plugin.reconciler.flush();
  assert.equal(h.index.get('while-paused.md')?.content, 'pause fixture');

  await h.controls.get('合并变化的等待时间').change(750);
  assert.equal(resumed.stopped, true);
  assert.equal(h.plugin.reconciler.debounceMs, 750);
  assert.equal(h.saved.at(-1).debounceMs, 750);
  h.bridges.at(-1).emit('message', { type: 'ready' });
  await h.plugin.reconciler.flush();
  assert.equal(h.plugin.status, 'watching');
});

for (const action of ['pause', 'unload']) {
  test(`${action} cancels an apply already waiting in the host adapter queue and ignores obsolete bridge messages`, async (t) => {
    const h = await createHarness(t);
    const bridge = await h.launch();
    h.put('waiting.md', 'queued fixture');
    const gate = h.blockNextAdapterCall();
    bridge.emit('message', { type: 'change', kind: 'create', path: 'waiting.md' });
    const engine = h.plugin.reconciler;
    const pending = engine.flush();
    await gate.entered.promise;
    if (action === 'pause') await h.host.commands.get('toggle-watcher').callback();
    else h.plugin.onunload();
    gate.release.resolve();
    await pending;
    assert.equal(bridge.stopped, true);
    assert.equal(h.index.has('waiting.md'), false);
    assert.deepEqual(h.applied, []);
    const bridgeCount = h.bridges.length;
    bridge.emit('message', { type: 'ready' });
    bridge.emit('message', { type: 'change', kind: 'create', path: 'waiting.md' });
    bridge.emit('message', { type: 'rescan', reason: 'reconnected' });
    await Promise.resolve();
    assert.equal(h.bridges.length, bridgeCount);
    assert.equal(h.index.size, 0);
    if (action === 'unload') {
      h.ready();
      assert.equal(h.bridges.length, bridgeCount, 'late layout callbacks cannot resurrect an unloaded plugin');
    }
  });
}

test('an unsupported host adapter reports incompatibility without starting a native helper', async (t) => {
  const h = await createHarness(t);
  delete h.adapter.reconcileFile;
  await h.plugin.restart();
  assert.equal(h.bridges.length, 0);
  assert.equal(h.plugin.status, 'error');
  assert.ok(h.notices.some((message) => message.includes('不兼容')));
});
