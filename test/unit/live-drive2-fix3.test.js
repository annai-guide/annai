// The second drive's voice fixes, fix pass 3: a let-go lyric teaches nothing, Classic's window closes on stuck sound, a tap waits as long as the
// microphone does, a typed line reaches Koe's next Realtime model, the level resets once per tap, and a turn with no turnComplete is bounded from
// when her sound began.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until, agentKit } from './agent-kit.js';
import { liveKit, texts, soon, tone } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { ProviderError } from '../../src/core/llm/contract.js';

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const RATE = 16_000;
const FOR_USER = 'The fuel station ahead is open until ten tonight.';
const NOTE = 'Tell the user the fuel station ahead is open until ten tonight.';
/** @param {any} k @param {'append' | 'immediate'} [mode] */
const tell = (k, mode = 'append') => k.agent.channel.send('kokoro', NOTE, mode, 'tool', undefined, undefined, false, FOR_USER);
const lines = async (/** @type {any} */ k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data);
/** Koe's own tool results (Kokoro's come too, when it is told). @param {any} k */
const koeCalls = async (k) => (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.half === 'koe');
const room = (/** @type {number} */ seconds) => quiet(seconds, 0.006);
/** @param {any} k */
const opened = async (k) => {
  k.agent.tap();
  await until(() => k.agent.live.listening, 3000);
};
/** A session with the mic open, the tap's lift over, the user's level known. @param {any} k @param {number} [db] */
async function learned(k, db = -5) {
  await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
  await opened(k);
  k.platform.mic.feed(room(1.5), RATE);
  k.platform.mic.feed(cat(hum(0.6, 0.5), room(1)), RATE);
  await soon(async () => (await k.events(['live.turn'])).length === 1, 3000);
  await k.agent.live.idle();
  await wait(1050);
  k.agent.live.level.reset();
  k.agent.live.level.heard(db);
  k.agent.live.level.heard(db);
}

test('1: a lyric let go while a note goes in teaches no level, though her reply to the note marks it answered', async () => {
  const k = await liveKit([{ heard: 'hello' }, { heard: 'la la', delayMs: 3000 }, { said: 'The fuel station is open until ten.', audio: tone(0.1) }]);
  try {
    await learned(k, -33);
    k.agent.live.level.reset();
    k.agent.live.level.heard(-33);
    k.agent.live.level.heard(-40);
    assert.equal(k.agent.live.level.db, -40);
    k.platform.mic.feed(cat(hum(0.6, 0.5), room(1)), RATE); // a loud lyric, about -6 dB
    await soon(async () => (await k.events(['live.turn'])).length === 2, 3000);
    await tell(k, 'immediate'); // goes in as the lyric ends; her reply to it is the first thing the model says
    await soon(async () => (await lines(k)).length === 1, 3000);
    await k.agent.live.idle();
    assert.equal(k.agent.live.level.db, -40, 'the lyric taught nothing');
  } finally {
    await k.done();
  }
});

test('2: Classic: sound stuck with the window open closes it: the dock stops saying Listening', async () => {
  const k = await agentKit([], { halves: true, voice: { speechIn: ['m-hear'] } });
  await k.voice.unlock();
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  assert.equal(k.platform.mic.isOpen(), true);
  k.voice.soundStopped(); // a streaming reminder's stall
  assert.notEqual(k.agent.state.name, 'listening');
  assert.equal(k.platform.mic.isOpen(), false, 'the ear is on the closed context');
  await until(() => k.notices.some((/** @type {any} */ n) => n.key === 'sound'));
  await wait(50);
  assert.equal(k.notices.filter((/** @type {any} */ n) => n.key === 'sound').length, 1, 'one card');
  assert.equal(await k.voice.unlock(), true);
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  assert.equal(k.platform.mic.isOpen(), true);
});

