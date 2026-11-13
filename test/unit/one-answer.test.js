// One answer: a note (or a reminder) whose words sound cut off is handled as a tap's cut is: what the user didn't hear is shown at once, silently,
// and nothing is asked again, so the provider's answer to what the microphone heard is the only one; Kokoro reads Koe's answer before she starts,
// for what both halves were given at once; and Koe passes on what the user said, as said. Lines and places are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until, agentKit } from './agent-kit.js';
import { liveKit, texts, soon, tone, say } from './koe-live-kit.js';
import { hum, quiet, cat, clip } from './voice-kit.js';
import { KOE_CORE, KOE_LIVE } from '../../src/core/koe/instructions.js';
import { channelTool } from '../../src/core/agent/halves.js';

const RATE = 16_000;
const FOR_USER = 'The fuel station ahead is open until ten tonight.';
const NOTE = 'Tell the user the fuel station ahead is open until ten tonight.';
const SAID = 'The fuel station ahead is open until ten tonight.';
/** Kokoro's tell_koe with for_user, as its tool sends it. @param {any} k */
const tell = (k) => k.agent.channel.send('kokoro', NOTE, 'append', 'tool', undefined, undefined, false, FOR_USER);
/** What annai showed for Shiori (the note's words for the user, a reminder), and whether annai's own voice said it. @param {any} k */
const shown = async (k) => (await k.events(['reminder'])).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.aloud)]);
/** The text turns annai sent asking her once more about a note (the plain ask, or any other). @param {any} k */
const asks = (k) => textsIn(k).filter((t) => /^\[annai\] /.test(t) && /Kokoro's note|cut you off|say it again/i.test(t));
/** The text turns the stand-in got, either flavour's. @param {any} k @returns {string[]} */
const textsIn = (k) => k.server.received().flatMap((/** @type {any} */ m) => (m.clientContent ? texts({ server: { received: () => [m] } })
  : m.type === 'conversation.item.create' ? (m.item?.content ?? []).filter((/** @type {any} */ p) => p.text).map((/** @type {any} */ p) => p.text) : []));
/** Her lines, as written: words, and whether cut. @param {any} k */
const lines = async (k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.cut)]);
/** How many times the note was heard whole. @param {any} k */
const wholeNotes = async (k) => (await lines(k)).filter(([text, cut]) => text === SAID && !cut).length;
/** A second, in the cut tests: a real one, so the session's quiet spell (30 s) outlasts the provider's second answer; the kit's 10 ms makes it 0.3 s. */
const REAL_SECOND = 1000;
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A live session in a car (sound at the microphone may cut her; speaker: on the phone's speaker, where it doesn't while she speaks), the user in
 * it: a first exchange, then Kokoro's note (or a reminder's wake), which she begins to say. turns: what the stand-in answers after it, in order;
 * first: what is said into it (default: Kokoro's note); begun: wait only until her sound for the note began, which may be before her first word.
 * @param {{ turns?: any[], pace?: number, note?: any, second?: number, live?: any, first?: (k: any) => Promise<unknown>, speaker?: boolean, begun?: boolean }} [o]
 */
async function noteSaid({ turns = [], pace = 1, note = { said: SAID, audio: tone(3) }, second = REAL_SECOND, live, first = tell, speaker = false, begun = false } = {}) {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, note, ...turns], { pace, agent: { secondMs: second }, ...(live ? { live } : {}) });
  await k.voice.unlock();
  if (!speaker) k.voice.route = async () => 'car';
  k.platform.streamSpeed = 1;
  k.agent.tap(); // the user is in this session, so she stays cuttable
  await until(() => k.agent.live.listening, 3000);
  await say(k, 'where-eat');
  await soon(async () => (await k.events(['out.speak'])).length === 1, 4000);
  await k.agent.live.idle();
  k.platform.mic.feed(quiet(0.5), RATE);
  await first(k);
  if (begun) {
    await soon(async () => textsIn(k).some((t) => t.includes('<from_kokoro')), 3000);
    await wait(300); // her sound for it has begun; its words come later
  } else await soon(async () => k.agent.live.view.name === 'speaking', 3000);
  return k;
}

/** A bump at the microphone, over her, once some of her words have been heard: a turn of its own. @param {any} k */
async function bump(k) {
  await wait(500);
  k.platform.mic.feed(cat(hum(0.8), quiet(1)), RATE);
}

test('a note cut by a sound as she says it is shown at once, silently, as a tap does; nothing is asked again, so the answer to the sound is the only one', async () => {
  // The provider's answer to the sound's own turn goes on from where its record of her words stops, as in a recorded drive.
  const k = await noteSaid({ turns: [{ said: 'open until ten tonight.', audio: tone(0.5), delayMs: 400 }] });
  try {
    await bump(k);
    await soon(async () => (await lines(k)).some(([text, cut]) => text === 'open until ten tonight.' && !cut), 8000);
    await wait(1500); // anything more the session gave would be here by now
    await k.agent.idle();
    assert.deepEqual(asks(k), [], 'nothing is asked again');
    assert.deepEqual(await shown(k), [[FOR_USER, false]], 'what the user didn\'t hear is shown, and not said');
    assert.ok(!k.said.some((/** @type {string} */ t) => t.includes('fuel station')), "annai's own voice says nothing of it");
    assert.deepEqual(await lines(k), [['Hello there.', false], ['The fuel✂', true], ['open until ten tonight.', false]], 'the cut words kept, marked; her answer to the sound stands');
  } finally {
    await k.done();
  }
});

test('a "what?" over her, which Gemini answers with her last words again: the note is heard whole once after the cut, and shown once', async () => {
  const k = await noteSaid({ turns: [{ heard: 'What?', said: SAID, audio: tone(0.5), delayMs: 400 }] });
  try {
    await bump(k);
    await soon(async () => (await wholeNotes(k)) === 1, 8000);
    await wait(1500);
    await k.agent.idle();
    assert.equal(await wholeNotes(k), 1, 'heard whole once: no ask beside the user\'s turn, so no second answer');
    assert.deepEqual(asks(k), []);
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
  } finally {
    await k.done();
  }
});

test('"stop" over her, and nothing at all back (Gemini\'s way of letting a turn go): the note is shown, silently; no ask, no fresh session, live voice stays', async () => {
  // 400 ms a second: the session's wait for an answer is 3.2 s, its quiet spell 12 s, so a retry (a fresh session at 3.2 s, then live voice
  // dropped at 6.4 s, as an ask left unanswered got) would show within the 9 s waited here.
  const k = await noteSaid({ turns: [{ silent: true }], second: 400 });
  try {
    await bump(k);
    await soon(async () => (await shown(k)).length === 1, 4000);
    await wait(9000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[FOR_USER, false]], 'shown at the cut, not said');
    assert.deepEqual(asks(k), [], 'nothing asked: a "stop" needs no clause of annai\'s');
    assert.equal(k.server.received().filter((/** @type {any} */ m) => m.setup).length, 1, 'no fresh session');
    const errors = (await k.events(['error'])).map((/** @type {any} */ e) => e.data.kind);
    assert.ok(!errors.includes('live-dropped'), JSON.stringify(errors));
    assert.equal(k.agent.koeState, 'live', 'live voice stays');
    assert.ok(!k.said.some((/** @type {string} */ t) => t.includes('fuel station')), "annai's own voice says nothing of it");
  } finally {
    await k.done();
  }
});

