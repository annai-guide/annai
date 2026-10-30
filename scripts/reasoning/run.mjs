// The reasoning check's run (docs/testing/reasoning-check.md): annai's own Halves in Node, in memory, against Claude on Anthropic's API
// and through OpenRouter, a synthetic trip, then what each request sent and got back, checked. Nothing of a request's body is kept, and
// every text written or printed passes the keys' scrub first.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { callRole, Bench } from '../../src/core/llm/fallback.js';
import { readConfig, saveProvider, saveRoles } from '../../src/core/llm/config.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { mergePatch } from '../../src/core/patch.js';
import { Halves } from '../../src/core/agent/halves.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { activate as anthropicMessages } from '../../plugins-official/anthropic-messages/index.js';
import { activate as chatCompletions } from '../../plugins-official/chat-completions/index.js';

/**
 * Where each provider is, its description, and the models Kokoro (Sonnet 5.5) and Koe · Classic (Haiku 5.5) run on; fallback is a second
 * Claude on the same endpoint, added to Kokoro's list for this run only, for the step the check makes Sonnet fail.
 */
export const PROVIDERS = Object.freeze({
  anthropic: { plugin: 'provider-anthropic', kokoro: 'claude-sonnet-5-5', koe: 'claude-haiku-5-5', fallback: 'claude-opus-5-5', host: 'api.anthropic.com' },
  openrouter: { plugin: 'provider-openrouter', kokoro: 'anthropic/claude-sonnet-5.5', koe: 'anthropic/claude-haiku-5.5', fallback: 'anthropic/claude-opus-5.5', host: 'openrouter.ai' },
});
/** The synthetic trip: nothing in it is anyone's. */
const TRIP = { title: 'Coast test trip', start: '2026-11-02', end: '2026-11-05' };
const NOTES = { '/notes/hotel.md': 'Hotel: the Seaview Inn, 12 Harbor Road, Example Bay. Check-in from 15:00.', '/notes/dinner.md': 'Dinner on the 3rd: the Lantern, 19:30, table for two.' };
/** What the user says, in turn. */
export const SAYS = Object.freeze([
  'Please look through my trip notes, read the hotel one, and tell me where we stay and when we can check in.',
  'Thanks! And where is dinner on the 3rd?',
]);
/** The negative control's turn, then the Claude-to-Claude turn: each needs a turn of three steps or more. */
export const CONTROL_SAY = 'Thanks again! Could you read the hotel note once more and tell me the street it is on?';
export const CROSS_SAY = 'Thanks! One last look at the hotel note, please: what time is check-in?';
/**
 * The check's own caps, so a model that loops cannot run up a bill: steps in one wake, and dollars in one day (the run's expected cost
 * is a few tenths of a dollar).
 */
export const CAPS = Object.freeze({ stepsPerWake: 8, spendPerDay: 1 });
/** The beta that lets a request say what Anthropic does with a thinking block that no longer fits what came before it. */
export const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/**
 * One request, as the check records it: never its body, only its size and what it sent back. phase: which part of the run it belongs
 * to (the conversation, the negative control, the Claude-to-Claude turn). bound: the check asked for an error on a mismatch (Anthropic).
 * upstream: the provider OpenRouter named. transformations: what Anthropic's input_transformations listed, null when the reply had none.
 * altered: the control changed an earlier message in it. stubbed: it was answered with a stubbed 529. A row's signed: the reply's stream
 * said "signature" (reported only); kept: annai kept a native for the reply, which is what the next step must send back.
 * @typedef {'main' | 'control' | 'cross'} Phase
 * @typedef {{ provider: string, model: string, bytes: number, thinking: number, thinkingBytes: number, status: number, signed: boolean,
 *   phase: Phase, bound: boolean, upstream: string | null, transformations: string[] | null, altered: boolean, stubbed: boolean }} Sent
 * @typedef {{ provider: string, half: string, wake: string, step: number, model: string, answeredBy: string | null, first: string | null,
 *   outcomes: string[], bytes: number, thinkingBytes: number, natives: { sent: number, changed: boolean } | null, cacheRead: number,
 *   cacheWrite: number, cost: number | null, signed: boolean, kept?: boolean, statuses: number[], phase?: Phase, upstream?: string | null,
 *   transformations?: string[] | null, bound?: boolean, altered?: boolean, stubbed?: boolean, benched?: boolean }} Row
 */

