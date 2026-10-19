/**
 * LM Studio's provider plugin with code (decision 22): its OpenAI-style list gives ids only, so the models
 * are looked up in LM Studio's own list (/api/v1/models, at the address's root): the context of a loaded
 * instance (never the most the model could take, which LM Studio doesn't load it with unless told), whether
 * it reads images, and whether it was trained for tool calls. An older LM Studio without that list lists as
 * the protocol does.
 */

/** The address without its /v1, where LM Studio's own API is. @param {string} base */
const root = (base) => String(base).replace(/\/+$/, '').replace(/\/v1$/, '');

/** @param {{ ability: string, endpoint: any, key: string | null, fetch: (url: string, init?: RequestInit) => Promise<Response>, protocolList: () => Promise<any[]> }} c */
export async function list({ endpoint, key, fetch, protocolList }) {
  const listed = await protocolList();
  const own = await fetch(`${root(endpoint.baseUrl)}/api/v1/models`, { headers: { ...endpoint.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) } })
    .then((res) => (res.ok ? res.json() : null)).catch(() => null);
  /** @type {Map<string, any>} its models by key, and by each loaded instance's id */
  const by = new Map();
  for (const m of Array.isArray(own?.models) ? own.models : []) {
    by.set(m.key, m);
    for (const i of m.loaded_instances ?? []) if (!by.has(i.id)) by.set(i.id, m);
  }
  return listed.map((m) => {
    const x = by.get(m.providerId);
    if (!x) return m;
    const instances = Array.isArray(x.loaded_instances) ? x.loaded_instances : [];
    const n = (instances.find((/** @type {any} */ i) => i.id === m.providerId) ?? instances[0])?.config?.context_length;
    const caps = x.capabilities;
    return {
      ...m,
      ...(Number.isInteger(n) && n > 0 ? { contextWindow: n } : {}),
      ...(caps && typeof caps === 'object' ? { input: ['text', ...(caps.vision ? ['image'] : [])], tools: Boolean(caps.trained_for_tool_use) } : {}),
    };
  });
}

/** @param {any} annai */
export function activate(annai) {
  return annai.providers.setup({ list });
}
