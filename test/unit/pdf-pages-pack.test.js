// The PDF pages plugin's packed CMaps (the review of reading-files, finding 9): PDF.js's 168 .bcmap files in one pack, so the catalog
// lists one file for them, not 168, and an install makes about 30 requests, not 198. The files inside are PDF.js's own, byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unpack } from '../../plugins-official/pdf-pages/index.js';

const root = new URL('../../', import.meta.url);

test("the CMap pack holds every one of PDF.js's 168 packed CMaps, each byte for byte as its index says", async () => {
  const files = unpack(new Uint8Array(await readFile(new URL('plugins-official/pdf-pages/vendor/pdfjs/cmaps.pack', root))));
  assert.equal(files.size, 168);
  for (const [name, { bytes, sha256 }] of files) {
    assert.match(name, /^[A-Za-z0-9-]+\.bcmap$/);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, name);
  }
  assert.ok(files.has('UniJIS-UCS2-H.bcmap') && files.has('Adobe-Japan1-UCS2.bcmap'));
});

test('the catalog lists the pack, not the CMaps one by one: PDF pages has at most 40 files', async () => {
  const catalog = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8'));
  const files = Object.keys(catalog.plugins.find((/** @type {any} */ p) => p.id === 'pdf-pages').files);
  assert.ok(files.length <= 40, `${files.length} files`);
  assert.ok(files.includes('vendor/pdfjs/cmaps.pack'));
  assert.ok(!files.some((f) => f.endsWith('.bcmap')));
  assert.ok(files.includes('vendor/pdfjs/cmaps/LICENSE'), 'the CMaps keep their licence');
});
