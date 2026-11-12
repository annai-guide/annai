// The second drive's voice fixes (design 2026-11-04, section 3): a note always reaches the user, a turn the model let go is never
// retried, a reminder being said isn't cut off, and a model that refuses its setup isn't tried first again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './agent-kit.js';
import { liveKit, texts, soon, tone, say, lives } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';
import { COOLDOWN_MS } from '../../src/core/llm/fallback.js';
import { updateAppSettings } from '../../src/core/settings.js';

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const RATE = 16_000;
const FOR_USER = 'The fuel station ahead is open until ten tonight.';
const NOTE = 'Tell the user the fuel station ahead is open until ten tonight.';
/** Kokoro's tell_koe with for_user, as its tool sends it. @param {any} k @param {'append' | 'immediate'} [mode] */
const tell = (k, mode = 'append') => k.agent.channel.send('kokoro', NOTE, mode, 'tool', undefined, undefined, false, FOR_USER);
const shown = async (/** @type {any} */ k) => (await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text);
const CUE = /^\[annai\] /;
/** Lyrics at the microphone: the room, then a rise and fall that never stops, until stop() says so. @param {any} k @param {() => boolean} stop */
async function lyrics(k, stop, amp = 0.1) {
  if (k.platform.mic.isOpen()) k.platform.mic.feed(quiet(0.3), RATE);
  while (!stop()) {
    if (k.platform.mic.isOpen()) k.platform.mic.feed(hum(0.1, amp), RATE);
    await wait(10);
  }
}

test('item 13: the model gives an empty turn for a note, in a session opened for it, and again when asked once more: its for_user words reach the user, once', async () => {
  const k = await liveKit([{}]);
  try {
    await tell(k);
    await soon(async () => (await shown(k)).length === 1, 5000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [FOR_USER]);
    assert.equal(texts(k).filter((t) => CUE.test(t)).length, 1, 'asked once more, once');
  } finally {
    await k.done();
  }
});

test("item 13: a note Koe said, cut off by lyrics before the user heard a word, isn't passed on: what the user didn't hear is shown at once, silently, and she isn't asked to say it again", async () => {
  // Two sounds of hers; the second is cut by sound at the microphone, in a car, where sound may cut her; the lyrics' turn gets no reply.
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, { said: 'The fuel station is open until ten.', audio: tone(1.5) }, { heard: 'la la' }]);
  try {
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
    k.platform.mic.feed(cat(hum(0.8), quiet(1)), RATE); // over her
    await soon(async () => (await shown(k)).length === 1, 6000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [FOR_USER], 'shown, so nothing is lost');
    assert.equal((await k.events(['reminder']))[0].data.aloud, undefined, 'and not said');
    assert.ok(!texts(k).some((t) => CUE.test(t)), 'not asked again');
  } finally {
    await k.done();
  }
});

test("item 13: a note whose words were cut off before they were heard is shown at once, so Koe's already_told after the cut shows nothing twice", async () => {
  // As the real model did when asked once more (2026-11-04, on a free key): it believes it has said it.
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, { said: 'The fuel station is open until ten.', audio: tone(1.5) }, { heard: 'la la', tool: { name: 'already_told', args: {} } }]);
  try {
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
    k.platform.mic.feed(cat(hum(0.8), quiet(1)), RATE);
    await soon(async () => (await shown(k)).length === 1, 6000);
    assert.deepEqual(await shown(k), [FOR_USER]);
  } finally {
    await k.done();
  }
});

test('item 13: in a session a note opened, with nobody in it, lyrics at the microphone neither cut the note nor keep it from being said', async () => {
  const k = await liveKit([{ said: 'The fuel station is open until ten.', audio: tone(0.5), delayMs: 800 }]);
  let done = false;
  try {
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    await tell(k);
    await until(() => k.agent.live.listening, 3000);
    const feeding = lyrics(k, () => done);
    await soon(async () => (await k.events(['out.speak'])).length === 1, 5000);
    done = true;
    await feeding;
    const [line] = await k.events(['out.speak']);
    assert.equal(line.data.cut, undefined, 'said whole');
    assert.deepEqual(await shown(k), []);
  } finally {
    done = true;
    await k.done();
  }
});

