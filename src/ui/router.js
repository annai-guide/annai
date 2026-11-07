/**
 * Hash routes: "#/<screen>" (shell.js's SCREENS), "#/trip/<id>/<talk, file, plan, booking, item, recap or replay>", "#/waiting/file?path=…"
 * (a file waiting with Shiori), plugins' pages: "#/ext/<plugin>/<screen>", "#/plugin-page/<plugin>/<page>", "#/trip/<id>/ext/<plugin>/<tab>".
 * "#import=<url>" (spec §12.3) becomes the import screen with that URL. A mangled link (a broken %-escape) opens Trips.
 * @param {string} hash
 * @returns {{ name: string, parts: string[], params: Record<string, string> }}
 */
export function parseHash(hash) {
  try {
    return parse(hash);
  } catch {
    return { name: 'trips', parts: ['trips'], params: {} };
  }
}

/** @param {string} hash */
function parse(hash) {
  const raw = hash.replace(/^#/, '');
  if (raw.startsWith('import=')) return { name: 'import', parts: ['import'], params: { url: decodeURIComponent(raw.slice('import='.length)) } };
  const h = raw.startsWith('/') ? raw : '/trips';
  const q = h.indexOf('?');
  const path = q < 0 ? h : h.slice(0, q);
  const query = q < 0 ? '' : h.slice(q + 1);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) parts.push('trips');
  const SUB = { talk: 'talk', file: 'file', plan: 'plan', booking: 'booking', item: 'item', recap: 'recap', replay: 'replay', ext: 'trip-ext' };
  const name = parts[0] === 'trip' && Object.hasOwn(SUB, parts[2] ?? '') ? SUB[/** @type {keyof typeof SUB} */ (parts[2])]
    : parts[0] === 'waiting' && parts[1] === 'file' ? 'waiting-file' : parts[0];
  return { name, parts, params: Object.fromEntries(new URLSearchParams(query)) };
}

/**
 * Where an address that names no trip goes while one is open: "#/talk" and "#/plan" are the open trip's, at its own address, so phone
 * Back never shows another conversation. Null for anything else, and while none is open (they show the no-trip screens until stage 7).
 * @param {{ parts: string[] }} route @param {string | null} target the trip being opened, or open
 * @returns {string | null}
 */
export function redirectOf(route, target) {
  if (!target || route.parts.length !== 1 || !['talk', 'plan'].includes(route.parts[0])) return null;
  return `#/trip/${encodeURIComponent(target)}/${route.parts[0]}`;
}
