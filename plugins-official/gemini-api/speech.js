import { TUNABLES, auth, join, classify, retryAfter, codeKind, readList as chatList } from './chat.js';
import { toContent } from './steps.js';
import { levelsFor } from './levels.js';

/**
 * Gemini's transcription and voices (G3), through the Interactions API as chat is, the key in its header.
 * Nothing is kept on Google's side (`store: false`).
 * - Transcription: Google's transcription model (gemini-3.5-transcribe) takes the audio alone with its
 *   transcription_config, Google's documented way to plain speech-to-text; any other model is told to write
 *   the speech down (INSTRUCTION) at temperature 0 and its lowest thinking. Measured 2026-10-20: both heard
 *   "Where should we eat?"; flash-lite with transcription_config and no words said "<noise>".
 * - Voices: Google sends 16-bit PCM at 24 kHz or G.711 at 8 kHz, base64 in JSON. Asked for μ-law at 16 kHz,
 *   or PCM at 16 kHz, it sent 8 and 24 (measured 2026-10-20), so those are the two qualities. The request
 *   always streams: as it comes, a sentence's first audio is in about 0.6 s, and even read whole it is ready
 *   sooner than a whole reply (1.1 s against 1.5–1.9 s). readSpeechStream gives the PCM as it comes, which
 *   annai plays once it won't stutter; readSpeech gives the whole clip as WAV (the stream switch off).
 * - Languages (phase 2; Google's transcription and speech guides, read 2026-10-22): the transcription model takes
 *   transcription_config.language_codes, several BCP-47 tags in Google's own list (en-US, ja-JP, cmn-Hans-CN: a language it has no tag for
 *   is left out), "If omitted or empty, the model automatically detects the language and handles code-switching"; any other model is told
 *   in the prompt which languages the speaker uses. The voice is given none: "The TTS models detect the input language automatically."
 */
export const INSTRUCTION = 'Transcribe this speech exactly, in its own language. Output only the words.';
/** The same, for a speaker whose languages are known (phase 2): named, so a short word is not taken for another. @param {{ spoken?: { name?: string }[] } | undefined} languages */
export function instructionFor(languages) {
  const names = (languages?.spoken ?? []).map((l) => String(l?.name ?? '')).filter(Boolean);
  if (!names.length) return INSTRUCTION;
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
  return `Transcribe this speech exactly, in its own language. The speaker uses ${list}: write ${names.length > 1 ? 'each' : 'it'} in the language spoken and never translate. Output only the words.`;
}
/** Google's 30 prebuilt voices, in its order (its voice options table, 2026-10-22), for the Voice field. */
const VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome',
  'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];
