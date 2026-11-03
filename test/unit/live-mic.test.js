// Live mic listening (the drive-test follow-ups design, section 6): event wakes listen briefly, only exchanges keep her listening,
// non-stop sound wakes Kokoro (who decides), urgent notes are said whole, and live Koe's sleep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './agent-kit.js';
import { liveKit, texts, soon, tone, say, sleep, lives } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const RATE = 16_000;
/** The wakes Kokoro got with a reason of annai's that matches. @param {any} k @param {RegExp} re */
const kokoroWakes = async (k, re) => (await k.events(['wake'])).filter((/** @type {any} */ e) => (e.data.reasons ?? []).some((/** @type {any} */ w) => re.test(String(w.text ?? ''))));
/** Feeds sound in real time, a tenth of a second at a time, until stop() says so. @param {any} k @param {() => boolean} stop */
async function feedWhile(k, stop, amp = 0.1) {
  if (k.platform.mic.isOpen()) k.platform.mic.feed(quiet(0.3), RATE); // the room first: the detector learns its floor
  while (!stop()) {
    if (k.platform.mic.isOpen()) k.platform.mic.feed(hum(0.1, amp), RATE);
    await wait(20);
  }
}

test('two user turns in a row at the 15 s cap wake Kokoro once with what was heard; nothing closes by itself', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  // Every turn heard is dismissed (an empty turn of hers): music, not the user.
  const k = await liveKit([{ heard: 'la la la' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } }); // 3 s here
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    k.platform.mic.feed(cat(quiet(0.3), hum(47)), RATE); // three turns at the cap, the last going on
    await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1);
    await wait(300);
    const [w] = await kokoroWakes(k, /non-stop sound/);
    assert.equal(w.data.reasons.filter((/** @type {any} */ x) => /non-stop sound/.test(x.text)).length, 1, 'once for the stretch');
    assert.match(w.data.reasons.find((/** @type {any} */ x) => /non-stop sound/.test(x.text)).text, /la la la/);
    assert.equal(k.agent.live.state, 'open', 'annai closes nothing on it');
    // A pause ends the stretch: two more caps wake Kokoro again.
    k.platform.mic.feed(cat(quiet(1.5), hum(31), quiet(1.5)), RATE);
    await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 2);
    assert.equal((await lives(k, 'closed')).length, 0);
  } finally {
    await k.done();
  }
});

test("Kokoro's note telling Koe to sleep, on non-stop sound, has live Koe call sleep: the session closes like a tap (sleep)", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  // The three turns heard are let go (the last ends on the pause); the note is answered with sleep.
  const k = await liveKit([{ heard: 'la la' }, { heard: 'la la' }, { heard: 'la' }, { tool: { name: 'sleep', args: {} } }], {
    kokoro: [{ rules: [{ match: 'non-stop sound', reply: { toolCalls: [{ name: 'tell_koe', input: { text: 'Only music is playing: go to sleep.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }],
  });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    k.platform.mic.feed(cat(quiet(0.3), hum(31), quiet(1.5)), RATE); // two turns at the cap, then a pause
    await until(() => k.agent.live.state === 'closed', 5000);
    assert.ok(texts(k).some((x) => /go to sleep/.test(x)), 'the note went to Koe');
    await soon(async () => (await lives(k, 'closed')).length === 1);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'sleep');
    assert.equal(k.agent.live.listening, false);
    assert.equal(k.platform.mic.isOpen(), false, 'the microphone is off');
  } finally {
    await k.done();
  }
});

test("live Koe has sleep, described for the live session; the user asking her to sleep closes it after she has said so", async () => {
  const k = await liveKit([{ heard: 'Go to sleep.', said: 'Good night.', audio: tone(0.2), tool: { name: 'sleep', args: {} } }]);
  try {
    const sleepTool = (await k.agent.koe.liveTools()).find((/** @type {any} */ t) => t.name === 'sleep');
    assert.ok(sleepTool, 'live Koe has sleep');
    assert.match(sleepTool.description, /only when the user asks you to sleep or stop listening, or a note from Kokoro tells you to/i);
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await say(k, 'where-eat');
    await until(() => k.agent.live.state === 'closed', 5000);
    const out = await k.events(['out.speak']);
    assert.equal(out.length, 1);
    assert.equal(out[0].data.cut, undefined, 'said whole before it closed');
    await soon(async () => (await lives(k, 'closed')).length === 1);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'sleep');
  } finally {
    await k.done();
  }
});

test("a trigger's session listens only briefly: a heard turn she dismisses doesn't hold it or clear that", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ said: 'The sun sets in half an hour.', audio: tone(0.1) }, { heard: 'mm' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } }); // 3 s spell, 400 ms answer window
    await k.voice.unlock();
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes' });
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await until(() => k.agent.live.listening, 3000);
    // Sound that keeps the detector busy (and a turn she lets go) for longer than the window: it still closes long before the spell.
    const t0 = Date.now();
    let done = false;
    const feeding = feedWhile(k, () => done || k.agent.live.state === 'closed');
    await until(() => k.agent.live.state === 'closed', 2500).finally(() => { done = true; });
    await feeding;
    assert.ok(Date.now() - t0 < 2500, `closed after ${Date.now() - t0} ms`);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'quiet');
  } finally {
    await k.done();
  }
});

