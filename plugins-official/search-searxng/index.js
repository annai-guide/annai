/**
 * SearXNG as a search provider for web_search (spec §7.2): a GET of <your address>/search?q=…&format=json.
 * It has no custom headers, so the browser asks no CORS preflight; the instance must still send
 * Access-Control-Allow-Origin, and have json in its search formats. No key; the address is the setting.
 */

/** @param {any} annai */
export function activate(annai) {
  const address = async () => String((await annai.settings.get()).url ?? '').trim();
  return annai.register('search', {
    id: 'searxng', name: 'SearXNG', kind: 'web',
    async ready() {
      const url = await address();
      if (!url) return { ok: false, why: 'needs the address of your instance (Settings → Plugins → SearXNG Search)' };
      const wrong = annai.helpers.addressProblem(url);
      return wrong ? { ok: false, why: wrong } : { ok: true };
    },
    /** @param {string} query @param {{ fetch: any, signal: AbortSignal, limit?: number }} c */
    async search(query, { fetch, signal, limit = 8 }) {
      const base = (await address()).replace(/\/+$/, '');
      let res;
      try {
        res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, { signal });
      } catch (e) {
        if (/** @type {any} */ (e)?.name === 'AbortError' || /** @type {any} */ (e)?.name === 'TimeoutError') throw e;
        throw Object.assign(new Error(`annai couldn't reach your SearXNG at ${base}. Check the address, that it is running, and that it sends Access-Control-Allow-Origin for annai's address.`), { kind: 'cors' });
      }
      if (res.status === 403) throw Object.assign(new Error('Your SearXNG refused JSON: put json under search: formats: in its settings.yml.'), { status: 403 });
      if (!res.ok) throw Object.assign(new Error(`Your SearXNG answered ${res.status}`), { status: res.status });
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== 'object') throw new Error('Your SearXNG sent an answer annai can\'t read: json must be one of its search formats.');
      return (Array.isArray(body.results) ? body.results : []).slice(0, limit).map((/** @type {any} */ r) => ({ title: r?.title, url: r?.url, snippet: r?.content }));
    },
  });
}
