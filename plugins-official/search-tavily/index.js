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
      return (await key()) ? { ok: true } : { ok: false, why: 'needs a key (Settings → Plugins → Tavily Search)' };
    },
    /** @param {string} query @param {{ fetch: any, signal: AbortSignal, limit?: number }} c */
    async search(query, { fetch, signal, limit = 8 }) {
      const depth = (await annai.settings.get()).depth === 'advanced' ? 'advanced' : 'basic';
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await key()}` },
        body: JSON.stringify({ query, search_depth: depth, max_results: limit, include_answer: false }),
      });
      // 432 and 433 are Tavily's plan and pay-as-you-go limits: a limit, like a 429.
      if (!res.ok) {
        const s = res.status === 432 || res.status === 433 ? 429 : res.status;
        throw Object.assign(new Error(s === 401 ? 'Tavily refused the key' : s === 429 ? 'Tavily is out of credits or rate limited' : `Tavily answered ${res.status}`), { status: s });
      }
      const body = await res.json().catch(() => null);
      return (Array.isArray(body?.results) ? body.results : []).map((/** @type {any} */ r) => ({ title: r?.title, url: r?.url, snippet: r?.content }));
    },
  });
}
