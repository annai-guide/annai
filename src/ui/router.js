/**
 * Hash routes: "#/trips", "#/trip/<id>", "#/trip/<id>/file?path=…" (&from= the Plan, booking or Now screen its crumb goes back to), "#/plan" (the open trip's), "#/trip/<id>/plan", "#/trip/<id>/booking?path=…", "#/settings",
 * "#/trip/<id>/recap", "#/trip/<id>/replay?day=…", "#/simulate", plugins' pages: "#/ext/<plugin>/<screen>", "#/plugin-page/<plugin>/<page>",
 * "#/trip/<id>/ext/<plugin>/<tab>",
 * "#/welcome" (and "#/welcome/2" to 6), "#/about" (and "#/about/licence", "#/about/fonts"), "#/experimental", "#/updates",
 * "#/plugins", "#/add" (the catalog: ?kind=providers from Models, ?ability=transcription or voice from a speech role; ?from= its crumb), "#/plugin-install" (the package picked on Add), "#/models", "#/voice", "#/shiori" (?edit=, ?compare=), "#/languages", "#/talk", "#/tools", "#/mcp" (MCP servers), "#/models/provider?id=…" (?new=<plugin>: a provider plugin's own Add flow), "#/models/model?id=…", "#/trace", "#/notifications", "#/import?inbox=1". "#import=<url>" (spec §12.3)
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
  const SUB = { file: 'file', plan: 'plan', booking: 'booking', recap: 'recap', replay: 'replay', ext: 'trip-ext' };
  const name = parts[0] === 'trip' && Object.hasOwn(SUB, parts[2] ?? '') ? SUB[/** @type {keyof typeof SUB} */ (parts[2])] : parts[0];
  return { name, parts, params: Object.fromEntries(new URLSearchParams(query)) };
}
