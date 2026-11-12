// Heard whole from the provider's own "all made": her turn counts as heard whole once all of it is made (Gemini's generationComplete, the
// protocol's `made`) and all of it played, its sound begun. So the user answering at once, as her last word sounds and before the provider ends
// her turn, gets no silent copy of the note they heard; and a tap or a close in a pause of her sound, while the provider still makes the rest, is a
// cut, whose rest is shown. A provider that never says (its type has no `made`) keeps the rules from before. Timings are real Gemini's
// (2026-11-12): generationComplete right after the last audio chunk, turnComplete 0.19 to 0.63 s after her sound stops, pauses up to 1.23 s.
// Lines and places are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './agent-kit.js';
import { liveKit, texts, soon, tone, say } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';

const RATE = 16_000;
const FOR_USER = 'The fuel station ahead is open until ten tonight.';
const NOTE = 'Tell the user the fuel station ahead is open until ten tonight.';
const SAID = 'The fuel station ahead is open until ten tonight.';
/** Kokoro's tell_koe with for_user, as its tool sends it. @param {any} k */
const tell = (k) => k.agent.channel.send('kokoro', NOTE, 'append', 'tool', undefined, undefined, false, FOR_USER);
/** What annai showed for Shiori in the conversation open, and whether its own voice said it. @param {any} k */
const shown = async (k) => (await k.events(['reminder'])).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.aloud)]);
/** What a trip's conversation holds of annai's cards for her. @param {any} k @param {string} trip */
const cards = async (k, trip) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(trip, { types: ['reminder'] }))).map((/** @type {any} */ e) => e.data.text);
/** Her lines, as written: words, and whether cut. @param {any} k */
const lines = async (k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.cut)]);
/** How many times the note was written heard whole. @param {any} k */
const wholeNotes = async (k) => (await lines(k)).filter(([text, cut]) => text === SAID && !cut).length;
/** How many times the note went into a session. @param {any} k */
const wentIn = (k) => texts(k).filter((/** @type {string} */ t) => t.includes('<from_kokoro')).length;
/** annai's asks once more. @param {any} k */
const asks = (k) => texts(k).filter((/** @type {string} */ t) => /^\[annai\] /.test(t));
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** The page out of view, or back, as the browser says it. @param {boolean} on */
function hidden(on) {
  if (on) /** @type {any} */ (globalThis).document = { visibilityState: 'hidden' };
  else delete (/** @type {any} */ (globalThis).document);
}
/** Her answer to what the user says next, so the note isn't the answer again (the stand-in's last turn repeats). */
const ANSWER = { said: 'Yes, until ten.', audio: tone(0.3), delayMs: 300 };
/** A pause of 1.5 s in her sound after its first 1.2 s (six pieces of 9,600 bytes), the provider still making the rest. */
const PAUSED = { said: SAID, audio: tone(3), gap: { at: 48_000, ms: 1500 } };

/**
 * A live session in the car (sound may cut her), the user in it, a real second; Kokoro's note, which she begins to say. Resolves as her sound for it
 * starts, with when. made false: the provider's plugin from before it said when her turn is all made.
 * pace: how long the stand-in's turns stay open, as a share of their sound's length (1.4: turnComplete 600 ms after 1.5 s of sound, and cut by the
 * user's turn beginning, as Gemini's are).
 * @param {{ note?: any, turns?: any[], made?: false, pace?: number }} [o] @returns {Promise<[any, number]>}
 */
async function noteSaid({ note = { said: SAID, audio: tone(1.5) }, turns = [ANSWER], made, pace = 1 } = {}) {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, note, ...turns], { pace, agent: { secondMs: 1000 }, ...(made === false ? { live: { made } } : {}) });
  await k.voice.unlock();
  k.voice.route = async () => 'car';
  k.platform.streamSpeed = 1;
  k.agent.tap();
  await until(() => k.agent.live.listening, 3000);
  await say(k, 'where-eat');
  await soon(async () => (await k.events(['out.speak'])).length === 1, 4000);
  await k.agent.live.idle();
  k.platform.mic.feed(quiet(0.5), RATE);
  await tell(k);
  await soon(async () => k.agent.live.view.name === 'speaking', 3000);
  return [k, Date.now()];
}

