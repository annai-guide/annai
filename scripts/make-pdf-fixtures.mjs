#!/usr/bin/env node
// Builds the small PDFs in test/fixtures/pdf/ (dev only, no dependency): the objects, the xref table and the trailer are written
// here, the same bytes on every run. Made-up words only; the repo is public, so never a real booking.
//   booking.pdf: 3 US-letter pages of text in Helvetica (not embedded).
//   scan.pdf: 1 page holding only test/fixtures/photos/upright.jpg (its left half red, its right half blue) drawn over the page.
//   blank.pdf: a page of text, then a page with nothing drawn on it.
// Run: node scripts/make-pdf-fixtures.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../test/fixtures/pdf/', import.meta.url));
mkdirSync(out, { recursive: true });

/**
 * A PDF of the given objects (object 1 is the catalog), each a string or, for a stream, [dictionary, bytes].
 * @param {(string | [string, Uint8Array])[]} objects @returns {Buffer}
 */
function pdf(objects) {
  /** @type {Buffer[]} */
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let at = parts[0].length;
  /** @type {number[]} */
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(at);
    const body = typeof o === 'string'
      ? [Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')]
      : [Buffer.from(`${i + 1} 0 obj\n${o[0].replace('>>', ` /Length ${o[1].length} >>`)}\nstream\n`, 'latin1'), Buffer.from(o[1]), Buffer.from('\nendstream\nendobj\n', 'latin1')];
    for (const b of body) {
      parts.push(b);
      at += b.length;
    }
  });
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** A page's content: lines of text from the top, in Helvetica at 18 pt; "·" is WinAnsi's periodcentered. @param {string[]} lines */
function text(lines) {
  const esc = (/** @type {string} */ s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  return Buffer.from(['BT', '/F1 18 Tf', '72 700 Td', '26 TL', ...lines.map((l) => `(${esc(l)}) '`), 'ET'].join('\n'), 'latin1');
}

const pages = [
  ['ANNAI AIR \xb7 Confirmation TEST42', 'Flight AN 123 \xb7 Seattle SEA 08:05 to Anchorage ANC 11:20', 'Fri Nov 20, 2026 \xb7 Seat 14D'],
  ['Return \xb7 Flight AN 124', 'Anchorage ANC 13:00 to Seattle SEA 17:35', 'Fri Nov 27, 2026'],
  ['Bags: one carry-on, one checked'],
];
// 1 catalog, 2 pages, 3 font, then each page and its content.
const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
writeFileSync(`${out}booking.pdf`, pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ...pages.flatMap((lines, i) => [
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    /** @type {[string, Uint8Array]} */ (['<< >>', text(lines)]),
  ]),
]));

// blank.pdf: a page of text, then a page with nothing drawn on it (as a real booking's last page was: two operators, no text, no picture).
writeFileSync(`${out}blank.pdf`, pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
  ['<< >>', text(['Hotel TEST42 \xb7 Check-in 15:00'])],
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>',
  ['<< >>', Buffer.from('q Q', 'latin1')],
]));

const jpeg = readFileSync(fileURLToPath(new URL('../test/fixtures/photos/upright.jpg', import.meta.url)));
writeFileSync(`${out}scan.pdf`, pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
  ['<< /Type /XObject /Subtype /Image /Width 64 /Height 48 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', jpeg],
  ['<< >>', Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q', 'latin1')],
]));
