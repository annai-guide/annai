#!/usr/bin/env node
// Stamps sw.js with a hash of every file in its SHELL list, so the service worker, and the
// name of its cache, change whenever anything annai ships changes (spec §17 rule 5). The catalogs of the languages in its
// LANGS list (l10n/<tag>.json) are hashed after the shell, so a translation fixed alone makes a new build too; then _headers.
// Beside sw.js it writes shell.json, the build's manifest: { build, files: { path: hash } }, the first 12 hex digits of each
// shell file's SHA-256, then each catalog's. An update fetches only the files whose hash isn't the one the version before holds them under (sw.js install).
//   node scripts/stamp.mjs          writes the hash and the manifest (the deploy build command)
//   node scripts/stamp.mjs --check  exits 1 when either is out of date (CI)
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BUILD_LINE = /^const BUILD = '[^']*';$/m;

/**
 * @param {URL} root the folder that holds sw.js
 * @param {{ check?: boolean }} [opts] check: only report, never write
 * @returns {Promise<{ ok: boolean, build: string }>} ok: sw.js already carried this build, and shell.json its files
 */
export async function stamp(root, { check = false } = {}) {
  const swUrl = new URL('sw.js', root);
  const sw = await readFile(swUrl, 'utf8');
  const list = /const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1];
  if (list === undefined || !BUILD_LINE.test(sw)) throw new Error('sw.js needs a SHELL list and a "const BUILD = \'…\';" line');
  const hash = createHash('sha256');
  /** @type {Record<string, string>} */
  const files = {};
  for (const [, path] of list.matchAll(/'(\/[^']*)'/g)) {
    const file = path.endsWith('/') ? `${path}index.html` : path;
    const bytes = await readFile(new URL(file.slice(1), root));
    hash.update(`${path}\0`).update(bytes).update('\0');
    files[path] = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  }
  const langs = /const LANGS = \[([^\]]*)\];/.exec(sw)?.[1] ?? '';
  for (const [, tag] of langs.matchAll(/'([^']+)'/g)) {
    const bytes = await readFile(new URL(`l10n/${tag}.json`, root));
    hash.update(`/l10n/${tag}.json\0`).update(bytes).update('\0');
    // Named in the manifest too, so an update copies a catalog that hasn't changed (L6 review 3).
    files[`/l10n/${tag}.json`] = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  }
  // The site's headers too: the pages carry its policy (CSP, Permissions-Policy), so a change to it alone must reach phones.
  const headers = await readFile(new URL('_headers', root)).catch(() => null);
  if (headers) hash.update('/_headers\0').update(headers).update('\0');
  const build = hash.digest('hex').slice(0, 12);
  const next = sw.replace(BUILD_LINE, `const BUILD = '${build}';`);
  const manifestUrl = new URL('shell.json', root);
  const manifest = `${JSON.stringify({ build, files }, null, 2)}\n`;
  const fresh = (await readFile(manifestUrl, 'utf8').catch(() => null)) === manifest;
  const ok = next === sw && fresh;
  if (!check && next !== sw) await writeFile(swUrl, next);
  if (!check && !fresh) await writeFile(manifestUrl, manifest);
  return { ok, build };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const { ok, build } = await stamp(new URL('../', import.meta.url), { check });
  if (check && !ok) {
    console.error(`sw.js and shell.json aren't stamped for the files annai ships (their build is ${build}). Run: npm run stamp`);
    process.exit(1);
  }
  console.log(`sw.js build ${build}${check ? ' is current' : ''}`);
}
