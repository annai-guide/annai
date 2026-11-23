import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noReader, readerRoles, readFile } from '../../src/core/agent/reading.js';
import { sendMs } from '../../src/core/llm/uploads.js';
import { callOnce } from '../../src/core/llm/call.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { useClock } from './clock.js';

test('with nothing here that reads a PDF, the note names the setting, and the plugin only when asked to', () => {
  assert.equal(noReader('pdf', { plugin: false }), "No model here can read PDFs, so what it says can't be told. Tell the user what fixes it: a model that reads PDFs (Takes PDFs on its page in Settings → Models).");
  // "Settings → Plugins", not "→ Add": it may be installed but off, or crashed (the review of reading-files).
  assert.match(noReader('pdf', { plugin: true }), /Takes PDFs on its page in Settings → Models\), or the PDF pages plugin \(Settings → Plugins\), which shows a PDF's pages to a model that sees photos\.$/);
  // The plugin runs, but nothing here sees photos: the other fix is a model that does.
  assert.match(noReader('pdf', { photos: true }), /Takes PDFs on its page in Settings → Models\), or a model that sees photos \(Takes photos on its page in Settings → Models\), which the PDF pages plugin shows a PDF's pages to\.$/);
  assert.match(noReader('image', { plugin: true }), /^No model here can see photos, .*Takes photos on its page in Settings → Models\)\.$/);
  assert.doesNotMatch(noReader('image', { plugin: true }), /PDF pages/);
});

test("the roles that read for a half: Koe's first for Kokoro; for Koe, Utility's, then Main's; an empty Utility is Main's, and a role with no chat model on is left out", () => {
  const chat = { kind: 'chat', type: 'scripted', on: true };
  /** @type {any} */
  const cfg = {
    providers: { p: { id: 'p', user: { name: 'P', abilities: { chat, realtime: { kind: 'realtime', type: 'gemini-live', on: true } } } } },
    models: { a: { id: 'a', provider: 'p', ability: 'chat', user: { providerId: 'a' } }, k: { id: 'k', provider: 'p', ability: 'chat', user: { providerId: 'k' } }, u: { id: 'u', provider: 'p', ability: 'chat', user: { providerId: 'u' } }, live: { id: 'live', provider: 'p', ability: 'realtime', user: { providerId: 'live' } } },
    roles: { main: { models: ['a'] }, utility: { models: [] }, 'koe-classic': { models: ['k'] }, 'koe-realtime': { models: ['live'] } },
  };
  assert.deepEqual(readerRoles(cfg, 'kokoro'), ['koe-classic', 'main']);
  assert.deepEqual(readerRoles(cfg, 'one'), ['koe-classic', 'main']);
  assert.deepEqual(readerRoles(cfg, 'koe'), ['main', 'koe-classic']);
  cfg.roles.utility.models = ['u'];
  assert.deepEqual(readerRoles(cfg, 'kokoro'), ['koe-classic', 'utility', 'main']);
  assert.deepEqual(readerRoles(cfg, 'koe'), ['utility', 'main', 'koe-classic'], "for Koe, Utility's first, then Main's (the coordinator's call, 2026-10-28)");
  cfg.roles.utility.models = ['a'];
  assert.deepEqual(readerRoles(cfg, 'kokoro'), ['koe-classic', 'utility'], "a list that is an earlier one's is left out");
  cfg.roles.utility.models = ['u'];
  assert.deepEqual(readerRoles(cfg, 'kokoro'), ['koe-classic', 'utility', 'main']);
  cfg.roles['koe-classic'].models = [];
  assert.deepEqual(readerRoles(cfg, 'kokoro'), ['utility', 'main'], 'a realtime model is no reader');
});

// read-wait-next (the Deferred entry "A reading's and a transcription's waits estimate their send apart from a model's"): a reading has no
// clock over its readers' calls; each is timed as any model call is (callOnce), and only the PDF pages' drawing has the reading's limit.

/** Two roles whose models see photos and read PDFs: Utility's (u), then Main's (m). @type {any} */
const twoReaders = {
  providers: { p: { id: 'p', user: { name: 'P', abilities: { chat: { kind: 'chat', type: 'scripted', on: true } } } } },
  models: {
    u: { id: 'u', provider: 'p', ability: 'chat', user: { providerId: 'u', input: ['text', 'image', 'pdf'] } },
    m: { id: 'm', provider: 'p', ability: 'chat', user: { providerId: 'm', input: ['text', 'image', 'pdf'] } },
  },
  roles: { main: { models: ['m'] }, utility: { models: ['u'] }, 'koe-classic': { models: [] } },
};
/**
 * A reader for each role: what its call does, given the call. Each call is kept in asked (its role, its first-words wait, whether it was
 * told it shares the link). @param {Record<string, (c: any) => Promise<any>>} by
 */