/** The models whose guide has the style in the text (2.5 and 3.1); from 3.8, it is speech_metadata. */
const IN_TEXT = /(?:^|-)(?:2\.\d|3\.[0-7])(?:-|$)/;
/** A style as plain words: whitespace collapsed, at most 200 characters, no trailing punctuation. @param {unknown} s */
const plain = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[\s.,;:!?]+$/, '');
/** The style a request carries, or ''. @param {Record<string, any>} t */
const styleOf = (t) => (t.styled === false ? '' : plain(t.style));
/** What a model that reads its text may be told after "Say": a few plain words, never a colon, a sentence or a tag it might say aloud. @param {string} style */
const foldable = (style) => /^[\p{L}\p{N}][\p{L}\p{N} ,'’-]*$/u.test(style) && style.length <= 80 && style.split(' ').length <= 6;
/** The voice's qualities, as Google is asked for them. @type {Record<string, { mime_type: string, sample_rate: number }>} */
const FORMATS = { pcm24: { mime_type: 'audio/l16', sample_rate: 24000 }, mulaw8: { mime_type: 'audio/mulaw', sample_rate: 8000 } };
/** @param {unknown} x @returns {x is Record<string, any>} */
const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
/** A model id from before provider-gemini 2.0 is "models/<id>". @param {unknown} id */
const idOf = (id) => String(id).replace(/^models\//, '');
/** @param {any} endpoint @param {string | null} key @param {any} body */
const post = (endpoint, key, body) => ({ url: join(endpoint.baseUrl, '/v1beta/interactions'), headers: { 'content-type': 'application/json', ...auth(endpoint, key) }, body: JSON.stringify(body) });
/** @param {{ endpoint: any, key: string | null }} c */
const listRequest = ({ endpoint, key }) => ({ url: join(endpoint.baseUrl, '/v1beta/models?pageSize=1000'), headers: auth(endpoint, key) });
/** The models a list names that generate content, by a test of their ids, with their names. @param {any} json @param {(id: string, m: any) => boolean} keep */
const listed = (json, keep) => (Array.isArray(json?.models) ? json.models : []).flatMap((/** @type {any} */ m) => {
  const id = idOf(m?.name ?? '');
  return id && m.supportedGenerationMethods?.includes?.('generateContent') && keep(id, m) ? [{ providerId: id, ...(m.displayName ? { name: String(m.displayName) } : {}) }] : [];
});

/** A model's lowest thinking, for a transcription: minimal where its family has it, else low; none for a family annai knows no levels for. @param {string} id */
function lowest(id) {
  const map = levelsFor(id);
  const level = (map?.off ?? map?.low)?.generation_config?.thinking_level;
  return level ? { thinking_level: level } : {};
}

/** The error a finished interaction carries, or an error reply's, as a ProviderError. @param {any} e @param {any} ProviderError */
const failure = (e, ProviderError) => new ProviderError(codeKind(e?.code, e?.message) ?? 'server', String(e?.message ?? 'Gemini reported an error.'));

/** A whole interaction's JSON; its error, or a failed status, thrown. @param {Response} res @param {any} ProviderError */
async function whole(res, ProviderError) {
  /** @type {any} */
  let j;
  try {
    j = JSON.parse(await res.text());
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError' || /** @type {any} */ (e)?.name === 'TimeoutError') throw e;
    throw new ProviderError('server', "Gemini's answer couldn't be read.");
  }
  if (isObject(j?.error) && !Array.isArray(j.steps)) throw failure(j.error, ProviderError);
  if (j?.status === 'failed') throw failure((Array.isArray(j.errors) ? j.errors[0] : j.error) ?? {}, ProviderError);
  return j;
}

/** The blocks of a type in a whole interaction's model_output steps, in order. @param {any} j @param {string} type @returns {any[]} */
const blocks = (j, type) => (Array.isArray(j?.steps) ? j.steps : []).filter((s) => s?.type === 'model_output')
  .flatMap((s) => (Array.isArray(s.content) ? s.content : [])).filter((c) => c?.type === type);

/** @param {any} annai */
export function transcriptionType(annai) {
  const { ProviderError, base64 } = annai.helpers;
  return {
    type: 'gemini-transcription',
    name: 'Gemini API transcription',
    speech: 'in',
    // language: for Google's transcription model, the languages to expect (BCP-47, comma-separated, such as "ja-JP"); empty: the languages
    // the user speaks (Settings → Shiori), else it tells.
    tunables: { audioIn: TUNABLES.audioIn, language: '' },
    /** @param {any} c */
    transcribeRequest: ({ endpoint, model, key, tunables: t, audio, languages }) => {
      const id = idOf(model.providerId);
      const sound = toContent({ type: 'audio', mediaType: audio.mediaType, data: base64.encode(audio.data) });
      if (/transcribe/.test(id)) {
        const own = String(t.language ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const language_codes = own.length ? own : [...new Set((languages?.spoken ?? []).map((/** @type {any} */ l) => l?.google).filter(Boolean))];
        return post(endpoint, key, { model: id, store: false, input: [{ type: 'user_input', content: [sound] }], generation_config: { transcription_config: { language_codes } } });
      }
      return post(endpoint, key, {
        model: id, store: false,
        input: [{ type: 'user_input', content: [{ type: 'text', text: instructionFor(languages) }, sound] }],
        generation_config: { temperature: 0, ...lowest(id) },
      });
    },
    // Google's tags for what isn't words ("<noise>", 2026-10-20) go, as Koe's cleanSaid takes them out: never the user's words.
    /** @param {Response} res */
    readTranscript: async (res) => ({ text: blocks(await whole(res, ProviderError), 'text').map((c) => String(c.text ?? '')).join('').replace(/<[^<>]*>/g, ' ').replace(/\s+/g, ' ').trim() }),
    classify,
    retryAfter,
    listRequest,
    // Google's transcription models, and the flash chat models, which hear well and cheaply; not the live ones.
    /** @param {any} json */
    readList: (json) => listed(json, (id, m) => (/transcribe/.test(id) ? !/live/.test(id) : /flash/.test(id) && chatList({ models: [m] }).length > 0)),
  };
}

/** @param {any} annai */
export function speechType(annai) {
  const { sse, ProviderError, base64, g711, wav } = annai.helpers;

  /**
   * A reader of Google's audio blocks as 16-bit PCM at their rate. Its PCM is little-endian; a piece that ends
   * mid-sample keeps its odd byte for the next.
   */
  const decoder = () => {
    /** @type {Uint8Array | null} */
    let odd = null;
    /** @param {any} block @returns {{ pcm: Int16Array, rate: number }} */
    return (block) => {
      const mime = String(block.mime_type ?? '');
      const type = mime.split(';')[0].trim().toLowerCase();
      const rate = Number(block.sample_rate) || Number(/rate=(\d+)/.exec(mime)?.[1]) || 24000; // Google's default: 24 kHz
      let bytes = base64.decode(String(block.data ?? ''));
      if (type === 'audio/mulaw') return { pcm: g711.ulawToPcm(bytes), rate };
      if (type === 'audio/alaw') return { pcm: g711.alawToPcm(bytes), rate };
      if (type === 'audio/wav') {
        try {
          return wav.decode(bytes);
        } catch {
          throw new ProviderError('server', "Gemini's voice sent a WAV file annai can't read.");
        }
      }
      if (odd) {
        const all = new Uint8Array(odd.length + bytes.length);
        all.set(odd);
        all.set(bytes, odd.length);
        bytes = all;
      }
      const n = bytes.length >> 1;
      odd = bytes.length % 2 ? bytes.slice(-1) : null;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
      return { pcm: Int16Array.from({ length: n }, (_, i) => dv.getInt16(i * 2, true)), rate };
    };
  };

  /** The audio of a streamed interaction, piece by piece, as it comes; a whole one's in one piece. @param {Response} res @returns {AsyncGenerator<{ pcm: Int16Array, rate: number }>} */
  async function* pieces(res) {
    const decode = decoder();
    if (/^application\/json\s*(;|$)/i.test(res.headers.get('content-type') ?? '')) {
      for (const b of blocks(await whole(res, ProviderError), 'audio')) yield decode(b);
      return;
    }
    for await (const { event, data } of sse(/** @type {ReadableStream<Uint8Array>} */ (res.body))) {
      if (data === '[DONE]') break;
      /** @type {any} */
      let e;
      try {
        e = JSON.parse(data);
      } catch {
        continue;
      }
      const type = e.event_type ?? event;
      if (type === 'step.delta' && e.delta?.type === 'audio' && typeof e.delta.data === 'string') {
        const piece = decode(e.delta);
        if (piece.pcm.length) yield piece;
      } else if (type === 'error') throw failure(e.error ?? e, ProviderError);
      else if (type === 'interaction.completed') {
        const it = e.interaction ?? {};
        if (it.status === 'failed') throw failure((Array.isArray(it.errors) ? it.errors[0] : it.error) ?? {}, ProviderError);
        return;
      }
    }
    throw new ProviderError('network', 'The voice stopped before it finished.');
  }

  return {
    type: 'gemini-speech',
    name: 'Gemini API voice',
    speech: 'out',
    // voice: one of Google's 30; style: how she should sound, in a few words (empty: none is sent); format: pcm24, full quality, or mulaw8, phone quality; stream: play
    // as it comes, once annai's start rule says it won't stutter (G3), else each sentence whole.
    tunables: { voice: 'Sulafat', style: '', format: 'pcm24', stream: true },
    voices: VOICES,
    // Data a minute of speech, as measured on the wire, streamed (2026-10-20): 239 KB for 3.6 s at full quality, 42 KB for 3.15 s at phone quality.
    choices: {
      format: { label: 'Sound', options: { pcm24: 'Full quality (the most data: about 4 MB a minute of speech)', mulaw8: 'Phone quality, 8 kHz (about 0.8 MB a minute)' } },
      stream: { label: 'Stream her voice, so she starts sooner (off: each sentence arrives whole first)' },
    },
    /** The style is input text, billed with the text. @param {any} c */
    extraChars: ({ tunables: t }) => styleOf(t).length,
    /** @param {any} c */
    speechRequest: ({ endpoint, model, key, tunables: t, text }) => {
      // An update reaches an annai still running its older shell, without G.711 and WAV, until a restart.
      if (!g711 || !wav) throw new Error('Gemini API voice needs a newer annai: restart annai to update it.');
      const id = idOf(model.providerId);
      const style = styleOf(t);
      const sentence = !style || (IN_TEXT.test(id) && !foldable(style)) ? { type: 'text', text }
        : IN_TEXT.test(id) ? { type: 'text', text: `Say ${style}: ${text}` } : { type: 'text', text, annotations: [{ type: 'speech_metadata', style }] };
      return post(endpoint, key, {
        model: id, store: false, stream: true,
        input: [{ type: 'user_input', content: [sentence] }],
        response_format: { type: 'audio', ...(FORMATS[t.format] ?? FORMATS.pcm24) },
        generation_config: { speech_config: [{ voice: String(t.voice || 'Sulafat') }] },
      });
    },
    /** @param {Response} res */
    readSpeechStream: (res) => pieces(res),
    /** @param {Response} res */
    readSpeech: async (res) => {
      if (/^application\/json\s*(;|$)/i.test(res.headers.get('content-type') ?? '')) {
        const audio = blocks(await whole(res, ProviderError), 'audio');
        // Google's whole default is a WAV file: as it came.
        if (audio.length === 1 && /^audio\/wav\b/i.test(String(audio[0].mime_type))) return { data: base64.decode(String(audio[0].data ?? '')), mediaType: 'audio/wav' };
        if (!audio.length) throw new ProviderError('server', 'The voice sent back no audio.');
        const decode = decoder();
        return clip(audio.map((b) => decode(b)));
      }
      /** @type {{ pcm: Int16Array, rate: number }[]} */
      const got = [];
      for await (const p of pieces(res)) got.push(p);
      return clip(got);
    },
    classify,
    retryAfter,
    listRequest,
    /** @param {any} json */
    readList: (json) => listed(json, (id) => /tts/.test(id)),
  };

  /** Pieces as one WAV clip, at the first's rate. @param {{ pcm: Int16Array, rate: number }[]} got */
  function clip(got) {
    const n = got.reduce((s, p) => s + p.pcm.length, 0);
    if (!n) throw new ProviderError('server', 'The voice sent back no audio.');
    const pcm = new Int16Array(n);
    let at = 0;
    for (const p of got) {
      pcm.set(p.pcm, at);
      at += p.pcm.length;
    }
    return { data: wav.encode(pcm, got[0].rate), mediaType: 'audio/wav' };
  }
}