test('item 13: a session opened after a sleep is fresh: the sleep note is not in its context', async () => {
  const k = await liveKit([{ tool: { name: 'sleep', args: {} }, handle: 'kept-after-sleep' }, { said: 'The fuel station is open until ten.', audio: tone(0.1) }]);
  try {
    await k.agent.channel.send('kokoro', 'Go to sleep.', 'append', 'tool', undefined, undefined, false, '');
    await soon(async () => (await lives(k, 'closed')).length === 1, 3000);
    await k.agent.idle();
    await tell(k);
    await soon(async () => (await k.events(['out.speak'])).length === 1, 3000);
    const setups = k.server.received().filter((/** @type {any} */ m) => m.setup);
    assert.equal(setups.length, 2);
    assert.equal(setups[1].setup.sessionResumption.handle, undefined, 'no handle after a sleep');
  } finally {
    await k.done();
  }
});

test('item 6: a turn the model never answers (the real model sends nothing at all for music) is let go: no second session, and its words go nowhere', async () => {
  const k = await liveKit([{ heardFirst: true, heard: 'la la', silent: true }, { said: 'should not be said', audio: tone(0.1) }]);
  try {
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['error'])).some((/** @type {any} */ e) => e.data.kind === 'live-silent'), 5000);
    await k.agent.live.idle();
    await wait(1200); // past another watchdog
    assert.equal(k.server.connections().length, 1, 'no session was opened for it');
    assert.deepEqual(texts(k), [], 'its words were not sent again');
    const heard = await k.events(['heard']);
    assert.equal(heard[0].data.dismissed, true, "written as what she didn't answer");
  } finally {
    await k.done();
  }
});

test('item 6: a note a session never answers is still the watchdog\'s: a fresh session gets it', async () => {
  const k = await liveKit([{ silent: true }, { said: 'The fuel station is open until ten.', audio: tone(0.1) }]);
  try {
    await tell(k);
    await soon(async () => (await k.events(['out.speak'])).length === 1, 6000);
    assert.equal(k.server.connections().length, 2);
    assert.equal(texts(k).filter((t) => t.includes('open until ten')).length, 2);
  } finally {
    await k.done();
  }
});

test('section 2: a dismissed live turn at the user\'s own level wakes Kokoro; a quieter one, lyrics, does not', async () => {
  const k = await liveKit([{ heard: 'Okay, cool.' }, { heard: 'la la la' }]);
  const cues = async () => (await k.events(['wake'])).filter((/** @type {any} */ e) => (e.data.reasons ?? []).some((/** @type {any} */ w) => /didn't answer/.test(String(w.text ?? ''))));
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    k.platform.mic.feed(cat(quiet(1.2), hum(0.6, 0.3), quiet(1)), RATE);
    await soon(async () => (await cues()).length === 1, 4000);
    await k.agent.idle();
    k.agent.live.level.heard(-5);
    k.agent.live.level.heard(-5); // the user's own level; what follows is 20 dB under it, yet starts a turn (the floor is quiet)
    k.platform.mic.feed(cat(hum(0.6, 0.02), quiet(1)), RATE);
    await soon(async () => (await k.events(['heard'])).length === 2, 4000);
    await k.agent.idle();
    assert.equal((await cues()).length, 1, 'lyrics cost no Kokoro call');
    assert.deepEqual((await k.events(['heard'])).map((/** @type {any} */ e) => e.data.ownLevel), [true, undefined]); // the first: quiet floor, nothing learned
  } finally {
    await k.done();
  }
});

test('item 12: a reminder being said finishes first: a session that opens meanwhile waits for it', async () => {
  const k = await liveKit([{ said: 'The fuel station is open until ten.', audio: tone(0.1) }], { voice: { playMs: 300 } });
  try {
    await k.voice.unlock();
    const said = k.voice.say('Your reminder, whole.');
    await wait(20);
    assert.equal(k.voice.speaker.speaking, true);
    await tell(k);
    await wait(100);
    assert.equal(k.server.connections().length, 0, 'no session while it is said');
    const spoken = await said;
    assert.equal(spoken.cut, null, 'said whole');
    await soon(async () => (await k.events(['out.speak'])).length === 1, 3000);
  } finally {
    await k.done();
  }
});

test('item 12: a tap while a reminder is said stops it and opens at once', async () => {
  const k = await liveKit([{ said: 'Yes?', audio: tone(0.1) }], { voice: { playMs: 5000 } });
  try {
    await k.voice.unlock();
    k.voice.say('Your reminder.').catch(() => {});
    await wait(20);
    k.agent.tap();
    await until(() => k.agent.live.listening, 2000);
  } finally {
    await k.done();
  }
});

test('a model of Koe\'s list that refuses its setup rests as a failure does, the note goes on at once to the next model of the list, not to annai\'s fallback, and nothing shows an error', async () => {
  const k = await liveKit([{ said: 'The fuel station is open until ten.', audio: tone(0.1) }], { live: { second: true } });
  try {
    const live = k.llm.live;
    const { ProviderError } = await import('../../src/core/llm/contract.js');
    k.llm.live = async (/** @type {string} */ id, /** @type {any} */ setup, /** @type {any} */ o) => {
      if (id === 'm-live') throw new ProviderError('bad-request', 'Invalid JSON payload received. Unknown name "something".');
      return live(id, setup, o);
    };
    /** @type {any[]} */
    const notes = [];
    k.agent.on('notice', (/** @type {any} */ n) => notes.push(n));
    await tell(k);
    await soon(async () => (await k.events(['out.speak'])).length === 1 || (await shown(k)).length > 0, 3000);
    const left = k.llm.bench.until('m-live') - Date.now();
    assert.ok(left > 0 && left <= COOLDOWN_MS, `rests as a failure does: ${left}`);
    assert.deepEqual(await shown(k), [], 'said by the next live model');
    assert.equal(k.agent.live.modelId, 'm-live2');
    assert.deepEqual(notes, [], 'no card, no toast');
    assert.deepEqual(await k.events(['error']), []);
  } finally {
    await k.done();
  }
});

test("a trigger's session says nothing for its reminder: annai says the reminder itself, once", async () => {
  const k = await liveKit([{}]);
  try {
    await k.voice.unlock();
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes', fallbacks: [{ watch: 'sun', text: 'Sunset at 18:40' }] });
    await soon(async () => (await shown(k)).length === 1, 5000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), ['Sunset at 18:40']);
    assert.equal((await k.events(['reminder']))[0].data.aloud, true);
  } finally {
    await k.done();
  }
});