/** A request body's thinking sent back: Anthropic's thinking blocks, or OpenRouter's reasoning_details. @param {any} body */
function thinkingOf(body) {
  const blocks = (body.messages ?? []).flatMap((/** @type {any} */ m) => [
    ...(Array.isArray(m.content) ? m.content.filter((/** @type {any} */ b) => b?.type === 'thinking' || b?.type === 'redacted_thinking') : []),
    ...(Array.isArray(m.reasoning_details) ? [m.reasoning_details] : []),
  ]);
  return { count: blocks.length, bytes: blocks.reduce((n, b) => n + JSON.stringify(b).length, 0) };
}

/**
 * The check's own change to a request to Anthropic, never production's: the binding controls beta, and where the thinking is adaptive (or
 * unset, which a Claude 5.5 model reads as adaptive), an error on a thinking block that no longer fits what came before it, so a request
 * that breaks the binding fails on any account, old or new. A thinking of another kind (between_tools takes no other field) is left alone.
 * @param {Record<string, string>} headers @param {any} body @returns {{ headers: Record<string, string>, bound: boolean }}
 */
export function bindingControls(headers, body) {
  const out = { ...headers };
  const name = Object.keys(out).find((k) => k.toLowerCase() === 'anthropic-beta') ?? 'anthropic-beta';
  out[name] = [...new Set([...String(out[name] ?? '').split(',').map((x) => x.trim()).filter(Boolean), BINDING_BETA])].join(',');
  const was = body.thinking;
  const bound = was === undefined || was?.type === 'adaptive';
  if (bound) body.thinking = { type: 'adaptive', ...(was ?? {}), block_binding: { prefix_mismatch_behavior: 'error' } };
  return { headers: out, bound };
}

/** An earlier message changed by a few words, for the negative control: the first the user wrote, so everything after it is bound to what was. @param {any} body */
function alter(body) {
  const m = (body.messages ?? []).find((/** @type {any} */ x) => x?.role === 'user');
  if (!m) return false;
  if (typeof m.content === 'string') {
    m.content += ' (edited)';
    return true;
  }
  const b = (Array.isArray(m.content) ? m.content : []).find((/** @type {any} */ x) => x?.type === 'text' && typeof x.text === 'string');
  if (!b) return false;
  b.text += ' (edited)';
  return true;
}

/** A short word from the provider, as the summary may hold it: letters, digits and a few marks. @param {unknown} x */
const plain = (x) => String(x ?? '').replace(/[^A-Za-z0-9 _.:/-]/g, '').slice(0, 60);

/** The first value under a key in a parsed event, looking a few levels in. @param {any} x @param {string} key @param {number} depth @returns {unknown} */
function find(x, key, depth) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined;
  if (key in x) return x[key];
  if (depth <= 0) return undefined;
  for (const v of Object.values(x)) {
    const got = find(v, key, depth - 1);
    if (got !== undefined) return got;
  }
  return undefined;
}

/**
 * What a streamed reply says about itself, apart from its content: the provider OpenRouter routed it to (a chunk's top-level provider), and
 * Anthropic's input_transformations (null when the stream never has the key). Each entry is kept as its type and reason, in plain words.
 * @param {string} text @returns {{ upstream: string | null, transformations: string[] | null }}
 */
export function scan(text) {
  /** @type {string | null} */
  let upstream = null;
  /** @type {string[] | null} */
  let transformations = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    /** @type {any} */
    let j;
    try {
      j = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    if (upstream === null && typeof j?.provider === 'string' && j.provider) upstream = plain(j.provider);
    const t = find(j, 'input_transformations', 3);
    if (t !== undefined) transformations = [...(transformations ?? []), ...(Array.isArray(t) ? t : []).map((/** @type {any} */ e) => (e && typeof e === 'object' ? `${plain(e.type ?? e.kind ?? 'entry')}:${plain(e.reason ?? '')}` : plain(e)))];
  }
  return { upstream, transformations };
}

/** A stubbed "overloaded" answer, in the provider's own shape: what a busy API says. @param {string} provider */
function overloaded(provider) {
  const body = provider === 'anthropic' ? { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } : { error: { code: 529, message: 'Overloaded' } };
  return new Response(JSON.stringify(body), { status: 529, headers: { 'content-type': 'application/json' } });
}

