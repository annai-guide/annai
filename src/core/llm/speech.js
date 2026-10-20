import { typeError, sameOrigin, noRedirect, ProviderError } from './contract.js';
import { cannotConnect, asProviderError } from './call.js';
import { speechCost } from './cost.js';
import { pickOut, formatOf } from '../voice/formats.js';

/** A piece of a voice's stream that a player can take: 16-bit PCM at a finite rate (fix pass). @param {any} p */
const playable = (p) => p?.pcm instanceof Int16Array && Number.isFinite(p.rate);

/**
 * Speech calls (spec §9.1, §10): one transcription, or one voice clip, from a speech endpoint type.
 * The type builds the HTTP request and reads the reply; annai sends it with a time limit, reads
 * errors into the same kinds as chat calls (§9.9), and traces it as a net.request with its cost
 * (§2: every request is traceable), with each clip's format and size. Keys never reach the trace (§9.9).
 * A voice whose format is 'auto' is asked for the smallest it offers (audioOut) that the device plays.
 * A voice that streams (readSpeechStream, its stream tunable not off), asked for a stream, gives its PCM
 * as it comes (G3): the call resolves at the first piece, which must come within the time limit, as a
 * whole clip must; then no gap may be longer. It is traced once all of it is in, or when it fails.
 * @typedef {import('./contract.js').EndpointType} EndpointType
 * @typedef {{ data: Uint8Array, mediaType: string }} Clip
 * @typedef {import('./contract.js').SpeechStream} SpeechStream
 * @param {{ type: EndpointType, endpoint: import('./config.js').Endpoint, model: import('./config.js').Model, key: string | null,
 *   audio?: { data: Uint8Array, mediaType: string, seconds?: number }, text?: string, fetch?: (url: string, init: RequestInit) => Promise<Response>,
 *   signal?: AbortSignal, timeoutMs?: number, trace?: ReturnType<typeof import('./trace.js').modelTrace>, registry?: import('../registry.js').Registry,
 *   now?: () => number, wake?: string, plays?: string[], stream?: boolean }} c  audio: transcribe it, with an 'in' type; text: say it, with an 'out' type;
 *   plays: what the device plays; stream: the caller plays a stream
 * @returns {Promise<{ text?: string, clip?: Clip, stream?: SpeechStream, cost: number | undefined, ms: number }>} text from an 'in' type, a clip or a stream from an 'out' type
 */
