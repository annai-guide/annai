// Drive 3's cut, at the live session: on the phone's speaker (annai doesn't hear while she speaks), in a noisy car (she plays at once), a
// bump at the microphone began about 150 ms before her first sound for a note from Kokoro. Held by the detector and not yet speech, it was
// taken for the user's turn as her voice began: her voice stopped after 58 ms, and the provider went on from the middle of the note 1.1 s
// later, so the user heard it without its first words (once in 47 notes). A sound cuts her only once it counts as speech (input.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './agent-kit.js';
import { liveKit, got, soon, tone, say } from './koe-live-kit.js';
import { quiet, burst, cat, RATE } from './voice-kit.js';

const FOR_USER = 'The fuel station ahead is open until ten tonight.';
const NOTE = 'Tell the user the fuel station ahead is open until ten tonight.';
/** The room (its floor about -78 dB), and drive 3's bump in it (live-input.test.js has its shape). @param {number} seconds */
const still = (seconds) => quiet(seconds, 0.00035);
const bump = burst(0.4, 0.017).map((x, i) => x * Math.exp(-i / (RATE * 0.06)));

/** What the microphone hears, fed as the clock goes (each 20 ms, what is due by then), so a slow timer doesn't move the sound. @param {any} k @param {Float32Array} pcm */
async function hear(k, pcm) {
  const t0 = Date.now();
  for (let at = 0; at < pcm.length;) {
    await new Promise((r) => setTimeout(r, 20));
    const due = Math.min(pcm.length, Math.round(((Date.now() - t0) * RATE) / 1000));
    if (due > at) k.platform.mic.feed(pcm.subarray(at, due), RATE);
    at = due;
  }
}

test('drive 3 at the live session, the phone\'s speaker in a noisy car: a bump begun 150 ms before her voice for a note sends no turn, and she says the note whole', async () => {
  // Her answer to the note begins 900 ms after it goes in (the drive: 870 ms); a turn for the bump would be answered from the note's middle.
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, { said: FOR_USER, audio: tone(3), delayMs: 900 }, { said: 'open until ten tonight.', audio: tone(1.5), delayMs: 400 }, {}], { pace: 1, agent: { secondMs: 1000 } });
  try {
    await k.voice.unlock();
    k.voice.route = async () => 'speaker';
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening, 5000);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['out.speak'])).length === 1, 15_000);
    await k.agent.live.idle();
    for (let i = 0; i < 3; i++) k.platform.mic.feed(cat(still(0.3), burst(0.06, 0.4), still(0.3)), RATE); // the car: noises thrown away
    const starts = () => got(k, 'realtimeInput').filter((/** @type {any} */ m) => m.realtimeInput.activityStart).length;
    assert.equal(starts(), 1, 'the question\'s turn');
    await k.agent.channel.send('kokoro', NOTE, 'append', 'tool', undefined, undefined, false, FOR_USER);
    await hear(k, cat(still(0.75), bump, still(4.5)));
    await soon(async () => starts() > 1 || (await k.events(['out.speak'])).length >= 2, 15_000); // a turn for the bump, or her line
    await new Promise((r) => setTimeout(r, 1500)); // and what follows it
    const lines = (await k.events(['out.speak'])).slice(1).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.cut)]);
    const sound = (await k.events(['live.reply'])).slice(1).map((/** @type {any} */ e) => [e.data.ms, Boolean(e.data.cut)]);
    const seen = [starts(), lines, sound]; // turns begun, her lines since the note ([words, cut]), and her sound ([ms played, cut])
    assert.deepEqual(seen, [1, [[FOR_USER, false]], [[3000, false]]], JSON.stringify(seen));
    // The Trace says what was dropped, and it is no turn: the question's turn ended, and the bump has a line of its own, nothing sent.
    const ends = (await k.events(['live.turn'])).map((/** @type {any} */ e) => [e.data.end, e.data.ms > 0]);
    assert.deepEqual(ends, [['pause', true], ['dropped', false]], JSON.stringify(ends));
  } finally {
    await k.done();
  }
});
