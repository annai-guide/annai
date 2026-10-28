import { ProviderError, typeError, portable, sameOrigin, noRedirect, saidWords } from './contract.js';
import { mergePatch } from '../patch.js';
import { levelPatch } from './reasoning.js';
import { NO_USAGE, mergeUsage, costOf } from './cost.js';
import { fromBase64 } from '../bytes.js';
import { sha256Hex } from '../hash.js';
import { UPLOAD_TTL_S, MARGIN_MS } from './uploads.js';
import { deleteTurn, lookTurn, keyPrint } from './kept.js';
import { ttlFor } from '../agent/warmth.js';
import { formatOf } from '../voice/formats.js';
import { SYS_DEVICE, ensureDeviceScope } from '../scopes.js';
import { forget as forgetHistory } from '../forget.js';
import { anySignal } from '../signals.js';

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
 *   citations?: { url: string, title?: string }[], attribution?: Attribution }} Reply
 *   attribution: what the provider asks shown of a grounded reply (G4), beside its parts: no model is sent it
 * @typedef {{ source: string, text: string, links: { url: string, title?: string }[], html?: string }} Attribution
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

/**
 * The model's provider tools this request turns on (spec §9.5): never one that is paid only on a key on the free tier
 * (Google refuses a request with its search at once there). @param {Model} model @param {Request} request @param {{ free?: boolean }} [endpoint]
 */
export function enabledProviderTools(model, request, endpoint) {
  const want = request.providerTools;
  if (!want) return [];
  return (model.providerTools ?? []).filter((t) => want.kinds.includes(t.kind) && !(want.off ?? []).includes(t.id) && !(t.paidOnly && endpoint?.free));
}

const MONTH = '/llm/tool-calls.json';
/** @type {Promise<unknown>} */
let counting = Promise.resolve();

/**
 * Counts n calls of a provider tool with a monthly allowance (G4: Google Search, 5,000 free a month), one count at a time;
 * how many are past it. This device's count, by tool id and calendar month in UTC, in /llm/tool-calls.json in "This device"
 * (no backup carries it, and it keeps no history). An estimate: other devices on the account use the same allowance.
 * @param {import('../workspace.js').Workspace} ws @param {string} id @param {number} n @param {number} free @param {number} [now]
 */
export function billMonth(ws, id, n, free, now = Date.now()) {
  const run = counting.then(async () => {
    const month = new Date(now).toISOString().slice(0, 7);
    const j = await ws.readJSON(SYS_DEVICE, MONTH).catch(() => null);
    const counts = j?.month === month && j.counts && typeof j.counts === 'object' ? { ...j.counts } : {};
    const before = Number(counts[id]) || 0;
    counts[id] = before + n;
    await ensureDeviceScope(ws.store, now);
    await ws.write(SYS_DEVICE, MONTH, { month, counts }, { author: 'system' });
    await forgetHistory(ws.store, SYS_DEVICE, { history: (p) => p === MONTH });
    return Math.max(0, before + n - free) - Math.max(0, before - free);
  });
  counting = run.catch(() => {});
  return run;
}

/**
 * Usage as it is billed: a provider tool with a monthly allowance counts only its calls past it, by this device's count;
 * without one (tally), every call. @param {Usage} usage @param {import('./config.js').ProviderTool[]} tools
 * @param {import('../workspace.js').Workspace} [tally]
 */
async function billed(usage, tools, tally) {
  let out = usage;
  for (const t of tools) {
    const n = t.freePerMonth !== undefined && t.usageKey ? usage.serverTools?.[t.usageKey] ?? 0 : 0;
    if (!n || !tally || !t.usageKey) continue;
    const over = await billMonth(tally, t.id, n, t.freePerMonth ?? 0).catch(() => n);
    out = { ...out, serverTools: { ...out.serverTools, [t.usageKey]: over } };
  }
  return out;
}

