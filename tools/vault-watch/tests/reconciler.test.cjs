'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Reconciler, normalizeRelativePath } = require('../lib/reconciler');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fault(code) {
  return Object.assign(new Error(`Simulated ${code}`), { code });
}

async function fixture(t, options = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'vault-watch-test-'));
  const applied = [];
  const loaded = new Set();
  const statuses = [];
  const engine = new Reconciler({
    root,
    debounceMs: 60_000,
    getLoadedPaths: () => [...loaded],
    applyPath: async (relative) => { applied.push(relative); },
    onStatus: (status) => statuses.push(status),
    ...options,
  });
  t.after(async () => {
    engine.stop();
    // Only remove this uniquely created fixture directory inside the OS temp.
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.match(path.basename(resolved), /^vault-watch-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, applied, loaded, statuses, engine };
}

test('normalizes separators without case-folding and rejects paths outside the vault', () => {
  assert.equal(normalizeRelativePath('Folder\\Mixed Case.md'), 'Folder/Mixed Case.md');
  assert.equal(normalizeRelativePath('folder//./note.md'), 'folder/note.md');
  for (const invalid of ['', '.', '..', '../other', 'folder/../../other', '/outside',
    '\\\\server\\share\\note', 'C:\\note.md', 'C:note.md', 'note.md:stream', 'file\0.md',
    '.. /outside', 'folder/.. /outside', 'folder./note.md', 'folder /note.md']) {
    assert.equal(normalizeRelativePath(invalid), null, invalid);
  }
});

test('complete scan reconciles parent creation and stale children in safe order', async (t) => {
  const { root, engine, loaded, applied } = await fixture(t);
  await fs.mkdir(path.join(root, 'new', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'new', 'nested', 'note.md'), 'fixture');
  loaded.add('old');
  loaded.add('old/note.md');
  await engine.start();
  assert.deepEqual(applied, ['old/note.md', 'old', 'new', 'new/nested', 'new/nested/note.md']);
});

test('duplicate events coalesce; a folder event includes unreported descendants', async (t) => {
  const { root, engine, applied } = await fixture(t);
  await engine.start();
  await fs.mkdir(path.join(root, 'incoming', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'incoming', 'nested', 'note.md'), 'fixture');
  engine.handleEvent({ type: 'create', path: 'incoming' });
  engine.handleEvent({ type: 'change', path: 'incoming' });
  engine.handleEvent({ type: 'change', path: 'incoming/nested/note.md' });
  await engine.flush();
  assert.deepEqual(applied, ['incoming', 'incoming/nested', 'incoming/nested/note.md']);
});

test('folder rename accounts for both old descendants and new descendants; delete removes both', async (t) => {
  const { root, engine, applied, loaded } = await fixture(t);
  await fs.mkdir(path.join(root, 'before'));
  await fs.writeFile(path.join(root, 'before', 'note.md'), 'fixture');
  await engine.start();
  loaded.add('before');
  loaded.add('before/note.md');
  applied.length = 0;
  await fs.rename(path.join(root, 'before'), path.join(root, 'after'));
  engine.handleEvent({ type: 'rename', oldPath: 'before', path: 'after' });
  await engine.flush();
  assert.deepEqual(applied, ['before/note.md', 'before', 'after', 'after/note.md']);
  loaded.clear();
  loaded.add('after');
  loaded.add('after/note.md');
  applied.length = 0;
  await fs.unlink(path.join(root, 'after', 'note.md'));
  await fs.rmdir(path.join(root, 'after'));
  engine.handleEvent({ type: 'delete', path: 'after' });
  await engine.flush();
  assert.deepEqual(applied, ['after/note.md', 'after']);
});

test('case-only rename delivers both paths without folding or merging them', async (t) => {
  const { root, engine, applied, loaded } = await fixture(t);
  await fs.writeFile(path.join(root, 'before.md'), 'fixture');
  await engine.start();
  loaded.add('before.md');
  applied.length = 0;
  await fs.rename(path.join(root, 'before.md'), path.join(root, 'Before.md'));
  engine.handleEvent({ type: 'rename', oldPath: 'before.md', path: 'Before.md' });
  await engine.flush();
  assert.deepEqual(applied, ['before.md', 'Before.md']);
});

test('ignores hidden directories and traversal events, but includes ordinary underscore paths', async (t) => {
  const { root, engine, applied } = await fixture(t);
  for (const name of ['.git', '.obsidian', '_secrets']) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'entry.md'), 'content is never read by this engine');
  }
  await engine.start();
  assert.deepEqual(applied, ['_secrets', '_secrets/entry.md']);
  applied.length = 0;
  for (const name of ['../elsewhere.md', '/absolute.md', 'C:\\outside.md', '.git/config',
    '.obsidian/plugins/test/main.js', 'normal/.cache/file.md', 'file.md:stream']) {
    assert.equal(engine.handleEvent({ type: 'change', path: name }), false);
  }
  await engine.flush();
  assert.deepEqual(applied, []);
});

