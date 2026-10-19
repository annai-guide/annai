import { SYS, SYS_SETTINGS } from '../scopes.js';
import { forget } from '../forget.js';
import { logEvent } from '../events.js';

/**
 * Moving over from endpoints to providers (milestone 1, decision 1): no conversion. The endpoints from
 * before go, with their models, their places in roles, their keys, their uploads and the templates
 * cache, files and history alike (spec §4.9), and a card names them so the user adds providers again.
 * A backup from before, restored later, is moved over again at the next start.
 * @param {import('../workspace.js').Workspace} ws @param {import('../types.js').Store} store
 * @returns {Promise<{ names: string[] } | null>} the endpoints' names, or null when there were none
 */
export async function moveOver(ws, store) {
  const endpoints = await ws.list(SYS_SETTINGS, '/llm/endpoints/');
  if (!endpoints.length) return null;
  /** @type {string[]} */
  const names = [];
  /** @type {Set<string>} */
  const ids = new Set();
  for (const f of endpoints) {
    const e = await ws.readJSON(SYS_SETTINGS, f.path).catch(() => null);
    if (typeof e?.id === 'string') ids.add(e.id);
    names.push(String(e?.user?.name || e?.template?.values?.name || e?.template?.id || e?.type || f.path.split('/').pop()?.replace(/\.json$/, '')));
  }
  /** @type {Set<string>} a model from before names its endpoint; a provider's names its provider */
  const old = new Set(endpoints.map((f) => f.path));
  const models = new Set();
  for (const f of await ws.list(SYS_SETTINGS, '/llm/models/')) {
    const m = await ws.readJSON(SYS_SETTINGS, f.path).catch(() => null);
    if (m && typeof m === 'object' && 'endpoint' in m) {
      old.add(f.path);
      if (typeof m.id === 'string') models.add(m.id);
    }
  }
  old.add('/llm/catalog/templates.json');
  await forget(store, SYS_SETTINGS, { files: (p) => old.has(p), history: (p) => old.has(p) });
  const roles = await ws.readJSON(SYS_SETTINGS, '/llm/roles.json').catch(() => null);
  if (roles && typeof roles === 'object') {
    const kept = Object.fromEntries(Object.entries(roles).map(([role, r]) => [role, { ...r, models: Array.isArray(r?.models) ? r.models.filter((/** @type {any} */ id) => !models.has(id)) : [] }]));
    await ws.write(SYS_SETTINGS, '/llm/roles.json', kept, { author: 'system' });
  }
  // Uploads were kept by endpoint; a provider's are "<provider>/<ability>".
  const uploads = await ws.readJSON(SYS_SETTINGS, '/llm/uploads.json').catch(() => null);
  if (uploads && typeof uploads === 'object' && Object.keys(uploads).some((k) => !k.includes('/'))) {
    await ws.write(SYS_SETTINGS, '/llm/uploads.json', Object.fromEntries(Object.entries(uploads).filter(([k]) => k.includes('/'))), { author: 'system' });
    await forget(store, SYS_SETTINGS, { history: (p) => p === '/llm/uploads.json' });
  }
  await store.tx(['secrets'], 'readwrite', async (t) => {
    for (const s of await t.listSecretIds()) if (s.startsWith('llm:') && ids.has(s.slice(4))) await t.deleteSecret(s);
  });
  await logEvent(store, SYS, { type: 'llm.moved', actor: 'system', data: { endpoints: endpoints.length, models: models.size } }).catch(() => {});
  return { names };
}