/**
 * A conversation's turn kept (G2, kept.js): chain false sends it whole; secret: the provider's key the call has (without one,
 * nothing is kept: it couldn't be deleted); borrow: warm housekeeping, which continues the live chain, records nothing and
 * deletes its own response, so the provider's cache sees the same prefix, and sends and stores nothing when there is no chain.
 * again: the chained call is being tried a second time, after a "not found" that looked up as passing
 * @typedef {{ kept: import('./kept.js').Kept, scope: string, chain: boolean, secret: string | null, borrow?: boolean, again?: boolean }} Keep
 */

/**
 * @param {{ type: EndpointType, endpoint: Endpoint, model: Model, key: string | null, request: Request, level?: string,
 *   fetch?: Fetch, signal?: AbortSignal, firstOutputMs?: number, onEvent?: (e: StreamEvent) => void, trace?: ModelTrace,
 *   registry?: import('../registry.js').Registry, now?: () => number, uploads?: import('./uploads.js').Uploads, keep?: Keep,
 *   tally?: import('../workspace.js').Workspace }} c
 *   firstOutputMs: how long to wait for the first output, and then between pieces of output
 *   uploads: photos go to the provider's files API once, then by id, where the endpoint type can (spec §4.8)
 *   keep: kept on the provider's side where its type can and its switch is on
 *   tally: where this device counts provider tools with a monthly allowance (billMonth)
 * @returns {Promise<Reply>}
 */
