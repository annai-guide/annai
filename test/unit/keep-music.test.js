// Keep my music playing (Settings → Voice, spec §10.1, §10.4; the user's report of 2026-11-21 and their answer U114 of 2026-11-26): on, her sound is
// the mixing kind (`ambient`) wherever it was `playback`, so other apps' music plays on under her, and no microphone opens by itself; a tap still listens,
// and play-and-record pauses the music then. Off, everything is as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear, idleAtOnce } from './agent-kit.js';
import { liveKit, soon, tone } from './koe-live-kit.js';
import { useClock } from './clock.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { voiceSettings } from '../../src/core/voice/settings.js';

/** Turns the switch on or off as the Voice screen does: saved, then the voice worked out again. @param {any} k @param {boolean} on */
const keep = async (k, on) => {
  await updateAppSettings(k.ws, { voice: { keepMusic: on } });
  await k.voice.refresh();
};
const speak = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }] });
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
/** The microphone's openings and closings, in order. @param {any} k */
const mics = (k) => k.platform.log.filter((/** @type {string} */ l) => l.startsWith('mic '));
/** Each call of a tool's result, in order. @param {any} k @param {string} name */
const results = async (k, name) => (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.name === name);
const MUSIC = "annai couldn't listen: the user keeps their music playing, so the microphone opens only when they tap you. The user may type.";

test('the setting: off unless saved as true', () => {
  assert.equal(voiceSettings({}).keepMusic, false);
  assert.equal(voiceSettings({ voice: { keepMusic: true } }).keepMusic, true);
  for (const v of ['true', 1, 'on', null]) assert.equal(voiceSettings({ voice: { keepMusic: v } }).keepMusic, false, String(v));
});

test('off: speak, then her listening, a tap and the first tap set the audio session exactly as before (spec §10.1)', async (t) => {
  useClock(t);
  const k = await agentKit([[speak('Want to stop for tacos?'), say('Great.'), say('Here.')]], { voice: { speechIn: ['m-hear'], hears: ['yes the first one', 'is there coffee nearby'] } });
  await keep(k, false);
  k.voice.unlock();
  assert.deepEqual(k.platform.sessions, [], 'the first tap sets nothing: the type stays auto');
  k.agent.send('Where should we eat?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await idleAtOnce(k);
  assert.deepEqual(k.platform.sessions, ['playback', 'play-and-record', 'playback', 'playback'], 'speaking, speak listening, its close, speaking again');
  assert.deepEqual(mics(k), ['mic open', 'mic close']);
  assert.equal((await results(k, 'speak'))[0].data.content, 'Said aloud. The user said:');
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'gas-station');
  await idleAtOnce(k);
  assert.deepEqual(k.platform.sessions.slice(4), ['play-and-record', 'playback', 'playback'], 'the tap listening, her answer, and after it');
  assert.ok(!k.platform.sessions.includes('ambient'));
});

test('on: she speaks with the mixing kind, no microphone opens, and the turn ends with her words, for no model call', async (t) => {
  useClock(t);
  const k = await agentKit([[speak('Anything else?'), say('unused')]], { voice: { speechIn: ['m-hear'] } });
  await keep(k, true);
  /** @type {string[]} */
  const states = [];
  k.agent.on('state', (/** @type {any} */ s) => states.push(s.name));
  k.agent.send('Thanks');
  await idleAtOnce(k);
  await new Promise((r) => setTimeout(r, 300)); // past her 20 s of listening (10 ms a second): nothing opened meanwhile
  assert.deepEqual(k.platform.sessions, ['ambient', 'ambient'], 'speaking, and the core\'s own call after the turn (#afterTurn: the browser plugin skips a type it has already, this fake records every call)');
  assert.equal(k.platform.opens, 0);
  assert.deepEqual(mics(k), []);
  assert.equal((await results(k, 'speak'))[0].data.content, `Said aloud. ${MUSIC}`);
  assert.equal(k.requests.length, 1, 'she would only have called sleep');
  assert.ok(!states.includes('listening') && !states.includes('hearing'), `the dock never said Listening: ${states}`);
  assert.equal(k.agent.state.name, 'sleeping');
});

test('on: a tap still listens (play-and-record, which pauses the music), her answer is the mixing kind again, and she does not listen on after it', async (t) => {
  useClock(t);
  const k = await agentKit([[speak('Yes, there is a café ahead.'), say('unused')]], { voice: { speechIn: ['m-hear'], hears: ['is there coffee nearby'] } });
  await keep(k, true);
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'gas-station');
  await idleAtOnce(k);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(k.platform.sessions, ['ambient', 'play-and-record', 'ambient', 'ambient'], 'the tap\'s unlock, its microphone, her answer, and after it');
  assert.deepEqual(mics(k), ['mic open', 'mic close'], 'the tap\'s microphone only');
  assert.equal((await results(k, 'speak'))[0].data.content, `Said aloud. ${MUSIC}`);
  assert.equal(k.requests.length, 1);
  assert.equal(k.agent.state.name, 'sleeping');
});

