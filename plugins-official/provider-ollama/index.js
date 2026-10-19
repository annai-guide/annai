/**
 * Ollama's provider plugin with code (decision 22): its OpenAI-style list gives ids only, so each model is
 * looked up in Ollama's own API, at the address's root. The context: the one a loaded model was given
 * (/api/ps, as "ollama ps" shows it), else its Modelfile's num_ctx (/api/show); never the context it was
 * trained on, which Ollama doesn't give it unless told (OLLAMA_CONTEXT_LENGTH). Photos and tools from its
 * capabilities. A model that lists thinking gets the named levels; one that can't think keeps the plugin's
 * map, where only off is named, as Ollama refuses a named level for it.
 */

/** The address without its /v1, where Ollama's own API is. @param {string} base */
const root = (base) => String(base).replace(/\/+$/, '').replace(/\/v1$/, '');
const LEVELS = { off: { reasoning_effort: 'none' }, low: { reasoning_effort: 'low' }, medium: { reasoning_effort: 'medium' }, high: { reasoning_effort: 'high' } };

/** @param {{ ability: string, endpoint: any, key: string | null, fetch: (url: string, init?: RequestInit) => Promise<Response>, protocolList: () => Promise<any[]> }} c */
export async function list({ endpoint, fetch, protocolList }) {
  const listed = await protocolList();
  const base = root(endpoint.baseUrl);
  /** @param {string} path @param {RequestInit} [init] */
  const ask = (path, init) => fetch(`${base}${path}`, { ...init, headers: { ...endpoint.headers, ...init?.headers } }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
  const running = await ask('/api/ps');
  /** @type {Map<string, number>} */
  const served = new Map((Array.isArray(running?.models) ? running.models : []).map((/** @type {any} */ m) => [String(m.model ?? m.name), m.context_length]));
  return Promise.all(listed.map(async (m) => {
    const show = await ask('/api/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.providerId }) });
    const caps = Array.isArray(show?.capabilities) ? show.capabilities : null;
    const n = served.get(m.providerId) ?? Number(/^num_ctx\s+(\d+)/m.exec(String(show?.parameters ?? ''))?.[1]);
    return {
      ...m,
      ...(Number.isInteger(n) && n > 0 ? { contextWindow: n } : {}),
      ...(caps ? { input: ['text', ...(caps.includes('vision') ? ['image'] : [])], tools: caps.includes('tools') } : {}),
      ...(caps?.includes('thinking') ? { reasoning: LEVELS } : {}),
    };
  }));
}

/** @param {any} annai */
export function activate(annai) {
  return annai.providers.setup({ list });
}
