// Writes catalog/plugins.json from plugins-official/: each official plugin's id, name, version,
// what it provides and the SHA-256 of every file, which annai checks before installing (spec §5.3).
// With --check it only says whether the committed catalog is current (npm run check, CI).
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'plugins-official');
const out = join(root, 'catalog', 'plugins.json');

/** Every file under d, as paths relative to it, in a stable order. @param {string} d @param {string} [prefix] @returns {Promise<string[]>} */
async function files(d, prefix = '') {
  /** @type {string[]} */
  const list = [];
  for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isDirectory()) list.push(...(await files(join(d, e.name), `${prefix}${e.name}/`)));
    else list.push(`${prefix}${e.name}`);
  }
  return list;
}

const plugins = [];
for (const e of (await readdir(dir, { withFileTypes: true })).filter((x) => x.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
  const base = join(dir, e.name);
  const manifest = JSON.parse(await readFile(join(base, 'annai-plugin.json'), 'utf8'));
  if (manifest.id !== e.name) throw new Error(`plugins-official/${e.name}: its annai-plugin.json says the id is "${manifest.id}"`);
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const f of await files(base)) hashes[f] = createHash('sha256').update(await readFile(join(base, f))).digest('hex');
  plugins.push({ id: manifest.id, name: manifest.name, version: manifest.version, provides: manifest.provides ?? {}, files: hashes });
}
const text = JSON.stringify({ format: 1, plugins }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if ((await readFile(out, 'utf8').catch(() => '')) !== text) {
    console.error('catalog/plugins.json is stale: run npm run catalog');
    process.exit(1);
  }
  console.log('catalog/plugins.json is current');
} else {
  await writeFile(out, text);
  console.log(`catalog/plugins.json: ${plugins.length} plugin(s)`);
}
