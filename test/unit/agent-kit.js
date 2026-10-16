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
import { readConfig, saveEndpoint, saveRoles } from '../../src/core/llm/config.js';
import { Agent } from '../../src/core/agent/loop.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { readFile } from 'node:fs/promises';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';
import { utf8 } from '../../src/core/bytes.js';

/**
 * A codec that "decodes" a source written as "WxH" and reports what it was asked.
 * @param {string[]} [formats] the formats it can make (all when not given)
 */
export function fakeCodec(formats) {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    async canMake(/** @type {string} */ type) {
      return !formats || formats.includes(type);
    },
    async encode(/** @type {Blob} */ blob, /** @type {any} */ o) {
      calls.push(o);
      if ((await blob.text()) === 'unreadable') throw new Error("This browser can't read that photo.");
      const [w, h] = ((await blob.text()).match(/(\d+)x(\d+)/) ?? ['', '0', '0']).slice(1).map(Number);
      const box = o.crop ?? { width: w, height: h };
      const s = Math.min(1, (o.maxEdge ?? Infinity) / Math.max(box.width, box.height));
      const width = Math.floor(box.width * s);
      const height = Math.floor(box.height * s);
      return { bytes: utf8(`${width}x${height}:${JSON.stringify(o.crop ?? null)}:${o.maxBytes ?? ""}`), type: o.formats[0], width, height };
    },
  };
}

/**
 * A memory-backed annai with the built-in file tools, one scripted endpoint and model per script
 * (all in the main role, in order), and an Agent on a fresh trip. Every request a model receives is
 * kept in `requests`.
 * @param {any[][]} scripts @param {{ models?: any[], open?: boolean, agent?: Record<string, any>, utility?: any[], codecFormats?: string[], uploading?: boolean }} [opts]
 *   uploading: whether the main model's endpoint takes photos by upload
 *   utility: a script for one more scripted model, in the utility role
 */
export async function agentKit(scripts, { models = [], open = true, agent: agentOpts = {}, utility, codecFormats, uploading = false } = {}) {
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
  // Kept in the workspace like the app's, so what the Agent saves on a model (a photo limit) is what the next call reads.
  for (const id of Object.keys(config.endpoints)) await saveEndpoint(ws, config.endpoints[id], Object.values(config.models).filter((/** @type {any} */ m) => m.endpoint === id));
  await saveRoles(ws, config.roles);
  const bench = new Bench();
  const llm = {
    bench,
    config: () => readConfig(ws),
    uploading: async () => uploading,
    /** @param {any} c */
    call: async (c) => callRole({
      role: c.role ?? 'main', request: c.request, level: c.level, config: await readConfig(ws), types: new Map([['scripted', watched]]), keyFor: async () => null, bench,
      signal: c.signal, onEvent: c.onEvent, prefer: c.prefer, record: c.record, repairImages: c.repairImages, sleep: async () => {}, trace: modelTrace(store, c.scope ?? SYS),
    }),
  };
  /** @type {any[]} */
  const notices = [];
  const codec = fakeCodec(codecFormats);
  const agent = new Agent({ store, ws, llm, registry, codec, timeZone: () => 'UTC', secondMs: 10, ...agentOpts });
  agent.addLoopTools(selfTools(agent));
  agent.on('notice', (n) => notices.push(n));
  /** @type {Record<string, string>} annai's own personalities, as shipped */
  const presets = {};
  for (const n of ['shiori', 'storyteller', 'quiet']) presets[n] = await readFile(new URL(`../../assets/personalities/${n}.md`, import.meta.url), 'utf8');
  if (open) await agent.open(trip);
  /** @param {string[]} [types] */
  const events = (types) => store.tx(['events'], 'readonly', (t) => t.listEvents(trip, types ? { types } : {}));
  return { store, ws, trip, registry, host, agent, llm, requests, events, notices, presets, codec };
}