test('a directory enumeration failure aborts the whole scan before any index mutation', async (t) => {
  let deny = false;
  const wrappedFs = {
    lstat: (...args) => fs.lstat(...args),
    readdir: (target, ...args) => {
      if (deny && path.basename(target) === 'unreadable') return Promise.reject(fault('EACCES'));
      return fs.readdir(target, ...args);
    },
  };
  const { root, engine, applied, loaded, statuses } = await fixture(t, { fs: wrappedFs });
  await fs.mkdir(path.join(root, 'unreadable'));
  await fs.writeFile(path.join(root, 'available.md'), 'fixture');
  await engine.start();
  loaded.add('old-missing.md');
  applied.length = 0;
  deny = true;
  await assert.rejects(engine.rescan(), { code: 'EACCES' });
  assert.deepEqual(applied, []);
  assert.deepEqual(statuses.at(-1), { state: 'error', reason: 'manual', code: 'EACCES' });
  deny = false;
  await engine.rescan();
  assert.ok(applied.includes('old-missing.md'), 'explicit retry recovers the serialized queue');
});

test('root disappearance is a connection error, not a mass deletion', async (t) => {
  let disconnected = false;
  const wrappedFs = {
    lstat: (...args) => fs.lstat(...args),
    readdir: (...args) => disconnected ? Promise.reject(fault('ENOENT')) : fs.readdir(...args),
  };
  const { engine, applied, loaded } = await fixture(t, { fs: wrappedFs });
  await engine.start();
  loaded.add('existing.md');
  disconnected = true;
  await assert.rejects(engine.rescan(), { code: 'ENOENT' });
  engine.handleEvent({ type: 'delete', path: 'existing.md' });
  await assert.rejects(engine.flush(), { code: 'ENOENT' });
  assert.deepEqual(applied, []);
});

test('a child stat permission/network error cannot become a deletion event', async (t) => {
  let statError;
  const wrappedFs = {
    readdir: (...args) => fs.readdir(...args),
    lstat: (target, ...args) => path.basename(target) === 'note.md' && statError
      ? Promise.reject(fault(statError)) : fs.lstat(target, ...args),
  };
  const { engine, applied, loaded } = await fixture(t, { fs: wrappedFs });
  await engine.start();
  loaded.add('note.md');
  for (const code of ['EACCES', 'EIO', 'ENETUNREACH']) {
    statError = code;
    engine.handleEvent({ type: 'delete', path: 'note.md' });
    await assert.rejects(engine.flush(), { code });
  }
  assert.deepEqual(applied, []);
});

test('stopping during a complete scan discards the old snapshot', async (t) => {
  const entered = deferred();
  const release = deferred();
  let block = true;
  const wrappedFs = {
    lstat: (...args) => fs.lstat(...args),
    readdir: async (...args) => {
      const result = await fs.readdir(...args);
      if (block) {
        block = false;
        entered.resolve();
        await release.promise;
      }
      return result;
    },
  };
  const { root, engine, applied, loaded } = await fixture(t, { fs: wrappedFs });
  await fs.writeFile(path.join(root, 'new.md'), 'fixture');
  loaded.add('old.md');
  const running = engine.start();
  await entered.promise;
  engine.stop();
  release.resolve();
  assert.equal(await running, false);
  assert.deepEqual(applied, []);
});

test('offline cancels queued work; reconnect reconciles the current filesystem', async (t) => {
  const { root, engine, applied } = await fixture(t);
  await engine.start();
  await fs.writeFile(path.join(root, 'queued.md'), 'fixture');
  engine.handleEvent({ type: 'create', path: 'queued.md' });
  const queued = engine.flush();
  await engine.setOnline(false);
  assert.equal(engine.handleEvent({ type: 'change', path: 'offline.md' }), false);
  await queued;
  assert.deepEqual(applied, []);
  await fs.writeFile(path.join(root, 'offline.md'), 'fixture');
  await engine.setOnline(true);
  assert.deepEqual(applied, ['offline.md', 'queued.md']);
});

