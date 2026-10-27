// node scripts/catalog-versions.mjs <live catalog/plugins.json> <new catalog/plugins.json>: lists the official plugins whose files
// changed under a version already released, and exits 1 when there are any. A phone holding the released copy would read the
// new one as a changed copy of an official plugin, so such a plugin needs a new version before it ships (scripts/release.sh).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The plugins in `next` whose version is one `live` has with other files. @param {any} live @param {any} next
 * @returns {{ id: string, version: string }[]}
 */
export function unbumped(live, next) {
  const plugins = (/** @type {any} */ c) => (Array.isArray(c?.plugins) ? c.plugins : []);
  const files = (/** @type {any} */ p) => JSON.stringify(Object.entries(p?.files ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));
  const released = new Map(plugins(live).map((/** @type {any} */ p) => [`${p.id}@${p.version}`, files(p)]));
  return plugins(next)
    .filter((/** @type {any} */ p) => released.has(`${p.id}@${p.version}`) && released.get(`${p.id}@${p.version}`) !== files(p))
    .map((/** @type {any} */ p) => ({ id: p.id, version: p.version }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [live, next] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const bad = unbumped(live, next);
  for (const p of bad) console.error(`${p.id} ${p.version}: its files changed since that version was released; give it a new version`);
  process.exit(bad.length ? 1 : 0);
}
