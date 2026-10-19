// Writes catalog/plugins.json from plugins-official/: each official plugin's facts (its kind, abilities,
// keywords, size and requirements, as scripts/catalog-facts.mjs reads them), what it provides and the
// SHA-256 of every file, which annai checks before installing (spec §5.3). Every plugin's manifest is
// checked as annai checks one, and every provider's requirements and abilities are checked against the
// catalog: each requirement is there in range, and each ability's type comes from a plugin it requires.
// With --check it only says whether the committed catalog is current (npm run check, CI).
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManifest } from '../src/core/packages.js';
import { catalogFacts } from './catalog-facts.mjs';
import { satisfies } from '../src/core/requires.js';

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
/** @type {Record<string, any>} */
const manifests = {};
for (const e of (await readdir(dir, { withFileTypes: true })).filter((x) => x.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
  const base = join(dir, e.name);
  const manifest = JSON.parse(await readFile(join(base, 'annai-plugin.json'), 'utf8'));
  if (manifest.id !== e.name) throw new Error(`plugins-official/${e.name}: its annai-plugin.json says the id is "${manifest.id}"`);
  checkManifest(manifest);
  manifests[manifest.id] = manifest;
  /** @type {Record<string, string>} */
  const hashes = {};
  let size = 0;
  for (const f of await files(base)) {
    hashes[f] = createHash('sha256').update(await readFile(join(base, f))).digest('hex');
    size += (await stat(join(base, f))).size;
  }
  const facts = catalogFacts(manifest, { size });
  plugins.push({ ...facts, provides: manifest.provides ?? {}, files: hashes });
}

// What a provider needs is in the catalog, in range, and gives each of its abilities' types.
/** @type {string[]} */
const wrong = [];
const typesOf = (/** @type {string} */ id) => manifests[id]?.provides?.['endpoint-type'] ?? [];
const offered = new Set(Object.keys(manifests).flatMap(typesOf));
for (const m of Object.values(manifests)) {
  for (const r of m.requires ?? []) {
    if (!manifests[r.id]) wrong.push(`${m.id}: requires ${r.id}, which isn't in plugins-official`);
    else if (!satisfies(manifests[r.id].version, r.version)) wrong.push(`${m.id}: requires ${r.id} ${r.version}, and it is ${manifests[r.id].version}`);
  }
  for (const [id, a] of Object.entries(m.provider?.abilities ?? {})) {
    if (!offered.has(a.type)) wrong.push(`${m.id}: its ability ${id} needs ${a.type}, which no official plugin provides`);
    else if (a.on !== false && !(m.requires ?? []).some((/** @type {any} */ r) => typesOf(r.id).includes(a.type))) wrong.push(`${m.id}: its ability ${id} starts on, but nothing it requires provides ${a.type}`);
  }
}
if (wrong.length) {
  console.error(wrong.join('\n'));
  process.exit(1);
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