test('events during a scan are retained and applied after it without overlapping callbacks', async (t) => {
  const entered = deferred();
  const release = deferred();
  let block = false;
  let active = 0;
  let maximum = 0;
  const applied = [];
  const wrappedFs = {
    lstat: (...args) => fs.lstat(...args),
    readdir: async (...args) => {
      const result = await fs.readdir(...args);
      if (block) {
        block = false;
        entered.resolve();
        await release.promise;
      }
      return result;
    },
  };
  const { root, engine } = await fixture(t, {
    fs: wrappedFs,
    applyPath: async (relative) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      applied.push(relative);
      active -= 1;
    },
  });
  await engine.start();
  block = true;
  const scan = engine.rescan();
  await entered.promise;
  await fs.writeFile(path.join(root, 'during.md'), 'fixture');
  engine.handleEvent({ type: 'create', path: 'during.md' });
  const flushed = engine.flush();
  release.resolve();
  await Promise.all([scan, flushed]);
  assert.deepEqual(applied, ['during.md']);
  assert.equal(maximum, 1);
});

test('the host queue can reject an apply that became obsolete while waiting', async (t) => {
  const entered = deferred();
  const release = deferred();
  const applied = [];
  const { root, engine } = await fixture(t, {
    applyPath: async (relative, context) => {
      entered.resolve();
      await release.promise; // model an existing Obsidian adapter.queue task
      if (context.isCurrent()) applied.push(relative);
    },
  });
  await fs.writeFile(path.join(root, 'queued.md'), 'fixture');
  const startup = engine.start();
  await entered.promise;
  await engine.setOnline(false);
  release.resolve();
  assert.equal(await startup, false);
  assert.deepEqual(applied, []);
});

test('a directory removed during enumeration gets one complete recovery scan', async (t) => {
  let root;
  let mutate = false;
  const wrappedFs = {
    readdir: async (target, ...args) => {
      const result = await fs.readdir(target, ...args);
      if (mutate && target === root) {
        mutate = false;
        await fs.rename(path.join(root, 'before'), path.join(root, 'after'));
      }
      return result;
    },
    lstat: (...args) => fs.lstat(...args),
  };
  const fixtureState = await fixture(t, { fs: wrappedFs });
  ({ root } = fixtureState);
  const { engine, loaded, applied, statuses } = fixtureState;
  await fs.mkdir(path.join(root, 'before'));
  await fs.writeFile(path.join(root, 'before', 'note.md'), 'fixture');
  loaded.add('before');
  loaded.add('before/note.md');
  mutate = true;
  await engine.start();
  assert.deepEqual(applied, ['before/note.md', 'before', 'after', 'after/note.md']);
  assert.ok(statuses.some((status) => status.reason === 'retry'));
});

test('continuous directory churn stops after one retry and never applies an incomplete scan', async (t) => {
  let root;
  let scans = 0;
  const wrappedFs = {
    readdir: async (target, ...args) => {
      const result = await fs.readdir(target, ...args);
      if (target === root) scans += 1;
      return result;
    },
    lstat: (target, ...args) => path.basename(target) === 'changing'
      ? Promise.reject(fault('ENOENT')) : fs.lstat(target, ...args),
  };
  const fixtureState = await fixture(t, { fs: wrappedFs });
  ({ root } = fixtureState);
  const { engine, loaded, applied } = fixtureState;
  await fs.mkdir(path.join(root, 'changing'));
  loaded.add('unrelated.md');
  await assert.rejects(engine.start(), { code: 'SCAN_CHANGED' });
  assert.equal(scans, 2);
  assert.deepEqual(applied, []);
});

test('symlink/junction subtrees never cause reads or reconciliation outside the vault', async (t) => {
  const { root, engine, applied } = await fixture(t);
  const external = await fs.mkdtemp(path.join(path.resolve(os.tmpdir()), 'vault-watch-test-external-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(external)), path.resolve(os.tmpdir()));
    assert.match(path.basename(external), /^vault-watch-test-external-/);
    await fs.rm(external, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(external, 'secret.md'), 'must never be read');
  try {
    await fs.symlink(external, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Symlink creation is unavailable.');
    throw error;
  }
  await engine.start();
  engine.handleEvent({ type: 'change', path: 'escape/secret.md' });
  await engine.flush();
  assert.deepEqual(applied, []);
});
