/**
 * Durable Objects in memory, for running the relay in Node (relay/serve.mjs) and for its tests: a
 * namespace whose objects keep their storage in a Map, and whose alarms fire on timers (or, with
 * timers off, when runDue is called by a test that moves its own clock). Values are copied in and
 * out, as Cloudflare's storage does. Not used on Cloudflare.
 */

/** The longest wait setTimeout holds; a longer one is waited in steps. */
const LONGEST = 2 ** 31 - 1;

export class MemoryStorage {
  /** @type {Map<string, any>} */
  #data = new Map();
  /** @type {number | null} */
  alarm = null;
  #changed;
  /** @param {() => void} [changed] told when the alarm is set or deleted */
  constructor(changed = () => {}) {
    this.#changed = changed;
  }
  /** @param {string} key */
  async get(key) {
    return structuredClone(this.#data.get(key));
  }
  /** @param {string | Record<string, any>} key @param {any} [value] */
  async put(key, value) {
    if (typeof key === 'string') this.#data.set(key, structuredClone(value));
    else for (const [k, v] of Object.entries(key)) this.#data.set(k, structuredClone(v));
  }
  /** @param {string | string[]} key */
  async delete(key) {
    if (!Array.isArray(key)) return this.#data.delete(key);
    let n = 0;
    for (const k of key) if (this.#data.delete(k)) n++;
    return n;
  }
  /** @param {{ prefix?: string }} [o] @returns {Promise<Map<string, any>>} */
  async list({ prefix = '' } = {}) {
    const keys = [...this.#data.keys()].filter((k) => k.startsWith(prefix)).sort();
    return new Map(keys.map((k) => [k, structuredClone(this.#data.get(k))]));
  }
  async getAlarm() {
    return this.alarm;
  }
  /** @param {number | Date} t */
  async setAlarm(t) {
    this.alarm = Number(t);
    this.#changed();
  }
  async deleteAlarm() {
    this.alarm = null;
    this.#changed();
  }
  /** Every key stored, sorted (tests). */
  keys() {
    return [...this.#data.keys()].sort();
  }
}

/**
 * @param {any} Class a Durable Object class: new Class({ storage }, env), with fetch(req) and alarm()
 * @param {any} env @param {{ now?: () => number, timers?: boolean }} [o]
 */
export function memoryNamespace(Class, env, { now = () => Date.now(), timers = true } = {}) {
  /** @typedef {{ obj: any, storage: MemoryStorage, timer: ReturnType<typeof setTimeout> | null }} Entry */
  /** @type {Map<string, Entry>} */
  const objects = new Map();
  /** @param {Entry} o */
  const arm = (o) => {
    if (!timers) return;
    if (o.timer) clearTimeout(o.timer);
    o.timer = null;
    if (o.storage.alarm === null) return;
    const step = () => {
      const left = /** @type {number} */ (o.storage.alarm) - now();
      if (left > 0) {
        o.timer = setTimeout(step, Math.min(left, LONGEST));
        return;
      }
      o.timer = null;
      o.storage.alarm = null;
      Promise.resolve(o.obj.alarm()).catch((/** @type {unknown} */ e) => console.warn('the relay alarm failed', e));
    };
    step();
  };
  /** @param {string} name @returns {Entry} */
  const object = (name) => {
    const had = objects.get(name);
    if (had) return had;
    /** @type {Entry} */
    const o = { obj: null, storage: /** @type {any} */ (null), timer: null };
    o.storage = new MemoryStorage(() => arm(o));
    o.obj = new Class({ storage: o.storage }, env);
    objects.set(name, o);
    return o;
  };
  return {
    /** @param {string} name */
    idFromName: (name) => ({ name, toString: () => name }),
    /** @param {{ name: string }} id */
    get: (id) => {
      const o = object(id.name);
      return { fetch: (/** @type {Request} */ req) => o.obj.fetch(req) };
    },
    objects,
    /** Fires every alarm due by now (a test that moves its own clock). */
    async runDue() {
      for (const o of objects.values()) {
        if (o.storage.alarm !== null && o.storage.alarm <= now()) {
          o.storage.alarm = null;
          await o.obj.alarm();
        }
      }
    },
    /** Every reminder waiting, in every object (tests). @returns {Promise<any[]>} */
    async waiting() {
      const out = [];
      for (const o of objects.values()) out.push(...(await o.storage.list({ prefix: 'm:' })).values());
      return out;
    },
    /** Stops the timers (a runner closing). */
    close() {
      for (const o of objects.values()) if (o.timer) clearTimeout(o.timer);
    },
  };
}

/**
 * A limit per key like Cloudflare's rate-limit binding: at most limit calls in each period (ms).
 * @param {{ limit?: number, period?: number, now?: () => number }} [o]
 */
export function memoryLimiter({ limit = 300, period = 60_000, now = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} */
  const seen = new Map();
  return {
    /** @param {{ key: string }} o */
    async limit({ key }) {
      const t = now();
      const recent = (seen.get(key) ?? []).filter((x) => x > t - period);
      const success = recent.length < limit;
      if (success) recent.push(t);
      seen.set(key, recent);
      return { success };
    },
  };
}
