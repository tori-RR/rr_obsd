'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const { EditorRefresh } = require('../src/vault-watch/editor-refresh');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeView(file, value = 'original') {
  const calls = [], scrollCalls = [], selectionCalls = [];
  const editor = {
    value,
    getValue() { return this.value; },
    setValue() { assert.fail('refresh must use view.setData, not editor.setValue'); },
    getScrollInfo: () => ({ left: 17, top: 143, height: 500, clientHeight: 250 }),
    scrollTo: (...args) => { scrollCalls.push(args); },
    listSelections: () => [{ anchor: { line: 0, ch: 1 }, head: { line: 0, ch: 2 } }],
    setSelections: selections => { selectionCalls.push(selections); },
    lineCount() { return this.value.split('\n').length; },
    getLine(line) { return this.value.split('\n')[line] ?? ''; },
  };
  const view = {
    file, editor, data: value, lastSavedData: value, dirty: false, saving: false,
    getViewType: () => 'markdown',
    getMode: () => 'source',
    setData(content, clear) {
      calls.push([content, clear]);
      this.data = content;
      this.editor.value = content;
    },
  };
  return { view, editor, calls, scrollCalls, selectionCalls };
}

function fixture(t, { files = ['A.md'], contents = {}, delayMs = 5, isCurrent = () => true } = {}) {
  const index = new Map(files.map(filePath => [filePath, { path: filePath, extension: 'md' }]));
  const entries = files.map(filePath => makeView(index.get(filePath), contents[filePath] ?? 'original'));
  const leaves = entries.map(({ view }) => ({ view }));
  const reads = [], conflicts = [], errors = [];
  let active = leaves[0], readImpl = async () => 'external update';
  const app = {
    workspace: {
      getLeavesOfType: type => type === 'markdown' ? leaves : [],
      getMostRecentLeaf: () => active,
    },
    vault: {
      getAbstractFileByPath: relative => index.get(relative) ?? null,
      read: file => { reads.push(file.path); return readImpl(file); },
    },
  };
  const refresh = new EditorRefresh({ app, delayMs, isCurrent,
    normalizePath: relative => relative.normalize('NFC'),
    onConflict: (...args) => { conflicts.push(args); },
    onError: (...args) => { errors.push(args); } });
  refresh.setOnline(true);
  t.after(() => refresh.stop());
  return { refresh, app, index, entries, leaves, reads, conflicts, errors,
    setRead: fn => { readImpl = fn; }, setActive: leaf => { active = leaf; } };
}

async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for editor refresh');
    await sleep(5);
  }
}

test('safe source refresh updates view data and baseline without invoking editor.setValue', async t => {
  const f = fixture(t);
  await f.refresh.refreshNow('A.md');
  const entry = f.entries[0];
  assert.deepEqual(entry.calls, [['external update', false]]);
  assert.equal(entry.view.data, 'external update');
  assert.equal(entry.editor.value, 'external update');
  assert.equal(entry.view.lastSavedData, 'external update');
  assert.deepEqual(entry.scrollCalls, [[17, 143]]);
  assert.equal(f.errors.length, 0);
});

test('switching from A to B during a read never inserts A into the B editor', async t => {
  const f = fixture(t, { files: ['A.md', 'B.md'] });
  const read = deferred();
  f.setRead(() => read.promise);
  const pending = f.refresh.refreshNow('A.md');
  await until(() => f.reads.length > 0);
  const entry = f.entries[0];
  entry.view.file = f.index.get('B.md');
  entry.editor.value = entry.view.lastSavedData = entry.view.data = 'B content';
  read.resolve('A external update');
  await pending;
  assert.equal(entry.editor.value, 'B content');
  assert.deepEqual(entry.calls, []);
});

