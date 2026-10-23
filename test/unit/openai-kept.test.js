import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { Kept } from '../../src/core/llm/kept.js';
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
const config = (url, tunables = {}, providerId = MODEL) => /** @type {any} */ ({
  providers: { 'pv-o': { id: 'pv-o', plugin: 'provider-openai', template: null, user: { name: 'OpenAI', baseUrl: url, abilities: { chat: { kind: 'chat', type: 'openai-responses', tunables } } }, created: 0 } },
  models: { 'm-o': { id: 'm-o', provider: 'pv-o', ability: 'chat', template: null, user: { providerId, input: ['text', 'image'] }, created: 0 }, 'm-p': { id: 'm-p', provider: 'pv-o', ability: 'chat', template: null, user: { providerId: 'gpt-6-sol', input: ['text'] }, created: 0 } },
  roles: { main: { models: ['m-o'], level: 'off' }, utility: { models: ['m-o'], level: 'off' } },
});

/** A Kept on memory storage, with calls through callRole. @param {any[]} replies @param {Record<string, any>} [tunables] @param {{ notFoundStatus?: number }} [o] */
async function callKit(replies, tunables = {}, o = {}) {
  const s = await startOpenAIServer({ key: KEY, replies, ...o });
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const kept = new Kept({ ws });
  const cfg = config(s.url, tunables);
  /** @param {any[]} messages @param {Record<string, any>} [o] */
  const call = (messages, o = {}) => callRole({
    role: 'main', config: cfg, types: new Map([['openai-responses', type]]), bench: new Bench(), keyFor: async () => KEY, kept, scope: 'trip-a',
    record: { keepParts: true }, trace: modelTrace(store, 'trip-a'), request: { messages, system: 'You are Shiori.', tail: 'Now: 12:00, Kyōto.', tools: [TOOL] }, ...o,
  });
  const requests = async () => (await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-a', { types: ['net.request'] }))).map((e) => e.data);
  return { s, store, ws, kept, cfg, call, requests, file: async () => ws.readJSON(SYS_DEVICE, '/llm/kept.json') };
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
    await c.call([more]); // Start fresh, or a compaction that put a summary in place of the past
    await c.call([msg('user', text('Summary: they asked about food.')), more]); // a compaction
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
    const c = await callKit([{ text: 'Ichiran.' }, { text: 'Yes, until 23:00.' }], {}, { notFoundStatus: status });
    try {
      const r = await c.call([m1]);
      c.s.expire(); // 30 days passed, or it was deleted
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
  const after = await run({});
  const sum = (/** @type {number[]} */ a) => a.reduce((x, y) => x + y, 0);
  assert.ok(sum(after) < sum(before) / 2, `${sum(after)} against ${sum(before)}`);
  assert.ok(after[9] < after[0] * 1.2, 'the last request is the size of the first');
  assert.ok(before[9] > before[0] * 3, 'sent whole, it grows');
  await mkdir(new URL('../../.superpowers/evidence/backlog-openai-kept/', import.meta.url), { recursive: true });
  await writeFile(new URL('../../.superpowers/evidence/backlog-openai-kept/request-sizes.json', import.meta.url), JSON.stringify({ unit: 'request body bytes, 10 turns against the stand-in', whole: before, kept: after, total: { whole: sum(before), kept: sum(after) } }, null, 2));
});

// ---- Deletions, through the service with provider-openai ----

/** The service with OpenAI added from annai's own files, at the stand-in's address, and two trips. @param {{ deleteDelay?: number }} [o] */
async function serviceKit({ deleteDelay = 0 } = {}) {
  const { hostKit } = await import('./package-kit.js');
  const { createLlm } = await import('../../src/core/llm/service.js');
  const { createTrip } = await import('../../src/core/scopes.js');
  const s = await startOpenAIServer({ key: KEY, replies: [(b) => ({ text: `Answer ${b.input.length}` })] });
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
  return { s, ...k, llm, id, tripA, tripB, talk, net, fetch, switchOff };
}

test("through the service: turns are chained per trip, counted as OpenAI keeps them (30 days), and removing a trip deletes its responses with DELETE /v1/responses/{id}", async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 3);
    await c.talk(c.tripB, 1);
    assert.deepEqual(c.s.bodies().map((b) => b.previous_response_id), [undefined, 'resp_stand-in-1', 'resp_stand-in-2', undefined]);
    assert.deepEqual(await c.llm.keptCount({ scope: c.tripA }), { turns: 3, waiting: 0, days: 30, who: ['OpenAI'] });
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

test('the custom provider offers the Responses protocol with keeping off until the user turns it on: a server that ignores previous_response_id would answer without the conversation', async () => {
  const d = JSON.parse(await readFile(new URL('../../plugins-official/provider-another-address/annai-plugin.json', import.meta.url), 'utf8'));
  assert.equal(d.provider.abilities.responses.tunables.keep, false);
  const o = JSON.parse(await readFile(new URL('../../plugins-official/provider-openai/annai-plugin.json', import.meta.url), 'utf8'));
  assert.equal(o.provider.abilities.chat.tunables?.keep, undefined, "OpenAI's own: on, the type's default");
  assert.equal(type.tunables.keep, true);
  assert.deepEqual(type.keeps, { name: 'OpenAI', days: 30, hours: 46, uniform: true, perModel: true });
  assert.ok(type.keeps.hours * 3600_000 < 2 * DAY, 'a chain ends before the photos it points at expire');
});
