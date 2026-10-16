import { ZipReader, ZipError } from './zip.js';

/**
 * Apple Wallet passes (spec §8: ".pkpass files are zips containing pass.json, read by our own
 * unzip. They become bookings."). annai reads what a pass says; Shiori writes the booking (§7.3).
 */

export const PASS_MAX = 8 * 1024 * 1024; // a pass is its pass.json, a few images and a signature
const JSON_MAX = 1024 * 1024;
const STRINGS_MAX = 1024 * 1024;
const FIELDS_MAX = 80;
const VALUE_MAX = 500;
const STYLES = ['boardingPass', 'eventTicket', 'coupon', 'storeCard', 'generic'];
const SECTIONS = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields'];

/** Text in UTF-8, or in UTF-16 when it starts with a byte-order mark. @param {Uint8Array} b */
function decode(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder().decode(b);
}

/** A pass.strings file's "key" = "value"; pairs. @param {string} text @returns {Map<string, string>} */
export function passStrings(text) {
  const unquote = (/** @type {string} */ s) => s.replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g)) out.set(unquote(m[1]), unquote(m[2]));
  return out;
}

/** @param {unknown} v */
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * What a Wallet pass says, as a small object for Shiori: who issued it, its kind, dates and
 * places, every field with its label, and its barcode's text. Labels and values are looked up
 * in the pass's English strings, or its first language's.
 * @param {Blob} file @returns {Promise<Record<string, any>>}
 */
export async function readPass(file) {
  if (file.size > PASS_MAX) throw new Error(`This file is larger (${(file.size / 1048576).toFixed(1)} MB) than a Wallet pass ever is, so annai didn't open it.`);
  /** @type {ZipReader} */
  let zip;
  try {
    zip = await ZipReader.open(file, { maxEntry: PASS_MAX, maxTotal: PASS_MAX });
  } catch (e) {
    throw new Error(`annai couldn't open this Wallet pass: ${e instanceof ZipError ? e.message : 'it is damaged'}.`);
  }
  if (!zip.has('pass.json')) throw new Error("This isn't a Wallet pass: it has no pass.json.");
  if (zip.size('pass.json') > JSON_MAX) throw new Error("This pass's pass.json is larger than any pass's, so annai didn't read it.");
  /** @type {any} */
  let pass;
  try {
    pass = JSON.parse(decode(await zip.read('pass.json')));
  } catch (e) {
    throw new Error(e instanceof ZipError ? `annai couldn't open this Wallet pass: ${e.message}.` : "This pass's pass.json isn't valid JSON, so annai can't read it.");
  }
  if (!isObject(pass)) throw new Error("This pass's pass.json isn't valid JSON, so annai can't read it.");
  const lang = ['en.lproj/pass.strings', ...zip.names().filter((n) => /^[^/]+\.lproj\/pass\.strings$/.test(n)).sort()]
    .find((n) => zip.has(n) && zip.size(n) <= STRINGS_MAX);
  const strings = lang ? passStrings(decode(await zip.read(lang))) : new Map();
  /** A value as Shiori sees it: looked up in the strings, and cut when long. @param {unknown} v */
  const say = (v) => {
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v !== 'string') return undefined;
    const s = strings.get(v) ?? v;
    return s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX)}…` : s;
  };
  const style = STYLES.find((s) => isObject(pass[s]));
  const body = style ? pass[style] : {};
  /** @type {Record<string, any>[]} */
  const fields = [];
  for (const section of SECTIONS) {
    for (const f of Array.isArray(body[section]) ? body[section] : []) {
      if (!isObject(f) || fields.length >= FIELDS_MAX) continue;
      const value = say(f.value);
      if (value === undefined) continue;
      const label = say(f.label);
      fields.push({ section: section.replace('Fields', ''), key: String(f.key ?? ''), ...(label !== undefined ? { label } : {}), value });
    }
  }
  /** @type {Record<string, any>[]} */
  const barcodes = [];
  for (const b of [...(Array.isArray(pass.barcodes) ? pass.barcodes : []), pass.barcode]) {
    if (!isObject(b) || typeof b.message !== 'string' || barcodes.some((x) => x.message === b.message.slice(0, VALUE_MAX)) || barcodes.length >= 4) continue;
    barcodes.push({ format: String(b.format ?? ''), message: b.message.slice(0, VALUE_MAX), ...(typeof b.altText === 'string' ? { altText: say(b.altText) } : {}) });
  }
  const locations = (Array.isArray(pass.locations) ? pass.locations : [])
    .filter((/** @type {any} */ l) => Number.isFinite(l?.latitude) && Number.isFinite(l?.longitude)).slice(0, 10)
    .map((/** @type {any} */ l) => ({ lat: l.latitude, lng: l.longitude, ...(typeof l.relevantText === 'string' ? { text: say(l.relevantText) } : {}) }));
  const semantics = isObject(pass.semantics) && JSON.stringify(pass.semantics).length <= 8000 ? pass.semantics : undefined;
  // JSON drops what is undefined.
  return JSON.parse(JSON.stringify({
    kind: 'Apple Wallet pass', style, transitType: style === 'boardingPass' ? say(body.transitType) : undefined,
    organization: say(pass.organizationName), description: say(pass.description), logoText: say(pass.logoText),
    relevantDate: say(pass.relevantDate), expirationDate: say(pass.expirationDate), voided: pass.voided === true ? true : undefined,
    locations: locations.length ? locations : undefined, semantics, fields, barcodes: barcodes.length ? barcodes : undefined,
  }));
}