/** The user speaks once her sound has played out (soundMs from its start), timed; resolves with how long after her sound the provider was told their turn began. @param {any} k @param {number} at @param {number} soundMs */
async function answersAtOnce(k, at, soundMs) {
  await wait(Math.max(0, at + soundMs + 20 - Date.now()));
  const before = k.server.received().filter((/** @type {any} */ m) => m.realtimeInput?.activityStart).length;
  k.platform.mic.feed(cat(hum(0.8), quiet(1)), RATE);
  await soon(async () => k.server.received().filter((/** @type {any} */ m) => m.realtimeInput?.activityStart).length > before, 3000);
  return Date.now() - (at + soundMs);
}

test('the user answers as her last word sounds, before the provider ends her turn: the note is heard whole, and no silent copy of it is shown', async () => {
  // turnComplete 600 ms after her sound, about the slowest of real Gemini's (625 ms): their turn begins well inside that.
  const [k, at] = await noteSaid({ pace: 1.4 });
  try {
    const after = await answersAtOnce(k, at, 1500);
    assert.ok(after < 333, `their turn began ${after} ms after her sound, within a third of a second`);
    await soon(async () => (await lines(k)).some(([text]) => text === ANSWER.said), 8000);
    await wait(1000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [], 'nothing shown: they heard it');
    assert.equal(await wholeNotes(k), 1, 'her line written whole, once');
    assert.deepEqual(asks(k), [], 'nothing asked again');
    assert.equal(wentIn(k), 1);
  } finally {
    await k.done();
  }
});

test('a tap in a pause of her sound, the provider still making the rest of the note: a cut, and the note is shown, silently', async () => {
  const [k, at] = await noteSaid({ note: PAUSED });
  try {
    await wait(at + 1350 - Date.now()); // her 1.2 s have played; the rest comes at 1.5 s
    assert.equal(k.agent.live.view.name, 'speaking');
    k.agent.tap();
    await wait(2500); // the rest, made and ended meanwhile, changes nothing
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[FOR_USER, false]], 'what they never heard is shown, and not said');
    assert.equal(await wholeNotes(k), 0);
    assert.ok((await lines(k)).some(([text, cut]) => cut && /✂$/.test(String(text))), JSON.stringify(await lines(k)));
    assert.ok(!k.said.some((/** @type {string} */ t) => t.includes('fuel station')), "annai's own voice says nothing of it");
  } finally {
    await k.done();
  }
});

test('another trip opened in a pause of her sound: a cut, so the note is shown in the trip left', async () => {
  const [k, at] = await noteSaid({ note: PAUSED });
  try {
    await wait(at + 1350 - Date.now());
    const { createTrip } = await import('../../src/core/scopes.js');
    const other = await createTrip(k.ws, { title: 'Carmel' });
    await k.agent.open(other);
    await k.agent.idle();
    await wait(300);
    assert.deepEqual(await cards(k, k.trip), [FOR_USER], 'shown in the trip left');
    assert.deepEqual(await cards(k, other), []);
  } finally {
    await k.done();
  }
});

test('the page out of view in a pause of her sound, and back: a cut, so the note goes in again and she says it', async () => {
  const [k, at] = await noteSaid({ note: PAUSED, turns: [{ said: SAID, audio: tone(0.3) }] });
  try {
    await wait(at + 1350 - Date.now());
    hidden(true);
    k.agent.hush('away');
    await wait(1000);
    hidden(false);
    await k.agent.shown();
    await soon(async () => (await wholeNotes(k)) === 1, 8000);
    await k.agent.idle();
    assert.equal(wentIn(k), 2, 'it went in again: they never heard its rest');
    assert.deepEqual(await shown(k), []);
  } finally {
    hidden(false);
    await k.done();
  }
});

for (const how of /** @type {const} */ (['a tap', 'the page out of view'])) {
  test(`${how} after her sound for a note all made has played out, before the provider ends her turn: heard whole, nothing shown or sent again`, async () => {
    const [k, at] = await noteSaid({ note: { said: SAID, audio: tone(1.5), endAt: 2100 }, turns: [{ said: SAID, audio: tone(0.3) }] });
    try {
      await wait(at + 1650 - Date.now());
      if (how === 'a tap') k.agent.tap();
      else {
        hidden(true);
        k.agent.hush('away');
        await wait(1000);
        hidden(false);
        await k.agent.shown();
      }
      await wait(2500);
      await k.agent.idle();
      assert.deepEqual(await shown(k), []);
      assert.equal(await wholeNotes(k), 1, 'written whole, once');
      assert.equal(wentIn(k), 1, 'not sent again');
    } finally {
      hidden(false);
      await k.done();
    }
  });
}

