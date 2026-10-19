import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProviderDesc, descHosts, ABILITY_KINDS, CATEGORIES, ROLE_KIND } from '../../src/core/llm/provider-desc.js';
import { OPENAI_LIKE, LOCAL_SPEECH } from './provider-kit.js';

/** @param {any} desc @param {string} id @param {any} ability */
const withAbility = (desc, id, ability) => ({ ...desc, abilities: { ...desc.abilities, [id]: ability } });

test('a provider description with abilities, models and roles is valid; each mistake is named', () => {
  assert.deepEqual(checkProviderDesc(OPENAI_LIKE), []);
  assert.deepEqual(checkProviderDesc(LOCAL_SPEECH), []);
  assert.match(checkProviderDesc(withAbility(OPENAI_LIKE, 'chat', { kind: 'chat' })).join(), /abilities\.chat\.type/);
  assert.match(checkProviderDesc(withAbility(OPENAI_LIKE, 'x', { kind: 'video', type: 'chat-completions' })).join(), /abilities\.x\.kind/);
  assert.match(checkProviderDesc({ ...OPENAI_LIKE, key: 'maybe' }).join(), /\$\.key/);
  assert.match(checkProviderDesc({ ...OPENAI_LIKE, roles: { recommended: { main: ['no-such-model'] } } }).join(), /roles\.recommended\.main/);
  assert.match(checkProviderDesc({ ...OPENAI_LIKE, roles: { recommended: { 'speech-out': ['gpt-6-luna'] } } }).join(), /speech-out/); // a chat model can't be a voice
  assert.match(checkProviderDesc(withAbility(OPENAI_LIKE, 'Bad Id', { kind: 'chat', type: 'x' })).join(), /ability id/);
  assert.match(checkProviderDesc({ ...OPENAI_LIKE, roles: { recommended: { sing: ['gpt-6-luna'] } } }).join(), /roles\.recommended\.sing/);
  assert.match(checkProviderDesc(withAbility(OPENAI_LIKE, 'chat', { kind: 'chat', type: 'openai-responses', models: [{ name: 'no id' }] })).join(), /models\[0\]\.providerId/);
  assert.match(checkProviderDesc({ ...OPENAI_LIKE, abilities: {} }).join(), /at least one ability/);
  assert.match(checkProviderDesc(null).join(), /\$/);
});

test('descHosts lists every host a key may go to', () => {
  assert.deepEqual(descHosts(LOCAL_SPEECH), ['localhost:8000', 'localhost:8880']);
  assert.deepEqual(descHosts(OPENAI_LIKE), ['api.openai.test']);
  assert.deepEqual(descHosts({ ...LOCAL_SPEECH, baseUrl: '', abilities: { chat: { kind: 'chat', type: 'chat-completions' } } }), []);
});

test('the kinds, categories and which ability kind each role takes', () => {
  assert.deepEqual(ABILITY_KINDS, ['chat', 'transcription', 'voice']);
  assert.deepEqual(CATEGORIES, ['providers', 'speech', 'backup', 'tools', 'skills', 'developer']);
  assert.deepEqual(ROLE_KIND, { main: 'chat', utility: 'chat', decide: 'chat', 'speech-in': 'transcription', 'speech-out': 'voice' });
});
