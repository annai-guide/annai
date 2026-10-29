#!/usr/bin/env node
// Builds the booking files in test/fixtures/bookings/ (dev only) for the hand-over tests: every name, company, code and person is
// invented (the repo is public: never a real booking). The same bytes on every run.
//   flight.pdf: two US-letter pages of text in Helvetica, the PDF objects written here (no library): the flight there, and back.
//   hotel.png: a booking screenshot, drawn with ImageMagick 7 (`magick`, as make-photo-fixtures.mjs uses it).
//   confirmation.txt: a pasted confirmation email for a rental car.
// Run: node scripts/make-booking-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../test/fixtures/bookings/', import.meta.url));
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

/** A page's content: lines of text from the top, in Helvetica at 16 pt; "\xb7" is WinAnsi's middle dot. @param {string[]} lines */
function text(lines) {
  const esc = (/** @type {string} */ s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  return Buffer.from(['BT', '/F1 16 Tf', '72 700 Td', '24 TL', ...lines.map((l) => `(${esc(l)}) '`), 'ET'].join('\n'), 'latin1');
}

const pages = [
  ['ANNAI AIR \xb7 Your trip is booked', 'Confirmation TESTQ1', 'Flight AN 123 \xb7 Fri Nov 20, 2026', 'Seattle (SEA) 11:20 to Anchorage (ANC) 14:05', 'Seat 14C \xb7 Traveller: Sam Rivera'],
  ['Return \xb7 Flight AN 124 \xb7 Fri Nov 27, 2026', 'Anchorage (ANC) 15:30 to Seattle (SEA) 20:05', 'Seat 14C \xb7 Traveller: Sam Rivera'],
];
// 1 catalog, 2 pages, 3 font, then each page and its content.
writeFileSync(`${out}flight.pdf`, pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ...pages.flatMap((lines, i) => [
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    /** @type {[string, Uint8Array]} */ (['<< >>', text(lines)]),
  ]),
]));

// A phone's screenshot of a hotel booking: black words on white, no dates in its metadata (so the bytes stay the same).
const hotel = ['Hotel Aurora Test, Anchorage', 'Check-in: Fri Nov 20, 2026', 'Check-out: Fri Nov 27, 2026', '7 nights · 1 room', 'Confirmation 88231'];
execFileSync('magick', [
  '-size', '390x300', 'xc:white', '-fill', 'black', '-pointsize', '20',
  ...hotel.flatMap((line, i) => ['-annotate', `+20+${40 + i * 44}`, line]),
  '-strip', '-define', 'png:exclude-chunks=date,time', `${out}hotel.png`,
], { stdio: ['ignore', 'ignore', 'inherit'] });

writeFileSync(`${out}confirmation.txt`, [
  'From: Midnight Test Rentals <bookings@example.com>',
  'Subject: Your car is reserved (TESTCAR7)',
  '',
  'Hi Sam,',
  '',
  'Your rental car is reserved.',
  'Pick-up: Fri Nov 20, 2026, 15:00, Anchorage Airport (ANC)',
  'Drop-off: Fri Nov 27, 2026, 13:00, Anchorage Airport (ANC)',
  'Car: compact, automatic',
  'Reservation: TESTCAR7',
  '',
  'Midnight Test Rentals',
  '',
].join('\n'));
