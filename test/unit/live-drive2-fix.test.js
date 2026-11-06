// The second drive's voice fixes, fix pass 1: sound that stops coming out loses no words, the level check learns only from the user, and
// the review's findings on the windows, the notes and a dead session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until, agentKit, hear } from './agent-kit.js';
import { useClock } from './clock.js';
import { liveKit, texts, soon, tone, say, lives } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { armUnlock, UNLOCK_EVENTS } from '../../src/ui/unlock.js';

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const RATE = 16_000;
const WORDS = 'The bridge ahead was built in 1932.';
const FOR_USER = 'The fuel station ahead is open until ten tonight.';
const NOTE = 'Tell the user the fuel station ahead is open until ten tonight.';
/** @param {any} k @param {'append' | 'immediate'} [mode] */
const tell = (k, mode = 'append') => k.agent.channel.send('kokoro', NOTE, mode, 'tool', undefined, undefined, false, FOR_USER);
const shown = async (/** @type {any} */ k) => (await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text);
const lines = async (/** @type {any} */ k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data);
const CUE = /^\[annai\] /;
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
  k.platform.mic.feed(cat(hum(0.6, 0.5), room(1)), RATE); // the tap's turn
  await soon(async () => (await k.events(['live.turn'])).length === 1, 3000);
  await k.agent.live.idle();
  await wait(1050); // a tap's lift: 8 s of the session's clock
  k.agent.live.level.reset();
  k.agent.live.level.heard(db);
  k.agent.live.level.heard(db);
}

test('H1: a live reply whose sound stalls loses nothing: her whole words are written and said by the speech voice, the screen says a tap fixes it, the microphone closes', async () => {
  const k = await liveKit([{ heard: 'Where should we eat?', said: WORDS, audio: tone(0.2) }, { heard: 'And then?', said: 'Then the coast.', audio: tone(0.1) }]);
  /** @type {string[]} */
  const cleared = [];
  k.agent.on('clear', (/** @type {string} */ key) => cleared.push(key));
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    k.platform.streamStalls = true;
    await opened(k);
    await say(k, 'where-eat');
    await soon(async () => (await lines(k)).length === 1, 8000);
    const [line] = await lines(k);
    assert.deepEqual([line.text, line.cut, line.voice], [WORDS, undefined, true], 'whole, not cut');
    const [reply] = await k.events(['live.reply']);
    assert.equal(reply.data.stalled, true);
    await soon(async () => k.platform.log.some((/** @type {string} */ l) => l === `play m-say:${WORDS}`), 2000);
    assert.equal(k.voice.unlocked, false, 'whole clips until a tap');
    assert.equal(k.agent.live.voiced, false);
    assert.equal(k.agent.live.listening, false);
    assert.equal(k.platform.mic.isOpen(), false, 'no microphone: the context it runs on is stuck');
    const card = k.notices.find((/** @type {any} */ n) => /stuck/i.test(n.body));
    assert.match(card.title, /Tap the screen/);
    assert.equal(card.key, 'sound');
    // A tap anywhere makes the sound anew; the card goes; a tap on Shiori listens, and her next reply plays again.
    k.platform.streamStalls = false;
    assert.equal(await k.voice.unlock(), true);
    assert.ok(k.platform.log.includes('unlock fresh'), 'a new context, in the tap');
    assert.deepEqual(cleared, ['sound']);
    await opened(k);
    await say(k, 'gas-station');
    await soon(async () => (await lines(k)).length === 2, 3000);
    assert.equal(k.platform.streams.length, 2);
    assert.equal((await lines(k))[1].cut, undefined);
  } finally {
    await k.done();
  }
});

test('H1: a stall as her sound starts, her turn still coming: the words are written at the turn\'s end, whole; a note in them is passed on', async () => {
  const k = await liveKit([{ said: 'The fuel station is open until ten.', audio: tone(1) }], { pace: 1 });
  try {
    await k.voice.unlock();
    await tell(k);
    await until(() => k.platform.streams.length === 1, 3000);
    k.platform.streams[0].stall();
    await wait(30);
    assert.deepEqual(await lines(k), [], 'at the turn\'s end');
    await soon(async () => (await lines(k)).length === 1, 3000);
    await k.agent.idle();
    assert.equal((await k.events(['out.speak']))[0].data.cut, undefined);
    assert.deepEqual(await shown(k), [], 'her words reached the user');
  } finally {
    await k.done();
  }
});

