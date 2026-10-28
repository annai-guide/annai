#!/usr/bin/env node
// Packs PDF.js's 168 packed CMaps into one file for the PDF pages plugin (dev only; the review of reading-files, finding 9), so annai's
// catalog lists one file, not 168, and an install makes about 30 requests, not 198. Each CMap goes in byte for byte, with its SHA-256.
//   node scripts/pack-pdfjs.mjs <pdfjs-dist package folder>          writes plugins-official/pdf-pages/vendor/pdfjs/cmaps.pack
//   node scripts/pack-pdfjs.mjs --check <pdfjs-dist package folder>  says whether the pack holds exactly that package's CMaps
// The pack: one line of JSON, { "source", "files": { name: [at, size, sha256] } }, then the files' bytes, at counted from after that line.
// The plugin reads it with unpack() (plugins-official/pdf-pages/index.js); test/unit/pdf-pages-pack.test.js checks every file's hash.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../plugins-official/pdf-pages/vendor/pdfjs/cmaps.pack', import.meta.url));
const check = process.argv[2] === '--check';
const pkg = process.argv[check ? 3 : 2];
if (!pkg) {
  console.error('usage: node scripts/pack-pdfjs.mjs [--check] <pdfjs-dist package folder>');
  process.exit(2);
}
const { version } = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
const names = (await readdir(join(pkg, 'cmaps'))).filter((n) => n.endsWith('.bcmap')).sort();
/** @type {Record<string, [number, number, string]>} */
const files = {};
/** @type {Buffer[]} */
const parts = [];
let at = 0;
for (const name of names) {
  const bytes = await readFile(join(pkg, 'cmaps', name));
  files[name] = [at, bytes.length, createHash('sha256').update(bytes).digest('hex')];
  parts.push(bytes);
  at += bytes.length;
}
const pack = Buffer.concat([Buffer.from(`${JSON.stringify({ source: `pdfjs-dist@${version} cmaps`, files })}\n`), ...parts]);
if (check) {
  const same = Buffer.compare(pack, await readFile(out).catch(() => Buffer.alloc(0))) === 0;
  console.log(same ? `cmaps.pack holds pdfjs-dist@${version}'s ${names.length} CMaps` : `cmaps.pack differs from pdfjs-dist@${version}'s CMaps: run node scripts/pack-pdfjs.mjs ${pkg}`);
  process.exit(same ? 0 : 1);
}
await writeFile(out, pack);
console.log(`wrote ${out}: ${names.length} CMaps, ${pack.length} bytes`);
