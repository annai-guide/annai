/**
 * Tavily as a search provider for web_search (spec §7.2): POST https://api.tavily.com/search with the
 * key as a bearer token, which Tavily's CORS answer allows a web app. The key is this plugin's own secret.
 */

/** @param {any} annai */
export function activate(annai) {
  const key = async () => {
    const k = await annai.secrets.get('key');
    return typeof k === 'string' && k ? k : null;
  };
  return annai.register('search', {
    id: 'tavily', name: 'Tavily', kind: 'web',
    async ready() {
      // Shiori is told why in English, and the screen shows it in its own words (annai's shown rule).
      const { message, shown } = annai.l10n.both`needs a key (Settings → Plugins → Tavily Search)`;
      return (await key()) ? { ok: true } : { ok: false, why: message, shown };
    },
    /** @param {string} query @param {{ fetch: any, signal: AbortSignal, limit?: number }} c */
    async search(query, { fetch, signal, limit = 8 }) {
      const depth = (await annai.settings.get()).depth === 'advanced' ? 'advanced' : 'basic';
      /** @type {Response} */
      let res;
      try {
        res = await fetch('https://api.tavily.com/search', {
          method: 'POST', signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${await key()}` },
          body: JSON.stringify({ query, search_depth: depth, max_results: limit, include_answer: false }),
        });
      } catch (e) {
        if (/** @type {any} */ (e)?.name === 'AbortError' || /** @type {any} */ (e)?.name === 'TimeoutError') throw e;
        // Tavily's 401 for a wrong key carries no CORS header, so a browser can't tell it from being offline.
        throw Object.assign(new Error("annai couldn't reach Tavily; check the key, or the device is offline"), { kind: 'cors' });
      }
      // 432 and 433 are Tavily's plan and pay-as-you-go limits: a limit, like a 429.
      if (!res.ok) {
        const s = res.status === 432 || res.status === 433 ? 429 : res.status;
        throw Object.assign(new Error(s === 401 ? 'Tavily refused the key' : s === 429 ? 'Tavily is out of credits or rate limited' : `Tavily answered ${res.status}`), { status: s });
      }
      const body = await annai.helpers.readAnswer(res, 'json', 'Tavily');
      return (Array.isArray(body?.results) ? body.results : []).map((/** @type {any} */ r) => ({ title: r?.title, url: r?.url, snippet: r?.content }));
    },
  });
}
