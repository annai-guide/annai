// Detailed trace's samples of sound the level check kept out: the live session tells the voice when a frame was kept out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './agent-kit.js';
import { liveKit, soon, tone } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';
import { updateAppSettings } from '../../src/core/settings.js';

const RATE = 16_000;
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const room = (/** @type {number} */ seconds) => quiet(seconds, 0.006);
const VOICE = { encoder: { makes: ['ogg'] }, plays: ['ogg', 'mp3', 'wav'] };

/** A session with the mic open and the user's level known, as live-drive2.test.js does it. @param {any} k */
async function learned(k) {
  await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
  k.agent.tap();
  await until(() => k.agent.live.listening, 3000);
  k.platform.mic.feed(room(1.5), RATE);
  k.platform.mic.feed(cat(hum(0.6, 0.5), room(1)), RATE);
  await soon(async () => (await k.events(['live.turn'])).length === 1, 3000);
  await k.agent.live.idle();
  await wait(1050);
  k.agent.live.level.reset();
  k.agent.live.level.heard(-5);
  k.agent.live.level.heard(-5);
}

test('sound the level check keeps out reaches the voice (keptOut), and with a plugin listening, the next 3 s outside a turn go as a "kept" clip', async () => {
  const k = await liveKit([{ heard: 'hello' }, { heard: 'where to', said: 'Tacos ahead.', audio: tone(0.1) }], { voice: VOICE });
  try {
    /** @type {any[]} */
    const clips = [];
    k.registry.add('remote-trace', 'heard-clips', { clip: (/** @type {any} */ c) => clips.push(c) });
    await learned(k);
    let kept = 0;
    const keptOut = k.voice.keptOut.bind(k.voice);
    k.voice.keptOut = () => { kept++; keptOut(); };
    k.platform.mic.feed(hum(0.5, 0.05), RATE); // quieter than the minimum
    assert.ok(kept > 0, 'told when frames were kept out');
    k.platform.mic.feed(room(4), RATE);
    await soon(async () => clips.some((c) => c.kind === 'kept'), 3000);
    const ms = clips.find((c) => c.kind === 'kept').ms;
    assert.ok(ms >= 3000 && ms < 3300, `${ms} ms`);
  } finally {
    await k.done();
  }
});
