import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProviderDesc, descOrigins, addressProblem, ABILITY_KINDS, CATEGORIES, ROLE_KINDS } from '../../src/core/llm/provider-desc.js';
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

test('descOrigins lists every origin a key may go to: scheme, host and port', () => {
  assert.deepEqual(descOrigins(LOCAL_SPEECH), ['http://localhost:8000', 'http://localhost:8880']);
  assert.deepEqual(descOrigins(OPENAI_LIKE), ['https://api.openai.test']);
  assert.deepEqual(descOrigins({ ...LOCAL_SPEECH, baseUrl: '', abilities: { chat: { kind: 'chat', type: 'chat-completions' } } }), [], 'an address the user gives');
});

test('security review: every address must parse, and be https, or http only for localhost and 127.0.0.1 (the CSP); none is dropped', () => {
  const at = (/** @type {string} */ baseUrl) => checkProviderDesc({ ...OPENAI_LIKE, baseUrl }).join();
  const abilityAt = (/** @type {string} */ baseUrl) => checkProviderDesc(withAbility(OPENAI_LIKE, 'voice', { ...OPENAI_LIKE.abilities.voice, baseUrl })).join();
  for (const bad of ['not a url', 'api.openai.test/v1', 'http://api.openai.test/v1', 'http://[::1]:8000/v1', 'ftp://api.openai.test/', 'javascript:alert(1)', 'https://']) {
    assert.match(at(bad), /\$\.baseUrl/, bad);
    assert.match(abilityAt(bad), /\$\.abilities\.voice\.baseUrl/, bad);
  }
  for (const good of ['', 'https://api.openai.test/v1', 'http://localhost:8000/v1', 'http://127.0.0.1:9931/v1', 'https://10.0.0.5:8443/v1']) assert.equal(at(good), '', good);
  assert.equal(abilityAt('http://localhost:8880/v1'), '');
  assert.match(abilityAt(''), /abilities\.voice\.baseUrl/, "an ability's own address, given, can't be empty");
});

test('the kinds, categories and which ability kind each role takes', () => {
  assert.deepEqual(ABILITY_KINDS, ['chat', 'transcription', 'voice', 'realtime']);
  assert.deepEqual(CATEGORIES, ['providers', 'speech', 'backup', 'tools', 'skills', 'developer']);
  // Koe's lists take realtime voice models too (K4); no other role does.
  assert.deepEqual(ROLE_KINDS, { main: ['chat'], utility: ['chat'], decide: ['chat'], koe: ['chat', 'realtime'], 'speech-in': ['transcription'], 'speech-out': ['voice'] });
  const live = { baseUrl: 'https://live.test', key: 'required', abilities: { live: { kind: 'realtime', type: 'gemini-live', on: false, models: [{ providerId: 'live-1' }] } } };
  assert.deepEqual(checkProviderDesc({ ...live, roles: { recommended: { koe: ['live-1'] } } }), []);
  assert.deepEqual(checkProviderDesc({ ...live, roles: { recommended: { main: ['live-1'] } } }), ['$.roles.recommended.main: live-1 isn\'t a chat model of this provider']);
});

test('fix pass: an address typed on a provider\'s page is checked by the same rule: https, or http only for localhost or 127.0.0.1, in words', () => {
  for (const ok of ['https://api.example.com/v1', 'http://localhost:8000/v1', 'http://127.0.0.1:9931/v1']) assert.equal(addressProblem(ok), null, ok);
  assert.match(String(addressProblem('api.example.com/v1')), /isn't a web address.*https:\/\//);
  assert.match(String(addressProblem('http://192.168.1.5:8080/v1')), /must start with https:\/\/ \(http:\/\/ only for localhost or 127\.0\.0\.1\)/);
  assert.match(String(addressProblem('ftp://example.com')), /must start with https/);
});

test('a server you run, at a plain http:// address on another computer, is told how to reach it: HTTPS in front of it; the rule stays', () => {
  for (const lan of ['http://192.168.1.5:9931/v1', 'http://gpu-box.local:11434/v1', 'http://10.0.0.7:8000/v1']) {
    assert.match(String(addressProblem(lan)), /must start with https:\/\/ \(http:\/\/ only for localhost or 127\.0\.0\.1\)\. A server on another computer needs HTTPS in front of it, such as Tailscale Serve or a tunnel\.$/, lan);
  }
  assert.doesNotMatch(String(addressProblem('ftp://example.com')), /another computer/);
  assert.doesNotMatch(String(addressProblem('https://')), /another computer/);
});