export async function callOnce({ type, endpoint, model, key, request, level = 'off', fetch: get = defaultFetch, signal, firstOutputMs = 30_000, onEvent = () => {}, trace, registry, now = Date.now, uploads, keep, tally }) {
  if (key) trace?.secret(key);
  // Credentials can also sit in an endpoint's extra headers; none may reach the trace (spec §9.9).
  for (const [name, value] of Object.entries(endpoint.headers ?? {})) {
    if (/auth|key|token|secret|cookie|session|password/i.test(name)) trace?.secret(String(value).replace(/^(Bearer|Basic)\s+/i, ''));
  }
  const base = type.tail ? request : withTail(request);
  // The cache lifetime this model has, as its warmth counts it (spec §6.4).
  const timed = base.cacheTtl ? { ...base, cacheTtl: ttlFor(model, base.cacheTtl) } : base;
  const tunables = { ...endpoint.tunables, ...model.tunables };
  // Found before the photos are: one in what the kept turn already holds is neither sent nor uploaded.
  let keeping = keep && type.keeps && tunables.keep !== false && keep.secret && !keep.kept.isOff(endpoint.id) ? keep : null;
  const print = keeping ? await keyPrint(keeping.secret, endpoint.baseUrl, endpoint.headers) : '';
  // A record that can't be read is a whole send.
  const matched = keeping?.chain ? await keeping.kept.match(endpoint.id, portable(timed.messages, model.providerId), { scope: keeping.scope, key: print, ...(keeping.borrow ? { borrow: true } : {}), ...(type.keeps?.perModel ? { model: model.providerId } : {}) }).catch(() => null) : null;
  if (keeping?.borrow && !matched) keeping = null;
  // The id OpenAI repeats in an error for a turn it no longer has is not for the trace.
  if (matched) trace?.secret(matched.id);
  /** @type {Awaited<ReturnType<typeof withUploads>>} */
  let uploaded;
  try {
    uploaded = await withUploads(timed, { type, endpoint, model, key, uploads, get, trace, signal, now, from: matched?.from ?? 0 });
  } catch (e) {
    // A stop during an upload is a stop, whether the caller stopped it or its deadline did (only an aborted call's upload throws; any
    // other failure is caught there and sends the photo as bytes): never a failure of the protocol's plugin or the model, which would bench it.
    if (signal?.aborted || /** @type {any} */ (e)?.name === 'AbortError') throw new ProviderError('cancelled', /* en */ 'Stopped.', { cause: e, said: { code: 'kind' } });
    throw e;
  }
  const { request: sent, expires } = uploaded;
  /** @type {CallSpec} */
  const spec = { endpoint, model, key, tunables, request: { ...sent, messages: portable(sent.messages, model.providerId) } };
  if (keeping) {
    spec.keep = true;
    if (matched) spec.kept = matched;
  }
  /** @type {string | null} the turn the provider kept */
  let keptId = null;
  /** Settles once the turn's id is written down (kept.json's pending). @type {Promise<unknown>} */
  let named = Promise.resolve();
  let bytes = 0;
  /**
   * The turn kept, settled: remembered, or deleted now with this call's key (also when it can't be written down); a
   * deletion that fails is queued. @param {(c: any) => Promise<string>} how
   */
  const settle = async (how) => {
    if (!keeping || !keptId) return;
    await named; // its pending record is written first
    const c = { id: keptId, endpoint: endpoint.id, scope: keeping.scope, key: print, days: Number(type.keeps?.days) || 1 };
    try {
      if ((await how(c).catch(() => 'now')) !== 'now') return;
      if ((await deleteTurn({ type, endpoint, key, id: keptId, fetch: get, trace, now }).catch(() => null))?.done) await keeping.kept.done(keptId).catch(() => {});
      else await keeping.kept.wait(c).catch(() => {});
    } finally {
      keeping.kept.ended(keptId); // a drain may take what is still pending
    }
  };
  const started = now();
  const timer = new AbortController();
  const late = () => timer.abort(/* en */ new DOMException('No output in time.', 'TimeoutError'));
  let t = setTimeout(late, firstOutputMs);
  const linked = signal ? anySignal([signal, timer.signal]) : timer.signal;
  /** @type {Part[]} */
  const parts = [];
  /** @type {{ token: string, logprob: number }[] | undefined} */
  let logprobs;
  /** @type {{ url: string, title?: string }[]} */
  const citations = [];
  /** @type {Attribution | undefined} */
  let attribution;
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
      // Not output: the provider named the turn it keeps. Only annai reads it, and writes it down now, in case the page closes first.
      if (keeping && !keptId) {
        keptId = ev.id;
        trace?.secret(ev.id); // an error may repeat it
        named = keeping.kept.pending({ id: ev.id, endpoint: endpoint.id, scope: keeping.scope, key: print, days: Number(type.keeps?.days) || 1 }).catch(() => {});
      }
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
    } else if (ev.type === 'attribution') {
      attribution = { source: ev.source, text: ev.text, links: ev.links, ...(ev.html ? { html: ev.html } : {}) };
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
      const body = JSON.stringify(applyPatches(built.body, endpoint, model, level, enabledProviderTools(model, request, endpoint).map((t) => t.patch)));
      bytes = utf8Length(body); // in the trace: how much a kept turn saves
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
    // What the provider had reported using, and what that costs: a call stopped part-way is billed for it (the second review of
    // phone-fixes-1). Searches it made count all the same.
    const spent = endpoint.free ? usage : await billed(usage, model.providerTools ?? [], tally);
    err.usage = usage;
    err.cost = endpoint.free ? 0 : costOf(spent, model.prices, model.providerTools, started);
    // A failed call's kept turn is deleted. A chained call refused, or whose turn was forgotten, drops its chain and goes once
    // more whole (callRole); forgotten on an unchained call is not-found.
    await settle((c) => /** @type {any} */ (keeping).kept.record(c));
    // A server that ignored the turn it was told to continue keeps nothing from now on (until annai starts again).
    if (keeping && err.noChain) keeping.kept.off(endpoint.id);
    let traced = false;
    // A photo the chain points at that the provider can't find is as good as a chain it forgot.
    if (keeping && spec.kept && (err.kind === 'forgotten' || err.kind === 'bad-request' || err.kind === 'upload' || err.kind === 'image')) {
      // A turn the server lost is dropped; one it still holds (a proxy that dropped the chain) is queued for deletion like the rest.
      const lost = err.kind === 'forgotten' && !err.noChain;
      // One gone within minutes of its chain's first turn may never have been stored (an account with no storage), or the error may be
      // passing: the server is asked whether it has it. Not there: nothing is kept there until annai starts again. There: once more.
      if (lost && type.keeps?.minLife && (await keeping.kept.ageOf(spec.kept.id).catch(() => Infinity)) < type.keeps.minLife) {
        const why = /* en */ 'The server no longer had a conversation annai stored minutes ago, so it is probably not storing for this account (Zero Data Retention): annai keeps nothing there until it starts again, and sends the whole conversation.';
        // The call's own line first, then the look-up it led to; a stop ends the look-up and the retry.
        await trace?.request({ ...info(), outcome: err.kind, error: err.message });
        traced = true;
        const found = await lookTurn({ type, endpoint, key, id: spec.kept.id, fetch: get, signal: linked, trace, now, missing: why }).catch(() => 'unknown');
        if (found === 'there' && !keeping.again && !linked.aborted) {
          err.again = true;
        } else if (found === 'gone') {
          keeping.kept.off(endpoint.id);
          err.message = why;
          err.said = { code: 'zdr' };
          err.shown = saidWords(err.said, err.kind);
        }
      }
      if (!err.again) {
        await keeping.kept.forget(spec.kept.id, lost).catch(() => {});
        err.whole = true;
      }
    } else if (err.kind === 'forgotten') err.kind = 'not-found';
    if (!traced) await trace?.request({ ...info(), outcome: err.kind, error: err.message });
    throw err;
  }
  clearTimeout(t);
  // The turn kept, to continue next time; one refused is deleted, or it would be in every later turn's history.
  // Borrowed (warm housekeeping): nothing is recorded, the response is deleted, and the chain it continued is as it was.
  await settle((c) => (keeping?.borrow || /** @type {StopReason} */ (stop) === 'refusal' ? Promise.resolve('now') : /** @type {any} */ (keeping).kept.record(
    { ...c, messages: spec.request.messages, reply: { role: 'assistant', parts }, hours: Number(type.keeps?.hours) || 0, ...(type.keeps?.perModel ? { model: model.providerId } : {}), ...(expires ? { limit: expires - MARGIN_MS } : {}), ...(spec.kept ? { after: spec.kept.id } : {}) })));
  // A free-tier key costs nothing; a tool's calls within its monthly allowance neither.
  const cost = endpoint.free ? 0 : costOf(await billed(usage, model.providerTools ?? [], tally), model.prices, model.providerTools, started);
  await trace?.request({ ...info(), outcome: 'ok', ...(cost !== undefined ? { cost } : {}) });
  return { parts, text: textOf(parts), usage, cost, stop, model: model.id, citations, ...(logprobs ? { logprobs } : {}), ...(attribution ? { attribution } : {}) };
}

