import { sha256Hex } from '../hash.js';
import { utf8, ownBuffer } from '../bytes.js';

/**
 * Model calls in the trace (spec §4.5, §9.6, §15): a net.request for every attempt, and a
 * model.turn for every role call. Request bodies aren't kept: a model request is logged as a
 * reference, not a copy. The reply's text and its reasoning are kept, as blobs the model.turn names
 * in refs, written in the same transaction (§4.9). Keys never reach the trace; any a provider echoes back in an
 * error are blanked out. Writing to the trace never breaks a call, not even on a full device.
 * @typedef {import('../types.js').Store} Store
 * @typedef {{ endpoint: string, model: string, providerModel: string, url: string, status: number, ms: number, firstMs: number | null,
 *   outcome: string, error?: string, usage: any, cost?: number }} RequestInfo
 * @typedef {{ model: string, name: string, outcome: string, ms: number, cost?: number, error?: string }} Attempt
 * @typedef {{ role: string, level: string, answeredBy: string | null, attempts: Attempt[], usage: any, cost: number | undefined, stop?: string }} TurnInfo
 */

/** @param {Store} store @param {string} scope */
export function modelTrace(store, scope) {
  /** @type {Set<string>} */
  const secrets = new Set();
  const scrub = (/** @type {unknown} */ s) => {
    let out = String(s ?? '');
    for (const k of secrets) out = out.split(k).join('«key»');
    return out;
  };
  /**
   * Appends an event, keeping each non-empty text as a blob it names in refs; data.stored says
   * which is which.
   * @param {{ ts: number, type: string, actor: string, data: any }} ev @param {[string, string][]} texts [name, text] pairs
   */
  const append = async (ev, texts) => {
    try {
      const kept = [];
      for (const [name, text] of texts) {
        if (!text) continue;
        const bytes = utf8(text);
        kept.push({ name, bytes, hash: await sha256Hex(bytes) });
      }
      if (!kept.length) {
        await store.tx(['events'], 'readwrite', (t) => t.appendEvent(scope, ev));
        return;
      }
      await store.tx(['blobs', 'events'], 'readwrite', async (t) => {
        for (const k of kept) {
          if (!(await t.hasBlob(k.hash))) await t.putBlob({ hash: k.hash, type: 'text/plain; charset=utf-8', size: k.bytes.byteLength, data: ownBuffer(k.bytes) });
        }
        await t.appendEvent(scope, { ...ev, data: { ...ev.data, stored: kept.map((k) => k.name) }, refs: kept.map((k) => k.hash) });
      });
    } catch {
      // the trace must never break a call
    }
  };
  return {
    /** A key the calls use, so that an echo of it can be blanked out. Short strings are ignored. @param {string} key */
    secret(key) {
      if (typeof key === 'string' && key.length >= 8) secrets.add(key);
    },
    /** @param {RequestInfo} i */
    request(i) {
      const data = { kind: 'model', ...i, ...(i.error ? { error: scrub(i.error) } : {}), url: scrub(i.url) };
      return append({ ts: Date.now(), type: 'net.request', actor: 'system', data }, []);
    },
    /**
     * @param {TurnInfo} i @param {string} text the reply's text
     * @param {string} [reasoning] the reply's reasoning: never shown in the conversation, visible here (spec §9.3)
     */
    turn(i, text, reasoning = '') {
      const data = { ...i, attempts: i.attempts.map((a) => (a.error ? { ...a, error: scrub(a.error) } : a)) };
      return append({ ts: Date.now(), type: 'model.turn', actor: 'system', data }, [['reply', scrub(text)], ['reasoning', scrub(reasoning)]]);
    },
  };
}