test('an editor replacement on the same note invalidates an outstanding read', async t => {
  const f = fixture(t);
  const read = deferred();
  f.setRead(() => read.promise);
  const pending = f.refresh.refreshNow('A.md');
  await until(() => f.reads.length > 0);
  const entry = f.entries[0];
  entry.view.editor = makeView(entry.view.file, 'replacement editor').editor;
  read.resolve('outdated read');
  await pending;
  assert.equal(entry.view.editor.value, 'replacement editor');
  assert.deepEqual(entry.calls, []);
});

test('a file object replacement or in-place rename invalidates an outstanding read', async t => {
  for (const change of ['object', 'path']) {
    const f = fixture(t);
    const read = deferred();
    f.setRead(() => read.promise);
    const pending = f.refresh.refreshNow('A.md');
    await until(() => f.reads.length > 0);
    if (change === 'object') f.entries[0].view.file = { path: 'A.md', extension: 'md' };
    else f.entries[0].view.file.path = 'Renamed.md';
    read.resolve('outdated read');
    await pending;
    assert.equal(f.entries[0].editor.value, 'original', change);
    assert.deepEqual(f.entries[0].calls, [], change);
  }
});

test('typing while a read is outstanding preserves the newly entered text', async t => {
  const f = fixture(t);
  const read = deferred();
  f.setRead(() => read.promise);
  const pending = f.refresh.refreshNow('A.md');
  await until(() => f.reads.length > 0);
  f.entries[0].editor.value = 'new user text';
  f.refresh.markEdited(f.entries[0].editor);
  read.resolve('external update');
  await pending;
  assert.equal(f.entries[0].editor.value, 'new user text');
  assert.deepEqual(f.entries[0].calls, []);
});

test('edit then undo to the old text still invalidates a pre-edit read', async t => {
  const f = fixture(t);
  const read = deferred();
  f.setRead(() => read.promise);
  const pending = f.refresh.refreshNow('A.md');
  await until(() => f.reads.length > 0);
  f.entries[0].editor.value = 'temporary edit';
  f.refresh.markEdited(f.entries[0].editor);
  f.entries[0].editor.value = 'original';
  f.refresh.markEdited(f.entries[0].editor);
  read.resolve('stale external update');
  await pending;
  assert.equal(f.entries[0].editor.value, 'original');
  assert.deepEqual(f.entries[0].calls, []);
});

test('a newer request invalidates the running read and applies only the serialized follow-up read', async t => {
  const f = fixture(t);
  const first = deferred(), second = deferred();
  let count = 0;
  f.setRead(() => (++count === 1 ? first : second).promise);
  const oldPending = f.refresh.refreshNow('A.md');
  await until(() => f.reads.length === 1);
  const newPending = f.refresh.refreshNow('A.md');
  assert.equal(f.reads.length, 1, 'only one read per document may be outstanding');
  first.resolve('older disk text');
  await until(() => f.reads.length === 2);
  assert.deepEqual(f.entries[0].calls, [], 'superseded content must never enter the editor');
  second.resolve('newest disk text');
  await newPending;
  await oldPending;
  assert.equal(f.entries[0].editor.value, 'newest disk text');
  assert.deepEqual(f.entries[0].calls, [['newest disk text', false]]);
});

test('pause, unload, and host invalidation cancel a read that has already started', async t => {
  for (const action of ['offline', 'stop', 'host']) {
    let current = true;
    const f = fixture(t, { isCurrent: () => current });
    const read = deferred();
    f.setRead(() => read.promise);
    const pending = f.refresh.refreshNow('A.md');
    await until(() => f.reads.length > 0);
    if (action === 'offline') f.refresh.setOnline(false);
    else if (action === 'stop') f.refresh.stop();
    else current = false;
    read.resolve('must not apply');
    await pending;
    assert.deepEqual(f.entries[0].calls, [], action);
    assert.equal(f.entries[0].editor.value, 'original', action);
  }
});