test("a trigger she says herself shows no reminder", async () => {
  const k = await liveKit([{ said: 'The sun sets soon.', audio: tone(0.1) }]);
  try {
    await k.voice.unlock();
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes', fallbacks: [{ watch: 'sun', text: 'Sunset at 18:40' }] });
    await soon(async () => (await k.events(['out.speak'])).length === 1, 3000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), []);
  } finally {
    await k.done();
  }
});

test("words a session failed to say are said aloud even with its voice in use: the microphone hears nothing meanwhile, and nothing of hers plays over them", async () => {
  const k = await liveKit([{}, {}, { said: 'Later words.', audio: tone(0.1) }], { voice: { playMs: 400 } });
  try {
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await tell(k);
    await soon(async () => k.platform.log.some((/** @type {string} */ l) => l.includes('play m-say:The fuel station')), 3000);
    assert.equal((await k.events(['reminder']))[0].data.aloud, true);
    assert.equal(k.voice.speaker.speaking, true);
    const started = k.server.received().filter((/** @type {any} */ m) => m.realtimeInput?.activityStart).length;
    k.platform.mic.feed(cat(quiet(0.3), hum(0.8), quiet(1)), RATE); // the fallback voice, at the microphone
    await wait(50);
    assert.equal(k.server.received().filter((/** @type {any} */ m) => m.realtimeInput?.activityStart).length, started, 'not heard as the user');
  } finally {
    await k.done();
  }
});

// The level check. The minimum is decided on the frame's own dB, so these feed whole sounds at known levels.
/** A room with something playing: its floor is learned over this, about -55 dB in the speech band. */
const room = (/** @type {number} */ seconds) => quiet(seconds, 0.006);
const starts = (/** @type {any} */ k) => k.server.received().filter((/** @type {any} */ m) => m.realtimeInput?.activityStart).length;
/** @param {any} k */
const opened = async (k) => {
  k.agent.tap();
  await until(() => k.agent.live.listening, 3000);
};
/** A session with the mic open, the tap's lift over, the user's level known. @param {any} k @param {number} [db] */
async function learned(k, db = -5) {
  await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } }); // no quiet spell closes it while a tap's lift runs out
  await opened(k);
  k.platform.mic.feed(room(1.5), RATE); // the floor is learned
  k.platform.mic.feed(cat(hum(0.6, 0.5), room(1)), RATE); // the tap's first turn: it lifts the minimum no more
  await soon(async () => (await k.events(['live.turn'])).length === 1, 3000);
  await k.agent.live.idle();
  await wait(1050); // a tap's lift: 8 s of the session's clock
  k.agent.live.level.reset();
  k.agent.live.level.heard(db);
  k.agent.live.level.heard(db);
}

