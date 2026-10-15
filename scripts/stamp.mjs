#!/usr/bin/env node
// Stamps sw.js with a hash of every file in its SHELL list, so the service worker, and the
// name of its cache, change whenever anything annai ships changes (spec §17 rule 5).
//   node scripts/stamp.mjs          writes the hash (the deploy build command)
//   node scripts/stamp.mjs --check  exits 1 when the hash is out of date (CI)
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BUILD_LINE = /^const BUILD = '[^']*';$/m;

/**
 * @param {URL} root the folder that holds sw.js
 * @param {{ check?: boolean }} [opts] check: only report, never write
 * @returns {Promise<{ ok: boolean, build: string }>} ok: sw.js already carried this build
 */
export async function stamp(root, { check = false } = {}) {
  const swUrl = new URL('sw.js', root);
  const sw = await readFile(swUrl, 'utf8');
  const list = /const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1];
  if (list === undefined || !BUILD_LINE.test(sw)) throw new Error('sw.js needs a SHELL list and a "const BUILD = \'…\';" line');
  const hash = createHash('sha256');
  for (const [, path] of list.matchAll(/'(\/[^']*)'/g)) {
    const file = path.endsWith('/') ? `${path}index.html` : path;
    hash.update(`${path}\0`).update(await readFile(new URL(file.slice(1), root))).update('\0');
  }
  const build = hash.digest('hex').slice(0, 12);
  const next = sw.replace(BUILD_LINE, `const BUILD = '${build}';`);
  const ok = next === sw;
  if (!check && !ok) await writeFile(swUrl, next);
  return { ok, build };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const { ok, build } = await stamp(new URL('../', import.meta.url), { check });
  if (check && !ok) {
    console.error(`sw.js isn't stamped for the files it ships (their build is ${build}). Run: npm run stamp`);
    process.exit(1);
  }
  console.log(`sw.js build ${build}${check ? ' is current' : ''}`);
}