/** The promise, or an error once it has taken too long; the timer is cleared either way, so a finished run does not wait for it. @template T @param {Promise<T>} p @param {number} ms @param {string} what @returns {Promise<T>} */
async function within(p, ms, what) {
  /** @type {any} */
  let timer;
  try {
    return await Promise.race([p, new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no ${what} within ${ms / 1000} s`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * annai in Node: a memory store, the file tools, the two endpoint types, the providers as their descriptions give them, Halves with
 * Kokoro on main (at level high in this run, as adaptive thinking may skip thinking on easy steps at medium; and a second Claude after it) and Koe · Classic; voice off; the check's caps on.
 * @param {{ provider: keyof typeof PROVIDERS, key: () => string, fetch: (url: string, init: RequestInit) => Promise<Response>, sleep?: (ms: number) => Promise<void> }} c
 */
async function annai({ provider, key, fetch, sleep }) {
  const which = PROVIDERS[provider];
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await host.addBuiltin(new URL('../../src/plugins/files/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: TRIP.title });
  await ws.write(trip, '/trip.json', TRIP, { author: 'user' }).catch(() => {});
  for (const [path, text] of Object.entries(NOTES)) await ws.write(trip, path, text, { author: 'user' });
  await updateAppSettings(ws, { shiori: { budgets: { ...CAPS } } });
  /** @type {Map<string, any>} */
  const types = new Map();
  const helpers = { sse, parsePartialJSON, ProviderError, errorFromResponse, retry };
  for (const [id, activate] of /** @type {const} */ ([['anthropic-messages', anthropicMessages], ['chat-completions', chatCompletions]])) {
    activate({ providers: { register: (/** @type {any} */ x) => { types.set(x.type, { ...x, pluginId: id }); return () => {}; } }, helpers });
  }
  const desc = JSON.parse(await readFile(new URL(`../../plugins-official/${which.plugin}/annai-plugin.json`, import.meta.url), 'utf8'));
  const chat = desc.provider.abilities.chat;
  const rec = { id: 'pv-check', plugin: which.plugin, template: { version: desc.version, values: desc.provider }, user: {}, created: 0 };
  const models = [['m-kokoro', which.kokoro], ['m-koe', which.koe], ['m-fallback', which.fallback]].map(([id, providerId]) => {
    const m = chat.models.find((/** @type {any} */ x) => x.providerId === providerId);
    if (!m) throw new Error(`${which.plugin}'s description has no ${providerId}.`);
    return { id, provider: rec.id, ability: 'chat', template: { id: `${which.plugin}/chat/${providerId}`, version: desc.version, values: mergePatch(chat.modelDefaults ?? {}, m) }, user: {}, created: 0 };
  });
  await saveProvider(ws, /** @type {any} */ (rec), /** @type {any} */ (models));
  await saveRoles(ws, { main: { models: ['m-kokoro', 'm-fallback'], level: 'high' }, 'koe-classic': { models: ['m-koe'], level: 'low' }, 'koe-realtime': { models: [], level: 'off' }, utility: { models: ['m-kokoro'], level: 'low' }, decide: { models: [], level: 'off' } }, { koeMode: 'classic' });
  const bench = new Bench();
  /** @type {Map<string, boolean[]>} */
  const kept = new Map();
  const none = async () => { throw new Error('Not in the reasoning check.'); };
  const llm = {
    bench,
    config: () => readConfig(ws),
    uploading: async () => false,
    /** @param {any} c */
    call: async (c) => {
      // Whether annai kept a native for each reply of a turn, in the order the model.turn events come (every call records exactly one).
      const note = (/** @type {boolean} */ native) => { if (c.record?.tag) kept.set(`${c.record.tag}|${c.record.wake}`, [...(kept.get(`${c.record.tag}|${c.record.wake}`) ?? []), native]); };
      try {
        const r = await callRole({
          role: c.role ?? 'main', request: c.request, level: c.level, config: await readConfig(ws), types, bench, signal: c.signal, onEvent: c.onEvent, prefer: c.prefer,
          record: c.record, repairImages: c.repairImages, trace: (() => { const t = modelTrace(store, c.scope ?? trip); t.secret(key()); return t; })(), speech: c.speech,
          firstOutputMs: c.firstOutputMs ?? 90_000, read: c.read, readings: c.readings, askResting: c.askResting, keepNative: c.keepNative, fetch, ...(sleep ? { sleep } : {}),
          // The key goes only to the endpoint type, which puts it in its request's header.
          keyFor: async () => key(),
        });
        note(Boolean(r.reply.native));
        return r;
      } catch (e) {
        note(false);
        throw e;
      }
    },
    types: () => types,
    synthesize: none, transcribe: none, live: none,
    decide: none,
  };
  const agent = new Halves({ store, ws, llm, registry, timeZone: () => 'UTC', secondMs: 1000 });
  agent.addLoopTools(selfTools(agent.kokoro));
  await agent.open(trip);
  return { store, trip, agent, bench, kept };
}

/**
 * The run against one provider: two messages, each answered in full; the negative control; and the turn in which Sonnet is made to fail
 * so a second Claude answers a step; what went to the provider and back, as rows.
 * @param {{ provider: keyof typeof PROVIDERS, key: () => string, fetch: (url: string, init: RequestInit) => Promise<Response>, log: (s: string) => void, timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void> }} c
 * @returns {Promise<Row[]>}
 */
export async function runProvider({ provider, key, fetch: send, log, timeoutMs = 240_000, sleep }) {
  const which = PROVIDERS[provider];
  /** @type {Sent[]} */
  const sent = [];
  /** @type {Promise<unknown>[]} */
  const reading = [];
  /** @type {Phase} */
  let phase = 'main';
  let altered = false;
  /** The Claude-to-Claude turn: Sonnet is stubbed with 529 from its first request that carries thinking until the next Claude answers. @type {'idle' | 'stubbing' | 'done'} */
  let cross = 'idle';
  const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const t = thinkingOf(body);
    const model = String(body.model ?? '');
    /** @type {Sent} */
    const rec = { provider, model, bytes: 0, thinking: t.count, thinkingBytes: t.bytes, status: 0, signed: false, phase, bound: false, upstream: null, transformations: null, altered: false, stubbed: false };
    sent.push(rec);
    if (phase === 'control' && !altered && t.count > 0) {
      // The negative control: an earlier message changed, thinking sent with it, which the check in callOnce cannot see.
      rec.altered = altered = alter(body);
    }
    let headers = /** @type {Record<string, string>} */ (init.headers ?? {});
    if (provider === 'anthropic') {
      const c = bindingControls(headers, body);
      headers = c.headers;
      rec.bound = c.bound;
    }
    const next = { ...init, headers, body: JSON.stringify(body) };
    rec.bytes = Buffer.byteLength(next.body);
    if (phase === 'cross' && model === which.kokoro && cross !== 'done') {
      if (cross === 'idle' && t.count > 0) cross = 'stubbing';
      if (cross === 'stubbing') {
        rec.status = 529;
        rec.stubbed = true;
        return overloaded(provider);
      }
    }
    if (phase === 'cross' && cross === 'stubbing' && model === which.fallback) cross = 'done';
    const res = await send(url, /** @type {RequestInit} */ (next));
    rec.status = res.status;
    // Whether the reply carried signed thinking, which the next step should send back, and what it says of itself: read from a copy, never kept.
    if (res.ok) reading.push(res.clone().text().then((x) => { rec.signed = /"signature(_delta)?"|signature/.test(x); Object.assign(rec, scan(x)); }, () => {}));
    return res;
  };
  const { store, trip, agent, bench, kept } = await annai({ provider, key, fetch, sleep });
  /** @param {string} say @param {Phase} part */
  const turn = async (say, part) => {
    phase = part;
    log(`  [${provider}] the user: ${say}`);
    agent.send(say);
    await within(agent.idle(), timeoutMs, 'answer');
  };
  for (const say of SAYS) await turn(say, 'main');
  await turn(CONTROL_SAY, 'control');
  // Whether anything rested after the control: a refused thinking asks the same model again and rests none.
  const benched = ['m-kokoro', 'm-koe', 'm-fallback'].some((id) => bench.until(id) > Date.now());
  await turn(CROSS_SAY, 'cross');
  await Promise.all(reading);
  const events = await store.tx(['events'], 'readonly', (t) => t.listEvents(trip));
  const capped = events.find((e) => e.type === 'error' && e.data?.kind === 'budget');
  if (capped) throw new Error(`The check's own cap stopped a turn (${capped.data.message}); nothing it found can be trusted.`);
  // Each half calls its own models, one call at a time: a request is its model's next, and a call's requests come before its model.turn.
  const ids = /** @type {Record<string, string>} */ ({ 'm-kokoro': which.kokoro, 'm-koe': which.koe, 'm-fallback': which.fallback });
  /** @type {Map<string, Sent[]>} */
  const queued = new Map();
  for (const x of sent) queued.set(x.model, [...(queued.get(x.model) ?? []), x]);
  /** @type {Map<string, { e: any, s?: Sent, n: number }[]>} */
  const pending = new Map();
  let n = 0;
  /** @type {Row[]} */
  const rows = [];
  /** @type {Map<string, number>} */
  const steps = new Map();
  for (const e of events) {
    if (e.type === 'net.request' && e.data.kind === 'model') {
      const m = String(e.data.providerModel ?? '');
      pending.set(m, [...(pending.get(m) ?? []), { e, s: queued.get(m)?.shift(), n: n++ }]);
      continue;
    }
    if (e.type !== 'model.turn') continue;
    // A call that fell back to a second model has requests under both: all of them are this call's.
    const used = [...new Set((e.data.attempts ?? []).map((/** @type {any} */ a) => ids[String(a.model)]).filter(Boolean))];
    const calls = used.flatMap((m) => pending.get(m) ?? []).sort((a, b) => a.n - b.n);
    for (const m of used) pending.set(m, []);
    if (!['conversation', 'koe'].includes(e.data.tag)) continue;
    const model = ids[String(e.data.attempts?.at(-1)?.model ?? '')] ?? '';
    const half = e.data.tag === 'koe' ? 'Koe' : 'Kokoro';
    const k = `${half}|${e.data.wake}`;
    const step = (steps.get(k) ?? 0) + 1;
    steps.set(k, step);
    const lastCall = calls.at(-1);
    const u = lastCall?.e.data.usage ?? {};
    const said = calls.flatMap((c) => c.s?.transformations ?? []);
    rows.push({
      provider, half, wake: String(e.data.wake ?? ''), step, model, answeredBy: e.data.answeredBy ?? null, first: e.data.first ?? null,
      outcomes: (e.data.attempts ?? []).map((/** @type {any} */ a) => String(a.outcome)), bytes: calls.reduce((x, c) => x + (c.s?.bytes ?? 0), 0),
      thinkingBytes: lastCall?.s?.thinkingBytes ?? 0, natives: lastCall?.e.data.natives ?? null, cacheRead: Number(u.cacheRead) || 0,
      cacheWrite: (Number(u.cacheWrite) || 0) + (Number(u.cacheWrite1h) || 0), cost: typeof e.data.cost === 'number' ? e.data.cost : null,
      signed: Boolean(lastCall?.s?.signed), kept: kept.get(`${e.data.tag}|${e.data.wake}`)?.[step - 1] ?? false, statuses: calls.map((c) => c.s?.status ?? 0), phase: lastCall?.s?.phase ?? 'main',
      upstream: lastCall?.s?.upstream ?? null, transformations: calls.some((c) => c.s?.transformations) ? said : null,
      bound: calls.some((c) => c.s?.bound), altered: calls.some((c) => c.s?.altered), stubbed: calls.some((c) => c.s?.stubbed),
      ...(calls.some((c) => c.s?.altered) ? { benched } : {}),
    });
  }
  return rows;
}

