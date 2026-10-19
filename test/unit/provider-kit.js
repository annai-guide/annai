// Provider descriptions the provider tests share (M1).
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
