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
import { mergePatch } from '../../src/core/patch.js';
import { Halves } from '../../src/core/agent/halves.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { activate as anthropicMessages } from '../../plugins-official/anthropic-messages/index.js';
import { activate as chatCompletions } from '../../plugins-official/chat-completions/index.js';

/** Where each provider is, its description, and the models Kokoro (Sonnet 5.5) and Koe · Classic (Haiku 5.5) run on. */
export const PROVIDERS = Object.freeze({
  anthropic: { plugin: 'provider-anthropic', kokoro: 'claude-sonnet-5-5', koe: 'claude-haiku-5-5', host: 'api.anthropic.com' },
  openrouter: { plugin: 'provider-openrouter', kokoro: 'anthropic/claude-sonnet-5.5', koe: 'anthropic/claude-haiku-5.5', host: 'openrouter.ai' },
});
/** The synthetic trip: nothing in it is anyone's. */
const TRIP = { title: 'Coast test trip', start: '2026-11-02', end: '2026-11-05' };
const NOTES = { '/notes/hotel.md': 'Hotel: the Seaview Inn, 12 Harbor Road, Example Bay. Check-in from 15:00.', '/notes/dinner.md': 'Dinner on the 3rd: the Lantern, 19:30, table for two.' };
/** What the user says, in turn. */
export const SAYS = Object.freeze([
  'Please look through my trip notes, read the hotel one, and tell me where we stay and when we can check in.',
  'Thanks! And where is dinner on the 3rd?',
]);

/**
 * One request, as the check records it: never its body, only its size and what it sent back. @typedef {{ provider: string, model: string,
 *   bytes: number, thinking: number, thinkingBytes: number, status: number, signed: boolean }} Sent
 * @typedef {{ provider: string, half: string, wake: string, step: number, model: string, answeredBy: string | null, first: string | null,
 *   outcomes: string[], bytes: number, thinkingBytes: number, natives: { sent: number, changed: boolean } | null, cacheRead: number,
 *   cacheWrite: number, cost: number | null, signed: boolean, statuses: number[] }} Row
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
 * annai in Node: a memory store, the file tools, the two endpoint types, the providers as their descriptions give them, Halves with
 * Kokoro on main and Koe · Classic; voice off.
 * @param {{ provider: keyof typeof PROVIDERS, key: () => string, fetch: (url: string, init: RequestInit) => Promise<Response> }} c
 */
async function annai({ provider, key, fetch }) {
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
  /** @type {Map<string, any>} */
  const types = new Map();
  const helpers = { sse, parsePartialJSON, ProviderError, errorFromResponse, retry };
  for (const [id, activate] of /** @type {const} */ ([['anthropic-messages', anthropicMessages], ['chat-completions', chatCompletions]])) {
    activate({ providers: { register: (/** @type {any} */ x) => { types.set(x.type, { ...x, pluginId: id }); return () => {}; } }, helpers });
  }
  const desc = JSON.parse(await readFile(new URL(`../../plugins-official/${which.plugin}/annai-plugin.json`, import.meta.url), 'utf8'));
  const chat = desc.provider.abilities.chat;
  const rec = { id: 'pv-check', plugin: which.plugin, template: { version: desc.version, values: desc.provider }, user: {}, created: 0 };
  const models = [which.kokoro, which.koe].map((providerId, i) => {
    const m = chat.models.find((/** @type {any} */ x) => x.providerId === providerId);
    if (!m) throw new Error(`${which.plugin}'s description has no ${providerId}.`);
    return { id: i ? 'm-koe' : 'm-kokoro', provider: rec.id, ability: 'chat', template: { id: `${which.plugin}/chat/${providerId}`, version: desc.version, values: mergePatch(chat.modelDefaults ?? {}, m) }, user: {}, created: 0 };
  });
  await saveProvider(ws, /** @type {any} */ (rec), /** @type {any} */ (models));
  await saveRoles(ws, { main: { models: ['m-kokoro'], level: 'medium' }, 'koe-classic': { models: ['m-koe'], level: 'low' }, 'koe-realtime': { models: [], level: 'off' }, utility: { models: ['m-kokoro'], level: 'low' }, decide: { models: [], level: 'off' } }, { koeMode: 'classic' });
  const bench = new Bench();
  const none = async () => { throw new Error('Not in the reasoning check.'); };
  const llm = {
    bench,
    config: () => readConfig(ws),
    uploading: async () => false,
    /** @param {any} c */
    call: async (c) => callRole({
      role: c.role ?? 'main', request: c.request, level: c.level, config: await readConfig(ws), types, bench, signal: c.signal, onEvent: c.onEvent, prefer: c.prefer,
      record: c.record, repairImages: c.repairImages, trace: (() => { const t = modelTrace(store, c.scope ?? trip); t.secret(key()); return t; })(), speech: c.speech,
      firstOutputMs: c.firstOutputMs ?? 90_000, read: c.read, readings: c.readings, askResting: c.askResting, keepNative: c.keepNative, fetch,
      // The key goes only to the endpoint type, which puts it in its request's header.
      keyFor: async () => key(),
    }),
    types: () => types,
    synthesize: none, transcribe: none, live: none,
    decide: none,
  };
  const agent = new Halves({ store, ws, llm, registry, timeZone: () => 'UTC', secondMs: 1000 });
  agent.addLoopTools(selfTools(agent.kokoro));
  await agent.open(trip);
  return { store, trip, agent };
}

