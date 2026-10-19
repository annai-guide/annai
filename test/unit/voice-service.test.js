import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Voice, restFor } from '../../src/core/voice/voice.js';
import { voiceSettings } from '../../src/core/voice/settings.js';
import { Registry } from '../../src/core/registry.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { Bench, COOLDOWN_MS } from '../../src/core/llm/fallback.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { fakePlatform } from './voice-fakes.js';
import { pickOut } from '../../src/core/voice/formats.js';
import { clip, quiet, cat } from './voice-kit.js';

const enc = new TextEncoder();

/**
 * A Voice over a fake llm: one API voice (v1), one transcription model (t1), and the stand-ins.
 * @param {{ failing?: boolean, retryAfter?: number, micFails?: string, format?: string, refuses?: string[], plays?: string[] }} [o]
 *   format: v1's format tunable (it offers OpenAI's list); refuses: the formats v1 answers 400 to, as Speaches does opus and aac; plays: what the phone plays
 */
async function voiceKit({ failing = false, retryAfter, micFails, format = 'mp3', refuses = [], plays } = {}) {
  const registry = new Registry();
  const ws = new Workspace(createMemoryStore(), { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const platform = fakePlatform({ micFails, plays });
  registry.add('voice-browser', 'voice-platform', platform);
  const bench = new Bench();
  /** @type {string[]} */
  const calls = [];
  /** The format v1 was asked for, each time, as speechCall resolves 'auto'. @type {string[]} */
  const asked = [];
  const offers = ['opus', 'aac', 'mp3', 'flac', 'wav'];
  const llm = {
    bench,
    types: () => new Map([['say', { speech: 'out' }], ['hear', { speech: 'in' }]]),
    config: async () => ({
      providers: {
        po: { id: 'po', plugin: 'p', template: null, user: { abilities: { voice: { kind: 'voice', type: 'say', tunables: { format, audioOut: offers } } } } },
        pi: { id: 'pi', plugin: 'p', template: null, user: { abilities: { transcription: { kind: 'transcription', type: 'hear' } } } },
      },
      models: { v1: { id: 'v1', provider: 'po', ability: 'voice', template: null, user: { providerId: 'tts' } }, t1: { id: 't1', provider: 'pi', ability: 'transcription', template: null, user: { providerId: 'asr' } } },
      roles: { 'speech-out': { models: ['v1', 'browser-voice'], level: 'off' }, 'speech-in': { models: ['send-audio', 't1', 'dictation'], level: 'off' } },
    }),
    /** @param {{ modelId: string, text: string, plays?: string[] }} c */
    async synthesize({ modelId, text, plays: p }) {
      calls.push(`say ${modelId} ${text}`);
      if (failing) throw new ProviderError('rate', 'Slow down.', { retryAfter });
      const f = format === 'auto' ? pickOut(offers, p ?? ['mp3', 'wav']) ?? 'mp3' : format;
      asked.push(f);
      if (refuses.includes(f)) throw new ProviderError('bad-request', 'Invalid request');
      return { clip: { data: enc.encode(`${modelId}:${text}`), mediaType: 'audio/mpeg' } };
    },
    /** @param {{ modelId: string, audio: any }} c */
    async transcribe({ modelId, audio }) {
      calls.push(`hear ${modelId} ${audio.mediaType}`);
      return { text: 'where should we stop for lunch' };
    },
  };
  const voice = new Voice({ llm, ws, registry, locale: 'en' });
  return { voice, platform, llm, calls, ws, bench, asked };
}

test('say(): through the speech-out list, the browser voice taking over from a voice that is resting', async () => {
  const k = await voiceKit();
  const spoken = await k.voice.say('Hello. This is how I sound.');
  assert.equal(spoken.said, 2);
  assert.deepEqual(k.platform.log.filter((l) => l.startsWith('play')), ['play v1:Hello.', 'play v1:This is how I sound.']);
  const f = await voiceKit({ failing: true, retryAfter: 42_000 });
  await f.voice.say('Hello.');
  assert.deepEqual(f.platform.log.filter((l) => l.startsWith('browser')), ['browser Hello.']);
  assert.ok(f.bench.until('v1') > Date.now() + 40_000, 'it rests as long as the provider asked');
});

test("a voice that refuses the format it offers is asked for MP3, then WAV, and gets that until annai restarts (Speaches refuses opus and aac)", async () => {
  const k = await voiceKit({ format: 'auto', refuses: ['opus', 'aac'], plays: ['ogg', 'aac', 'mp3', 'wav'] });
  await k.voice.say('Hello.');
  assert.deepEqual(k.asked, ['opus', 'mp3']);
  assert.deepEqual(k.platform.log.filter((l) => l.startsWith('play')), ['play v1:Hello.']);
  await k.voice.say('Again.');
  assert.deepEqual(k.asked, ['opus', 'mp3', 'mp3'], 'MP3 straight away');
  assert.equal(k.bench.until('v1'), 0, 'it spoke: not benched');
  const w = await voiceKit({ format: 'auto', refuses: ['opus', 'mp3'], plays: ['ogg', 'mp3', 'wav'] });
  await w.voice.sample('v1', 'Hi.');
  assert.deepEqual(w.asked, ['opus', 'mp3', 'wav']);
  const none = await voiceKit({ format: 'auto', refuses: ['opus', 'mp3', 'wav'], plays: ['ogg', 'mp3', 'wav'] });
  await none.voice.say('Hello.');
  assert.deepEqual(none.asked, ['opus', 'mp3', 'wav']);
  assert.deepEqual(none.platform.log.filter((l) => l.startsWith('browser')), ['browser Hello.'], 'then the next voice, as before');
  const chosen = await voiceKit({ format: 'opus', refuses: ['opus'], plays: ['ogg', 'mp3', 'wav'] });
  await chosen.voice.say('Hello.');
  assert.deepEqual(chosen.asked, ['opus'], 'a format the user chose is left alone');
});

test('a resting voice rests as long as the provider asked, else the usual cooldown (spec §9.6)', () => {
  assert.equal(restFor(new ProviderError('rate', 'x', { retryAfter: 5000 })), 5000);
  assert.equal(restFor(new Error('x')), COOLDOWN_MS);
});

test('listenOnce(): the mic opens, one segment comes back, the mic closes and the session goes back to playback', async () => {
  const k = await voiceKit();
  /** @type {string[]} */
  const who = [];
  const off = k.voice.onLevel((x, w) => { if (x > 0) who.push(w); });
  const heard = k.voice.listenOnce({ seconds: 5 });
  await new Promise((r) => setTimeout(r, 5));
  k.platform.mic.feed(cat(quiet(0.5), await clip('where-lunch'), quiet(1)), 16_000);
  const seg = await heard;
  off();
  assert.ok(seg && seg.ms > 1000);
  assert.deepEqual(k.platform.log, ['mic open', 'mic close']);
  assert.deepEqual(k.platform.sessions, ['play-and-record', 'playback']);
  assert.ok(who.includes('you'));
  assert.equal(await k.voice.transcribe(/** @type {any} */ (seg), 't1'), 'where should we stop for lunch');
  assert.deepEqual(k.calls, ['hear t1 audio/wav']);
  assert.deepEqual(await k.voice.transcribers(), ['t1']);
});

test('listenOnce(): nothing heard in time gives null, and the mic closes', async () => {
  const k = await voiceKit();
  assert.equal(await k.voice.listenOnce({ seconds: 0.02 }), null);
  assert.deepEqual(k.platform.log, ['mic open', 'mic close']);
});

test('Settings → Voice: defaults, and values outside their range fall back', async () => {
  assert.deepEqual(voiceSettings({}), { mode: 'auto', pauseMs: 700, silenceSeconds: 8, firstWordsSeconds: 15, keepClips: false, browserVoice: '', rate: 1, lastChoices: {}, closeAfterSeconds: 30, bargeIn: true });
  assert.deepEqual(voiceSettings({ voice: { pauseMs: 50, browserVoice: 'Samantha', rate: 1.2 } }), { ...voiceSettings({}), browserVoice: 'Samantha', rate: 1.2 });
  // A live session's quiet spell is 10 to 300 seconds; cutting her off by speaking is on unless turned off (K5).
  assert.deepEqual(voiceSettings({ voice: { closeAfterSeconds: 5, bargeIn: false } }), { ...voiceSettings({}), bargeIn: false });
  assert.equal(voiceSettings({ voice: { closeAfterSeconds: 120 } }).closeAfterSeconds, 120);
  const k = await voiceKit();
  await updateAppSettings(k.ws, { voice: { browserVoice: 'v-en', rate: 0.9 } });
  await k.voice.say('Hi.');
  assert.ok(k.platform.log.includes('play v1:Hi.'));
});

test('a microphone that fails to open sets the audio session back to playback, and the error goes on (spec §10.1)', async () => {
  const k = await voiceKit({ micFails: 'NotAllowedError' });
  await assert.rejects(k.voice.open({ kind: 'record', onSegment: () => {}, onError: () => {} }), /Permission denied/);
  assert.deepEqual(k.platform.sessions, ['play-and-record', 'playback'], "the car's music leaves the call-quality route");
});
