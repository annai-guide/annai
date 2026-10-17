/**
 * Durable Objects in memory, for running the relay in Node (relay/serve.mjs) and for its tests: a
 * namespace whose objects keep their storage in a Map, and whose alarms fire on timers (or, with
 * timers off, when runDue is called by a test that moves its own clock). Values are copied in and
 * out, as Cloudflare's storage does. Given a file, every change is written there before it is
 * answered, and load() brings it all back after a restart. Not used on Cloudflare.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The longest wait setTimeout holds; a longer one is waited in steps. */
const LONGEST = 2 ** 31 - 1;
/** Cloudflare's storage takes at most this many keys in one put or delete. */
export const MAX_KEYS = 128;

/** @param {number} n */
function allowed(n) {
  if (n > MAX_KEYS) throw new Error(`Durable Object storage takes at most ${MAX_KEYS} keys a call; this was ${n}.`);
}

export class MemoryStorage {
  /** @type {Map<string, any>} */
  #data = new Map();
  /** @type {number | null} */
  alarm = null;
  #changed;
  #saved;
  /**
   * @param {() => void} [changed] told when the alarm is set or deleted
   * @param {() => Promise<void>} [saved] awaited after every change, until it is written down
   */
  constructor(changed = () => {}, saved = async () => {}) {
    this.#changed = changed;
    this.#saved = saved;
  }
  /** @param {string} key */
  async get(key) {
    return structuredClone(this.#data.get(key));
  }
  /** @param {string | Record<string, any>} key @param {any} [value] */
  async put(key, value) {
    if (typeof key === 'string') {
      this.#data.set(key, structuredClone(value));
    } else {
      allowed(Object.keys(key).length);
      for (const [k, v] of Object.entries(key)) this.#data.set(k, structuredClone(v));
    }
    await this.#saved();
  }
  /** @param {string | string[]} key */
  async delete(key) {
    if (!Array.isArray(key)) {
      const had = this.#data.delete(key);
      await this.#saved();
      return had;
    }
    allowed(key.length);
    let n = 0;
    for (const k of key) if (this.#data.delete(k)) n++;
    await this.#saved();
    return n;
  }
  /** @param {{ prefix?: string }} [o] @returns {Promise<Map<string, any>>} */
  async list({ prefix = '' } = {}) {
    const keys = [...this.#data.keys()].filter((k) => k.startsWith(prefix)).sort();
    return new Map(keys.map((k) => [k, structuredClone(this.#data.get(k))]));
  }
  /** Everything stored goes; the alarm stays, as on Cloudflare. */
  async deleteAll() {
    this.#data.clear();
    await this.#saved();
  }
  async getAlarm() {
    return this.alarm;
  }
  /** @param {number | Date} t */
  async setAlarm(t) {
    this.alarm = Number(t);
    this.#changed();
    await this.#saved();
  }
  async deleteAlarm() {
    this.alarm = null;
    this.#changed();
    await this.#saved();
  }
  /** Every key stored, sorted (tests). */
  keys() {
    return [...this.#data.keys()].sort();
  }
  /** What is stored and the alarm, as plain data for a file. */
  snapshot() {
    return { data: Object.fromEntries(this.#data), alarm: this.alarm };
  }
  /** Puts back what snapshot() gave, without saving it again. @param {{ data?: Record<string, any>, alarm?: number | null }} s */
  restore(s) {
    this.#data = new Map(Object.entries(s.data ?? {}));
    this.alarm = typeof s.alarm === 'number' ? s.alarm : null;
  }
}

/**
 * Writes what a namespace holds to a file, readable by its owner alone: each change waits for a
 * write that began after it, and changes made while one is being written share the next.
 * @param {string} file @param {() => any} contents
 */
function fileSaver(file, contents) {
  /** @type {Promise<void> | null} */
  let next = null;
  /** @type {Promise<void>} */
  let last = Promise.resolve();
  const write = async () => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(contents()), { mode: 0o600 });
    await rename(tmp, file);
  };
  return () => {
    if (next) return next;
    const mine = last.then(async () => {
      next = null;
      await write();
    });
    next = mine;
    last = mine.catch(() => {});
    return mine;
  };
}

/**
 * @param {any} Class a Durable Object class: new Class({ storage }, env), with fetch(req) and alarm()
 * @param {any} env @param {{ now?: () => number, timers?: boolean, file?: string }} [o]
 *   file: where everything is kept, so a restart (load()) forgets nothing
 */
export function memoryNamespace(Class, env, { now = () => Date.now(), timers = true, file } = {}) {
  /** @typedef {{ obj: any, storage: MemoryStorage, timer: ReturnType<typeof setTimeout> | null }} Entry */
  /** @type {Map<string, Entry>} */
  const objects = new Map();
  const save = file
    ? fileSaver(file, () => ({
      v: 1,
      objects: Object.fromEntries([...objects].flatMap(([name, o]) => {
        const s = o.storage.snapshot();
        return Object.keys(s.data).length || s.alarm !== null ? [[name, s]] : [];
      })),
    }))
    : async () => {};
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
    o.storage = new MemoryStorage(() => arm(o), save);
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
    /** Brings back what the file holds, and arms each alarm (one already due fires at once). */
    async load() {
      if (!file) return;
      /** @type {any} */
      let kept;
      try {
        kept = JSON.parse(await readFile(file, 'utf8'));
      } catch (e) {
        if (/** @type {any} */ (e)?.code === 'ENOENT') return;
        throw new Error(`The relay's data file ${file} can't be read (${e instanceof Error ? e.message : e}). Move it aside to start empty.`);
      }
      for (const [name, s] of Object.entries(kept?.objects ?? {})) {
        const o = object(name);
        o.storage.restore(/** @type {any} */ (s));
        arm(o);
      }
    },
    /** Fires every alarm due by now, and those they set for now, as Cloudflare would (a test that moves its own clock). */
    async runDue() {
      for (let round = 0; round < 100; round++) {
        const due = [...objects.values()].filter((o) => o.storage.alarm !== null && o.storage.alarm <= now());
        if (!due.length) return;
        for (const o of due) {
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
export function memoryLimiter({ limit = 60, period = 60_000, now = () => Date.now() } = {}) {
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