test('on: her wait opens no microphone, and a tap while she waits listens for its answer', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'wait', input: { seconds: 600 } }] }, say('Ramen it is.')]], { voice: { speechIn: ['m-hear'], hears: ['the first one'] } });
  await keep(k, true);
  k.agent.send('Give me a minute');
  await until(() => k.agent.state.name === 'waiting');
  assert.equal(k.platform.opens, 0, 'her wait opened nothing');
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await idleAtOnce(k);
  assert.equal((await results(k, 'wait'))[0].data.content, 'The user said:');
  assert.equal(k.platform.opens, 1, 'the tap\'s');
  assert.ok(!k.platform.sessions.includes('playback'), `${k.platform.sessions}`);
});

test('on: her question aloud opens no microphone, and waits for a tap on its buttons', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'ask', input: { question: 'Tacos or ramen?', options: ['Tacos', 'Ramen'] } }] }, say('Tacos it is.')]], { voice: { speechIn: ['m-hear'] } });
  await keep(k, true);
  k.agent.send('Where to eat?');
  await until(() => k.said.includes('Tacos or ramen?') && k.agent.state.name === 'waiting');
  await new Promise((r) => setTimeout(r, 200)); // past her question's 8 s: still waiting, by hand
  assert.equal(k.platform.opens, 0);
  assert.equal(k.agent.state.label, 'Waiting for your OK');
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Tacos');
  await idleAtOnce(k);
  assert.equal((await results(k, 'ask'))[0].data.content, 'The user chose: Tacos');
  assert.equal(k.platform.opens, 0);
  assert.deepEqual([...new Set(k.platform.sessions)], ['ambient']);
});

test('on: the wait tool waits for typing, with no microphone', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'wait', input: { seconds: 10 } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: { speechIn: ['m-hear'] } });
  await keep(k, true);
  k.agent.send('Give me a minute');
  await until(() => k.agent.state.name === 'waiting');
  assert.deepEqual([k.agent.state.name, k.agent.state.label], ['waiting', 'Your turn']);
  k.agent.send('Ready');
  await idleAtOnce(k);
  assert.equal((await results(k, 'wait'))[0].data.content, 'The user wrote: Ready');
  assert.equal(k.platform.opens, 0);
});

