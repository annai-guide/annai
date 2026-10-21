/**
 * llama.cpp's provider plugin with code (decision 22): its model list says the context the model was
 * trained on, not the one llama-server serves, so the list is read with /props, at the address's root:
 * the context each conversation gets, and whether the loaded model reads images or hears audio. /props
 * describes the one model the server has loaded (its model_alias), so only that model gets them, marked
 * loaded: under its name, and under a tag of it when that is the name's one tag listed, as Unsloth Studio
 * also lists it ("…-GGUF:Q5_K_M"). A server without /props lists as the protocol does.
 */

/** The address without its /v1, where llama-server answers /props. @param {string} base */
const root = (base) => String(base).replace(/\/+$/, '').replace(/\/v1$/, '');

/** @param {{ ability: string, endpoint: any, key: string | null, fetch: (url: string, init?: RequestInit) => Promise<Response>, protocolList: () => Promise<any[]> }} c */
export async function list({ endpoint, key, fetch, protocolList }) {
  const listed = await protocolList();
  const props = await fetch(`${root(endpoint.baseUrl)}/props`, { headers: { ...endpoint.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) } })
    .then((res) => (res.ok ? res.json() : null)).catch(() => null);
  const n = props?.default_generation_settings?.n_ctx;
  const kinds = props?.modalities;
  const alias = props?.model_alias;
  const tags = listed.filter((m) => typeof alias === 'string' && m.providerId.startsWith(`${alias}:`));
  const named = listed.filter((m) => m.providerId === alias || (tags.length === 1 && m === tags[0]));
  const loaded = !props ? [] : named.length ? named : listed.length === 1 ? listed : [];
  return listed.map((m) => (!loaded.includes(m) ? m : {
    ...m,
    loaded: true,
    ...(Number.isInteger(n) && n > 0 ? { contextWindow: n } : {}),
    ...(kinds && typeof kinds === 'object' ? { input: ['text', ...(kinds.vision ? ['image'] : []), ...(kinds.audio ? ['audio'] : [])] } : {}),
  }));
}

/** @param {any} annai */
export function activate(annai) {
  return annai.providers.setup({ list });
}
