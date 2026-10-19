import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEC_ORDER, pickFormat, pickOut, mediaTypeOf, formatOf, rankOf } from '../../src/core/voice/formats.js';

test("Groq on a phone that makes Opus: ogg or webm by Groq's order; Gemini through Chat Completions: wav, or mp3 where the phone makes it", () => {
  assert.equal(pickFormat(['webm', 'ogg', 'mp4', 'mp3', 'flac', 'wav'], ['ogg', 'webm', 'wav']), 'webm');
  assert.equal(pickFormat(['ogg', 'webm', 'wav'], ['ogg', 'webm', 'wav']), 'ogg', "within a codec, the receiver's own order counts");
  assert.equal(pickFormat(['wav', 'mp3'], ['ogg', 'webm', 'wav']), 'wav');
  assert.equal(pickFormat(['wav', 'mp3'], ['ogg', 'webm', 'aac', 'mp3', 'flac', 'wav']), 'mp3');
});

test("annai's codec order decides between codecs, never the receiver's: Opus, then AAC, MP3, FLAC, WAV", () => {
  assert.deepEqual(CODEC_ORDER.map((g) => g[0]), ['ogg', 'mp4', 'mp3', 'flac', 'wav']);
  const all = ['ogg', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav'];
  assert.equal(pickFormat(['wav', 'flac', 'mp3', 'aac', 'webm'], all), 'webm');
  assert.equal(pickFormat(['wav', 'flac', 'mp3', 'aac'], all), 'aac');
  assert.equal(pickFormat(['wav', 'flac', 'mp3', 'mp4'], ['aac', 'mp3', 'wav']), 'mp3', 'ADTS AAC is not an MP4 file');
  assert.equal(pickFormat(['wav', 'flac'], all), 'flac');
});

test('nothing in common gives wav when the receiver takes it (annai always makes WAV), else null', () => {
  assert.equal(pickFormat(['ogg', 'wav'], ['mp3']), 'wav');
  assert.equal(pickFormat(['ogg', 'wav'], []), 'wav');
  assert.equal(pickFormat(['ogg', 'webm'], ['mp3', 'wav']), null);
  assert.equal(pickFormat([], ['ogg', 'wav']), null);
  assert.equal(pickFormat(['pcm16', 'm4a-ish'], ['ogg', 'wav']), null, 'names annai has no file kind for are passed over');
});

test("speech out: opus where the device plays Ogg Opus (OpenAI's name for it), else aac, else mp3", () => {
  const openai = ['opus', 'aac', 'mp3', 'flac', 'wav'];
  assert.equal(pickOut(openai, ['ogg', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav']), 'opus');
  assert.equal(pickOut(openai, ['webm', 'mp4', 'aac', 'mp3', 'wav']), 'aac', 'WebM Opus playing says nothing about Ogg');
  assert.equal(pickOut(openai, ['mp3', 'wav']), 'mp3');
  assert.equal(pickOut(['mp3'], ['ogg', 'mp3']), 'mp3', "OpenRouter's voices send MP3 only");
  assert.equal(pickOut(['opus'], ['mp3']), null, 'nothing the device plays');
});

test('file kinds and media types, both ways', () => {
  assert.deepEqual(['ogg', 'opus', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav'].map(mediaTypeOf),
    ['audio/ogg', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/flac', 'audio/wav']);
  assert.equal(formatOf('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(formatOf('audio/mpeg'), 'mp3');
  assert.equal(formatOf('audio/x-wav'), 'wav');
  assert.equal(formatOf('audio/L16'), null);
  assert.deepEqual(['webm', 'aac', 'mp3', 'flac', 'wav', 'pcm16'].map(rankOf), [0, 1, 2, 3, 4, Infinity]);
});
