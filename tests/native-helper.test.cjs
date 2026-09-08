const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const native = path.join(__dirname, '..', 'native', 'watch.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function createHarness(t, parentPid = process.pid) {
  const tempBase = await fs.realpath(os.tmpdir());
  const container = await fs.mkdtemp(path.join(tempBase, 'ovw-native-test-'));
  const root = path.join(container, 'vault');
  await fs.mkdir(root);
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.stdin.end();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
      if (child.exitCode === null) child.kill();
    }
    const resolved = await fs.realpath(container);
    assert.equal(path.dirname(resolved).toLowerCase(), tempBase.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('ovw-native-test-'));
    await fs.rm(resolved, { recursive: true, force: false });
  });
  const script = await fs.readFile(native, 'utf8');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  assert.ok(encoded.length < 30000, 'EncodedCommand must fit Windows process limit with headroom');
  child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, OVW_ROOT: root, OVW_PARENT_PID: String(parentPid) },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = [];
  const parseErrors = [];
  let buffered = '', stderr = '', spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr += text; });
  child.stdout.on('data', text => {
    buffered += text;
    let end;
    while ((end = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { parseErrors.push(line); }
    }
  });
  async function waitFor(predicate, from = 0, timeout = 45_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.deepEqual(parseErrors, [], 'stdout must contain only JSON lines');
      const found = events.slice(from).find(predicate);
      if (found) return found;
      assert.equal(child.exitCode, null, `helper exited early: ${JSON.stringify(events)} ${stderr}`);
      await sleep(25);
    }
    assert.fail(`Timed out waiting for event; events=${JSON.stringify(events.slice(from))}; stderr=${stderr}`);
  }
  await waitFor(event => event.type === 'ready');
  return { child, root, events, waitFor, parseErrors, stderr: () => stderr };
}

const options = { skip: process.platform !== 'win32', timeout: 180_000 };

test('native helper reports file and directory events with UTF-8 relative paths', options, async t => {
  const h = await createHarness(t);
  const change = (kind, name) => event => event.type === 'change' && event.kind === kind && event.path === name;
  const filename = '笔记 & $sample [1].md';
  await fs.writeFile(path.join(h.root, filename), 'first', { flag: 'wx' });
  await h.waitFor(change('create', filename));
  await sleep(150);
  let cursor = h.events.length;
  await fs.appendFile(path.join(h.root, filename), '\nsecond');
  await h.waitFor(change('update', filename), cursor);
  cursor = h.events.length;
  await fs.rename(path.join(h.root, filename), path.join(h.root, 'renamed.md'));
  const renamed = await h.waitFor(change('rename', 'renamed.md'), cursor);
  assert.equal(renamed.oldPath, filename);

  await fs.mkdir(path.join(h.root, 'folder'));
  await h.waitFor(change('create', 'folder'));
  await fs.mkdir(path.join(h.root, 'folder', 'nested'));
  await h.waitFor(change('create', 'folder/nested'));
  await fs.writeFile(path.join(h.root, 'folder', 'nested', 'entry.md'), 'nested', { flag: 'wx' });
  await h.waitFor(change('create', 'folder/nested/entry.md'));
  await fs.rename(path.join(h.root, 'folder'), path.join(h.root, 'moved'));
  const directoryRename = await h.waitFor(change('rename', 'moved'));
  assert.equal(directoryRename.oldPath, 'folder');
  cursor = h.events.length;
  await fs.appendFile(path.join(h.root, 'moved', 'nested', 'entry.md'), '\nafter directory rename');
  await h.waitFor(change('update', 'moved/nested/entry.md'), cursor);

  await fs.unlink(path.join(h.root, 'renamed.md'));
  await h.waitFor(change('delete', 'renamed.md'));
  await fs.unlink(path.join(h.root, 'moved', 'nested', 'entry.md'));
  await h.waitFor(change('delete', 'moved/nested/entry.md'));
  await fs.rmdir(path.join(h.root, 'moved', 'nested'));
  await h.waitFor(change('delete', 'moved/nested'));
  await fs.rmdir(path.join(h.root, 'moved'));
  await h.waitFor(change('delete', 'moved'));
  await h.waitFor(event => event.type === 'heartbeat');
  for (const event of h.events.filter(event => event.type === 'change')) {
    for (const relative of [event.path, event.oldPath].filter(Boolean)) {
      assert.ok(!path.win32.isAbsolute(relative));
      assert.ok(!relative.includes('\\'));
      assert.ok(!relative.split('/').includes('..'));
    }
  }
  assert.ok(!h.events.some(event => event.type === 'error' || event.type === 'offline'));
});

test('closing stdin releases the helper process', options, async t => {
  const h = await createHarness(t);
  const exited = new Promise(resolve => h.child.once('exit', code => resolve(code)));
  h.child.stdin.end();
  assert.equal(await Promise.race([exited, sleep(5000, 'timeout')]), 0);
});

test('a write burst either delivers every create or explicitly requests reconciliation', options, async t => {
  const h = await createHarness(t);
  const cursor = h.events.length;
  const count = 800;
  await Promise.all(Array.from({ length: count }, (_, index) =>
    fs.writeFile(path.join(h.root, `burst-${index}.md`), 'burst', { flag: 'wx' })));
  await h.waitFor(event => {
    if (event.type === 'rescan' && event.reason === 'overflow') return true;
    const created = new Set(h.events.slice(cursor)
      .filter(item => item.type === 'change' && item.kind === 'create' && /^burst-\d+\.md$/.test(item.path))
      .map(item => item.path));
    return created.size === count;
  }, cursor);
  await sleep(200);
  const afterBurst = h.events.length;
  await fs.writeFile(path.join(h.root, 'after-burst.md'), 'still watching', { flag: 'wx' });
  await h.waitFor(event => event.type === 'change' && event.kind === 'create' && event.path === 'after-burst.md', afterBurst);
  assert.ok(!h.events.some(event => event.type === 'error' || event.type === 'offline'));
});

test('root loss reports offline and reconnects without inventing deletion events', options, async t => {
  const h = await createHarness(t);
  const renamed = `${h.root}-offline`;
  assert.equal(path.dirname(renamed), path.dirname(h.root));
  await fs.writeFile(path.join(h.root, 'retained.md'), 'retained', { flag: 'wx' });
  await h.waitFor(event => event.type === 'change' && event.kind === 'create');
  let cursor = h.events.length;
  await fs.rename(h.root, renamed);
  await h.waitFor(event => event.type === 'offline', cursor, 15000);
  assert.ok(!h.events.slice(cursor).some(event => event.type === 'change' && event.kind === 'delete'));
  cursor = h.events.length;
  await fs.rename(renamed, h.root);
  await h.waitFor(event => event.type === 'rescan' && event.reason === 'reconnected', cursor);
  assert.equal(h.events.filter(event => event.type === 'ready').length, 1);
  await fs.appendFile(path.join(h.root, 'retained.md'), '\nback online');
  await h.waitFor(event => event.type === 'change' && event.kind === 'update' && event.path === 'retained.md', cursor);
});

test('helper exits when its designated parent exits even with stdin still open', options, async t => {
  const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true, stdio: 'ignore',
  });
  t.after(() => { if (parent.exitCode === null) parent.kill(); });
  const h = await createHarness(t, parent.pid);
  const exited = new Promise(resolve => h.child.once('exit', code => resolve(code)));
  parent.kill();
  assert.equal(await Promise.race([exited, sleep(5000, 'timeout')]), 0);
});