/** The turn each row belongs to, in the order they began. @param {Row[]} rows @returns {Row[][]} */
function turnsOf(rows) {
  /** @type {Map<string, Row[]>} */
  const turns = new Map();
  for (const r of rows) turns.set(`${r.half}|${r.wake}`, [...(turns.get(`${r.half}|${r.wake}`) ?? []), r]);
  return [...turns.values()];
}

const whereOf = (/** @type {Row} */ r) => `${r.provider} ${r.half} turn ${r.wake.slice(-4)} step ${r.step}`;
/** The conversation's rows, or the part of the run a row belongs to. @param {Row[]} rows @param {Phase} phase */
const inPhase = (rows, phase) => rows.filter((r) => (r.phase ?? 'main') === phase);

/**
 * The checks (the design §12 and the review of 2026-10-30), on one provider's rows: each a name and the problems found.
 * @param {Row[]} all @returns {{ name: string, problems: string[] }[]}
 */
export function checks(all) {
  const rows = inPhase(all, 'main');
  const provider = all[0]?.provider ?? '';
  const turns = turnsOf(rows);
  const back = [];
  const cache = [];
  /** Where nothing past the system prompt was cached: a step reads no more than the one before it. */
  const grow = [];
  for (const list of turns) {
    let signed = 0;
    for (const [i, r] of list.entries()) {
      if (r.step > 1 && signed > 0 && (r.natives?.sent ?? 0) < signed) back.push(`${whereOf(r)}: ${signed} earlier ${signed === 1 ? 'reply' : 'replies'} with thinking, ${r.natives?.sent ?? 0} sent back${r.natives?.changed ? ' (changed)' : ''}`);
      // A reply counts when annai kept a native for it (a signed one cut at max_tokens, say, correctly has none); old summaries had only signed.
      if (r.kept ?? r.signed) signed++;
      // Within a turn, a step reads at least what the step before it had read and written: that prefix is in its request, and was cached.
      const was = list[i - 1];
      if (was && r.cacheRead < was.cacheRead + was.cacheWrite) cache.push(`${whereOf(r)}: read ${r.cacheRead}, but step ${was.step} had read ${was.cacheRead} and written ${was.cacheWrite}`);
      if (was && r.cacheRead <= was.cacheRead) grow.push(`${whereOf(r)}: read ${r.cacheRead}, not above step ${was.step}'s ${was.cacheRead}`);
    }
  }
  // The next turn's first request reads where the previous turn began, which that turn's first request had cached: each half's turns after its first.
  for (const half of new Set(turns.map((l) => l[0].half))) {
    const own = turns.filter((l) => l[0].half === half);
    for (const [i, list] of own.entries()) {
      const was = own[i - 1]?.[0];
      if (was && list[0].cacheRead < was.cacheRead + was.cacheWrite) cache.push(`${whereOf(list[0])}: the next turn's first request read ${list[0].cacheRead}, but the turn before had read ${was.cacheRead} and written ${was.cacheWrite} at its first step`);
      if (was && list[0].cacheRead <= was.cacheRead) grow.push(`${whereOf(list[0])}: the next turn's first request read ${list[0].cacheRead}, not above the turn before's ${was.cacheRead} at its first step`);
    }
  }
  const sentAny = rows.some((r) => r.step >= 2 && (r.natives?.sent ?? 0) > 0);
  return [
    { name: 'a native was sent on a step 2 or later: Claude\'s thinking went back at least once', problems: sentAny ? [] : [`${provider}: no request on a step 2 or later sent a native`] },
    { name: 'every step after a reply with thinking sends it back', problems: back },
    { name: 'no attempt refused for its reasoning, and no 400', problems: rows.flatMap((r) => [...(r.outcomes.includes('reasoning') ? [`${whereOf(r)}: refused for its reasoning`] : []), ...(r.statuses.includes(400) ? [`${whereOf(r)}: a 400`] : [])]) },
    { name: "every call answered by the role's first model", problems: rows.filter((r) => r.outcomes.length !== 1 || r.outcomes[0] !== 'ok' || (r.first && r.answeredBy !== r.first)).map((r) => `${whereOf(r)}: ${r.outcomes.join(', ')}; answered by ${r.answeredBy}`) },
    { name: 'within a turn, and at each half\'s next turn, a request reads at least what the one before it read and wrote', problems: cache },
    { name: 'within a turn, and at each half\'s next turn, a request reads more than the one before it: something past the system prompt is cached', problems: grow },
    ...(provider === 'anthropic' ? [{ name: 'the negative control: a changed earlier message is refused, asked again once without thinking on the same model, and answered; nothing rests or falls back', problems: controlProblems(all) }] : []),
    { name: 'Claude to Claude: one step answered by the next Claude model after Sonnet failed, and the rest of the turn accepted', problems: crossProblems(all) },
  ];
}