test('reconnecting does not revive an outstanding read from before the disconnect', async t => {
  const f = fixture(t);
  const read = deferred();
  f.setRead(() => read.promise);
  const pending = f.refresh.refreshNow('A.md');
  await until(() => f.reads.length > 0);
  f.refresh.setOnline(false);
  f.refresh.setOnline(true);
  read.resolve('pre-disconnect snapshot');
  await pending;
  assert.equal(f.entries[0].editor.value, 'original');
  assert.deepEqual(f.entries[0].calls, []);
});

test('requests for different files retain independent debounce timers', async t => {
  const f = fixture(t, { files: ['A.md', 'B.md'] });
  f.setRead(async file => `updated ${file.path}`);
  f.refresh.request('A.md');
  f.refresh.request('B.md');
  await until(() => f.entries.every(entry => entry.calls.length === 1));
  assert.equal(f.entries[0].editor.value, 'updated A.md');
  assert.equal(f.entries[1].editor.value, 'updated B.md');
});

test('a scheduled refresh is cancelled before it starts when paused or stopped', async t => {
  for (const action of ['offline', 'stop']) {
    const f = fixture(t, { delayMs: 10 });
    f.refresh.request('A.md');
    if (action === 'offline') f.refresh.setOnline(false);
    else f.refresh.stop();
    await sleep(25);
    assert.deepEqual(f.reads, [], action);
    assert.deepEqual(f.entries[0].calls, [], action);
  }
});

test('all source views for one note receive the update', async t => {
  const f = fixture(t);
  const second = makeView(f.index.get('A.md'));
  f.leaves.push({ view: second.view });
  await f.refresh.refreshNow('A.md');
  assert.equal(f.entries[0].editor.value, 'external update');
  assert.equal(second.editor.value, 'external update');
});

test('an unsaved split view defers refresh for the shared document in all views', async t => {
  const f = fixture(t);
  const dirty = makeView(f.index.get('A.md'));
  dirty.editor.value = 'unsaved split text';
  dirty.view.dirty = true;
  f.leaves.push({ view: dirty.view });
  await f.refresh.refreshNow('A.md');
  assert.equal(f.entries[0].editor.value, 'original');
  assert.deepEqual(f.entries[0].calls, []);
  assert.equal(dirty.editor.value, 'unsaved split text');
  assert.deepEqual(dirty.calls, []);
  assert.equal(f.conflicts.length, 1);
});

test('dirty, saving, divergent, or missing-baseline views are never overwritten', async t => {
  for (const state of ['dirty', 'saving', 'divergent', 'missing-baseline']) {
    const f = fixture(t);
    const entry = f.entries[0];
    if (state === 'dirty') entry.view.dirty = true;
    if (state === 'saving') entry.view.saving = true;
    if (state === 'divergent') entry.editor.value = 'unsaved user text';
    if (state === 'missing-baseline') delete entry.view.lastSavedData;
    const before = entry.editor.value;
    await f.refresh.refreshNow('A.md');
    assert.deepEqual(entry.calls, [], state);
    assert.equal(entry.editor.value, before, state);
  }
});

test('a save begun during a read prevents applying the external snapshot', async t => {
  const f = fixture(t);
  const read = deferred();
  f.setRead(() => read.promise);
  const pending = f.refresh.refreshNow('A.md');
  await until(() => f.reads.length > 0);
  f.entries[0].view.saving = true;
  read.resolve('external update');
  await pending;
  assert.deepEqual(f.entries[0].calls, []);
});

test('refreshActive reads only the active source note, while refreshOpen visits all source notes', async t => {
  const f = fixture(t, { files: ['A.md', 'B.md', 'Preview.md'] });
  f.entries[2].view.getMode = () => 'preview';
  f.setActive(f.leaves[1]);
  f.setRead(async file => `updated ${file.path}`);
  await f.refresh.refreshActive();
  await until(() => f.entries[1].calls.length === 1);
  assert.deepEqual(f.reads, ['B.md']);
  assert.deepEqual(f.entries[0].calls, []);
  f.reads.length = 0;
  await f.refresh.refreshOpen();
  await until(() => f.entries[0].calls.length === 1);
  assert.deepEqual([...new Set(f.reads)].sort(), ['A.md', 'B.md']);
  assert.deepEqual(f.entries[2].calls, []);
});