test('the provider done before the sound cut her voice: shown at once as well, and nothing asked (the release asked her once, and she said it again)', async () => {
  // The note's turn ends at the provider at once (pace 0); her voice plays it out in real time, and the sound cuts that.
  const k = await noteSaid({ pace: 0, note: { said: SAID, audio: tone(1.5) }, turns: [{ delayMs: 400 }] });
  try {
    await bump(k);
    await soon(async () => (await shown(k)).length === 1, 4000);
    await wait(1500);
    await k.agent.idle();
    assert.deepEqual(asks(k), []);
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
    assert.equal(await wholeNotes(k), 0);
  } finally {
    await k.done();
  }
});

test('cut twice: the note is shown once, at the first cut, and nothing of it is said again, so the second sound cuts only her answer to the first', async () => {
  const k = await noteSaid({ turns: [{ said: 'Open until ten tonight, as I said.', audio: tone(3), delayMs: 400 }, { delayMs: 400 }] });
  try {
    await bump(k);
    await soon(async () => (await shown(k)).length === 1, 4000);
    await soon(async () => k.agent.live.view.name === 'speaking', 4000); // her answer to the first sound
    await bump(k);
    await soon(async () => (await lines(k)).filter(([, cut]) => cut).length === 2, 4000);
    await wait(1500);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[FOR_USER, false]], 'shown once, and never said');
    assert.deepEqual(asks(k), []);
    assert.ok(!k.said.some((/** @type {string} */ t) => t.includes('fuel station')));
  } finally {
    await k.done();
  }
});

test('a reminder Koe says, cut by a sound: shown at once as a reminder, silently; annai neither asks nor says it', async () => {
  const sunset = { kind: /** @type {const} */ ('trigger'), text: 'Sunset in 30 minutes', fallbacks: [{ watch: 'sun', text: 'Sunset at 18:40' }] };
  const k = await noteSaid({ note: { said: 'The sun sets at 18:40, in thirty minutes.', audio: tone(3) }, turns: [{ delayMs: 400 }], first: (x) => x.agent.wake(sunset) });
  try {
    await bump(k);
    await soon(async () => (await shown(k)).length === 1, 4000);
    await wait(1500);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [['Sunset at 18:40', false]], 'shown, not said');
    assert.ok(!k.said.some((/** @type {string} */ t) => /Sunset/.test(t)), "annai's own voice doesn't say it");
    assert.deepEqual(asks(k), []);
  } finally {
    await k.done();
  }
});

for (const [what, answer] of /** @type {const} */ ([['says the note again', { said: SAID, audio: tone(0.5) }], ['says nothing', {}]])) {
  test(`on OpenAI Realtime too, her answer to the sound ${what}: the note is shown once, silently, and nothing is asked, so that answer is the only one`, async () => {
    // OpenAI's response.done comes as generation ends (pace 0.05), before her voice has played it out: the path where the release asked her
    // again, answered after her answer to the user's turn (so she said the note twice, or annai showed it and she said it too).
    const k = await noteSaid({ live: { type: 'openai-realtime' }, pace: 0.05, turns: [answer, { said: SAID, audio: tone(0.5) }] });
    try {
      await bump(k);
      await soon(async () => (await shown(k)).length === 1, 8000);
      await wait(2000);
      await k.agent.idle();
      assert.equal(await wholeNotes(k), 'said' in answer ? 1 : 0, 'heard whole at most once');
      assert.deepEqual(asks(k), []);
      assert.deepEqual(await shown(k), [[FOR_USER, false]]);
    } finally {
      await k.done();
    }
  });
}

test('a drop as she says a note is no sound: the resumed session gets the note again, and nothing is shown', async () => {
  const k = await noteSaid({ turns: [{ said: SAID, audio: tone(0.3) }] });
  try {
    await wait(500);
    k.server.close(1011, 'Internal error encountered.');
    await soon(async () => (await wholeNotes(k)) === 1, 8000);
    await wait(3000); // a second saying of it would be here by now
    await k.agent.idle();
    assert.equal(await wholeNotes(k), 1, 'heard whole once');
    assert.equal(k.server.received().filter((/** @type {any} */ m) => m.setup).length, 2, 'resumed');
    assert.equal(textsIn(k).filter((t) => t.includes('<from_kokoro')).length, 2, 'the note went in again');
    assert.deepEqual(asks(k), []);
    assert.deepEqual(await shown(k), []);
  } finally {
    await k.done();
  }
});

// A note that goes into a session again (a drop, or the page out of view, as she says it) is one annai never heard said whole, so her "I already told
// them" (already_told) doesn't settle it: she is asked once more, and if she still doesn't say it, annai shows it and says it itself. A note she never
// began goes in again too, and her saying it settles it as for any note.
const TOLD = { tool: { name: 'already_told', args: {} } };
const AGAIN = { said: SAID, audio: tone(0.3) };
/** Gemini's own close, as a dropped connection arrives. @param {any} k */
const drop = (k) => k.server.close(1011, 'Internal error encountered.');
/** How many times the note went into a session. @param {any} k */
const wentIn = (k) => textsIn(k).filter((/** @type {string} */ t) => t.includes('<from_kokoro')).length;
/** The sessions the stand-in set up. @param {any} k */
const sessions = (k) => k.server.received().filter((/** @type {any} */ m) => m.setup).length;
/** annai shows the note and says it with its own voice, after asking her once. @param {any} k */
async function shownAndSaid(k) {
  await soon(async () => (await shown(k)).length === 1, 45_000);
  await k.agent.idle();
  assert.deepEqual(await shown(k), [[FOR_USER, true]], 'shown, and said by annai');
  assert.equal(k.said.filter((/** @type {string} */ t) => t.includes('fuel station')).length, 1, "annai's own voice says it once");
  assert.equal(asks(k).length, 1, 'she was asked once more');
}

for (const [what, turns] of /** @type {[string, any[]][]} */ ([['and nothing when asked once more', [TOLD, {}]], ['and again when asked once more', [TOLD, TOLD]]])) {
  test(`a drop as she says a note, and the resumed session says it was already told ${what}: she is asked once, then annai shows the note and says it`, async () => {
    const k = await noteSaid({ turns });
    try {
      await wait(500);
      drop(k);
      await shownAndSaid(k);
      assert.equal(sessions(k), 2, 'resumed');
      assert.equal(wentIn(k), 2, 'the note went in again');
      assert.equal(await wholeNotes(k), 0, 'she never said it whole');
    } finally {
      await k.done();
    }
  });
}

test('a drop as she says a note, "already told" from the resumed session, and she says it when asked once more: heard whole once, nothing shown, annai says nothing', async () => {
  const k = await noteSaid({ turns: [TOLD, AGAIN] });
  try {
    await wait(500);
    drop(k);
    await soon(async () => (await wholeNotes(k)) === 1, 45_000);
    await wait(6000); // anything more would be here by now
    await k.agent.idle();
    assert.equal(await wholeNotes(k), 1, 'heard whole once');
    assert.equal(asks(k).length, 1, 'asked once');
    assert.deepEqual(await shown(k), []);
    assert.ok(!k.said.some((/** @type {string} */ t) => t.includes('fuel station')), "annai's own voice says nothing of it");
  } finally {
    await k.done();
  }
});

