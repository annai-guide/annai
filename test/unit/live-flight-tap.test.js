// The tap (spec §10.8): a tap stops her while she sounds, or while what she says after a call is due (the quiet after "Checking your notes."):
// the card for the note in flight, the microphone listens, the session stays; whatever she makes before the next input (the user speaks, any
// text goes in, a close) is written as her answer and never spoken. A second tap in that quiet closes. Lines and places are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tone, soon, liveKit, say } from './koe-live-kit.js';
import { until } from './agent-kit.js';
import { hum, quiet, cat } from './voice-kit.js';
import { RATE, PASS, FOR_USER, LOOKS, CONT, tell2, shown, lines, words, cues, asks, wait, start, lineAt, join, zeros } from './live-flight-kit.js';

const OKAY = { said: 'Okay.', audio: tone(0.3) };

/** The user speaks, and the stand-in hears their turn end. @param {any} k */
const speaks = (k) => k.platform.mic.feed(cat(hum(0.8), quiet(1)), RATE);
const YES = { said: 'Yes, until ten.', audio: tone(0.3), delayMs: 300 };

test('a tap in the quiet after "Checking your notes." has played out: the note on a card, her continuation written and not heard, the session open, and the next question answered aloud', async () => {
  const { k, w } = await start({ turns: [LOOKS, CONT, YES] });
  try {
    await wait(1500);
    assert.equal(k.agent.live.view.name, 'thinking', 'the dock: she isn\'t done');
    assert.equal(k.agent.tap(), 'cut');
    await wait(100);
    assert.equal(k.agent.live.view.name, 'listening');
    assert.equal(k.agent.live.state, 'open');
    await soon(async () => (await words(k)).includes(CONT.said), 8000);
    await wait(500);
    speaks(k);
    await soon(async () => (await words(k)).includes(YES.said), 8000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
    const all = await lines(k);
    assert.deepEqual(all.map((l) => [l.text, l.voice, l.cut]), [['Hello there.', true, false], ['Checking your notes.', true, false], [CONT.said, false, false], [YES.said, true, false]]);
    assert.equal(k.platform.streams.length, 3, 'no stream for the continuation');
  } finally {
    w.stop();
    await k.done();
  }
});

test('a second tap in that quiet closes the session', async () => {
  const { k, w } = await start({ turns: [LOOKS, CONT, OKAY] });
  try {
    await wait(1500);
    assert.equal(k.agent.tap(), 'cut');
    await wait(400);
    assert.equal(k.agent.tap(), 'stopped');
    await wait(300);
    assert.equal(k.agent.live.state, 'closed');
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
  } finally {
    w.stop();
    await k.done();
  }
});

test('a note that comes after a tap in that quiet goes in once her unspoken continuation has ended, and is said aloud, not asked for', async () => {
  const { k, t0, w } = await start({ turns: [LOOKS, CONT, { said: PASS, audio: tone(0.8) }, OKAY] });
  try {
    await wait(1500);
    k.agent.tap();
    await wait(500);
    await tell2(k);
    await soon(async () => (await words(k)).includes(PASS), 10_000);
    await k.agent.idle();
    const pass = (await lines(k)).find((l) => l.text === PASS);
    assert.ok(pass?.voice && !pass.cut, 'said aloud');
    assert.deepEqual(cues(k), []);
    assert.ok(w.at(/pass closes/) >= (await lineAt(k, t0, CONT.said)) - 100, 'after her unspoken continuation');
  } finally {
    w.stop();
    await k.done();
  }
});

// A tap in the quiet tail of her words (her player still holds 1.5 s of near-silence), the provider's end at 0.9 s.
const LOOKS_TAIL = { ...LOOKS, audio: join(tone(0.8), zeros(1.5)), endAt: 900 };

test('a tap in the quiet tail of a turn that goes on, a note in flight: a card, and her continuation written without voice', async () => {
  const { k, w } = await start({ turns: [LOOKS_TAIL, CONT, YES] });
  try {
    await wait(1100);
    k.agent.tap();
    await soon(async () => (await words(k)).includes(CONT.said), 8000);
    await wait(500);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
    const cont = (await lines(k)).find((l) => l.text === CONT.said);
    assert.ok(cont && !cont.voice && !cont.cut, 'written whole, not heard');
  } finally {
    w.stop();
    await k.done();
  }
});

test('a tap in the quiet tail of her own lookup for the user: her answer is written, not spoken', async () => {
  const { k, w } = await start({ note: false, turns: [LOOKS_TAIL, { ...CONT, said: 'You have two reminders set.' }, OKAY] });
  try {
    await wait(1100);
    k.agent.tap();
    await soon(async () => (await words(k)).includes('You have two reminders set.'), 8000);
    await wait(500);
    await k.agent.idle();
    const cont = (await lines(k)).find((l) => l.text === 'You have two reminders set.');
    assert.ok(cont && !cont.voice, 'written, not spoken');
    assert.deepEqual(await shown(k), []);
  } finally {
    w.stop();
    await k.done();
  }
});

// What a tap does not stop cleanly (review of 2026-11-12, F5): a turn of hers that has begun, and isn't heard yet. A tap stops her while a turn of
// hers is open and not cut (the dock says Thinking or Speaking): the card, nothing of what she makes before the next input is heard, and the
// rest of a half-made continuation is written whole when it ends, not cut off at the tap.
const LOOKS_LONG = { ...LOOKS, audio: tone(3) };

test('a tap while "Checking your notes." still plays and her continuation has sound but no word yet: the card, and the continuation written, not heard', async () => {
  const { k, w } = await start({ turns: [LOOKS_LONG, { ...CONT, audio: tone(2.5), delayMs: 300, saidAt: 1500 }, YES] });
  try {
    await wait(2000);
    assert.equal(k.agent.tap(), 'cut');
    await soon(async () => (await words(k)).includes(CONT.said), 8000);
    await wait(500);
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
    const cont = (await lines(k)).find((l) => l.text === CONT.said);
    assert.ok(cont && !cont.voice && !cont.cut, 'written whole, not heard');
    assert.equal(k.platform.streams.length, 2, 'no stream for the continuation');
  } finally {
    w.stop();
    await k.done();
  }
});

test('a tap while nothing plays and her continuation has sound but no word yet: the dock says Thinking, so it stops her (card, session open), not closes', async () => {
  const { k, w } = await start({ turns: [LOOKS, { ...CONT, audio: tone(2.5), delayMs: 300, saidAt: 1500 }, YES] });
  try {
    await wait(2000);
    assert.equal(k.agent.live.view.name, 'thinking');
    assert.equal(k.agent.tap(), 'cut');
    assert.equal(k.agent.live.state, 'open');
    await soon(async () => (await words(k)).includes(CONT.said), 8000);
    await wait(500);
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
    const cont = (await lines(k)).find((l) => l.text === CONT.said);
    assert.ok(cont && !cont.voice && !cont.cut, 'written whole, not heard');
  } finally {
    w.stop();
    await k.done();
  }
});

test('a tap while her own lookup\'s continuation is half made and waits behind the line still playing: it is written whole when it ends, not cut off at the tap', async () => {
  const ALL = 'The pass is open until nine tonight.';
  const { k, t0, w } = await start({ note: false, turns: [LOOKS_LONG, { said: ALL, audio: tone(2.5), delayMs: 300, endAt: 3500 }, OKAY] });
  try {
    await wait(2200); // the continuation's words are in and queued behind "Checking your notes.", its end is not
    assert.equal(k.agent.tap(), 'cut');
    const tapped = Date.now() - t0;
    await soon(async () => (await words(k)).some((x) => x.startsWith('The pass')), 10_000);
    const [line] = (await lines(k)).filter((l) => l.text.startsWith('The pass'));
    assert.deepEqual([line.text, line.voice, line.cut], [ALL, false, false], 'whole, not heard, no ✂');
    assert.ok(line.ts - t0 > tapped + 1500, `written at ${line.ts - t0} ms, the tap was at ${tapped} ms: at its end, not at the tap`);
  } finally {
    w.stop();
    await k.done();
  }
});

// Review F4: sound stuck after the tap; the turn the tap stopped is written, never read aloud by the speech voice.
test('sound goes stuck after a tap in the wait: her continuation is written, and the speech voice does not read it aloud', async () => {
  const { k, w } = await start({ turns: [LOOKS, CONT, YES] });
  try {
    await wait(1500);
    assert.equal(k.agent.tap(), 'cut');
    k.voice.soundStopped();
    await soon(async () => (await words(k)).includes(CONT.said), 8000);
    await wait(500);
    assert.ok(!k.platform.log.some((/** @type {string} */ l) => l.includes(`play m-say:${CONT.said}`)), 'not read aloud');
  } finally {
    w.stop();
    await k.done();
  }
});

// Review F2, with the user's pick (2026-11-12): a tap that stops her keeps annai from asking her aloud, and a new note waits for their first sentence.
test('a tap in the wait after her lookup for the user\'s own question, and no continuation: nothing is asked aloud at 8 s, no answer is played, the session stays open', async () => {
  const k = await liveKit([{ tool: { name: 'watch_list', args: {} } }, { said: 'You have two reminders set.', audio: tone(0.5) }], { pace: 1, agent: { secondMs: 1000 } });
  try {
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['tool.result'])).some((/** @type {any} */ e) => e.data.half === 'koe'), 8000);
    assert.equal(k.agent.live.view.name, 'thinking');
    assert.equal(k.agent.tap(), 'cut');
    await wait(10_000); // past the 8 s of the user's turn
    assert.deepEqual(asks(k).filter((x) => /answer them aloud/.test(x)), [], 'nothing asked aloud');
    assert.deepEqual(await words(k), []);
    assert.equal(k.agent.live.state, 'open');
    assert.equal(k.agent.live.view.name, 'listening');
  } finally {
    await k.done();
  }
});

test('a note waiting when the user taps to stop her goes in once 2 s pass with no speech, and is said; it does not go in at the tap', async () => {
  const { k, t0, w } = await start({ turns: [{ said: FOR_USER, audio: tone(1.5) }, { said: PASS, audio: tone(0.8) }, OKAY] });
  try {
    await tell2(k);
    await wait(500);
    assert.equal(k.agent.tap(), 'cut'); // her turn has about a second to go: it ends, and the note could go in at once
    const tapped = Date.now() - t0;
    await soon(async () => (await words(k)).includes(PASS), 12_000);
    await k.agent.idle();
    const went = w.at(/pass closes/) - tapped;
    assert.ok(went >= 1900 && went < 4000, `the note went in ${went} ms after the tap (the user's 2 s: #hearFirst)`);
    const pass = (await lines(k)).find((l) => l.text === PASS);
    assert.ok(pass?.voice && !pass.cut, 'said aloud, whole');
    assert.deepEqual(await shown(k), [[FOR_USER, false]], 'the cut note alone is shown');
  } finally {
    w.stop();
    await k.done();
  }
});