test('turned on while she listens: voice off and on again does not open her microphone again (spec §10.5)', async (t) => {
  useClock(t);
  const k = await agentKit([[speak('Which day would you like?'), { toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: { speechIn: ['m-hear'] } });
  k.agent.send('Plan our day');
  await until(() => k.agent.state.name === 'listening');
  await keep(k, true);
  await k.voice.choose('off');
  await k.voice.choose('on');
  await idleAtOnce(k);
  assert.deepEqual(mics(k), ['mic open', 'mic close'], 'opened before the switch, and not again');
});

test('on: the first tap sets the mixing kind before the silent clip that unlocks sound plays, but never under an open microphone', async (t) => {
  useClock(t);
  const k = await agentKit([[say('x')]], { voice: {} });
  await keep(k, true);
  /** @type {string[][]} */
  const at = [];
  const unlock = k.platform.player.unlock;
  k.platform.player.unlock = (/** @type {any} */ o) => { at.push([...k.platform.sessions]); return unlock(o); };
  await k.voice.unlock();
  assert.deepEqual(at, [['ambient']]);
  // Sound that got stuck while a microphone is open: the next tap's unlock leaves play-and-record alone, and still unlocks the player.
  k.platform.sessions.length = 0;
  k.voice.soundStopped();
  k.voice.session('play-and-record');
  const used = k.platform.mic.inUse;
  k.platform.mic.inUse = () => ({ label: 'iPhone Microphone', deviceId: 'm1' });
  await k.voice.unlock();
  k.platform.mic.inUse = used;
  assert.deepEqual(k.platform.sessions, ['play-and-record']);
  assert.deepEqual(at, [['ambient'], ['play-and-record']], 'the player was unlocked again, with the session as it was');
});

test("where the browser has no audio session (Chrome), a saved switch does nothing: she speaks with playback and listens as before", async (t) => {
  useClock(t);
  const k = await agentKit([[speak('Anything else?'), { toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: { speechIn: ['m-hear'] } });
  k.platform.audioSession = false;
  await keep(k, true);
  k.agent.send('Thanks');
  await idleAtOnce(k);
  assert.equal(k.platform.sessions[0], 'playback');
  assert.deepEqual(mics(k), ['mic open', 'mic close']);
  assert.equal((await results(k, 'speak'))[0].data.content, 'Said aloud. Heard nothing (20 seconds).');
});

test('Live with the switch on: its microphone is play-and-record for the session as before (it pauses the music), and its close is the mixing kind', async () => {
  const k = await liveKit([]);
  try {
    await keep(k, true);
    k.agent.tap();
    await until(() => k.agent.live.listening);
    assert.equal(k.platform.sessions.at(-1), 'play-and-record');
    k.agent.live.close('voice');
    assert.equal(k.platform.sessions.at(-1), 'ambient');
    assert.ok(!k.platform.sessions.includes('playback'), `${k.platform.sessions}`);
  } finally {
    await k.done();
  }
});

// Her turn with a call after speak, then words with no sleep: the window after she spoke would open here (switch off); with it on, nothing does.
const SPEAK_SHOW = { toolCalls: [{ name: 'speak', input: { text: 'Here it is.' } }, { name: 'show', input: { card: { title: 'Bixby Bridge', text: 'Ahead.' } } }] };

test('on: the window after she spoke stays shut: speak with another call after it, then words with no sleep, and no microphone opens at all', async (t) => {
  useClock(t);
  const k = await agentKit([[SPEAK_SHOW, { text: 'Done.' }]], { voice: { speechIn: ['m-hear'] } });
  await keep(k, true);
  /** @type {string[]} */
  const states = [];
  k.agent.on('state', (/** @type {any} */ s) => states.push(s.name));
  k.agent.send('What is ahead?');
  await idleAtOnce(k);
  await new Promise((r) => setTimeout(r, 300)); // past her 20 s of listening and the window's
  assert.equal(k.requests.length, 2, 'speak and show, then her words: the turn did not end at speak');
  assert.equal((await results(k, 'speak'))[0].data.content, `Said aloud. ${MUSIC}`);
  assert.equal(k.platform.opens, 0);
  assert.deepEqual(mics(k), []);
  assert.ok(!states.includes('listening'), `the dock never said Listening: ${states}`);
  assert.equal(k.agent.state.name, 'sleeping');
  // The same turn with the switch off: she listens (speak's listening, and the window after her words), so this turn does reach those doors.
  const off = await agentKit([[SPEAK_SHOW, { text: 'Done.' }]], { voice: { speechIn: ['m-hear'] } });
  await keep(off, false);
  off.agent.send('What is ahead?');
  await until(() => off.agent.state.name === 'listening');
  assert.ok(off.platform.opens >= 1);
});

test('on: a tap answers her wait, and her reply has no speech: the tap\'s microphone closes with her turn, and is not made the window after she spoke', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Take your time.' } }, { name: 'wait', input: { seconds: 600 } }] }, { text: 'Noted.' }]], { voice: { speechIn: ['m-hear'], hears: ['the first one'] } });
  await keep(k, true);
  k.agent.send('Give me a minute');
  await until(() => k.agent.state.name === 'waiting');
  assert.equal(k.platform.opens, 0, 'her wait opened nothing');
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await idleAtOnce(k);
  assert.equal((await results(k, 'wait'))[0].data.content, 'The user said:');
  assert.equal(k.platform.mic.isOpen(), false, 'closed at the turn\'s end, not left open for the window after she spoke');
  assert.equal(k.agent.state.name, 'sleeping');
  assert.deepEqual(mics(k), ['mic open', 'mic close']);
  assert.equal(k.platform.sessions.at(-1), 'ambient');
});

test('on: a tap\'s microphone that hears nothing closes on its time with the mixing kind, never playback', async (t) => {
  useClock(t);
  const k = await agentKit([[say('x')]], { voice: { speechIn: ['m-hear'] } });
  await keep(k, true);
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await until(() => k.platform.sessions.at(-1) === 'ambient' && mics(k).length === 2, 3000); // its 8 s: 80 ms here
  assert.deepEqual(k.platform.sessions, ['ambient', 'play-and-record', 'ambient']);
  assert.deepEqual(mics(k), ['mic open', 'mic close']);
});

test('on: a voice\'s Test, a microphone test and a microphone that failed to open all leave the mixing kind, never playback', async () => {
  const k = await agentKit([[say('x')]], { voice: { speechIn: ['m-hear'] } });
  await keep(k, true);
  await k.voice.sample('m-say', 'Hello there.');
  assert.deepEqual(k.platform.sessions, ['ambient'], 'a voice\'s Test (Voice.sample)');
  k.platform.sessions.length = 0;
  assert.equal(await k.voice.listenOnce({ seconds: 0.02 }), null);
  assert.deepEqual(k.platform.sessions, ['play-and-record', 'ambient'], 'a microphone test\'s end (listenOnce)');
  const bad = await agentKit([[say('x')]], { voice: { speechIn: ['m-hear'], micFails: 'NotAllowedError' } });
  await keep(bad, true);
  bad.platform.sessions.length = 0;
  await assert.rejects(bad.voice.open({ kind: 'record', onSegment: () => {}, onError: () => {} }), /Permission denied/);
  assert.deepEqual(bad.platform.sessions, ['play-and-record', 'ambient'], 'a microphone that failed to open (Voice.open)');
});

/** The session types set, one each. @param {any} k */
const kinds = (k) => [...new Set(k.platform.sessions)];
const REMINDER = { kind: 'trigger', text: 'Sunset in 30 minutes', fallbacks: [{ watch: 'sun', text: 'Sunset at 18:40' }] };
const URGENT = { kind: 'trigger', text: 'Leave now', fallbacks: [{ watch: 'ferry', text: 'Leave now for the ferry.' }], urgent: true };

for (const [name, wake] of /** @type {[string, any][]} */ ([['a trigger', REMINDER], ['an urgent note', URGENT]])) {
  test(`Live, the switch on and sound unlocked: ${name} opens a session by itself that speaks, listens to nothing, and closes by itself; a tap on it then listens`, async () => {
    const k = await liveKit([{ said: 'The sun sets soon.', audio: tone(0.1) }, { said: 'Go ahead.', audio: tone(0.1) }]);
    try {
      await keep(k, true);
      await k.voice.unlock();
      await k.agent.wake(wake); // it returns once the session has spoken and gone quiet
      await soon(async () => (await k.events(['out.speak'])).length === 1, 5000);
      assert.equal(k.platform.opens, 0, 'no microphone');
      assert.deepEqual(kinds(k), ['ambient'], 'her sound is the mixing kind, and nothing paused the music');
      await until(() => k.agent.live.state === 'closed', 3000); // by itself: its answer time ran out with nobody there
      assert.equal(k.platform.opens, 0);
      assert.deepEqual(kinds(k), ['ambient']);
      assert.deepEqual(mics(k), []);
      // A tap on one still open: it listens (play-and-record, which stops the music), and its close sets the mixing kind.
      const again = k.agent.wake(wake);
      await until(() => k.agent.live.state === 'open', 3000);
      assert.equal(k.platform.opens, 0);
      k.agent.tap();
      await until(() => k.agent.live.listening, 3000);
      assert.equal(k.platform.opens, 1, 'the tap\'s');
      assert.equal(k.platform.sessions.at(-1), 'play-and-record');
      k.agent.live.close('voice');
      await until(() => k.platform.sessions.at(-1) === 'ambient', 1000); // at once, or once her voice has faded out
      assert.ok(!k.platform.sessions.includes('playback'), `${k.platform.sessions}`);
      await again;
    } finally {
      await k.done();
    }
  });

  test(`Live, the switch off: ${name} listens after her as before (play-and-record, a microphone)`, async () => {
    const k = await liveKit([{ said: 'The sun sets soon.', audio: tone(0.1) }]);
    try {
      await keep(k, false);
      await k.voice.unlock();
      await k.agent.wake(wake);
      await until(() => k.agent.live.listening, 3000);
      assert.equal(k.platform.opens, 1);
      assert.ok(k.platform.sessions.includes('play-and-record'));
      assert.ok(!k.platform.sessions.includes('ambient'));
    } finally {
      await k.done();
    }
  });
}

test('Live with the switch on: a microphone that failed leaves the mixing kind, and the close of a session whose voice is still fading too, never playback', async () => {
  const failing = await liveKit([], { voice: { micFails: 'NotAllowedError' } });
  try {
    await keep(failing, true);
    failing.agent.tap();
    await until(() => failing.notices.some((/** @type {any} */ n) => n.tone === 'warn'), 3000);
    assert.deepEqual(failing.platform.sessions.slice(0, 3), ['ambient', 'play-and-record', 'ambient'], 'the first tap, the microphone asked for, the failure (#deaf)');
    assert.ok(!failing.platform.sessions.includes('playback'), `${failing.platform.sessions}`);
  } finally {
    await failing.done();
  }
  const k = await liveKit([{ said: 'The bridge ahead was built in 1932 and it is one of the most photographed on the coast.', audio: tone(3) }], { pace: 1 });
  try {
    await keep(k, true);
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening);
    k.agent.send('Tell me about the bridge');
    await until(() => k.agent.live.view.name === 'speaking');
    await new Promise((r) => setTimeout(r, 300));
    k.agent.live.close('voice');
    assert.equal(k.platform.sessions.at(-1), 'play-and-record', 'not yet: her voice is fading out');
    await until(() => k.platform.sessions.at(-1) === 'ambient', 1000); // once the fade is over
    assert.ok(!k.platform.sessions.includes('playback'), `${k.platform.sessions}`);
  } finally {
    await k.done();
  }
});
