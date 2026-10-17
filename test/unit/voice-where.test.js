import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whereHeard, whereSaid, browserVoiceFor, DICTATION_AWAY, DICTATION_HERE } from '../../src/core/voice/where.js';
import { saveRoles, readConfig } from '../../src/core/llm/config.js';
import { agentKit, until } from './agent-kit.js';

/** A config with an audio main model on OpenRouter, a transcription model on Groq, a voice on OpenAI, and the stand-ins. @param {{ audio?: boolean, speechIn?: string[], speechOut?: string[] }} [o] */
function config({ audio = true, speechIn = ['send-audio', 'asr', 'dictation'], speechOut = ['tts', 'browser-voice'] } = {}) {
  return /** @type {any} */ ({
    endpoints: {
      or: { id: 'or', type: 'chat-completions', template: null, user: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' } },
      gq: { id: 'gq', type: 'openai-transcription', template: null, user: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' } },
      oa: { id: 'oa', type: 'openai-speech', template: null, user: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' } },
    },
    models: {
      main: { id: 'main', endpoint: 'or', template: null, user: { providerId: 'google/gemini-2.5-flash', input: audio ? ['text', 'audio'] : ['text'] } },
      asr: { id: 'asr', endpoint: 'gq', template: null, user: { providerId: 'whisper-large-v3-turbo', name: 'Whisper on Groq' } },
      tts: { id: 'tts', endpoint: 'oa', template: null, user: { providerId: 'gpt-4o-mini-tts', name: 'OpenAI voice' } },
    },
    roles: { main: { models: ['main'], level: 'off' }, 'speech-in': { models: speechIn, level: 'off' }, 'speech-out': { models: speechOut, level: 'off' } },
  });
}

test('where what you say goes, for each speech-in entry in order (spec §11.7)', () => {
  const rows = whereHeard(config(), { dictation: { available: true, local: false } });
  assert.deepEqual(rows.map((r) => r.name), ['Send audio to the model', 'Whisper on Groq', 'Phone dictation']);
  assert.equal(rows[0].where, 'As sound, to the model that hears it: OpenRouter (openrouter.ai).');
  assert.equal(rows[1].where, 'As sound, to Groq (api.groq.com), to be written down.');
  assert.equal(rows[2].where, DICTATION_AWAY);
  assert.match(DICTATION_AWAY, /Google's servers.*Apple's.*the trace can't show it/);
  assert.equal(whereHeard(config(), { dictation: { available: true, local: true } })[2].where, DICTATION_HERE);
  assert.match(DICTATION_HERE, /on this phone only/i);
  assert.match(whereHeard(config(), { dictation: { available: false, local: false } })[2].where, /This browser has no dictation/);
  assert.match(whereHeard(config({ audio: false }), { dictation: { available: true, local: false } })[0].where, /none of the models that hear you takes audio now/);
});

test('where what she says goes: a voice service, or the browser voice on this phone or not (spec §11.7)', () => {
  const local = { id: 'v1', name: 'Samantha', lang: 'en-US', local: true };
  const online = { id: 'v2', name: 'Google US English', lang: 'en-US', local: false };
  const rows = whereSaid(config(), { browser: true, voice: local });
  assert.deepEqual(rows.map((r) => [r.name, r.where]), [
    ['OpenAI voice', 'Her words go to OpenAI (api.openai.com), which sends back the sound.'],
    ['Browser voice', 'Spoken on this phone (Samantha): her words stay on it.'],
  ]);
  assert.equal(whereSaid(config(), { browser: true, voice: online })[1].where, "Her words go to the service behind Google US English (Google's), to be spoken; they aren't spoken on this phone.");
  assert.match(whereSaid(config(), { browser: true, voice: null })[1].where, /can't tell whether it speaks on this phone/);
  assert.match(whereSaid(config(), { browser: false, voice: null })[1].where, /This browser has no voice of its own/);
});

test("the browser voice: the one you chose; else one on this phone for the language, so her words stay on it; else the browser's default", () => {
  const voices = [
    { id: 'g', name: 'Google US English', lang: 'en-US', local: false, default: true },
    { id: 'd', name: 'Daniel', lang: 'en-GB', local: true },
    { id: 's', name: 'Samantha', lang: 'en-US', local: true },
    { id: 'k', name: 'Kyoko', lang: 'ja-JP', local: true },
  ];
  assert.equal(browserVoiceFor(voices, { chosen: 'g', lang: 'en-US' })?.id, 'g');
  assert.equal(browserVoiceFor(voices, { chosen: '', lang: 'en-US' })?.id, 's');
  assert.equal(browserVoiceFor(voices, { chosen: '', lang: 'en-AU' })?.id, 'd', 'the same language, another region');
  assert.equal(browserVoiceFor(voices, { chosen: 'gone', lang: 'ja' })?.id, 'k');
  assert.equal(browserVoiceFor(voices.filter((v) => !v.local), { chosen: '', lang: 'en-US' })?.id, 'g');
  assert.equal(browserVoiceFor([{ id: 'x', name: 'Google français', lang: 'fr-FR', local: false }, { id: 'y', name: 'Google UK English', lang: 'en-GB', local: false }], { lang: 'en' })?.id, 'y', 'no default: the first in the language');
  assert.equal(browserVoiceFor([], { chosen: '', lang: 'en-US' }), null);
});

test('the trace says when phone dictation listened, without the words; on this phone only when it is (spec §11.7)', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Noted.' } }, { name: 'sleep', input: {} }] }]], { voice: { dictation: true, speechIn: ['dictation'] } });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  k.platform.dictation.say('is there a gas station nearby');
  await k.agent.idle();
  const [line] = await k.events(['speech.browser']);
  assert.equal(line.data.kind, 'dictation');
  assert.equal(line.data.local, false);
  assert.equal(line.data.message, "Phone dictation listened: the browser sends the audio to its own speech service; annai can't see that request.");
  assert.ok(!JSON.stringify(line).includes('gas station'), 'no words in it');
  k.platform.dictationLocal = true;
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  assert.equal(k.platform.dictationOpened.at(-1).local, true, 'dictation is asked to stay on the phone');
  const lines = await k.events(['speech.browser']);
  assert.equal(lines.at(-1).data.message, 'Phone dictation listened, on this phone only.');
});

test('the trace says when a browser voice that is not on this phone spoke; one on the phone needs no line (spec §11.7)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'Noted.' } }, { name: 'sleep', input: {} }] },
    { toolCalls: [{ name: 'speak', input: { text: 'Again.' } }, { name: 'sleep', input: {} }] },
  ]], { voice: {} });
  const cfg = await readConfig(k.ws);
  await saveRoles(k.ws, { ...cfg.roles, 'speech-out': { models: ['browser-voice'], level: 'off' } });
  k.platform.voiceList = [{ id: 'g', name: 'Google US English', lang: 'en-US', local: false }];
  k.agent.send('Hi');
  await k.agent.idle();
  const lines = () => k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(k.voice.scope, { types: ['speech.browser'] }));
  const [line] = await lines();
  assert.deepEqual([line.data.kind, line.data.voice, line.data.local], ['voice', 'Google US English', false]);
  assert.equal(line.data.message, "The browser voice Google US English spoke: the browser sends her words to that voice's service; annai can't see that request.");
  assert.ok(!JSON.stringify(line).includes('Noted'), 'no words in it');
  k.platform.voiceList = [{ id: 's', name: 'Samantha', lang: 'en-US', local: true }];
  k.agent.send('Hi again');
  await k.agent.idle();
  assert.equal((await lines()).length, 1);
  assert.ok(k.platform.log.includes('browser Again.'));
});
