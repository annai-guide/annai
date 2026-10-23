import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { Kept, keyPrint, keeperOf, lookTurn } from '../../src/core/llm/kept.js';
import { Uploads } from '../../src/core/llm/uploads.js';
import { sha256Hex } from '../../src/core/hash.js';
import { callRole, Bench } from '../../src/core/llm/fallback.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS_DEVICE } from '../../src/core/scopes.js';
import { activate } from '../../plugins-official/openai-responses/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { startOpenAIServer } from '../fakes/openai-server.js';

// OpenAI keeps a conversation's turns on its side (`store: true`, `previous_response_id`), as Gemini does: the same Kept
// machinery, against the Responses stand-in. The real API is not reached from here (no key): see the report.

const KEY = 'sk-stand-in-openai-key-0123456789';
const MODEL = 'gpt-6-luna';
const DAY = 86_400_000;
/** The endpoint type, registered the way annai's plugin host would. @returns {any} */
function load() {
  /** @type {any} */
  let type = null;
  activate({ providers: { register: (/** @type {any} */ t) => { type = { ...t, pluginId: 'openai-responses' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return type;
}
const type = load();
const TOOL = { name: 'places', description: 'Places nearby.', input: { type: 'object', properties: { q: { type: 'string' } } } };
/** @param {'user' | 'assistant'} role @param {...any} parts @returns {any} */
const msg = (role, ...parts) => ({ role, parts });
const text = (/** @type {string} */ t) => ({ type: 'text', text: t });
const m1 = msg('user', text('Where can we eat?'));

/** An OpenAI provider at the stand-in's address, its models in main and utility. @param {string} url @param {Record<string, any>} [tunables] @param {string} [providerId] */
const config = (url, tunables = { keep: true }, providerId = MODEL, headers = {}) => /** @type {any} */ ({
  providers: { 'pv-o': { id: 'pv-o', plugin: 'provider-openai', template: null, user: { name: 'OpenAI', baseUrl: url, headers, abilities: { chat: { kind: 'chat', type: 'openai-responses', tunables } } }, created: 0 } },
  models: { 'm-o': { id: 'm-o', provider: 'pv-o', ability: 'chat', template: null, user: { providerId, input: ['text', 'image'] }, created: 0 }, 'm-p': { id: 'm-p', provider: 'pv-o', ability: 'chat', template: null, user: { providerId: 'gpt-6-sol', input: ['text'] }, created: 0 } },
  roles: { main: { models: ['m-o'], level: 'off' }, utility: { models: ['m-o'], level: 'off' } },
});

/** A Kept on memory storage, with calls through callRole. @param {any[]} replies @param {Record<string, any>} [tunables] @param {{ notFoundStatus?: number, zdr?: boolean, headers?: Record<string, string>, anyKey?: boolean }} [o] */
async function callKit(replies, tunables = { keep: true }, o = {}) {
  const { headers, anyKey, ...server } = o;
  const s = await startOpenAIServer({ ...(anyKey ? {} : { key: KEY }), replies, ...server });
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const clock = { skew: 0 };
  const kept = new Kept({ ws, now: () => Date.now() + clock.skew });
  const cfg = config(s.url, tunables, MODEL, headers);
  /** @param {any[]} messages @param {Record<string, any>} [o] */
  const call = (messages, o = {}) => callRole({
    role: 'main', config: cfg, types: new Map([['openai-responses', type]]), bench: new Bench(), keyFor: async () => KEY, kept, scope: 'trip-a',
    record: { keepParts: true }, trace: modelTrace(store, 'trip-a'), request: { messages, system: 'You are Shiori.', tail: 'Now: 12:00, Kyōto.', tools: [TOOL] }, ...o,
  });
  const requests = async () => (await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-a', { types: ['net.request'] }))).map((e) => e.data);
  return { s, store, ws, kept, cfg, clock, call, requests, file: async () => ws.readJSON(SYS_DEVICE, '/llm/kept.json') };
}
/** The conversation so far as messages, after a call's reply. @param {any[]} messages @param {any} r */
const said = (messages, r) => [...messages, msg('assistant', ...r.reply.parts)];

test("a conversation's second turn sends only what is new, after the response it continues; the system prompt and the now block go every time", async () => {
  const c = await callKit([{ calls: [{ name: 'places', input: { q: 'ramen' } }] }, { text: 'Ichiran is 200 m away.' }, { text: 'Until 23:00.' }]);
  try {
    const first = await c.call([m1]);
    const tr = msg('user', { type: 'tool_result', id: /** @type {any} */ (first.reply.parts.find((p) => p.type === 'tool_call')).id, content: 'Ichiran, 200 m' });
    const h2 = [...said([m1], first), tr];
    const second = await c.call(h2);
    assert.equal(second.reply.text, 'Ichiran is 200 m away.');
    const [b1, b2] = c.s.bodies();
    assert.deepEqual([b1.store, b1.previous_response_id], [true, undefined]);
    assert.deepEqual([b2.store, b2.previous_response_id], [true, 'resp_stand-in-1']);
    assert.deepEqual(b2.input, [
      { type: 'function_call_output', call_id: 'call_1_0', output: 'Ichiran, 200 m' },
      { role: 'developer', content: 'Now: 12:00, Kyōto.' },
    ], 'the tool result and the now block, nothing OpenAI keeps');
    assert.equal(b2.instructions, 'You are Shiori.', "instructions aren't carried over by OpenAI");
    assert.equal(b2.tools.length, 1);
    const [q1, q2] = await c.requests();
    assert.deepEqual([q1.kept, q2.kept], [undefined, { from: 2 }]);
    assert.ok(q2.bytes < q1.bytes + 100);
    // Its third turn continues the second.
    await c.call([...said(h2, second), msg('user', text('Is it open now?'))]);
    assert.equal(c.s.bodies()[2].previous_response_id, 'resp_stand-in-2');
    assert.deepEqual(await c.kept.count(), { turns: 3, waiting: 0, until: (await c.file()).turns[2].until, endpoints: ['pv-o/chat'] });
    assert.ok(c.s.bodies()[1].input.length < 3);
  } finally {
    await c.s.close();
  }
});

test('a mismatch sends everything: an edited or forgotten message, a Start fresh, a compaction, and another model', async () => {
  const c = await callKit([{ text: 'Ichiran.' }]);
  try {
    const r = await c.call([m1]);
    const h = said([m1], r);
    const more = msg('user', text('Is it open?'));
    await c.call([msg('user', text('Where can we drink?')), ...h.slice(1), more]); // the first message edited
    await c.call([...h.slice(1), more]); // the first message forgotten
    await c.call([msg('user', text('[annai: a new conversation] Today is a new day in Kyoto.')), more]); // Start fresh: the note is message 0
    await c.call([msg('user', text('Summary: they asked about food.')), more]); // a compaction: the summary replaces the past
    const bodies = c.s.bodies();
    for (const b of bodies.slice(1)) assert.equal(b.previous_response_id, undefined, 'whole');
    assert.equal(bodies[1].input.length, 4, 'the edit: all of it, and the now block');
    assert.equal(bodies.length, 5);
    // The model changes: the same conversation, another model, is a new chain.
    const cfg = /** @type {any} */ ({ ...c.cfg, roles: { ...c.cfg.roles, main: { models: ['m-p'], level: 'off' } } });
    await c.call([...h, more], { config: cfg });
    assert.equal(c.s.bodies().at(-1).previous_response_id, undefined, 'another model never continues it');
    assert.equal(c.s.bodies().at(-1).model, 'gpt-6-sol');
    assert.equal(c.s.bodies().at(-1).store, true, 'and starts a chain of its own');
    // The first model, still in the log, continues its own.
    await c.call([...h, more]);
    assert.equal(c.s.bodies().at(-1).previous_response_id, 'resp_stand-in-1');
  } finally {
    await c.s.close();
  }
});

for (const status of [400, 404]) {
  test(`"not found" (${status}): OpenAI no longer has the response, so the same model is asked once more, whole, and starts a new chain`, async () => {
    const c = await callKit([{ text: 'Ichiran.' }, { text: 'Yes, until 23:00.' }], { keep: true }, { notFoundStatus: status });
    try {
      const r = await c.call([m1]);
      c.clock.skew = 3_600_000; // an hour on: gone since (a server that has lost one minutes after storing it is not storing)
      c.s.expire();
      const again = await c.call([...said([m1], r), msg('user', text('Is it open?'))]);
      assert.equal(again.reply.text, 'Yes, until 23:00.');
      assert.deepEqual(again.attempts.map((a) => a.outcome), ['forgotten', 'ok']);
      const [, b2, b3] = c.s.bodies();
      assert.equal(b2.previous_response_id, 'resp_stand-in-1');
      assert.equal(b3.previous_response_id, undefined);
      assert.equal(b3.store, true);
      assert.ok(b3.input.length > b2.input.length, 'whole');
      assert.deepEqual((await c.requests()).map((q) => [q.outcome, q.status]), [['ok', 200], ['forgotten', status], ['ok', 200]]);
      assert.deepEqual((await c.file()).turns.map((/** @type {any} */ x) => x.id), ['resp_stand-in-2'], 'the forgotten one gone, the whole one a new chain');
      // The next turn goes after the new one.
      await c.call([...said([...said([m1], r), msg('user', text('Is it open?'))], again), msg('user', text('Thanks'))]);
      assert.equal(c.s.bodies().at(-1).previous_response_id, 'resp_stand-in-2');
    } finally {
      await c.s.close();
    }
  });
}

test("classify: a missing previous response is forgotten, by its code or by its words alone; other 400s and 404s are not", () => {
  const body = (/** @type {any} */ e) => JSON.stringify({ error: { type: 'invalid_request_error', param: null, ...e } });
  assert.equal(type.classify(404, body({ message: "Previous response with id 'resp_1' not found.", code: 'previous_response_not_found' })), 'forgotten');
  assert.equal(type.classify(400, body({ message: "Previous response with id 'resp_1' not found.", code: null })), 'forgotten');
  assert.equal(type.classify(400, body({ message: "Previous response with id 'resp_1' not found.", code: 'invalid_request_error' })), 'forgotten');
  assert.equal(type.classify(404, body({ message: "The model 'x' does not exist", code: 'model_not_found' })), 'not-found');
  assert.equal(type.classify(400, body({ message: 'Something else is wrong.', code: null })), null);
});

test("only a conversation's own turns are kept: a utility call stores nothing, and the switch off sends store: false and keeps nothing", async () => {
  const c = await callKit([{ text: 'OK' }]);
  try {
    await c.call([m1], { role: 'utility', record: {} });
    assert.equal(c.s.bodies()[0].store, false);
    assert.deepEqual(c.s.stored(), []);
    assert.deepEqual(await c.kept.count(), { turns: 0, waiting: 0, until: 0, endpoints: [] });
  } finally {
    await c.s.close();
  }
  const off = await callKit([{ text: 'OK' }], { keep: false });
  try {
    const r = await off.call([m1]);
    await off.call([...said([m1], r), msg('user', text('More?'))]);
    assert.deepEqual(off.s.bodies().map((b) => [b.store, b.previous_response_id]), [[false, undefined], [false, undefined]]);
    assert.deepEqual(off.s.stored(), []);
  } finally {
    await off.s.close();
  }
});

test('a call that fails after OpenAI kept its response deletes it', async () => {
  const c = await callKit([{ text: 'x', error: undefined }]);
  try {
    // A response OpenAI named, then a stream that fails: its response is deleted at once.
    const real = globalThis.fetch;
    const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
      const res = await real(url, init);
      if (init?.method !== 'POST') return res;
      const body = await res.text();
      const cut = body.slice(0, body.indexOf('event: response.output_item.added'));
      return new Response(`${cut}event: error\ndata: {"type":"error","code":"server_error","message":"boom","sequence_number":3}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    await assert.rejects(c.call([m1], { fetch }));
    assert.ok(c.s.deleted().length >= 1, 'each attempt, retried, deleted its own');
    assert.deepEqual(c.s.stored(), []);
    assert.deepEqual(await c.kept.count(), { turns: 0, waiting: 0, until: 0, endpoints: [] });
  } finally {
    await c.s.close();
  }
});

test('a whole (non-streamed) reply names its response too', async () => {
  const c = await callKit([{ text: 'Ichiran.' }, { text: 'Yes.' }]);
  try {
    const real = globalThis.fetch;
    // A server that ignores stream: true.
    const fetch = (/** @type {any} */ url, /** @type {any} */ init) => real(url, init?.body ? { ...init, body: JSON.stringify({ ...JSON.parse(init.body), stream: false }) } : init);
    const r = await c.call([m1], { fetch });
    await c.call([...said([m1], r), msg('user', text('Open?'))], { fetch });
    assert.deepEqual(c.s.bodies().map((b) => b.previous_response_id), [undefined, 'resp_stand-in-1']);
  } finally {
    await c.s.close();
  }
});

test('10 turns: the requests grow with the conversation sent whole, and stay the size of the new turn kept', async () => {
  /** @param {Record<string, any>} tunables */
  const run = async (tunables) => {
    const c = await callKit([(/** @type {any} */ b) => ({ text: `Answer to ${b.input.at(-2)?.content?.[0]?.text ?? b.input.at(-2)?.content}: ${'Ichiran is 200 m away, open until 23:00, and its broth is rich. '.repeat(4)}` })], tunables);
    try {
      /** @type {any[]} */
      let messages = [];
      /** @type {number[]} */
      const sizes = [];
      for (let i = 0; i < 10; i++) {
        messages = [...messages, msg('user', text(`Question ${i}: what is near the hotel at stop ${i}, and is it open late?`))];
        const r = await c.call(messages);
        messages = said(messages, r);
      }
      for (const q of await c.requests()) sizes.push(q.bytes);
      assert.equal(sizes.length, 10);
      return sizes;
    } finally {
      await c.s.close();
    }
  };
  const before = await run({ keep: false });
  const after = await run({ keep: true });
  const sum = (/** @type {number[]} */ a) => a.reduce((x, y) => x + y, 0);
  assert.ok(sum(after) < sum(before) / 2, `${sum(after)} against ${sum(before)}`);
  assert.ok(after[9] < after[0] * 1.2, 'the last request is the size of the first');
  assert.ok(before[9] > before[0] * 3, 'sent whole, it grows');
  if (process.env.ANNAI_EVIDENCE_DIR) {
    await mkdir(process.env.ANNAI_EVIDENCE_DIR, { recursive: true });
    await writeFile(`${process.env.ANNAI_EVIDENCE_DIR}/request-sizes.json`, JSON.stringify({ unit: 'request body bytes, 10 turns against the stand-in', whole: before, kept: after, total: { whole: sum(before), kept: sum(after) } }, null, 2));
  }
});

// ---- Deletions, through the service with provider-openai ----

/** The service with OpenAI added from annai's own files, at the stand-in's address, and two trips. @param {{ deleteDelay?: number, replies?: any[] }} [o] */
async function serviceKit({ deleteDelay = 0, replies = [(/** @type {any} */ b) => ({ text: `Answer ${b.input.length}` })] } = {}) {
  const { hostKit } = await import('./package-kit.js');
  const { createLlm } = await import('../../src/core/llm/service.js');
  const { createTrip } = await import('../../src/core/scopes.js');
  const s = await startOpenAIServer({ key: KEY, replies });
  const k = await hostKit();
  const root = new URL('../../', import.meta.url);
  const net = { online: true };
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (String(url).startsWith(s.url)) {
      if (!net.online) throw new TypeError('Failed to fetch');
      if (init?.method === 'DELETE' && deleteDelay) await new Promise((r) => setTimeout(r, deleteDelay));
      return globalThis.fetch(url, init);
    }
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
  const id = await llm.addProvider('provider-openai', { roles: 'recommended', key: KEY, baseUrl: s.url, official: true });
  const tripA = await createTrip(k.ws, { title: 'Kyoto' });
  const tripB = await createTrip(k.ws, { title: 'Osaka' });
  /** A conversation of n turns in a trip, each continuing the one before. @param {string} scope @param {number} n */
  const talk = async (scope, n) => {
    /** @type {any[]} */
    const messages = [];
    for (let i = 0; i < n; i++) {
      messages.push(msg('user', text(`${scope}: question ${i}`)));
      const r = await llm.call({ role: 'main', scope, request: { messages }, record: { keepParts: true } });
      messages.push(msg('assistant', ...r.reply.parts));
    }
  };
  /** The Chat ability's keep switch, saved as the provider page saves it. @param {boolean} [on] */
  const switchOff = async (on = false) => {
    const { readConfig, saveProvider } = await import('../../src/core/llm/config.js');
    const rec = (await readConfig(k.ws)).providers[id];
    await saveProvider(k.ws, { ...rec, user: { ...rec.user, abilities: { ...rec.user.abilities, chat: { ...rec.user.abilities?.chat, tunables: { keep: on } } } } });
  };
  /** annai starts again: a new service reads the files. */
  const restart = () => createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
  /** A response stored at OpenAI that annai only has as pending, left by a page killed mid-turn ageMs ago. */
  const orphan = async (ageMs = 120_000) => {
    const { ensureDeviceScope } = await import('../../src/core/scopes.js');
    const rid = (await (await fetch(`${s.url}/responses`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: 'x', store: true }) })).json()).id;
    const f = (await k.ws.readJSON(SYS_DEVICE, '/llm/kept.json').catch(() => null)) ?? { turns: [], forget: [], pending: [] };
    await ensureDeviceScope(k.store, Date.now());
    await k.ws.write(SYS_DEVICE, '/llm/kept.json', { ...f, pending: [...(f.pending ?? []), { id: rid, endpoint: `${id}/chat`, scope: tripA, key: await keyPrint(KEY, s.url), until: Date.now() + 35 * DAY, at: Date.now() - ageMs }] }, { author: 'system' });
    return rid;
  };
  return { s, ...k, llm, id, tripA, tripB, talk, net, fetch, switchOff, restart, orphan };
}

test("through the service: turns are chained per trip, counted as OpenAI keeps them (30 days), and removing a trip deletes its responses with DELETE /v1/responses/{id}", async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 3);
    await c.talk(c.tripB, 1);
    assert.deepEqual(c.s.bodies().map((b) => b.previous_response_id), [undefined, 'resp_stand-in-1', 'resp_stand-in-2', undefined]);
    assert.deepEqual(await c.llm.keptCount({ scope: c.tripA }), { turns: 3, waiting: 0, days: 35, who: ['OpenAI'] });
    const { removeTrip } = await import('../../src/core/scopes.js');
    await removeTrip(c.store, c.tripA);
    assert.deepEqual(await c.llm.forgetScope(c.tripA), { queued: 3 });
    await c.llm.drainKept();
    assert.deepEqual(c.s.deleted().sort(), ['resp_stand-in-1', 'resp_stand-in-2', 'resp_stand-in-3']);
    assert.deepEqual(c.s.stored(), ['resp_stand-in-4'], "Osaka's stays");
    const del = c.s.seen.filter((x) => x.method === 'DELETE');
    assert.ok(del.every((x) => x.headers.authorization === `Bearer ${KEY}` && x.url.startsWith('/v1/responses/resp_stand-in-')));
    const traced = (await c.store.tx(['events'], 'readonly', (t) => t.listEvents('sys', { types: ['net.request'] }))).map((e) => e.data).filter((d) => d.kind === 'forget');
    assert.deepEqual(traced.map((d) => [d.outcome, d.status]), [['ok', 200], ['ok', 200], ['ok', 200]]);
    assert.ok(!JSON.stringify(traced).includes('resp_stand-in') && !JSON.stringify(traced).includes(KEY));
  } finally {
    await c.s.close();
  }
});

test("switching keep off deletes all of that ability's stored responses; switched back on, a chain starts afresh", async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 2);
    await c.talk(c.tripB, 1);
    await c.switchOff();
    assert.deepEqual(await c.llm.forgetEndpoint(`${c.id}/chat`), { queued: 3 });
    await c.llm.drainKept();
    assert.deepEqual(c.s.stored(), []);
    assert.equal(c.s.deleted().length, 3);
    // Off, a turn is sent whole and stored nowhere.
    await c.talk(c.tripA, 1);
    assert.deepEqual([c.s.bodies().at(-1).store, c.s.bodies().at(-1).previous_response_id], [false, undefined]);
    assert.deepEqual(c.s.stored(), []);
    await c.switchOff(true);
    await c.talk(c.tripA, 1);
    assert.deepEqual([c.s.bodies().at(-1).store, c.s.bodies().at(-1).previous_response_id], [true, undefined]);
  } finally {
    await c.s.close();
  }
});

test("Erase deletes every stored response first, and says what is left; offline, the deletions wait", async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 1);
    await c.talk(c.tripB, 1);
    assert.deepEqual(await c.llm.forgetAll({ timeoutMs: 10_000 }), { left: 0 });
    assert.deepEqual(c.s.stored(), []);
    await c.talk(c.tripA, 1);
    assert.deepEqual(c.s.stored(), [], 'Erase lasts: a turn answered after it is deleted at once');
  } finally {
    await c.s.close();
  }
  const off = await serviceKit();
  try {
    await off.talk(off.tripA, 1);
    off.net.online = false;
    assert.deepEqual(await off.llm.forgetAll({ timeoutMs: 200 }), { left: 1 });
    off.net.online = true;
    assert.deepEqual(await off.llm.drainKept(), { done: 1, left: 0 });
    assert.deepEqual(off.s.stored(), []);
  } finally {
    await off.s.close();
  }
});

test('removing the provider deletes its stored responses first, while its key is there', async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 2);
    await c.llm.removeProvider(c.id);
    assert.deepEqual(c.s.stored(), []);
    assert.equal(c.s.deleted().length, 2);
  } finally {
    await c.s.close();
  }
});

test('a response deleted by OpenAI already (30 days) is a 404 on delete: done, not waiting', async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 2);
    c.s.expire();
    await c.llm.forgetEndpoint(`${c.id}/chat`);
    await c.llm.drainKept();
    assert.equal(c.s.seen.filter((x) => x.method === 'DELETE').length, 2, 'asked for each');
    assert.deepEqual(c.s.deleted(), [], 'and gone already');
    assert.deepEqual(await c.llm.keptCount(), { turns: 0, waiting: 0, days: 0, who: [] });
  } finally {
    await c.s.close();
  }
});

test("OpenAI's retention is 'at least 30 days': each response is tracked 35 days, and a chain is continued 29 days from its first turn", async () => {
  assert.deepEqual(type.keeps, { name: 'OpenAI', provider: 'provider-openai', days: 35, hours: 29 * 24, holds: 'at least 30 days', note: type.keeps.note, perModel: true, minLife: 10 * 60_000 });
  assert.match(type.keeps.note, /dashboard/);
  const c = await callKit([{ text: 'A' }]);
  try {
    await c.call([m1]);
    const t = (await c.file()).turns[0];
    assert.ok(Math.abs(t.until - (Date.now() + 35 * DAY)) < 10_000);
    assert.ok(Math.abs(t.ends - (Date.now() + 29 * DAY)) < 10_000);
  } finally {
    await c.s.close();
  }
});

// ---- The fix pass: the review's probes, and what followed ----

test('the default is off: OpenAI\'s own chat ability turns it on, and a custom Responses record of any version keeps nothing until switched on', async () => {
  assert.equal(type.tunables.keep, false);
  const o = JSON.parse(await readFile(new URL('../../plugins-official/provider-openai/annai-plugin.json', import.meta.url), 'utf8'));
  assert.equal(o.provider.abilities.chat.tunables.keep, true);
  // An older record, with no keep in it: off.
  const old = await callKit([{ text: 'A' }], {});
  try {
    const r = await old.call([m1]);
    await old.call([...said([m1], r), msg('user', text('More?'))]);
    assert.deepEqual(old.s.bodies().map((b) => [b.store, b.previous_response_id]), [[false, undefined], [false, undefined]]);
  } finally {
    await old.s.close();
  }
  // The custom provider, as its description makes it, with Responses switched on: off until the user switches keeping on.
  const d = JSON.parse(await readFile(new URL('../../plugins-official/provider-another-address/annai-plugin.json', import.meta.url), 'utf8'));
  const s = await startOpenAIServer({ key: KEY, replies: [{ text: 'A' }] });
  try {
    const cfg = /** @type {any} */ ({
      providers: { 'pv-c': { id: 'pv-c', plugin: 'provider-another-address', template: { values: d.provider }, user: { name: 'My server', baseUrl: s.url, abilities: { responses: { on: true } } }, created: 0 } },
      models: { 'm-c': { id: 'm-c', provider: 'pv-c', ability: 'responses', template: null, user: { providerId: MODEL, input: ['text'] }, created: 0 } },
      roles: { main: { models: ['m-c'], level: 'off' } },
    });
    const store = createMemoryStore();
    const ws = new Workspace(store);
    await ensureBaseScopes(ws);
    const kept = new Kept({ ws });
    const call = (/** @type {any[]} */ messages, /** @type {any} */ over = cfg) => callRole({ role: 'main', config: over, types: new Map([['openai-responses', type]]), bench: new Bench(), keyFor: async () => KEY, kept, scope: 'trip-a', record: { keepParts: true }, request: { messages, tail: 'now' } });
    const r = await call([m1]);
    await call([...said([m1], r), msg('user', text('More?'))]);
    assert.deepEqual(s.bodies().map((b) => [b.store, b.previous_response_id]), [[false, undefined], [false, undefined]]);
    const on = structuredClone(cfg);
    on.providers['pv-c'].user.abilities.responses.tunables = { keep: true };
    await call([...said([m1], r), msg('user', text('Again?'))], on);
    await call([...said([...said([m1], r), msg('user', text('Again?'))], r), msg('user', text('And?'))], on);
    assert.deepEqual(s.bodies().slice(2).map((b) => [b.store, b.previous_response_id]), [[true, undefined], [true, 'resp_stand-in-3']]);
  } finally {
    await s.close();
  }
});

test('warm housekeeping borrows the live chain: it carries previous_response_id and only what is new, its response is deleted, and the next real turn goes on from the last real one', async () => {
  const c = await callKit([{ text: 'A' }, { text: 'B' }, { text: 'Summary.' }, { text: 'C' }]);
  try {
    let m = [msg('user', text('q0'))];
    for (let i = 1; i <= 2; i++) {
      const r = await c.call(m);
      m = [...said(m, r), msg('user', text(`q${i}`))];
    }
    const housekeeping = { record: { tag: 'compaction' }, borrow: true, request: { messages: m, system: 'You are Shiori.', tail: '[annai: housekeeping] Summarize.', tools: [TOOL] } };
    const h = await c.call(m, housekeeping);
    assert.equal(h.reply.text, 'Summary.');
    const hb = c.s.bodies()[2];
    assert.deepEqual([hb.store, hb.previous_response_id], [true, 'resp_stand-in-2']);
    assert.deepEqual(hb.input, [{ role: 'user', content: [{ type: 'input_text', text: 'q2' }] }, { role: 'developer', content: '[annai: housekeeping] Summarize.' }], 'only the new message and the summary request');
    assert.deepEqual(c.s.deleted(), ['resp_stand-in-3'], 'its response is deleted at once');
    assert.deepEqual(c.s.stored(), ['resp_stand-in-1', 'resp_stand-in-2']);
    assert.deepEqual((await c.file()).turns.map((/** @type {any} */ t) => t.id), ['resp_stand-in-1', 'resp_stand-in-2'], 'recorded nothing');
    // The real turn goes on from the last real one, not from the housekeeping.
    await c.call(m);
    assert.equal(c.s.bodies()[3].previous_response_id, 'resp_stand-in-2');
    assert.deepEqual((await c.requests()).filter((q) => q.kind === 'forget').length, 1, 'the deletion is in the trace');
  } finally {
    await c.s.close();
  }
  // No live chain (a fresh conversation, or another model): the whole conversation, stored nowhere.
  const fresh = await callKit([{ text: 'Summary.' }]);
  try {
    await fresh.call([msg('user', text('q0'))], { record: { tag: 'compaction' }, borrow: true });
    const cfg = /** @type {any} */ ({ ...fresh.cfg, roles: { ...fresh.cfg.roles, main: { models: ['m-p'], level: 'off' } } });
    await fresh.call([msg('user', text('q0'))], { record: {}, config: cfg });
    assert.deepEqual(fresh.s.bodies().map((b) => [b.store, b.previous_response_id]), [[false, undefined], [false, undefined]]);
    assert.deepEqual(fresh.s.seen.filter((x) => x.method === 'DELETE'), []);
  } finally {
    await fresh.s.close();
  }
});

test('warm housekeeping after a chain of three turns shares the whole stored prefix: the cache is not broken (P7)', async () => {
  const c = await callKit([{ text: 'A' }]);
  try {
    let m = [msg('user', text('q0'))];
    for (let i = 1; i <= 3; i++) {
      const r = await c.call(m);
      m = [...said(m, r), msg('user', text(`q${i}`))];
    }
    await c.call(m, { record: { tag: 'compaction' }, borrow: true, request: { messages: m, system: 'You are Shiori.', tail: '[annai: housekeeping] Summarize.', tools: [] } });
    const b = c.s.bodies().at(-1);
    assert.equal(b.previous_response_id, 'resp_stand-in-3');
    assert.equal(b.input.length, 2);
  } finally {
    await c.s.close();
  }
});

test('P2: a chained call refused for a photo whose upload is gone is sent whole once, the chain it continued is queued for deletion, and the next turn goes on', async () => {
  const gone = { error: { status: 400, body: { error: { message: 'Error while downloading file-abc: file not found.', type: 'invalid_request_error', param: 'input', code: 'image_file_not_found' } } } };
  const c = await callKit([(b) => (b.previous_response_id === 'resp_stand-in-1' ? gone : { text: 'A' })]);
  const uploads = { isOff: () => true, forget: async () => {}, get: async () => null };
  try {
    const r = await c.call([m1], { uploads });
    const m2 = [...said([m1], r), msg('user', text('q1'))];
    const again = await c.call(m2, { uploads });
    assert.equal(again.reply.text, 'A');
    assert.deepEqual(again.attempts.map((a) => a.outcome), ['upload', 'ok']);
    assert.deepEqual(c.s.bodies().map((b) => b.previous_response_id), [undefined, 'resp_stand-in-1', undefined]);
    assert.deepEqual((await c.file()).forget.map((/** @type {any} */ d) => d.id), ['resp_stand-in-1'], 'the old chain is queued for deletion');
    await c.call([...said(m2, again), msg('user', text('q2'))], { uploads });
    assert.equal(c.s.bodies().at(-1).previous_response_id, 'resp_stand-in-2', 'the new chain goes on');
  } finally {
    await c.s.close();
  }
});

/** A files endpoint for the stand-in: every upload expires in 48 hours. @param {{ n: number }} count */
const filesFetch = (count) => (/** @type {any} */ url, /** @type {any} */ init) => {
  if (String(url).endsWith('/files')) {
    count.n++;
    return Promise.resolve(new Response(JSON.stringify({ id: `file-${count.n}`, object: 'file', expires_at: Math.floor(Date.now() / 1000) + 172800 }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  return globalThis.fetch(url, init);
};
const PHOTO = (/** @type {string} */ h) => ({ type: 'image', mediaType: 'image/png', data: Buffer.from(`a photo ${h}`).toString('base64'), hash: h.repeat(64).slice(0, 64) });

test('a chain ends before the earliest photo it points at expires, and the end is carried down the chain', async () => {
  const c = await callKit([{ text: 'A' }]);
  const uploads = new Uploads(c.ws);
  const count = { n: 0 };
  const fetch = filesFetch(count);
  try {
    const m = [msg('user', text('what is this?'), PHOTO('a'))];
    const r = await c.call(m, { fetch, uploads });
    const expires = Date.now() + 172_800_000;
    const first = (await c.file()).turns[0];
    assert.ok(Math.abs(first.ends - (expires - 3_600_000)) < 5000, 'an hour before the photo expires');
    const m2 = [...said(m, r), msg('user', text('and the price?'))];
    const r2 = await c.call(m2, { fetch, uploads });
    const second = (await c.file()).turns.find((/** @type {any} */ t) => t.id === 'resp_stand-in-2');
    assert.equal(second.ends, first.ends, 'carried');
    // Past it, the conversation goes whole.
    const late = Date.now;
    Date.now = () => late() + 47.5 * 3_600_000;
    try {
      await c.call([...said(m2, r2), msg('user', text('and the hours?'))], { fetch, uploads });
    } finally {
      Date.now = late;
    }
    assert.equal(c.s.bodies().at(-1).previous_response_id, undefined);
  } finally {
    await c.s.close();
  }
});

test('P8: a chained turn uploads nothing for photos it does not send; a new photo in what it sends is uploaded', async () => {
  const c = await callKit([{ text: 'A' }]);
  const uploads = new Uploads(c.ws);
  const count = { n: 0 };
  const fetch = filesFetch(count);
  try {
    const m = [msg('user', text('what is this?'), PHOTO('a'))];
    const r = await c.call(m, { fetch, uploads });
    assert.equal(count.n, 1);
    await uploads.forget('pv-o/chat'); // its upload is about to expire: it would be uploaded again
    const m2 = [...said(m, r), msg('user', text('and the price?'))];
    const r2 = await c.call(m2, { fetch, uploads });
    assert.equal(count.n, 1, 'the earlier photo is not sent, so not uploaded');
    assert.ok(!JSON.stringify(c.s.bodies().at(-1).input).includes('input_image'));
    const m3 = [...said(m2, r2), msg('user', text('this one?'), PHOTO('b'))];
    await c.call(m3, { fetch, uploads });
    assert.equal(count.n, 2);
    assert.match(JSON.stringify(c.s.bodies().at(-1).input), /"file_id":"file-2"/);
    // Whole (an edit), every photo is sent, so every photo is uploaded.
    await c.call([msg('user', text('edited'), PHOTO('a')), ...m3.slice(1)], { fetch, uploads });
    assert.equal(c.s.bodies().at(-1).previous_response_id, undefined);
    assert.ok(count.n >= 3);
  } finally {
    await c.s.close();
  }
});

test('P1: an organization with Zero Data Retention: the response says it is not stored, so nothing is chained, nothing fails, nothing is deleted', async () => {
  const c = await callKit([{ text: 'A' }], { keep: true }, { zdr: true });
  try {
    let m = [msg('user', text('q0'))];
    for (let i = 1; i <= 3; i++) {
      const r = await c.call(m);
      m = [...said(m, r), msg('user', text(`q${i}`))];
    }
    assert.deepEqual((await c.requests()).map((q) => q.outcome), ['ok', 'ok', 'ok']);
    assert.ok(c.s.bodies().every((b) => b.previous_response_id === undefined));
    assert.deepEqual(c.s.seen.filter((x) => x.method === 'DELETE'), []);
    assert.deepEqual(await c.kept.count(), { turns: 0, waiting: 0, until: 0, endpoints: [] });
  } finally {
    await c.s.close();
  }
});

test('P3: the response id is written down as soon as OpenAI names it, and replaced when the turn ends', async () => {
  const c = await callKit([{ text: 'A', delayMs: 400 }]);
  try {
    const p = c.call([m1]);
    await new Promise((r) => setTimeout(r, 200));
    const mid = await c.file();
    assert.deepEqual(mid.pending.map((/** @type {any} */ x) => [x.id, x.endpoint, x.scope]), [['resp_stand-in-1', 'pv-o/chat', 'trip-a']]);
    assert.ok(!JSON.stringify(mid).includes(KEY));
    await p;
    const end = await c.file();
    assert.deepEqual(end.pending, []);
    assert.deepEqual(end.turns.map((/** @type {any} */ t) => t.id), ['resp_stand-in-1']);
  } finally {
    await c.s.close();
  }
});

test('P3: a pending response older than a call can last is queued for deletion at the next drain; a recent one is left', async () => {
  const c = await serviceKit();
  try {
    const [old, recent] = [await c.orphan(3_600_000), await c.orphan(5_000)];
    const llm2 = c.restart();
    await llm2.drainKept();
    assert.deepEqual(c.s.deleted(), [old]);
    assert.deepEqual(c.s.stored(), [recent]);
  } finally {
    await c.s.close();
  }
});

test('Erase: a pending id left by a page killed mid-turn under 15 minutes ago is counted in the warning and deleted before the wipe', async () => {
  const c = await serviceKit();
  try {
    const rid = await c.orphan();
    const llm2 = c.restart();
    await llm2.drainKept();
    assert.equal((await llm2.keptCount()).turns, 1, 'the warning counts it');
    assert.ok(c.s.stored().includes(rid), 'a drain leaves it: its call might still be answering');
    assert.deepEqual(await llm2.forgetAll({ timeoutMs: 5000 }), { left: 0 });
    assert.ok(!c.s.stored().includes(rid));
    assert.deepEqual(c.s.deleted(), [rid]);
  } finally {
    await c.s.close();
  }
});

test('Erase while a borrowed housekeeping call is still running: its response is deleted before the wipe, not only pending', async () => {
  const c = await serviceKit({ replies: [(b) => (JSON.stringify(b.input).includes('housekeeping') ? { text: 'Summary', delayMs: 9000 } : { text: 'A' })] });
  try {
    const r1 = await c.llm.call({ role: 'main', scope: c.tripA, request: { messages: [msg('user', text('q0'))], tail: 'now' }, record: { keepParts: true } });
    const m = [...said([msg('user', text('q0'))], r1), msg('user', text('q1'))];
    const hk = c.llm.call({ role: 'main', scope: c.tripA, request: { messages: m, tail: '[annai: housekeeping] Summarize.' }, borrow: true, record: { tag: 'compaction' } });
    hk.catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(await c.llm.forgetAll({ timeoutMs: 3000 }), { left: 0 });
    assert.deepEqual(c.s.stored(), [], 'nothing of it is left at OpenAI');
  } finally {
    await c.s.close();
  }
});

test('removing the provider, or a new key, deletes a pending id too; the words before the tap count it', async () => {
  const c = await serviceKit();
  try {
    const rid = await c.orphan();
    const llm2 = c.restart();
    await llm2.drainKept();
    assert.equal((await llm2.keptCount({ provider: c.id })).turns, 1);
    await llm2.removeProvider(c.id);
    assert.ok(!c.s.stored().includes(rid));
    assert.deepEqual(c.s.deleted(), [rid]);
  } finally {
    await c.s.close();
  }
});

test('P6: a server that drops previous_response_id is noticed from what it echoes: the turn is sent whole, the stray response deleted, and keeping stays off for that endpoint', async () => {
  const c = await callKit([(b) => ({ text: `saw ${b.input.filter((/** @type {any} */ x) => x.role === 'user').length} user message(s)` })]);
  const fetch = (/** @type {any} */ url, /** @type {any} */ init) => {
    if (init?.method !== 'POST' || !init.body) return globalThis.fetch(url, init);
    const { previous_response_id: _, ...rest } = JSON.parse(init.body);
    return globalThis.fetch(url, { ...init, body: JSON.stringify(rest) });
  };
  try {
    let m = [msg('user', text('q0'))];
    let r = await c.call(m, { fetch });
    m = [...said(m, r), msg('user', text('q1'))];
    r = await c.call(m, { fetch });
    assert.equal(r.reply.text, 'saw 2 user message(s)', 'the conversation was sent whole');
    assert.deepEqual(r.attempts.map((a) => a.outcome), ['forgotten', 'ok']);
    const noticed = (await c.requests()).find((q) => q.outcome === 'forgotten');
    assert.match(noticed.error, /ignored the conversation/i);
    assert.deepEqual(c.s.deleted(), ['resp_stand-in-2'], 'the response that had no conversation behind it');
    // From now on, until annai starts again: whole, and stored nowhere.
    m = [...said(m, r), msg('user', text('q2'))];
    await c.call(m, { fetch });
    assert.deepEqual([c.s.bodies().at(-1).store, c.s.bodies().at(-1).previous_response_id], [false, undefined]);
    // The first turn, which the proxy dropped the chain from, is still at OpenAI: annai still knows it, and deletes it.
    await c.kept.queue();
    await c.kept.drain({ fetch: globalThis.fetch, resolve: async () => /** @type {any} */ ({ type, endpoint: { baseUrl: c.s.url, headers: {} }, key: KEY, print: await keyPrint(KEY, c.s.url) }) });
    assert.deepEqual(c.s.stored(), [], 'nothing is left at OpenAI');
  } finally {
    await c.s.close();
  }
});

test("a stream with no response.created: the id is learned from response.completed, so the turn can be continued and deleted", async () => {
  const c = await callKit([{ text: 'A' }]);
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    const res = await globalThis.fetch(url, init);
    if (init?.method !== 'POST') return res;
    const blocks = (await res.text()).split('\n\n').filter((b) => !/^event: response\.(created|in_progress)/.test(b));
    return new Response(blocks.join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const r = await c.call([m1], { fetch });
    await c.call([...said([m1], r), msg('user', text('More?'))], { fetch });
    assert.equal(c.s.bodies()[1].previous_response_id, 'resp_stand-in-1');
  } finally {
    await c.s.close();
  }
});

test('a whole reply that failed still names its response first, so the call can delete it', async () => {
  const events = [];
  /** @type {any} */
  let error = null;
  try {
    for await (const e of type.read(new Response(JSON.stringify({ id: 'resp_failed', object: 'response', status: 'failed', error: { code: 'server_error', message: 'boom' }, output: [] }), { headers: { 'content-type': 'application/json' } }), { keep: true })) events.push(e);
  } catch (e) {
    error = e;
  }
  assert.deepEqual(events, [{ type: 'kept', id: 'resp_failed' }]);
  assert.equal(error?.kind, 'server');
});

test('a keyless endpoint keeps nothing: it could not delete what it stored', async () => {
  const c = await callKit([{ text: 'A' }], { keep: true }, { anyKey: true });
  try {
    const r = await c.call([m1], { keyFor: async () => null });
    await c.call([...said([m1], r), msg('user', text('More?'))], { keyFor: async () => null });
    assert.deepEqual(c.s.bodies().map((b) => [b.store, b.previous_response_id]), [[false, undefined], [false, undefined]]);
    assert.deepEqual(c.s.seen.filter((x) => x.method === 'DELETE'), []);
  } finally {
    await c.s.close();
  }
});

test("the provider's own name and words, unless it is OpenAI's own provider; OpenAI's note about its dashboard", () => {
  assert.deepEqual(keeperOf(type.keeps, 'provider-openai', 'OpenAI'), { name: 'OpenAI', holds: 'at least 30 days', note: type.keeps.note });
  assert.deepEqual(keeperOf(type.keeps, 'provider-another-address', 'My server'), { name: 'My server', holds: 'as long as that server keeps them', note: '' });
  assert.deepEqual(keeperOf({ name: 'Google', days: 55, hours: 23 }, 'provider-gemini', 'Google Gemini'), { name: 'Google', holds: null, note: '' });
  assert.deepEqual(keeperOf(undefined, 'x', 'Y'), { name: 'Y', holds: null, note: '' });
});

test("P4: a missing response's id, which OpenAI repeats in its error, is not in the trace", async () => {
  const c = await callKit([{ text: 'A' }]);
  try {
    const r = await c.call([m1]);
    c.s.expire();
    await c.call([...said([m1], r), msg('user', text('q1'))]);
    const turns = (await c.store.tx(['events'], 'readonly', (t) => t.listEvents('trip-a', { types: ['model.turn'] }))).map((e) => e.data);
    const traced = JSON.stringify([await c.requests(), turns]);
    assert.ok(!traced.includes('resp_stand-in-1'));
    assert.ok(traced.includes('forgotten'), 'but what happened is');
  } finally {
    await c.s.close();
  }
});

test('the key print covers the extra headers: another project or organization keeps nothing of the first\'s', async () => {
  const plain = (await sha256Hex('https://x.test/v1\nsk-1')).slice(0, 16);
  assert.equal(await keyPrint('sk-1', 'https://x.test/v1/'), plain, 'as before without headers');
  assert.equal(await keyPrint('sk-1', 'https://x.test/v1/', {}), plain);
  const a = await keyPrint('sk-1', 'https://x.test/v1', { 'OpenAI-Project': 'proj_a' });
  assert.notEqual(a, plain);
  assert.notEqual(a, await keyPrint('sk-1', 'https://x.test/v1', { 'OpenAI-Project': 'proj_b' }));
  assert.equal(a, await keyPrint('sk-1', 'https://x.test/v1', { 'openai-project': 'proj_a' }), 'a header name is any case');
  const c = await callKit([{ text: 'A' }], { keep: true }, { headers: { 'OpenAI-Project': 'proj_a' } });
  try {
    const r = await c.call([m1]);
    const next = [...said([m1], r), msg('user', text('More?'))];
    await c.call(next);
    assert.equal(c.s.bodies()[1].previous_response_id, 'resp_stand-in-1', 'the same project');
    await c.call(next, { config: config(c.s.url, { keep: true }, MODEL, { 'OpenAI-Project': 'proj_b' }) });
    assert.equal(c.s.bodies()[2].previous_response_id, undefined, 'another project: whole');
  } finally {
    await c.s.close();
  }
});

test('reasoning: a reasoning turn is stored with its encrypted item; the chained turn after it sends none; a whole send carries it back', async () => {
  const c = await callKit([{ reasoning: { summary: '**Looking**', encrypted: 'gAAAAABenc' }, text: 'A' }, { text: 'B' }]);
  try {
    const r = await c.call([m1]);
    assert.ok(r.reply.parts.some((/** @type {any} */ p) => p.type === 'reasoning' && p.signature));
    const m2 = [...said([m1], r), msg('user', text('More?'))];
    await c.call(m2);
    const [, b2] = c.s.bodies();
    assert.equal(b2.previous_response_id, 'resp_stand-in-1');
    assert.ok(!JSON.stringify(b2.input).includes('reasoning'), 'OpenAI holds it');
    await c.call([msg('user', text('Where else?')), ...m2.slice(1)]); // an edit: whole
    const b3 = c.s.bodies()[2];
    assert.equal(b3.previous_response_id, undefined);
    assert.ok(b3.input.some((/** @type {any} */ x) => x.type === 'reasoning' && x.encrypted_content === 'gAAAAABenc'));
    assert.equal(b3.store, true);
  } finally {
    await c.s.close();
  }
});

test('a response that was there minutes ago and is gone means the server is not storing (Zero Data Retention, unannounced): nothing is kept there from then on, and the Trace says so; one gone after an hour is just expired', async () => {
  const c = await callKit([{ text: 'A' }]);
  try {
    const r = await c.call([m1]);
    c.s.expire(); // gone within minutes
    const m2 = [...said([m1], r), msg('user', text('q1'))];
    const again = await c.call(m2);
    assert.deepEqual(again.attempts.map((a) => a.outcome), ['forgotten', 'ok']);
    const said1 = (await c.requests()).find((q) => q.kind === 'look');
    assert.match(said1.error, /not storing/i);
    assert.match(said1.error, /Zero Data Retention/);
    await c.call([...said(m2, again), msg('user', text('q2'))]);
    assert.deepEqual([c.s.bodies().at(-1).store, c.s.bodies().at(-1).previous_response_id], [false, undefined]);
  } finally {
    await c.s.close();
  }
  const later = await callKit([{ text: 'A' }]);
  try {
    const r = await later.call([m1]);
    later.clock.skew = 3_600_000;
    later.s.expire();
    const m2 = [...said([m1], r), msg('user', text('q1'))];
    const again = await later.call(m2);
    await later.call([...said(m2, again), msg('user', text('q2'))]);
    assert.deepEqual([later.s.bodies().at(-1).store, later.s.bodies().at(-1).previous_response_id], [true, 'resp_stand-in-2'], 'keeping goes on');
  } finally {
    await later.s.close();
  }
});

test("warm housekeeping in the agent's real shape: the conversation ends with the last reply, and the borrow continues that very turn, sending only the summary request", async () => {
  const c = await callKit([{ text: 'A' }, { text: 'B' }, { text: 'Summary.' }]);
  try {
    let m = [msg('user', text('q0'))];
    const r1 = await c.call(m);
    m = said(m, r1); // [q0, A]: one turn in the chain
    const hk = (/** @type {any[]} */ messages) => c.call(messages, { record: { tag: 'compaction' }, borrow: true, request: { messages, system: 'S', tail: '[annai: housekeeping] Summarize.' } });
    await hk(m);
    const b1 = c.s.bodies().at(-1);
    assert.deepEqual([b1.store, b1.previous_response_id], [true, 'resp_stand-in-1']);
    assert.deepEqual(b1.input, [{ role: 'developer', content: '[annai: housekeeping] Summarize.' }], 'only the summary request');
    m = [...m, msg('user', text('q1'))];
    const r2 = await c.call(m);
    m = said(m, r2);
    await hk(m);
    const b2 = c.s.bodies().at(-1);
    assert.equal(b2.previous_response_id, (await c.file()).turns.at(-1).id);
    assert.equal(b2.input.length, 1);
    assert.deepEqual(c.s.stored(), (await c.file()).turns.map((/** @type {any} */ t) => t.id), 'its own response is deleted');
    // A real turn never matches a conversation with nothing new after the reply.
    await c.call(m);
    assert.equal(c.s.bodies().at(-1).previous_response_id, 'resp_stand-in-1', 'a real turn goes after an earlier turn, never the one with nothing after its reply');
  } finally {
    await c.s.close();
  }
});

test("a new response's id is registered as a secret the moment it is named: an error that repeats it does not put it in the Trace", async () => {
  const c = await callKit([{ text: 'A' }]);
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    const res = await globalThis.fetch(url, init);
    if (init?.method !== 'POST') return res;
    const body = await res.text();
    const cut = body.slice(0, body.indexOf('event: response.output_item.added'));
    return new Response(`${cut}event: error\ndata: {"type":"error","code":"invalid_prompt","message":"Response resp_stand-in-1 was blocked.","sequence_number":3}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    await assert.rejects(c.call([m1], { fetch }));
    const turns = (await c.store.tx(['events'], 'readonly', (t) => t.listEvents('trip-a', { types: ['model.turn'] }))).map((e) => e.data);
    const traced = JSON.stringify([await c.requests(), turns]);
    assert.ok(!traced.includes('resp_stand-in-1'));
    assert.ok(traced.includes('was blocked'));
  } finally {
    await c.s.close();
  }
});

/** A reply that refuses a chained request as "not found" the first n times, as an intermittent error does. */
const flaky = (/** @type {{ n: number }} */ left, /** @type {number} */ status = 400) => (/** @type {any} */ b) => (b.previous_response_id && left.n-- > 0
  ? { error: { status, body: { error: { message: `Previous response with id '${b.previous_response_id}' not found.`, type: 'invalid_request_error', param: 'previous_response_id', code: 'previous_response_not_found' } } } }
  : { text: 'A' });

test('a "not found" right after storing that is passing (the response is there when looked up): the chained call is tried once more, and keeping goes on', async () => {
  const left = { n: 1 };
  const c = await callKit([flaky(left)]);
  try {
    let m = [msg('user', text('q0'))];
    for (let i = 1; i <= 3; i++) {
      const r = await c.call(m);
      m = [...said(m, r), msg('user', text(`q${i}`))];
    }
    assert.deepEqual(c.s.bodies().map((b) => [b.store, b.previous_response_id ?? null]), [[true, null], [true, 'resp_stand-in-1'], [true, 'resp_stand-in-1'], [true, 'resp_stand-in-2']], 'the same chained call again, and the chain goes on');
    const look = c.s.seen.filter((x) => x.method === 'GET');
    assert.deepEqual(look.map((x) => x.url), ['/v1/responses/resp_stand-in-1']);
    assert.equal(look[0].headers.authorization, `Bearer ${KEY}`);
    assert.ok((await c.requests()).some((q) => q.kind === 'look' && q.status === 200));
    assert.ok(!JSON.stringify(await c.requests()).includes('resp_stand-in-1'), 'its id is not in the Trace');
  } finally {
    await c.s.close();
  }
});

test('a "not found" that keeps coming while the response is there is sent whole after one more try, and no more', async () => {
  const left = { n: 99 };
  const c = await callKit([flaky(left)]);
  try {
    const r = await c.call([m1]);
    const again = await c.call([...said([m1], r), msg('user', text('q1'))]);
    assert.deepEqual(again.attempts.map((a) => a.outcome), ['forgotten', 'forgotten', 'ok']);
    assert.deepEqual(c.s.bodies().map((b) => b.previous_response_id ?? null), [null, 'resp_stand-in-1', 'resp_stand-in-1', null]);
  } finally {
    await c.s.close();
  }
});

test('a "not found" for a response that is not there when looked up was never stored: keeping goes off, and the Trace says so', async () => {
  const left = { n: 1 };
  const c = await callKit([flaky(left)]);
  try {
    const r = await c.call([m1]);
    c.s.expire();
    const again = await c.call([...said([m1], r), msg('user', text('q1'))]);
    assert.deepEqual(again.attempts.map((a) => a.outcome), ['forgotten', 'ok']);
    const reqs = await c.requests();
    assert.ok(reqs.some((q) => q.kind === 'look' && q.status === 404));
    assert.match(reqs.find((q) => q.kind === 'look').error, /Zero Data Retention/, 'said where it was found');
    assert.match(again.attempts[0].error ?? '', /Zero Data Retention/);
    assert.equal(c.s.bodies().at(-1).store, false);
  } finally {
    await c.s.close();
  }
});

test('aborting during a photo upload is a cancelled call, not a plugin failure: the model is not benched', async () => {
  const c = await callKit([{ text: 'A' }]);
  const ac = new AbortController();
  const fetch = (/** @type {any} */ url, /** @type {any} */ init) => {
    if (String(url).endsWith('/files')) {
      setTimeout(() => ac.abort(), 30);
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return globalThis.fetch(url, init);
  };
  const bench = new Bench();
  const cfg = /** @type {any} */ (structuredClone(c.cfg));
  cfg.models['m-o'].user.input = ['text', 'image'];
  try {
    const e = await callRole({ role: 'main', config: cfg, types: new Map([['openai-responses', type]]), bench, keyFor: async () => KEY, kept: c.kept, scope: 'trip-a', record: { keepParts: true },
      uploads: new Uploads(c.ws), fetch, signal: ac.signal, request: { messages: [msg('user', text('look'), PHOTO('a'))], tail: 'now' } }).then(() => null, (x) => x);
    assert.equal(e?.kind, 'cancelled');
    assert.ok(bench.until('m-o') <= Date.now(), 'not benched');
  } finally {
    await c.s.close();
  }
});

test('a stop while the look-up is out ends it at once: the call is not left to wait for the look-up\'s own time limit, and no retry follows', async () => {
  const left = { n: 1 };
  const c = await callKit([flaky(left)]);
  const ac = new AbortController();
  const fetch = (/** @type {any} */ url, /** @type {any} */ init) => {
    if (init?.method !== 'GET') return globalThis.fetch(url, init);
    setTimeout(() => ac.abort(), 40);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => globalThis.fetch(url, init).then(resolve, reject), 3000); // a slow look-up
      init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
    });
  };
  try {
    const r = await c.call([m1]);
    const started = Date.now();
    const e = await c.call([...said([m1], r), msg('user', text('q1'))], { fetch, signal: ac.signal }).then(() => null, (x) => x);
    assert.ok(Date.now() - started < 1500, `ended in ${Date.now() - started} ms`);
    assert.equal(e?.kind, 'cancelled');
    assert.equal(c.s.bodies().length, 2, 'no request after the stop');
  } finally {
    await c.s.close();
  }
});

test("a deadline that passes while a photo uploads is a stop (cancelled), not a time-out that rests the model", async () => {
  const c = await callKit([{ text: 'A' }]);
  const signal = AbortSignal.timeout(40);
  const fetch = (/** @type {any} */ url, /** @type {any} */ init) => (String(url).endsWith('/files')
    ? new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)))
    : globalThis.fetch(url, init));
  const bench = new Bench();
  const cfg = /** @type {any} */ (structuredClone(c.cfg));
  cfg.models['m-o'].user.input = ['text', 'image'];
  try {
    const e = await callRole({ role: 'main', config: cfg, types: new Map([['openai-responses', type]]), bench, keyFor: async () => KEY, kept: c.kept, scope: 'trip-a', record: { keepParts: true },
      uploads: new Uploads(c.ws), fetch, signal, request: { messages: [msg('user', text('look'), PHOTO('a'))], tail: 'now' } }).then(() => null, (x) => x);
    assert.equal(e?.kind, 'cancelled');
    assert.ok(bench.until('m-o') <= Date.now(), 'not benched');
  } finally {
    await c.s.close();
  }
});

test("the look-up registers the key as a secret itself, as a deletion does", async () => {
  /** @type {string[]} */
  const secrets = [];
  const trace = /** @type {any} */ ({ secret: (/** @type {string} */ k) => secrets.push(k), request: async () => {} });
  const found = await lookTurn({ type, endpoint: /** @type {any} */ ({ baseUrl: 'https://api.openai.com/v1', name: 'OpenAI', headers: {} }), key: 'sk-look', id: 'resp_1', fetch: async () => new Response('{}', { status: 200 }), trace, now: Date.now });
  assert.equal(found, 'there');
  assert.deepEqual(secrets, ['sk-look']);
});

test("the Trace reads in order: the failed call's own line, then the look-up it led to", async () => {
  const left = { n: 1 };
  const c = await callKit([flaky(left)]);
  try {
    const r = await c.call([m1]);
    await c.call([...said([m1], r), msg('user', text('q1'))]);
    const lines = (await c.requests()).map((q) => [q.kind, q.outcome]);
    assert.deepEqual(lines, [['model', 'ok'], ['model', 'forgotten'], ['look', 'ok'], ['model', 'ok']]);
  } finally {
    await c.s.close();
  }
});
