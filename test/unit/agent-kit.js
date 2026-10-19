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
import { readConfig, saveProvider, saveRoles } from '../../src/core/llm/config.js';
import { Agent } from '../../src/core/agent/loop.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { readFile } from 'node:fs/promises';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';
import { utf8 } from '../../src/core/bytes.js';
import { Voice } from '../../src/core/voice/voice.js';
import { decide } from '../../src/core/llm/decide.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { fakePlatform } from './voice-fakes.js';
import { clip, quiet, cat } from './voice-kit.js';

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
 * A memory-backed annai with the built-in file tools, one scripted provider and model per script
 * (all in the main role, in order), and an Agent on a fresh trip. Every request a model receives is
 * kept in `requests`.
 * @param {(any[] | Record<string, any>)[]} scripts @param {{ models?: any[], open?: boolean, agent?: Record<string, any>, utility?: any[], codecFormats?: string[], uploading?: boolean,
 *   voice?: { mode?: 'on' | 'off' | 'auto', speechIn?: string[], hears?: string[], failing?: string[], decide?: any[], dictation?: boolean, keepClips?: boolean, playMs?: number, micFails?: string } }} [opts]
 *   uploading: whether the main model's provider takes photos by upload
 *   utility: a script for one more scripted model, in the utility role
 *   voice: Shiori with a voice (spec §10): a fake device; a voice (m-say) and a transcription model (m-hear) that hears hears, in turn (the last
 *   repeats); decide: a script for a quick-decision model (the gate); micFails: the microphone refuses with this error name
 */