test('a drop after her sound for the note has played out, before the provider ends the turn: the note is heard whole once, not again after the drop', async () => {
  const k = await noteSaid({ note: { said: SAID, audio: tone(1.5), endAt: 1900 }, turns: [AGAIN] });
  try {
    await wait(1650);
    drop(k);
    await soon(async () => sessions(k) === 2, 8000);
    await wait(6000);
    await k.agent.idle();
    assert.equal(await wholeNotes(k), 1, 'said once');
    assert.equal(wentIn(k), 1, 'not sent again: she had said it');
    assert.deepEqual(asks(k), []);
    assert.deepEqual(await shown(k), []);
  } finally {
    await k.done();
  }
});

// The page out of view (or another close) in the moment after her sound for a note has all played, before the provider ends her turn: the note was
// heard whole, so it passes on as at a tap, and nothing sends it again or shows it.
for (const [what, answer] of /** @type {const} */ ([['she would say it again', AGAIN], ['she would say she already told them', TOLD]])) {
  test(`the page out of view after her sound for the note has played out, before the provider ends her turn, and back (${what}): heard whole once, not sent again, nothing shown or asked`, async () => {
    const k = await noteSaid({ note: { said: SAID, audio: tone(1.5), endAt: 1900 }, turns: [answer] });
    try {
      await wait(1650);
      hidden(true);
      k.agent.hush('away');
      await wait(1000);
      hidden(false);
      await k.agent.shown();
      await wait(6000);
      await k.agent.idle();
      assert.equal(await wholeNotes(k), 1, 'said once');
      assert.equal(wentIn(k), 1, 'not sent again: she had said it');
      assert.deepEqual(asks(k), []);
      assert.deepEqual(await shown(k), []);
      assert.ok(!k.said.some((/** @type {string} */ t) => t.includes('fuel station')), "annai's own voice says nothing of it");
    } finally {
      hidden(false);
      await k.done();
    }
  });
}

test("another trip opened after her sound for the note has played out, before the provider ends her turn: heard whole, so no \"Shiori's answer\" for it in the trip left", async () => {
  const k = await noteSaid({ note: { said: SAID, audio: tone(1.5), endAt: 1900 } });
  try {
    await wait(1650);
    const { createTrip } = await import('../../src/core/scopes.js');
    const other = await createTrip(k.ws, { title: 'Carmel' });
    await k.agent.open(other);
    await k.agent.idle();
    await wait(300);
    const whole = async (/** @type {string} */ trip) => (await inTrip(k, trip, ['out.speak'])).filter((/** @type {any} */ e) => e.data.text === SAID && !e.data.cut).length;
    assert.equal((await whole(k.trip)) + (await whole(other)), 1, 'her line, written once (in whichever conversation the write found open: not this change\'s)');
    assert.deepEqual(await entries(k, k.trip), [], 'no card in the trip left');
    assert.deepEqual(await entries(k, other), []);
  } finally {
    await k.done();
  }
});

for (const [what, answer, said] of /** @type {const} */ ([['"already told"', TOLD, false], ['the note', AGAIN, true]])) {
  test(`a drop before her sound for the note began, the resumed session answers ${what}: ${said ? 'heard whole once, nothing shown' : 'asked once more, then annai shows the note and says it'}`, async () => {
    const k = await noteSaid({ begun: true, note: { said: SAID, audio: tone(3), delayMs: 1500 }, turns: [answer] });
    try {
      await wait(300);
      drop(k);
      if (said) {
        await soon(async () => (await wholeNotes(k)) === 1, 45_000);
        await wait(6000);
        await k.agent.idle();
        assert.equal(await wholeNotes(k), 1);
        assert.deepEqual(asks(k), []);
        assert.deepEqual(await shown(k), []);
      } else await shownAndSaid(k);
      assert.equal(wentIn(k), 2, 'the note went in again');
    } finally {
      await k.done();
    }
  });
}

for (const [what, answer, said] of /** @type {const} */ ([['"already told"', TOLD, false], ['the note', AGAIN, true]])) {
  test(`the page out of view as she says a note, and back, the resumed session answers ${what}: ${said ? 'heard whole, nothing shown' : 'asked once more, then annai shows the note and says it'}`, async () => {
    const k = await noteSaid({ turns: [answer] });
    try {
      await wait(500);
      hidden(true);
      k.agent.hush('away');
      await wait(1000);
      hidden(false);
      await k.agent.shown();
      if (said) {
        await soon(async () => (await wholeNotes(k)) === 1, 45_000);
        await wait(6000);
        await k.agent.idle();
        assert.equal(await wholeNotes(k), 1);
        assert.deepEqual(asks(k), []);
        assert.deepEqual(await shown(k), []);
      } else await shownAndSaid(k);
      assert.equal(wentIn(k), 2, 'the note went in again');
    } finally {
      hidden(false);
      await k.done();
    }
  });
}

test('"already told" for a note that never went in again settles it: nothing asked, nothing shown, nothing said by annai', async () => {
  const k = await noteSaid({ begun: true, note: TOLD });
  try {
    await wait(6000); // the ask, and what it shows, would be here by now
    await k.agent.idle();
    assert.deepEqual(asks(k), []);
    assert.deepEqual(await shown(k), []);
    assert.ok(!k.said.some((/** @type {string} */ t) => t.includes('fuel station')));
    assert.equal(sessions(k), 1);
  } finally {
    await k.done();
  }
});

// The rule is one, at the start of the user's turn: what Kokoro's notes went in and weren't passed on is shown, silently, and settled, whatever
// of it her sound had begun. So a note is never lost for a sound that cut her before her first word (her words follow her sound), whatever she
// answers to the sound, and she is never asked to say it again.
const LATE = { said: SAID, audio: tone(3), saidAt: 2500 };
for (const [what, answer] of /** @type {const} */ ([
  ['already_told: she believes she said it', { heard: 'la la', tool: { name: 'already_told', args: {} } }],
  ['words of her own', { heard: 'What?', said: 'Of course, one moment.', audio: tone(0.5) }],
  ['nothing at all, as after "stop"', { heard: 'Stop.' }],
])) {
  test(`a sound cuts her after a note went in and her sound began, before her first word, and her answer to it is ${what}: the note is shown at once, silently, and nothing is asked`, async () => {
    const k = await noteSaid({ begun: true, note: LATE, turns: [answer] });
    try {
      await bump(k);
      await soon(async () => (await shown(k)).length === 1, 4000);
      await wait(1500); // the ask the release sent, and whatever she answered to it, would be here by now
      await k.agent.idle();
      assert.deepEqual(await shown(k), [[FOR_USER, false]], 'shown once, and not said');
      assert.deepEqual(asks(k), [], 'she is not asked to say it');
      assert.ok(!k.said.some((/** @type {string} */ t) => t.includes('fuel station')), "annai's own voice says nothing of it");
    } finally {
      await k.done();
    }
  });
}

