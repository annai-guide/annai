import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Voice, WRITE_DOWN } from '../../src/core/voice/voice.js';
import { Registry } from '../../src/core/registry.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { fakePlatform, fakeLlm } from './voice-fakes.js';
import { clip, quiet, cat } from './voice-kit.js';

// Languages you speak (phase 2): what the voice side tells the models and the browser.

const lunch = cat(quiet(0.5), await clip('where-lunch'), quiet(1));

/** A Voice over fakes. @param {Parameters<typeof fakeLlm>[0]} [o] @param {string} [locale] */
async function kit(o, locale = 'en-US') {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const platform = fakePlatform({ dictation: true });
  registry.add('voice-browser', 'voice-platform', platform);
  const llm = fakeLlm(o);
  const voice = new Voice({ llm, ws, registry, store, locale, where: 'ios' });
  voice.retryMs = [0, 0];
  return { voice, platform, llm, ws };
}

/** Records one segment of the lunch question. @param {Awaited<ReturnType<typeof kit>>} k */
async function hear(k) {
  /** @type {any[]} */
  const got = [];
  const s = await k.voice.open({ kind: 'record', onSegment: (h) => got.push(h), onError: (e) => assert.fail(e) });
  k.platform.mic.feed(lunch, 16_000);
  s.stop();
  return got[0];
}

test('a transcription model is given what the user speaks, once they have chosen', async () => {
  const k = await kit();
  const seg = await hear(k);
  await k.voice.transcribe(seg, 't1');
  assert.deepEqual(k.llm.uploads[0].languages, { spoken: [], answer: null }, "nothing chosen: the browser's language is no hint (it could force a Whisper-style model to English)");
  await updateAppSettings(k.ws, { languages: { spoken: ['ja', 'en', 'zh'] } });
  await k.voice.transcribe(await hear(k), 't1');
  assert.deepEqual(k.llm.uploads[1].languages.spoken.map((/** @type {any} */ l) => [l.id, l.iso]), [['ja', 'ja'], ['en', 'en'], ['zh', 'zh']]);
  assert.equal(k.llm.uploads[1].languages.answer, null);
});

test('phone dictation listens in the first language listed (it takes one tag), whatever Shiori answers in; with none chosen, in the browser\'s own', async () => {
  const k = await kit(undefined, 'en-GB');
  const open = async () => {
    const s = await k.voice.open({ kind: 'dictation', onSegment: () => {}, onError: (e) => assert.fail(e) });
    s.stop();
    return k.platform.dictationOpened.at(-1).lang;
  };
  assert.equal(await open(), 'en-GB');
  await updateAppSettings(k.ws, { languages: { spoken: ['ja', 'en'] } });
  assert.equal(await open(), 'ja-JP');
  await updateAppSettings(k.ws, { languages: { spoken: ['zh', 'ja'] } });
  assert.equal(await open(), 'zh-CN');
  // A fixed answer language is for her voice, not for your ears (review item 1).
  await updateAppSettings(k.ws, { languages: { spoken: ['en', 'zh', 'ja'], answer: 'ja' } });
  assert.equal(await open(), 'en-US');
  assert.equal(k.platform.dictationOpened.length, 4);
});

test('"on this phone only" is asked about the language dictation will listen in, not the browser\'s (Step S5)', async () => {
  const k = await kit(undefined, 'en-GB');
  await k.voice.dictationLocal();
  assert.equal(k.platform.dictationAsked.at(-1), 'en-GB');
  await updateAppSettings(k.ws, { languages: { spoken: ['ja', 'en'] } });
  await k.voice.dictationLocal();
  assert.equal(k.platform.dictationAsked.at(-1), 'ja-JP');
  const s = await k.voice.open({ kind: 'dictation', onSegment: () => {}, onError: (e) => assert.fail(e) });
  s.stop();
  assert.equal(k.platform.dictationAsked.at(-1), 'ja-JP', 'and opening a session asks about the same one');
  assert.equal(k.platform.dictationOpened.at(-1).lang, 'ja-JP');
});

test('the browser voice says each sentence in the language it is written in, among those listed; a fixed answer language wins', async () => {
  const k = await kit({ speechOut: ['browser-voice'] });
  await updateAppSettings(k.ws, { languages: { spoken: ['en', 'zh', 'ja'] } });
  await k.voice.say('Dinner is at six.');
  await k.voice.say('夕食は六時です。');
  await k.voice.say('晚饭六点。');
  assert.deepEqual(k.platform.said.map((s) => [s.text, s.lang]), [['Dinner is at six.', 'en-US'], ['夕食は六時です。', 'ja-JP'], ['晚饭六点。', 'zh-CN']]);
  await updateAppSettings(k.ws, { languages: { answer: 'ja' } });
  await k.voice.say('Dinner is at six.');
  assert.equal(k.platform.said.at(-1).lang, 'ja-JP');
});

test('the model that writes down what it heard is told the languages, and not to translate, once the user has chosen them; before that it gets no hint (review item 13)', async () => {
  const k = await kit({ main: [{ id: 'm1', input: ['text', 'audio'] }], speechIn: ['send-audio', 'dictation'], reply: 'tacos please' });
  const h0 = await hear(k);
  await k.voice.writeDown(h0.id, { scope: 'trip-1', wake: 'w-1', hearer: 'm1' });
  assert.equal(k.llm.systems.at(-1), WRITE_DOWN, 'nothing chosen: the browser\'s language is no evidence of what is spoken');
  await updateAppSettings(k.ws, { languages: { spoken: ['en', 'ja'] } });
  const h = await hear(k);
  await k.voice.writeDown(h.id, { scope: 'trip-1', wake: 'w-1', hearer: 'm1' });
  assert.equal(k.llm.systems.at(-1), `${WRITE_DOWN} The speaker uses English or Japanese: write each in the language spoken and never translate.`);
  await updateAppSettings(k.ws, { languages: { spoken: ['en'] } });
  const h2 = await hear(k);
  await k.voice.writeDown(h2.id, { scope: 'trip-1', wake: 'w-1', hearer: 'm1' });
  assert.equal(k.llm.systems.at(-1), `${WRITE_DOWN} The speaker uses English: write it in the language spoken and never translate.`);
});
