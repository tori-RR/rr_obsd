'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');
const { NativeBridge } = require('../lib/native-bridge');
const { Reconciler } = require('../lib/reconciler');

test('native bridge and reconciler keep a disk-backed mock index current end to end', {
  skip: process.platform !== 'win32',
  timeout: 40_000,
}, async (t) => {
  const temporaryBase = await fs.realpath(os.tmpdir());
  const container = await fs.mkdtemp(path.join(temporaryBase, 'ovw-integration-test-'));
  const root = path.join(container, 'vault');
  const index = new Map();
  const applied = [];
  const messages = [];
  const failures = [];
  let started = false;
  let engine;
  let bridge;

  t.after(async () => {
    engine?.stop();
    await bridge?.stop();
    // Resolve and validate the exact temporary container before recursive cleanup.
    const resolved = await fs.realpath(container);
    assert.equal(path.dirname(resolved).toLowerCase(), temporaryBase.toLowerCase());
    assert.match(path.basename(resolved), /^ovw-integration-test-/);
    await fs.rm(resolved, { recursive: true, force: false });
  });

  await fs.mkdir(path.join(root, 'existing', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'existing', 'nested', 'startup.md'), 'already on disk', { flag: 'wx' });

  engine = new Reconciler({
    root,
    debounceMs: 30,
    getLoadedPaths: () => index.keys(),
    onStatus: (status) => {
      if (status.state === 'error') failures.push(status.code);
    },
    // This is deliberately a disk-backed host adapter, rather than a spy: a
    // delivered event succeeds only if reconciliation yields the current index.
    applyPath: async (relative, context) => {
      if (!context.isCurrent()) return;
      const absolute = path.join(root, ...relative.split('/'));
      let value;
      try {
        const stat = await fs.lstat(absolute);
        value = stat.isDirectory() ? { kind: 'directory' }
          : { kind: 'file', content: await fs.readFile(absolute, 'utf8') };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!context.isCurrent()) return;
      if (value) {
        index.set(relative, value);
      } else {
        for (const key of index.keys()) {
          if (key === relative || key.startsWith(`${relative}/`)) index.delete(key);
        }
      }
      applied.push(relative);
    },
  });

  bridge = new NativeBridge({ root, helperPath: path.join(__dirname, '..', 'native', 'watch.ps1') });
  const track = (promise) => { void promise.catch((error) => failures.push(error.code || error.message)); };
  bridge.on('diagnostic', (diagnostic) => failures.push(diagnostic.code));
  bridge.on('message', (message) => {
    messages.push(message);
    if (message.type === 'ready') {
      track((started ? engine.setOnline(true) : engine.start()).then(() => { started = true; }));
    } else if (message.type === 'change') {
      engine.handleEvent({ type: message.kind, path: message.path, oldPath: message.oldPath });
    } else if (message.type === 'offline') {
      track(engine.setOnline(false));
    } else if (message.type === 'rescan') {
      track(message.reason === 'reconnected' ? engine.setOnline(true) : engine.rescan(message.reason));
    } else if (message.type === 'error') {
      failures.push(message.code || message.reason || 'HELPER_ERROR');
    }
  });

  async function waitFor(predicate, label, timeout = 12_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      assert.deepEqual(failures, [], `${label}: no bridge/reconciliation failures`);
      if (predicate()) return;
      await sleep(25);
    }
    assert.fail(`${label}: timed out; index=${JSON.stringify([...index.keys()])}; messages=${JSON.stringify(messages)}`);
  }

  await bridge.start();
  await waitFor(() => started && index.get('existing/nested/startup.md')?.content === 'already on disk',
    'startup scan');
  assert.equal(index.get('existing')?.kind, 'directory');
  assert.equal(index.get('existing/nested')?.kind, 'directory');

  // No calls to rescan or synthetic change events below: every update must
  // arrive through the actual PowerShell watcher and NativeBridge transport.
  const original = '新增 & $note [1].md';
  await fs.writeFile(path.join(root, original), 'first revision', { flag: 'wx' });
  await waitFor(() => index.get(original)?.content === 'first revision', 'file creation');
  await fs.writeFile(path.join(root, original), 'second revision');
  await waitFor(() => index.get(original)?.content === 'second revision', 'file content change');

  await fs.rename(path.join(root, original), path.join(root, 'renamed.md'));
  await waitFor(() => !index.has(original) && index.get('renamed.md')?.content === 'second revision', 'file rename');
  assert.ok(messages.some((message) => message.type === 'change' && message.kind === 'rename' &&
    message.path === 'renamed.md' && message.oldPath === original));

  await fs.mkdir(path.join(root, 'incoming', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'incoming', 'nested', 'child.md'), 'nested content', { flag: 'wx' });
  await waitFor(() => index.get('incoming/nested/child.md')?.content === 'nested content', 'new directory subtree');
  await fs.rename(path.join(root, 'incoming'), path.join(root, 'moved'));
  await waitFor(() => ![...index.keys()].some((key) => key === 'incoming' || key.startsWith('incoming/')) &&
    index.get('moved')?.kind === 'directory' && index.get('moved/nested')?.kind === 'directory' &&
    index.get('moved/nested/child.md')?.content === 'nested content', 'directory rename with descendants');

  await fs.unlink(path.join(root, 'renamed.md'));
  await waitFor(() => !index.has('renamed.md'), 'file deletion');
  await fs.unlink(path.join(root, 'moved', 'nested', 'child.md'));
  await fs.rmdir(path.join(root, 'moved', 'nested'));
  await fs.rmdir(path.join(root, 'moved'));
  await waitFor(() => ![...index.keys()].some((key) => key === 'moved' || key.startsWith('moved/')),
    'directory subtree deletion');
  assert.deepEqual([...index.keys()].sort(), ['existing', 'existing/nested', 'existing/nested/startup.md']);

  await engine.flush();
  engine.stop();
  await bridge.stop();
  const stoppedApplyCount = applied.length;
  const stoppedMessagesCount = messages.length;
  const stoppedIndex = [...index.entries()];
  await fs.writeFile(path.join(root, 'after-stop.md'), 'must stay unindexed', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'existing', 'nested', 'startup.md'), 'changed after stop');
  await sleep(400);
  assert.equal(applied.length, stoppedApplyCount, 'stop prevents further index application');
  assert.equal(messages.length, stoppedMessagesCount, 'stop detaches native message delivery');
  assert.deepEqual([...index.entries()], stoppedIndex);
  assert.equal(bridge.child, null, 'helper process is released');
  assert.deepEqual(failures, []);
});
