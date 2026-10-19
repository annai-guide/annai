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

test('recording alongside (MediaRecorder, decision 24): each segment brings the file cut with it; while nobody speaks the file starts again every 2 s, never during speech', async () => {
  const p = fakePlatform();
  let t = 0;
  /** @type {any[]} */
  const got = [];
  const s = await record({ mic: p.mic, now: () => t, recording: { type: 'audio/mp4', format: 'mp4' }, onSegment: (seg) => got.push(seg) });
  /** Feeds sound at 16 kHz, the clock moving with it. @param {Float32Array} pcm */
  const feed = (pcm) => {
    for (let i = 0; i < pcm.length; i += 2048) {
      t += (Math.min(2048, pcm.length - i) / 16_000) * 1000;
      p.mic.feed(pcm.subarray(i, i + 2048), 16_000);
    }
  };
  feed(quiet(5));
  assert.deepEqual(p.log, ['mic open, recording audio/mp4', 'mic again', 'mic again'], 'at about 2 s and 4 s');
  p.log.length = 1;
  feed(cat(lunch, quiet(1)));
  assert.deepEqual(p.log.slice(1), ['mic take'], 'cut with the segment, and not started again while she spoke');
  assert.equal(got.length, 1);
  assert.deepEqual([...got[0].encoded.keys()], ['mp4']);
  assert.equal(new TextDecoder().decode(await got[0].encoded.get('mp4')), 'audio/mp4 file 1');
  assert.equal(got[0].audio.mediaType, 'audio/wav', 'the samples are kept for other formats');
  feed(quiet(0.8));
  assert.deepEqual(p.log.slice(1), ['mic take'], 'the new file is younger than 2 s');
  s.close();
  const plain = await record({ mic: fakePlatform().mic, onSegment: () => {} });
  plain.close();
});
