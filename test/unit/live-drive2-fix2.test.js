// The second drive's voice fixes, fix pass 2: the level check after a tap, a session that stays dead, sound stuck for every microphone, the
// order of what the user sends, and a note that waited for a turnComplete that never came.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until, agentKit } from './agent-kit.js';
import { liveKit, texts, soon, tone } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';
import { updateAppSettings } from '../../src/core/settings.js';

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const RATE = 16_000;
const FOR_USER = 'The fuel station ahead is open until ten tonight.';
const NOTE = 'Tell the user the fuel station ahead is open until ten tonight.';
/** @param {any} k @param {'append' | 'immediate'} [mode] */
const tell = (k, mode = 'append') => k.agent.channel.send('kokoro', NOTE, mode, 'tool', undefined, undefined, false, FOR_USER);
const lines = async (/** @type {any} */ k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data);
const room = (/** @type {number} */ seconds) => quiet(seconds, 0.006);
const starts = (/** @type {any} */ k) => k.server.received().filter((/** @type {any} */ m) => m.realtimeInput?.activityStart).length;
const cues = async (/** @type {any} */ k) => (await k.events(['wake'])).filter((/** @type {any} */ e) => (e.data.reasons ?? []).some((/** @type {any} */ w) => /didn't answer/.test(String(w.text ?? ''))));
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

test('1: a tap while Ignoring, music on: the lyric after it teaches nothing, reads as nobody\'s own, and wakes no Kokoro', async () => {
  const k = await liveKit([{ heard: 'hello' }, { heard: 'la la' }, { heard: 'na na' }, { heard: 'oh oh' }]);
  try {
    await learned(k);
    const heard = (await k.events(['heard'])).length;
    k.platform.mic.feed(hum(0.5, 0.03), RATE);
    assert.equal(k.agent.state.name, 'ignoring');
    assert.equal(k.agent.live.tap(), 'listening');
    k.platform.mic.feed(cat(room(0.3), hum(0.6, 0.05), room(1)), RATE); // the first sound after the tap: a lyric, at about -26 dB
    await soon(async () => (await k.events(['heard'])).length === heard + 1, 3000);
    await k.agent.live.idle();
    assert.equal(k.agent.live.level.db, -5, 'let go: nothing learned, nothing forgotten');
    k.platform.mic.feed(cat(hum(0.6, 0.05), room(1)), RATE);
    await soon(async () => (await k.events(['heard'])).length === heard + 2, 3000);
    await k.agent.idle();
    assert.deepEqual((await k.events(['heard'])).slice(heard).map((/** @type {any} */ e) => e.data.ownLevel), [undefined, undefined]);
    assert.deepEqual(await cues(k), []);
  } finally {
    await k.done();
  }
});

test('1: a first answered lyric, music on, doesn\'t make the next lyrics the user\'s own: one turn is no level', async () => {
  const k = await liveKit([{ said: 'The fuel station is open.', audio: tone(0.1) }, { heard: 'la la', said: 'A song?', audio: tone(0.1) }, { heard: 'na na' }, { heard: 'oh oh' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    await tell(k);
    await until(() => k.agent.live.listening, 3000);
    await soon(async () => (await lines(k)).length === 1, 3000);
    await k.agent.live.idle();
    k.platform.mic.feed(cat(room(1.5), hum(0.6, 0.1), room(1)), RATE);
    await soon(async () => (await lines(k)).length === 2, 3000);
    await k.agent.live.idle();
    assert.equal(k.agent.live.level.db, null);
    for (const n of [2, 3]) {
      k.platform.mic.feed(cat(hum(0.6, 0.1), room(1)), RATE);
      await soon(async () => (await k.events(['heard'])).length === n, 3000);
      await k.agent.live.idle();
    }
    await k.agent.idle();
    assert.deepEqual((await k.events(['heard'])).slice(1).map((/** @type {any} */ e) => e.data.ownLevel), [undefined, undefined]);
    assert.deepEqual(await cues(k), []);
  } finally {
    await k.done();
  }
});

test('1: turns at the user\'s own level, let go, cue Kokoro once until an exchange: an answered turn lets the next one cue', async () => {
  const k = await liveKit([{ heard: 'okay' }, { heard: 'one' }, { heard: 'two' }, { heard: 'three' }, { heard: 'where to', said: 'Tacos.', audio: tone(0.1) }, { heard: 'four' }]);
  try {
    await learned(k, -10);
    const loud = cat(hum(0.6, 0.3), room(1));
    const heard = (await k.events(['heard'])).length;
    const turn = async (/** @type {number} */ n) => {
      k.platform.mic.feed(loud, RATE);
      await soon(async () => (await k.events(['heard'])).length === heard + n, 3000);
      await k.agent.live.idle();
      await k.agent.idle();
    };
    await turn(1);
    await turn(2);
    await turn(3);
    const was = (await cues(k)).length;
    assert.deepEqual((await k.events(['heard'])).slice(heard).map((/** @type {any} */ e) => e.data.ownLevel), [true, true, true], 'the lines say so');
    assert.equal(was, 1, 'three lines, one Kokoro turn');
    await turn(4);
    await turn(5);
    assert.equal((await cues(k)).length, 2, 'after her answer, again');
  } finally {
    await k.done();
  }
});

test('decision 8: a real first turn let go in a note\'s session, in a quiet car with nothing learned, still cues Kokoro', async () => {
  const k = await liveKit([{ said: 'The fuel station is open.', audio: tone(0.1) }, { heard: 'okay thanks' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    await tell(k);
    await until(() => k.agent.live.listening, 3000);
    await soon(async () => (await lines(k)).length === 1, 3000);
    await k.agent.live.idle();
    k.platform.mic.feed(cat(quiet(1.5), hum(0.6, 0.1), quiet(1)), RATE);
    await soon(async () => (await k.events(['heard'])).length === 1, 3000);
    await soon(async () => (await cues(k)).length === 1, 3000);
    assert.equal((await k.events(['heard']))[0].data.ownLevel, true);
    assert.equal(k.agent.live.level.db, null, 'and it teaches nothing');
  } finally {
    await k.done();
  }
});

test('decision 7: a loud answered lyric leaves the normal voice able to open a turn', async () => {
  const k = await liveKit([{ heard: 'hello' }, { heard: 'la la', said: 'A song?', audio: tone(0.1) }, { heard: 'where to', said: 'Tacos.', audio: tone(0.1) }]);
  try {
    await learned(k, -35);
    k.agent.live.level.heard(-35);
    k.platform.mic.feed(cat(hum(0.6, 0.5), room(1)), RATE); // about -8 dB, answered
    await soon(async () => (await lines(k)).length === 1, 3000);
    await k.agent.live.idle();
    const before = starts(k);
    k.platform.mic.feed(cat(hum(0.6, 0.03), room(1)), RATE); // about -33 dB: the normal voice
    await soon(async () => starts(k) === before + 1, 1000);
  } finally {
    await k.done();
  }
});

test('2: a session that stays silent reconnects once until an answer, and the quiet spell closes it: the microphone doesn\'t stay open on music', async () => {
  const k = await liveKit([{ silent: true }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } }); // 3 s here
    await opened(k);
    const end = Date.now() + 15_000;
    let bursts = 0;
    while (k.agent.live.state !== 'closed' && Date.now() < end) {
      k.platform.mic.feed(cat(room(0.2), hum(0.5, 0.5), room(1)), RATE);
      bursts++;
      await wait(1250); // 10 s of the session's clock
    }
    assert.equal(k.agent.live.state, 'closed', `still open after ${bursts} bursts`);
    assert.equal(k.platform.mic.isOpen(), false);
    assert.equal(k.server.connections().length, 2, 'one reconnect');
  } finally {
    await k.done();
  }
});

test('2: an answer after the rescue lets a later dead stretch reconnect once more', async () => {
  const k = await liveKit([{ silent: true }, { silent: true }, { heard: 'there', said: 'Back.', audio: tone(0.1) }, { silent: true }, { silent: true }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await opened(k);
    const burst = async (/** @type {number} */ n) => {
      k.platform.mic.feed(cat(room(0.2), hum(0.5, 0.5), room(1)), RATE);
      await soon(async () => n === 0 || (await k.events(['error'])).filter((/** @type {any} */ e) => e.data.kind === 'live-silent').length === n, 3000);
    };
    await burst(1);
    await burst(2);
    await soon(async () => k.server.connections().length === 2, 3000);
    await soon(async () => k.agent.live.busy === false, 3000);
    await burst(0); // answered
    await soon(async () => (await lines(k)).length === 1, 3000);
    await k.agent.live.idle();
    await burst(3);
    await burst(4);
    await soon(async () => k.server.connections().length === 3, 3000);
  } finally {
    await k.done();
  }
});

test('4: sound stuck under annai\'s other voice closes the live microphone too: the dock never says Listening, deaf', async () => {
  const k = await liveKit([{ heard: 'hello', said: 'Hi.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    await opened(k);
    assert.equal(k.agent.state.name, 'listening');
    k.voice.soundStopped(); // what a streaming reminder's stall does (Speaker's onBlocked)
    assert.equal(k.agent.live.listening, false);
    assert.equal(k.platform.mic.isOpen(), false);
    assert.equal(k.agent.live.voiced, false);
    assert.notEqual(k.agent.state.name, 'listening');
    assert.equal(k.notices.filter((/** @type {any} */ n) => n.key === 'sound').length, 1, 'one card');
    assert.equal(await k.voice.unlock(), true);
    assert.ok(k.platform.log.includes('unlock fresh'));
    await opened(k);
    assert.equal(k.agent.state.name, 'listening');
  } finally {
    await k.done();
  }
});

test('4: no other microphone opens on stuck sound: Voice.open says so; the tap that brings it back, still starting, is waited for', async () => {
  const k = await liveKit([{ heard: 'hello' }]);
  try {
    const o = { kind: /** @type {const} */ ('record'), onSegment() {}, onError() {} };
    await k.voice.unlock();
    k.voice.soundStopped();
    k.platform.player.unlock = async () => false;
    await assert.rejects(k.voice.open(o), (/** @type {any} */ e) => e.stuck === true && /stuck/.test(e.message));
    assert.equal(k.platform.mic.isOpen(), false);
    k.platform.player.unlock = async () => { await wait(30); return true; };
    k.voice.unlock();
    const session = await k.voice.open(o);
    assert.equal(k.platform.mic.isOpen(), true);
    session.stop();
  } finally {
    await k.done();
  }
});

test('4: Classic\'s tap while sound stays stuck shows the sound card, not one about the microphone', async () => {
  const k = await agentKit([], { voice: { speechIn: ['m-hear'] } });
  await k.voice.unlock();
  k.voice.soundStopped();
  k.platform.player.unlock = async () => false;
  k.agent.tap();
  await k.agent.idle();
  await soon(async () => k.notices.some((/** @type {any} */ n) => n.key === 'sound'), 1000);
  assert.deepEqual(k.notices.filter((/** @type {any} */ n) => /microphone/i.test(n.title)), []);
  assert.equal(k.platform.mic.isOpen(), false);
});

test('5a: a clip that never ends, sound stuck: her later replies are written at once, not at the tap', async () => {
  const k = await liveKit([{ heard: 'hello', said: 'Hi.', audio: tone(0.1) }, { said: 'The fuel station is open until ten.', audio: tone(0.1) }], { voice: { playMs: 60_000 } });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    await k.agent.live.open('tap');
    k.voice.say('A clip that never ends.').catch(() => {});
    await wait(20);
    k.voice.soundStopped();
    assert.equal(k.voice.speaker.speaking, true);
    await tell(k);
    await soon(async () => (await lines(k)).length >= 1, 1500);
  } finally {
    await k.done();
  }
});

test('5c: sound stuck again within 5 s of a tap brings a card again', async () => {
  const k = await liveKit([{ heard: 'hello' }]);
  try {
    await k.voice.unlock();
    k.voice.soundStopped();
    await k.voice.unlock();
    k.voice.soundStopped();
    assert.equal(k.notices.filter((/** @type {any} */ n) => n.key === 'sound').length, 2);
  } finally {
    await k.done();
  }
});

test('5d: a slow first line (a photo) is written and sent first, and a line written waits for no session', async () => {
  const k = await liveKit([{ said: 'One.', audio: tone(0.1) }, { said: 'Two.', audio: tone(0.1) }]);
  try {
    await k.agent.opening;
    const logUser = k.agent.koe.logUser.bind(k.agent.koe);
    let slow = true;
    k.agent.koe.logUser = async (/** @type {any[]} */ ...a) => {
      if (slow) {
        slow = false;
        await wait(120);
      }
      return logUser(...a);
    };
    k.agent.send('First line.');
    k.agent.send('Second line.');
    await soon(async () => (await k.events(['msg.user'])).length === 2, 3000);
    assert.deepEqual((await k.events(['msg.user'])).map((/** @type {any} */ e) => e.data.text), ['First line.', 'Second line.']);
    await soon(async () => texts(k).length >= 2, 3000);
    assert.deepEqual(texts(k).slice(0, 2).map((t) => t.replace(/<[^>]+>/g, '')), ['[typed] First line.', '[typed] Second line.']);
  } finally {
    await k.done();
  }
});

const CHECKING = { heard: 'where to', said: 'Let me check.', audio: tone(0.1), tool: { name: 'tell_kokoro', args: { text: 'Where should we stop?' } } };

test('6: a tool response with no turnComplete: her turn ends a little past her sound, and a note goes in', async () => {
  const k = await liveKit([{ ...CHECKING, noEnd: true }, { said: 'The fuel station is open until ten.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    await opened(k);
    k.platform.mic.feed(cat(room(1.5), hum(0.6, 0.5), room(1)), RATE);
    await soon(async () => (await k.events(['tool.result'])).length === 1, 3000);
    await tell(k);
    assert.equal(texts(k).length, 0, 'it waits for her turn');
    // Two seconds of the session's clock, 250 ms here.
    await soon(async () => texts(k).length === 1, 1500);
    assert.deepEqual((await lines(k)).map((/** @type {any} */ d) => d.text), ['Let me check.']);
    await soon(async () => (await lines(k)).length === 2, 1500);
    assert.equal((await lines(k))[1].text, 'The fuel station is open until ten.');
    assert.equal(k.agent.live.busy, false);
  } finally {
    await k.done();
  }
});

test('6: a turnComplete in good time ends her turn as ever: nothing more happens at the bound', async () => {
  const k = await liveKit([CHECKING]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    await opened(k);
    k.platform.mic.feed(cat(room(1.5), hum(0.6, 0.5), room(1)), RATE);
    await soon(async () => (await lines(k)).length === 1, 3000);
    const heard = (await k.events(['heard'])).map((/** @type {any} */ e) => e.data.dismissed);
    await wait(400);
    assert.deepEqual((await k.events(['heard'])).map((/** @type {any} */ e) => e.data.dismissed), heard);
    assert.equal((await lines(k)).length, 1);
  } finally {
    await k.done();
  }
});

test('6: the bound waits for her sound, and for more of her turn: a long sentence isn\'t ended under it', async () => {
  const k = await liveKit([{ ...CHECKING, noEnd: true, audio: tone(4) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    k.platform.streamSpeed = 1;
    await opened(k);
    k.platform.mic.feed(cat(room(1.5), hum(0.6, 0.5), room(1)), RATE);
    await soon(async () => (await k.events(['tool.result'])).length === 1, 3000);
    await soon(async () => k.platform.streams.length === 1, 3000);
    await wait(1000);
    assert.equal(k.platform.streams[0].ended, false, 'not before 4 s of sound and the wait');
    assert.deepEqual(await lines(k), []);
  } finally {
    await k.done();
  }
});

test('6: a turnComplete that comes after the bound is that turn\'s: never an answer to what the user said since', async () => {
  const k = await liveKit([{ ...CHECKING, endAt: 500 }, { heard: 'and then', said: 'Then the coast.', audio: tone(0.1), delayMs: 400 }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    await opened(k);
    k.platform.mic.feed(cat(room(1.5), hum(0.6, 0.5), room(1)), RATE);
    await soon(async () => (await lines(k)).length === 1, 3000); // ended at the bound, about 350 ms in
    await k.agent.live.idle();
    k.platform.mic.feed(cat(hum(0.6, 0.5), room(1)), RATE);
    await soon(async () => (await lines(k)).length === 2, 3000);
    await k.agent.idle();
    assert.deepEqual((await k.events(['heard'])).map((/** @type {any} */ e) => e.data.dismissed), [undefined, undefined]);
  } finally {
    await k.done();
  }
});
