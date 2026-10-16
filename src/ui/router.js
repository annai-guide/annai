/**
 * Hash routes: "#/trips", "#/trip/<id>", "#/trip/<id>/file?path=…", "#/plan" (the open trip's), "#/trip/<id>/plan", "#/trip/<id>/booking?path=…", "#/settings",
 * "#/plugins", "#/models", "#/shiori" (?edit=, ?compare=), "#/talk", "#/tools", "#/models/endpoint?id=…", "#/models/model?id=…", "#/trace", "#/import?inbox=1". "#import=<url>" (spec §12.3)
 * becomes the import screen with that URL. A mangled link (a broken %-escape) opens Trips.
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
  const SUB = { file: 'file', plan: 'plan', booking: 'booking' };
  const name = parts[0] === 'trip' && Object.hasOwn(SUB, parts[2] ?? '') ? SUB[/** @type {keyof typeof SUB} */ (parts[2])] : parts[0];
  return { name, parts, params: Object.fromEntries(new URLSearchParams(query)) };
}
