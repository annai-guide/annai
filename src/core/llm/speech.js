import { typeError, sameOrigin, noRedirect } from './contract.js';
import { cannotConnect, asProviderError } from './call.js';
import { speechCost } from './cost.js';
import { pickOut, formatOf } from '../voice/formats.js';

/**
 * Speech calls (spec §9.1, §10): one transcription, or one voice clip, from a speech endpoint type.
 * The type builds the HTTP request and reads the reply; annai sends it with a time limit, reads
 * errors into the same kinds as chat calls (§9.9), and traces it as a net.request with its cost
 * (§2: every request is traceable), with each clip's format and size. Keys never reach the trace (§9.9).
 * A voice whose format is 'auto' is asked for the smallest it offers (audioOut) that the device plays.
 * @typedef {import('./contract.js').EndpointType} EndpointType
 * @typedef {{ data: Uint8Array, mediaType: string }} Clip
 * @param {{ type: EndpointType, endpoint: import('./config.js').Endpoint, model: import('./config.js').Model, key: string | null,
 *   audio?: { data: Uint8Array, mediaType: string, seconds?: number }, text?: string, fetch?: (url: string, init: RequestInit) => Promise<Response>,
 *   signal?: AbortSignal, timeoutMs?: number, trace?: ReturnType<typeof import('./trace.js').modelTrace>, registry?: import('../registry.js').Registry,
 *   now?: () => number, wake?: string, plays?: string[] }} c  audio: transcribe it, with an 'in' type; text: say it, with an 'out' type; plays: what the device plays
 * @returns {Promise<{ text?: string, clip?: Clip, cost: number | undefined, ms: number }>} text from an 'in' type, clip from an 'out' type
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
  const cost = hearing ? speechCost(model.prices, { seconds: c.audio?.seconds }) : speechCost(model.prices, { chars: text.length });
  const started = now();
  let status = 0;
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(new DOMException('No answer in time.', 'TimeoutError')), timeoutMs);
  const signal = c.signal ? AbortSignal.any([c.signal, timer.signal]) : timer.signal;
  /** @param {string} outcome @param {string} [error] */
  const trace = (outcome, error) => c.trace?.request({
    ...(clip ? { format: formatOf(clip.mediaType) ?? clip.mediaType, bytes: clip.data.byteLength } : {}),
    kind: hearing ? 'speech-in' : 'speech-out', endpoint: endpoint.name, model: model.name, providerModel: model.providerId, url: built.url, status,
    ms: now() - started, firstMs: null, outcome, usage: null, ...(error ? { error } : {}), ...(outcome === 'ok' && cost !== undefined ? { cost } : {}),
    ...(c.wake ? { wake: c.wake } : {}), ...(hearing ? { seconds: c.audio?.seconds } : { chars: text.length }),
  });
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
    const out = hearing
      ? { text: String((await /** @type {NonNullable<EndpointType['readTranscript']>} */ (type.readTranscript)(res, spec)).text ?? '').trim() }
      : { clip: (clip = await /** @type {NonNullable<EndpointType['readSpeech']>} */ (type.readSpeech)(res, spec)) };
    await trace('ok');
    return { ...out, cost, ms: now() - started };
  } catch (e) {
    const err = asProviderError(e, signal, type, c.registry);
    await trace(err.kind, err.message);
    throw err;
  } finally {
    clearTimeout(t);
  }
}
