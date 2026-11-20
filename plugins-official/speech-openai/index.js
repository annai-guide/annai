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
 * Raw audio (PCM, 16-bit little-endian mono, no header): a voice is asked for it where its format is 'pcm', where its `stream`
 * tunable is on (the voice page's Stream switch, off unless a provider's description names it: OpenRouter's), and where its id
 * starts with one of the ability's `pcmOnly` prefixes (OpenRouter's HeyGen and Gemini voices answer nothing else: 400 for mp3 and
 * wav, the voice probe of 2026-11-19). Whole, it is played as a WAV clip; streamed (readSpeechStream), through the stream player
 * as it comes. Either way at the rate its answer names, `audio/pcm;rate=44100;channels=1` (OpenRouter's, observed on every PCM
 * answer of the probe, not documented), read by our own rule; an answer with no rate, or one outside it, fails that voice (the
 * next one speaks), never a guess.
 */
const MEDIA = /** @type {Record<string, string>} */ ({ mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav' });
/**
 * The rates a 16-bit PCM voice is made at: 24 kHz (Gemini's, Grok's, Voxtral's, Kokoro's) and 44.1 kHz (Fish Audio's, HeyGen's) as the
 * probe of 2026-11-19 saw them, cross-checked against their MP3's length within 2%; 24 kHz is also OpenAI's own, as its speech guide
 * documents it (the probe named no OpenAI voice, and nothing here measured it); 8, 16, 22.05, 32 and 48 kHz, the other PCM outputs
 * ElevenLabs and Azure list (their text-to-speech references, read 2026-11-19: ElevenLabs alone has 32 kHz). A rate outside them is a
 * header annai can't trust, not one to play at.
 */
const RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000]);
/** The names a raw PCM answer goes by: only audio/pcm, which is 16-bit little-endian, is played (IANA's audio/L16 is big-endian). */
const RAW = /^audio\/(?:pcm|x-pcm|l\d+)$/i;
/**
 * A PCM answer's rate by our own rule (RULES principle 9): the Content-Type is audio/pcm, with nothing but one rate among RATES and, if
 * it says, one channel. Anything else (a parameter such as encoding=f32le, which may change what the bytes are, or another name for
 * raw audio) is not a form annai plays: null. @param {string} header
 */
function pcmRate(header) {
  const [type, ...params] = header.toLowerCase().split(';').map((s) => s.trim());
  const values = (/** @type {string} */ name) => params.filter((p) => p.startsWith(`${name}=`)).map((p) => p.slice(name.length + 1));
  const rates = values('rate');
  const channels = values('channels');
  const ok = type === 'audio/pcm' && params.length === rates.length + channels.length && rates.length === 1 && /^\d+$/.test(rates[0]) && RATES.has(Number(rates[0]))
    && (!channels.length || (channels.length === 1 && channels[0] === '1'));
  return ok ? Number(rates[0]) : null;
}
/**
 * Bytes of 16-bit little-endian PCM as samples, after the odd byte a piece before ended with; the odd byte this one ends with is
 * kept for the next (a network piece ends anywhere: Fish Audio's came in pieces of 4229, 3715 and 26 bytes).
 * @param {Uint8Array | null} odd @param {Uint8Array} bytes @returns {{ pcm: Int16Array, odd: Uint8Array | null }}
 */