test('H1: a tap always reaches the unlock: armUnlock stays armed after one worked, and Voice does nothing while sound is fine', async () => {
  const target = new EventTarget();
  let calls = 0;
  armUnlock(target, () => { calls++; return true; });
  target.dispatchEvent(new Event(UNLOCK_EVENTS[0]));
  await wait(1);
  target.dispatchEvent(new Event(UNLOCK_EVENTS[0]));
  assert.equal(calls, 2);
});

test('level: a turn she let go teaches nothing and is not the user\'s own level with none learned; one she answers teaches', async () => {
  // A slower clock and a long answer window: on the kit's, a starved CPU's session closes between turns.
  const k = await liveKit([{ said: 'The fuel station is open.', audio: tone(0.1) }, { heard: 'la la' }, { heard: 'where to', said: 'Tacos ahead.', audio: tone(0.1) }], { agent: { secondMs: 100 } });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 600;
    await k.voice.unlock();
    await tell(k);
    await until(() => k.agent.live.listening, 60_000);
    await soon(async () => (await lines(k)).length === 1);
    await k.agent.live.idle();
    k.platform.mic.feed(cat(room(1.5), hum(0.6, 0.1), room(1)), RATE); // lyrics, in a session nobody tapped
    await soon(async () => (await k.events(['heard'])).length === 1);
    await k.agent.live.idle();
    assert.equal(k.agent.live.level.db, null, 'a turn let go teaches nothing');
    assert.equal((await k.events(['heard']))[0].data.ownLevel, undefined, 'no level learned: not the user\'s own');
    k.platform.mic.feed(cat(hum(0.6, 0.1), room(1)), RATE);
    await soon(async () => (await lines(k)).length === 2);
    await k.agent.live.idle();
    assert.equal(k.agent.live.level.db, null, 'she answered it, but one may be a lyric');
  } finally {
    await k.done();
  }
});

