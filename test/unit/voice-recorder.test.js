import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record } from '../../src/core/voice/recorder.js';
import { decodeWav, wavSeconds, resample } from '../../src/core/voice/pcm.js';
import { clip, quiet, cat } from './voice-kit.js';
import { fakePlatform } from './voice-fakes.js';

const lunch = await clip('where-lunch');

test('the microphone opens for the window; what it hears is cut into 16 kHz WAV segments (spec §10.2)', async () => {
  const p = fakePlatform();
  /** @type {any[]} */
  const got = [];
  let speech = 0;
  /** @type {number[]} */
  const levels = [];
  const s = await record({ mic: p.mic, onSpeech: () => speech++, onLevel: (x) => levels.push(x), onSegment: (seg) => got.push(seg) });
  p.mic.feed(resample(cat(quiet(0.5), lunch, quiet(1)), 16_000, 48_000), 48_000);
  assert.equal(got.length, 1);
  assert.equal(speech, 1);
  assert.match(got[0].id, /^s-/);
  assert.equal(got[0].audio.mediaType, 'audio/wav');
  assert.equal(decodeWav(got[0].audio.data).sampleRate, 16_000);
  assert.ok(Math.abs(got[0].audio.seconds - wavSeconds(got[0].audio.data)) < 0.05);
  assert.ok(levels.some((x) => x > 0.2));
  s.close();
  assert.deepEqual(p.log, ['mic open', 'mic close']);
  assert.equal(levels.at(-1), 0);
});

test('closing keeps speech that was still going; nothing comes after', async () => {
  const p = fakePlatform();
  /** @type {any[]} */
  const got = [];
  const s = await record({ mic: p.mic, onSegment: (seg) => got.push(seg) });
  p.mic.feed(cat(quiet(0.5), lunch.subarray(0, 16_000)), 16_000);
  assert.equal(got.length, 0);
  s.close();
  assert.equal(got.length, 1);
  p.mic.feed(cat(lunch, quiet(1)), 16_000);
  s.close();
  assert.equal(got.length, 1);
});
