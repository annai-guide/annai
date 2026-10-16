/**
 * Cache lifetime awareness (spec §6.4): when each model last got this prefix, so the loop knows
 * whether its cache is warm. Each provider caches per model, so warmth is per model and prefix.
 */

export const TTL_MS = Object.freeze({ '5m': 5 * 60_000, '1h': 60 * 60_000 });
/** A cache this close to expiring counts as about to expire: a rewrite now costs nothing extra. */
export const SOON_MS = 60_000;

/** The lifetime to ask a model for: the one wanted, if it has it, else its first, else 5 minutes. @param {{ cacheTtls: string[] }} model @param {string} wanted @returns {'5m' | '1h'} */
export function ttlFor(model, wanted) {
  const list = model.cacheTtls ?? [];
  return /** @type {'5m' | '1h'} */ (list.includes(wanted) ? wanted : list[0] === '1h' ? '1h' : '5m');
}

export class Warmth {
  /** @type {Map<string, { fingerprint: string, at: number, ttlMs: number }>} */
  #seen = new Map();
  /** @type {{ modelId: string, fingerprint: string, at: number, ttlMs: number } | null} */
  last = null;

  /** @param {string} modelId @param {string} fingerprint @param {number} ttlMs @param {number} at */
  note(modelId, fingerprint, ttlMs, at) {
    this.#seen.set(modelId, { fingerprint, at, ttlMs });
    this.last = { modelId, fingerprint, at, ttlMs };
  }

  /** @param {string} modelId @param {string} fingerprint @param {number} now @returns {{ warm: boolean, expiresAt: number }} */
  state(modelId, fingerprint, now) {
    const s = this.#seen.get(modelId);
    if (!s || s.fingerprint !== fingerprint) return { warm: false, expiresAt: 0 };
    const expiresAt = s.at + s.ttlMs;
    return { warm: now < expiresAt, expiresAt };
  }
}