export async function agentKit(scripts, { models = [], open = true, agent: agentOpts = {}, utility, codecFormats, uploading = false, voice: v } = {}) {
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
  const config = { providers: {}, models: {}, roles: { main: { models: [], level: 'medium' }, utility: { models: [], level: 'low' }, decide: { models: [], level: 'off' } } };
  /** A provider with one ability, and one model on it. @param {string} p @param {string} m @param {string} name @param {any} ability @param {any} user */
  const add = (p, m, name, ability, user) => {
    config.providers[p] = { id: p, plugin: 'provider-test', template: null, user: { name, abilities: { [ability.kind]: ability } }, created: 0 };
    config.models[m] = { id: m, provider: p, ability: ability.kind, template: null, user, created: 0 };
  };
  scripts.forEach((script, i) => {
    add(`pv-${i}`, `m-${i}`, `E${i}`, { kind: 'chat', type: 'scripted', tunables: Array.isArray(script) ? { script } : script },
      { providerId: `model-${i}`, prices: { input: 1, output: 1 }, input: ['text', 'image'], ...(models[i] ?? {}) });
    config.roles.main.models.push(`m-${i}`);
  });
  if (utility) {
    add('pv-u', 'm-u', 'EU', { kind: 'chat', type: 'scripted', tunables: { script: utility } }, { providerId: 'model-u', prices: { input: 1, output: 1 }, input: ['text', 'image'] });
    config.roles.utility.models = ['m-u'];
  }
  if (v) {
    add('pv-say', 'm-say', 'Say', { kind: 'voice', type: 'say' }, { providerId: 'voice' });
    add('pv-hear', 'm-hear', 'Hear', { kind: 'transcription', type: 'hear' }, { providerId: 'ears' });
    config.roles['speech-out'] = { models: ['m-say'], level: 'off' };
    config.roles['speech-in'] = { models: v.speechIn ?? ['send-audio', 'm-hear', 'dictation'], level: 'off' };
    if (v.decide) {
      add('pv-d', 'm-d', 'ED', { kind: 'chat', type: 'scripted', tunables: { script: v.decide } }, { providerId: 'model-d', prices: { input: 1, output: 1 }, input: ['text'] });
      config.roles.decide.models = ['m-d'];
    }
  }

  // Kept in the workspace like the app's, so what the Agent saves on a model (a photo limit) is what the next call reads.
  for (const id of Object.keys(config.providers)) await saveProvider(ws, config.providers[id], Object.values(config.models).filter((/** @type {any} */ m) => m.provider === id));
  await saveRoles(ws, config.roles);
  /** The endpoint types: the scripted model, and fake speech types whose calls the llm below answers. */
  const types = new Map([['scripted', watched], ['say', { type: 'say', name: 'Say', speech: 'out', pluginId: 'test' }], ['hear', { type: 'hear', name: 'Hear', speech: 'in', pluginId: 'test' }]]);
  /** @type {string[]} what the voice was asked to say */
  const said = [];
  /** @type {string[]} the transcription models asked, in turn */
  const transcribed = [];
  const hears = [...(v?.hears ?? ['what was said'])];
  const bench = new Bench();
  const llm = {
    bench,
    config: () => readConfig(ws),
    uploading: async () => uploading,
    /** @param {any} c */
    call: async (c) => callRole({
      role: c.role ?? 'main', request: c.request, level: c.level, config: await readConfig(ws), types, keyFor: async () => null, bench,
      signal: c.signal, onEvent: c.onEvent, prefer: c.prefer, record: c.record, repairImages: c.repairImages, sleep: async () => {}, trace: modelTrace(store, c.scope ?? SYS),
      speech: c.speech, firstOutputMs: c.firstOutputMs,
    }),
    types: () => types,
    /** @param {{ modelId: string, text: string }} c */
    synthesize: async (c) => {
      said.push(c.text);
      return { clip: { data: utf8(`${c.modelId}:${c.text}`), mediaType: 'audio/mpeg' }, cost: 0, ms: 1 };
    },
    /** @param {{ modelId: string }} c */
    transcribe: async (c) => {
      transcribed.push(c.modelId);
      if (v?.failing?.includes(c.modelId)) throw new ProviderError('server', `${c.modelId} is down`);
      return { text: hears.length > 1 ? hears.shift() : hears[0], cost: 0, ms: 1 };
    },
    /** @param {any} c */
    gate: async (c) => decide({ prompt: c.prompt, options: c.options, parts: c.parts, fallback: false, call: (role, request) => llm.call({ role, request, speech: c.speech, scope: c.scope, record: { tag: 'gate' } }) }),
  };
  /** @type {any[]} */
  const notices = [];
  const codec = fakeCodec(codecFormats);
  /** @type {Voice | null} */
  let voice = null;
  /** @type {ReturnType<typeof fakePlatform> | null} */
  let platform = null;
  if (v) {
    platform = fakePlatform({ playMs: v.playMs ?? 5, dictation: v.dictation, micFails: v.micFails });
    registry.add('voice-browser', 'voice-platform', platform);
    await updateAppSettings(ws, { voice: { mode: v.mode ?? 'on', keepClips: Boolean(v.keepClips) } });
    voice = new Voice({ llm, ws, registry, store, locale: 'en', where: 'ios' });
    await voice.refresh(); // as the app does when it starts
  }
  const agent = new Agent({ store, ws, llm, registry, codec, voice, timeZone: () => 'UTC', secondMs: 10, ...agentOpts });
  agent.addLoopTools(selfTools(agent));
  agent.on('notice', (n) => notices.push(n));
  /** @type {Record<string, string>} annai's own personalities, as shipped */
  const presets = {};
  for (const n of ['shiori', 'storyteller', 'quiet']) presets[n] = await readFile(new URL(`../../assets/personalities/${n}.md`, import.meta.url), 'utf8');
  if (open) await agent.open(trip);
  /** @param {string[]} [types] */
  const events = (types) => store.tx(['events'], 'readonly', (t) => t.listEvents(trip, types ? { types } : {}));
  return { store, ws, trip, registry, host, agent, llm, requests, events, notices, presets, codec, voice: /** @type {any} */ (voice), platform: /** @type {any} */ (platform), said, transcribed };
}

/** Waits until fn() is true (every 2 ms, at most ms). @param {() => boolean} fn @param {number} [ms] */
export async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`still waiting after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** The microphone hears one of the speech clips, then a pause: one segment. @param {any} k @param {string} name */
export async function hear(k, name) {
  k.platform.mic.feed(cat(quiet(0.3), await clip(name), quiet(1)), 16_000);
}
