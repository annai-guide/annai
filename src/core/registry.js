export class PluginError extends Error {
  /** @param {string} pluginId @param {string} message @param {unknown} [cause] */
  constructor(pluginId, message, cause) {
    super(`${pluginId}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'PluginError';
    this.pluginId = pluginId;
  }
}

/**
 * Everything plugins contribute, grouped by kind ("schema", "tool", …).
 * Functions plugins hand over go through guard(): a failure becomes a
 * plugin.error event, and a plugin that fails maxFailures times in a row is
 * switched off until enable() is called (spec §5.5).
 */
export class Registry {
  /** @type {Map<string, { pluginId: string, item: any }[]>} */ #items = new Map();
  /** @type {Map<string, number>} */ #failures = new Map();
  /** @type {Set<string>} */ #disabled = new Set();
  /** @type {Set<() => void>} */ #listeners = new Set();

  /** @param {{ log?: (ev: { type: string, actor: string, data: any }) => unknown, maxFailures?: number }} [opts] */
  constructor(opts = {}) {
    this.log = opts.log ?? (() => {});
    this.maxFailures = opts.maxFailures ?? 3;
  }

  /** @param {string} pluginId @param {string} kind @param {any} item @returns {() => void} removes this contribution */
  add(pluginId, kind, item) {
    const entry = { pluginId, item };
    const list = this.#items.get(kind) ?? [];
    list.push(entry);
    this.#items.set(kind, list);
    this.#emit();
    return () => {
      const l = this.#items.get(kind);
      const i = l ? l.indexOf(entry) : -1;
      if (l && i >= 0) {
        l.splice(i, 1);
        this.#emit();
      }
    };
  }

  /** Contributions of a kind from plugins that are not switched off. @param {string} kind */
  list(kind) {
    return (this.#items.get(kind) ?? []).filter((e) => !this.#disabled.has(e.pluginId)).map((e) => e.item);
  }

  /** @param {string} pluginId */
  removePlugin(pluginId) {
    let changed = false;
    for (const [kind, l] of this.#items) {
      const kept = l.filter((e) => e.pluginId !== pluginId);
      if (kept.length !== l.length) {
        this.#items.set(kind, kept);
        changed = true;
      }
    }
    if (changed) this.#emit();
  }

  /** @param {string} pluginId */
  isDisabled(pluginId) {
    return this.#disabled.has(pluginId);
  }

  /** Clears a plugin's failure count and switches it back on. @param {string} pluginId */
  enable(pluginId) {
    this.#failures.delete(pluginId);
    if (this.#disabled.delete(pluginId)) this.#emit();
  }

  /**
   * @template {(...args: any[]) => any} F
   * @param {string} pluginId @param {string} name what the function is, for messages
   * @param {F} fn
   * @returns {(...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>}
   */
  guard(pluginId, name, fn) {
    return async (...args) => {
      if (this.#disabled.has(pluginId)) throw new PluginError(pluginId, 'is switched off after repeated errors');
      try {
        const result = await fn(...args);
        this.#failures.set(pluginId, 0);
        return result;
      } catch (e) {
        this.#fail(pluginId, name, e);
        throw new PluginError(pluginId, `${name} failed: ${/** @type {any} */ (e)?.message ?? e}`, e);
      }
    };
  }

  /** @param {() => void} fn */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** @param {string} pluginId @param {string} name @param {any} e */
  #fail(pluginId, name, e) {
    const n = (this.#failures.get(pluginId) ?? 0) + 1;
    this.#failures.set(pluginId, n);
    this.#safeLog({ type: 'plugin.error', actor: `plugin:${pluginId}`, data: { name, message: String(e?.message ?? e), count: n } });
    if (n >= this.maxFailures && !this.#disabled.has(pluginId)) {
      this.#disabled.add(pluginId);
      this.#safeLog({ type: 'plugin.disabled', actor: 'system', data: { plugin: pluginId, reason: `failed ${n} times in a row` } });
      this.#emit();
    }
  }

  /** @param {{ type: string, actor: string, data: any }} ev */
  #safeLog(ev) {
    try {
      const r = /** @type {any} */ (this.log(ev));
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      // logging must never break the caller
    }
  }

  #emit() {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (e) {
        console.warn('a registry listener failed', e);
      }
    }
  }
}