test('3: a tap whose silent clip takes 1.5 s still opens the Classic microphone', async () => {
  const k = await agentKit([], { voice: { speechIn: ['m-hear'] } });
  await k.voice.unlock();
  k.voice.soundStopped();
  k.platform.player.unlock = async () => { await wait(1500); return true; };
  k.voice.unlock();
  const session = await k.voice.open({ kind: 'record', onSegment() {}, onError() {} });
  assert.equal(k.platform.mic.isOpen(), true);
  session.stop();
});

test('5: a typed line when the first Realtime model refuses goes to the next, and is answered there', async () => {
  const k = await liveKit([{ said: 'Yes, by the entrance.', audio: tone(0.1) }], { live: { second: true } });
  try {
    const live = k.llm.live;
    k.llm.live = async (/** @type {string} */ id, /** @type {any} */ setup, /** @type {any} */ o) => {
      if (id === 'm-live') throw new ProviderError('bad-request', 'Thinking level must be specified for this model.');
      return live(id, setup, o);
    };
    k.agent.send('Is there parking?');
    await soon(async () => texts(k).some((/** @type {string} */ x) => /Is there parking\?/.test(x)), 3000);
    assert.equal(k.agent.live.modelId, 'm-live2');
    await soon(async () => (await lines(k)).length === 1, 3000);
  } finally {
    await k.done();
  }
});

test('6: two turns answered inside one tap\'s lift both teach the level: it resets once per tap', async () => {
  const k = await liveKit([{ heard: 'one', said: 'First.', audio: tone(0.1) }, { heard: 'two', said: 'Second.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await opened(k);
    k.platform.mic.feed(room(1.5), RATE);
    k.platform.mic.feed(cat(hum(0.6, 0.5), room(1)), RATE);
    await soon(async () => (await k.events(['heard'])).length === 1, 3000); // answered, still inside the lift
    k.platform.mic.feed(cat(hum(0.6, 0.4), room(1)), RATE);
    await soon(async () => (await k.events(['heard'])).length === 2, 3000);
    await k.agent.live.idle();
    assert.notEqual(k.agent.live.level.db, null, 'two peaks are a level');
  } finally {
    await k.done();
  }
});

const CHECKING = { heard: 'where to', said: 'Let me check.', audio: tone(0.1), tool: { name: 'tell_kokoro', args: { text: 'Where should we stop?' } } };

test('9: the bound counts from when her sound began: her first word coming late doesn\'t end the turn under it', async () => {
  const k = await liveKit([{ ...CHECKING, noEnd: true, audio: tone(1.5), saidAt: 700 }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    k.platform.streamSpeed = 1;
    await opened(k);
    k.platform.mic.feed(cat(room(1.5), hum(0.6, 0.5), room(1)), RATE);
    await soon(async () => (await koeCalls(k)).length === 1, 3000);
    await wait(500); // past a flat bound of 250 ms, before her first word
    assert.equal(k.agent.live.busy, true, 'her sound is still to play');
    await soon(async () => (await lines(k)).length === 1, 5000);
    assert.equal((await lines(k))[0].text, 'Let me check.');
  } finally {
    await k.done();
  }
});

test('8: a silently answered call alone, no turnComplete ever: Kokoro\'s owed note is asked again at the bound, not at the silent wait', async () => {
  const k = await liveKit([{ tool: { name: 'tell_kokoro', args: { text: 'Anything on the way?' } }, noEnd: true }, { said: 'The fuel station is open until ten.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    await opened(k);
    await tell(k);
    await soon(async () => (await koeCalls(k)).length === 1, 10_000);
    await soon(async () => texts(k).filter((x) => /^\[annai\]/.test(x)).length === 1, 10_000);
    const silent = (await k.events(['error'])).filter((/** @type {any} */ e) => e.data.kind === 'live-silent');
    assert.deepEqual(silent, [], 'asked at the bound, before the silent wait gave up');
  } finally {
    await k.done();
  }
});
