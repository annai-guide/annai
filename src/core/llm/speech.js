import { typeError, sameOrigin, noRedirect, ProviderError } from './contract.js';
import { cannotConnect, asProviderError, sendCut, watched, typeWorked } from './call.js';
import { sendMs } from './uploads.js';
import { speechCost } from './cost.js';
import { pickOut, formatOf } from '../voice/formats.js';
import { anySignal } from '../signals.js';

/** A piece of a voice's stream that a player can take: 16-bit PCM at a finite rate. @param {any} p */
const playable = (p) => p?.pcm instanceof Int16Array && Number.isFinite(p.rate);

/**
 * Speech calls (spec §9.1, §10): one transcription, or one voice clip, from a speech endpoint type. The type builds the HTTP request and
 * reads the reply; annai sends it with a time limit, reads errors into the same kinds as chat calls (§9.9), and traces it as a net.request
 * with its cost, with each clip's format and size. Keys never reach the trace (§9.9). A voice whose format is 'auto' is asked for the
 * smallest it offers (audioOut) that the device plays. A voice that streams (readSpeechStream, its stream tunable not off), asked for a
 * stream, gives its PCM as it comes: the call resolves at the first piece, which must come within the time limit, as a whole clip must;
 * then no gap may be longer. The time limit (a transcription's 15 s, a voice's 10 s, unless the role says: service.js) starts once the
 * provider has the whole request, as a model's wait does (call.js): until its answer's headers come, it is longer by the request's time at
 * SLOW_UPLINK, so a recording going up slowly isn't cut, twice that when shared (a half's turn's transcription, as its model's send is). A
 * recording that got no headers in that time fails as a cut send (call.js's sendCut, as a photo's request does), which rests its model
 * only once another model heard the recording (voice.js). It is traced once all of it is in, or when it fails.
 * @typedef {import('./contract.js').EndpointType} EndpointType
 * @typedef {{ data: Uint8Array, mediaType: string }} Clip
 * @typedef {import('./contract.js').SpeechStream} SpeechStream
 * @param {{ type: EndpointType, endpoint: import('./config.js').Endpoint, model: import('./config.js').Model, key: string | null,
 *   audio?: { data: Uint8Array, mediaType: string, seconds?: number }, text?: string, fetch?: (url: string, init: RequestInit) => Promise<Response>,
 *   signal?: AbortSignal, timeoutMs?: number, trace?: ReturnType<typeof import('./trace.js').modelTrace>, registry?: import('../registry.js').Registry,
 *   now?: () => number, wake?: string, plays?: string[], stream?: boolean, unstyled?: boolean, languages?: import('./contract.js').Languages, shared?: boolean,
 *   ability?: import('./config.js').Ability, onEvent?: (e: import('./contract.js').StreamEvent) => void }} c  audio: transcribe it, with an 'in' type; text: say it, with an 'out' type; ability: the endpoint's, for its name where the address is wrong;
 *   onEvent: told `sending` on and off around a recording's send (the dock's Sending…, as callOnce tells it);
 *   plays: what the device plays; stream: the caller plays a stream; unstyled: send no style (a server refused it); languages: what the user speaks, for a
 *   transcription's language hint: a voice is given none, the voice APIs called here take none (a multilingual voice follows the text; one made for one language reads everything in it)
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
  if (c.unstyled) spec.tunables.styled = false; // the server refused the style (voice.js): none this time
  if (!hearing && spec.tunables.format === 'auto') spec.tunables.format = pickOut([].concat(spec.tunables.audioOut ?? []), c.plays ?? ['mp3', 'wav']) ?? 'mp3';
  /** @type {{ data: Uint8Array, mediaType: string } | undefined} */
  let clip = c.audio;
  /** @type {number | undefined} */
  let cost;
  let url = `${type.type}:`;
  /** The reply's failed read (call.js watched). @type {() => unknown} */
  let dropped = () => undefined;
  const started = now();
  let status = 0;
  const streams = !hearing && c.stream === true && typeof type.readSpeechStream === 'function' && spec.tunables.stream !== false;
  /** @type {number | null} */
  let firstMs = null;
  const timer = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let t;
  /** The time limit, from now: to the first piece, or from one piece to the next; ms: while the request goes up. @param {string} why @param {number} [ms] */
  const limit = (why, ms = timeoutMs) => {
    clearTimeout(t);
    t = setTimeout(() => timer.abort(new DOMException(why, 'TimeoutError')), ms);
  };
  let sending = 0; // the time the request has, until the answer's headers
  /** The dock's Sending… is on (spec §16.3): a recording's request, from just before its POST until its send ends (`sendOver`), as callOnce says it. */
  let up = false;
  const sendOver = () => {
    if (!up) return;
    up = false;
    c.onEvent?.({ type: 'sending', on: false });
  };
  const signal = c.signal ? anySignal([c.signal, timer.signal]) : timer.signal;
  /** A stream's format and size so far. @type {{ format: string, bytes: number } | null} */
  let sound = null;
  /** @param {string} outcome @param {string} [error] */
  const trace = (outcome, error) => c.trace?.request({
    ...(clip ? { format: formatOf(clip.mediaType) ?? clip.mediaType, bytes: clip.data.byteLength } : sound ?? {}),
    kind: hearing ? 'speech-in' : 'speech-out', endpoint: endpoint.name, model: model.name, providerModel: model.providerId, url, status,
    ms: now() - started, firstMs, outcome, usage: null, ...(error ? { error } : {}), ...(outcome === 'ok' && cost !== undefined ? { cost } : {}),
    ...(c.wake ? { wake: c.wake } : {}), ...(hearing ? { seconds: c.audio?.seconds } : { chars: text.length }),
  });
  /** @param {unknown} e */
  const failed = async (e) => {
    let err = asProviderError(e, signal, type, c.registry, dropped());
    // A voice that started, then stalled: what it was, as it is made (the said its words come from), never a message patched after.
    if (err.said?.code === 'late' && firstMs !== null) err = new ProviderError('timeout', /* en */ 'The voice stopped arriving for longer than annai waits.', { cause: e, said: { code: 'stalled' } });
    // A recording that never went up in its send's time, as a photo's request does (call.js): likelier the link than the model. A voice's text is small: late.
    if (hearing && sending && err.said?.code === 'late') err = sendCut(e, sending);
    await trace(err.kind, err.message);
    return err;
  };
  let handed = false;
  try {
    // From the request's build on, what the type's code throws is classified (asProviderError), and a builder gets only an address that parses.
    sameOrigin(endpoint, endpoint.baseUrl, c.ability);
    const built = hearing
      ? /** @type {NonNullable<EndpointType['transcribeRequest']>} */ (type.transcribeRequest)({ ...spec, audio: /** @type {{ data: Uint8Array, mediaType: string }} */ (c.audio), ...(c.languages ? { languages: c.languages } : {}) })
      : /** @type {NonNullable<EndpointType['speechRequest']>} */ (type.speechRequest)({ ...spec, text });
    url = built.url;
    cost = endpoint.free ? 0 : hearing ? speechCost(model.prices, { seconds: c.audio?.seconds, at: started }) : speechCost(model.prices, { chars: text.length + (type.extraChars?.(spec) ?? 0), at: started });
    // The request's bytes: at least the recording's, more as base64 in JSON (a string body). `sending` is that time until the headers come.
    sending = timeoutMs + sendMs(Math.max(c.audio?.data.byteLength ?? 0, typeof built.body === 'string' ? built.body.length : 0), c.shared);
    limit(/* en */ 'No answer in time.', sending);
    /** @type {Response} */
    let res;
    sameOrigin(endpoint, built.url, c.ability); // the key goes only to the ability's address
    up = hearing;
    if (up) c.onEvent?.({ type: 'sending', on: true });
    try {
      res = await (c.fetch ?? ((url, init) => fetch(url, init)))(built.url, { method: 'POST', headers: built.headers, body: built.body, signal, redirect: 'manual' });
    } catch (e) {
      throw cannotConnect(e, signal);
    }
    sending = 0;
    sendOver(); // the provider has the recording
    limit(/* en */ 'No answer in time.'); // the provider has the request
    status = res.status;
    noRedirect(res, endpoint);
    const reply = watched(res);
    dropped = reply.dropped;
    if (!res.ok) throw typeError(type, res.status, await reply.res.text().catch(() => ''), res.headers);
    res = reply.res;
    if (streams) {
      const pieces = /** @type {NonNullable<EndpointType['readSpeechStream']>} */ (type.readSpeechStream)(res, spec)[Symbol.asyncIterator]();
      const first = await pieces.next();
      if (first.done) throw new ProviderError('server', /* en */ 'The voice sent back no audio.');
      if (!playable(first.value) || !(first.value.rate >= 3000)) throw new ProviderError('server', /* en */ 'The voice sent no sound annai can play.');
      firstMs = now() - started;
      handed = true;
      return { stream: { rate: first.value.rate, chunks: rest(first.value, pieces) }, cost, ms: now() - started };
    }
    const out = hearing
      ? { text: String((await /** @type {NonNullable<EndpointType['readTranscript']>} */ (type.readTranscript)(res, spec)).text ?? '').trim() }
      : { clip: (clip = await /** @type {NonNullable<EndpointType['readSpeech']>} */ (type.readSpeech)(res, spec)) };
    typeWorked(type, c.registry);
    await trace('ok');
    return { ...out, cost, ms: now() - started };
  } catch (e) {
    sendOver(); // a send that failed (cut, stopped, no connection) is over, before the next try or the card
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
    sound = { format: /* en */ `streamed PCM at ${head.rate / 1000} kHz`, bytes: head.pcm.byteLength };
    let settled = false;
    try {
      yield head.pcm;
      for (;;) {
        limit(/* en */ 'The voice stopped arriving.');
        const next = await pieces.next();
        clearTimeout(t);
        if (next.done) break;
        if (!playable(next.value)) throw new ProviderError('server', /* en */ 'The voice sent no sound annai can play.');
        sound.bytes += next.value.pcm.byteLength;
        yield next.value.pcm;
      }
      settled = true;
      typeWorked(type, c.registry);
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