test("on the phone's speaker, a note that comes as the user's turn ends waits for her answer to them, held for their pause, and is then said, not shown", async () => {
  // Half-duplex: her voice waits HOLD_MS after the user's last turn ended, in case they go on. One input at a time (spec §7.1, 2026-11-12): the
  // note waited for that turn's end, and now waits for her answer to it too, so it never goes in beside the user's turn (it went in as the turn
  // ended before, and the user going on while her voice for it waited showed it on a card).
  const meanwhile = async (/** @type {any} */ k) => {
    k.platform.mic.feed(hum(0.8), RATE);
    await tell(k);
    k.platform.mic.feed(quiet(1), RATE);
  };
  const k = await noteSaid({ speaker: true, pace: 0, first: meanwhile, note: { heard: 'Also,', said: 'Go on.', audio: tone(0.3) }, turns: [{ said: SAID, audio: tone(1.5) }, { said: 'Of course.', audio: tone(0.3), delayMs: 300 }] });
  try {
    assert.ok(!textsIn(k).some((t) => t.includes('<from_kokoro')), 'not in while her answer to them plays');
    await soon(async () => (await lines(k)).some(([text, cut]) => text === SAID && !cut), 8000);
    await k.agent.idle();
    assert.deepEqual((await lines(k)).map(([text]) => text), ['Hello there.', 'Go on.', SAID]);
    assert.deepEqual(await shown(k), [], 'said, so not shown');
    assert.deepEqual(asks(k), []);
  } finally {
    await k.done();
  }
});

// What Kokoro meant for the user that isn't a note's for_user words: her own speak, a card or a question, which Koe is given as notes while it
// talks (gated). Cut inside one, by a sound or by a tap, annai shows it as it does when Koe never passes it on: silently, once, never lost.
const CARD = { title: 'Fuel', text: 'Open until ten tonight.' };
const ASK = { question: 'Fill up here?', options: ['Yes', 'No'] };
const GATED = /** @type {const} */ ({
  speak: { why: 'gated:speak', text: FOR_USER, call: { name: 'speak', input: { text: FOR_USER } } },
  show: { why: 'gated:show', text: 'Kokoro wants to show: Fuel: Open until ten tonight.', call: { name: 'show', input: { card: CARD } } },
  ask: { why: 'gated:ask', text: 'Kokoro wants to ask: Fill up here? (Yes, No)', call: { name: 'ask', input: ASK } },
});
/** What annai showed of a gated note: the words (a reminder entry, with whether it was said), the card, or the question. @param {any} k @param {keyof typeof GATED} kind */
const showing = async (k, kind) => (kind === 'speak' ? shown(k) : (await k.events([kind === 'show' ? 'out.show' : 'out.ask'])).map((/** @type {any} */ e) => (kind === 'show' ? e.data.card : [e.data.question, e.data.options])));
const SHOWING = { speak: [[FOR_USER, false]], show: [CARD], ask: [[ASK.question, ASK.options]] };

for (const kind of /** @type {const} */ (['speak', 'show', 'ask'])) {
  for (const by of /** @type {const} */ (['a sound', 'a tap'])) {
    test(`Kokoro's gated ${kind}, which Koe is saying, cut by ${by}: annai shows it at once, silently, once; nothing is said or asked`, async () => {
      const { why, text, call } = GATED[kind];
      const k = await noteSaid({ first: (x) => x.agent.channel.send('kokoro', text, 'append', why, undefined, call, false, ''), turns: [{ delayMs: 400 }] });
      try {
        if (by === 'a tap') assert.equal(k.agent.live.tap(), 'cut');
        else await bump(k);
        await soon(async () => (await showing(k, kind)).length === 1, 4000);
        await wait(1500);
        await k.agent.idle();
        assert.deepEqual(await showing(k, kind), SHOWING[kind], 'shown once');
        if (kind !== 'speak') assert.deepEqual(await shown(k), [], 'as itself, not as words');
        assert.deepEqual(k.said, [], "annai's own voice says nothing");
        assert.deepEqual(asks(k), []);
      } finally {
        await k.done();
      }
    });
  }
}

// Two things owed at once, and shown one after the other: each goes into the conversation it belongs to, whichever the user has since opened. A switch
// to another trip moves the open conversation at once, while the first card is still being written.
const COAST = 'The coast road is closed at the bridge until noon.';
/** Kokoro's note with words for the user (for_user), as its tool sends it. @param {any} k @param {string} words */
const tellWords = (k, words) => k.agent.channel.send('kokoro', `Tell the user: ${words}`, 'append', 'tool', undefined, undefined, false, words);
/** What a conversation holds of what annai showed for Shiori: the words, and whether they were hers. @param {any} k @param {string | null} trip */
const entries = async (k, trip) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(trip, { types: ['reminder'] }))).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.answer)]);

/** A live session where the user is part-way through a sentence, so what Kokoro sends for them waits, owed. @param {(k: any) => Promise<unknown>} items */
async function owing(items) {
  const k = await liveKit([{ heard: 'Tell me a story.', said: 'Sure.', audio: tone(0.2) }]);
  const lunch = await clip('where-lunch');
  k.agent.tap();
  await until(() => k.agent.live.listening && k.platform.log.includes('mic open'));
  k.platform.mic.feed(cat(quiet(0.5), lunch.subarray(0, lunch.length >> 1)), RATE); // still speaking: the notes wait
  await until(() => k.agent.live.view.name === 'hearing');
  await items(k);
  await until(() => k.agent.live.owing);
  return k;
}

const AT_A_SWITCH = /** @type {const} */ ([
  ['two notes with words for the user', async (/** @type {any} */ k) => { await tellWords(k, FOR_USER); await tellWords(k, COAST); }, [[FOR_USER, true], [COAST, true]]],
  ['a note, then a reminder', async (/** @type {any} */ k) => { await tellWords(k, FOR_USER); await k.agent.wake(SUNSET); }, [[FOR_USER, true], ['Sunset at 18:40', false]]],
  ['a reminder, then a note', async (/** @type {any} */ k) => { await k.agent.wake(SUNSET); await until(() => k.agent.live.owing); await tellWords(k, FOR_USER); }, [['Sunset at 18:40', false], [FOR_USER, true]]],
]);
for (const [what, items, want] of AT_A_SWITCH) {
  test(`${what} still owed when the user switches to another trip: both are written in the trip left, and the trip opened gets nothing`, async () => {
    const k = await owing(items);
    try {
      const { createTrip } = await import('../../src/core/scopes.js');
      const other = await createTrip(k.ws, { title: 'Carmel' });
      await k.agent.open(other);
      await k.agent.idle();
      await soon(async () => (await entries(k, k.trip)).length + (await entries(k, other)).length >= want.length, 4000);
      await wait(300); // anything late
      assert.deepEqual(await entries(k, other), [], 'none in the trip opened');
      assert.deepEqual([...(await entries(k, k.trip))].sort(), [...want].sort(), 'both, in the trip left');
      assert.deepEqual(k.said, [], 'not said');
    } finally {
      await k.done();
    }
  });
}

test('one note with words for the user still owed when the user switches to another trip: written in the trip left, and the trip opened gets nothing', async () => {
  const k = await owing((x) => tellWords(x, FOR_USER));
  try {
    const { createTrip } = await import('../../src/core/scopes.js');
    const other = await createTrip(k.ws, { title: 'Carmel' });
    await k.agent.open(other);
    await k.agent.idle();
    await soon(async () => (await entries(k, k.trip)).length === 1, 4000);
    await wait(300);
    assert.deepEqual(await entries(k, k.trip), [[FOR_USER, true]]);
    assert.deepEqual(await entries(k, other), []);
  } finally {
    await k.done();
  }
});

