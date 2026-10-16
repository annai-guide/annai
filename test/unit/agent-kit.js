import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { callRole, Bench } from '../../src/core/llm/fallback.js';
import { Agent } from '../../src/core/agent/loop.js';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';

/**
 * A memory-backed annai with the built-in file tools, one scripted endpoint and model per script
 * (all in the main role, in order), and an Agent on a fresh trip. Every request a model receives is
 * kept in `requests`.
 * @param {any[][]} scripts @param {{ models?: any[], open?: boolean, agent?: Record<string, any>, utility?: any[] }} [opts]
 *   utility: a script for one more scripted model, in the utility role
 */
export async function agentKit(scripts, { models = [], open = true, agent: agentOpts = {}, utility } = {}) {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await host.addBuiltin(new URL('../../src/plugins/files/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  /** @type {any} */
  let type = null;
  scripted({ providers: { register: (/** @type {any} */ x) => { type = { ...x, pluginId: 'scripted-model' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  /** @type {any[]} */
  const requests = [];
  const watched = { ...type, run: (/** @type {any} */ c) => { requests.push(structuredClone(c.request)); return type.run(c); } };
  /** @type {any} */
  const config = { endpoints: {}, models: {}, roles: { main: { models: [], level: 'medium' }, utility: { models: [], level: 'low' }, decide: { models: [], level: 'off' } } };
  scripts.forEach((script, i) => {
    config.endpoints[`ep-${i}`] = { id: `ep-${i}`, type: 'scripted', template: null, user: { name: `E${i}`, tunables: { script } }, created: 0 };
    config.models[`m-${i}`] = { id: `m-${i}`, endpoint: `ep-${i}`, template: null, user: { providerId: `model-${i}`, prices: { input: 1, output: 1 }, input: ['text', 'image'], ...(models[i] ?? {}) }, created: 0 };
    config.roles.main.models.push(`m-${i}`);
  });
  if (utility) {
    config.endpoints['ep-u'] = { id: 'ep-u', type: 'scripted', template: null, user: { name: 'EU', tunables: { script: utility } }, created: 0 };
    config.models['m-u'] = { id: 'm-u', endpoint: 'ep-u', template: null, user: { providerId: 'model-u', prices: { input: 1, output: 1 }, input: ['text', 'image'] }, created: 0 };
    config.roles.utility.models = ['m-u'];
  }
  const bench = new Bench();
  const llm = {
    bench,
    config: async () => config,
    /** @param {any} c */
    call: (c) => callRole({
      role: c.role ?? 'main', request: c.request, level: c.level, config, types: new Map([['scripted', watched]]), keyFor: async () => null, bench,
      signal: c.signal, onEvent: c.onEvent, prefer: c.prefer, record: c.record, sleep: async () => {}, trace: modelTrace(store, c.scope ?? SYS),
    }),
  };
  /** @type {any[]} */
  const notices = [];
  const agent = new Agent({ store, ws, llm, registry, timeZone: () => 'UTC', secondMs: 10, ...agentOpts });
  agent.on('notice', (n) => notices.push(n));
  if (open) await agent.open(trip);
  /** @param {string[]} [types] */
  const events = (types) => store.tx(['events'], 'readonly', (t) => t.listEvents(trip, types ? { types } : {}));
  return { store, ws, trip, registry, host, agent, llm, config, requests, events, notices };
}