export async function speechCall(c) {
  const { type, endpoint, model, key, now = Date.now, timeoutMs = 15_000 } = c;
  const hearing = Boolean(c.audio);
  const text = c.text ?? '';
  if (key) c.trace?.secret(key);
  // Credentials can also sit in an endpoint's extra headers.
  for (const [name, value] of Object.entries(endpoint.headers ?? {})) {
    if (/auth|key|token|secret|cookie|session|password/i.test(name)) c.trace?.secret(String(value).replace(/^(Bearer|Basic)\s+/i, ''));
  }
  const spec = { endpoint, model, key, tunables: { ...endpoint.tunables, ...model.tunables } };
  if (!hearing && spec.tunables.format === 'auto') spec.tunables.format = pickOut([].concat(spec.tunables.audioOut ?? []), c.plays ?? ['mp3', 'wav']) ?? 'mp3';
  /** @type {{ data: Uint8Array, mediaType: string } | undefined} */
  let clip = c.audio;
  const built = hearing
    ? /** @type {NonNullable<EndpointType['transcribeRequest']>} */ (type.transcribeRequest)({ ...spec, audio: /** @type {{ data: Uint8Array, mediaType: string }} */ (c.audio) })
    : /** @type {NonNullable<EndpointType['speechRequest']>} */ (type.speechRequest)({ ...spec, text });
  const cost = endpoint.free ? 0 : hearing ? speechCost(model.prices, { seconds: c.audio?.seconds }) : speechCost(model.prices, { chars: text.length });
  const started = now();
  let status = 0;
  const streams = !hearing && c.stream === true && typeof type.readSpeechStream === 'function' && spec.tunables.stream !== false;
  /** @type {number | null} */
  let firstMs = null;
  const timer = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let t;
  /** The time limit, from now: to the first piece, or from one piece to the next. @param {string} why */
  const limit = (why) => {
    clearTimeout(t);
    t = setTimeout(() => timer.abort(new DOMException(why, 'TimeoutError')), timeoutMs);
  };
  limit('No answer in time.');
  const signal = c.signal ? AbortSignal.any([c.signal, timer.signal]) : timer.signal;
  /** A stream's format and size so far. @type {{ format: string, bytes: number } | null} */
  let sound = null;
  /** @param {string} outcome @param {string} [error] */
  const trace = (outcome, error) => c.trace?.request({
    ...(clip ? { format: formatOf(clip.mediaType) ?? clip.mediaType, bytes: clip.data.byteLength } : sound ?? {}),
    kind: hearing ? 'speech-in' : 'speech-out', endpoint: endpoint.name, model: model.name, providerModel: model.providerId, url: built.url, status,
    ms: now() - started, firstMs, outcome, usage: null, ...(error ? { error } : {}), ...(outcome === 'ok' && cost !== undefined ? { cost } : {}),
    ...(c.wake ? { wake: c.wake } : {}), ...(hearing ? { seconds: c.audio?.seconds } : { chars: text.length }),
  });
  /** @param {unknown} e */
  const failed = async (e) => {
    const err = asProviderError(e, signal, type, c.registry);
    if (err.kind === 'timeout' && firstMs !== null) err.message = 'The voice stopped arriving for longer than its wait.';
    await trace(err.kind, err.message);
    return err;
  };
  let handed = false;
  try {
    /** @type {Response} */
    let res;
    sameOrigin(endpoint, built.url); // the key goes only to the ability's address
    try {
      res = await (c.fetch ?? ((url, init) => fetch(url, init)))(built.url, { method: 'POST', headers: built.headers, body: built.body, signal, redirect: 'manual' });
    } catch (e) {
      throw cannotConnect(e, signal);
    }
    status = res.status;
    noRedirect(res, endpoint);
    if (!res.ok) {
      throw typeError(type, res.status, await res.text().catch(() => ''), res.headers);
    }
    if (streams) {
      const pieces = /** @type {NonNullable<EndpointType['readSpeechStream']>} */ (type.readSpeechStream)(res, spec)[Symbol.asyncIterator]();
      const first = await pieces.next();
      if (first.done) throw new ProviderError('server', 'The voice sent back no audio.');
      if (!playable(first.value) || !(first.value.rate >= 3000)) throw new ProviderError('server', 'The voice sent no sound annai can play.');
      firstMs = now() - started;
      handed = true;
      return { stream: { rate: first.value.rate, chunks: rest(first.value, pieces) }, cost, ms: now() - started };
    }
    const out = hearing
      ? { text: String((await /** @type {NonNullable<EndpointType['readTranscript']>} */ (type.readTranscript)(res, spec)).text ?? '').trim() }
      : { clip: (clip = await /** @type {NonNullable<EndpointType['readSpeech']>} */ (type.readSpeech)(res, spec)) };
    await trace('ok');
    return { ...out, cost, ms: now() - started };
  } catch (e) {
    throw await failed(e);
  } finally {
    if (!handed) clearTimeout(t);
  }

  /**
   * The stream's pieces, the first already in: each next one within the time limit. Traced at its end, with
   * its size as 16-bit PCM; a caller that stops reading early stops the reply, traced as cancelled.
   * @param {{ pcm: Int16Array, rate: number }} head @param {AsyncIterator<{ pcm: Int16Array, rate: number }>} pieces @returns {AsyncGenerator<Int16Array>}
   */
  async function* rest(head, pieces) {
    sound = { format: `streamed PCM at ${head.rate / 1000} kHz`, bytes: head.pcm.byteLength };
    let settled = false;
    try {
      yield head.pcm;
      for (;;) {
        limit('The voice stopped arriving.');
        const next = await pieces.next();
        clearTimeout(t);
        if (next.done) break;
        if (!playable(next.value)) throw new ProviderError('server', 'The voice sent no sound annai can play.');
        sound.bytes += next.value.pcm.byteLength;
        yield next.value.pcm;
      }
      settled = true;
      await trace('ok');
    } catch (e) {
      settled = true;
      throw await failed(e);
    } finally {
      clearTimeout(t);
      if (!settled) {
        await trace('cancelled');
        await pieces.return?.();
      }
    }
  }
}
