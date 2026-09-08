import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await checkDirectory(file);
    else if (/\.(?:c?js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
      assert.equal(result.status, 0, `Syntax check failed: ${file}`);
    }
  }
}

await checkDirectory('src');
await checkDirectory('scripts');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const [pkg, manifest, lock, versions] = await Promise.all(['package.json', 'manifest.json', 'package-lock.json', 'versions.json'].map(json));
assert.equal(pkg.version, manifest.version);
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[''].version, pkg.version);
assert.equal(versions[pkg.version], manifest.minAppVersion);
const helper = await readFile('native/watch.ps1', 'utf8');
assert.ok(Buffer.from(helper.replace(/\r?\n/g, '\r\n'), 'utf16le').toString('base64').length < 30000,
  'The helper must fit EncodedCommand even after Windows line-ending conversion.');
console.log(`Checked source syntax, release metadata and helper size for ${pkg.version}.`);