/**
 * The run against one provider: two messages, each answered in full; what went to it and back, as rows.
 * @param {{ provider: keyof typeof PROVIDERS, key: () => string, fetch: (url: string, init: RequestInit) => Promise<Response>, log: (s: string) => void, timeoutMs?: number }} c
 * @returns {Promise<Row[]>}
 */
export async function runProvider({ provider, key, fetch: send, log, timeoutMs = 240_000 }) {
  /** @type {Sent[]} */
  const sent = [];
  /** @type {Promise<unknown>[]} */
  const reading = [];
  const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const t = thinkingOf(body);
    /** @type {Sent} */
    const rec = { provider, model: String(body.model ?? ''), bytes: typeof init.body === 'string' ? Buffer.byteLength(init.body) : 0, thinking: t.count, thinkingBytes: t.bytes, status: 0, signed: false };
    sent.push(rec);
    const res = await send(url, init);
    rec.status = res.status;
    // Whether the reply carried signed thinking, which the next step should send back: read from a copy, never kept.
    if (res.ok) reading.push(res.clone().text().then((x) => { rec.signed = /"signature(_delta)?"|signature/.test(x); }, () => {}));
    return res;
  };
  const { store, trip, agent } = await annai({ provider, key, fetch });
  for (const say of SAYS) {
    log(`  [${provider}] the user: ${say}`);
    agent.send(say);
    await Promise.race([agent.idle(), new Promise((_, no) => setTimeout(() => no(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs))]);
  }
  await Promise.all(reading);
  const events = await store.tx(['events'], 'readonly', (t) => t.listEvents(trip));
  // Each half calls its own model, one call at a time: a request is its model's next, and a call's requests come before its model.turn.
  const which = PROVIDERS[provider];
  const ids = /** @type {Record<string, string>} */ ({ 'm-kokoro': which.kokoro, 'm-koe': which.koe });
  /** @type {Map<string, Sent[]>} */
  const queued = new Map();
  for (const x of sent) queued.set(x.model, [...(queued.get(x.model) ?? []), x]);
  /** @type {Map<string, any[]>} */
  const pending = new Map();
  /** @type {Row[]} */
  const rows = [];
  /** @type {Map<string, number>} */
  const steps = new Map();
  for (const e of events) {
    if (e.type === 'net.request' && e.data.kind === 'model') {
      const m = String(e.data.providerModel ?? '');
      pending.set(m, [...(pending.get(m) ?? []), { e, s: queued.get(m)?.shift() }]);
      continue;
    }
    if (e.type !== 'model.turn') continue;
    const model = ids[String(e.data.attempts?.at(-1)?.model ?? '')] ?? '';
    const calls = pending.get(model) ?? [];
    pending.set(model, []);
    if (!['conversation', 'koe'].includes(e.data.tag)) continue;
    const half = e.data.tag === 'koe' ? 'Koe' : 'Kokoro';
    const k = `${half}|${e.data.wake}`;
    const step = (steps.get(k) ?? 0) + 1;
    steps.set(k, step);
    const lastCall = calls.at(-1);
    const u = lastCall?.e.data.usage ?? {};
    rows.push({
      provider, half, wake: String(e.data.wake ?? ''), step, model, answeredBy: e.data.answeredBy ?? null, first: e.data.first ?? null,
      outcomes: (e.data.attempts ?? []).map((/** @type {any} */ a) => String(a.outcome)), bytes: calls.reduce((n, c) => n + (c.s?.bytes ?? 0), 0),
      thinkingBytes: lastCall?.s?.thinkingBytes ?? 0, natives: lastCall?.e.data.natives ?? null, cacheRead: Number(u.cacheRead) || 0,
      cacheWrite: (Number(u.cacheWrite) || 0) + (Number(u.cacheWrite1h) || 0), cost: typeof e.data.cost === 'number' ? e.data.cost : null,
      signed: Boolean(lastCall?.s?.signed), statuses: calls.map((c) => c.s?.status ?? 0),
    });
  }
  return rows;
}

/**
 * The four checks (the design §12), on one provider's rows: each a name and the problems found.
 * @param {Row[]} rows @returns {{ name: string, problems: string[] }[]}
 */