const readers = (by) => {
  /** @type {{ role: string, firstOutputMs: number, shared: unknown }[]} */
  const asked = [];
  const call = async (/** @type {any} */ c) => {
    asked.push({ role: c.role, firstOutputMs: c.firstOutputMs, shared: c.shared });
    return by[c.role](c);
  };
  return { asked, call };
};
/** A call that answers after ms (Infinity: never), or fails with err then; ended by its signal. @param {number} ms @param {Error} [err] */
const after = (ms, err) => async (/** @type {any} */ c) => new Promise((done, fail) => {
  const t = ms === Infinity ? undefined : setTimeout(() => (err ? fail(err) : done({ reply: { text: `Read by ${c.role}.`, stop: 'end' }, answeredBy: c.role })), ms);
  c.signal.addEventListener('abort', () => { clearTimeout(t); fail(new ProviderError('cancelled', 'Stopped.')); }, { once: true });
});
/** A call that never starts answering, ended at its first-words wait as callOnce ends it. */
const neverStarts = async (/** @type {any} */ c) => after(c.firstOutputMs, new ProviderError('timeout', 'No output started in time.', { said: { code: 'late' } }))(c);
/** @param {any} file @param {any} llm @param {any} [more] */
const readWith = (file, llm, more = {}) => readFile(file, { input: ['text'] }, {
  llm: { config: async () => twoReaders, ...llm }, half: 'one', pages: null, signal: new AbortController().signal, wakeId: 'w-1', scope: 'trip-a',
  secondMs: 1, explain: (/** @type {any} */ e, /** @type {string} */ role) => `${role}: ${e.message}`, store: /** @type {any} */ ({}), ...more,
});
// At secondMs 1, the old limit was a photo's 30 seconds as 30 ms, and 4,000 characters of base64 added 458 ms (SLOW_UPLINK, 70 kbit/s).
/** @type {import('../../src/core/agent/reading.js').FileToRead} */
const photo = { kind: 'image', mediaType: 'image/jpeg', data: 'A'.repeat(4_000) };

test("a reader's call that takes longer than the reading's old limit and its send's estimate is still the description: readFile puts no clock over a reader's call (read-wait-next, 1)", async (t) => {
  useClock(t);
  const r = readers({ utility: after(1_000) });
  const started = Date.now();
  assert.deepEqual(await readWith(photo, r), { how: 'told', text: "What it shows (described by utility, as you can't see photos): Read by utility.", images: [] });
  assert.equal(Date.now() - started, 1_000);
  assert.ok(1_000 > 30 + sendMs(4_000));
});

test("a reader whose call fails at its own limit (a send that never went up) is ended at that moment, in the call's own words, and the next reader is asked; the reading says the first's (read-wait-next, 2)", async (t) => {
  useClock(t);
  const send = new ProviderError('timeout', 'No answer in 70 seconds. The connection may be too slow to send photos or files.', { said: { code: 'send', seconds: 70 } });
  const r = readers({ utility: after(70_000, send), main: after(70_000, send) });
  const started = Date.now();
  const read = await readWith(photo, r);
  assert.equal(read.how, 'failed');
  assert.equal(read.text, "It couldn't be described: utility: No answer in 70 seconds. The connection may be too slow to send photos or files.");
  assert.equal(Date.now() - started, 140_000, 'each reader ended by its own call, the next then asked');
  assert.deepEqual(r.asked.map((a) => a.role), ['utility', 'main']);
});

test("a reader that never starts answering passes the photo on at its own wait, the longer of its role's and DESCRIBE_S: the next reader describes it (read-wait-next, 3)", async (t) => {
  useClock(t);
  const r = readers({ utility: neverStarts, main: after(5) });
  const started = Date.now();
  const read = await readWith({ ...photo, data: 'AAAA' }, r);
  assert.equal(read.text, "What it shows (described by main, as you can't see photos): Read by main.");
  assert.deepEqual(r.asked.map((a) => [a.role, a.firstOutputMs]), [['utility', 30_000], ['main', 30_000]], "the role's 30 s, over DESCRIBE_S's 30 ms at secondMs 1");
  assert.equal(Date.now() - started, 30_000 + 5);
});

