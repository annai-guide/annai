import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listen } from '../../src/core/voice/listening.js';
import { Voice, WRITE_DOWN } from '../../src/core/voice/voice.js';
import { voiceSettings } from '../../src/core/voice/settings.js';
import { micProblem } from '../../src/core/voice/mic.js';
import { Registry } from '../../src/core/registry.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { fakePlatform, fakeLlm } from './voice-fakes.js';
import { clip, quiet, cat } from './voice-kit.js';

const lunch = cat(quiet(0.5), await clip('where-lunch'), quiet(1));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('a recording session: the microphone is open until it stops; what it hears comes as audio segments (spec §10.2)', async () => {
  const p = fakePlatform();
  /** @type {any[]} */
  const got = [];
  const s = await listen({ platform: /** @type {any} */ (p), kind: 'record', pauseMs: 700, onSegment: (h) => got.push(h), onError: (e) => assert.fail(e) });
  p.mic.feed(lunch, 16_000);
  s.stop();
  assert.equal(got.length, 1);
  assert.equal(got[0].source, 'mic');
  assert.equal(got[0].audio.mediaType, 'audio/wav');
  assert.equal(s.kind, 'record');
  assert.deepEqual(p.log, ['mic open', 'mic close']);
});

test('a dictation session gives words; when dictation fails, recording takes over from the next segment (spec §10.3)', async () => {
  const p = fakePlatform({ dictation: true });
  /** @type {any[]} */
  const got = [];
  /** @type {string[]} */
  const switched = [];
  const s = await listen({ platform: /** @type {any} */ (p), kind: 'dictation', pauseMs: 700, onSegment: (h) => got.push(h), onError: (e) => assert.fail(e), onSwitch: (e) => switched.push(e.message) });
  p.dictation.say('is there a gas station nearby');
  assert.deepEqual(got.map((h) => [h.source, h.text]), [['dictation', 'is there a gas station nearby']]);
  p.dictation.fail('network');
  await tick();
  assert.equal(s.kind, 'record');
  assert.deepEqual(switched, ['Phone dictation stopped (network).']);
  p.mic.feed(lunch, 16_000);
  assert.equal(got.at(-1).source, 'mic');
  s.stop();
  assert.deepEqual(p.log, ['dictation open', 'dictation close', 'mic open', 'mic close']);
});

/** A Voice over fakes. @param {Parameters<typeof fakeLlm>[0]} [o] @param {{ dictation?: boolean }} [p] */
async function voiceKit(o, { dictation = false } = {}) {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const platform = fakePlatform({ dictation });
  registry.add('voice-browser', 'voice-platform', platform);
  const llm = fakeLlm(o);
  const voice = new Voice({ llm, ws, registry, store, locale: 'en', where: 'ios' });
  return { voice, platform, llm, ws };
}

/** Opens a recording session, says the lunch question, and gives what was heard. @param {Awaited<ReturnType<typeof voiceKit>>} k */
async function hearLunch(k) {
  /** @type {any[]} */
  const got = [];
  const s = await k.voice.open({ kind: 'record', onSegment: (h) => got.push(h), onError: (e) => assert.fail(e) });
  k.platform.mic.feed(lunch, 16_000);
  s.stop();
  return got[0];
}

