'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { NativeBridge } = require('../src/vault-watch/native-bridge');

function fakeProcess() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
  child.exit = code => { child.exitCode = code; child.emit('exit', code); };
  child.kill = () => child.exit(1);
  child.stdin.on('finish', () => child.exit(0));
  return child;
}
function setup(options = {}) {
  const children = [], calls = [];
  const bridge = new NativeBridge({ root: 'M:\\notes with spaces & symbols', helperPath: 'test.ps1',
    platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, readFile: async () => '# reviewed helper',
    spawnProcess: (...args) => { calls.push(args); const child = fakeProcess(); children.push(child); return child; },
    restartDelayMs: 10, maxRestartDelayMs: 20, ...options });
  return { bridge, children, calls };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('launch is hidden, shell-free and passes the vault path only as data', async () => {
  const { bridge, calls } = setup();
  await bridge.start();
  const [exe, args, options] = calls[0];
  assert.match(exe, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.OVW_ROOT, bridge.root);
  assert.ok(!args.includes('-ExecutionPolicy'));
  assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), '# reviewed helper');
  await bridge.stop();
});

test('partial JSON lines are reassembled and heartbeat is not a change', async () => {
  const { bridge, children } = setup();
  const seen = [];
  bridge.on('message', message => seen.push(message));
  await bridge.start();
  children[0].stdout.write('{"type":"rea');
  children[0].stdout.write('dy"}\r\n{"type":"heartbeat"}\n{"type":"change","path":"中文.md","kind":"update"}\n');
  assert.deepEqual(seen.map(item => item.type), ['ready', 'change']);
  assert.equal(seen[1].path, '中文.md');
  await bridge.stop();
});

test('unexpected exit goes offline and restarts; stop prevents further restart', async () => {
  const { bridge, children } = setup();
  const seen = [];
  bridge.on('message', message => seen.push(message));
  await bridge.start();
  children[0].exit(1);
  await delay(30);
  assert.equal(children.length, 2);
  assert.equal(seen[0].type, 'offline');
  await bridge.stop();
  await delay(35);
  assert.equal(children.length, 2);
});

test('unload while helper source is loading never launches a process', async () => {
  let release;
  const { bridge, calls } = setup({ readFile: () => new Promise(resolve => { release = resolve; }) });
  const starting = bridge.start();
  await bridge.stop();
  release('# helper');
  await starting;
  assert.equal(calls.length, 0);
});

test('a helper source read failure retries and recovers when the share returns', async () => {
  let reads = 0;
  const { bridge, calls, children } = setup({ readFile: async () => {
    if (++reads === 1) throw Object.assign(new Error('private path unavailable'), { code: 'ENOENT' });
    return '# restored helper';
  } });
  const messages = [], diagnostics = [];
  bridge.on('message', message => messages.push(message));
  bridge.on('diagnostic', diagnostic => diagnostics.push(diagnostic));
  await bridge.start();
  assert.equal(calls.length, 0);
  assert.deepEqual(messages, [{ type: 'offline', reason: 'helper-read-failed' }]);
  assert.deepEqual(diagnostics, [{ code: 'ENOENT' }]);
  await delay(35);
  assert.equal(calls.length, 1);
  assert.equal(Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le'), '# restored helper');
  children[0].stdout.write('{"type":"ready"}\n');
  assert.equal(messages.at(-1).type, 'ready');
  await bridge.stop();
});

test('stopping during a failed helper read neither retries nor reports stale errors', async () => {
  let rejectRead;
  const { bridge, calls } = setup({ readFile: () => new Promise((resolve, reject) => { rejectRead = reject; }) });
  const messages = [];
  bridge.on('message', message => messages.push(message));
  const starting = bridge.start();
  await bridge.stop();
  rejectRead(Object.assign(new Error('disconnected'), { code: 'ENOENT' }));
  await starting;
  await delay(35);
  assert.equal(calls.length, 0);
  assert.deepEqual(messages, []);
  assert.equal(bridge.restartTimer, null);
});

test('stopping while the source retry is waiting prevents a later process launch', async () => {
  const { bridge, calls } = setup({ readFile: async () => { throw new Error('disconnected'); } });
  await bridge.start();
  await bridge.stop();
  await delay(35);
  assert.equal(calls.length, 0);
  assert.equal(bridge.restartTimer, null);
});

test('malformed output and stderr never expose private path text in diagnostics', async () => {
  const { bridge, children } = setup();
  const seen = [];
  bridge.on('diagnostic', item => seen.push(item));
  await bridge.start();
  children[0].stdout.write('not JSON with a secret path\n');
  children[0].stderr.write('C:\\private\\path');
  assert.deepEqual(seen, [{ code: 'INVALID_HELPER_JSON' }, { code: 'HELPER_STDERR' }]);
  await bridge.stop();
});

test('unsupported platform and oversized helper fail before spawning', async () => {
  const unsupported = setup({ platform: 'linux' });
  await assert.rejects(unsupported.bridge.start(), /Windows/);
  assert.equal(unsupported.calls.length, 0);
  const oversized = setup({ readFile: async () => 'x'.repeat(12000) });
  await assert.rejects(oversized.bridge.start(), /command-line limit/);
  assert.equal(oversized.calls.length, 0);
});
