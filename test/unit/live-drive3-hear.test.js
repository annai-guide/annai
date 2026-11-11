// The third drive's "hears from the first tap" (drive-3 design, D4 and D5): a microphone whose audio thread never runs takes the dock off
// Listening and says tap, in live voice and in classic; between the user's tap and Listening the dock says "One moment…", while a session
// opened to speak (a note) shows her thinking; and a tap while it opens stops it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until, agentKit } from './agent-kit.js';
import { liveKit, soon, tone } from './koe-live-kit.js';
import { LABELS } from '../../src/core/agent/loop.js';
import { updateAppSettings } from '../../src/core/settings.js';

const FOR_USER = 'The fuel station ahead is open until ten tonight.';
const NOTE = 'Tell the user the fuel station ahead is open until ten tonight.';
/** @param {any} k */
const tell = (k) => k.agent.channel.send('kokoro', NOTE, 'append', 'tool', undefined, undefined, false, FOR_USER);
const STUCK = 'Tap the screen so Shiori can speak';

/** Something the test lets go of when it says. @returns {[Promise<void>, () => void]} */
function gate() {
  /** @type {() => void} */
  let open = () => {};
  return [new Promise((r) => { open = () => r(undefined); }), () => open()];
}

/** The microphone's open held until the returned function is called. @param {any} k */
function slowMic(k) {
  const open = k.platform.mic.open;
  const [held, release] = gate();
  k.platform.mic.open = async (/** @type {any} */ o) => {
    await held;
    return open.call(k.platform.mic, o);
  };
  return release;
}

/** The live session's connection held where it has begun to open (Koe's conversation still opening), until the returned function is called. @param {any} k */
function slowSession(k) {
  const [held, release] = gate();
  k.agent.koe.opening = held;
  return release;
}

/** What the dock is told, in order. @param {any} k */
function dock(k) {
  /** @type {{ name: string, label: string }[]} */
  const views = [];
  k.agent.on('state', (/** @type {any} */ s) => views.push({ name: s.name, label: s.label }));
  return views;
}

test('D5: a tap\'s live session says "One moment…" while it connects and while its microphone starts, awake and never thinking; Listening only once it hears', async () => {
  const k = await liveKit([]);
  try {
    const views = dock(k);
    const connected = slowSession(k);
    const micOpen = slowMic(k);
    k.agent.tap();
    await until(() => k.agent.live.state === 'opening', 5000);
    assert.deepEqual(k.agent.live.view, { name: 'opening', label: 'One moment…' }, 'connecting');
    connected();
    await until(() => k.agent.live.state === 'open', 5000);
    await new Promise((r) => setTimeout(r, 30)); // the microphone is still being asked for
    assert.equal(k.agent.live.listening, false);
    assert.equal(k.agent.live.view.name, 'opening', 'its microphone starting');
    micOpen();
    await until(() => k.agent.live.listening, 3000);
    assert.equal(k.agent.live.view.name, 'listening');
    const names = views.map((v) => v.name);
    assert.ok(!names.includes('thinking'), `never thinking: ${JSON.stringify(names)}`);
    assert.ok(names.indexOf('opening') < names.indexOf('listening'), JSON.stringify(names));
    assert.equal(views.find((v) => v.name === 'opening')?.label, LABELS.opening);
  } finally {
    await k.done();
  }
});

test('D5 (fix pass): after a tap the dock is told "One moment…", then Listening, nothing between; a refused microphone: "One moment…", then what the failure leaves', async () => {
  const k = await liveKit([]);
  try {
    const views = dock(k);
    k.agent.tap();
    await until(() => k.agent.live.listening, 5000);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(views.map((v) => v.name), ['opening', 'listening'], 'no "Tap to talk" between the session opening and its microphone starting');
    k.agent.tap(); // stops it
    await until(() => k.agent.live.state === 'closed', 3000);
    views.length = 0;
    const open = k.platform.mic.open;
    k.platform.mic.open = async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); };
    k.agent.tap();
    await soon(async () => k.notices.some((/** @type {any} */ n) => /microphone/i.test(`${n.title} ${n.body}`)), 5000);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(views.map((v) => v.name), ['opening', 'sleeping'], 'the session stays, without its microphone');
    k.platform.mic.open = open;
  } finally {
    await k.done();
  }
});

