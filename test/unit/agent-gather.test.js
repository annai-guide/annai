// Item 16 (the user, 2026-10-21): the user's messages are gathered before a turn starts, so a half-finished message doesn't
// cost a wasted turn. Kokoro behind Koe waits for the user's input to go quiet; one Shiori waits only while they type or speak.
// Times here run at secondMs 100 (a second is 100 ms): quiet 150 ms, a lone photo's 300 ms, the cap 2 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { createTrip } from '../../src/core/scopes.js';
import { GATHER } from '../../src/core/agent/loop.js';

const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const pause = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** Shiori as two halves: Kokoro sleeps, Koe says it is listening. @param {Record<string, any>} [agent] */
const halves = (agent = {}) => agentKit([{ rules: [{ match: '.', reply: sleep }] }], { koe: { type: { rules: [{ match: '.', reply: say('Mm-hm.') }] } }, agent: { secondMs: 100, ...agent } });
/** When Kokoro's first request went out, by polling. @param {any} k */
async function kokoroAt(k, ms = 5000) {
  await until(() => (k.sent['model-0'] ?? []).length > 0, ms);
  return Date.now();
}

test('the values: quiet 1.5 s, 3 s after a photo on its own, typing that lapses after 5 s without a keystroke, never held past 20 s', () => {
  assert.deepEqual(GATHER, { quiet: 1.5, photo: 3, typing: 5, most: 20 });
});

test('behind Koe, two typed lines close together reach Kokoro in one turn; Koe answers each at once', async () => {
  const k = await halves();
  k.agent.send('Also,');
  await pause(50);
  k.agent.send('we are vegetarian.');
  await k.agent.idle();
  assert.equal(k.sent['model-0'].length, 1, 'one Kokoro turn');
  assert.match(JSON.stringify(k.sent['model-0'][0].messages), /Also,.*we are vegetarian\./);
  assert.equal(k.sent['model-koe'].length, 2, 'Koe took each line as it came');
});

test('behind Koe, a photo on its own waits longer for the words that follow it', async () => {
  const k = await halves();
  await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('800x600'), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  k.agent.send('', { photos: [{ path: '/trip/files/p.webp' }] });
  await pause(200); // past the quiet for words, within a photo's
  k.agent.send('What is this?');
  await k.agent.idle();
  assert.equal(k.sent['model-0'].length, 1);
  assert.match(JSON.stringify(k.sent['model-0'][0].messages), /What is this\?/);
});

test('behind Koe, a heard segment resets the quiet', async () => {
  const k = await halves();
  k.agent.send('Where can we');
  await pause(100);
  const heardAt = Date.now();
  await k.agent.koe.log({ type: 'heard', actor: 'user', data: { id: 'h-1', ms: 900, source: 'dictation', text: 'eat tonight?' } });
  const started = await kokoroAt(k);
  assert.ok(started - heardAt >= 140, `Kokoro started ${started - heardAt} ms after the heard words`);
  await k.agent.idle();
});

test('behind Koe, Kokoro waits while the user is typing, up to 20 s', async () => {
  const k = await halves();
  k.agent.typing(true);
  k.agent.send('Is Nepenthe open');
  await pause(400);
  assert.equal(k.sent['model-0'], undefined, 'not while the typing box holds text');
  k.agent.typing(false);
  await kokoroAt(k);
  await k.agent.idle();
  const capped = await halves();
  capped.agent.typing(true);
  const keys = setInterval(() => capped.agent.typing(true), 200); // a keystroke every 2 s, as it runs here
  const sent = Date.now();
  capped.agent.send('Is Nepenthe open');
  const started = await kokoroAt(capped);
  clearInterval(keys);
  assert.ok(started - sent >= 1900, `held ${started - sent} ms: the cap is 20 s`);
  capped.agent.typing(false);
  await capped.agent.idle();
});

test("behind Koe, Koe's question after the user has finished starts Kokoro at once: its quiet counts from the user's input", async () => {
  const k = await halves({ secondMs: 1000 }); // quiet 1.5 s
  k.agent.send('Is Nepenthe open tonight?');
  await k.agent.idle();
  await pause(1600);
  const asked = Date.now();
  await k.agent.channel.send('koe', 'Is Nepenthe open tonight?', 'append', 'tool');
  await until(() => k.sent['model-0'].length === 2, 5000);
  assert.ok(Date.now() - asked < 1000, `${Date.now() - asked} ms`);
  await k.agent.idle();
});

test('one Shiori: no fixed wait, but a turn of the user\'s holds while they type, up to 20 s', async () => {
  const k = await agentKit([[say('Hi.')]], { agent: { secondMs: 1000 } });
  const sent = Date.now();
  k.agent.send('Hello');
  await until(() => k.requests.length === 1, 5000);
  assert.ok(Date.now() - sent < 1000, 'at once');
  await k.agent.idle();
  const typing = await agentKit([[say('Hi.')]], { agent: { secondMs: 100 } });
  typing.agent.typing(true);
  typing.agent.send('Hello');
  await pause(300);
  assert.equal(typing.requests.length, 0, 'held while the typing box holds text');
  typing.agent.send('again');
  typing.agent.typing(false);
  await typing.agent.idle();
  assert.equal(typing.requests.length, 1, 'one turn for both');
  assert.match(JSON.stringify(typing.requests[0].messages), /Hello.*again/);
  const capped = await agentKit([[say('Hi.')]], { agent: { secondMs: 100 } });
  capped.agent.typing(true);
  const keys = setInterval(() => capped.agent.typing(true), 200);
  const at = Date.now();
  capped.agent.send('Hello');
  await until(() => capped.requests.length === 1, 5000);
  clearInterval(keys);
  assert.ok(Date.now() - at >= 1900, `held ${Date.now() - at} ms`);
  capped.agent.typing(false);
  await capped.agent.idle();
});

