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

test('a server you run, at a plain http:// address on another computer, is told how to reach it: an https address, a Tailscale Serve command with its own port, and CORS; the rule stays', () => {
  /** @type {[string, number][]} */
  const lans = [['http://192.168.1.5:9931/v1', 9931], ['http://gpu-box.local:11434/v1', 11434], ['http://10.0.0.7:8000/v1', 8000], ['http://10.0.0.7/v1', 80]];
  for (const [lan, port] of lans) {
    const said = String(addressProblem(lan));
    assert.match(said, /^An address must start with https:\/\/ \(http:\/\/ only for localhost or 127\.0\.0\.1\)\. Browsers block plain http from an https page, and annai calls only https addresses on your network, so a server on another computer needs one\. /, lan);
    assert.ok(said.endsWith(`Tailscale Serve can give it: tailscale serve --bg --https=8443 http://localhost:${port}. The server must also allow CORS from annai.guide.`), lan);
    assert.doesNotMatch(said, /needs an address like|is an address/, 'a command is not called an address');
  }
  assert.doesNotMatch(String(addressProblem('ftp://example.com')), /another computer/);
  assert.doesNotMatch(String(addressProblem('https://')), /another computer/);
});


test('freeTier in a description is true, false, the name of who doesn\'t charge, or absent: a provider whose keys may be on a free tier', () => {
  assert.deepEqual(checkProviderDesc({ ...OPENAI_LIKE, freeTier: true }), []);
  assert.deepEqual(checkProviderDesc({ ...OPENAI_LIKE, freeTier: false }), []);
  assert.deepEqual(checkProviderDesc({ ...OPENAI_LIKE, freeTier: 'Google' }), [], "who doesn't charge, by name");
  assert.match(checkProviderDesc({ ...OPENAI_LIKE, freeTier: 1 }).join(), /\$\.freeTier/);
  assert.match(checkProviderDesc({ ...OPENAI_LIKE, freeTier: '' }).join(), /\$\.freeTier/);
  // A note for models from before the provider's list gave windows, shown only while one of them is there.
  assert.deepEqual(checkProviderDesc(withAbility(OPENAI_LIKE, 'native', { kind: 'chat', type: 'gemini', noWindowNote: 'Add it again with Fetch model list.' })), []);
  assert.match(checkProviderDesc(withAbility(OPENAI_LIKE, 'native', { kind: 'chat', type: 'gemini', noWindowNote: 3 })).join(), /noWindowNote/);
});

test("the note every local server's page shows: a phone's localhost, https only, a Tailscale Serve command with that server's own port and the address to type, the tailnet, CORS, and Chrome's permission", async () => {
  const { localNote } = await import('../../src/core/llm/provider-desc.js');
  const { readFile } = await import('node:fs/promises');
  const note = localNote('http://localhost:9931/v1');
  assert.match(note, /^On a phone, localhost is the phone itself\. A server on another computer needs an https address: annai calls only https addresses on your network, since browsers block plain http from an https page\. /);
  assert.match(note, /with the phone on your tailnet: run tailscale serve --bg --https=8443 http:\/\/localhost:9931 where the server is, then give annai https:\/\/<machine>\.<tailnet>\.ts\.net:8443\/v1\. /);
  assert.match(note, /The server must also allow CORS from annai\.guide\. Chrome 142 and later may ask you to allow local network access\.$/);
  // Each page's own port: from its description's address.
  /** @type {[string, number][]} */
  const servers = [['provider-llamacpp', 9931], ['provider-ollama', 11434], ['provider-lmstudio', 1234], ['provider-vllm', 8000], ['provider-sglang', 30000], ['provider-local-speech', 8000]];
  for (const [id, port] of servers) {
    const m = JSON.parse(await readFile(new URL(`../../plugins-official/${id}/annai-plugin.json`, import.meta.url), 'utf8'));
    assert.match(localNote(m.provider.baseUrl), new RegExp(`http://localhost:${port} where the server is`), String(id));
  }
  assert.match(localNote(''), /http:\/\/localhost:8080 where the server is/, 'a provider with no address of its own: a usual port');
});
