// Detailed trace's recordings, on annai's side: what the microphone heard goes to a plugin that asked ('heard-clips'), and to nobody else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './agent-kit.js';
import { LiveInput } from '../../src/core/realtime/input.js';
import { joinPcm } from '../../src/core/voice/pcm.js';
import { liveKit, say, soon, tone } from './koe-live-kit.js';
import { quiet, cat, clip } from './voice-kit.js';

const VOICE = { encoder: { makes: ['ogg'] }, plays: ['ogg', 'mp3', 'wav'] };
/** Listens as Remote trace does. @param {any} k @returns {{ clips: any[], off: () => void }} */
function listen(k) {
  /** @type {any[]} */
  const clips = [];
  return { clips, off: k.registry.add('remote-trace', 'heard-clips', { clip: (/** @type {any} */ c) => clips.push(c) }) };
}

test('a live turn reaches a plugin that asked, in the smallest format, under its heard entry\'s id; no blob is kept without "Keep voice clips"', async () => {
  const k = await liveKit([{ heard: 'Where should we eat?', said: 'Tacos.', audio: tone(0.2) }], { voice: VOICE });
  try {
    const { clips } = listen(k);
    k.agent.tap();
    await until(() => k.agent.live.listening);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['heard'])).length > 0 && clips.length > 0);
    const [heard] = await k.events(['heard']);
    assert.equal(clips.length, 1);
    assert.equal(clips[0].id, heard.data.id);
    assert.equal(clips[0].kind, 'turn');
    assert.equal(clips[0].format, 'ogg');
    assert.ok(clips[0].data.length > 0 && clips[0].ms > 0);
    assert.equal(heard.data.clip, undefined, 'the conversation keeps nothing');
    assert.equal(heard.refs, undefined);
  } finally {
    await k.done();
  }
});

test('a live turn with no words still reaches the plugin: music that opened a turn is what the check is tuned from; it has no heard entry', async () => {
  const k = await liveKit([{ said: '', audio: tone(0.1) }], { voice: VOICE });
  try {
    const { clips } = listen(k);
    k.agent.tap();
    await until(() => k.agent.live.listening);
    await say(k, 'where-eat');
    await soon(async () => clips.length > 0);
    assert.equal(clips[0].kind, 'turn');
    assert.equal((await k.events(['heard'])).length, 0);
  } finally {
    await k.done();
  }
});

test('a turn the session closed on still reaches the plugin', async () => {
  const k = await liveKit([], { voice: VOICE });
  try {
    const { clips } = listen(k);
    k.agent.tap();
    await until(() => k.agent.live.listening);
    k.platform.mic.feed(cat(quiet(0.3), await clip('where-eat')), 16_000);
    await new Promise((r) => setTimeout(r, 100));
    k.agent.hush('away');
    await soon(async () => clips.length > 0);
    assert.equal(clips[0].kind, 'turn');
  } finally {
    await k.done();
  }
});

test('with no plugin listening, nothing is collected or made', async () => {
  const k = await liveKit([{ heard: 'Where should we eat?', said: 'Tacos.', audio: tone(0.2) }], { voice: VOICE });
  try {
    assert.equal(k.voice.tapped, false);
    let told = 0;
    const tell = k.voice.tell.bind(k.voice);
    k.voice.tell = (/** @type {any} */ h, /** @type {any} */ kind) => { told++; return tell(h, kind); };
    k.agent.tap();
    await until(() => k.agent.live.listening);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['heard'])).length > 0);
    assert.equal(told, 0);
  } finally {
    await k.done();
  }
});

test('a plugin that throws on a clip counts against it, and the voice goes on', async () => {
  const k = await liveKit([{ heard: 'Where should we eat?', said: 'Tacos.', audio: tone(0.2) }], { voice: VOICE });
  try {
    k.registry.add('remote-trace', 'heard-clips', { clip: () => { throw new Error('broken'); } });
    k.agent.tap();
    await until(() => k.agent.live.listening);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['out.speak'])).length > 0);
  } finally {
    await k.done();
  }
});

test('the level check\'s sample: the next 3 s of sound outside a turn, at most one a minute, only while a plugin listens', async () => {
  const k = await liveKit([], { voice: VOICE });
  try {
    let t = 1_000_000;
    k.voice.now = () => t;
    const rate = 16_000;
    const second = new Int16Array(rate).fill(500);
    // Nobody listening: nothing starts.
    k.voice.keptOut();
    k.voice.outside(second, rate);
    const { clips, off } = listen(k);
    for (let i = 0; i < 3; i++) k.voice.outside(second, rate);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(clips.length, 0);
    // Listening, and sound kept out.
    k.voice.keptOut();
    k.voice.keptOut();
    k.voice.outside(second, rate);
    k.voice.outside(second, rate);
    assert.equal(clips.length, 0);
    k.voice.outside(second, rate);
    await soon(async () => clips.length === 1);
    assert.equal(clips[0].kind, 'kept');
    assert.equal(clips[0].ms, 3000);
    assert.match(clips[0].id, /^[A-Za-z0-9_-]+$/);
    // Within the minute: none; past it: one more.
    t += 59_000;
    k.voice.keptOut();
    for (let i = 0; i < 3; i++) k.voice.outside(second, rate);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(clips.length, 1);
    t += 1000;
    k.voice.keptOut();
    for (let i = 0; i < 3; i++) k.voice.outside(second, rate);
    await soon(async () => clips.length === 2);
    // The switch going off mid-sample lets it go.
    t += 60_000;
    k.voice.keptOut();
    k.voice.outside(second, rate);
    off();
    k.voice.outside(second, rate);
    k.voice.outside(second, rate);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(clips.length, 2);
  } finally {
    await k.done();
  }
});

test('LiveInput tells sound outside a turn only: never what a turn sends', async () => {
  /** @type {any} */
  let frames = null;
  const sent = [];
  let outside = 0;
  let inTurn = 0;
  const input = new LiveInput({
    mic: { open: async (/** @type {any} */ o) => { frames = o.onFrames; return { close() {} }; } },
    send: { activity() {}, audio: (b) => sent.push(b) }, rate: 16_000,
  });
  input.onOutside = (pcm) => {
    outside += pcm.length;
    if (input.active) inTurn++;
  };
  await input.start();
  const frame = (/** @type {number} */ level) => new Float32Array(1600).map((_, i) => level * Math.sin(i / 4));
  for (let i = 0; i < 20; i++) frames(frame(0.0005), 16_000);
  assert.ok(outside > 0);
  for (let i = 0; i < 10; i++) frames(frame(0.3), 16_000);
  assert.ok(sent.length > 0, 'a turn was sent');
  assert.equal(inTurn, 0);
  input.stop();
});

test('joinPcm puts pieces together', () => {
  assert.deepEqual([...joinPcm([new Int16Array([1, 2]), new Int16Array([3])])], [1, 2, 3]);
});
