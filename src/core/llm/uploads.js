import { SYS_SETTINGS } from '../scopes.js';
import { sameOrigin, noRedirect } from './contract.js';

/**
 * Photos uploaded to a provider's files API (spec §4.8): each request copy once, by endpoint
 * ("<provider>/<ability>", since file ids belong to one protocol's files API).
 * Every upload is used for 48 hours; an id within an hour of that is uploaded again. Where the provider keeps
 * files until they are deleted (OpenRouter), annai deletes its own after 48 hours, from the provider's own list (sweepUploads).
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
  /** @type {Set<string>} endpoints whose uploads failed, or can't be deleted, since annai started */
  #off = new Set();
  /** @param {Workspace} ws */
  constructor(ws) {
    this.ws = ws;
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
  /** @param {string} endpointId */
  isOff(endpointId) {
    return this.#off.has(endpointId);
  }
}

/**
 * Deletions sent at once: a browser opens at most 6 connections to one host over HTTP/1.1, so more would only wait there; OpenRouter
 * states no rate limit for its files API (checked 2026-11-14).
 */
const AT_ONCE = 6;
/** Each list or delete request's time limit, a kept turn's deletion's (kept.js). */
const REQUEST_MS = 15_000;

/**
 * @typedef {{ outcome: 'done' | 'none' | 'refused' | 'unreadable' | 'unreachable', deleted: number, left: number }} Swept
 *   none: no files API there (the type has no list, or the list is a 404); refused: a 401 or 403; unreadable: a list annai can't read;
 *   unreachable: no answer, a 429 or a server error on the list or a deletion; left: annai's files it didn't delete
 */

/**
 * Deletes annai's own uploads at an endpoint whose provider keeps files until they are deleted (spec §4.8): every file its list
 * names as annai names them (OURS) whose upload is over 48 hours old, or with all, at any age. The provider's own list is the
 * record, so a file no record here names (a deletion that failed, another device's, this device's data lost) goes too. A file
 * whose time annai can't read goes only with all. The age is the device's clock against the provider's: a clock far ahead
 * deletes live uploads early, which costs one upload again (the provider's 400 for a dead id, §9.9). Each request is traced as
 * a kept turn's deletion is, without ids, and never follows a redirect.
 * @param {{ type: EndpointType, endpoint: Endpoint, key: string | null, fetch: (url: string, init: RequestInit) => Promise<Response>,
 *   trace?: ReturnType<typeof import('./trace.js').modelTrace>, now?: () => number, all?: boolean, only?: (name: string) => boolean }} c
 *   only: which of annai's files, by name (Test's photo)
 * @returns {Promise<Swept>}
 */
export async function sweepUploads({ type, endpoint, key, fetch, trace, now = Date.now, all = false, only = () => true }) {
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
    if (status === 404) return { outcome: 'none', deleted: 0, left: 0 };
    if (status === 401 || status === 403) return { outcome: 'refused', deleted: 0, left: 0 };
    if (!res || status < 200 || status >= 300) return { outcome: 'unreachable', deleted: 0, left: 0 };
    /** @type {ReturnType<NonNullable<EndpointType['readUploads']>>} */
    let page;
    try {
      page = type.readUploads(await res.json());
    } catch {
      return { outcome: 'unreadable', deleted: 0, left: 0 };
    }
    for (const f of page.files) if (OURS.test(f.name) && only(f.name)) ours.push(f);
    cursor = page.cursor;
  } while (cursor && !cursors.has(cursor));
  const due = ours.filter((f) => all || f.createdAt + UPLOAD_TTL_S * 1000 <= now());
  let deleted = 0;
  let refused = false;
  const queue = due.slice();
  const one = async () => {
    for (let f = queue.shift(); f && !refused; f = queue.shift()) {
      const r = type.deleteUploadRequest?.({ endpoint, key, id: f.id });
      if (!r) return;
      const { status } = await send(r, r.method, { endpoint, fetch, trace, now, kind: 'upload-delete', shown: r.url.replace(encodeURIComponent(f.id), '…') });
      if ((status >= 200 && status < 300) || status === 404) deleted++;
      else if (status === 401 || status === 403) refused = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, due.length) }, one));
  const left = due.length - deleted;
  return { outcome: refused ? 'refused' : left ? 'unreachable' : 'done', deleted, left };
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
