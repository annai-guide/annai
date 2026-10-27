// Writes catalog/plugins.json from plugins-official/: each official plugin's facts (its kind, abilities,
// keywords, size and requirements, as src/core/catalog-facts.js reads them), what it provides and the
// SHA-256 of every file, which annai checks before installing (spec §5.3). Every plugin's manifest is
// checked as annai checks one, and every provider's requirements and abilities are checked against the
// catalog: each requirement is there in range, and each ability's type comes from a plugin it requires.
// It also writes src/core/official-names.js: the names of the kinds handed keys that official plugins provide, so
// none is ever a third party's, even before annai's own is installed (K4 review); and, for each language the plugins translate to,
// catalog/l10n/<tag>.json: each plugin's name, description, featured sentence and keywords in it, which the Add screen fetches
// with plugins.json when the screens aren't English (localization design, section 8). Each translation is checked as annai checks one.
// With --check it only says whether the committed catalog is current (npm run check, CI).
import { readFile, readdir, writeFile, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManifest, checkTranslation } from '../src/core/packages.js';
import { catalogFacts } from '../src/core/catalog-facts.js';
import { satisfies } from '../src/core/requires.js';
import { KEYED } from '../src/core/registry.js';

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
/** @type {Record<string, Record<string, any>>} each language's words for the catalog, by plugin id */
const words = {};
for (const e of (await readdir(dir, { withFileTypes: true })).filter((x) => x.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
  const base = join(dir, e.name);
  const manifest = JSON.parse(await readFile(join(base, 'annai-plugin.json'), 'utf8'));
  if (manifest.id !== e.name) throw new Error(`plugins-official/${e.name}: its annai-plugin.json says the id is "${manifest.id}"`);
  checkManifest(manifest);
  manifests[manifest.id] = manifest;
  for (const tag of manifest.l10n ?? []) {
    const file = join(base, 'l10n', `${tag}.json`);
    const bytes = await readFile(file).catch(() => undefined);
    const wrong = checkTranslation(manifest, tag, bytes && new Uint8Array(bytes));
    if (wrong) throw new Error(`plugins-official/${e.name}: ${wrong}`);
    // What the Add screen shows of it in that language.
    const own = JSON.parse(String(bytes)).manifest ?? {};
    const shown = Object.fromEntries(['name', 'description', 'featured', 'keywords'].filter((k) => own[k] !== undefined).map((k) => [k, own[k]]));
    if (Object.keys(shown).length) (words[tag] ??= {})[manifest.id] = shown;
  }
  /** @type {Record<string, string>} */
  const hashes = {};
  let size = 0;
  for (const f of await files(base)) {
    hashes[f] = createHash('sha256').update(await readFile(join(base, f))).digest('hex');
    size += (await stat(join(base, f))).size;
  }
  const facts = catalogFacts(manifest, { size });
  // featured: the one-tap start's provider (spec §9.8); it counts only here, in annai's own catalog.
  plugins.push({ ...facts, ...(manifest.featured ? { featured: manifest.featured } : {}), provides: manifest.provides ?? {}, files: hashes });
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
const keyed = Object.fromEntries([...KEYED].sort().map((kind) => [kind, Object.fromEntries(plugins.flatMap((p) => (p.provides?.[kind] ?? []).map((n) => [n, p.id])))]));
const namesOut = join(root, 'src', 'core', 'official-names.js');
// A kind of backup place's English name, by its type: a place shows it while its plugin isn't running (backup.js).
const storage = Object.fromEntries(plugins.flatMap((p) => (p.provides?.['storage-type'] ?? []).map((n) => [n, p.name])).sort());
const names = `// Written by scripts/catalog.mjs: the names of the kinds handed keys that annai's official plugins provide (spec §5.6),
// so none is a third party's, even before annai's own is installed; and its kinds of backup place's English names.
export const OFFICIAL_NAMES = Object.freeze(${JSON.stringify(keyed)});
export const STORAGE_NAMES = Object.freeze(${JSON.stringify(storage)});
`;
const wordsDir = join(root, 'catalog', 'l10n');
const wordsOut = Object.entries(words).map(([tag, w]) => [join(wordsDir, `${tag}.json`), `${JSON.stringify({ format: 1, plugins: w }, null, 2)}\n`]);
if (process.argv.includes('--check')) {
  const had = (await readdir(wordsDir).catch(() => [])).filter((f) => f.endsWith('.json')).length;
  const stale = had !== wordsOut.length || (await Promise.all(wordsOut.map(async ([f, w]) => (await readFile(f, 'utf8').catch(() => '')) !== w))).some(Boolean);
  if ((await readFile(out, 'utf8').catch(() => '')) !== text || (await readFile(namesOut, 'utf8').catch(() => '')) !== names || stale) {
    console.error('catalog/plugins.json, catalog/l10n or src/core/official-names.js is stale: run npm run catalog, then npm run stamp');
    process.exit(1);
  }
  console.log('catalog/plugins.json is current');
} else {
  await writeFile(out, text);
  await writeFile(namesOut, names);
  await mkdir(wordsDir, { recursive: true });
  for (const [f, w] of wordsOut) await writeFile(f, w);
  console.log(`catalog/plugins.json: ${plugins.length} plugin(s); catalog/l10n: ${wordsOut.length} language(s)`);
}
