// Provider descriptions the provider tests share (M1).
import { utf8 } from '../../src/core/bytes.js';
import { sha256Hex } from '../../src/core/hash.js';

/** @typedef {import('../../src/core/llm/provider-desc.js').ProviderDesc} ProviderDesc */

/** A provider like OpenAI's: chat through Responses, chat through Chat Completions (off), a voice. */
export const OPENAI_LIKE = /** @type {ProviderDesc} */ (Object.freeze({
  baseUrl: 'https://api.openai.test/v1', key: 'required', keyUrl: 'https://platform.openai.test/api-keys',
  abilities: {
    chat: { kind: 'chat', type: 'openai-responses', models: [{ providerId: 'gpt-6-luna', name: 'GPT-6 Luna', prices: { input: 0.1, output: 0.5 } }] },
    'chat-completions': { kind: 'chat', type: 'chat-completions', on: false, tunables: { maxTokensField: 'max_completion_tokens' } },
    voice: { kind: 'voice', type: 'openai-speech', models: [{ providerId: 'tts-1', name: 'TTS-1', prices: { perMillionChars: 15 } }] },
  },
  roles: { recommended: { main: ['gpt-6-luna'], 'speech-out': ['tts-1'] } },
}));

/** A local speech server: transcription at the provider's address, a voice at its own. */
export const LOCAL_SPEECH = /** @type {ProviderDesc} */ (Object.freeze({
  baseUrl: 'http://localhost:8000/v1', key: 'optional', local: true,
  abilities: {
    transcription: { kind: 'transcription', type: 'openai-transcription' },
    voice: { kind: 'voice', type: 'openai-speech', baseUrl: 'http://localhost:8880/v1' },
  },
}));

/** @typedef {import('../../src/core/llm/providers.js').ProviderSource} ProviderSource */