test('D5: a session a note opens to speak shows her thinking while it opens, not "One moment…"', async () => {
  const k = await liveKit([]);
  try {
    await k.voice.unlock();
    const views = dock(k);
    const micOpen = slowMic(k);
    tell(k);
    await until(() => k.agent.live.state === 'open', 5000);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(k.agent.live.view.name, 'thinking', 'her microphone starting, for a session opened to speak');
    micOpen();
    await until(() => k.agent.live.listening, 3000);
    assert.ok(!views.some((v) => v.name === 'opening'), JSON.stringify(views));
  } finally {
    await k.done();
  }
});

test('D5: a tap while a tap\'s session is still connecting stops it: it never opens, and no microphone is asked for', async () => {
  const k = await liveKit([]);
  try {
    const connected = slowSession(k);
    k.agent.tap();
    await until(() => k.agent.live.state === 'opening', 5000);
    assert.equal(k.agent.tap(), 'stopped');
    assert.equal(k.agent.live.state, 'closed');
    assert.equal(k.agent.live.view.name, 'sleeping');
    connected();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(k.agent.live.state, 'closed', 'the connection that finished afterwards is let go');
    assert.ok(!k.platform.log.includes('mic open'));
  } finally {
    await k.done();
  }
});

test('D4, live: a microphone whose audio thread never runs takes the dock off Listening at once: a card says tap, and the next tap makes the sound anew and listens', async () => {
  const k = await liveKit([]);
  try {
    const views = dock(k);
    k.platform.micStuckMs = 50;
    k.agent.tap();
    await soon(async () => k.notices.some((/** @type {any} */ n) => n.title === STUCK), 5000);
    assert.equal(k.voice.stuck, true);
    assert.equal(k.agent.live.listening, false);
    assert.notEqual(k.agent.live.view.name, 'listening');
    assert.ok(!views.some((v) => v.name === 'listening'), `the dock never said Listening: ${JSON.stringify(views.map((v) => v.name))}`);
    k.platform.micStuckMs = 0;
    k.agent.tap();
    await until(() => k.agent.live.listening, 5000);
    assert.ok(k.platform.log.includes('unlock fresh'), 'the tap made the sound anew');
  } finally {
    await k.done();
  }
});

test('D4, classic: a microphone whose audio thread never runs: the card says tap, and the dock never says Listening', async () => {
  const k = await agentKit([[{ text: 'Hi.' }]], { voice: { playMs: 5, speechIn: ['m-hear'] } });
  /** @type {string[]} */
  const names = [];
  k.agent.on('state', (/** @type {any} */ s) => names.push(s.name));
  k.platform.micStuckMs = 50;
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.notices.some((/** @type {any} */ n) => n.title === STUCK), 5000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(k.voice.stuck, true);
  assert.ok(!names.includes('listening'), JSON.stringify(names));
  assert.notEqual(k.agent.state.name, 'listening');
});

test('D5 in classic voice too (the coordinator\'s call): after a tap the dock is told "One moment…", then Listening; a tap meanwhile stops it, and the window that opens afterwards is let go', async () => {
  const k = await agentKit([[{ text: 'Hi.' }]], { voice: { playMs: 5, speechIn: ['m-hear'] } });
  /** @type {string[]} */
  const names = [];
  k.agent.on('state', (/** @type {any} */ s) => names.push(s.name));
  assert.equal(k.agent.tap(), 'listening');
  assert.equal(k.agent.state.name, 'opening');
  assert.equal(k.agent.state.label, 'One moment…');
  await until(() => k.agent.state.name === 'listening', 5000);
  assert.deepEqual(names, ['opening', 'listening']);
  assert.equal(k.agent.tap(), 'stopped');
  await until(() => !k.platform.mic.isOpen(), 3000);
  names.length = 0;
  assert.equal(k.agent.tap(), 'listening');
  assert.equal(k.agent.tap(), 'stopped', 'a tap while it opens stops it');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(k.platform.mic.isOpen(), false, 'the window that finished opening afterwards is let go');
  assert.notEqual(k.agent.state.name, 'listening');
  assert.ok(!names.includes('listening'), JSON.stringify(names));
  assert.equal(k.agent.state.name, 'sleeping');
});

