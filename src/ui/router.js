/**
 * Hash routes: "#/trips", "#/trip/<id>", "#/trip/<id>/file?path=…", "#/settings",
 * "#/plugins", "#/trace", "#/import?inbox=1". "#import=<url>" (spec §12.3)
 * becomes the import screen with that URL.
 * @param {string} hash
 * @returns {{ name: string, parts: string[], params: Record<string, string> }}
 */
export function parseHash(hash) {
  const raw = hash.replace(/^#/, '');
  if (raw.startsWith('import=')) return { name: 'import', parts: ['import'], params: { url: decodeURIComponent(raw.slice('import='.length)) } };
  const h = raw.startsWith('/') ? raw : '/trips';
  const q = h.indexOf('?');
  const path = q < 0 ? h : h.slice(0, q);
  const query = q < 0 ? '' : h.slice(q + 1);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) parts.push('trips');
  const name = parts[0] === 'trip' && parts[2] === 'file' ? 'file' : parts[0];
  return { name, parts, params: Object.fromEntries(new URLSearchParams(query)) };
}