// A card, a question or a spoken line Kokoro made while Koe talks, held for Koe, when the user switches to another trip or starts fresh before Koe passes
// it on: the card and the line are written, silently, into the conversation left (above the divider), the card as the same record a card annai shows
// at once leaves; the question is let go, with only a Trace line: nobody can answer it in a conversation they left.
/** A conversation's entries of these types, oldest first. @param {any} k @param {string} trip @param {string[]} types */
const inTrip = (k, trip, types) => k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(trip, { types }));
for (const how of /** @type {const} */ (['a switch to another trip', 'Start fresh'])) {
  for (const kind of /** @type {const} */ (['show', 'ask', 'speak'])) {
    test(`Kokoro's gated ${kind} still held for Koe at ${how}: ${kind === 'ask' ? 'let go, with only a Trace line' : 'written, silently, into the conversation left'}; nothing anywhere else, nothing said`, async () => {
      const { why, text, call } = GATED[kind];
      const k = await owing((x) => x.agent.channel.send('kokoro', text, 'append', why, undefined, call, false, ''));
      try {
        const { createTrip } = await import('../../src/core/scopes.js');
        const other = await createTrip(k.ws, { title: 'Carmel' });
        if (how === 'Start fresh') assert.equal(await k.agent.startFresh(), 'done');
        else await k.agent.open(other);
        await k.agent.idle();
        await wait(300); // anything late
        const left = await inTrip(k, k.trip, ['out.show', 'out.ask', 'reminder', 'error', 'compaction']);
        const lines = left.map((/** @type {any} */ e) => (e.type === 'out.show' ? ['card', e.data.card, e.actor, e.data.half, 'by' in e.data]
          : e.type === 'out.ask' ? ['question', e.data.question] : e.type === 'reminder' ? ['words', e.data.text, Boolean(e.data.answer), Boolean(e.data.aloud)]
            : e.type === 'error' ? ['trace', e.data.kind, e.data.quiet, /question/.test(e.data.message)] : ['fresh']));
        const want = kind === 'show' ? [['card', CARD, 'shiori', 'kokoro', true]] : kind === 'speak' ? [['words', FOR_USER, true, false]] : [['trace', 'unshown', true, true]];
        assert.deepEqual(lines, [...want, ...(how === 'Start fresh' ? [['fresh']] : [])], 'in the conversation left, above the divider at Start fresh');
        assert.deepEqual(await inTrip(k, other, ['out.show', 'out.ask', 'reminder', 'error']), [], 'nothing in the trip opened');
        assert.deepEqual(k.said, [], 'nothing said');
      } finally {
        await k.done();
      }
    });
  }
}

// Two notes at once go in one at a time (spec §7.1, 2026-11-12): a cut shows the one in flight; the other goes in after it, and is said.
test("two notes with words for the user at once, and a tap in her answer to the first: the first is shown at once, silently, once; the second goes in after the tap and is said", async () => {
  const both = async (/** @type {any} */ k) => { await Promise.all([tellWords(k, FOR_USER), tellWords(k, COAST)]); };
  const k = await noteSaid({ first: both, turns: [{ said: COAST, audio: tone(1) }] });
  try {
    assert.ok(!textsIn(k).some((t) => t.includes(COAST)), 'the second waits');
    assert.equal(k.agent.live.tap(), 'cut');
    await soon(async () => (await lines(k)).some(([text, cut]) => text === COAST && !cut), 8000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[FOR_USER, false]], 'the first, once, never said');
    assert.ok(textsIn(k).some((t) => t.includes(COAST)), 'the second went in');
    assert.deepEqual(asks(k), []);
  } finally {
    await k.done();
  }
});

test("two notes with words for the user at once, and the user begins before her sound for the first: the first is shown, silently, once; the second goes in after her answer to them", async () => {
  const both = async (/** @type {any} */ k) => { await Promise.all([tellWords(k, FOR_USER), tellWords(k, COAST)]); };
  const k = await noteSaid({ first: both, begun: true, note: LATE, turns: [{ said: 'Go on.', audio: tone(0.3) }, { said: COAST, audio: tone(1) }] });
  try {
    await bump(k);
    await soon(async () => (await lines(k)).some(([text, cut]) => text === COAST && !cut), 10_000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[FOR_USER, false]], 'the first, once, never said');
    assert.deepEqual(asks(k), []);
  } finally {
    await k.done();
  }
});

// A note with no words for the user (a correction or an instruction for Koe): its text is for Koe, so annai can't show it, and it isn't sent again at
// the end of the cutting turn (that second input is what doubled a note). What Kokoro reads of it is Koe's own cut line, with its ✂: she decides.
const CORRECTION = 'Correction: the fuel station closes at nine, not ten. Say so.';
const correct = (/** @type {any} */ k) => k.agent.channel.send('kokoro', CORRECTION, 'append', 'tool', undefined, undefined, false, '');
const closes = { said: 'Correction: it closes at nine, not ten.', audio: tone(3) };
/** Koe's lines as Kokoro's transcript holds them, from the user's first words on. @param {any} k */
const kokoroLines = (k) => k.agent.kokoro.transcript.messages.flatMap((/** @type {any} */ m) => m.parts.map((/** @type {any} */ p) => (p.type === 'text' ? p.text : '')));
const CUT_LINE = /^\[Koe said aloud\] "[^"]*✂"$/;

test('a note with no words for the user, cut by a sound as she says it, and the user says something: it is neither shown nor sent again; Kokoro reads her cut line when she is woken', async () => {
  const k = await noteSaid({ note: closes, first: correct, turns: [{ heard: 'What?', said: 'Go on.', audio: tone(0.4), delayMs: 300 }] });
  try {
    await bump(k);
    await soon(async () => (k.sent['model-0']?.length ?? 0) >= 1, 8000);
    await wait(1500);
    await k.agent.idle();
    assert.equal(textsIn(k).filter((t) => t.includes('<from_kokoro')).length, 1, 'the note went in once, and is not sent again');
    assert.deepEqual(asks(k), []);
    assert.deepEqual(await shown(k), [], 'its text is for Koe: nothing for the user to see');
    assert.deepEqual(k.said, []);
    const read = k.sent['model-0'][0].messages.flatMap((/** @type {any} */ m) => m.parts.map((/** @type {any} */ p) => (p.type === 'text' ? p.text : '')));
    assert.ok(read.some((t) => CUT_LINE.test(t)), `Kokoro's request holds Koe's line, cut: ${JSON.stringify(read)}`);
    assert.ok(read.indexOf(read.find((/** @type {string} */ t) => CUT_LINE.test(t))) < read.findIndex((/** @type {string} */ t) => t.includes('"Go on."')), 'before what Koe said next');
  } finally {
    await k.done();
  }
});

