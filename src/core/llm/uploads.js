import { SYS_SETTINGS } from '../scopes.js';
import { sameOrigin, noRedirect } from './contract.js';

/**
 * Photos uploaded to a provider's files API (spec §4.8): each request copy once, by endpoint
 * ("<provider>/<ability>", since file ids belong to one protocol's files API).
 * Every upload is used for 48 hours; an id within an hour of that is uploaded again. Where the provider keeps
 * files until they are deleted, annai deletes its own after 48 hours, from the provider's own list (sweepUploads).
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {import('./contract.js').EndpointType} EndpointType
 * @typedef {import('./config.js').Endpoint} Endpoint
 */

export const UPLOAD_TTL_S = 172_800;
const PATH = '/llm/uploads.json';
export const MARGIN_MS = 3_600_000;

const EXT = /** @type {Record<string, string>} */ ({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' });
/** The name of the Test button's photo (spec §9.8). */
export const TEST_UPLOAD = 'annai-test.png';
/** What annai names its uploads, and nothing else does: the one rule the namer and the sweep share. */
export const OURS = /^annai-(?:[0-9a-f]{16}|test)\.[a-z0-9]+$/;
/** An upload's name: annai-, the first 16 hex of its bytes' hash, its type's ending. @param {string} hash @param {string} mediaType */
export const uploadName = (hash, mediaType) => `annai-${hash.slice(0, 16)}.${EXT[mediaType] ?? 'bin'}`;

export class Uploads {
  /** @type {Record<string, Record<string, { id: string, expiresAt: number }>> | null} */
  #map = null;
  /** @type {Set<string>} endpoints whose upload was refused, unreadable or its plugin's failure (a call's: call.js withUploads; a Test's, any failure: check.js testUpload), or whose key was refused or can't delete: until annai restarts, or their provider's key or address changes, or a Test passes */
  #off = new Set();
  /** @type {Map<string, Set<string>>} by endpoint, the photos that go in the request there (hold, held): until annai restarts, or a new key or address, or a Test that passes, as #off */
  #held = new Map();
  /** @type {Set<string>} endpoints held since their provider last answered a request there (answered): no photo is uploaded there meanwhile */
  #waiting = new Set();
  /** @type {Set<string>} endpoints whose list answered and isn't one annai can read: the provider's, not the key's, so until annai restarts or a Test reads the list */
  #unread = new Set();
  /** @param {Workspace} ws @param {(endpointId: string) => boolean} [going] whether an endpoint's provider is going, or its key or address changing: nothing is uploaded there meanwhile, and an upload answered meanwhile is deleted (withUploads) */
  constructor(ws, going = () => false) {
    this.ws = ws;
    this.going = going;
  }
  async #load() {
    this.#map ??= (await this.ws.readJSON(SYS_SETTINGS, PATH).catch(() => null)) ?? {};
    return /** @type {Record<string, Record<string, { id: string, expiresAt: number }>>} */ (this.#map);
  }
  /** @param {string} endpointId @param {string} hash @returns {Promise<string | null>} */
  async get(endpointId, hash, now = Date.now()) {
    const e = (await this.#load())[endpointId]?.[hash];
    return e && e.expiresAt - MARGIN_MS > now ? e.id : null;
  }
  /** When a photo's upload expires, or 0. @param {string} endpointId @param {string} hash */
  async expires(endpointId, hash) {
    return (await this.#load())[endpointId]?.[hash]?.expiresAt ?? 0;
  }
  /** @param {string} endpointId @param {string} hash @param {string} id @param {number} expiresAt */
  async set(endpointId, hash, id, expiresAt, now = Date.now()) {
    const map = await this.#load();
    const kept = Object.fromEntries(Object.entries(map[endpointId] ?? {}).filter(([, v]) => v.expiresAt > now));
    map[endpointId] = { ...kept, [hash]: { id, expiresAt } };
    await this.ws.write(SYS_SETTINGS, PATH, map, { author: 'system' });
  }
  /** Forgets an endpoint's uploads: it said one was unknown or expired, or annai deleted them. @param {string} endpointId */
  async forget(endpointId) {
    const map = await this.#load();
    if (!map[endpointId]) return;
    delete map[endpointId];
    await this.ws.write(SYS_SETTINGS, PATH, map, { author: 'system' });
  }
  /** Reads the file again at the next use: a provider's removal took its uploads out of it (spec §4.9). */
  reload() {
    this.#map = null;
  }
  /** @param {string} endpointId */
  off(endpointId) {
    this.#off.add(endpointId);
  }
  /**
   * A photo whose upload was cut at UPLOAD_MS, or answered 408, 429 or a server error (call.js withUploads): a later try may work, but one at once
   * would likely wait it out again. That photo goes in the request there from then on, and so does every photo not yet uploaded there until its
   * provider next answers a request there (answered); then the next new photo is uploaded again. So a files service that keeps hanging costs
   * one wait a turn that brings new photos, never one a step or a model, and one until its provider answers on a link that answers nothing.
   * @param {string} endpointId @param {string} hash
   */
  hold(endpointId, hash) {
    this.#waiting.add(endpointId);
    this.#held.set(endpointId, (this.#held.get(endpointId) ?? new Set()).add(hash));
  }
  /** Whether a photo not uploaded there goes in the request without a try: one held, or any while the endpoint waits for its provider's answer, which holds it too. @param {string} endpointId @param {string} hash */
  held(endpointId, hash) {
    if (this.#waiting.has(endpointId)) this.hold(endpointId, hash);
    return !!this.#held.get(endpointId)?.has(hash);
  }
  /** Its provider answered a request there (call.js callOnce): the next new photo is uploaded again; those held stay in the request. @param {string} endpointId */
  answered(endpointId) {
    this.#waiting.delete(endpointId);
  }
  /** A new key or address, or a Test that passed: what failed with the old ones says nothing about these. A list annai can't read stays (listed). @param {string} id a provider's id (all its endpoints) or an endpoint's */
  retry(id) {
    for (const e of [...this.#off, ...this.#held.keys()]) {
      if (e !== id && !e.startsWith(`${id}/`)) continue;
      this.#off.delete(e);
      this.#held.delete(e);
      this.#waiting.delete(e);
    }
  }
  /**
   * What a read of an endpoint's list found (sweepUploads), the one rule for the sweeps and Test, so annai never makes files it can't delete:
   * a refusal is the key's, and turns uploads off as a refused upload does; a list that answered and isn't one annai can read is the
   * provider's, and turns them off whatever key or address comes, until annai restarts or a Test reads the list (test: this read is a
   * Test's). No answer says nothing. @param {string} endpointId @param {Swept | null} r @param {{ test?: boolean }} [o]
   * @returns {boolean} whether the list keeps uploads off there
   */
  listed(endpointId, r, { test = false } = {}) {
    if (r?.outcome === 'refused') this.#off.add(endpointId);
    if (r?.outcome === 'unreadable') this.#unread.add(endpointId);
    if (r?.outcome === 'done' && test) this.#unread.delete(endpointId);
    return r?.outcome === 'refused' || this.#unread.has(endpointId);
  }
  /** @param {string} endpointId */
  isOff(endpointId) {
    return this.#off.has(endpointId) || this.#unread.has(endpointId) || this.going(endpointId);
  }
}

/**
 * Deletions sent at once: a browser opens at most 6 connections to one host over HTTP/1.1, so more would only wait there. The one files
 * API annai deletes from publishes no rate limit for its files (its schema lists a 429, no number: checked 2026-11-14), and a 429 on a
 * deletion waits for the next sweep.
 */
const AT_ONCE = 6;
/**
 * Each list or delete request's time limit, a kept turn's deletion's (kept.js), and Test's photo upload's (a 16×16 image). 15 s is
 * about 35 times the 427 ms a deletion took when measured at the one files API annai deletes from (docs/limitations.md, the entry on
 * photos that outlive 48 hours), room for a slow link to set up a connection. It began as a kept turn's deletion's limit (0ba2134e),
 * which the sweeps and Test took for their small requests, and a voice added by id for the read of its list (service.js addModelById;
 * a router's, the biggest voice list, is 57 KB and took 47 ms on 2026-11-20); the other lists and the test photo's upload were not measured.
 */
export const REQUEST_MS = 15_000;
/**
 * One chat photo's upload (call.js): 120 s, a limit that catches a hang or a link too slow for the photo. It stands apart from a role's wait for the first words,
 * which starts after the uploads and is for a slow model. Sized for the slowest mobile data still in use, 2G EDGE: 59.2 kbit/s up a
 * timeslot at its best coding (MCS-9), and a class 10 phone uses 2 slots, 118.4 kbit/s, or 1 (59.2), as the network chooses by the traffic
 * (Wikipedia, General Packet Radio Service, multislot classes). A photo of 1 MiB (the request cap until 2026-11-21, 256 KiB since:
 * photos.js; a traveller can set more) is 8,388,608 bits: 71 s at 118.4 kbit/s, and 120 s lets the link run down to 70 kbit/s (59% of
 * that); 1 slot at 59.2 would need 142 s. A cut upload sends the photo in the request, as any failed one does, and holds uploads there until
 * its provider next answers (Uploads.hold).
 */
export const UPLOAD_MS = 120_000;
/** bit/s: the slowest uplink a model call's request has time for (call.js), the one UPLOAD_MS is sized for (see there). */
export const SLOW_UPLINK = 70_000;
/**
 * How long a request's bytes take to go up at SLOW_UPLINK, in ms: the time a wait gets on top of its own until the provider has the
 * whole request (a model's in call.js, a transcription's or a voice's in speech.js). shared: the other half may send on the same link at
 * the same time (a half's turn, §4.8), so the time of twice the bytes. @param {number} bytes @param {boolean} [shared]
 */
export const sendMs = (bytes, shared = false) => Math.ceil(((shared ? 2 : 1) * bytes * 8 * 1000) / SLOW_UPLINK);

/**
 * @typedef {{ outcome: 'done' | 'none' | 'refused' | 'unreadable' | 'unreachable', deleted: number, left: number }} Swept
 *   none: the type has no list; refused: a 401 or 403; unreadable: a list annai can't read, or none there (a 404, or another 4xx, but not
 *   a 408 or a 429) where the type has one; unreachable: no answer, a 408, a 429 or a server error on the list or a deletion; left: annai's files it didn't delete
 */

/**
 * Deletes annai's own uploads at an endpoint whose provider keeps files until they are deleted (spec §4.8): every file its list
 * names as annai names them (OURS) whose upload is over 48 hours old, or with all, at any age. The provider's own list is the
 * record, so a file no record here names (a deletion that failed, another device's, this device's data lost) goes too. A file
 * whose time annai can't read goes only with all. The age is the device's clock against the provider's: a clock far ahead
 * deletes live uploads early, which costs one upload again (the provider's 400 for a dead id, §9.9). Each request is traced as
 * a kept turn's deletion is, without ids, and never follows a redirect.
 * @param {{ type: EndpointType, endpoint: Endpoint, key: string | null, fetch: (url: string, init: RequestInit) => Promise<Response>,
 *   trace?: ReturnType<typeof import('./trace.js').modelTrace>, now?: () => number, all?: boolean }} c
 * @returns {Promise<Swept>}
 */
export async function sweepUploads({ type, endpoint, key, fetch, trace, now = Date.now, all = false }) {
  if (!type.listUploadsRequest || !type.readUploads || !type.deleteUploadRequest) return { outcome: 'none', deleted: 0, left: 0 };
  if (key) trace?.secret(key);
  /** @type {{ id: string, name: string, createdAt: number }[]} */
  const ours = [];
  /** @type {Set<string>} */
  const cursors = new Set();
  /** @type {string | null} */
  let cursor = null;
  do {
    if (cursor) cursors.add(cursor);
    const r = type.listUploadsRequest({ endpoint, key, cursor });
    const { status, res } = await send(r, 'GET', { endpoint, fetch, trace, now, kind: 'upload-list', shown: r.url.split('?')[0] });
    if (status === 401 || status === 403) return { outcome: 'refused', deleted: 0, left: 0 };
    // Any other 4xx is an answer, and not a list (a 404, a 405, a 410, a 422: moved or changed); a 408 and a 429 ask for a later try.
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { outcome: 'unreadable', deleted: 0, left: 0 };
    if (!res || status < 200 || status >= 300) return { outcome: 'unreachable', deleted: 0, left: 0 };
    // A body that breaks off or stalls past the time limit is no answer, as no reply at all is; only a body that arrived and can't be read is unreadable.
    /** @type {string} */
    let body;
    try {
      body = await res.text();
    } catch {
      return { outcome: 'unreachable', deleted: 0, left: 0 };
    }
    /** @type {ReturnType<NonNullable<EndpointType['readUploads']>>} */
    let page;
    try {
      page = type.readUploads(JSON.parse(body));
    } catch {
      return { outcome: 'unreadable', deleted: 0, left: 0 };
    }
    for (const f of page.files) if (OURS.test(f.name)) ours.push(f);
    cursor = page.cursor;
  } while (cursor && !cursors.has(cursor));
  const due = ours.filter((f) => all || f.createdAt + UPLOAD_TTL_S * 1000 <= now());
  let deleted = 0;
  let refused = false;
  const queue = due.slice();
  const one = async () => {
    for (let f = queue.shift(); f && !refused; f = queue.shift()) {
      const status = await deleteUpload({ type, endpoint, key, fetch, trace, now, id: f.id });
      // A 404: someone else deleted it first.
      if ((status >= 200 && status < 300) || status === 404) deleted++;
      else if (status === 401 || status === 403) refused = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, due.length) }, one));
  const left = due.length - deleted;
  return { outcome: refused ? 'refused' : left ? 'unreachable' : 'done', deleted, left };
}

/**
 * One upload's deletion by its id, at the endpoint's own address, as the sweep makes it and Test, for the photo it just uploaded.
 * @param {{ type: EndpointType, endpoint: Endpoint, key: string | null, fetch: (url: string, init: RequestInit) => Promise<Response>,
 *   trace?: ReturnType<typeof import('./trace.js').modelTrace>, now?: () => number, id: string }} c
 * @returns {Promise<number>} the status; 0: no answer (or a redirect, which is never followed), or the type can't delete
 */
export async function deleteUpload({ type, endpoint, key, fetch, trace, now = Date.now, id }) {
  const r = type.deleteUploadRequest?.({ endpoint, key, id });
  if (!r) return 0;
  return (await send(r, r.method, { endpoint, fetch, trace, now, kind: 'upload-delete', shown: r.url.replace(encodeURIComponent(id), '…') })).status;
}

/**
 * One request of a sweep, to the endpoint's own address, traced without ids (shown: its address as the Trace says it).
 * @param {{ url: string, headers: Record<string, string> }} r @param {string} method
 * @param {{ endpoint: Endpoint, fetch: (url: string, init: RequestInit) => Promise<Response>, trace?: ReturnType<typeof import('./trace.js').modelTrace>, now: () => number, kind: string, shown: string }} c
 * @returns {Promise<{ status: number, res: Response | null }>} status 0: no answer
 */
async function send(r, method, { endpoint, fetch, trace, now, kind, shown }) {
  const started = now();
  let status = 0;
  /** @type {Response | null} */
  let res = null;
  try {
    sameOrigin(endpoint, r.url);
    res = await fetch(r.url, { method, headers: r.headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_MS) });
    status = res.status;
    noRedirect(res, endpoint);
  } catch {
    res = null; // no answer, or a redirect: it waits
  }
  const ok = (status >= 200 && status < 300) || (kind === 'upload-delete' && status === 404);
  await trace?.request({ kind, endpoint: endpoint.name, model: '', providerModel: '', url: shown, status, ms: now() - started, firstMs: null, outcome: ok ? 'ok' : 'waiting', usage: null });
  return { status: res ? status : 0, res };
}