export function checks(rows) {
  const where = (/** @type {Row} */ r) => `${r.provider} ${r.half} turn ${r.wake.slice(-4)} step ${r.step}`;
  /** @type {Map<string, Row[]>} */
  const turns = new Map();
  for (const r of rows) turns.set(`${r.half}|${r.wake}`, [...(turns.get(`${r.half}|${r.wake}`) ?? []), r]);
  const back = [];
  const cache = [];
  for (const list of turns.values()) {
    let signed = 0;
    for (const r of list) {
      if (r.step > 1 && signed > 0 && (r.natives?.sent ?? 0) < signed) back.push(`${where(r)}: ${signed} earlier ${signed === 1 ? 'reply' : 'replies'} with thinking, ${r.natives?.sent ?? 0} sent back${r.natives?.changed ? ' (changed)' : ''}`);
      if (r.signed) signed++;
      if (r.step > 1 && !(r.cacheRead > 0)) cache.push(`${where(r)}: no cache read`);
    }
  }
  // The next turn's first request reads where the previous turn began: each half's turns after its first.
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const r of rows.filter((x) => x.step === 1)) {
    const n = (seen.get(r.half) ?? 0) + 1;
    seen.set(r.half, n);
    if (n > 1 && !(r.cacheRead > 0)) cache.push(`${where(r)}: the next turn's first request read no cache`);
  }
  return [
    { name: 'every step after a reply with thinking sends it back', problems: back },
    { name: 'no attempt refused for its reasoning, and no 400', problems: rows.flatMap((r) => [...(r.outcomes.includes('reasoning') ? [`${where(r)}: refused for its reasoning`] : []), ...(r.statuses.includes(400) ? [`${where(r)}: a 400`] : [])]) },
    { name: "every call answered by the role's first model", problems: rows.filter((r) => r.outcomes.length !== 1 || r.outcomes[0] !== 'ok' || (r.first && r.answeredBy !== r.first)).map((r) => `${where(r)}: ${r.outcomes.join(', ')}; answered by ${r.answeredBy}`) },
    { name: 'from the second step on, and at the next turn, every request reads the cache', problems: cache },
  ];
}

/** The rows as a table, and each turn's kept thinking at its last step, in KB. @param {Row[]} rows */
export function table(rows) {
  const head = ['provider', 'half', 'turn', 'step', 'model', 'sent', 'thinking back', 'natives', 'outcome', 'cache read', 'cache write', 'cost'];
  const kb = (/** @type {number} */ n) => `${(n / 1024).toFixed(1)} KB`;
  const lines = rows.map((r) => [r.provider, r.half, r.wake.slice(-4), String(r.step), r.model, kb(r.bytes), kb(r.thinkingBytes),
    r.natives ? `${r.natives.sent} sent${r.natives.changed ? ', changed' : ''}` : '-', r.outcomes.join(' then '), String(r.cacheRead), String(r.cacheWrite), r.cost === null ? '-' : `$${r.cost.toFixed(4)}`]);
  const width = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (/** @type {string[]} */ l) => l.map((x, i) => x.padEnd(width[i])).join('  ').trimEnd();
  /** @type {Map<string, number>} */
  const kept = new Map();
  for (const r of rows) kept.set(`${r.provider} ${r.half} turn ${r.wake.slice(-4)}`, Math.max(kept.get(`${r.provider} ${r.half} turn ${r.wake.slice(-4)}`) ?? 0, r.thinkingBytes));
  const steps = rows.filter((r) => r.step > 1 && r.thinkingBytes > 0);
  const perStep = steps.length ? steps.reduce((n, r) => n + r.thinkingBytes / Math.max(1, r.natives?.sent ?? 1), 0) / steps.length : 0;
  return [fmt(head), ...lines.map(fmt), '', 'Thinking kept per turn (the last step\'s request):', ...[...kept].map(([k, v]) => `  ${k}: ${kb(v)}`),
    `About ${kb(perStep)} of thinking per step sent back (the design assumed 5 KB; the limit is 64 KB).`].join('\n');
}

/** The report of a run's rows: the table, then each check, passed or not. @param {Row[]} rows */
export function report(rows) {
  const results = [...new Set(rows.map((r) => r.provider))].map((p) => ({ provider: p, checks: checks(rows.filter((r) => r.provider === p)) }));
  const pass = rows.length > 0 && results.every((r) => r.checks.every((c) => !c.problems.length));
  const text = [table(rows), '', ...results.flatMap((r) => [`${r.provider}:`, ...r.checks.map((c) => `  ${c.problems.length ? 'FAIL' : 'pass'}  ${c.name}${c.problems.map((p) => `\n          ${p}`).join('')}`)]), '', pass ? 'PASS' : 'FAIL'].join('\n');
  return { pass, text, results };
}

/**
 * Runs the providers given, writes the summary (rows, no bodies) after checking it holds no key, and says whether every check passed.
 * @param {{ providers: { provider: keyof typeof PROVIDERS, key: () => string, fetch: (url: string, init: RequestInit) => Promise<Response> }[],
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