test('the same, cut by a plain noise and nothing follows: nothing is sent again, and her transcript holds Koe\'s cut line for whenever she next takes a turn (no wake of annai\'s own)', async () => {
  const k = await noteSaid({ note: closes, first: correct, turns: [{ delayMs: 300 }] });
  try {
    await bump(k);
    await wait(4000);
    await k.agent.idle();
    assert.equal(textsIn(k).filter((t) => t.includes('<from_kokoro')).length, 1);
    assert.deepEqual(asks(k), []);
    assert.deepEqual(await shown(k), []);
    assert.equal(k.sent['model-0'], undefined, 'nothing woke Kokoro: the noise was no one\'s words');
    assert.ok(kokoroLines(k).some((t) => CUT_LINE.test(t)), JSON.stringify(kokoroLines(k)));
  } finally {
    await k.done();
  }
});

// Kokoro reads Koe's answer before she starts, for what both halves were given (a typed line, a wake with reminders): her first request then
// holds it, and her "on it" or the reminder isn't said a second time.

/** Every text of a request's user messages. @param {any} req */
const userTexts = (req) => req.messages.filter((/** @type {any} */ m) => m.role === 'user').flatMap((/** @type {any} */ m) => m.parts.filter((/** @type {any} */ p) => p.type === 'text').map((/** @type {any} */ p) => p.text));
/** A second, in these tests: the live wait for Koe's answer is 8 of them (3.2 s), the quiet the user's input needs 1.5 (0.6 s). */
const SECOND = 400;
/** When each of Kokoro's model calls began (model-0 is hers). @returns {{ starts: number[], hold: (c: any) => Promise<void> }} */
function kokoroStarts() {
  /** @type {number[]} */
  const starts = [];
  return { starts, hold: async (c) => { if (c.model.providerId === 'model-0') starts.push(Date.now()); } };
}
/** The page out of view, or back, as the browser says it. @param {boolean} on */
function hidden(on) {
  if (on) /** @type {any} */ (globalThis).document = { visibilityState: 'hidden' };
  else delete (/** @type {any} */ (globalThis).document);
}

test("a typed line in live voice: Kokoro's turn waits for Koe's answer, so her first request holds Koe's line", async () => {
  const { starts, hold } = kokoroStarts();
  const k = await liveKit([{ said: 'Hello. What can I do?', audio: tone(0.3), delayMs: 1000 }], { agent: { secondMs: SECOND }, hold });
  try {
    const sent = Date.now();
    k.agent.send('hello?');
    await until(() => starts.length > 0, 8000);
    await k.agent.idle();
    const first = userTexts(k.sent['model-0'][0]);
    assert.ok(first.some((t) => /^\[Koe said( aloud)?\] "Hello\. What can I do\?"$/.test(t)), JSON.stringify(first));
    assert.ok(starts[0] - sent < 8 * SECOND, `started ${starts[0] - sent} ms after the line, at Koe's line, not at the bound`);
  } finally {
    await k.done();
  }
});

test("a typed line Koe passes on (tell_kokoro, no words): Kokoro starts at the tell_kokoro, not at the bound", async () => {
  const { starts, hold } = kokoroStarts();
  const k = await liveKit([{ tool: { name: 'tell_kokoro', args: { text: 'hello?' } }, delayMs: 1200 }, {}], { agent: { secondMs: SECOND }, hold });
  try {
    const sent = Date.now();
    k.agent.send('hello?');
    await until(() => starts.length > 0, 8000);
    const told = (await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'tell_kokoro');
    assert.ok(told, 'Koe passed it on');
    assert.ok(starts[0] >= told.ts - 50, 'not before it');
    assert.ok(starts[0] - sent < 8 * SECOND - 500, `started ${starts[0] - sent} ms after the line`);
    await k.agent.idle();
  } finally {
    await k.done();
  }
});

test("a typed line Koe gives nothing back to: Kokoro starts at the live session's own no-answer bound (8 seconds)", async () => {
  const { starts, hold } = kokoroStarts();
  const k = await liveKit([{}], { agent: { secondMs: SECOND }, hold });
  try {
    const sent = Date.now();
    k.agent.send('hello?');
    await until(() => starts.length > 0, 12_000);
    const at = starts[0] - sent;
    assert.ok(at >= 8 * SECOND - 100 && at < 8 * SECOND + 2500, `started ${at} ms after the line`);
    await k.agent.idle();
  } finally {
    await k.done();
  }
});

test("a typed line whose answer is Koe's sleep: the session closes, and Kokoro waits no longer", async () => {
  const { starts, hold } = kokoroStarts();
  const k = await liveKit([{ tool: { name: 'sleep', args: {} }, delayMs: 600 }], { agent: { secondMs: SECOND }, hold });
  try {
    const sent = Date.now();
    k.agent.send('never mind');
    await until(() => starts.length > 0, 12_000);
    assert.ok(starts[0] - sent < 8 * SECOND - 500, `started ${starts[0] - sent} ms after the line`);
    await k.agent.idle();
  } finally {
    await k.done();
  }
});

test("a typed line when no live session can open (today's spend reached, Koe stays live): Kokoro's turn waits no longer", async () => {
  const usage = { promptTokenCount: 1_000_000, responseTokenCount: 0, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1_000_000 }] };
  const k = await liveKit([{ said: 'Sure.', audio: tone(0.1), usage }], { agent: { secondMs: SECOND } });
  try {
    const { updateAppSettings } = await import('../../src/core/settings.js');
    await updateAppSettings(k.ws, { shiori: { budgets: { spendPerDay: 0.5 } } });
    k.agent.send('Hi');
    await soon(async () => (await k.events(['live.session'])).some((/** @type {any} */ e) => e.data.state === 'closed'));
    await k.agent.idle();
    assert.equal(k.agent.koeState, 'live', 'Koe stays live: the model is not at fault');
    const sent = Date.now();
    k.agent.send('How far is Testville?');
    /** Kokoro's wake for the line (the same budget then stops her turn: its line comes as soon as she starts). */
    const woke = async () => (await k.events(['wake'])).find((/** @type {any} */ e) => e.data.half === 'kokoro' && e.data.reasons.some((/** @type {any} */ r) => r.text === 'How far is Testville?'));
    await soon(async () => Boolean(await woke()), 12_000);
    const at = (await woke()).ts - sent;
    assert.ok(at < 8 * SECOND - 1000, `Kokoro started ${at} ms after the line, not at the live bound`);
    await k.agent.idle();
  } finally {
    await k.done();
  }
});

/** annai's fact in Kokoro's wake: Koe is saying the reminder, so she doesn't. */
const SAYING = /Koe is saying these reminders to the user now: \\?"Sunset at 18:40\\?"\. Don't pass them on\./;
const SUNSET = { kind: /** @type {const} */ ('trigger'), text: 'Sunset in 30 minutes', fallbacks: [{ watch: 'sun', text: 'Sunset at 18:40' }] };