/** What went wrong in the negative control on Anthropic: it must be refused, asked again once on the same model, and answered. @param {Row[]} all */
function controlProblems(all) {
  const row = inPhase(all, 'control').find((r) => r.altered);
  if (!row) return ['no request carried thinking in the control turn, so no earlier message could be changed under it'];
  const problems = [];
  if (row.outcomes.join() !== 'reasoning,ok') problems.push(`${whereOf(row)}: attempts were ${row.outcomes.join(', ')}, not a refusal and one answer`);
  if (row.statuses.join() !== '400,200') problems.push(`${whereOf(row)}: statuses were ${row.statuses.join(', ')}, not 400 then 200`);
  if (row.first && row.answeredBy !== row.first && !row.outcomes.includes('benched')) problems.push(`${whereOf(row)}: answered by ${row.answeredBy}, not the model asked`);
  if (row.benched) problems.push(`${whereOf(row)}: a model was left resting`);
  return problems;
}

/** What went wrong in the Claude-to-Claude turn. A turn stopped on purpose by differing provider tools is reported (notes), not a problem. @param {Row[]} all */
function crossProblems(all) {
  const rows = inPhase(all, 'cross');
  const stubbed = rows.find((r) => r.stubbed);
  if (!stubbed) return ['no request carried thinking in the Claude-to-Claude turn, so none was made to fail'];
  const problems = [];
  if (stubbed.outcomes.at(-1) !== 'ok' || stubbed.model === PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (stubbed.provider)].kokoro) problems.push(`${whereOf(stubbed)}: the stubbed step was not answered by the next Claude (${stubbed.outcomes.join(', ')}; answered by ${stubbed.answeredBy})`);
  for (const r of rows) {
    if (r.outcomes.includes('reasoning')) problems.push(`${whereOf(r)}: refused for its reasoning`);
    if (r.statuses.includes(400)) problems.push(`${whereOf(r)}: a 400`);
  }
  return problems;
}

