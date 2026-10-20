import { ProviderError, typeError, portable, sameOrigin, noRedirect } from './contract.js';
import { mergePatch } from '../patch.js';
import { levelPatch } from './reasoning.js';
import { NO_USAGE, mergeUsage, costOf } from './cost.js';
import { fromBase64 } from '../bytes.js';
import { UPLOAD_TTL_S } from './uploads.js';
import { ttlFor } from '../agent/warmth.js';
import { formatOf } from '../voice/formats.js';

/**
 * One model call (spec §9.1): the endpoint type builds the request, annai merges in the
 * endpoint's and the model's extra fields and the reasoning level, sends it, and puts the
 * streamed reply together. It never falls back; callRole does that (§9.6).
 * @typedef {import('./contract.js').EndpointType} EndpointType
 * @typedef {import('./contract.js').CallSpec} CallSpec
 * @typedef {import('./contract.js').Request} Request
 * @typedef {import('./contract.js').Part} Part
 * @typedef {import('./contract.js').Usage} Usage
 * @typedef {import('./contract.js').StreamEvent} StreamEvent
 * @typedef {import('./contract.js').StopReason} StopReason
 * @typedef {import('./config.js').Endpoint} Endpoint
 * @typedef {import('./config.js').Model} Model
 * @typedef {ReturnType<typeof import('./trace.js').modelTrace>} ModelTrace
 * @typedef {{ parts: Part[], text: string, usage: Usage, cost: number | undefined, stop: StopReason, model: string, logprobs?: { token: string, logprob: number }[],
 *   citations?: { url: string, title?: string }[] }} Reply
 * @typedef {(url: string, init: RequestInit) => Promise<Response>} Fetch
 */

const defaultFetch = /** @type {Fetch} */ ((url, init) => fetch(url, init));

/**
 * The request with its tail as the last text of the final user message (or a user message of its
 * own), for endpoint types that don't place it themselves.
 * @param {Request} request @returns {Request}
 */
export function withTail(request) {
  if (!request.tail) return request;
  const { tail, ...rest } = request;
  const messages = request.messages.slice();
  const last = messages.at(-1);
  if (last?.role === 'user') messages[messages.length - 1] = { role: 'user', parts: [...last.parts, { type: 'text', text: tail }] };
  else messages.push({ role: 'user', parts: [{ type: 'text', text: tail }] });
  return { ...rest, messages };
}

/**
 * The body with the endpoint's extra fields, then the model's, then the reasoning level's patch
 * merged in (spec §9.2–9.4; a key ending in "+" appends to an array).
 * @param {any} body @param {Endpoint} endpoint @param {Model} model @param {string} level
 */
export function applyPatches(body, endpoint, model, level, extra = []) {
  let out = mergePatch(body, endpoint.extraBody ?? {}, { append: true });
  out = mergePatch(out, model.extraBody ?? {}, { append: true });
  const r = levelPatch(model.reasoning, level);
  if (r) out = mergePatch(out, r, { append: true });
  for (const p of extra) out = mergePatch(out, p, { append: true });
  return out;
}

/** The model's provider tools this request turns on (spec §9.5). @param {Model} model @param {Request} request */
export function enabledProviderTools(model, request) {
  const want = request.providerTools;
  if (!want) return [];
  return (model.providerTools ?? []).filter((t) => want.kinds.includes(t.kind) && !(want.off ?? []).includes(t.id));
}

/**
 * How a conversation's own turn is kept on the provider's side (G2): kept, the turns remembered; scope, the conversation's;
 * chain false sends it whole all the same (the provider forgot the turn it continued).
 * @typedef {{ kept: import('./kept.js').Kept, scope: string, chain: boolean }} Keep
 */

/**
 * @param {{ type: EndpointType, endpoint: Endpoint, model: Model, key: string | null, request: Request, level?: string,
 *   fetch?: Fetch, signal?: AbortSignal, firstOutputMs?: number, onEvent?: (e: StreamEvent) => void, trace?: ModelTrace,
 *   registry?: import('../registry.js').Registry, now?: () => number, uploads?: import('./uploads.js').Uploads, keep?: Keep }} c
 *   firstOutputMs: how long to wait for the first output, and then between pieces of output
 *   uploads: photos go to the provider's files API once, then by id, where the endpoint type can (spec §4.8)
 *   keep: the turn is kept on the provider's side where its type can and its ability's keep switch is on, and continues one kept
 * @returns {Promise<Reply>}
 */
