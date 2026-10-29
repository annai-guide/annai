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
import { Halves } from '../../src/core/agent/halves.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { syncNames } from '../../src/core/names.js';
import { readFile } from 'node:fs/promises';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';
import { utf8 } from '../../src/core/bytes.js';
import { Voice } from '../../src/core/voice/voice.js';
import { decide } from '../../src/core/llm/decide.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { fakePlatform } from './voice-fakes.js';
import { clip, quiet, cat } from './voice-kit.js';
import { openLive } from '../../src/core/realtime/open.js';
import { endpointOf, providerOf, modelOf } from '../../src/core/llm/config.js';
import { COOLDOWN_MS } from '../../src/core/llm/fallback.js';
import { toBase64, fromBase64 } from '../../src/core/bytes.js';
import { activate as geminiLive } from '../../plugins-official/gemini-live/index.js';
import { activate as openaiRealtime } from '../../plugins-official/openai-realtime/index.js';
import { g711 } from '../../src/core/voice/g711.js';
import { activate as anthropicMessages } from '../../plugins-official/anthropic-messages/index.js';

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
 * @param {(any[] | Record<string, any>)[]} scripts @param {{ models?: any[], open?: boolean, agent?: Record<string, any>, utility?: any[], utilityModel?: Record<string, any>, codecFormats?: string[], uploading?: boolean,
 *   voice?: { mode?: 'on' | 'off' | 'auto', speechIn?: string[], hears?: string[], failing?: string[], decide?: any[], dictation?: boolean, keepClips?: boolean, playMs?: number, micFails?: string,
 *     encoder?: { makes: string[] }, plays?: string[] },
 *   halves?: boolean, koe?: { type?: any[] | Record<string, any>, talk?: any[] | Record<string, any>, input?: string[], model?: Record<string, any> },
 *   live?: { origin: string, first?: boolean, key?: string, tunables?: Record<string, any>, type?: 'gemini-live' | 'openai-realtime' }, fetch?: import('../../src/core/llm/call.js').Fetch }} [opts]
 *   uploading: whether the main model's provider takes photos by upload; a script (or koe's type) with an ability is a model on that
 *   endpoint type (anthropic-messages), its requests sent through fetch (a stand-in)
 *   utility: a script for one more scripted model, in the utility role; utilityModel: what its model record has besides (its input)
 *   voice: Shiori with a voice (spec §10): a fake device; a voice (m-say) and a transcription model (m-hear) that hears hears, in turn (the last
 *   repeats); decide: a script for a quick-decision model (the gate); micFails: the microphone refuses with this error name
 *   halves: Shiori as Halves (the Koe and Kokoro design), the scripts' models as Kokoro's (main); koe: scripts for two chat models in
 *   Koe · Classic, talk's (m-koet, model-koet) before type's (m-koe, model-koe), and the inputs Koe's models take;
 *   live: a realtime model (m-live, Gemini Live's protocol) at the stand-in realtime server's origin, in Koe · Realtime, the mode chosen;
 *   first false chooses Koe · Classic; key and tunables, for the real service (test/live); type: OpenAI's protocol
 *   (gpt-realtime-2.1, at <origin>/v1) in place of Gemini's
 */
export async function agentKit(scripts, { models = [], open = true, agent: agentOpts = {}, utility, utilityModel = {}, codecFormats, uploading = false, voice: v, halves = false, koe, live, fetch } = {}) {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  syncNames(ws); // as the app does
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await host.addBuiltin(new URL('../../src/plugins/files/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  /** @type {any} */
  let type = null;
  scripted({ providers: { register: (/** @type {any} */ x) => { type = { ...x, pluginId: 'scripted-model' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  /** @type {any[]} */
  const requests = [];
  /** @type {Record<string, any[]>} the requests each provider model got */
  const sent = {};
  const watched = { ...type, run: (/** @type {any} */ c) => { requests.push(structuredClone(c.request)); (sent[c.model.providerId] ??= []).push(structuredClone(c.request)); return type.run(c); } };
  /** @type {any} */
  const config = { providers: {}, models: {}, roles: { main: { models: [], level: 'medium' }, utility: { models: [], level: 'low' }, decide: { models: [], level: 'off' } } };
  /** A provider with one ability, and one model on it. @param {string} p @param {string} m @param {string} name @param {any} ability @param {any} user */
  const add = (p, m, name, ability, user) => {
    config.providers[p] = { id: p, plugin: 'provider-test', template: null, user: { name, abilities: { [ability.kind]: ability } }, created: 0 };
    config.models[m] = { id: m, provider: p, ability: ability.kind, template: null, user, created: 0 };
  };
  /** A script's ability: the scripted model's, or the one it names (a real endpoint type, reached through fetch). @param {any} script */
  const ability = (script) => (script.ability ? { kind: 'chat', ...script.ability } : { kind: 'chat', type: 'scripted', tunables: Array.isArray(script) ? { script } : script });
  scripts.forEach((script, i) => {
    add(`pv-${i}`, `m-${i}`, `E${i}`, ability(script),
      { providerId: `model-${i}`, prices: { input: 1, output: 1 }, input: ['text', 'image'], ...(models[i] ?? {}) });
    config.roles.main.models.push(`m-${i}`);
  });
  config.roles['koe-classic'] = { models: [], level: 'off' };
  config.roles['koe-realtime'] = { models: [], level: 'off' };
  if (koe?.talk) {
    add('pv-koet', 'm-koet', 'KoeT', { kind: 'chat', type: 'scripted', tunables: Array.isArray(koe.talk) ? { script: koe.talk } : koe.talk }, { providerId: 'model-koet', prices: { input: 1, output: 1 }, input: koe.input ?? ['text', 'image'] });
    config.roles['koe-classic'].models.push('m-koet');
  }
  if (koe?.type) {
    add('pv-koe', 'm-koe', 'Koe', ability(koe.type), { providerId: 'model-koe', prices: { input: 1, output: 1 }, input: koe.input ?? ['text', 'image'], ...(koe.model ?? {}) });
    config.roles['koe-classic'].models.push('m-koe');
  }
  if (live) {
    const openai = live.type === 'openai-realtime';
    add('pv-live', 'm-live', openai ? 'OpenAI' : 'Gemini', { kind: 'realtime', type: openai ? 'openai-realtime' : 'gemini-live', baseUrl: openai ? `${live.origin}/v1` : live.origin },
      { providerId: openai ? 'gpt-realtime-2.1' : 'gemini-3.8-live', name: openai ? 'GPT Realtime 2.1' : 'Gemini 3.8 Live', prices: { input: 0.75, audioIn: 3, output: 4.5, audioOut: 12 }, input: ['text', 'image'] });
    config.roles['koe-realtime'].models = ['m-live'];
  }
  if (utility) {
    add('pv-u', 'm-u', 'EU', { kind: 'chat', type: 'scripted', tunables: { script: utility } }, { providerId: 'model-u', prices: { input: 1, output: 1 }, input: ['text', 'image'], ...utilityModel });
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
  // A live model first in Koe's list was Koe · Realtime chosen; after the chat models, Koe · Classic (the user, 2026-10-22: two lists).
  await saveRoles(ws, config.roles, live ? { koeMode: live.first === false ? 'classic' : 'realtime' } : {});
  /** The endpoint types: the scripted model, and fake speech types whose calls the llm below answers. */
  const types = new Map([['scripted', watched], ['say', { type: 'say', name: 'Say', speech: 'out', pluginId: 'test' }], ['hear', { type: 'hear', name: 'Hear', speech: 'in', pluginId: 'test' }]]);
  anthropicMessages({ providers: { register: (/** @type {any} */ x) => { types.set(x.type, { ...x, pluginId: 'anthropic-messages' }); return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  for (const [id, activate] of /** @type {const} */ ([['gemini-live', geminiLive], ['openai-realtime', openaiRealtime]])) {
    activate({ providers: { register: (/** @type {any} */ x) => { types.set(id, { ...x, pluginId: id }); return () => {}; } }, helpers: { ProviderError, base64: { encode: toBase64, decode: fromBase64 }, g711 }, events: { append: async () => {} } });
  }
  /** Every live session opened, in order, and every socket. @type {any[]} */
  const sessions = [];
  /** @type {WebSocket[]} */
  const sockets = [];
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
      speech: c.speech, firstOutputMs: c.firstOutputMs, read: c.read, readings: c.readings, askResting: c.askResting, fetch,
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
    /** A live session at the stand-in, as the service opens one: a refused key, a limit or a server failure rests the model. @param {string} modelId @param {any} setup @param {{ scope?: string, wake?: string, output?: any }} [o] */
    live: async (modelId, setup, o = {}) => {
      const cfg = await readConfig(ws);
      const rec = cfg.models[modelId];
      const pRec = cfg.providers[rec.provider];
      const type = /** @type {any} */ (types.get(providerOf(pRec).abilities[rec.ability].type));
      const endpoint = endpointOf(pRec, rec.ability, type.tunables);
      const s = openLive({
        type, endpoint, model: modelOf(rec), key: live?.key ?? 'k-live', tunables: { ...type.tunables, proactive: false, ...live?.tunables },
        setup: { audioIn: type.audio.in[0], audioOut: type.audio.out[0], ...setup }, trace: modelTrace(store, o.scope ?? SYS), wake: o.wake, output: o.output,
        socket: (/** @type {string} */ url, /** @type {string[]} */ protocols) => { const w = new WebSocket(url, protocols); sockets.push(w); return w; },
      });
      s.closed.then(({ kind }) => { if (kind === 'auth' || kind === 'rate' || kind === 'server' || (kind === 'not-found' && !setup.resume)) bench.bench(modelId, COOLDOWN_MS); });
      sessions.push(s);
      return s;
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
    platform = fakePlatform({ playMs: v.playMs ?? 5, dictation: v.dictation, micFails: v.micFails, encoder: v.encoder, plays: v.plays });
    registry.add('voice-browser', 'voice-platform', platform);
    await updateAppSettings(ws, { voice: { mode: v.mode ?? 'on', keepClips: Boolean(v.keepClips) } });
    voice = new Voice({ llm, ws, registry, store, locale: 'en', where: 'ios' });
    voice.retryMs = [0, 0]; // a failed upload is sent again at once here
    await voice.refresh(); // as the app does when it starts
  }
  /** @type {any} */
  const agent = halves || koe || live
    ? new Halves({ store, ws, llm, registry, codec, voice, timeZone: () => 'UTC', secondMs: 10, ...agentOpts })
    : new Agent({ store, ws, llm, registry, codec, voice, timeZone: () => 'UTC', secondMs: 10, ...agentOpts });
  agent.addLoopTools(selfTools(agent.kokoro ?? agent));
  agent.on('notice', (n) => notices.push(n));
  /** @type {Record<string, string>} annai's own personalities, as shipped */
  const presets = {};
  for (const n of ['shiori', 'storyteller', 'quiet']) presets[n] = await readFile(new URL(`../../assets/personalities/${n}.md`, import.meta.url), 'utf8');
  if (open) await agent.open(trip);
  /** @param {string[]} [types] */
  const events = (types) => store.tx(['events'], 'readonly', (t) => t.listEvents(trip, types ? { types } : {}));
  return { store, ws, trip, registry, host, agent, llm, requests, sent, events, notices, presets, codec, voice: /** @type {any} */ (voice), platform: /** @type {any} */ (platform), said, transcribed, sessions, sockets };
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
