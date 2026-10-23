/**
 * Serper as a search provider for web_search (spec §7.2): POST https://google.serper.dev/search with the
 * key in X-API-KEY, which Serper's CORS answer allows a web app. The key is this plugin's own secret.
 */

/** @param {any} annai */
export function activate(annai) {
  const key = async () => {
    const k = await annai.secrets.get('key');
    return typeof k === 'string' && k ? k : null;
  };
  return annai.register('search', {
    id: 'serper', name: 'Serper', kind: 'web',
    async ready() {
      return (await key()) ? { ok: true } : { ok: false, why: 'needs a key (Settings → Plugins → Serper Search)' };
    },
    /** @param {string} query @param {{ fetch: any, signal: AbortSignal, limit?: number }} c */
    async search(query, { fetch, signal, limit = 8 }) {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-api-key': /** @type {string} */ (await key()) },
        body: JSON.stringify({ q: query, num: limit }),
      });
      if (!res.ok) {
        const said = String((await annai.helpers.readAnswer(res, 'json', 'Serper').catch(() => null))?.message ?? '');
        // Out of credits comes as a 400 "Not enough credits": a limit, to rest on.
        const s = /credit/i.test(said) ? 402 : res.status;
        throw Object.assign(new Error(s === 402 ? 'Serper is out of credits' : s === 401 || s === 403 ? 'Serper refused the key' : `Serper answered ${res.status}`), { status: s });
      }
      const body = await annai.helpers.readAnswer(res, 'json', 'Serper');
      const box = body?.answerBox;
      const answer = box && (box.link || box.url) ? [{ title: box.title ?? 'Answer', url: box.link ?? box.url, snippet: box.answer ?? box.snippet }] : [];
      return [...answer, ...(Array.isArray(body?.organic) ? body.organic : []).map((/** @type {any} */ r) => ({ title: r?.title, url: r?.link, snippet: r?.snippet }))];
    },
  });
}
