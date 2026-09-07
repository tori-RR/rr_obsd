import { build, stop } from 'esbuild';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (pkg.version !== manifest.version) throw new Error('Package and manifest versions differ.');
try { await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  external: ['obsidian'],
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  outfile: 'main.js',
  sourcemap: false,
  banner: { js: '/* RR Obsd Toolbox — MIT; source: https://github.com/tori-RR/rr_obsd */' },
  logLevel: 'info'
}); } finally { stop(); }