test("the sign's Stop while Kokoro is still gathering: its turn never starts", async () => {
  const k = await halves();
  k.agent.typing(true);
  k.agent.send('Plan our afternoon');
  await until(() => k.agent.kokoroWorking);
  k.agent.stopKokoro();
  k.agent.typing(false);
  await k.agent.idle();
  assert.equal(k.sent['model-0'], undefined);
});

test('opening another conversation while a turn gathers does not wait for the gather (review A2)', async () => {
  const k = await agentKit([[say('Hi.')]], { agent: { secondMs: 100 } });
  const other = await createTrip(k.ws, { title: 'Other' });
  k.agent.typing(true);
  k.agent.send('Hello');
  await pause(50);
  const t0 = Date.now();
  await k.agent.open(other);
  assert.ok(Date.now() - t0 < 500, `open waited ${Date.now() - t0} ms for the gather`);
  k.agent.typing(false);
  await k.agent.idle();
});

test('the cap counts from the first wake: a wake that waited out a long turn starts at once after it, typing or not (review a5)', async () => {
  const k = await agentKit([[{ delayMs: 2500, ...say('First.') }, say('Second.')]], { agent: { secondMs: 100 } });
  k.agent.send('One');
  await until(() => k.requests.length === 1);
  const sent = Date.now();
  k.agent.typing(true);
  k.agent.send('Two'); // waits for the first turn, which has slept by then
  await until(() => k.requests.length === 2, 6000);
  assert.ok(Date.now() - sent < 3500, `${Date.now() - sent} ms: the 2 s cap had passed while the first turn ran`);
  k.agent.typing(false);
  await k.agent.idle();
});

test('one Shiori: a tap while a turn of the user\'s is gathering stops it, as Stop does for Kokoro; what they sent is kept, not taken up later (review a3)', async () => {
  const k = await agentKit([[say('Hi.')]], { agent: { secondMs: 100 } });
  k.agent.typing(true);
  k.agent.send('Hello');
  await pause(50);
  assert.equal(k.agent.tap(), 'stopped');
  k.agent.typing(false);
  await k.agent.idle();
  assert.equal(k.requests.length, 0);
  assert.deepEqual((await k.events(['msg.user'])).map((e) => e.data.text), ['Hello']);
  assert.equal((await k.events(['error'])).at(-1).data.kind, 'stopped');
  await k.agent.open(k.trip);
  await k.agent.idle();
  assert.equal(k.requests.length, 0, 'not taken up when the conversation opens again');
});

test("a typing box left holding text stops holding Kokoro after 5 s without a keystroke (review A3, the reviewer's probe B)", async () => {
  const k = await halves();
  k.agent.send('Is Nepenthe open tonight?');
  await k.agent.idle();
  k.agent.typing(true); // Escape, say, left text in the box, and no keystroke came after
  await pause(300);
  const asked = Date.now();
  await k.agent.channel.send('koe', 'Is Nepenthe open tonight?', 'append', 'tool');
  await until(() => k.sent['model-0'].length === 2, 5000);
  assert.ok(Date.now() - asked < 1000, `held ${Date.now() - asked} ms`);
  await k.agent.idle();
});

test("behind Koe, what doesn't come from the user (a reminder, a trigger, a review) isn't held while they type (review A3)", async () => {
  const k = await halves();
  k.agent.typing(true);
  const fired = Date.now();
  await k.agent.wake({ kind: 'trigger', text: 'Your watch w-1 (at 10:00) fired: the time came.', fallbacks: [] });
  await kokoroAt(k);
  assert.ok(Date.now() - fired < 400, `held ${Date.now() - fired} ms`);
  k.agent.typing(false);
  await k.agent.idle();
});

test('the page going away (hush) ends the typing too: Kokoro goes on once the quiet has passed (review A3)', async () => {
  const k = await halves({ secondMs: 1000 });
  k.agent.typing(true);
  k.agent.send('Is Nepenthe open');
  await pause(100);
  const gone = Date.now();
  k.agent.hush('away');
  await kokoroAt(k, 6000);
  assert.ok(Date.now() - gone < 3000, `${Date.now() - gone} ms: the quiet of 1.5 s, not the 5 s of typing`);
  await k.agent.idle();
});

test("Koe answers at once, typing or not: only Kokoro gathers; the sign shows while it does (the full e2e run)", async () => {
  const k = await halves();
  /** @type {any[]} */
  const signs = [];
  k.agent.on('halves', (/** @type {any} */ x) => signs.push(x.kokoroWorking));
  k.agent.typing(true);
  const sent = Date.now();
  k.agent.send('Is Nepenthe open?');
  await until(() => (k.sent['model-koe'] ?? []).length === 1, 3000);
  assert.ok(Date.now() - sent < 400, `Koe waited ${Date.now() - sent} ms`);
  assert.equal(k.sent['model-0'], undefined, 'Kokoro still gathers');
  assert.ok(signs.includes(true), '"Kokoro is working" shows already');
  k.agent.typing(false);
  await k.agent.idle();
});
