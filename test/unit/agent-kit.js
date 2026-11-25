import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
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
import { activate as chatCompletions } from '../../plugins-official/chat-completions/index.js';

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
 * @param {(any[] | Record<string, any>)[]} scripts @param {{ models?: any[], open?: boolean, ready?: Promise<void>, agent?: Record<string, any>, utility?: any[] | Record<string, any>, utilityModel?: Record<string, any>, codecFormats?: string[], uploading?: boolean,
 *   voice?: { mode?: 'on' | 'off' | 'auto', speechIn?: string[], hears?: string[], failing?: string[], decide?: any[], dictation?: boolean, keepClips?: boolean, playMs?: number, micFails?: string,
 *     encoder?: { makes: string[] }, plays?: string[], closeAfterSeconds?: number, speechOut?: string[] },
 *   halves?: boolean, koe?: { type?: any[] | Record<string, any>, talk?: any[] | Record<string, any>, input?: string[], model?: Record<string, any> },
 *   live?: { origin: string, first?: boolean, second?: boolean, key?: string, tunables?: Record<string, any>, type?: 'gemini-live' | 'openai-realtime', made?: false }, fetch?: import('../../src/core/llm/call.js').Fetch,
 *   hold?: (c: any) => Promise<unknown> }} [opts]
 *   hold: a scripted call waits for this before it answers, so a test sets an order without a delay
 *   uploading: whether the main model's provider takes photos by upload; a script (or koe's type) with an ability is a model on that
 *   endpoint type (anthropic-messages, chat-completions), its requests sent through fetch (a stand-in)
 *   utility: a script for one more model, in the utility role (one with an ability as a script's is); utilityModel: what its model record has besides (its input)
 *   voice: Shiori with a voice (spec §10): a fake device; a voice (m-say) and a transcription model (m-hear) that hears hears, in turn (the last
 *   repeats); decide: a script for a quick-decision model (the gate); micFails: the microphone refuses with this error name; closeAfterSeconds: Settings →
 *   Voice's quiet spell, saved before the agent is made (koe-live-kit's liveKit gives its own); speechOut: the speech-out list (m-say; ['browser-voice'] for the phone's voice)
 *   halves: Shiori as Halves (the Koe and Kokoro design), the scripts' models as Kokoro's (main); koe: scripts for two chat models in
 *   Koe · Classic, talk's (m-koet, model-koet) before type's (m-koe, model-koe), and the inputs Koe's models take;
 *   live: a realtime model (m-live, Gemini Live's protocol) at the stand-in realtime server's origin, in Koe · Realtime, the mode chosen;
 *   first false chooses Koe · Classic; key and tunables, for the real service (test/live); type: OpenAI's protocol
 *   (gpt-realtime-2.1, at <origin>/v1) in place of Gemini's
 */
export async function agentKit(scripts, { models = [], open = true, agent: agentOpts = {}, utility, utilityModel = {}, codecFormats, uploading = false, voice: v, halves = false, koe, live, fetch, hold, ready } = {}) {
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
  const watched = {
    ...type,
    run: (/** @type {any} */ c) => {
      requests.push(structuredClone(c.request));
      (sent[c.model.providerId] ??= []).push(structuredClone(c.request));
      return hold ? (async function* () { await hold(c); yield* type.run(c); })() : type.run(c);
    },
  };
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
    if (live.second) { // a second Realtime model after the first, at the same server
      add('pv-live2', 'm-live2', 'Gemini 2', { kind: 'realtime', type: 'gemini-live', baseUrl: live.origin },
        { providerId: 'gemini-3.8-live-b', name: 'Gemini 3.8 Live B', prices: { input: 0.75, audioIn: 3, output: 4.5, audioOut: 12 }, input: ['text', 'image'] });
      config.roles['koe-realtime'].models.push('m-live2');
    }
  }
  if (utility) {
    add('pv-u', 'm-u', 'EU', ability(utility), { providerId: 'model-u', prices: { input: 1, output: 1 }, input: ['text', 'image'], ...utilityModel });
    config.roles.utility.models = ['m-u'];
  }
  if (v) {
    add('pv-say', 'm-say', 'Say', { kind: 'voice', type: 'say' }, { providerId: 'voice' });
    add('pv-hear', 'm-hear', 'Hear', { kind: 'transcription', type: 'hear' }, { providerId: 'ears' });
    config.roles['speech-out'] = { models: v.speechOut ?? ['m-say'], level: 'off' };
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
  chatCompletions({ providers: { register: (/** @type {any} */ x) => { types.set(x.type, { ...x, pluginId: 'chat-completions' }); return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  for (const [id, activate] of /** @type {const} */ ([['gemini-live', geminiLive], ['openai-realtime', openaiRealtime]])) {
    // made false: the protocol as a plugin from before it said when her turn is all made (an older one, or a third party's).
    activate({ providers: { register: (/** @type {any} */ x) => { types.set(id, { ...x, pluginId: id, ...(live?.made === false ? { made: undefined } : {}) }); return () => {}; } }, helpers: { ProviderError, base64: { encode: toBase64, decode: fromBase64 }, g711 }, events: { append: async () => {} } });
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
    ready,
    config: () => readConfig(ws),
    uploading: async () => uploading,
    /** @param {any} c */
    call: async (c) => callRole({
      role: c.role ?? 'main', request: c.request, level: c.level, config: await readConfig(ws), types, keyFor: async () => null, bench,
      signal: c.signal, onEvent: c.onEvent, prefer: c.prefer, record: c.record, repairImages: c.repairImages, sleep: async () => {}, trace: modelTrace(store, c.scope ?? SYS),
      speech: c.speech, firstOutputMs: c.firstOutputMs, read: c.read, readings: c.readings, askResting: c.askResting, keepNative: c.keepNative, shared: c.shared, fetch,
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
    await updateAppSettings(ws, { voice: { mode: v.mode ?? 'on', keepClips: Boolean(v.keepClips), ...(v.closeAfterSeconds === undefined ? {} : { closeAfterSeconds: v.closeAfterSeconds }) } });
    voice = new Voice({ llm, ws, registry, store, locale: 'en', where: 'ios' });
    voice.sleep = async () => {}; // a failed upload is sent again at once here
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

/**
 * A model's script or rules, written again once what it names exists (a trip made after the kit, by its id): the scripted model reads them
 * from its provider's record at each call. @param {any} k @param {any[] | Record<string, any>} script @param {string} [provider] pv-0, the first script's (Kokoro's)
 */
export async function rescript(k, script, provider = 'pv-0') {
  const p = structuredClone((await readConfig(k.ws)).providers[provider]);
  p.user.abilities.chat.tunables = Array.isArray(script) ? { script } : script;
  await saveProvider(k.ws, p);
}

/**
 * The kit's store refuses writes as WebKit refuses them on a full disk (UnknownError): every write, the user's lines, or the log
 * entries a test picks; or every transaction, reads too, as Chromium's does at no byte free (the builder's probe of 2026-11-19: a read fails after a failed
 * write); or reads alone, as any other failed open; and what the agent hands back, and (tried) each log entry a refusal turned away: a test's "was
 * refused" is then a fact, not an absence.
 * @param {any} k @param {{ error?: () => unknown }} [o] error: what each refusal throws, made fresh as a store's is (a TypeError: a bug of ours, not a full phone)
 * @returns {{ full: (which: 'all' | 'everything' | 'reads' | 'lines' | ((ev: any) => boolean) | null) => void, back: { words: string, error: unknown }[], tried: any[] }}
 */
export function refusing(k, { error = () => new DOMException('Unable to store record in object store', 'UnknownError') } = {}) {
  /** @type {'all' | 'everything' | 'reads' | 'lines' | ((ev: any) => boolean) | null} */
  let which = null;
  /** @type {any[]} */
  const tried = [];
  const refuse = () => Promise.reject(error());
  const real = k.store.tx.bind(k.store);
  k.store.tx = (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => real(stores, mode, (/** @type {any} */ t) => {
    if (which === 'everything' || (which === 'reads' && mode !== 'readwrite')) return refuse();
    if (mode !== 'readwrite' || !which || which === 'reads') return fn(t);
    if (which === 'all') return refuse();
    const refused = which === 'lines' ? (/** @type {any} */ ev) => ev.type === 'msg.user' : which;
    return fn({ ...t, appendEvent: (/** @type {string} */ scope, /** @type {any} */ ev) => { // the predicate is called once: a test's may count its calls
      if (!refused(ev)) return t.appendEvent(scope, ev);
      tried.push(ev);
      return refuse();
    } });
  });
  /** @type {{ words: string, error: unknown }[]} */
  const back = [];
  k.agent.on('unsaved', (/** @type {any} */ x) => back.push(x));
  return { full: (w) => { which = w; }, back, tried };
}

/**
 * What each of Shiori's own turns' calls (the ones with keepNative) asked of the model, from now on: its role, whether it said it shares the link
 * with the other half (callOnce's `shared`), and Koe's state when it was made. @param {any} k @returns {[string, boolean | undefined, string][]}
 */
export function watchShared(k) {
  /** @type {[string, boolean | undefined, string][]} */
  const seen = [];
  const call = k.llm.call;
  k.llm.call = (/** @type {any} */ c) => {
    if (c.keepNative) seen.push([c.role, c.shared, k.agent.koeState]);
    return call(c);
  };
  return seen;
}

/** Waits until fn() is true (every 2 ms, at most ms). @param {() => boolean} fn @param {number} [ms] */
export async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`still waiting after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * p, or a failure saying why once ms have passed (on the clock's time, when the test has one): a regression fails at once, not at the test's own
 * timeout (120 s). A race on p itself, not a poll of a flag, so whatever p waits for is still waited for. 2000 ms: 30 times the longest of the 131 such
 * waits in the five files that use it, 65 ms of clock time (measured 2026-11-20). Of the waits agent-loop, trip-tools and typed-kept passed to it
 * (2026-11-22), the longest on real time is under 40 ms, and on a test's clock 1650 ms, a reader's 1.5 s: a clock's time is the timers waited out, the same
 * on any machine. A test whose wait runs longer on its clock passes its own ms, saying why. Of the 75 324 waits in one run of the whole suite (6536
 * tests, 2026-11-24) beside 32 CPU-burning loops (a load average of 80 to 150), those left at 2000 ms on real time took at most 623 ms, and on a test's
 * clock 1650 ms (agent-loop's, a reader's 1.5 s). Real time grows with the load, so a wait on the real clock that waits out a timer of a second or more
 * (her voice's HOLD_MS, a typed line's gathering, the stand-in's turn) passes its own ms: the timer plus 2000. A wait whose time is CPU work on the real
 * clock, a turn of 50 or 60 scripted calls, a simulation's whole run, has no bound that holds on every machine: in that run they took up to 898 and 2398 ms
 * of real time, and at 2000 ms only 0 and 10 of 24 copies of agent-budgets were clean beside 48 busy loops. Such a test runs on a test clock (useClock),
 * where CPU time costs none and a leak still fails at once; except a test with a real socket (push-sim's stand-in server), which keeps the real clock
 * (clock.js) and so has no bound: a leak fails it at the test's timeout.
 * @param {Promise<unknown>} p @param {string} why @param {number} [ms]
 */
export async function inTime(p, why, ms = 2000) {
  /** @type {any} */
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(why)), ms); });
  try {
    await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** idle(), bounded: a wake left queued, or a turn still busy, fails at once, saying so. @param {any} k @param {number} [ms] as inTime's */
export async function idleAtOnce(k, ms = 2000) {
  await inTime(k.agent.idle(), `nothing waits in memory: still waiting after ${ms} ms, a wake left queued, a turn still busy, or a wait longer than that`, ms);
}

/**
 * A simulation's start (SimRun's start()) or its end (its `finished`), bounded as idleAtOnce is, and what it settled with: SimRun waits for the agent's
 * idle() at every moment (#settle), so a leaked busy count, or a turn that never ends, fails here at once, not at the test's 120 s. For a test on a test
 * clock (useClock), where the time of its work is not counted: of the 14 runs in the two simulation files, the longest start or end took 70 ms on it
 * (2026-11-24), so 2000 ms.
 * @template T @param {Promise<T>} p @param {number} [ms] @returns {Promise<T>}
 */
export async function simAtOnce(p, ms = 2000) {
  const settled = p.then((v) => ({ v }));
  await inTime(settled, `the simulation did not go on: still waiting after ${ms} ms, a wake left queued, a turn still busy, or a wait longer than that`, ms);
  return (await settled).v;
}

/**
 * Holds the store transactions `which` names at the door until it is opened, outside the store's queue (a phone slow to read or write), so a wait that
 * doesn't count what is held finishes first. @param {any} k @param {(stores: string[], mode: string) => boolean} which @returns {{ open: () => void }}
 */
export function holdAtDoor(k, which) {
  const real = k.store.tx.bind(k.store);
  /** @type {() => void} */
  let open = () => {};
  const door = new Promise((r) => { open = () => r(undefined); });
  k.store.tx = (/** @type {string[]} */ stores, /** @type {string} */ mode, /** @type {any} */ fn) => (which(stores, mode) ? door.then(() => real(stores, mode, fn)) : real(stores, mode, fn));
  return { open };
}

/**
 * The first read of each reminder annai shows (its card's) waits at the door, so the card and the entry come after whatever else is done, as on a
 * phone slow to read; nothing else is held. @param {any} k @param {any} [half] the half whose reminders (Kokoro's, or one Shiori's; Koe's for Start fresh's)
 * @returns {{ open: () => void, reached: () => boolean }} reached: a reminder has come to be shown, and is held
 */
export function holdReminders(k, half = k.agent.kokoro ?? k.agent) {
  let holding = false;
  let reached = false;
  const door = holdAtDoor(k, (stores) => holding && stores.length === 1 && stores[0] === 'secrets');
  const remind = half.remind.bind(half);
  half.remind = (/** @type {any[]} */ ...a) => {
    holding = reached = true; // its card's read is its first call to the store, made before remind() returns
    try {
      return remind(...a);
    } finally {
      holding = false;
    }
  };
  return { ...door, reached: () => reached };
}

/**
 * The first write after a reminder's card is raised, which is its entry's (everything else of the work is done by then, or counted on its own), waits
 * at the door, as on a phone slow to write: the card is out and the entry is not. A wait that doesn't count the entry finishes first. Made before the
 * reminder comes. @param {any} k @returns {{ open: () => void, cardShown: () => boolean }}
 */
export function holdEntries(k) {
  let card = false;
  let taken = false;
  k.agent.on('notice', (/** @type {any} */ n) => { if (n.title === 'Reminder') card = true; });
  return { ...holdAtDoor(k, (_stores, mode) => mode === 'readwrite' && card && !taken && (taken = true)), cardShown: () => card };
}

/**
 * Starts the work with `start` (a wake whose reminder annai shows) so that everything but the reminder's entry is done first, then holds the entry at
 * the door: the card's read waits while both halves finish what they do for the wake, then the card comes and the entry's write waits (holdEntries), so
 * nothing else of the work can be the one held. Settles once the card is out; open the door it returns to let the entry through. For Halves.
 * @param {any} k @param {() => unknown} start @returns {Promise<{ open: () => void }>}
 */
export async function slowEntry(k, start) {
  const cardDoor = holdReminders(k);
  await start();
  await until(() => cardDoor.reached());
  await idleAtOnce({ agent: k.agent.kokoro });
  await idleAtOnce({ agent: k.agent.koe });
  const entryDoor = holdEntries(k);
  cardDoor.open();
  await until(() => entryDoor.cardShown());
  return entryDoor;
}

/**
 * A promise for the end of the next turn, her own (turn.end), asked for before the work that ends it. @param {any} k @returns {Promise<void>}
 */
export function turnEnds(k) {
  return new Promise((resolve) => {
    const off = k.agent.on('event', (/** @type {any} */ e) => {
      if (e.type !== 'turn.end') return;
      off?.();
      resolve(undefined);
    });
  });
}

/**
 * idle() does not settle while the door is shut, and does once it is open. `done` is what the door doesn't hold, finished first (her turn's end,
 * the reminder's card): the clock's 60 ms (real time where a test has no clock) then only has to outlast what idle() itself still does, never the rest of the work.
 * @param {any} k @param {{ open: () => void }} door @param {string} why @param {() => Promise<unknown> | unknown} [done]
 */
export async function settlesOnlyAfter(k, door, why, done = () => {}) {
  await done();
  let settled = false;
  const idle = k.agent.idle().then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(settled, false, why);
  door.open();
  await inTime(idle, `${why}: once the door is open, idle() settles (still waiting after 2000 ms: a wake left queued, a turn still busy, or a wait longer than that)`);
}

/**
 * Each half's own cards, as they are raised: what a "shown once" counts, since Halves' own list (k.notices) drops a card identical to the one before it
 * within 5 s (its #notice), which hides a double show. Made before anything runs. @param {any} k @returns {any[]}
 */
export function raw(k) {
  /** @type {any[]} */
  const got = [];
  for (const half of k.agent.kokoro ? [k.agent.kokoro, k.agent.koe] : [k.agent]) half.on('notice', (/** @type {any} */ n) => got.push(n));
  return got;
}

/** The microphone hears one of the speech clips, then a pause: one segment. @param {any} k @param {string} name */
export async function hear(k, name) {
  k.platform.mic.feed(cat(quiet(0.3), await clip(name), quiet(1)), 16_000);
}
