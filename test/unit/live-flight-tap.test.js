// The tap (spec §10.8): a tap stops her while she sounds, or while what she says after a call is due (the quiet after "Checking your notes."):
// the card for the note in flight, the microphone listens, the session stays; whatever she makes before the next input (the user speaks, any
// text goes in, a close) is written as her answer and never spoken. A second tap in that quiet closes. Lines and places are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tone, soon } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';
import { RATE, PASS, FOR_USER, LOOKS, CONT, tell2, shown, lines, words, cues, wait, start, lineAt, join, zeros } from './live-flight-kit.js';

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
