// Live Koe's lines at a switch: each is written into the conversation she spoke in, not the one opened meanwhile (the session's scope is bound as it
// connects), and the event reaches the screens' listeners as any held wake's does. And a reply with no sound yet is not heard whole: its note is
// kept to be said again, or written where it was made, never lost. Lines and places are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until, agentKit } from './agent-kit.js';
import { liveKit, soon, tone, say } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';
import { createTrip } from '../../src/core/scopes.js';

const RATE = 16_000;
const SAID = 'The fuel station ahead is open until ten tonight.';
const NOTE = 'Tell the user the fuel station ahead is open until ten tonight.';
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** What was written into a conversation, as `type:text`. @param {any} k @param {string} scope @param {string[]} types */
const inTrip = async (k, scope, types) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types }))).map((/** @type {any} */ e) => `${e.type}:${e.data.text}`);

/**
 * A live session in a car, the user in it after a first exchange; then Kokoro's note, which she begins to say.
 * @param {any[]} turns what the stand-in answers after the first exchange
 */
async function noteBegun(turns) {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, ...turns], { agent: { secondMs: 1000 } });
  await k.voice.unlock();
  k.voice.route = async () => 'car';
  k.platform.streamSpeed = 1;
  k.agent.tap();
  await until(() => k.agent.live.listening, 3000);
  await say(k, 'where-eat');
  await soon(async () => (await k.events(['out.speak'])).length === 1, 4000);
  await k.agent.live.idle();
  k.platform.mic.feed(quiet(0.5), RATE);
  await k.agent.channel.send('kokoro', NOTE, 'append', 'tool', undefined, undefined, false, SAID);
  await soon(async () => k.agent.live.view.name === 'speaking', 3000);
  return k;
}

// 400 and 800 ms: cut; 1650 ms: all of her sound has played and the provider has not ended her turn.
for (const at of [400, 800, 1650]) {
  test(`her line for a note, a switch ${at} ms into it, is written into the conversation she spoke in, and its event is heard there`, async () => {
    const k = await noteBegun([{ said: SAID, audio: tone(1.5), endAt: 1900 }]);
    try {
      /** @type {any[]} */
      const seen = [];
      k.agent.on('event', (/** @type {any} */ e) => { if (e.type === 'out.speak') seen.push(e); });
      await wait(at);
      const other = await createTrip(k.ws, { title: 'Carmel' });
      await k.agent.open(other);
      await k.agent.idle();
      await wait(500);
      const left = await inTrip(k, k.trip, ['out.speak']);
      assert.deepEqual(await inTrip(k, other, ['out.speak', 'reminder']), [], 'nothing of hers in the trip opened');
      assert.ok(left.some((l) => l.startsWith(at === 1650 ? `out.speak:${SAID}` : 'out.speak:The fuel')), `her line is in the trip left: ${JSON.stringify(left)}`);
      assert.ok(seen.some((e) => e.scope === k.trip && e.data.text.startsWith('The fuel')), 'listeners heard it for the conversation left');
    } finally {
      await k.done();
    }
  });
}

test("the user's own words, cut by a switch, are written into the conversation they spoke in (the same path)", async () => {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, { heard: 'Where should we eat tonight near the', heardFirst: true, said: 'Sure.', audio: tone(0.3) }], { agent: { secondMs: 1000 } });
  try {
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['out.speak'])).length === 1, 4000);
    await k.agent.live.idle();
    k.platform.mic.feed(cat(hum(3), quiet(1)), RATE);
    await wait(800);
    const other = await createTrip(k.ws, { title: 'Carmel' });
    await k.agent.open(other);
    await k.agent.idle();
    await wait(500);
    assert.deepEqual(await inTrip(k, other, ['heard']), [], 'nothing of the trip left in the trip opened');
  } finally {
    await k.done();
  }
});

test('an entry written into another conversation is heard by the listeners, as a held wake is (a draft is named by a spoken line, live mode follows its rows)', async () => {
  const k = await agentKit([]);
  const other = await createTrip(k.ws, { title: 'Carmel' });
  /** @type {any[]} */
  const seen = [];
  k.agent.on('event', (/** @type {any} */ e) => seen.push(e));
  await k.agent.log({ type: 'out.speak', actor: 'shiori', data: { id: 's1', live: true, by: null }, texts: [['text', 'Hello.']] }, { scope: other });
  assert.deepEqual(seen.map((e) => [e.scope, e.type]), [[other, 'out.speak']]);
});

// A first real word with no audio yet makes the stream with nothing pushed, so nothing is queued: that is no sound played.
for (const how of ['switch', 'away']) {
  test(`her words came before any sound, then ${how}: the note isn't passed on as heard whole`, async () => {
    const k = await noteBegun([{ said: SAID, endAt: 1900 }, { said: SAID, audio: tone(0.3) }]);
    try {
      await wait(300);
      /** @type {string | null} */
      let other = null;
      if (how === 'switch') {
        other = await createTrip(k.ws, { title: 'Carmel' });
        await k.agent.open(other);
      } else {
        // @ts-ignore the page out of view
        globalThis.document = { visibilityState: 'hidden' };
        k.agent.hush('away');
        await wait(800);
        // @ts-ignore
        delete globalThis.document;
        await k.agent.shown();
        await soon(async () => (await inTrip(k, k.trip, ['out.speak'])).some((l) => l === `out.speak:${SAID}`), 8000);
      }
      await k.agent.idle();
      await wait(500);
      const left = [...(await inTrip(k, k.trip, ['out.speak', 'reminder'])), ...(other ? await inTrip(k, other, ['out.speak', 'reminder']) : [])];
      assert.ok(left.some((l) => l.endsWith(SAID)), `the note is said again or shown where it was made: ${JSON.stringify(left)}`);
    } finally {
      // @ts-ignore
      delete globalThis.document;
      await k.done();
    }
  });
}

test('a tap on Shiori as her words begin, before any sound, keeps the note: it is shown, not dropped as heard whole', async () => {
  const k = await noteBegun([{ said: SAID, endAt: 1900 }]);
  try {
    await wait(300);
    k.agent.tap();
    await k.agent.idle();
    await wait(800);
    const shown = [...(await inTrip(k, k.trip, ['out.speak', 'reminder']))];
    assert.ok(shown.some((l) => l.endsWith(SAID)), `the note's words are shown: ${JSON.stringify(shown)}`);
  } finally {
    await k.done();
  }
});