/** A string's length in bytes as UTF-8, without copying it. @param {string} s */
function utf8Length(s) {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80) n += c >= 0x800 && (c < 0xd800 || c > 0xdfff) ? 2 : 1;
  }
  return n;
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
  if (name === 'TimeoutError' || signal.reason?.name === 'TimeoutError') return new ProviderError('timeout', /* en */ 'No output started in time.', { cause: e, said: { code: 'late' } });
  if (name === 'AbortError' || signal.aborted) return new ProviderError('cancelled', /* en */ 'Stopped.', { cause: e, said: { code: 'kind' } });
  // The plugin that registered the type is blamed, never a field the type carries.
  const by = registry?.owner('endpoint-type', type.type)?.pluginId;
  if (by) registry?.fail(by, /* en */ `endpoint type ${type.type}`, e);
  return new ProviderError('plugin', String(/** @type {any} */ (e)?.message ?? e), { cause: e });
}

const EXT = /** @type {Record<string, string>} */ ({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' });

/** Photos' hashes by their data, kept across calls (a conversation sends each again every turn), the latest up to PHOTO_CHARS of data. */
const photoHashes = new Map();
let photoChars = 0;
const PHOTO_CHARS = 24 * 2 ** 20;

/** Forgets every photo's hash, and so its data: a trip removed, or Erase (removing means removing, in memory too). */
export function forgetPhotoHashes() {
  photoHashes.clear();
  photoChars = 0;
}

/** The hash of a photo's bytes, by its base64 data: worked out once while it is sent again and again. @param {string} data */
export async function photoHash(data) {
  const had = photoHashes.get(data);
  if (had) {
    photoHashes.delete(data);
    photoHashes.set(data, had); // the latest go last
    return /** @type {string} */ (had);
  }
  const hash = await sha256Hex(fromBase64(data));
  if (!photoHashes.has(data)) photoChars += data.length; // asked for again while it was being worked out: counted once
  photoHashes.set(data, hash);
  for (const k of photoHashes.keys()) {
    if (photoChars <= PHOTO_CHARS || k === data) break;
    photoHashes.delete(k);
    photoChars -= k.length;
  }
  return hash;
}

/**
 * Photos go by id to an endpoint that stores files (spec §4.8): each is uploaded once, named
 * annai-…, expiring after 48 hours. A failed upload sends the bytes, and stops uploading there
 * until annai restarts.
 * @param {Request} request
 * @param {{ type: EndpointType, endpoint: Endpoint, model: Model, key: string | null, uploads?: import('./uploads.js').Uploads, get: Fetch, trace?: ModelTrace, signal?: AbortSignal, now: () => number, from?: number }} c
 * from: the first message that is sent, the ones before it being held by a kept turn; expires: when the earliest of the photos sent by id expires (0: none)
 * @returns {Promise<{ request: Request, expires: number }>}
 */
async function withUploads(request, { type, endpoint, model, key, uploads, get, trace, signal, now, from = 0 }) {
  if (!uploads || !type.uploadRequest || !type.readUpload || endpoint.tunables?.uploads === false || uploads.isOff(endpoint.id) || !model.input.includes('image')) return { request, expires: 0 };
  /** @type {Map<string, string>} upload ids, by the hash of the bytes uploaded */
  const ids = new Map();
  /** When each photo's upload expires, by the same hash. @type {Map<string, number>} */
  const expiry = new Map();
  /** @type {Map<string, string>} each photo's hash, by its data: the bytes' own, never the hash a part claims (review, 1) */
  const hashes = new Map();
  const hashOf = async (/** @type {string} */ data) => hashes.get(data) ?? hashes.set(data, await photoHash(data)).get(data);
  // Only what is sent is uploaded: a photo in the turns a kept turn already holds is left as it is.
  for (const m of request.messages.slice(from)) {
    for (const p of m.parts) {
      if (p.type !== 'image' || !p.hash || !p.data || uploads.isOff(endpoint.id)) continue;
      const hash = /** @type {string} */ (await hashOf(p.data));
      if (ids.has(hash)) continue;
      const known = await uploads.get(endpoint.id, hash, now());
      if (known) {
        ids.set(hash, known);
        expiry.set(hash, (await uploads.expires?.(endpoint.id, hash)) || 0);
        continue;
      }
      const r = type.uploadRequest({ endpoint, key, tunables: { ...endpoint.tunables, ...model.tunables }, bytes: fromBase64(p.data), mediaType: p.mediaType, name: `annai-${hash.slice(0, 16)}.${EXT[p.mediaType] ?? 'bin'}`, expiresInSeconds: UPLOAD_TTL_S });
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
        const expiresAt = up.expiresAt ?? now() + UPLOAD_TTL_S * 1000;
        await uploads.set(endpoint.id, hash, up.id, expiresAt, now());
        ids.set(hash, up.id);
        expiry.set(hash, expiresAt);
      } catch (e) {
        if (signal?.aborted) throw e;
        if (!traced) await trace?.upload({ endpoint: endpoint.name, url: r.url, status: 0, ms: now() - started, error: String(/** @type {any} */ (e)?.message ?? e) });
        uploads.off(endpoint.id); // photos go as bytes here until annai restarts
      }
    }
  }
  if (!ids.size) return { request, expires: 0 };
  // The earliest expiry of the photos sent by id: a chain that points at them must end before it.
  const times = [...expiry.values()].filter(Boolean);
  const id = (/** @type {any} */ p) => (p.type === 'image' && p.hash && p.data ? ids.get(/** @type {string} */ (hashes.get(p.data))) : undefined);
  return {
    request: { ...request, messages: request.messages.map((m) => ({ role: m.role, parts: m.parts.map((p) => (id(p) ? { ...p, fileId: id(p) } : p)) })) },
    expires: times.length ? Math.min(...times) : 0,
  };
}
