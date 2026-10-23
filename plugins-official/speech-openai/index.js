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
 * Languages (phase 2; OpenAI's speech-to-text guide and OpenRouter's STT page, read 2026-10-22): a transcription takes `language`, one
 * ISO-639-1 code (OpenRouter: "Auto-detected if omitted"; its `prompt` "is accepted but ignored"), or, for gpt-transcribe, `languages`
 * (several; "Don't send both"). The user speaks several as often as one, so: one language listed, it is sent; several, none (the
 * model detects: giving only the first would force a Chinese sentence into English, and a prompt naming them is one Whisper may
 * echo back on silence); a `language` set by hand on the model's page wins. No voice API takes a language: they follow the text.
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
/** A calm, warm voice among a list's, which is the model's voice before the list's first. */
const WARM = /^(?:sulafat|marin|af_heart)$|neutral/i;
/**
 * A speech list. Only OpenRouter's entries carry supported_voices (null for Fish Audio's, which takes any voice of its library): from
 * those, each model's own voices, its voice (a warm one, else the first) and, for a vendor its docs say ignores instructions,
 * `styled: false`. Any other server's list is read as it is.
 * @param {any} json
 */
const readSpeechList = (json) => entries(json).map((m) => {
  const voices = Array.isArray(m.supported_voices) ? m.supported_voices.filter((/** @type {any} */ v) => typeof v === 'string' && v) : [];
  const tunables = {
    ...(voices.length ? { voice: voices.find((/** @type {string} */ v) => WARM.test(v)) ?? voices[0], voices } : {}),
    ...('supported_voices' in m && !TAKES_STYLE.test(m.id) ? { styled: false } : {}),
  };
  return Object.keys(tunables).length ? { ...listed(m), tunables } : listed(m);
});

/** A style as plain words: whitespace collapsed, at most 200 characters, no trailing punctuation. @param {unknown} s */
const plain = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[\s.,;:!?]+$/, '');
/**
 * The style a request carries, or ''. `instructions` is this tunable's name before the Style field: a user's own, since no description
 * has it (spec §9.2), so it wins over a description's `style`; the page says it is emptied when a style is typed.
 * @param {Record<string, any>} t
 */
const styleOf = (t) => (t.styled === false ? '' : plain(plain(t.instructions) || t.style));

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
      transcribeRequest: ({ endpoint, model, key, tunables: t, audio, languages }) => {
        const form = new FormData();
        form.append('file', new Blob([audio.data], { type: audio.mediaType }), `speech.${EXT[audio.mediaType] ?? 'wav'}`);
        form.append('model', model.providerId);
        form.append('response_format', 'json');
        const codes = [...new Set((languages?.spoken ?? []).map((/** @type {any} */ l) => l?.iso).filter(Boolean))];
        if (t.language) form.append('language', String(t.language));
        else if (/(?:^|\/)gpt-(?:live-)?transcribe(?:-|$)/.test(model.providerId)) for (const c of codes) form.append('languages[]', c);
        else if (codes.length === 1) form.append('language', codes[0]);
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
      /** What OpenRouter adds to a Fish Audio model's text, "[style] ", is billed with it. @param {any} c */
      extraChars: ({ model, tunables: t }) => styleOf(t).length + (styleOf(t) && /^fish-audio\//.test(model.providerId) ? 3 : 0),
      /** @param {any} c */
      speechRequest: ({ endpoint, model, key, tunables: t, text }) => {
        /** @type {Record<string, any>} */
        let body = { model: model.providerId, input: text, response_format: t.format === 'auto' ? 'mp3' : t.format }; // auto: annai chose none
        if (t.voice) body.voice = t.voice; // none: the provider picks (Fish Audio's free voice on OpenRouter picks a different speaker each time)
        const style = styleOf(t);
        if (style) body.instructions = style;
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
