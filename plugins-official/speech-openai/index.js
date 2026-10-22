/**
 * OpenAI-compatible speech (spec §9.1, §10): transcription through /audio/transcriptions and
 * voices through /audio/speech. OpenAI, OpenRouter, Groq and local servers (Speaches, whisper.cpp's
 * server, Kokoro) speak this API; their differences are tunables. OpenRouter lists its speech models
 * apart from its chat models (listPath: /models?output_modalities=…). audioIn says what audio a
 * transcription takes, and audioOut what a voice gives, as OpenAI's documents them (Koe and Kokoro
 * design, "Audio formats"); with format 'auto', annai asks for the smallest the phone plays.
 * A voice model has a voice and a style, saved on its page and sent with every request (spec §10.1): `voice` as
 * it is, and `style` as `instructions`, which OpenAI's gpt-4o-mini-tts, Gemini's voices and Fish Audio's take
 * (OpenRouter's audio docs; for Fish Audio they become a [bracketed] direction at the start of the text) and
 * the others ignore. `styled: false` says a voice ignores it, so none is sent; unknown (a server of the user's),
 * it is sent. `voices` suggests what the Voice field may hold; a speech list fills it from OpenRouter's supported_voices.
 */
const MEDIA = /** @type {Record<string, string>} */ ({ mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/L16' });
const EXT = /** @type {Record<string, string>} */ ({ 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/flac': 'flac' });
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
/** @param {any} json @returns {any[]} */
const entries = (json) => (Array.isArray(json?.data) ? json.data : []).filter((/** @type {any} */ m) => typeof m?.id === 'string');
/** @param {any} m */
const listed = (m) => (typeof m.name === 'string' && m.name ? { providerId: m.id, name: m.name } : { providerId: m.id });
/** @param {any} json */
const readList = (json) => entries(json).map(listed);
/** A model's id, as OpenRouter's audio docs say whether its vendor takes instructions: OpenAI's gpt-4o-mini-tts, Gemini and Fish Audio. */
const TAKES_STYLE = /^(?:openai\/gpt-4o-mini-tts|google\/|fish-audio\/)/;
/** Fish Audio's models have no voice of their own: sent none, each request is a speaker of its choosing. This is Laura, a library voice by Fish Audio, as provider-openrouter's description has it. */
const FISH = { voice: 'e3cd384158934cc9a01029cd7d278634', style: 'calm, warm and friendly' };
/**
 * A speech list: also each model's own voices (OpenRouter's supported_voices) and, where its id says it ignores a style
 * (OpenAI's tts-1, or a vendor on OpenRouter other than those above), `styled: false`; a Fish Audio model starts with FISH.
 * @param {any} json
 */
const readSpeechList = (json) => entries(json).map((m) => {
  const voices = Array.isArray(m.supported_voices) ? m.supported_voices.filter((/** @type {any} */ v) => typeof v === 'string' && v) : [];
  const ignores = /^tts-1/.test(m.id) || (m.id.includes('/') && !TAKES_STYLE.test(m.id));
  const tunables = { ...(m.id.startsWith('fish-audio/') ? FISH : {}), ...(voices.length ? { voices } : {}), ...(ignores ? { styled: false } : {}) };
  return Object.keys(tunables).length ? { ...listed(m), tunables } : listed(m);
});

/** @param {any} annai */
export function activate(annai) {
  const { ProviderError, mergePatch } = annai.helpers;
  const offs = [
    annai.providers.register({
      type: 'openai-transcription',
      name: 'OpenAI-compatible transcription',
      speech: 'in',
      tunables: { path: '/audio/transcriptions', listPath: '/models', language: '', prompt: '', audioIn: ['webm', 'mp4', 'mp3', 'wav'] },
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
      tunables: { path: '/audio/speech', listPath: '/models', voice: 'marin', format: 'auto', audioOut: ['opus', 'aac', 'mp3', 'flac', 'wav'], style: '', speed: null },
      /** @param {any} c */
      speechRequest: ({ endpoint, model, key, tunables: t, text }) => {
        /** @type {Record<string, any>} */
        let body = { model: model.providerId, input: text, response_format: t.format === 'auto' ? 'mp3' : t.format }; // auto: annai chose none
        if (t.voice) body.voice = t.voice; // none: the provider picks (Fish Audio's free voice on OpenRouter picks a different speaker each time)
        const style = String(t.style || t.instructions || '').trim(); // instructions: this tunable's name before the Style field
        if (style && t.styled !== false) body.instructions = style;
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
      readList: readSpeechList,
    }),
  ];
  return () => { for (const off of offs) off(); };
}
