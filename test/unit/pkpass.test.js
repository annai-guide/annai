import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPass, passStrings, PASS_MAX } from '../../src/core/pkpass.js';
import { ZipWriter } from '../../src/core/zip.js';
import { utf8 } from '../../src/core/bytes.js';

/** A zip of these entries. @param {Record<string, string | Uint8Array>} entries */
async function zip(entries) {
  const z = new ZipWriter();
  for (const [name, v] of Object.entries(entries)) await z.add(name, typeof v === 'string' ? utf8(v) : v);
  return z.finish();
}
/** UTF-16 with a byte-order mark, as Apple's tools write .strings files. @param {string} s @param {boolean} [be] */
function utf16(s, be = false) {
  const out = new Uint8Array(2 + s.length * 2);
  out.set(be ? [0xfe, 0xff] : [0xff, 0xfe]);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2 + (be ? 1 : 0)] = c & 0xff;
    out[2 + i * 2 + (be ? 0 : 1)] = c >> 8;
  }
  return out;
}

const PASS = {
  formatVersion: 1, passTypeIdentifier: 'pass.com.example.air', serialNumber: '1', teamIdentifier: 'X',
  organizationName: 'Example Air', description: 'boarding_desc', relevantDate: '2026-11-25T08:00-08:00',
  locations: [{ latitude: 37.6213, longitude: -122.379, relevantText: 'At SFO' }, { latitude: 'north' }],
  barcodes: [{ format: 'PKBarcodeFormatQR', message: 'M1PAN/YUFEI ABC123 SFOEWRUA 0123', messageEncoding: 'iso-8859-1', altText: 'ABC123' }],
  barcode: { format: 'PKBarcodeFormatQR', message: 'M1PAN/YUFEI ABC123 SFOEWRUA 0123', messageEncoding: 'iso-8859-1' },
  semantics: { airlineCode: 'UA', flightNumber: 123, departureGate: '42' },
  boardingPass: {
    transitType: 'PKTransitTypeAir',
    headerFields: [{ key: 'gate', label: 'gate_label', value: '42' }],
    primaryFields: [{ key: 'origin', label: 'SFO', value: 'San Francisco' }, { key: 'destination', label: 'EWR', value: 'Newark' }],
    auxiliaryFields: [{ key: 'seat', label: 'Seat', value: '21C' }, { key: 'boards', label: 'Boards', value: '2026-11-25T07:20-08:00', dateStyle: 'PKDateStyleShort' }, { key: 'weird', value: { nested: true } }, 'not a field'],
    backFields: [{ key: 'conf', label: 'Confirmation', value: 'ABC123' }],
  },
};

test('readPass: what a boarding pass says, with its English labels from UTF-16 strings', async () => {
  const strings = '"boarding_desc" = "Boarding pass";\n"gate_label" = "Gate";\n';
  const got = await readPass(await zip({ 'pass.json': JSON.stringify(PASS), 'en.lproj/pass.strings': utf16(strings), 'icon.png': new Uint8Array(10) }));
  assert.deepEqual(got, {
    kind: 'Apple Wallet pass', style: 'boardingPass', transitType: 'PKTransitTypeAir', organization: 'Example Air', description: 'Boarding pass',
    relevantDate: '2026-11-25T08:00-08:00', locations: [{ lat: 37.6213, lng: -122.379, text: 'At SFO' }],
    semantics: { airlineCode: 'UA', flightNumber: 123, departureGate: '42' },
    fields: [
      { section: 'header', key: 'gate', label: 'Gate', value: '42' },
      { section: 'primary', key: 'origin', label: 'SFO', value: 'San Francisco' },
      { section: 'primary', key: 'destination', label: 'EWR', value: 'Newark' },
      { section: 'auxiliary', key: 'seat', label: 'Seat', value: '21C' },
      { section: 'auxiliary', key: 'boards', label: 'Boards', value: '2026-11-25T07:20-08:00' },
      { section: 'back', key: 'conf', label: 'Confirmation', value: 'ABC123' },
    ],
    barcodes: [{ format: 'PKBarcodeFormatQR', message: 'M1PAN/YUFEI ABC123 SFOEWRUA 0123', altText: 'ABC123' }],
  });
  // Big-endian strings, and a pass in another language only.
  const de = await readPass(await zip({ 'pass.json': JSON.stringify(PASS), 'de.lproj/pass.strings': utf16('"gate_label" = "Flugsteig";', true) }));
  assert.equal(de.fields[0].label, 'Flugsteig');
});

test('passStrings: quoted pairs with escapes', () => {
  assert.deepEqual([...passStrings('"a" = "x \\"quoted\\"";\n"b"="line\\none";')], [['a', 'x "quoted"'], ['b', 'line\none']]);
});

test('readPass: many fields are cut to 80, and long values to 500 characters', async () => {
  const generic = { generic: { backFields: Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, value: 'v'.repeat(900) })) } };
  const got = /** @type {any} */ (await readPass(await zip({ 'pass.json': JSON.stringify(generic) })));
  assert.equal(got.fields.length, 80);
  assert.equal(got.fields[0].value.length, 501); // 500 and "…"
});

test('readPass: what is not a pass, or is a hostile one, gets plain words', async () => {
  await assert.rejects(readPass(new Blob(['hello'])), /couldn't open this Wallet pass: this is not a zip archive/);
  await assert.rejects(readPass(await zip({ 'other.txt': 'x' })), /isn't a Wallet pass: it has no pass\.json/);
  await assert.rejects(readPass(await zip({ 'pass.json': '{nope' })), /pass\.json isn't valid JSON/);
  await assert.rejects(readPass(await zip({ 'pass.json': '[1, 2]' })), /pass\.json isn't valid JSON/);
  await assert.rejects(readPass(new Blob([new Uint8Array(PASS_MAX + 1)])), /larger \(8\.0 MB\) than a Wallet pass ever is/);
  // A zip bomb: a pass.json that unpacks to more than any pass holds.
  await assert.rejects(readPass(await zip({ 'pass.json': new Uint8Array(PASS_MAX + 1024) })), /too large to open here/);
});