test('unchanged disk content causes no editor rewrite or scroll change', async t => {
  const f = fixture(t);
  f.setRead(async () => 'original');
  await f.refresh.refreshNow('A.md');
  assert.deepEqual(f.entries[0].calls, []);
  assert.deepEqual(f.entries[0].scrollCalls, []);
});

test('a read failure preserves editor contents and is reported through onError', async t => {
  const f = fixture(t);
  f.setRead(async () => { throw new Error('SMB unavailable'); });
  await f.refresh.refreshNow('A.md');
  assert.equal(f.entries[0].editor.value, 'original');
  assert.deepEqual(f.entries[0].calls, []);
  assert.equal(f.errors.length, 1);
});

test('IME composition before or during a read prevents rewriting the editor', async t => {
  for (const when of ['before', 'during']) {
    const f = fixture(t);
    const entry = f.entries[0];
    entry.editor.cm = { composing: when === 'before', state: { doc: {} } };
    if (when === 'before') {
      await f.refresh.refreshNow('A.md');
    } else {
      const read = deferred();
      f.setRead(() => read.promise);
      const pending = f.refresh.refreshNow('A.md');
      await until(() => f.reads.length > 0);
      entry.editor.cm.composing = true;
      read.resolve('external update');
      await pending;
    }
    assert.equal(entry.editor.value, 'original', when);
    assert.deepEqual(entry.calls, [], when);
  }
});

test('a dirty split opened during a read prevents refreshing the shared document', async t => {
  const f = fixture(t);
  const read = deferred();
  f.setRead(() => read.promise);
  const pending = f.refresh.refreshNow('A.md');
  await until(() => f.reads.length > 0);
  const dirty = makeView(f.index.get('A.md'));
  dirty.editor.value = 'newly opened unsaved text';
  dirty.view.dirty = true;
  f.leaves.push({ view: dirty.view });
  read.resolve('external update');
  await pending;
  assert.equal(f.entries[0].editor.value, 'original');
  assert.deepEqual(f.entries[0].calls, []);
  assert.equal(dirty.editor.value, 'newly opened unsaved text');
  assert.deepEqual(dirty.calls, []);
});

test('a host load that synchronously stops or switches notes cancels fallback and position restoration', async t => {
  for (const action of ['stop', 'switch']) {
    const f = fixture(t, { files: ['A.md', 'B.md'] });
    const entry = f.entries[0];
    let fallbackCalls = 0;
    entry.view.setViewData = () => { ++fallbackCalls; };
    entry.view.setData = (content, clear) => {
      entry.calls.push([content, clear]);
      if (action === 'stop') f.refresh.stop();
      else {
        entry.view.file = f.index.get('B.md');
        entry.view.editor = makeView(entry.view.file, 'B contents').editor;
      }
    };
    await f.refresh.refreshNow('A.md');
    assert.deepEqual(entry.calls, [['external update', false]], action);
    assert.equal(fallbackCalls, 0, action);
    assert.deepEqual(entry.scrollCalls, [], action);
    assert.deepEqual(entry.selectionCalls, [], action);
    if (action === 'switch') assert.equal(entry.view.editor.value, 'B contents');
  }
});

test('input synchronously triggered in a second split by the first host load is preserved', async t => {
  const f = fixture(t);
  const second = makeView(f.index.get('A.md'));
  f.leaves.push({ view: second.view });
  const first = f.entries[0];
  const originalSetData = first.view.setData;
  first.view.setData = function (content, clear) {
    originalSetData.call(this, content, clear);
    second.editor.value = 'new input in second split';
    second.view.dirty = true;
    f.refresh.markEdited(second.editor);
  };
  await f.refresh.refreshNow('A.md');
  assert.equal(first.editor.value, 'external update');
  assert.equal(second.editor.value, 'new input in second split');
  assert.deepEqual(second.calls, []);
});