test('level check: with something playing, sound quieter than the minimum starts no turn, and what it kept out is logged; the user at their own level still gets through', async () => {
  const k = await liveKit([{ heard: 'hello' }, { heard: 'where to', said: 'Tacos ahead.', audio: tone(0.1) }]);
  try {
    await learned(k);
    const before = starts(k);
    k.platform.mic.feed(cat(hum(1.5, 0.05), room(0.5)), RATE); // lyrics, far above the floor and 15+ dB under the voice
    await wait(80);
    assert.equal(starts(k), before, 'lyrics opened no turn');
    k.platform.mic.feed(cat(hum(0.6, 0.5), room(1)), RATE); // the user
    await soon(async () => starts(k) === before + 1, 2000);
    await soon(async () => (await k.events(['live.turn'])).length === 2, 3000);
    const turn = (await k.events(['live.turn']))[1].data;
    assert.equal(typeof turn.voiceDb, 'number');
    assert.equal(typeof turn.minDb, 'number');
    assert.ok(turn.keptFrames > 20, `${turn.keptFrames} frames kept out`);
    assert.equal(typeof turn.keptPeakDb, 'number');
  } finally {
    await k.done();
  }
});

test("level check: lyrics kept out don't keep the room noisy, so her voice doesn't start at once; and they don't raise the floor over the user's voice", async () => {
  const k = await liveKit([{ heard: 'hello' }]);
  try {
    await learned(k);
    const before = starts(k);
    for (let i = 0; i < 6; i++) k.platform.mic.feed(cat(hum(1.5, 0.05), room(0.1)), RATE); // ten seconds of them, hardly a gap
    k.platform.mic.feed(cat(hum(0.6, 0.35), room(1)), RATE); // the user, not loud: about -12 dB against a voice of -5
    await soon(async () => starts(k) === before + 1, 1000); // heard: the floor stayed down
  } finally {
    await k.done();
  }
});

test('level check: the user is never unheard: a quiet car has no minimum', async () => {
  const k = await liveKit([{ heard: 'hello', said: 'Hi.', audio: tone(0.1) }]);
  try {
    await opened(k);
    k.agent.live.level.heard(-3);
    k.agent.live.level.heard(-3);
    k.platform.mic.feed(quiet(1.5, 0.0002), RATE); // under -70 dB
    k.platform.mic.feed(cat(hum(0.6, 0.01), quiet(1, 0.0002)), RATE); // a word 30 dB under the voice
    await soon(async () => starts(k) >= 1, 1000); // heard
  } finally {
    await k.done();
  }
});