export async function callOnce({ type, endpoint, model, key, request, level = 'off', fetch: get = defaultFetch, signal, firstOutputMs = 30_000, onEvent = () => {}, trace, registry, now = Date.now, uploads, keep }) {
  if (key) trace?.secret(key);
  // Credentials can also sit in an endpoint's extra headers; none may reach the trace (spec §9.9).
  for (const [name, value] of Object.entries(endpoint.headers ?? {})) {
    if (/auth|key|token|secret|cookie|session|password/i.test(name)) trace?.secret(String(value).replace(/^(Bearer|Basic)\s+/i, ''));
  }
  const sent = await withUploads(type.tail ? request : withTail(request), { type, endpoint, model, key, uploads, get, trace, signal, now });
  // The cache lifetime this model has, as its warmth counts it (spec §6.4).
  const req = sent.cacheTtl ? { ...sent, cacheTtl: ttlFor(model, sent.cacheTtl) } : sent;
  /** @type {CallSpec} */
  const spec = { endpoint, model, key, tunables: { ...endpoint.tunables, ...model.tunables }, request: { ...req, messages: portable(req.messages, model.providerId) } };
  // Kept on the provider's side (G2): a free key's turns for a day, else the ability's keepDays.
  const keeping = keep && type.keeps && spec.tunables.keep !== false ? keep : null;
  const days = endpoint.free ? 1 : Number(spec.tunables.keepDays) > 0 ? Number(spec.tunables.keepDays) : 1;
  if (keeping) {
    spec.keep = true;
    // A record that can't be read is a whole send.
    spec.kept = keeping.chain ? await keeping.kept.match(endpoint.id, spec.request.messages, { free: Boolean(endpoint.free), keepDays: days, scope: keeping.scope }).catch(() => null) : null;
  }
  /** @type {string | null} the turn the provider kept */
  let keptId = null;
  let bytes = 0;
  const started = now();
  const timer = new AbortController();
  const late = () => timer.abort(new DOMException('No output in time.', 'TimeoutError'));
  let t = setTimeout(late, firstOutputMs);
  const linked = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  /** @type {Part[]} */
  const parts = [];
  /** @type {{ token: string, logprob: number }[] | undefined} */
  let logprobs;
  /** @type {{ url: string, title?: string }[]} */
  const citations = [];
  /** @type {Usage} */
  let usage = { ...NO_USAGE };
  /** @type {StopReason} */
  let stop = 'end';
  /** @type {number | null} */
  let firstMs = null;
  let status = 0;
  let url = `${type.type}:`;
  /** @param {StreamEvent} ev */
  const take = (ev) => {
    if (ev.type === 'kept') {
      // Not output: the provider named the turn it keeps. Only annai reads it.
      if (keeping) keptId = ev.id;
      return;
    }
    clearTimeout(t);
    t = setTimeout(late, firstOutputMs);
    if (firstMs === null && ev.type !== 'usage') firstMs = now() - started;
    if (ev.type === 'text') {
      const last = parts.at(-1);
      if (last?.type === 'text') last.text += ev.text;
      else parts.push({ type: 'text', text: ev.text });
    } else if (ev.type === 'reasoning') {
      parts.push({ type: 'reasoning', text: ev.text, ...(ev.signature ? { signature: ev.signature } : {}), ...(ev.redacted ? { redacted: ev.redacted } : {}), model: model.providerId });
    } else if (ev.type === 'tool_call') {
      // What the provider wrote on the call to have back (Gemini 3's thought signature) goes back only to this model.
      parts.push({ type: 'tool_call', id: ev.id, name: ev.name, input: ev.input, ...(ev.extra !== undefined ? { extra: ev.extra, model: model.providerId } : {}) });
    } else if (ev.type === 'provider') {
      parts.push({ type: 'provider', block: ev.block, model: model.providerId });
    } else if (ev.type === 'citation') {
      if (ev.url && !citations.some((c) => c.url === ev.url)) citations.push({ url: ev.url, ...(ev.title ? { title: ev.title } : {}) });
    } else if (ev.type === 'logprobs') {
      logprobs = ev.top;
    } else if (ev.type === 'usage') {
      usage = mergeUsage(usage, ev.usage);
    } else if (ev.type === 'stop') {
      stop = ev.reason;
    }
    onEvent(ev);
  };
  // Heard speech sent as audio: each clip's format and size (spec §10.6).
  const audio = request.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'audio' ? [{ format: formatOf(p.mediaType) ?? p.mediaType, bytes: Math.floor((p.data.length * 3) / 4) - (p.data.match(/=*$/)?.[0].length ?? 0) }] : [])));
  const info = () => ({
    endpoint: endpoint.name, model: model.name, providerModel: model.providerId, url, status, ms: now() - started, firstMs, usage, ...(audio.length ? { audio } : {}),
    ...(spec.kept ? { kept: { from: spec.kept.from } } : {}), ...(bytes ? { bytes } : {}),
  });
  try {
    if (type.run) {
      for await (const ev of untilAborted(type.run({ ...spec, signal: linked }), linked)) take(ev);
    } else {
      const built = /** @type {NonNullable<EndpointType['build']>} */ (type.build)(spec);
      url = built.url;
      sameOrigin(endpoint, built.url); // the key goes only to the ability's address
      /** @type {Response} */
      let res;
      const body = JSON.stringify(applyPatches(built.body, endpoint, model, level, enabledProviderTools(model, request).map((t) => t.patch)));
      bytes = body.length; // in the trace: how much a kept turn saves
      try {
        res = await get(built.url, { method: 'POST', headers: built.headers, body, signal: linked, redirect: 'manual' });
      } catch (e) {
        throw cannotConnect(e, linked);
      }
      status = res.status;
      noRedirect(res, endpoint);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // An error response that is the model declining (Gemini's safety block) is an answer: it ends the turn, as any refusal does.
        const declined = type.refusal?.(res.status, text, spec);
        if (typeof declined !== 'string' || !declined) throw typeError(type, res.status, text, res.headers);
        take({ type: 'text', text: declined });
        take({ type: 'stop', reason: 'refusal' });
      } else {
        for await (const ev of untilAborted(/** @type {NonNullable<EndpointType['read']>} */ (type.read)(res, spec), linked)) take(ev);
      }
    }
  } catch (e) {
    clearTimeout(t);
    const err = asProviderError(e, linked, type, registry);
    if (!err.partial) err.partial = textOf(parts); // what it said before it stopped: kept, and continued after a cut-off
    // A turn the provider kept for a call that failed is deleted (spec §4.9); one it forgot goes with its chain. Forgotten
    // means something only when the call continued a kept turn: else the provider doesn't know the model or address.
    if (keeping && keptId) await keeping.kept.discard(keptId, endpoint.id, days).catch((x) => console.warn("a kept turn couldn't be queued for deletion", x));
    if (err.kind === 'forgotten') {
      if (keeping && spec.kept) await keeping.kept.forget(spec.kept.id).catch(() => {});
      else err.kind = 'not-found';
    }
    await trace?.request({ ...info(), outcome: err.kind, error: err.message });
    throw err;
  }
  clearTimeout(t);
  if (keeping && keptId) {
    // The turn the provider kept, to continue next time: fingerprints of what was sent, never what was.
    await keeping.kept.record({ id: keptId, endpoint: endpoint.id, model: model.providerId, scope: keeping.scope, messages: spec.request.messages, reply: { role: 'assistant', parts }, days, ...(spec.kept ? { after: spec.kept.id } : {}) })
      .catch((x) => console.warn("a kept turn couldn't be recorded", x));
  }
  const cost = endpoint.free ? 0 : costOf(usage, model.prices, model.providerTools); // a free-tier key costs nothing
  await trace?.request({ ...info(), outcome: 'ok', ...(cost !== undefined ? { cost } : {}) });
  return { parts, text: textOf(parts), usage, cost, stop, model: model.id, citations, ...(logprobs ? { logprobs } : {}) };
}

