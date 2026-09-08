'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

// Advance wall time without awaiting async timer callbacks. A blocked NAS call
// must remain in flight while independent clocks and lifecycle events continue.
class Clock {
  constructor() { this.now = 0; this.tasks = new Map(); this.next = 0; this.errors = []; }
  setTimeout(callback, delay) {
    const handle = { id: ++this.next, unref() {} };
    this.tasks.set(handle, { handle, callback, delay, at: this.now + delay });
    return handle;
  }
  clearTimeout(handle) { this.tasks.delete(handle); }
  count(delay) { return [...this.tasks.values()].filter(task => task.delay === delay).length; }
  async advance(milliseconds) {
    const end = this.now + milliseconds;
    for (;;) {
      const next = [...this.tasks.values()].filter(task => task.at <= end)
        .sort((left, right) => left.at - right.at || left.handle.id - right.handle.id)[0];
      if (!next) break;
      this.now = next.at;
      this.tasks.delete(next.handle);
      try { Promise.resolve(next.callback()).catch(error => this.errors.push(error)); }
      catch (error) { this.errors.push(error); }
      await settle();
    }
    this.now = end;
    await settle();
    assert.deepEqual(this.errors, []);
  }
}

async function harness(t, hooks = {}) {
  const clock = new Clock();
  const calls = { active: 0, open: 0, scans: [], edits: [], notices: [] };
  const bridges = [];
  const engines = [];
  const refreshes = [];
  const events = new Map();
  const registered = [];
  const commands = new Map();
  let layoutReady;
  class NativeBridge extends EventEmitter {
    constructor(options) { super(); this.options = options; bridges.push(this); }
    async start() {}
    async stop() { this.stopped = true; await hooks.bridgeStop?.(); }
  }
  class Reconciler {
    constructor(options) { this.options = options; engines.push(this); }
    start() { return hooks.start?.() ?? Promise.resolve(true); }
    setOnline(online) { this.online = online; return online ? (hooks.reconnect?.() ?? Promise.resolve(true)) : Promise.resolve(false); }
    rescan(reason) { calls.scans.push(reason); return hooks.scan?.(reason) ?? Promise.resolve(true); }
    handleEvent() {}
    stop() { this.stopped = true; }
  }
  class EditorRefresh {
    constructor(options) { this.options = options; refreshes.push(this); }
    setOnline(online) { this.online = online; }
    refreshActive() { calls.active++; return hooks.active?.() ?? Promise.resolve(false); }
    refreshOpen() { calls.open++; return hooks.open?.() ?? Promise.resolve(false); }
    markEdited(editor) { calls.edits.push(editor); }
    request() {}
    stop() { this.stopped = true; }
  }
  const host = {
    manifest: { id: 'rr-obsd', dir: '.obsidian/plugins/rr-obsd' },
    addStatusBarItem: () => ({ style: {} }),
    addCommand: command => commands.set(command.id, command),
    registerEvent: reference => registered.push(reference),
    app: {
      vault: {
        adapter: { getBasePath: () => 'C:\\test-vault', queue: callback => callback(), reconcileFile: async () => {} },
        configDir: '.obsidian', getAllLoadedFiles: () => [],
      },
      workspace: {
        onLayoutReady: callback => { layoutReady = callback; },
        on: (name, callback) => { events.set(name, callback); return { name, callback }; },
      },
    },
  };
  const sourcePath = path.resolve(__dirname, '../src/modules/vault-watch.js');
  const exported = { exports: {} };
  const context = {
    module: exported,
    require: identifier => {
      if (identifier === 'obsidian') return { Notice: class { constructor(message) { calls.notices.push(message); } },
        Setting: class {}, normalizePath: value => value.replace(/\\/g, '/') };
      // Match the component basename so the test survives source-directory moves.
      if (identifier.endsWith('/native-bridge')) return { NativeBridge };
      if (identifier.endsWith('/reconciler')) return { Reconciler };
      if (identifier.endsWith('/editor-refresh')) return { EditorRefresh };
      if (identifier.endsWith('/obsidian-adapter')) return { createApplyPath: () => async () => {} };
      if (identifier === 'node:path') return path;
      throw new Error(`Unexpected dependency: ${identifier}`);
    },
    process: { platform: 'win32' },
    Date: class extends Date { static now() { return clock.now; } },
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  const { VaultWatchModule, VAULT_WATCH_DEFAULTS } = exported.exports;
  const settings = { ...VAULT_WATCH_DEFAULTS, ...hooks.settings };
  const module = new VaultWatchModule(host, settings, async () => {});
  await module.onload();
  t.after(() => module.onunload());
  return { clock, calls, module, settings, bridges, engines, refreshes, events, registered, commands,
    layoutReady: () => layoutReady(),
    async ready() {
      await module.restart();
      bridges.at(-1).emit('message', { type: 'ready' });
      await settle();
      calls.active = calls.open = 0;
      calls.scans.length = 0;
    },
  };
}

test('the five-second timer checks only the active editor, not the vault or all open notes', async t => {
  const { clock, calls, ready } = await harness(t);
  await ready();
  assert.equal(clock.count(5000), 1);
  assert.equal(clock.count(180000), 1);
  await clock.advance(5000);
  assert.equal(calls.active, 1);
  assert.equal(calls.open, 0);
  assert.deepEqual(calls.scans, []);
});

test('a safety scan schedules its next 180-second delay only after scan and open-editor refresh finish', async t => {
  const scan = deferred();
  const open = deferred();
  let blockOpen = false;
  const { clock, calls, ready, module } = await harness(t, {
    scan: () => scan.promise,
    open: () => blockOpen ? open.promise : Promise.resolve(false),
  });
  await ready();
  blockOpen = true;
  await clock.advance(180000);
  assert.deepEqual(calls.scans, ['safety']);
  assert.equal(clock.count(180000), 0);
  module.startTimers(module.lifecycle);
  assert.equal(clock.count(180000), 0, 'another start request cannot duplicate an in-flight scan');
  await clock.advance(400000);
  assert.deepEqual(calls.scans, ['safety']);
  scan.resolve(true);
  await settle();
  assert.equal(calls.open, 1);
  assert.equal(clock.count(180000), 0, 'open-editor fallback is part of the same completion boundary');
  open.resolve(false);
  await settle();
  assert.equal(clock.count(180000), 1);
  await clock.advance(179999);
  assert.deepEqual(calls.scans, ['safety']);
  await clock.advance(1);
  assert.deepEqual(calls.scans, ['safety', 'safety']);
});

test('a failed periodic scan is reported and still schedules another attempt', async t => {
  const { clock, calls, ready } = await harness(t, { scan: () => Promise.reject(new Error('Simulated share error')) });
  await ready();
  await clock.advance(180000);
  assert.deepEqual(calls.scans, ['safety']);
  assert.equal(calls.open, 0);
  assert.equal(calls.notices.length, 1);
  assert.equal(clock.count(180000), 1);
  await clock.advance(180000);
  assert.deepEqual(calls.scans, ['safety', 'safety']);
});

test('a slow active-editor read completes before its next five-second delay begins', async t => {
  const read = deferred();
  const { clock, calls, ready, module } = await harness(t, { active: () => read.promise });
  await ready();
  await clock.advance(5000);
  assert.equal(calls.active, 1);
  assert.equal(clock.count(5000), 0);
  module.startTimers(module.lifecycle);
  await clock.advance(20000);
  assert.equal(calls.active, 1);
  read.resolve(false);
  await settle();
  assert.equal(clock.count(5000), 1);
  await clock.advance(4999);
  assert.equal(calls.active, 1);
  await clock.advance(1);
  assert.equal(calls.active, 2);
});

test('zero intervals disable both fallback timers', async t => {
  const { clock, ready } = await harness(t, { settings: { activeCheckSeconds: 0, safetyScanSeconds: 0 } });
  await ready();
  assert.equal(clock.tasks.size, 0);
});

test('a failed startup scan still permits timed recovery while the native watcher remains online', async t => {
  const { clock, calls, ready } = await harness(t, { start: () => Promise.reject(new Error('Simulated scan failure')) });
  await ready();
  assert.equal(calls.notices.length, 1);
  assert.equal(clock.count(5000), 1);
  assert.equal(clock.count(180000), 1);
});

test('offline, pause, and unload cancel timers and stale asynchronous callbacks cannot rearm them', async t => {
  for (const action of ['offline', 'pause', 'unload']) {
    await t.test(action, async subtest => {
      const scan = deferred();
      const { clock, calls, ready, module, bridges, settings } = await harness(subtest, { scan: () => scan.promise });
      await ready();
      await clock.advance(180000);
      if (action === 'offline') bridges.at(-1).emit('message', { type: 'offline' });
      else if (action === 'pause') { settings.enabled = false; await module.restart(); }
      else module.onunload();
      assert.equal(clock.tasks.size, 0);
      scan.resolve(true);
      await settle();
      assert.equal(calls.open, 0);
      assert.equal(clock.tasks.size, 0);
      await clock.advance(600000);
      assert.deepEqual(calls.scans, ['safety']);
    });
  }
});

test('a timer from before disconnect cannot rearm clocks during a pending reconnect scan', async t => {
  const scan = deferred();
  const reconnect = deferred();
  const { clock, calls, ready, bridges } = await harness(t, {
    scan: () => scan.promise, reconnect: () => reconnect.promise,
  });
  await ready();
  await clock.advance(180000);
  const bridge = bridges.at(-1);
  bridge.emit('message', { type: 'offline' });
  bridge.emit('message', { type: 'rescan', reason: 'reconnected' });
  assert.equal(clock.tasks.size, 0);
  scan.resolve(false);
  await settle();
  assert.equal(clock.tasks.size, 0, 'old completion must remain cancelled after online becomes true again');
  assert.equal(calls.open, 0);
  reconnect.resolve(true);
  await settle();
  assert.equal(clock.count(5000), 1);
  assert.equal(clock.count(180000), 1);
  assert.equal(calls.open, 1);
});

test('an old callback cannot clear a timer slot created by a completed reconnect', async t => {
  const scan = deferred();
  const { clock, ready, bridges } = await harness(t, { scan: () => scan.promise });
  await ready();
  await clock.advance(180000);
  const bridge = bridges.at(-1);
  bridge.emit('message', { type: 'offline' });
  bridge.emit('message', { type: 'rescan', reason: 'reconnected' });
  await settle();
  assert.equal(clock.count(180000), 1);
  scan.resolve(false);
  await settle();
  assert.equal(clock.count(180000), 1, 'only the new timer generation owns the slot');
  assert.equal(clock.count(5000), 1);
});

test('an obsolete startup completion cannot refresh views or arm timers before reconnect completes', async t => {
  const startup = deferred();
  const reconnect = deferred();
  const { clock, calls, ready, bridges } = await harness(t, {
    start: () => startup.promise, reconnect: () => reconnect.promise,
  });
  await ready();
  const bridge = bridges.at(-1);
  assert.equal(clock.tasks.size, 0);
  bridge.emit('message', { type: 'offline' });
  bridge.emit('message', { type: 'rescan', reason: 'reconnected' });
  startup.resolve(true);
  await settle();
  assert.equal(calls.open, 0);
  assert.equal(clock.tasks.size, 0);
  reconnect.resolve(true);
  await settle();
  assert.equal(calls.open, 1);
  assert.equal(clock.count(5000), 1);
  assert.equal(clock.count(180000), 1);
});

test('workspace event subscriptions forward edits and active-file changes and use host cleanup', async t => {
  const { calls, ready, events, registered } = await harness(t);
  await ready();
  const editor = {};
  events.get('editor-change')(editor);
  events.get('file-open')({ path: 'note.md' });
  events.get('active-leaf-change')({});
  await settle();
  assert.deepEqual(calls.edits, [editor]);
  assert.equal(calls.active, 2);
  assert.equal(calls.open, 0);
  assert.deepEqual(registered.map(reference => reference.name).sort(), ['active-leaf-change', 'editor-change', 'file-open']);
});

test('late layout readiness and bridge shutdown cannot restart an unloaded module', async t => {
  const shutdown = deferred();
  const { module, bridges, clock, ready, layoutReady } = await harness(t, { bridgeStop: () => shutdown.promise });
  await ready();
  const restarting = module.restart();
  module.onunload();
  layoutReady();
  shutdown.resolve();
  await restarting;
  await settle();
  assert.equal(bridges.length, 1);
  assert.equal(clock.tasks.size, 0);
});