/**
 * What the run found that is no check's to fail: said in the report. @param {Row[]} all @returns {string[]}
 */
export function notes(all) {
  const provider = all[0]?.provider ?? '';
  const out = [];
  const main = inPhase(all, 'main');
  if (provider === 'anthropic') {
    const bound = all.filter((r) => r.bound).length;
    out.push(`block_binding (an error on a mismatch) was sent on ${bound} of ${all.length} steps${bound ? '' : ': none, so an account made before 2026-08-31 would not have failed a broken binding here'}.`);
    const seen = all.filter((r) => r.transformations !== null && r.transformations !== undefined);
    const entries = [...new Set(seen.flatMap((r) => r.transformations ?? []))];
    out.push(seen.length ? `input_transformations came with ${seen.length} of ${all.length} steps${entries.length ? `: ${entries.join(', ')}` : ', always empty'}.` : 'input_transformations never appeared in a stream: only the 400s could show a broken binding.');
  }
  if (provider === 'openrouter') {
    const per = turnsOf(all).map((list) => ({ list, up: [...new Set(list.map((r) => r.upstream).filter(Boolean))] })).filter((x) => x.up.length);
    out.push(per.length ? `Upstream provider per turn: ${per.map(({ list, up }) => `${list[0].half} ${list[0].wake.slice(-4)} ${up.join(' then ')}${up.length > 1 ? ' (changed within the turn)' : ''}`).join('; ')}.` : 'OpenRouter named no upstream provider in its stream.');
    const row = inPhase(all, 'control').find((r) => r.altered);
    out.push(row ? `Negative control: ${row.outcomes.join() === 'reasoning,ok' ? 'OpenRouter refused the changed message (400), and annai asked again without thinking' : row.statuses.includes(400) ? `refused (${row.outcomes.join(', ')})` : 'OpenRouter answered it (200): the thinking was dropped, or not checked'}.` : 'Negative control: no request carried thinking, so nothing was changed.');
  }
  const stubbed = inPhase(all, 'cross').find((r) => r.stubbed);
  if (stubbed) {
    const after = inPhase(all, 'cross').filter((r) => r.half === stubbed.half && r.wake === stubbed.wake && r.step >= stubbed.step);
    const natives = after.map((r) => r.natives);
    out.push(`Claude to Claude: ${stubbed.answeredBy ?? 'the next model'} answered the stubbed step; natives sent from there on: ${natives.map((x) => (x ? `${x.sent}${x.changed ? ' (changed)' : ''}` : '0')).join(', ')}${natives.some((x) => x?.changed) ? '; the turn\'s thinking stopped because something before it differed between the two models (their provider tools, say)' : ''}.`);
  }
  // A signed reply annai kept nothing for (cut at max_tokens, or OpenRouter's [REDACTED] details) is right, but its thinking can't go back.
  const unkept = all.filter((r) => r.signed && r.kept === false);
  if (unkept.length) out.push(`${unkept.length} signed ${unkept.length === 1 ? 'reply' : 'replies'} kept no native, so their thinking could not go back: ${unkept.map(whereOf).join('; ')}.`);
  if (!main.length) out.push('The conversation produced no rows.');
  // Every need of a check below is a reply with thinking followed by another step: adaptive thinking may skip thinking on easy steps.
  if (!turnsOf(main).some((list) => list.some((r, i) => (r.kept ?? r.signed) && i < list.length - 1))) out.push('no reply thought before another step: inconclusive, rerun (it is not a fault of annai until thinking is seen and not sent back).');
  const failing = checks(all).filter((c) => c.problems.length);
  if (failing.length && failing.every((c) => /reads (at least|more than)/.test(c.name))) {
    out.push(provider === 'openrouter'
      ? 'only the cache checks failed: the likely cause is that OpenRouter did not pass on the cache marks on the tool messages\' content, so only the system prompt was cached. The fix (docs/testing/reasoning-check.md): put the end mark on the request\'s own now block instead, in chat-completions\' build.'
      : 'only the cache checks failed: the marks annai placed (the system, the end, cacheAt) were not the entries the next request read; compare the table\'s cache read and write columns.');
  }
  return out;
}

