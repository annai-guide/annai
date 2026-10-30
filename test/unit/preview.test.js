import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pdfPages } from '../../src/ui/preview.js';
import { utf8 } from '../../src/core/bytes.js';

test('pdfPages: the page count of the flight fixture; null for no PDF; a count past 2 MiB is not looked for', async () => {
  assert.equal(pdfPages(await readFile('test/fixtures/bookings/flight.pdf')), 2);
  assert.equal(pdfPages(utf8('not a pdf /Type /Pages /Count 9')), null);
  const big = new Uint8Array(3 * 1024 * 1024);
  big.set(utf8('%PDF-1.4\n'));
  big.set(utf8('<< /Type /Pages /Count 4 >>'), 2.5 * 1024 * 1024);
  assert.equal(pdfPages(big), null);
});

test("pdfPages: the largest count of a page tree, never a page's or the catalog's; none found is null", () => {
  // A tree of two nodes: the root counts every page.
  const tree = utf8('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Kids [3 0 R 4 0 R] /Count 12 /Type /Pages >> endobj\n3 0 obj << /Type /Pages /Parent 2 0 R /Count 5 /Kids [] >> endobj\n5 0 obj << /Type /Page /Count 99 >> endobj\n');
  assert.equal(pdfPages(tree), 12);
  // A scan whose objects are compressed shows no page tree: left out, not guessed.
  assert.equal(pdfPages(utf8('%PDF-1.5\n1 0 obj << /Type /ObjStm /N 40 /Length 9 /Filter /FlateDecode >> stream\nxxxxxxxxx\nendstream')), null);
  assert.equal(pdfPages(utf8('%PDF-1.4\n<< /Type /Pages /Count -3 >>')), null);
  assert.equal(pdfPages(new Uint8Array(0)), null);
});