test('level: a tapped turn she answers sets voiceDb anew, down too: the old level is gone, and the next answered turn sets it', async () => {
  const k = await liveKit([{ heard: 'hello', said: 'Hi.', audio: tone(0.1) }, { heard: 'yes', said: 'Good.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.level.heard(0);
    k.agent.live.level.heard(0);
    await opened(k);
    k.platform.mic.feed(cat(room(1.5), hum(0.6, 0.03), room(1)), RATE);
    await soon(async () => (await lines(k)).length === 1, 3000);
    await k.agent.live.idle();
    assert.equal(k.agent.live.level.db, null, 'what it knew is gone, and one turn says nothing yet');
    k.platform.mic.feed(cat(hum(0.6, 0.03), room(1)), RATE);
    await soon(async () => (await lines(k)).length === 2, 3000);
    await k.agent.live.idle();
    assert.ok(/** @type {number} */ (k.agent.live.level.db) < -20, `${k.agent.live.level.db}`);
  } finally {
    await k.done();
  }
});

test('level: the floor carries across sessions, so a lyric in the first second of a note\'s session is kept out; a route change forgets it', async () => {
  const k = await liveKit([{ heard: 'hello' }, { said: 'The fuel station is open.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    await learned(k);
    k.agent.live.close('sleep');
    await k.agent.idle();
    const before = starts(k);
    await tell(k);
    await until(() => k.agent.live.listening, 3000);
    await soon(async () => (await lines(k)).length === 1, 3000);
    await k.agent.live.idle();
    k.platform.mic.feed(cat(room(0.2), hum(0.5, 0.05), room(0.5)), RATE); // the session's first second of sound
    await wait(50);
    assert.equal(starts(k), before, 'kept out');
  } finally {
    await k.done();
  }
});

test('a tap while Ignoring lifts the minimum for 8 s, not for one turn: a lyric that takes the lift leaves the soft word its way in, and Ignoring stays away', async () => {
  const k = await liveKit([{ heard: 'hello' }, { heard: 'la la' }, { heard: 'soft', said: 'Yes?', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await learned(k);
    k.platform.mic.feed(hum(0.5, 0.03), RATE);
    assert.equal(k.agent.state.name, 'ignoring');
    const before = starts(k);
    assert.equal(k.agent.live.tap(), 'listening');
    k.platform.mic.feed(cat(room(0.3), hum(0.6, 0.05), room(1)), RATE); // the next lyric
    await soon(async () => starts(k) === before + 1, 1000);
    await soon(async () => (await k.events(['heard'])).length >= 2, 2000);
    k.platform.mic.feed(cat(hum(0.6, 0.03), room(1)), RATE); // the soft word
    await soon(async () => starts(k) === before + 2, 1000);
    assert.notEqual(k.agent.state.name, 'ignoring');
    await wait(1050);
    await k.agent.live.idle();
    k.agent.live.level.heard(-5);
    k.agent.live.level.heard(-5);
    k.platform.mic.feed(hum(0.5, 0.03), RATE);
    assert.equal(k.agent.state.name, 'ignoring', 'after the 8 s, it holds again');
  } finally {
    await k.done();
  }
});

test('the dock says she is working, not Listening, while the microphone is deaf for an urgent note', async () => {
  const k = await liveKit([{ said: 'The fuel station is open until ten.', audio: tone(0.2), delayMs: 400 }]);
  try {
    await k.voice.unlock();
    await tell(k);
    await until(() => k.agent.live.listening, 3000);
    assert.equal(k.agent.live.view.name, 'thinking');
    await soon(async () => (await lines(k)).length === 1, 3000);
    await k.agent.live.idle();
    assert.equal(k.agent.live.view.name, 'listening');
  } finally {
    await k.done();
  }
});

test('a dead session: the first turn with nothing back is let go, no line, no card, still listening; the second straight one reconnects with the handle, and no words', async () => {
  const k = await liveKit([{ silent: true }, { silent: true }, { heard: 'there', said: 'Back.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await opened(k);
    const n = k.notices.length;
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['error'])).filter((/** @type {any} */ e) => e.data.kind === 'live-silent').length === 1, 4000);
    assert.equal(k.server.connections().length, 1);
    assert.equal(k.agent.live.view.name, 'listening');
    assert.equal(k.notices.length, n);
    assert.deepEqual(await lines(k), []);
    await say(k, 'gas-station');
    const setups = () => k.server.received().filter((/** @type {any} */ m) => m.setup);
    await soon(async () => setups().length === 2, 4000);
    assert.equal(typeof setups()[1].setup.sessionResumption.handle, 'string', 'with the handle');
    assert.deepEqual(texts(k), [], 'no words sent again');
    assert.equal(k.agent.live.listening, true);
  } finally {
    await k.done();
  }
});

test('a heard word back keeps a session that lets go of turns: no reconnect', async () => {
  const k = await liveKit([{ heardFirst: true, heard: 'la', silent: true }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await opened(k);
    for (const [i, c] of ['where-eat', 'gas-station'].entries()) {
      await say(k, c);
      await soon(async () => (await k.events(['error'])).filter((/** @type {any} */ e) => e.data.kind === 'live-silent').length === i + 1, 4000);
    }
    assert.equal(k.server.connections().length, 1);
  } finally {
    await k.done();
  }
});

test('the speech pipeline leaves the audio session alone while a microphone is open', async () => {
  const k = await liveKit([{ heard: 'hello' }]);
  try {
    await k.voice.unlock();
    k.platform.input = { label: 'iPhone Microphone', deviceId: 'd' };
    await opened(k);
    const n = k.platform.sessions.length;
    await k.voice.say('A reminder.');
    assert.deepEqual(k.platform.sessions.slice(n), []);
    k.agent.live.close('tap');
    await k.voice.say('Another.');
    assert.equal(k.platform.sessions.at(-1), 'playback');
  } finally {
    await k.done();
  }
});

test('item 12: a typed line is written at once, though a session waits for the reminder being said', async () => {
  const k = await liveKit([{ said: 'Yes.', audio: tone(0.1) }], { voice: { playMs: 300 } });
  try {
    await k.voice.unlock();
    const said = k.voice.say('Your reminder, whole.');
    await wait(20);
    k.agent.send('A typed line.');
    await soon(async () => (await k.events(['msg.user'])).length === 1, 150);
    assert.equal(k.voice.speaker.speaking, true);
    assert.equal((await said).cut, null);
  } finally {
    await k.done();
  }
});

test('item 12: a reminder that begins while the socket connects isn\'t cut: the session goes on waiting for it', async () => {
  const k = await liveKit([{ said: 'The fuel station is open until ten.', audio: tone(0.1) }], { voice: { playMs: 300 } });
  try {
    await k.voice.unlock();
    const live = k.llm.live;
    /** @type {Promise<any> | null} */
    let said = null;
    k.llm.live = async (/** @type {string} */ id, /** @type {any} */ setup, /** @type {any} */ o) => {
      said = k.voice.say('Your reminder, whole.');
      await wait(20);
      return live(id, setup, o);
    };
    await tell(k);
    await until(() => said !== null, 2000);
    assert.equal((await said).cut, null, 'said whole');
    await soon(async () => (await lines(k)).length === 1, 3000);
  } finally {
    await k.done();
  }
});

test('why=pathway: a healthy session stays when a rest ends and an earlier model comes back; it closes when its own model rests or leaves the list', async () => {
  const k = await liveKit([{ heard: 'hello', said: 'Hi.', audio: tone(0.1) }], { live: { second: true } });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.llm.bench.bench('m-live', 60_000);
    await k.agent.chooseKoe('realtime');
    await opened(k);
    assert.equal(k.agent.live.modelId, 'm-live2');
    k.llm.bench.clear('m-live');
    await k.agent.chooseKoe('realtime'); // a refresh
    assert.equal(k.agent.live.state, 'open');
    assert.deepEqual(await lives(k, 'closed'), []);
    k.llm.bench.bench('m-live2', 60_000);
    await k.agent.chooseKoe('realtime');
    assert.equal(k.agent.live.state, 'closed');
  } finally {
    await k.done();
  }
});

test('Step 2: a tap that cuts her off inside a note: not said again, and its words for the user are shown, silently', async () => {
  const k = await liveKit([{ heard: 'hello', said: 'Hi.', audio: tone(0.1) }, { said: 'The fuel station is open until ten.', audio: tone(1.5) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    k.platform.streamSpeed = 1;
    await opened(k);
    await say(k, 'where-eat');
    await soon(async () => (await lines(k)).length === 1, 4000);
    await k.agent.live.idle();
    await tell(k);
    await soon(async () => k.agent.live.view.name === 'speaking', 3000);
    assert.equal(k.agent.live.tap(), 'cut');
    await soon(async () => (await shown(k)).length === 1, 2000);
    assert.deepEqual(await shown(k), [FOR_USER]);
    assert.notEqual((await k.events(['reminder']))[0].data.aloud, true);
    await wait(300);
    assert.equal(texts(k).filter((t) => CUE.test(t)).length, 0, 'not asked again');
  } finally {
    await k.done();
  }
});

test('Step 3: the wait for a reminder leaves no timer behind', async () => {
  const k = await liveKit([{ said: 'Yes.', audio: tone(0.1) }], { voice: { playMs: 30 } });
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  /** @type {Set<any>} */
  const long = new Set();
  /** @type {any} */ (globalThis).setTimeout = (/** @type {any} */ fn, /** @type {number} */ ms, /** @type {any[]} */ ...a) => {
    const id = real.set(fn, ms, ...a);
    if (ms >= 50_000 && ms <= 70_000) long.add(id);
    return id;
  };
  /** @type {any} */ (globalThis).clearTimeout = (/** @type {any} */ id) => { long.delete(id); real.clear(id); };
  try {
    await k.voice.unlock();
    const said = k.voice.say('A reminder.');
    await tell(k);
    await said;
    await soon(async () => (await lines(k)).length === 1, 3000);
    assert.equal(long.size, 0);
  } finally {
    globalThis.setTimeout = real.set;
    globalThis.clearTimeout = real.clear;
    await k.done();
  }
});

test('Step 4: one microphone batch that keeps a frame out and starts the user\'s turn leaves no "ignoring" behind', async () => {
  const k = await liveKit([{ heard: 'hello' }, { heard: 'where to' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await learned(k);
    k.platform.mic.feed(cat(hum(0.3, 0.03), hum(0.3, 0.5)), RATE);
    assert.equal(k.agent.state.name, 'hearing');
    k.platform.mic.feed(cat(hum(0.3, 0.5), room(1)), RATE);
    assert.equal(k.agent.live.view.name === 'ignoring', false);
  } finally {
    await k.done();
  }
});

test('Step 5: a note\'s words cut off in a turn that called a tool it speaks after: asked once more only after that answer', async () => {
  const k = await liveKit([
    { heard: 'hello', said: 'Hi.', audio: tone(0.1) },
    { said: 'The fuel station is open until ten.', audio: tone(1.5), tool: { name: 'list', args: { path: '/trip/' } } },
    { delayMs: 400, said: 'Nothing in the trip.', audio: tone(0.1) },
  ]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.platform.streamSpeed = 1;
    await opened(k);
    await say(k, 'where-eat');
    await soon(async () => (await lines(k)).length === 1, 4000);
    await k.agent.live.idle();
    k.platform.mic.feed(quiet(0.5), RATE);
    await tell(k);
    await soon(async () => k.agent.live.view.name === 'speaking', 3000);
    await wait(100);
    k.platform.mic.feed(cat(hum(0.8), quiet(1)), RATE);
    await soon(async () => (await k.events(['out.speak'])).some((/** @type {any} */ e) => e.data.cut), 3000);
    await wait(50);
    assert.equal(texts(k).filter((t) => CUE.test(t)).length, 0, 'not before the tool\'s answer');
  } finally {
    await k.done();
  }
});

const choose = (/** @type {'A' | 'B'} */ letter) => ({ toolCalls: [{ name: 'decide', input: { option: letter } }] });
const speakOnly = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }] });

test('item 10: chatter in speak\'s window neither closes the microphone nor extends it: the window runs from her last words', async (t) => {
  useClock(t);
  const k = await agentKit([[speakOnly('Bixby Bridge is ahead.')]], { voice: { decide: [choose('B'), choose('B')], speechIn: ['m-hear'], hears: ['turn the radio down', 'pass the water'] } });
  await updateAppSettings(k.ws, { voice: { silenceSeconds: 100 } }); // 1 s of the test's clock
  k.agent.send('What is ahead?');
  await until(() => k.agent.state.name === 'listening');
  const from = Date.now();
  await hear(k, 'where-lunch');
  await until(() => (k.requests.length >= 2));
  await wait(10);
  assert.equal(k.platform.mic.isOpen(), true, 'chatter closes nothing');
  assert.equal(k.agent.state.name, 'listening');
  await hear(k, 'where-lunch');
  await k.agent.idle();
  assert.ok(Date.now() - from <= 1100, `${Date.now() - from} ms`);
  const speak = (await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'speak');
  assert.match(speak.data.content, /Heard nothing/);
  const heard = await k.events(['heard']);
  assert.deepEqual(heard.map((/** @type {any} */ e) => e.data.dismissed), [true, true]);
  assert.equal(k.requests.filter((/** @type {any} */ r) => !String(r.system ?? '').startsWith('You make one quick decision')).length, 1, 'no call for chatter');
  assert.equal(k.platform.mic.isOpen(), false);
});

test('Step 1: a turn cut by opening another conversation leaves no microphone open in the one left', async () => {
  const k = await agentKit([[speakOnly('Bixby Bridge is ahead, and it is a long way off.')]], { voice: { speechIn: ['m-hear'], playMs: 150 } });
  k.agent.send('What is ahead?');
  await until(() => k.agent.state.name === 'speaking');
  await k.agent.open(null);
  await k.agent.idle();
  await wait(30);
  assert.equal(k.platform.mic.isOpen(), false, 'no microphone');
  assert.notEqual(k.agent.state.name, 'listening');
});

test('level: a turn after the tap\'s lift ran out says nothing about the user\'s voice', async () => {
  const k = await liveKit([{ heard: 'hello' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.level.heard(0);
    k.agent.live.level.heard(0);
    await opened(k);
    k.platform.mic.feed(room(1.5), RATE);
    await wait(1050);
    k.platform.mic.feed(cat(hum(0.6, 0.5), room(1)), RATE);
    await soon(async () => (await k.events(['live.turn'])).length === 1, 3000);
    await k.agent.live.idle();
    assert.equal(k.agent.live.level.db, 0, 'as it was');
  } finally {
    await k.done();
  }
});

test('H1: a microphone that can\'t start as its sound is stuck: the same way out, no card about the microphone', async () => {
  const k = await liveKit([{ said: 'The fuel station is open until ten.', audio: tone(0.1) }]);
  try {
    await k.voice.unlock();
    k.platform.mic.open = async () => { throw Object.assign(new Error('stuck'), { stuck: true }); };
    await tell(k);
    await soon(async () => (await lines(k)).length === 1, 3000);
    assert.equal(k.voice.unlocked, false);
    assert.equal(k.notices.length, 1);
    assert.equal(k.notices[0].key, 'sound');
    assert.equal((await lines(k))[0].voice, true, 'said by the speech voice');
    assert.ok(k.platform.log.includes('play m-say:The fuel station is open until ten.'));
  } finally {
    await k.done();
  }
});
