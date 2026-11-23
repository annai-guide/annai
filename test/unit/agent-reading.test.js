import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noReader, readerRoles, readFile } from '../../src/core/agent/reading.js';
import { sendMs } from '../../src/core/llm/uploads.js';
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

test("a reading's limit has each reader's time to go up on top, added once when it is asked: a photo slower to go up than the limit is still described, and a reader that never answers ends at the limit and that time, not later (photo-wait's follow-ups, 2)", async (t) => {
  useClock(t); // a clock that moves only by its timers: an end is exact, whatever the machine's speed
  /** @type {any} */
  const cfg = {
    providers: { p: { id: 'p', user: { name: 'P', abilities: { chat: { kind: 'chat', type: 'scripted', on: true } } } } },
    models: { u: { id: 'u', provider: 'p', ability: 'chat', user: { providerId: 'u', input: ['text', 'image'] } } },
    roles: { main: { models: ['u'] }, utility: { models: [] }, 'koe-classic': { models: [] } },
  };
  /** A reader that has its answer ms after it is asked (its request going up until then), ended by its signal. @param {number} ms */
  const answersAfter = (ms) => async (/** @type {any} */ c) => new Promise((done, fail) => {
    const t = ms === Infinity ? undefined : setTimeout(() => done({ reply: { text: 'A pelican on a post.', stop: 'end' }, answeredBy: 'Reader' }), ms);
    c.signal.addEventListener('abort', () => { clearTimeout(t); fail(new Error('stopped')); }, { once: true });
  });
  // At secondMs 1, a photo's 30 seconds are 30 ms; 4,000 characters of base64 take 0.46 s at the slow link (SLOW_UPLINK, 70 kbit/s).
  const read = (/** @type {number} */ ms) => readFile({ kind: 'image', mediaType: 'image/jpeg', data: 'A'.repeat(4_000) }, { input: ['text'] }, {
    llm: { call: answersAfter(ms), config: async () => cfg }, half: 'one', pages: null, signal: new AbortController().signal, wakeId: 'w-1', scope: 'trip-a',
    secondMs: 1, explain: () => 'it failed', store: /** @type {any} */ ({}),
  });
  assert.deepEqual(await read(250), { how: 'told', text: "What it shows (described by Reader, as you can't see photos): A pelican on a post.", images: [] });
  const started = Date.now();
  assert.equal((await read(Infinity)).how, 'late');
  assert.equal(Date.now() - started, 30 + sendMs(4_000), "the limit and the photo's send time, once");
});
