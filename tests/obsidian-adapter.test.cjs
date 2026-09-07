'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApplyPath } = require('../lib/obsidian-adapter');

test('refresh uses the queued real adapter reconciliation, preserving real filenames', async () => {
  const calls = [];
  const adapter = { getBasePath() {}, queue: fn => fn(), reconcileFile: async (...args) => calls.push(args) };
  const apply = createApplyPath(adapter, value => value.normalize('NFC'));
  await apply('Folder/Cafe\u0301.md');
  assert.deepEqual(calls, [['Folder/Cafe\u0301.md', 'Folder/Café.md', true]]);
});

test('a disconnect or unload cancels an operation already waiting in Obsidian queue', async () => {
  let queued, active = true, called = false;
  const adapter = { getBasePath() {}, queue: fn => new Promise(resolve => { queued = async () => { await fn(); resolve(); }; }),
    reconcileFile: async () => { called = true; } };
  const apply = createApplyPath(adapter, value => value);
  const pending = apply('note.md', { isCurrent: () => active });
  active = false;
  await queued();
  await pending;
  assert.equal(called, false);
});

test('missing internal adapter API fails explicitly', () => {
  assert.throws(() => createApplyPath({}, value => value), /required file adapter/);
});