test("a reminder's wake that Koe says (live, the page in view; a chat Koe): Kokoro starts at once, told by annai that Koe is saying it", async () => {
  {
    const { starts, hold } = kokoroStarts();
    const k = await liveKit([{ said: 'The sun sets at 18:40.', audio: tone(0.3), delayMs: 1500 }], { agent: { secondMs: SECOND }, hold });
    try {
      await k.voice.unlock();
      const at = Date.now();
      await k.agent.wake(SUNSET);
      await until(() => starts.length > 0, 8000);
      assert.ok(starts[0] - at < 1000, `live: started ${starts[0] - at} ms after the wake, not after Koe's line`);
      assert.ok(userTexts(k.sent['model-0'][0]).some((t) => SAYING.test(t)), JSON.stringify(userTexts(k.sent['model-0'][0])));
      await k.agent.idle();
    } finally {
      await k.done();
    }
  }
  const { starts, hold: mine } = kokoroStarts();
  const k = await agentKit([{ rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] }], {
    koe: { type: { rules: [{ match: '.', reply: { toolCalls: [{ name: 'speak', input: { text: 'Sunset at 18:40.' } }, { name: 'sleep', input: {} }] } }] } },
    agent: { secondMs: 200 },
    // Koe's model takes 1 s: Kokoro starts before its words, with annai's word for them.
    hold: async (c) => {
      await mine(c);
      if (c.model.providerId === 'model-koe') await new Promise((r) => setTimeout(r, 1000));
    },
  });
  const at = Date.now();
  await k.agent.wake(SUNSET);
  await until(() => starts.length > 0, 5000);
  assert.ok(starts[0] - at < 800, `chat Koe: started ${starts[0] - at} ms after the wake`);
  assert.ok(userTexts(k.sent['model-0'][0]).some((t) => SAYING.test(t)));
  await k.agent.idle();
  assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['Sunset at 18:40.'], 'said once, by Koe');
});

test("a reminder's wake with nothing for Koe to say, or while a live session waits for the page: no word of Koe saying it, and Kokoro starts at once", async () => {
  for (const [what, wake, away] of /** @type {const} */ ([['no reminders', { kind: 'trigger', text: 'Sunset in 30 minutes' }, false], ['out of view', SUNSET, true]])) {
    const { starts, hold } = kokoroStarts();
    const k = await liveKit([{ said: 'The sun sets at 18:40.', audio: tone(0.3), delayMs: 2500 }], { agent: { secondMs: SECOND }, hold });
    try {
      await k.voice.unlock();
      if (away) hidden(true);
      const at = Date.now();
      await k.agent.wake(/** @type {any} */ (wake));
      await until(() => starts.length > 0, 8000);
      assert.ok(starts[0] - at < 2000, `${what}: started ${starts[0] - at} ms after the wake`);
      assert.ok(!userTexts(k.sent['model-0'][0]).some((t) => /Koe is saying/.test(t)), `${what}: annai says nothing of Koe saying it`);
    } finally {
      hidden(false);
      await k.done();
    }
  }
});

test("a reminder's wake, another conversation opened 300 ms after it, then back: Kokoro takes nothing up on return (annai's own wake is let go)", async () => {
  const { starts, hold: mine } = kokoroStarts();
  const k = await agentKit([{ rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] }], {
    koe: { type: { rules: [{ match: '.', reply: { toolCalls: [{ name: 'speak', input: { text: 'Sunset at 18:40.' } }, { name: 'sleep', input: {} }] } }] } },
    agent: { secondMs: 200 },
    hold: async (c) => {
      await mine(c);
      if (c.model.providerId === 'model-koe') await new Promise((r) => setTimeout(r, 1000));
    },
  });
  const { createTrip } = await import('../../src/core/scopes.js');
  const other = await createTrip(k.ws, { title: 'Testville' });
  await k.agent.wake(SUNSET);
  await new Promise((r) => setTimeout(r, 300));
  await k.agent.open(other);
  await k.agent.idle();
  const before = starts.length;
  await k.agent.open(k.trip);
  await k.agent.idle();
  await new Promise((r) => setTimeout(r, 400));
  await k.agent.idle();
  assert.equal(starts.length - before, 0, 'no request on return');
  assert.ok(!userTexts(k.sent['model-0'].at(-1)).some((t) => /You haven't answered this yet/.test(t)), 'nothing written as unanswered');
});

test("Koe unset, or down: the reminder's wake is Kokoro's alone, as before, with no word of Koe saying it", async () => {
  for (const koe of [undefined, { type: [{ error: 'auth', message: 'bad key' }] }]) {
    const k = await agentKit([{ rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] }], koe ? { koe } : { halves: true });
    if (koe) {
      k.agent.send('Hello?');
      await k.agent.idle();
      assert.equal(k.agent.koeState, 'down');
    }
    await k.agent.wake(SUNSET);
    await k.agent.idle();
    const asked = k.sent['model-0'].filter((/** @type {any} */ r) => userTexts(r).some((t) => /Sunset in 30 minutes/.test(t)));
    assert.ok(asked.length, `${koe ? 'down' : 'unset'}: Kokoro was asked`);
    assert.ok(!asked.some((/** @type {any} */ r) => userTexts(r).some((t) => /Koe is saying/.test(t))), `${koe ? 'down' : 'unset'}: no word of Koe`);
    assert.equal((await k.events(['reminder'])).length, 1, `${koe ? 'down' : 'unset'}: Kokoro slept, so annai said it, once`);
  }
});

// A cue (a place, the road, an arrival) is hers to say or let pass, not the user's reminder: live voice lets it go once the session has it, as
// classic voice does once a model answers. It is never shown as a "Reminder" after that, and a page out of view keeps it with the wake rather than
// showing it. One no model ever got still falls back as before. Kokoro is told of it as of a reminder, as released ("Don't pass them on").
const NEAR = 'Near the old town.';
const NEAR_W = { kind: /** @type {const} */ ('trigger'), text: 'Your watch p1 (arriving) fired: near the old town', fallbacks: [{ watch: 'p1', text: NEAR, cue: true }] };
const BOTH_W = { ...SUNSET, fallbacks: [...SUNSET.fallbacks, ...NEAR_W.fallbacks] };

test("Kokoro's wake lists a cue as it lists a reminder, with \"Don't pass them on\", as released (live, and a chat Koe): nothing shows that Kokoro leaves one alone", async () => {
  for (const live of [true, false]) {
    for (const [wake, listed] of /** @type {const} */ ([[NEAR_W, [NEAR]], [BOTH_W, ['Sunset at 18:40', NEAR]]])) {
      const { starts, hold } = kokoroStarts();
      const k = live ? await liveKit([{ said: 'The old town is ahead.', audio: tone(0.3) }], { agent: { secondMs: SECOND }, hold })
        : await agentKit([{ rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] }], { koe: { type: { rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] } }, agent: { secondMs: SECOND }, hold });
      try {
        if (live) await k.voice.unlock();
        await k.agent.wake(/** @type {any} */ (wake));
        await until(() => starts.length > 0, 8000);
        const said = userTexts(k.sent['model-0'][0]).filter((t) => /Koe is saying/.test(t));
        const want = `Koe is saying these reminders to the user now: ${listed.map((x) => `"${x}"`).join(', ')}. Don't pass them on.`;
        assert.ok(said.some((t) => t.replaceAll('\\"', '"').includes(want)), `${live ? 'live' : 'chat'}: Kokoro reads ${want}, got ${JSON.stringify(said)}`);
        await k.agent.idle();
      } finally {
        await k.done?.();
      }
    }
  }
});