/** @param {Part[]} parts */
function textOf(parts) {
  return parts.filter((p) => p.type === 'text').map((p) => /** @type {any} */ (p).text).join('');
}

/**
 * The events of an async iterable until the signal aborts, even if the iterable is stuck waiting.
 * @template T @param {AsyncIterable<T>} iterable @param {AbortSignal} signal @returns {AsyncGenerator<T>}
 */
async function* untilAborted(iterable, signal) {
  const it = iterable[Symbol.asyncIterator]();
  /** @type {Promise<never>} */
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const r = await Promise.race([it.next(), aborted]);
      if (r.done) return;
      yield r.value;
    }
  } finally {
    // Don't wait: a generator stuck in an await would never answer.
    it.return?.()?.catch(() => {});
  }
}

/** A failed fetch: an abort stays an abort; anything else means annai couldn't reach the endpoint. @param {unknown} e @param {AbortSignal} signal */
export function cannotConnect(e, signal) {
  const name = /** @type {any} */ (e)?.name;
  if (signal.aborted || name === 'AbortError' || name === 'TimeoutError') return e;
  return new ProviderError('unreachable', String(/** @type {any} */ (e)?.message ?? e), { cause: e });
}

/**
 * Whatever went wrong, as a ProviderError. Running out of time is "timeout", the caller stopping
 * is "cancelled", and any other error from the endpoint type's code is a bug in its plugin, which
 * counts against the plugin (spec §5.5).
 * @param {unknown} e @param {AbortSignal} signal @param {EndpointType} type @param {import('../registry.js').Registry} [registry]
 */
