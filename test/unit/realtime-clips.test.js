import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { decodeWav } from '../../src/core/voice/pcm.js';
import { Keys } from '../../scripts/realtime/keys.mjs';
import { CLIPS, SEND_RATE, trimSilence, fromTts, joinParts, askTts, loadClips, DIR } from '../../scripts/realtime/clips.mjs';

/** A tone of seconds at the rate, loudness amp. @param {number} s @param {number} [amp] @param {number} [rate] */
const tone = (s, amp = 0.3, rate = SEND_RATE) => Float32Array.from({ length: Math.round(s * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * 300 * i) / rate));
const quiet = (/** @type {number} */ s) => new Float32Array(Math.round(s * SEND_RATE));
const seconds = (/** @type {Float32Array} */ p) => p.length / SEND_RATE;
const cat = (/** @type {Float32Array[]} */ ...ps) => Float32Array.from(ps.flatMap((p) => [...p]));

test('trimSilence takes quiet off both ends, keeping a short margin of it', () => {
  const out = trimSilence(cat(quiet(1), tone(0.5), quiet(1)));
  assert.ok(seconds(out) > 0.5 && seconds(out) < 0.5 + 0.4, `${seconds(out)} s`);
  assert.deepEqual(trimSilence(quiet(1)).length, 0);
});

test('trimSilence leaves a pause inside the speech alone', () => {
  const out = trimSilence(cat(quiet(0.5), tone(0.4), quiet(1.5), tone(0.4), quiet(0.5)));
  assert.ok(seconds(out) > 2.3 && seconds(out) < 2.8, `${seconds(out)} s`);
});

test('fromTts turns Gemini\'s 24 kHz 16-bit bytes into 16 kHz samples of the same length in time', () => {
  const bytes = new Uint8Array(Int16Array.from({ length: 24_000 }, (_, i) => Math.round(8000 * Math.sin(i / 5))).buffer);
  const out = fromTts(bytes);
  assert.equal(out.length, SEND_RATE);
  assert.ok(Math.max(...out) > 0.2);
});

test('joinParts puts the silence of a number between the speech of the strings', () => {
  const out = joinParts([tone(0.5), 1.5, tone(0.5)]);
  assert.equal(Math.round(seconds(out) * 10) / 10, 2.5);
});

test('askTts sends the words and the voice, reads the audio from the answer, and moves to the next key on a 429', async () => {
  const keys = Keys.fromFile('AIza-aaaaaaaaaaaaaaaa\nAIza-bbbbbbbbbbbbbbbb\n', '1-2');
  /** @type {{ key: string | null, body: any }[]} */
  const calls = [];
  const audio = Buffer.from(new Int16Array(2400).buffer).toString('base64');
  /** @type {typeof fetch} */
  const fetcher = async (url, init) => {
    const h = /** @type {Record<string, string>} */ (init?.headers);
    calls.push({ key: h['x-goog-api-key'], body: JSON.parse(String(init?.body)) });
    return calls.length === 1
      ? new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }), { status: 429 })
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: audio } }] } }] }), { status: 200 });
  };
  const bytes = await askTts({ text: 'Hello there.', voice: 'Kore', model: 'm-tts', keys, fetcher, pauseMs: 0 });
  assert.equal(bytes.length, 4800);
  assert.deepEqual(calls.map((c) => c.key), ['AIza-aaaaaaaaaaaaaaaa', 'AIza-bbbbbbbbbbbbbbbb']);
  assert.equal(calls[1].body.contents[0].parts[0].text, 'Hello there.');
  assert.equal(calls[1].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.deepEqual(calls[1].body.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(keys.line, 2);
});

test('askTts gives up with the keys used up, and its error never holds a key', async () => {
  const keys = Keys.fromFile('AIza-aaaaaaaaaaaaaaaa\n', '1');
  /** @type {typeof fetch} */
  const fetcher = async () => new Response(JSON.stringify({ error: { code: 429, message: 'quota for AIza-aaaaaaaaaaaaaaaa' } }), { status: 429 });
  await assert.rejects(askTts({ text: 'x', voice: 'Kore', model: 'm', keys, fetcher, pauseMs: 0 }), (/** @type {any} */ e) => /429|quota/i.test(e.message) && !e.message.includes('AIza'));
});

test('the clip set: 5 to 8 travel questions, a quick yes, a sentence with a thinking pause, a long question, and silence; for the languages check, more short English replies and a sentence in Japanese and one in Chinese (phase 2)', () => {
  const kinds = Object.values(CLIPS).map((c) => c.kind);
  const count = (/** @type {string} */ k) => kinds.filter((x) => x === k).length;
  assert.ok(count('question') >= 5 && count('question') <= 8);
  for (const k of ['yes', 'pause', 'long', 'silence']) assert.equal(count(k), 1, k);
  const pause = Object.values(CLIPS).find((c) => c.kind === 'pause');
  assert.ok(pause?.parts?.some((p) => typeof p === 'number' && p >= 1 && p <= 2), 'a 1 to 2 s pause inside it');
  // The short replies the user's trace of 2026-10-22 had misheard as other languages, and a sentence in each of his other languages.
  assert.deepEqual(['yes', 'sure', 'what', 'alright', 'no'].map((n) => CLIPS[n].text), ['Yes.', 'Sure.', 'What?', 'Alright.', 'No.']);
  assert.equal(count('reply'), 4);
  assert.deepEqual([CLIPS.ja.kind, CLIPS.ja.lang, CLIPS.zh.kind, CLIPS.zh.lang], ['sentence', 'ja', 'sentence', 'zh']);
  assert.match(CLIPS.ja.text ?? '', /[\u3040-\u30ff]/, 'kana');
  assert.match(CLIPS.zh.text ?? '', /[\u4e00-\u9fff]/);
  assert.doesNotMatch(CLIPS.zh.text ?? '', /[\u3040-\u30ff]/);
  for (const [n, c] of Object.entries(CLIPS)) if (c.kind !== 'silence' && !['ja', 'zh'].includes(n)) assert.ok((c.lang ?? 'en') === 'en', `${n} is English`);
});

test('the cached clips are 16 kHz mono 16-bit WAV files, small, one for every clip that has speech, none with a key in it', async () => {
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.wav')).sort();
  const spoken = Object.entries(CLIPS).filter(([, c]) => c.kind !== 'silence').map(([n]) => `${n}.wav`).sort();
  assert.deepEqual(files, spoken);
  let total = 0;
  for (const f of files) {
    const bytes = new Uint8Array(await readFile(new URL(f, DIR)));
    total += bytes.length;
    const w = decodeWav(bytes);
    assert.equal(w.sampleRate, 16_000, f);
    assert.ok(w.pcm.length / 16_000 > 0.3 && w.pcm.length / 16_000 < 20, `${f}: ${w.pcm.length / 16_000} s`);
    assert.ok(w.pcm.reduce((m, x) => Math.max(m, Math.abs(x)), 0) > 0.05, `${f} is not silent`);
    assert.ok(!/AIza/.test(Buffer.from(bytes).toString('latin1')), `${f} holds a key`);
  }
  assert.ok(total < 1_600_000, `${total} bytes in all`);
  const loaded = await loadClips();
  assert.deepEqual(Object.keys(loaded).sort(), Object.keys(CLIPS).sort());
  assert.ok(loaded.lunch.pcm instanceof Float32Array && loaded.lunch.seconds > 0.5);
  assert.deepEqual([loaded.lunch.lang, loaded.ja.lang, loaded.zh.lang, loaded.silence.lang], ['en', 'ja', 'zh', 'en']);
});