test('a tap while her sound for a note all made still plays (the provider had made it, as in 3 of 5 real cuts): a cut, and the note is shown', async () => {
  const [k, at] = await noteSaid({ note: { said: SAID, audio: tone(3) } });
  try {
    await wait(at + 1000 - Date.now());
    k.agent.tap();
    await wait(1000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
    assert.equal(await wholeNotes(k), 0);
  } finally {
    await k.done();
  }
});

// Her reply to the note speaks and calls a tool she speaks after (watch_list: annai answers it without `silent`), and the provider says the turn is
// all made right after the call, as it does after a silent one (generationComplete 0 to 17 ms after it), before it knows what the answer is. More of
// that turn comes once annai answers, so it is not all made: until it ends, a user starting or a tap is a cut, and the note shows.
const LOOKS = { said: 'Let me check.', audio: tone(0.6), tool: { name: 'watch_list', args: {} }, noEnd: true };

test('the user speaks in the wait for a tool she speaks after, her words for the note played: the note is shown, not lost', async () => {
  const [k, at] = await noteSaid({ note: LOOKS });
  try {
    await wait(at + 600 + 600 - Date.now()); // "Let me check." has played; the tool was answered, and nothing more comes
    assert.deepEqual((await k.events(['tool.call'])).map((/** @type {any} */ e) => e.data.name), ['watch_list']);
    await answersAtOnce(k, Date.now(), 0);
    await soon(async () => (await lines(k)).length === 2, 8000); // the provider answers them in the turn it still has open
    assert.deepEqual(await shown(k), [[FOR_USER, false]], 'what Kokoro made for them is shown, silently');
  } finally {
    await k.done();
  }
});

test('a tap in the wait for a tool she speaks after, her words for the note played: a cut, and the note is shown', async () => {
  const [k, at] = await noteSaid({ note: LOOKS });
  try {
    await wait(at + 600 + 600 - Date.now());
    k.agent.tap();
    await soon(async () => (await lines(k)).length === 2, 8000);
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
    assert.equal(await wholeNotes(k), 0);
  } finally {
    await k.done();
  }
});

// A provider whose plugin never says when her turn is all made keeps the rules from before: all played is heard whole at a tap or a close, and
// the user's turn beginning shows what went in.
test('a provider that never says: the user answering at once still gets the silent copy of the note, as before', async () => {
  const [k, at] = await noteSaid({ pace: 1.4, made: false });
  try {
    await answersAtOnce(k, at, 1500);
    await soon(async () => (await lines(k)).some(([text]) => text === ANSWER.said), 8000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
    assert.equal(await wholeNotes(k), 1);
  } finally {
    await k.done();
  }
});

test('a provider that never says: a tap in a pause of her sound counts the note as heard whole, as before', async () => {
  const [k, at] = await noteSaid({ note: PAUSED, made: false });
  try {
    await wait(at + 1350 - Date.now());
    k.agent.tap();
    await wait(2500);
    await k.agent.idle();
    assert.deepEqual(await shown(k), []);
    assert.equal(await wholeNotes(k), 0, 'its line holds only what had come, unmarked');
    assert.ok((await lines(k)).some(([text, cut]) => !cut && String(text).startsWith('The fuel')), JSON.stringify(await lines(k)));
  } finally {
    await k.done();
  }
});

test('a provider that never says: another trip opened in a pause of her sound shows nothing in the trip left, as before', async () => {
  const [k, at] = await noteSaid({ note: PAUSED, made: false });
  try {
    await wait(at + 1350 - Date.now());
    const { createTrip } = await import('../../src/core/scopes.js');
    const other = await createTrip(k.ws, { title: 'Carmel' });
    await k.agent.open(other);
    await k.agent.idle();
    await wait(300);
    assert.deepEqual(await cards(k, k.trip), []);
  } finally {
    await k.done();
  }
});

// "One moment." and tell_kokoro, then no turnComplete (19 of 121 real tell_kokoro turns): annai ended her turn 2 s past her sound, and until then
// the dock said she was speaking and Kokoro's note waited. All made, it ends as her sound does.
const CHECKING = { heard: 'where to', said: 'One moment.', audio: tone(0.8), tool: { name: 'tell_kokoro', args: { text: 'Where should we stop?' } }, noEnd: true };
const FUEL = { said: 'The fuel station ahead is open until ten.', audio: tone(0.3) };

/** The user asks; she says "One moment." and asks Kokoro, whose note is ready at once. Resolves with when her sound began. @param {{ made?: false, turns?: any[] }} [o] @returns {Promise<[any, number]>} */
async function oneMoment({ made, turns = [CHECKING, FUEL] } = {}) {
  const k = await liveKit(turns, { pace: 1, agent: { secondMs: 1000 }, ...(made === false ? { live: { made } } : {}) });
  await k.voice.unlock();
  k.voice.route = async () => 'car';
  k.platform.streamSpeed = 1;
  k.agent.tap();
  await until(() => k.agent.live.listening, 3000);
  await say(k, 'where-eat');
  await soon(async () => k.agent.live.view.name === 'speaking', 5000);
  const at = Date.now();
  await soon(async () => (await k.events(['tool.result'])).some((/** @type {any} */ e) => e.data.half === 'koe'), 3000);
  await tell(k);
  return [k, at];
}
/** When the note went into the session, polled. @param {any} k */
async function noteIn(k) {
  await soon(async () => wentIn(k) === 1, 6000);
  return Date.now();
}

test('a silent tool call\'s turn with no turnComplete, all made: it ends as her sound does, so the dock leaves "speaking" and Kokoro\'s note goes in then', async () => {
  const [k, at] = await oneMoment();
  try {
    const inAt = await noteIn(k);
    assert.notEqual(k.platform.streams[0].playedMs, null, 'her stream for "One moment." is over: the dock no longer says she speaks it');
    assert.ok(inAt - (at + 800) < 600, `the note went in ${inAt - at - 800} ms after her sound`);
    await soon(async () => (await lines(k)).some(([text]) => text === FUEL.said), 5000);
    assert.deepEqual((await lines(k)).map(([text]) => text).slice(-2), ['One moment.', FUEL.said]);
  } finally {
    await k.done();
  }
});

test('a provider that never says: that turn still ends 2 s past her sound, the note waiting, as before', async () => {
  const [k, at] = await oneMoment({ made: false });
  try {
    await wait(at + 1300 - Date.now());
    assert.equal(k.agent.live.view.name, 'speaking', 'her sound is over, but her stream is not ended: the dock still says she speaks');
    const inAt = await noteIn(k);
    assert.ok(inAt - (at + 800) >= 1500, `the note went in ${inAt - at - 800} ms after her sound`);
  } finally {
    await k.done();
  }
});

// The same turn when its turnComplete does come, 100 ms after her sound: the note goes in at made, before it, and Gemini ends the turn it meets
// with interrupted and its turnComplete 20 ms later (19 of 19 real turns, 2026-11-12). That is the end of the turn annai had ended, not an answer
// to the note: the note's 8 s wait runs on, and a session that is silent on it is asked again (as it is when no turnComplete came at all).
const CHECKING_ENDS = { ...CHECKING, noEnd: false, endAt: 900 };

test('the provider ends that turn with interrupted after the note went in, and is silent on the note: the wait for its answer runs on, the note is asked again and said', async () => {
  const [k] = await oneMoment({ turns: [CHECKING_ENDS, { silent: true }, FUEL] });
  try {
    await noteIn(k);
    await soon(async () => (await k.events(['error'])).some((/** @type {any} */ e) => e.data.kind === 'live-silent'), 12_000);
    await soon(async () => (await lines(k)).some(([text]) => text === FUEL.said), 8000);
    assert.equal(wentIn(k), 2, 'a fresh session got the note again');
    assert.deepEqual((await lines(k)).map(([text]) => text).slice(-2), ['One moment.', FUEL.said]);
  } finally {
    await k.done();
  }
});

test("the provider ends that turn with interrupted after the note went in: the first words of its answer, before its first sound, are kept in her line", async () => {
  const [k] = await oneMoment({ turns: [CHECKING_ENDS, { ...FUEL, saidFirst: true }] });
  try {
    await soon(async () => (await lines(k)).length === 2, 5000);
    assert.deepEqual(await lines(k), [['One moment.', false], [FUEL.said, false]]);
  } finally {
    await k.done();
  }
});