for (const by of /** @type {const} */ (['a tap', 'a sound'])) {
  test(`live: a cue the session has, cut by ${by} before she answers it, is let go: no "Reminder" card for it; a reminder beside it is shown, silently, as before`, async () => {
    for (const wake of [NEAR_W, BOTH_W]) {
      const k = await noteSaid({ first: (x) => x.agent.wake(wake), turns: [{ delayMs: 400 }] });
      try {
        if (by === 'a tap') assert.equal(k.agent.live.tap(), 'cut');
        else await bump(k);
        await wait(1500);
        await k.agent.idle();
        assert.deepEqual(await shown(k), wake === BOTH_W ? [['Sunset at 18:40', false]] : [], 'the cue never shows');
        assert.ok(!k.notices.some((/** @type {any} */ n) => n.body === NEAR), 'no card for it');
        assert.deepEqual(k.said, [], "annai's voice says nothing");
      } finally {
        await k.done();
      }
    }
  });
}

test('live: a cue the session has and lets pass in silence asks nothing again and shows nothing; one no session ever got falls back as before', async () => {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, {}, {}], { agent: { secondMs: REAL_SECOND } });
  try {
    await k.voice.unlock();
    k.agent.send('Hi');
    await soon(async () => (await k.events(['out.speak'])).length === 1, 4000);
    await k.agent.live.idle();
    await k.agent.wake(NEAR_W);
    await soon(async () => textsIn(k).some((t) => t.includes('near the old town')), 4000);
    await wait(4000); // her silent answer, and any ask once more
    await k.agent.idle();
    assert.deepEqual(asks(k), [], 'not asked again');
    assert.deepEqual(await shown(k), [], 'nothing shown');
    assert.deepEqual(k.said, []);
  } finally {
    await k.done();
  }
  // No session can open (today's spend reached, Koe stays live): annai shows it, as it did.
  const usage = { promptTokenCount: 1_000_000, responseTokenCount: 0, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1_000_000 }] };
  const spent = await liveKit([{ said: 'Sure.', audio: tone(0.1), usage }], { agent: { secondMs: REAL_SECOND } });
  try {
    const { updateAppSettings } = await import('../../src/core/settings.js');
    await updateAppSettings(spent.ws, { shiori: { budgets: { spendPerDay: 0.5 } } });
    spent.agent.send('Hi');
    await soon(async () => (await spent.events(['live.session'])).some((/** @type {any} */ e) => e.data.state === 'closed'));
    await spent.agent.idle();
    await spent.agent.wake(NEAR_W);
    await soon(async () => (await shown(spent)).length === 1, 4000);
    assert.deepEqual((await shown(spent)).map(([text]) => text), [NEAR]);
  } finally {
    await spent.done();
  }
});

test('live: a cue the session has is let go at a switch to another trip; one still waiting to go in falls back there as before', async () => {
  const k = await noteSaid({ first: (x) => x.agent.wake(NEAR_W), turns: [{ delayMs: 400 }] });
  try {
    const { createTrip } = await import('../../src/core/scopes.js');
    const other = await createTrip(k.ws, { title: 'Carmel' });
    await k.agent.open(other);
    await k.agent.idle();
    await wait(300);
    assert.deepEqual(await entries(k, k.trip), [], 'nothing in the trip left');
    assert.deepEqual(await entries(k, other), []);
  } finally {
    await k.done();
  }
  const w = await owing((x) => x.agent.wake(NEAR_W));
  try {
    const { createTrip } = await import('../../src/core/scopes.js');
    await w.agent.open(await createTrip(w.ws, { title: 'Carmel' }));
    await w.agent.idle();
    await soon(async () => (await entries(w, w.trip)).length === 1, 4000);
    assert.deepEqual(await entries(w, w.trip), [[NEAR, false]], 'never in: its fallback, in the trip left');
  } finally {
    await w.done();
  }
});

test('live, the page out of view: a reminder is shown at once, as before; a cue waits with the wake for the page, and is let go once the session has it', async () => {
  const k = await liveKit([{ said: 'The old town is ahead, and sunset is at 18:40.', audio: tone(0.3) }], { agent: { secondMs: REAL_SECOND } });
  try {
    await k.voice.unlock();
    hidden(true);
    await k.agent.wake(BOTH_W);
    await soon(async () => (await shown(k)).length === 1, 4000);
    await wait(300);
    assert.deepEqual(await shown(k), [['Sunset at 18:40', true]], 'the reminder only, said as before');
    assert.ok(!k.said.includes(NEAR), 'the cue is not said');
    hidden(false);
    k.agent.shown();
    await soon(async () => textsIn(k).some((t) => t.includes('Sunset in 30 minutes')), 4000);
    await soon(async () => (await k.events(['out.speak'])).length === 1, 4000);
    await k.agent.idle();
    assert.deepEqual((await shown(k)).map(([text]) => text), ['Sunset at 18:40'], 'the cue never shows');
  } finally {
    hidden(false);
    await k.done();
  }
});

// Koe's instructions, at the source: passing on is the default, said in the same words to a chat Koe, a live one and in tell_kokoro's own
// description; no standing excuse; the lines that get no reply say what to do, and a live Koe is told once that every word it makes is heard.
test("Koe passes on what the user said as they said it, in its instructions and in tell_kokoro's description; meanwhile it says \"One moment.\" and asks nothing of its own", () => {
  const tool = channelTool('koe', /** @type {any} */ ({ send: async () => 'sent' }));
  for (const k of [KOE_CORE, KOE_LIVE, tool.description]) assert.match(k, /what the user said,? as they said it|what they said, as they said it/);
  for (const k of [KOE_CORE, KOE_LIVE]) {
    const line = k.split('\n').find((l) => l.startsWith('- Anything else the user says to you'));
    assert.ok(line, 'one line says it');
    assert.match(line, /"One moment\.", (then )?tell_kokoro what they said, as they said it/);
    assert.match(line, /Ask them nothing of your own, and never say it's done until a note says so\./);
    assert.doesNotMatch(k, /can't check|can't be reached|saying you're checking/, 'no ready excuse, and no promise to check');
    assert.doesNotMatch(k, /\bwhen the user asks for something done\b/i, 'one rule, not two');
  }
});

test("the lines that get no reply say what to do, and name no state; a live Koe is told once that every word it makes is spoken aloud", () => {
  for (const k of [KOE_CORE, KOE_LIVE]) {
    assert.doesNotMatch(k, /Silence is|Say nothing at all|thinks aloud, say nothing/);
    assert.match(k, /single stray words and a language the user doesn't speak get no reply: no words, no sound[.;]/);
    // Told to stop is no line to pass on: it is what NO_FILLER says (stop, and say nothing).
    assert.match(k, /\n- Anything else the user says to you \(a question, a request, something to do\), unless it tells you to stop \(then stop, and say nothing\):/);
  }
  assert.doesNotMatch(KOE_CORE, /(no sound|stray word): call sleep/, 'one colon in the line');
  assert.match(KOE_LIVE, /only acknowledges \(okay, cool, thanks\) or thinks aloud, it gets no reply: no words, no sound\./);
  assert.equal(KOE_LIVE.split('\n').filter((l) => /Every word you produce is spoken aloud to the user, so never describe what you are doing or that you are staying quiet\./.test(l)).length, 1);
  assert.doesNotMatch(KOE_CORE, /spoken aloud to the user/, "a chat Koe's own text is never shown or said");
});