/** OpenAI's provider plugin, as a started one registers it: chat through Responses, Chat Completions (off), transcription and a voice. @type {ProviderSource} */
export const OPENAI_SRC = /** @type {ProviderSource} */ ({
  plugin: 'provider-openai', name: 'OpenAI', version: '1.0.0',
  provider: {
    baseUrl: 'https://api.openai.test/v1', key: 'required', keyUrl: 'https://platform.openai.test/api-keys',
    abilities: {
      chat: { kind: 'chat', type: 'openai-responses', name: 'Chat (Responses)', models: [
        { providerId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', prices: { input: 2, output: 10 } },
        { providerId: 'gpt-6-luna', name: 'GPT-6 Luna', prices: { input: 0.1, output: 0.5 } },
      ] },
      'chat-completions': { kind: 'chat', type: 'chat-completions', name: 'Chat (Chat Completions)', on: false, tunables: { maxTokensField: 'max_completion_tokens' } },
      transcription: { kind: 'transcription', type: 'openai-transcription', models: [{ providerId: 'gpt-transcribe', name: 'OpenAI: GPT Transcribe', prices: { perMinute: 0.0045 } }] },
      voice: { kind: 'voice', type: 'openai-speech', models: [{ providerId: 'gpt-4o-mini-tts', name: 'OpenAI: GPT-4o mini TTS (Marin)', tunables: { voice: 'marin' }, prices: { perMillionChars: 18 } }] },
    },
    roles: { recommended: { main: ['gpt-6.1-sol'], utility: ['gpt-6-luna'], decide: ['gpt-6-luna'], 'speech-in': ['gpt-transcribe'], 'speech-out': ['gpt-4o-mini-tts'] } },
  },
});

/** A router with free models and a priced voice, as OpenRouter's is. @type {ProviderSource} */
export const ROUTER_SRC = /** @type {ProviderSource} */ ({
  plugin: 'provider-router', name: 'Router', version: '1.0.0',
  provider: {
    baseUrl: 'https://router.test/api/v1', key: 'required', headers: { 'HTTP-Referer': 'https://annai.guide', 'X-Title': 'annai' },
    abilities: {
      chat: { kind: 'chat', type: 'chat-completions', tunables: { reasoningField: 'reasoning' }, models: [
        { providerId: 'big', name: 'Big', prices: { input: 2, output: 10 } }, { providerId: 'small:free', name: 'Small (free)', prices: { input: 0, output: 0 } },
      ] },
      voice: { kind: 'voice', type: 'openai-speech', models: [{ providerId: 'free-voice', name: 'Free voice', prices: { perMillionChars: 0 } }, { providerId: 'paid-voice', name: 'Paid voice', prices: { perMillionChars: 15 } }] },
    },
    roles: { free: { main: ['small:free'], utility: ['small:free'], decide: ['small:free'] }, recommended: { main: ['big'], utility: ['small:free'], decide: ['small:free'], 'speech-out': ['free-voice', 'paid-voice'] } },
  },
});

/** Anthropic's: Claude models added by id or from a list take both cache lifetimes, and web search. @type {ProviderSource} */
export const ANTHROPIC_SRC = /** @type {ProviderSource} */ ({
  plugin: 'provider-anthropic', name: 'Anthropic', version: '1.0.0',
  provider: {
    baseUrl: 'https://api.anthropic.test', key: 'required',
    abilities: { chat: { kind: 'chat', type: 'anthropic-messages', modelDefaults: { cacheTtls: ['5m', '1h'], providerTools: [{ id: 'anthropic-web-search', name: 'Anthropic web search', kind: 'search', patch: { 'tools+': [{ type: 'web_search_20250305', name: 'web_search' }] } }] } } },
  },
});

/** Another address: every ability off until the user turns it on. @type {ProviderSource} */
export const ANOTHER_SRC = /** @type {ProviderSource} */ ({
  plugin: 'provider-another-address', name: 'Another address', version: '1.0.0',
  provider: {
    baseUrl: '', key: 'optional',
    abilities: {
      'chat-completions': { kind: 'chat', type: 'chat-completions', name: 'Chat Completions', on: false },
      messages: { kind: 'chat', type: 'anthropic-messages', name: 'Anthropic Messages', on: false, modelDefaults: { cacheTtls: ['5m', '1h'] } },
      voice: { kind: 'voice', type: 'openai-speech', name: 'Voice', on: false },
    },
  },
});

/**
 * A protocol plugin: code that registers one endpoint type, which answers "hi" with no network; with
 * list, it lists models at <address>/models, sending the key as a bearer token.
 * @param {string} id @param {string} type @param {string} version @param {{ list?: boolean, speech?: 'in' | 'out' }} [o]
 */
export const PROTO = (id, type, version, { list = false, speech } = {}) => ({
  'annai-plugin.json': JSON.stringify({ id, name: `Proto ${type}`, version, api: 1, entry: 'index.js', provides: { 'endpoint-type': [type] } }),
  'index.js': `export function activate(annai) { return annai.providers.register({ type: '${type}', name: '${type}',
    ${speech === 'out' ? "speech: 'out', speechRequest: (c) => ({ url: c.endpoint.baseUrl + '/audio/speech', headers: c.endpoint.headers, body: '{}' }), readSpeech: async () => ({ data: new Uint8Array(4), mediaType: 'audio/mpeg' })," : ''}
    ${speech === 'in' ? "speech: 'in', transcribeRequest: (c) => ({ url: c.endpoint.baseUrl + '/audio/transcriptions', headers: c.endpoint.headers, body: '{}' }), readTranscript: async () => ({ text: 'heard' })," : ''}
    ${speech ? '' : "run: async function* (c) { yield { type: 'text', text: 'hi from ' + c.endpoint.id.split('/')[1] }; },"}
    ${list ? "listRequest: ({ endpoint, key }) => ({ url: endpoint.baseUrl + '/models', headers: { ...endpoint.headers, ...(key ? { authorization: 'Bearer ' + key } : {}) } }), readList: (j) => j.data.map((m) => ({ providerId: m.id }))," : ''}
  }); }`,
});
/** A data-only provider plugin needing requires, with a chat ability per type. @param {string} id @param {any[]} requires @param {string[]} types @param {string} [version] */
export const PROVIDER = (id, requires, types, version = '1.0.0') => ({
  'annai-plugin.json': JSON.stringify({
    id, name: `Provider ${id}`, version, api: 1, requires,
    provider: { baseUrl: 'https://llm.example/v1', key: 'required', abilities: Object.fromEntries(types.map((t, i) => [`chat-${i}`, { kind: 'chat', type: t }])) },
  }),
});

/**
 * annai's catalog and official plugin files, stood in for: what fetch asked for is kept; failNext makes the next request
 * for one path fail as a dropped connection does; offline makes every request fail.
 * @param {Record<string, Record<string, string>>} plugins by id, each its files
 */
export async function site(plugins) {
  const entries = [];
  for (const [id, f] of Object.entries(plugins)) {
    const m = JSON.parse(f['annai-plugin.json']);
    /** @type {Record<string, string>} */
    const hashes = {};
    for (const [name, text] of Object.entries(f)) hashes[name] = await sha256Hex(utf8(text));
    entries.push({ id, name: m.name, version: m.version, provides: m.provides ?? {}, requires: m.requires ?? [], files: hashes });
  }
  const s = {
    /** @type {string[]} */ asked: [],
    /** @type {Set<string>} */ failing: new Set(),
    offline: false,
    /** @param {string} path */ failNext: (path) => { s.failing.add(path); },
    /** @param {any} url */
    fetch: async (url) => {
      const path = new URL(String(url), 'http://annai.test').pathname;
      s.asked.push(path);
      if (s.offline) throw new TypeError('Failed to fetch');
      if (s.failing.delete(path)) throw new TypeError('Failed to fetch');
      if (path === '/catalog/plugins.json') return new Response(JSON.stringify({ format: 1, plugins: entries }));
      const m = /^\/plugins-official\/([^/]+)\/(.+)$/.exec(path);
      const text = m ? plugins[m[1]]?.[m[2]] : undefined;
      return text === undefined ? new Response('not found', { status: 404 }) : new Response(text);
    },
    entries,
  };
  return s;
}