/** The rows as a table, and each turn's kept thinking at its last step, in KB. @param {Row[]} rows */
export function table(rows) {
  const head = ['provider', 'half', 'turn', 'step', 'part', 'model', 'sent', 'thinking back', 'natives', 'outcome', 'cache read', 'cache write', 'cost', 'upstream'];
  const kb = (/** @type {number} */ n) => `${(n / 1024).toFixed(1)} KB`;
  const part = (/** @type {Row} */ r) => ({ main: '', control: 'control', cross: 'cross' })[r.phase ?? 'main'] + (r.altered ? '*' : '') + (r.stubbed ? '!' : '');
  const lines = rows.map((r) => [r.provider, r.half, r.wake.slice(-4), String(r.step), part(r), r.model, kb(r.bytes), kb(r.thinkingBytes),
    r.natives ? `${r.natives.sent} sent${r.natives.changed ? ', changed' : ''}` : '-', r.outcomes.join(' then '), String(r.cacheRead), String(r.cacheWrite), r.cost === null ? '-' : `$${r.cost.toFixed(4)}`, r.upstream ?? '-']);
  const width = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (/** @type {string[]} */ l) => l.map((x, i) => x.padEnd(width[i])).join('  ').trimEnd();
  /** @type {Map<string, number>} */
  const kept = new Map();
  for (const r of inPhase(rows, 'main')) kept.set(`${r.provider} ${r.half} turn ${r.wake.slice(-4)}`, Math.max(kept.get(`${r.provider} ${r.half} turn ${r.wake.slice(-4)}`) ?? 0, r.thinkingBytes));
  const steps = inPhase(rows, 'main').filter((r) => r.step > 1 && r.thinkingBytes > 0);
  const perStep = steps.length ? steps.reduce((n, r) => n + r.thinkingBytes / Math.max(1, r.natives?.sent ?? 1), 0) / steps.length : 0;
  return [fmt(head), ...lines.map(fmt), '', '* the request the control changed an earlier message in; ! the step made to fail with a 529', '', 'Thinking kept per turn (the last step\'s request):', ...[...kept].map(([k, v]) => `  ${k}: ${kb(v)}`),
    `About ${kb(perStep)} of thinking per step sent back (the design assumed 5 KB; the limit is 64 KB).`].join('\n');
}