test("level check: the first turn of a session, with no voice learned, has no minimum; a tap lifts one for a while", async () => {
  const k = await liveKit([{ heard: 'hello' }, { heard: 'hello' }, { heard: 'la' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await opened(k);
    k.platform.mic.feed(room(1.5), RATE);
    k.platform.mic.feed(cat(hum(0.6, 0.03), room(1)), RATE); // quiet, first
    await soon(async () => starts(k) === 1, 2000);
    await soon(async () => (await k.events(['live.turn'])).length === 1, 3000);
    await k.agent.live.idle();
    await wait(1050); // a tap's lift
    // Loud once: quiet words are now under the minimum...
    k.agent.live.level.heard(-3);
    k.agent.live.level.heard(-3);
    k.platform.mic.feed(cat(hum(0.6, 0.03), room(1)), RATE);
    await wait(80);
    assert.equal(starts(k), 1, 'kept out');
  } finally {
    await k.done();
  }
  const k2 = await liveKit([{ heard: 'hello' }]);
  try {
    k2.agent.live.level.heard(-3);
    k2.agent.live.level.heard(-3); // loud in an earlier session
    await opened(k2); // ...and a tap lifts it, with the floor learned and something playing
    k2.platform.mic.feed(room(1.5), RATE);
    k2.platform.mic.feed(cat(hum(0.6, 0.03), room(1)), RATE);
    await soon(async () => starts(k2) === 1, 1000); // a tap: heard
  } finally {
    await k2.done();
  }
});

test('level check: a new audio route forgets the level: the first turn after it gets through', async () => {
  const k = await liveKit([{ heard: 'hello' }, { heard: 'hello' }]);
  try {
    k.voice.route = async () => 'speaker';
    await learned(k);
    await wait(20); // the route is read as the microphone opens
    k.agent.live.level.heard(-3);
    k.agent.live.level.heard(-3);
    k.voice.route = async () => 'car';
    k.agent.live.unmute(); // Halves asks on every change of the audio
    await wait(20);
    assert.equal(k.agent.live.level.db, null);
    const before = starts(k);
    k.platform.mic.feed(cat(hum(0.6, 0.03), room(1)), RATE);
    await soon(async () => starts(k) === before + 1, 1000);
  } finally {
    await k.done();
  }
});

test('level check: a session a note opened keeps the level learned before, and logs what the minimum kept out as its microphone closes', async () => {
  const k = await liveKit([{ heard: 'hello' }, { said: 'The fuel station is open until ten.', audio: tone(0.1) }]);
  try {
    await learned(k);
    k.agent.live.close('sleep');
    await k.agent.idle();
    assert.equal(typeof k.agent.live.level.db, 'number', 'kept across sessions');
    await k.agent.wake({ kind: 'trigger', text: 'A reminder' });
    await until(() => k.agent.live.listening, 3000);
    await soon(async () => (await k.events(['out.speak'])).length === 1, 3000);
    await k.agent.live.idle();
    k.platform.mic.feed(room(1.5), RATE);
    k.platform.mic.feed(hum(1, 0.05), RATE);
    const n = (await k.events(['live.turn'])).length;
    k.agent.live.close('sleep');
    await soon(async () => (await k.events(['live.turn'])).length === n + 1, 2000);
    const [last] = (await k.events(['live.turn'])).slice(-1);
    assert.equal(last.data.end, 'kept');
    assert.ok(last.data.keptFrames > 10);
  } finally {
    await k.done();
  }
});

test('ignoring: sound the minimum keeps out shows, with the words that offer a tap; the user\'s voice opens a turn and clears it', async () => {
  const k = await liveKit([{ heard: 'hello' }, { heard: 'where to', said: 'Tacos ahead.', audio: tone(0.1) }]);
  const names = /** @type {string[]} */ ([]);
  try {
    await learned(k);
    assert.equal(k.agent.state.name, 'listening');
    k.agent.on('state', (/** @type {any} */ s) => names.push(s.name));
    k.platform.mic.feed(hum(0.5, 0.05), RATE);
    assert.equal(k.agent.state.name, 'ignoring');
    assert.match(k.agent.state.label, /Ignoring sound/);
    k.platform.mic.feed(room(0.2), RATE);
    assert.equal(k.agent.state.name, 'ignoring', 'held past the last frame');
    k.platform.mic.feed(hum(0.6, 0.5), RATE); // the user
    assert.equal(k.agent.state.name, 'hearing');
    assert.ok(names.includes('ignoring') && names.at(-1) === 'hearing', names.join());
  } finally {
    await k.done();
  }
});

test('ignoring: it ends on its own about 3 s after the last sound kept out, and doesn\'t flicker before', async () => {
  const k = await liveKit([{ heard: 'hello' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } }); // 3 s here: longer than what this looks at
    await learned(k);
    k.platform.mic.feed(hum(0.3, 0.05), RATE);
    assert.equal(k.agent.state.name, 'ignoring');
    await wait(150); // 375 ms here
    k.platform.mic.feed(hum(0.1, 0.05), RATE);
    await wait(280);
    assert.equal(k.agent.state.name, 'ignoring', 'the later frame held it');
    await until(() => k.agent.state.name === 'listening', 1000);
  } finally {
    await k.done();
  }
});

test('ignoring: a tap keeps the microphone open and lifts the minimum: the soft word that follows is a turn', async () => {
  const k = await liveKit([{ heard: 'hello' }, { heard: 'soft', said: 'Yes?', audio: tone(0.1) }]);
  try {
    await learned(k);
    k.platform.mic.feed(hum(0.5, 0.03), RATE);
    assert.equal(k.agent.state.name, 'ignoring');
    const before = starts(k);
    assert.equal(k.agent.live.tap(), 'listening');
    assert.equal(k.agent.live.listening, true, 'still open');
    assert.equal(k.agent.state.name, 'listening');
    k.platform.mic.feed(cat(room(0.3), hum(0.6, 0.03), room(1)), RATE);
    await soon(async () => starts(k) === before + 1, 1000);
  } finally {
    await k.done();
  }
});

test('ignoring: a quiet car never shows it', async () => {
  const k = await liveKit([{ heard: 'hello' }]);
  const names = /** @type {string[]} */ ([]);
  try {
    await opened(k);
    k.agent.on('state', (/** @type {any} */ s) => names.push(s.name));
    k.agent.live.level.heard(-3);
    k.agent.live.level.heard(-3);
    k.platform.mic.feed(quiet(1.5, 0.0002), RATE);
    k.platform.mic.feed(cat(hum(0.6, 0.01), quiet(1, 0.0002)), RATE);
    await soon(async () => starts(k) === 1, 1000);
    assert.ok(!names.includes('ignoring'), names.join());
  } finally {
    await k.done();
  }
});