export function asProviderError(e, signal, type, registry) {
  if (e instanceof ProviderError) return e;
  const name = /** @type {any} */ (e)?.name;
  if (name === 'TimeoutError' || signal.reason?.name === 'TimeoutError') return new ProviderError('timeout', 'No output started in time.', { cause: e });
  if (name === 'AbortError' || signal.aborted) return new ProviderError('cancelled', 'Stopped.', { cause: e });
  // The plugin that registered the type is blamed, never a field the type carries.
  const by = registry?.owner('endpoint-type', type.type)?.pluginId;
  if (by) registry?.fail(by, `endpoint type ${type.type}`, e);
  return new ProviderError('plugin', String(/** @type {any} */ (e)?.message ?? e), { cause: e });
}

const EXT = /** @type {Record<string, string>} */ ({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' });

/**
 * Photos go by id to an endpoint that stores files (spec §4.8): each is uploaded once, named
 * annai-…, expiring after 48 hours. A failed upload sends the bytes, and stops uploading there
 * until annai restarts.
 * @param {Request} request
 * @param {{ type: EndpointType, endpoint: Endpoint, model: Model, key: string | null, uploads?: import('./uploads.js').Uploads, get: Fetch, trace?: ModelTrace, signal?: AbortSignal, now: () => number }} c
 * @returns {Promise<Request>}
 */
async function withUploads(request, { type, endpoint, model, key, uploads, get, trace, signal, now }) {
  if (!uploads || !type.uploadRequest || !type.readUpload || endpoint.tunables?.uploads === false || uploads.isOff(endpoint.id) || !model.input.includes('image')) return request;
  /** @type {Map<string, string>} */
  const ids = new Map();
  for (const m of request.messages) {
    for (const p of m.parts) {
      if (p.type !== 'image' || !p.hash || !p.data || ids.has(p.hash) || uploads.isOff(endpoint.id)) continue;
      const known = await uploads.get(endpoint.id, p.hash, now());
      if (known) {
        ids.set(p.hash, known);
        continue;
      }
      const r = type.uploadRequest({ endpoint, key, tunables: { ...endpoint.tunables, ...model.tunables }, bytes: fromBase64(p.data), mediaType: p.mediaType, name: `annai-${p.hash.slice(0, 16)}.${EXT[p.mediaType] ?? 'bin'}`, expiresInSeconds: UPLOAD_TTL_S });
      const started = now();
      let traced = false;
      try {
        sameOrigin(endpoint, r.url); // elsewhere: never sent, and the photo goes in the request
        const res = await get(r.url, { method: 'POST', headers: r.headers, body: r.body, signal, redirect: 'manual' });
        traced = true;
        await trace?.upload({ endpoint: endpoint.name, url: r.url, status: res.status, ms: now() - started, ...(res.ok ? {} : { error: (await res.text().catch(() => '')).slice(0, 300) }) });
        noRedirect(res, endpoint);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const up = type.readUpload(await res.json());
        await uploads.set(endpoint.id, p.hash, up.id, up.expiresAt ?? now() + UPLOAD_TTL_S * 1000, now());
        ids.set(p.hash, up.id);
      } catch (e) {
        if (signal?.aborted) throw e;
        if (!traced) await trace?.upload({ endpoint: endpoint.name, url: r.url, status: 0, ms: now() - started, error: String(/** @type {any} */ (e)?.message ?? e) });
        uploads.off(endpoint.id); // photos go as bytes here until annai restarts
      }
    }
  }
  if (!ids.size) return request;
  return { ...request, messages: request.messages.map((m) => ({ role: m.role, parts: m.parts.map((p) => (p.type === 'image' && p.hash && ids.has(p.hash) ? { ...p, fileId: ids.get(p.hash) } : p)) })) };
}