function samples(odd, bytes) {
  const all = odd ? new Uint8Array(odd.length + bytes.length) : bytes;
  if (odd) {
    all.set(odd);
    all.set(bytes, odd.length);
  }
  const pcm = new Int16Array(all.length >> 1);
  const dv = new DataView(all.buffer, all.byteOffset, pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = dv.getInt16(i * 2, true);
  return { pcm, odd: all.length % 2 ? all.slice(-1) : null };
}
/** Whether a voice is asked for raw audio. @param {{ providerId: string }} model @param {Record<string, any>} t */
const asksPcm = (model, t) => t.format === 'pcm' || t.stream !== false
  || [].concat(t.pcmOnly ?? []).some((/** @type {unknown} */ p) => typeof p === 'string' && p !== '' && String(model.providerId).startsWith(p));
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
  const { ProviderError, mergePatch, wav } = annai.helpers;
  const { t } = annai.l10n;

  /** A reply's body read, a dropped connection a network error (the next voice says the sentence), never the plugin's. @template T @param {() => Promise<T>} read */
  const received = async (read) => {
    try {
      return await read();
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError' || /** @type {any} */ (e)?.name === 'TimeoutError') throw e;
      throw new ProviderError('network', 'The voice stopped before it finished.', { cause: e });
    }
  };
  /** A PCM answer annai can't play: the Content-Type it came with, quoted (cut short), is the evidence. @param {string} header */
  const unplayable = (header) => {
    const said = header.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
    return new ProviderError('server', RAW.test(header.split(';')[0].trim()) ? `The voice sent raw audio (PCM) in a form annai can't play ("${said}"): it plays 16-bit mono at a rate it knows.`
      : `The voice sent ${said ? `"${said}"` : 'no content type'}, not the raw audio (PCM) annai asked for.`);
  };
  /** The answer's PCM as it arrives, at the rate it names (its Content-Type, read by pcmRate). @param {Response} res @returns {AsyncGenerator<{ pcm: Int16Array, rate: number }>} */
  async function* pieces(res) {
    const header = res.headers.get('content-type') ?? '';
    const rate = pcmRate(header);
    if (!rate) {
      res.body?.cancel().catch(() => {}); // not read: the connection goes, with its sentence said whole by the next voice
      throw unplayable(header);
    }
    if (!res.body) return;
    const reader = res.body.getReader();
    /** @type {Uint8Array | null} */
    let odd = null;
    let ended = false;
    try {
      for (;;) {
        const r = await received(() => reader.read());
        if (r.done) break;
        const got = samples(odd, r.value);
        odd = got.odd;
        if (got.pcm.length) yield { pcm: got.pcm, rate };
      }
      ended = true;
    } finally {
      if (!ended) reader.cancel().catch(() => {}); // stopped early, or cut: the connection goes
    }
  }

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
        else if (codes.length === 1 && /^[a-z]{2}$/.test(codes[0])) form.append('language', codes[0]); // ISO-639-1 only: no `yue`
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
      // stream: ask for raw audio and play it as it comes (off: each sentence whole, in its format). pcmOnly, which a description gives:
      // the prefixes of the ids of voices that answer only raw audio.
      tunables: { path: '/audio/speech', listPath: '/models', voice: 'marin', format: 'auto', audioOut: ['opus', 'aac', 'mp3', 'flac', 'wav'], style: '', speed: null, stream: false },
      // Its switch shows only where a provider's description names `stream` (provider.js): OpenRouter's voices name their PCM's rate,
      // which other servers' may not. Raw audio is about 3 times an MP3's data at 24 kHz, 5.5 times at 44.1 kHz: 16-bit mono at 384 and
      // 705.6 kbit/s against a 128 kbit/s MP3 (nominal; the probe's Fish Audio clip, 442,368 bytes against 78,157, was 5.66 times).
      // Streamed, Fish Audio's voice started 2.0, 4.1 and 5.4 s sooner for texts of 4.8, 10.3 and 11.3 s of speech (the probe: the MP3's
      // last byte less the stream's first piece): the "2 to 5 seconds" of the provider's note. It plays about a second after the request:
      // the probe's first piece came 460 ms in, and stream-start.js measures the arrival rate for a quarter second before it starts.
      choices: { stream: { label: t`Stream her voice, so she starts sooner, uncompressed: several times the data (off: each sentence arrives whole first, compressed unless the voice sends only uncompressed audio)` } },
      /** What OpenRouter adds to a Fish Audio model's text, "[style] ", is billed with it. @param {any} c */
      extraChars: ({ model, tunables: t }) => styleOf(t).length + (styleOf(t) && /^fish-audio\//.test(model.providerId) ? 3 : 0),
      /** @param {any} c */
      speechRequest: ({ endpoint, model, key, tunables: t, text }) => {
        /** @type {Record<string, any>} */
        let body = { model: model.providerId, input: text, response_format: asksPcm(model, t) ? 'pcm' : t.format === 'auto' ? 'mp3' : t.format }; // auto: annai chose none
        if (t.voice) body.voice = t.voice; // none: the provider picks (Fish Audio's free voice on OpenRouter picks a different speaker each time)
        const style = styleOf(t);
        if (style) body.instructions = style;
        if (t.speed) body.speed = t.speed;
        body = mergePatch(mergePatch(body, endpoint.extraBody ?? {}), model.extraBody ?? {});
        return { url: join(endpoint.baseUrl, t.path), headers: { 'content-type': 'application/json', ...auth(endpoint, key) }, body: JSON.stringify(body) };
      },
      /** Raw audio as a WAV clip at the rate its answer names; any other audio as it came. @param {Response} res @param {any} c */
      readSpeech: async (res, { model, tunables: t }) => {
        const data = new Uint8Array(await received(() => res.arrayBuffer()));
        if (!data.length) throw new ProviderError('server', 'The voice sent back no audio.');
        const header = res.headers.get('content-type') ?? '';
        const type = header.split(';')[0].trim();
        if (RAW.test(type) || (!type.startsWith('audio/') && asksPcm(model, t))) {
          const rate = pcmRate(header);
          if (!rate) throw unplayable(header);
          return { data: wav.encode(samples(null, data).pcm, rate), mediaType: 'audio/wav' };
        }
        return { data, mediaType: type.startsWith('audio/') ? type : MEDIA[t.format] ?? 'audio/mpeg' };
      },
      /** @param {Response} res */
      readSpeechStream: (res) => pieces(res),
      classify,
      listRequest,
      readList: readSpeechList,
    }),
  ];
  return () => { for (const off of offs) off(); };
}