/** The report of a run's rows: the table, then each check, passed or not, then what was found besides. @param {Row[]} rows */
export function report(rows) {
  const results = [...new Set(rows.map((r) => r.provider))].map((p) => ({ provider: p, checks: checks(rows.filter((r) => r.provider === p)), notes: notes(rows.filter((r) => r.provider === p)) }));
  const pass = rows.length > 0 && results.every((r) => r.checks.every((c) => !c.problems.length));
  const text = [table(rows), '', ...results.flatMap((r) => [`${r.provider}:`, ...r.checks.map((c) => `  ${c.problems.length ? 'FAIL' : 'pass'}  ${c.name}${c.problems.map((p) => `\n          ${p}`).join('')}`), ...r.notes.map((x) => `  note  ${x}`)]), '', pass ? 'PASS' : 'FAIL'].join('\n');
  return { pass, text, results };
}

/**
 * Runs the providers given, writes the summary (rows, no bodies) after checking it holds no key, and says whether every check passed.
 * @param {{ providers: { provider: keyof typeof PROVIDERS, key: () => string, fetch: (url: string, init: RequestInit) => Promise<Response>, sleep?: (ms: number) => Promise<void> }[],
 *   out: URL, keys: { scrub: (s: string) => string, assertClean: (s: string, what?: string) => void }[], log?: (s: string) => void }} c
 */
export async function runCheck({ providers, out, keys, log = console.log }) {
  /** @type {Row[]} */
  const rows = [];
  for (const p of providers) rows.push(...(await runProvider({ ...p, log })));
  const r = report(rows);
  const clean = (/** @type {string} */ s, /** @type {string} */ what) => { for (const k of keys) k.assertClean(s, what); return s; };
  await mkdir(out, { recursive: true });
  await writeFile(new URL('summary.json', out), clean(`${JSON.stringify({ rows, pass: r.pass }, null, 1)}\n`, 'summary.json'));
  await writeFile(new URL('summary.txt', out), clean(`${r.text}\n`, 'summary.txt'));
  log(clean(r.text, 'the report'));
  return r;
}

/** A run's summary read again, and checked anew: no network. @param {URL} dir */
export async function reread(dir) {
  const { rows } = JSON.parse(await readFile(new URL('summary.json', dir), 'utf8'));
  return report(rows);
}
