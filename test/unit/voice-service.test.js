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
import { clip, quiet, cat } from './voice-kit.js';

const enc = new TextEncoder();

/** A Voice over a fake llm: one API voice (v1), one transcription model (t1), and the stand-ins. @param {{ failing?: boolean, retryAfter?: number }} [o] */
async function voiceKit({ failing = false, retryAfter } = {}) {
  const registry = new Registry();
  const ws = new Workspace(createMemoryStore(), { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const platform = fakePlatform();
  registry.add('voice-browser', 'voice-platform', platform);
  const bench = new Bench();
  /** @type {string[]} */
  const calls = [];
  const llm = {
    bench,
    types: () => new Map([['say', { speech: 'out' }], ['hear', { speech: 'in' }]]),
    config: async () => ({
      endpoints: { eo: { id: 'eo', type: 'say' }, ei: { id: 'ei', type: 'hear' } },
      models: { v1: { id: 'v1', endpoint: 'eo', template: null, user: { providerId: 'tts' } }, t1: { id: 't1', endpoint: 'ei', template: null, user: { providerId: 'asr' } } },
      roles: { 'speech-out': { models: ['v1', 'browser-voice'], level: 'off' }, 'speech-in': { models: ['send-audio', 't1', 'dictation'], level: 'off' } },
    }),
    /** @param {{ modelId: string, text: string }} c */
    async synthesize({ modelId, text }) {
      calls.push(`say ${modelId} ${text}`);
      if (failing) throw new ProviderError('rate', 'Slow down.', { retryAfter });
      return { clip: { data: enc.encode(`${modelId}:${text}`), mediaType: 'audio/mpeg' } };
    },
    /** @param {{ modelId: string, audio: any }} c */
    async transcribe({ modelId, audio }) {
      calls.push(`hear ${modelId} ${audio.mediaType}`);
      return { text: 'where should we stop for lunch' };
    },
  };
  const voice = new Voice({ llm, ws, registry, locale: 'en' });
  return { voice, platform, llm, calls, ws, bench };
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
  assert.deepEqual(voiceSettings({}), { pauseMs: 700, browserVoice: '', rate: 1 });
  assert.deepEqual(voiceSettings({ voice: { pauseMs: 50, browserVoice: 'Samantha', rate: 1.2 } }), { pauseMs: 700, browserVoice: 'Samantha', rate: 1.2 });
  const k = await voiceKit();
  await updateAppSettings(k.ws, { voice: { browserVoice: 'v-en', rate: 0.9 } });
  await k.voice.say('Hi.');
  assert.ok(k.platform.log.includes('play v1:Hi.'));
});
