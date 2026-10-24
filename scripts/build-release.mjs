#!/usr/bin/env node
// Readies an unpacked release of annai in place (scripts/release.sh runs it before switching to the release):
//   node scripts/build-release.mjs <dir>
// Beside each text file annai fetches it writes x.br (brotli, quality 11), kept only when it is smaller than
// the file; scripts/serve.mjs sends it to a browser that takes brotli (every browser annai supports does, over
// HTTPS). No file of the release changes: x.br decodes to the file's own bytes, so a phone runs exactly what the
// tests ran, and every hash taken on the source still holds (sw.js's BUILD, the catalog's file hashes, and
// the per-file hashes a later update will compare to fetch only the files that changed).
import { readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** What counts as text: the kinds of file annai ships that aren't compressed already (fonts and pictures are). */
export const TEXT = /\.(?:html|js|mjs|css|json|webmanifest|svg|txt|md)$|(?:^|\/)LICENSE$/;
/** The folders annai fetches from on demand, outside sw.js's SHELL: languages, the catalog, the official plugins. */
const ON_DEMAND = ['l10n', 'catalog', 'plugins-official'];

/**
 * The text files annai fetches, relative to dir: sw.js, its manifest shell.json (in a release from after it came), the files in its
 * SHELL, and the on-demand folders.
 * @param {string} dir @returns {Promise<string[]>}
 */
export async function shippedText(dir) {
  const sw = await readFile(join(dir, 'sw.js'), 'utf8');
  const list = /const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1];
  if (list === undefined) throw new Error(`${dir}/sw.js has no SHELL list`);
  const names = new Set(['sw.js']);
  if (await stat(join(dir, 'shell.json')).then((s) => s.isFile(), () => false)) names.add('shell.json');
  for (const [, path] of list.matchAll(/'(\/[^']*)'/g)) names.add(path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1));
  for (const folder of ON_DEMAND) {
    for (const name of await readdir(join(dir, folder), { recursive: true }).catch(() => /** @type {string[]} */ ([]))) {
      const path = `${folder}/${name.split('\\').join('/')}`;
      if ((await stat(join(dir, path))).isFile()) names.add(path);
    }
  }
  return [...names].filter((n) => TEXT.test(n));
}

/** @param {Buffer} buf */
export const brotli = (buf) => brotliCompressSync(buf, { params: {
  [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
} });

/**
 * Writes x.br beside dir's shipped text files, and returns the totals: files, and bytes as the files are (raw)
 * and as sent to a browser that takes brotli (br).
 * @param {string} dir
 */
export async function precompress(dir) {
  const sizes = { files: 0, raw: 0, br: 0 };
  for (const name of await shippedText(dir)) {
    const own = await readFile(join(dir, name));
    const packed = brotli(own);
    if (packed.length < own.length) await writeFile(join(dir, `${name}.br`), packed);
    else await rm(join(dir, `${name}.br`), { force: true });
    sizes.files++;
    sizes.raw += own.length;
    sizes.br += Math.min(packed.length, own.length);
  }
  return sizes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Which release folder? node scripts/build-release.mjs <dir>');
    process.exit(2);
  }
  const { files, raw, br } = await precompress(dir);
  const kib = (/** @type {number} */ n) => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`${files} text files: ${kib(raw)} as they are, ${kib(br)} as brotli`);
}
