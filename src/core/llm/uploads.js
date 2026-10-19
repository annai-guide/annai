import { SYS_SETTINGS } from '../scopes.js';

/**
 * Photos uploaded to a provider's files API (spec §4.8): each request copy once, by endpoint
 * ("<provider>/<ability>", since file ids belong to one protocol's files API).
 * Every upload expires after 48 hours; an id within an hour of that is uploaded again.
 * @typedef {import('../workspace.js').Workspace} Workspace
 */

export const UPLOAD_TTL_S = 172_800;
const PATH = '/llm/uploads.json';
const MARGIN_MS = 3_600_000;

export class Uploads {
  /** @type {Record<string, Record<string, { id: string, expiresAt: number }>> | null} */
  #map = null;
  /** @type {Set<string>} endpoints whose uploads failed since annai started */
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
  /** @param {string} endpointId @param {string} hash @param {string} id @param {number} expiresAt */
  async set(endpointId, hash, id, expiresAt, now = Date.now()) {
    const map = await this.#load();
    const kept = Object.fromEntries(Object.entries(map[endpointId] ?? {}).filter(([, v]) => v.expiresAt > now));
    map[endpointId] = { ...kept, [hash]: { id, expiresAt } };
    await this.ws.write(SYS_SETTINGS, PATH, map, { author: 'system' });
  }
  /** Forgets an endpoint's uploads, after it said one was unknown or expired. @param {string} endpointId */
  async forget(endpointId) {
    const map = await this.#load();
    if (!map[endpointId]) return;
    delete map[endpointId];
    await this.ws.write(SYS_SETTINGS, PATH, map, { author: 'system' });
  }
  /** Forgets every upload to a provider's abilities, when it is removed (spec §4.9). @param {string} providerId */
  async forgetProvider(providerId) {
    const map = await this.#load();
    const gone = Object.keys(map).filter((k) => k.startsWith(`${providerId}/`));
    if (!gone.length) return;
    for (const k of gone) delete map[k];
    await this.ws.write(SYS_SETTINGS, PATH, map, { author: 'system' });
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
