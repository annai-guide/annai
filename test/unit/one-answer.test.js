// One answer: a note whose words sound cut off while the provider was still making them is said again from its start, never taken up from its
// middle; and Kokoro reads Koe's answer before she starts, for what both halves were given at once. Lines and places are synthetic.
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
/** What annai showed as Shiori's answer (the note's words, when Koe never passed it on). @param {any} k */
const shown = async (k) => (await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text);
/** The asks annai sent because sound cut her off. @param {any} k */
const cutAsks = (k) => texts(k).filter((t) => /^\[annai\] /.test(t) && /cut you off/.test(t));
/** Her lines, as written: words, and whether cut. @param {any} k */
const lines = async (k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.cut)]);

/**
 * A live session in a car (sound at the microphone may cut her), the user in it: a first exchange, then Kokoro's note, which she begins to say.
 * turns: what the stand-in answers after the note's own turn, in order; cue: its answer to annai's ask. @param {{ turns?: any[], cue?: any, pace?: number, note?: any }} [o]
 */
async function noteSaid({ turns = [], cue = { said: SAID, audio: tone(0.2) }, pace = 1, note = { said: SAID, audio: tone(3) } } = {}) {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, note, ...turns], { pace, server: { onText: { match: /cut you off/, turn: cue } } });
  await k.voice.unlock();
  k.voice.route = async () => 'car';
  k.platform.streamSpeed = 1;
  k.agent.tap(); // the user is in this session, so she stays cuttable
  await until(() => k.agent.live.listening, 3000);
  await say(k, 'where-eat');
  await soon(async () => (await k.events(['out.speak'])).length === 1, 4000);
  await k.agent.live.idle();
  k.platform.mic.feed(quiet(0.5), RATE);
  await tell(k);
  await soon(async () => k.agent.live.view.name === 'speaking', 3000);
  return k;
}

/** A bump at the microphone, over her, once some of her words have been heard: a turn of its own. @param {any} k */
async function bump(k) {
  await new Promise((r) => setTimeout(r, 500));
  k.platform.mic.feed(cat(hum(0.8), quiet(1)), RATE);
}

test('a note cut by a sound while the provider still made it is asked for again once the sound\'s turn ends, and said again from its start; nothing is taken up from its middle', async () => {
  // The provider's answer to the sound's own turn comes late (as Gemini's do), and would go on from where its record stopped: the ask goes in first.
  const k = await noteSaid({ turns: [{ said: 'open until ten tonight.', audio: tone(0.5), delayMs: 400 }] });
  try {
    await bump(k);
    await soon(async () => (await lines(k)).some(([text, cut]) => text === SAID && !cut), 8000);
    await k.agent.idle();
    assert.equal(cutAsks(k).length, 1, 'asked once, when the sound\'s turn ended');
    const said = await lines(k);
    assert.deepEqual(said.at(-1), [SAID, false], 'said again whole');
    assert.ok(said.some(([text, cut]) => cut && /✂$/.test(text)), 'the cut words are kept, marked');
    assert.ok(!said.some(([text]) => /^open until ten/.test(text)), 'nothing from its middle');
    assert.deepEqual(await shown(k), [], 'she said it: annai shows nothing');
  } finally {
    await k.done();
  }
});

test("the ask's own text turn cutting a turn that hadn't sounded yet is no second cut: the note is said once more, and annai shows nothing", async () => {
  // The provider's answer to the sound's turn: its sound came, its first word not yet (her voice waits for a word), when the ask cuts it.
  const k = await noteSaid({ turns: [{ said: 'open until ten tonight.', audio: tone(0.5), saidAt: 1500 }] });
  try {
    await bump(k);
    await soon(async () => (await lines(k)).some(([text, cut]) => text === SAID && !cut), 8000);
    await k.agent.idle();
    assert.equal(cutAsks(k).length, 1);
    assert.deepEqual(await shown(k), []);
    assert.deepEqual((await lines(k)).at(-1), [SAID, false]);
  } finally {
    await k.done();
  }
});

test('cut twice: asked once, then annai shows and says the words for the user; never a third ask', async () => {
  const k = await noteSaid({ turns: [{ said: 'open until ten tonight.', audio: tone(0.5), delayMs: 400 }], cue: { said: SAID, audio: tone(3) } });
  try {
    await bump(k);
    await soon(async () => cutAsks(k).length === 1, 6000);
    await soon(async () => k.agent.live.view.name === 'speaking', 4000); // she says it again
    await bump(k);
    await soon(async () => (await shown(k)).length === 1, 8000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [FOR_USER]);
    assert.equal(cutAsks(k).length, 1, 'one ask, then the backstop');
  } finally {
    await k.done();
  }
});

test('the provider done, then her sound cut: asked once, as before, and said again whole', async () => {
  // The note's turn ends at the provider at once (pace 0); her voice plays it out in real time, and the sound cuts that.
  const k = await noteSaid({ pace: 0, note: { said: SAID, audio: tone(1.5) }, turns: [{ said: 'open until ten tonight.', audio: tone(0.5), delayMs: 400 }] });
  try {
    await bump(k);
    await soon(async () => (await lines(k)).some(([text, cut]) => text === SAID && !cut), 8000);
    await k.agent.idle();
    assert.equal(cutAsks(k).length, 1);
    assert.deepEqual(await shown(k), []);
  } finally {
    await k.done();
  }
});