/** @type {import('../../src/core/agent/reading.js').FileToRead} */
const pdf = { kind: 'pdf', mediaType: 'application/pdf', data: 'A'.repeat(40_000), name: 'booking.pdf' };
/** A PDF pages plugin that never draws, until it is stopped. */
const hangs = { pages: (/** @type {any} */ _b, /** @type {any} */ o) => new Promise((_, no) => o.signal.addEventListener('abort', () => no(new Error('Stopped.')), { once: true })) };

test("a PDF whose readers refuse at once, then whose pages plugin hangs, ends at DESCRIBE_PDF_S from the drawing's start, not later for the PDF's size (read-wait-next, 4)", async (t) => {
  useClock(t);
  const refused = new ProviderError('bad-request', 'The PDF is too long.');
  const r = readers({ utility: after(7, refused), main: after(3, refused) });
  const started = Date.now();
  const read = await readFile(pdf, { input: ['text', 'image'] }, {
    llm: { config: async () => twoReaders, call: r.call }, half: 'one', pages: /** @type {any} */ (hangs), signal: new AbortController().signal, wakeId: 'w-1', scope: 'trip-a',
    secondMs: 1, explain: (/** @type {any} */ e) => e.message, store: /** @type {any} */ ({}),
  });
  assert.deepEqual([read.how, read.text], ['late', "It couldn't be described in time (90 seconds)."]);
  assert.equal(Date.now() - started, 7 + 3 + 90, "the readers' 10 ms, then the drawing's 90 seconds at secondMs 1; the PDF's size adds nothing");
});

test("a PDF's telling that arrives after the drawing's 90 seconds is the result, from its words (no drawing runs) or from its pages' pictures: the reading has no clock over its readers, and the drawing's ends once the pages are drawn (read-wait-next, 5)", async (t) => {
  useClock(t);
  const r = readers({ utility: after(200) });
  const read = await readWith({ ...pdf, data: 'JVBE' }, r);
  assert.equal(read.how, 'told');
  assert.match(read.text, /^What it says \(told by utility, as you can't read PDFs\): Read by utility\.$/);
  // No reader reads PDFs; Utility's sees photos, and tells the drawn page after 200 ms.
  const seer = structuredClone(twoReaders);
  seer.models.u.user.input = ['text', 'image'];
  seer.roles.main.models = [];
  const pages = { pages: async () => ({ count: 1, pages: [{ type: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0]), width: 10, height: 10 }] }) };
  const told = await readFile({ ...pdf, data: 'JVBE' }, { input: ['text'] }, {
    llm: { config: async () => seer, call: readers({ utility: after(200) }).call }, half: 'one', pages: /** @type {any} */ (pages), signal: new AbortController().signal, wakeId: 'w-1', scope: 'trip-a',
    secondMs: 1, explain: (/** @type {any} */ e) => e.message, store: /** @type {any} */ ({}),
  });
  assert.equal(told.text, "What it says (told by utility from pictures of page 1 of 1, as you can't read PDFs): Read by utility.");
});

test("every reader call is asked as shared when its reading is, and not when it isn't: a photo's two readers, a PDF's words from the second, and its pages' pictures from the second (read-wait-next, 6)", async (t) => {
  useClock(t);
  const refused = new ProviderError('bad-request', 'No.');
  // Neither reader reads PDFs, both see photos; one page is drawn.
  const seers = structuredClone(twoReaders);
  for (const m of Object.values(seers.models)) /** @type {any} */ (m).user.input = ['text', 'image'];
  const pages = { pages: async () => ({ count: 1, pages: [{ type: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0]), width: 10, height: 10 }] }) };
  for (const shared of [true, false, undefined]) {
    const more = shared === undefined ? {} : { shared };
    const want = Boolean(shared);
    const photoAsk = readers({ utility: after(5, refused), main: after(5) });
    await readWith(photo, photoAsk, more);
    assert.deepEqual(photoAsk.asked.map((a) => [a.role, a.shared]), [['utility', want], ['main', want]], `a photo, shared ${shared}`);
    const words = readers({ utility: after(5, refused), main: after(5) });
    await readWith({ ...pdf, data: 'JVBE' }, words, more);
    assert.deepEqual(words.asked.map((a) => [a.role, a.shared]), [['utility', want], ['main', want]], `a PDF's words, shared ${shared}`);
    const drawn = readers({ utility: after(5, refused), main: after(5) });
    await readWith({ ...pdf, data: 'JVBE' }, { call: drawn.call, config: async () => seers }, { pages, ...more });
    assert.deepEqual(drawn.asked.map((a) => [a.role, a.shared]), [['utility', want], ['main', want]], `a PDF's pictures, shared ${shared}`);
  }
});