test('a heard turn she answers with words clears the brief window: the quiet spell holds after it', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ said: 'The sun sets in half an hour.', audio: tone(0.1) }, { heard: 'where should we eat', said: 'Tacos ahead.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k.voice.unlock();
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes' });
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await until(() => k.agent.live.listening, 3000);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['out.speak'])).length === 2);
    await wait(1000); // past the 400 ms window, inside the 3 s spell
    assert.equal(k.agent.live.state, 'open');
  } finally {
    await k.done();
  }
});

test('an urgent note (immediate) is said whole while the detector reports speech; it opens a closed session listening briefly', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'la la' }, { said: 'Turn left in two hundred meters.', audio: tone(0.6) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k.voice.unlock();
    // In the car, where speaking cuts her off (full duplex), her voice playing in real time: sound over it is heard.
    k.voice.route = async () => 'car';
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedWhile(k, () => done); // music, never stopping: a user turn is going on
    try {
      await until(() => k.agent.live.view.name === 'hearing', 3000).catch((e) => { throw new Error(`${e.message}: ${k.agent.live.view.name}`); });
      await k.agent.live.note('Say now: turn left in 200 m.', 'immediate');
      await soon(async () => (await k.events(['out.speak'])).length === 1, 5000);
    } finally {
      done = true;
      await feeding;
    }
    const [out] = await k.events(['out.speak']);
    assert.equal(out.data.cut, undefined, 'never cut by the music');
    assert.equal(out.data.voice, true);
  } finally {
    await k.done();
  }
  // Closed, an immediate note opens a session that listens only briefly.
  const k2 = await liveKit([{ said: 'Turn left now.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k2.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k2.voice.unlock();
    const t0 = Date.now();
    await k2.agent.live.note('Say now: turn left.', 'immediate');
    await soon(async () => (await k2.events(['out.speak'])).length === 1);
    await until(() => k2.agent.live.state === 'closed', 2500);
    assert.ok(Date.now() - t0 < 2500, 'the answer window, not the 3 s spell');
  } finally {
    await k2.done();
  }
});

test('a non-urgent note waits for the user turn going on to end (at most the 15 s cap), then is said', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'la la' }, { said: 'Fuel is low.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    k.platform.mic.feed(cat(quiet(0.3), hum(5)), RATE); // a turn going on
    assert.equal(k.agent.live.view.name, 'hearing');
    const going = k.agent.live.note('Fuel is low.', 'append');
    await wait(200);
    assert.ok(!texts(k).some((x) => /Fuel is low/.test(x)), 'not while the turn goes on');
    k.platform.mic.feed(cat(hum(11), quiet(1)), RATE); // the turn reaches the cap
    await going;
    await soon(async () => texts(k).some((x) => /Fuel is low/.test(x)));
  } finally {
    await k.done();
  }
});
