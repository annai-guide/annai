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