test("over the real callOnce, a reader whose request never goes up ends at its wait and its send's time, twice that when shared: the reading's own limit no longer ends it first (read-wait-next, 7)", async (t) => {
  useClock(t);
  const type = /** @type {any} */ ({
    type: 'test', name: 'Test', pluginId: 'test-plugin', read: async function* () {},
    build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: { model: c.model.providerId, messages: c.request.messages } }),
  });
  const endpoint = { id: 'p/chat', provider: 'p', ability: 'chat', type: 'test', name: 'P', baseUrl: 'https://llm.test', headers: {}, tunables: {}, extraBody: {} };
  const model = { id: 'u', provider: 'p', ability: 'chat', name: 'U', providerId: 'u', input: ['text', 'image'], tools: true, contextWindow: 100000, maxOutput: 1000, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {} };
  for (const shared of [false, true]) {
    /** @type {string[]} */
    const bodies = [];
    const fetch = (/** @type {string} */ _url, /** @type {any} */ init) => new Promise((_, fail) => {
      bodies.push(init.body);
      init.signal.addEventListener('abort', () => fail(init.signal.reason), { once: true });
    });
    const one = { ...twoReaders, roles: { ...twoReaders.roles, main: { models: [] } } };
    const call = async (/** @type {any} */ c) => ({ reply: await callOnce({ type, endpoint, model, key: null, request: c.request, fetch: /** @type {any} */ (fetch), firstOutputMs: c.firstOutputMs, shared: c.shared, signal: c.signal }), answeredBy: 'U' });
    const started = Date.now();
    const read = await readWith(photo, { call, config: async () => one }, { shared });
    const bytes = new TextEncoder().encode(bodies[0]).byteLength;
    assert.equal(Date.now() - started, 30_000 + sendMs(bytes, shared), `shared ${shared}: the reader's wait and its send's time`);
    assert.equal(read.how, 'failed');
    assert.match(read.text, /^It couldn't be described: utility: No answer in \d+ seconds\. The connection may be too slow to send photos or files\.$/);
  }
});

// read-wait-fix1: what the second opinions' mutants showed the tests above left open.

test("a reader whose role waits less than DESCRIBE_S (Koe's 8 s) is asked with DESCRIBE_S at the production second, and ends at it (read-wait-fix1, the floor)", async (t) => {
  useClock(t);
  const koe = { ...twoReaders, roles: { main: { models: [] }, utility: { models: [] }, 'koe-classic': { models: ['u'] } } };
  const r = readers({ 'koe-classic': neverStarts });
  const started = Date.now();
  const read = await readWith(photo, { call: r.call, config: async () => koe }, { secondMs: 1000 });
  assert.deepEqual(r.asked.map((a) => a.firstOutputMs), [30_000], "DESCRIBE_S's 30 s, not Koe's 8");
  assert.equal(Date.now() - started, 30_000);
  assert.equal(read.how, 'failed');
});

test("the turn's stop reaches a reader that never answers: the reading says so at once, and asks no further reader (read-wait-fix1)", async (t) => {
  useClock(t);
  const turn = new AbortController();
  const r = readers({ utility: after(Infinity), main: after(Infinity) });
  setTimeout(() => turn.abort(), 5);
  const started = Date.now();
  const read = await readWith(photo, r, { signal: turn.signal, secondMs: 1000 });
  assert.equal(read.how, 'stopped');
  assert.equal(Date.now() - started, 5);
  assert.deepEqual(r.asked.map((a) => a.role), ['utility']);
});

test('a turn already stopped when the reading starts ends it before any reader is asked (read-wait-fix1)', async (t) => {
  useClock(t);
  const turn = new AbortController();
  turn.abort();
  const r = readers({ utility: after(Infinity), main: after(Infinity) });
  const read = await readWith(photo, r, { signal: turn.signal, secondMs: 1000 });
  assert.equal(read.how, 'stopped');
  assert.deepEqual(r.asked, []);
});

test("a PDF told in words after the drawing's 90 seconds is the result while the pages plugin is installed: no drawing's clock runs over a telling that needs no pages (read-wait-fix1)", async (t) => {
  useClock(t);
  let drawn = 0;
  const pages = { pages: async () => { drawn++; return { count: 1, pages: [] }; } };
  const r = readers({ utility: after(200) });
  const read = await readWith({ ...pdf, data: 'JVBE' }, r, { pages });
  assert.equal(read.how, 'told');
  assert.equal(drawn, 0);
});