test('D4 (fix pass): Test the microphone on stuck sound says tap, and the tap makes the sound anew, so the test works again', async () => {
  const k = await agentKit([[{ text: 'Hi.' }]], { voice: { playMs: 5, speechIn: ['m-hear'] } });
  k.platform.micStuckMs = 20;
  await assert.rejects(k.voice.listenOnce({ seconds: 1 }), (/** @type {any} */ e) => e.stuck === true && /Tap the screen/.test(e.message));
  assert.equal(k.voice.stuck, true, 'marked where every stuck open is, whoever opened it');
  k.platform.micStuckMs = 0;
  await k.voice.unlock(); // the tap the advice asks for
  assert.ok(k.platform.log.includes('unlock fresh'), 'the tap made the sound anew');
  assert.equal(k.voice.stuck, false);
  assert.equal(await k.voice.listenOnce({ seconds: 0.05 }), null, 'it listens again (nothing said)');
  assert.ok(k.platform.log.includes('mic open'));
});

for (const type of ['gemini-live', 'openai-realtime']) {
  test(`R1: a tap that cuts her while the microphone listens tells the dock Listening at once, never "Thinking · tap to stop" (${type === 'gemini-live' ? 'a provider annai sends no cut' : 'a provider annai sends a cut'})`, async () => {
    const k = await liveKit([{ said: 'The bridge ahead was built in 1932 and it is one of the most photographed on the coast.', audio: tone(3) }], { pace: 1, live: { type } });
    try {
      await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } }); // the quiet spell, on the kit's 10 ms second, closes nothing here
      k.platform.streamSpeed = 1;
      k.agent.tap();
      await until(() => k.agent.live.listening, 5000);
      k.agent.send('Tell me about the bridge');
      await until(() => k.agent.live.view.name === 'speaking', 5000);
      await new Promise((r) => setTimeout(r, 300));
      const views = dock(k);
      assert.equal(k.agent.tap(), 'cut');
      await new Promise((r) => setTimeout(r, 400)); // the rest of her turn may still be coming
      assert.deepEqual(views.map((v) => v.name), ['listening']);
      assert.equal(k.agent.live.listening, true);
    } finally {
      await k.done();
    }
  });
}

test('R2: a classic tap whose open fails outside its own catch (a store read) goes back to "Tap to talk", and is no longer opening', async () => {
  const k = await agentKit([[{ text: 'Hi.' }]], { voice: { playMs: 5, speechIn: ['m-hear'] } });
  /** @type {string[]} */
  const names = [];
  k.agent.on('state', (/** @type {any} */ s) => names.push(s.name));
  k.voice.howToListen = async () => { throw new Error('the store could not be read'); };
  assert.equal(k.agent.tap(), 'listening');
  await until(() => !k.agent.tapOpening, 3000);
  assert.deepEqual(names, ['opening', 'sleeping']);
  assert.equal(k.agent.state.label, LABELS.sleeping);
});

test('R2: with voice off, a tap whose open fails that way lets go of the voice it held on for that tap', async () => {
  const k = await agentKit([{ rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] }], { halves: true, voice: { mode: 'off', speechIn: ['m-hear'] } });
  k.voice.howToListen = async () => { throw new Error('the store could not be read'); };
  k.agent.tap();
  await until(() => k.voice.on, 3000); // the tap holds voice on for its exchange
  await until(() => !k.voice.on, 3000); // and lets go once the open has failed
  assert.notEqual(k.agent.state.name, 'opening');
});
