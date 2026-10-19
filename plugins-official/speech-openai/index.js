/**
 * OpenAI-compatible speech (spec §9.1, §10): transcription through /audio/transcriptions and
 * voices through /audio/speech. OpenAI, OpenRouter, Groq and local servers (Speaches, whisper.cpp's
 * server, Kokoro) speak this API; their differences are tunables. OpenRouter lists its speech models
 * apart from its chat models (listPath: /models?output_modalities=…).
 */
const MEDIA = /** @type {Record<string, string>} */ ({ mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/L16' });
const EXT = /** @type {Record<string, string>} */ ({ 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' });
const CODES = /** @type {Record<string, string>} */ ({ invalid_api_key: 'auth', insufficient_quota: 'credit', model_not_found: 'not-found' });

/** @param {string} base @param {string} path */
const join = (base, path) => String(base).replace(/\/+$/, '') + path;
/** @param {any} endpoint @param {string | null} key @returns {Record<string, string>} */
const auth = (endpoint, key) => ({ ...(key ? { authorization: `Bearer ${key}` } : {}), ...(endpoint.headers ?? {}) });

/** A sharper kind for an error, from OpenAI's error code. @param {number} _status @param {string} body */
function classify(_status, body) {
  try {
    return CODES[JSON.parse(body)?.error?.code] ?? null;
  } catch {
    return null;
  }
}

/** @param {{ endpoint: any, key: string | null }} c */
const listRequest = ({ endpoint, key }) => ({ url: join(endpoint.baseUrl, endpoint.tunables?.listPath || '/models'), headers: auth(endpoint, key) });
/** @param {any} json */
const readList = (json) => (Array.isArray(json?.data) ? json.data : []).filter((/** @type {any} */ m) => typeof m?.id === 'string')
  .map((/** @type {any} */ m) => (typeof m.name === 'string' && m.name ? { providerId: m.id, name: m.name } : { providerId: m.id }));

/** @param {any} annai */
export function activate(annai) {
  const { ProviderError, mergePatch } = annai.helpers;
  const offs = [
    annai.providers.register({
      type: 'openai-transcription',
      name: 'OpenAI-compatible transcription',
      speech: 'in',
      tunables: { path: '/audio/transcriptions', listPath: '/models', language: '', prompt: '' },
      /** @param {any} c */
      transcribeRequest: ({ endpoint, model, key, tunables: t, audio }) => {
        const form = new FormData();
        form.append('file', new Blob([audio.data], { type: audio.mediaType }), `speech.${EXT[audio.mediaType] ?? 'wav'}`);
        form.append('model', model.providerId);
        form.append('response_format', 'json');
        if (t.language) form.append('language', String(t.language));
        if (t.prompt) form.append('prompt', String(t.prompt));
        return { url: join(endpoint.baseUrl, t.path), headers: auth(endpoint, key), body: form };
      },
      /** @param {Response} res */
      readTranscript: async (res) => {
        const json = await res.json();
        return { text: typeof json?.text === 'string' ? json.text : '' };
      },
      classify,
      listRequest,
      readList,
    }),
    annai.providers.register({
      type: 'openai-speech',
      name: 'OpenAI-compatible voice',
      speech: 'out',
      tunables: { path: '/audio/speech', listPath: '/models', voice: 'marin', format: 'mp3', instructions: '', speed: null },
      /** @param {any} c */
      speechRequest: ({ endpoint, model, key, tunables: t, text }) => {
        /** @type {Record<string, any>} */
        let body = { model: model.providerId, input: text, voice: t.voice, response_format: t.format };
        if (t.instructions) body.instructions = t.instructions;
        if (t.speed) body.speed = t.speed;
        body = mergePatch(mergePatch(body, endpoint.extraBody ?? {}), model.extraBody ?? {});
        return { url: join(endpoint.baseUrl, t.path), headers: { 'content-type': 'application/json', ...auth(endpoint, key) }, body: JSON.stringify(body) };
      },
      /** @param {Response} res @param {any} c */
      readSpeech: async (res, { tunables: t }) => {
        const data = new Uint8Array(await res.arrayBuffer());
        if (!data.length) throw new ProviderError('server', 'The voice sent back no audio.');
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
        return { data, mediaType: type.startsWith('audio/') ? type : MEDIA[t.format] ?? 'audio/mpeg' };
      },
      classify,
      listRequest,
      readList,
    }),
  ];
  return () => { for (const off of offs) off(); };
}