test('how to listen is judged against the main model expected to hear it (spec §10.3)', async () => {
  assert.equal((await (await voiceKit({ main: [{ id: 'm1', input: ['text', 'audio'] }] })).voice.howToListen()).kind, 'record');
  assert.equal((await (await voiceKit({ main: [{ id: 'm1', input: ['text'] }] })).voice.howToListen()).kind, 'record', 'through t1');
  const k = await voiceKit({ main: [{ id: 'm1', input: ['text'] }], speechIn: ['send-audio', 'dictation'] }, { dictation: true });
  assert.equal((await k.voice.howToListen()).kind, 'dictation');
  k.voice.dictationFailed = true;
  assert.match(/** @type {any} */ (await k.voice.howToListen()).why, /m1 doesn't take audio/);
  const resting = await voiceKit({ main: [{ id: 'm1', input: ['text'] }, { id: 'm2', input: ['text', 'audio'] }], speechIn: ['send-audio'] });
  resting.llm.bench.bench('m1', 60_000);
  assert.equal((await resting.voice.howToListen()).kind, 'record', 'the first main model that is not resting is the one expected to hear');
});

test('open() keeps what it hears in memory, plays and records; the resolver transcribes for a text-only model and benches one that fails', async () => {
  const k = await voiceKit({ asr: ['t1', 't2'], speechIn: ['send-audio', 't1', 't2'], failing: ['t1'], hears: ['where should we stop for lunch'] });
  const h = await hearLunch(k);
  assert.equal(k.voice.memory.get(h.id)?.id, h.id);
  assert.deepEqual(k.platform.sessions, ['play-and-record']);
  const r = await k.voice.resolver('trip-1', 'w-1')({ name: 'm1', input: ['text'] }, { messages: [{ role: 'user', parts: [{ type: 'speech', id: h.id }] }] });
  assert.deepEqual(r.messages[0].parts, [{ type: 'text', text: 'where should we stop for lunch' }]);
  assert.deepEqual(k.llm.calls, ['hear t1 audio/wav trip-1 w-1', 'hear t2 audio/wav trip-1 w-1']);
  assert.ok(k.llm.bench.until('t1') > Date.now());
});

test('writeDown(): the words, and who wrote them down; sent audio is written down by the model that heard it (spec §10.3)', async () => {
  const sent = await voiceKit({ main: [{ id: 'm1', input: ['text', 'audio'] }], speechIn: ['send-audio', 'dictation'], reply: 'tacos please' });
  const h = await hearLunch(sent);
  assert.deepEqual(await sent.voice.writeDown(h.id, { scope: 'trip-1', wake: 'w-1', hearer: 'm1' }), { text: 'tacos please', by: 'm1' });
  assert.deepEqual(sent.llm.calls, ['call main m1 transcribe audio']);
  assert.match(WRITE_DOWN, /exactly what is said/);
  const asr = await voiceKit();
  const h2 = await hearLunch(asr);
  assert.deepEqual(await asr.voice.writeDown(h2.id, { scope: 'trip-1' }), { text: 'what was said', by: 't1' });
  const none = await voiceKit({ speechIn: ['dictation'] });
  const h3 = await hearLunch(none);
  assert.equal(await none.voice.writeDown(h3.id, { scope: 'trip-1' }), null);
  assert.equal(await none.voice.writeDown('s-unknown', { scope: 'trip-1' }), null);
});

test('Settings → Voice: mode, silence, first words and clips, with defaults; refresh() turns voice on for On', async () => {
  assert.deepEqual(voiceSettings({}), { mode: 'auto', pauseMs: 700, silenceSeconds: 8, firstWordsSeconds: 15, keepClips: false, browserVoice: '', rate: 1 });
  assert.deepEqual(voiceSettings({ voice: { mode: 'loud', silenceSeconds: 1, firstWordsSeconds: 500, keepClips: 'yes' } }), voiceSettings({}));
  const k = await voiceKit();
  assert.equal(await k.voice.refresh(), false, 'Auto is off until milestone 3c can tell the situation');
  await updateAppSettings(k.ws, { voice: { mode: 'on', silenceSeconds: 5, keepClips: true } });
  assert.equal(await k.voice.refresh(), true);
  assert.equal(k.voice.on, true);
  assert.equal((await k.voice.settings()).silenceSeconds, 5);
  assert.match(k.voice.problem(Object.assign(new Error('x'), { name: 'NotAllowedError' })).body, /Settings → Apps → Safari → Microphone/);
  assert.equal(micProblem(Object.assign(new Error('x'), { name: 'NotFoundError' }), 'android').title, 'No microphone found');
});
