/** Words said of plugins in several places. */
const OWN = "annai's own plugin uses this name";
/** A package from elsewhere can't take one of annai's own ids (security review). */
export const TAKEN = `${OWN}, so a package from elsewhere can't have it. Ask its author to rename it.`;
/** One from elsewhere that holds one is never used as annai's own (security review). */
export const NOT_OWN = `${OWN}, but the one installed came from elsewhere, so annai won't use it. Remove it in Settings → Plugins, then try again.`;
/** A plugin the user switched off stays off (security review). */
export const TURN_ON = 'Turn it on in Settings → Plugins, then try again.';

const by = (/** @type {string} */ f) => (/** @type {any} */ x) => String(x?.[f]);
/** Kinds whose names have one owner, with how a name is read. @type {Record<string, (item: any) => string>} */
export const NAMED = Object.freeze({
  tool: by('name'), 'endpoint-type': by('type'), 'storage-type': by('type'), skill: by('name'), personality: by('name'), 'ui:component': by('name'), 'ui:card-type': by('type'), search: by('id'),
});
/** Kinds handed the user's keys: rank alone owns them, never a choice. */
export const KEYED = new Set(['endpoint-type', 'storage-type']);

/** How owners are found (reserved: 'only' annai's alone, 'own' annai's until chosen; official: whose a keyed name is).
 * @typedef {{ rank: (pluginId: string) => (number | string)[], choice: (kind: string, name: string) => string | undefined,
 *   reserved: (kind: string, name: string) => 'only' | 'own' | null, official?: (kind: string, name: string) => string | undefined }} Rules
 * @typedef {{ kind: string, name: string, owner: string, used: boolean, reserved: boolean, chosen: boolean }} Clash */
/** @type {Rules} before setRules: the first to register owns a name */
const FIRST = { rank: () => [], choice: () => undefined, reserved: () => null };

/** Two ranks of one length compared element by element: below 0 when a comes first. @param {(number | string)[]} a @param {(number | string)[]} b */
export function compareRanks(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Errors that mean a plugin's code is broken, rather than a tool saying it can't do something. */
const BUGS = [TypeError, ReferenceError, RangeError, SyntaxError, EvalError];

/**
 * Whether an error is a bug in a plugin's code (spec §5.5) rather than its answer. A fetch the
 * browser couldn't make (offline: "Failed to fetch", Safari's "Load failed") is an answer (§17).
 * @param {unknown} e
 */
export function isPluginBug(e) {
  if (!(e instanceof Error)) return true;
  const offline = e instanceof TypeError && /fetch|load failed|network/i.test(e.message);
  // An address the user typed that isn't one is the user's to fix, not a bug.
  const address = e instanceof TypeError && /invalid url|failed to parse url/i.test(e.message);
  return !offline && !address && BUGS.some((B) => e instanceof B);
}

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
/**
 * Why a plugin was switched off, as data: it failed count times in a row, or its hooks were handed more than entries log entries in
 * seconds (a loop). The card makes its words from it. @typedef {{ kind: 'failed', count: number } | { kind: 'loop', entries: number, seconds: number }} DisabledWhy
 */

/** Why, in annai's English, as the log keeps it for the Trace. @param {DisabledWhy} why */
/* en */
export const disabledReason = (why) => (why.kind === 'loop' ? `its hooks were handed more than ${why.entries} log entries in ${why.seconds} seconds, which looks like a loop` : `failed ${why.count} times in a row`);

export class Registry {
  /** @type {Map<string, { pluginId: string, item: any, seq: number }[]>} */ #items = new Map();
  #seq = 0;
  /** @type {Rules} */ #rules = FIRST;
  /** @type {Map<string, number>} */ #failures = new Map();
  /** @type {Set<string>} */ #disabled = new Set();
  /** @type {Set<() => void>} */ #listeners = new Set();
  /** @type {Set<(info: { pluginId: string, why: DisabledWhy, message: string }) => void>} */ #offs = new Set();

  /** @param {{ log?: (ev: { type: string, actor: string, data: any }) => unknown, maxFailures?: number }} [opts] */
  constructor(opts = {}) {
    this.log = opts.log ?? (() => {});
    this.maxFailures = opts.maxFailures ?? 3;
  }

  /** @param {string} pluginId @param {string} kind @param {any} item @returns {() => void} removes this contribution */
  add(pluginId, kind, item) {
    const entry = { pluginId, item, seq: this.#seq++ };
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

  /** Contributions of a kind from plugins not switched off; of a named kind, each name's owner's. @param {string} kind */
  list(kind) {
    return this.entries(kind).map((e) => e.item);
  }

  /**
   * Contributions of a kind with the plugin each came from; of a named kind, one per name, its owner's. all: every one, used or not, on or off.
   * @param {string} kind @param {{ all?: boolean }} [o] @returns {{ pluginId: string, item: any }[]}
   */
  entries(kind, { all = false } = {}) {
    const name = NAMED[kind];
    const seen = new Set();
    return (this.#items.get(kind) ?? []).filter((e) => all || (!this.#disabled.has(e.pluginId) && (!name || (!seen.has(name(e.item))
      && this.owner(kind, name(e.item))?.pluginId === e.pluginId && seen.add(name(e.item)))))).map((e) => ({ pluginId: e.pluginId, item: e.item }));
  }

  /** @param {Rules} rules */
  setRules(rules) {
    this.#rules = rules;
    this.#emit();
  }

  /** A name's owner: annai's, the user's choice while it runs, else the lowest rank running; null: nobody. @param {string} kind @param {string} name @returns {{ pluginId: string, chosen: boolean } | null} */
  owner(kind, name) {
    const how = this.#rules.reserved(kind, name);
    if (how === 'only') return { pluginId: 'annai', chosen: false };
    const read = NAMED[kind] ?? (() => '');
    const live = (this.#items.get(kind) ?? []).filter((e) => !this.#disabled.has(e.pluginId) && read(e.item) === name);
    const chosen = this.choosable(kind, name) && this.#rules.choice(kind, name);
    if (chosen && live.some((e) => e.pluginId === chosen)) return { pluginId: chosen, chosen: true };
    const rank = (/** @type {{ pluginId: string, seq: number }} */ e) => [...this.#rules.rank(e.pluginId), e.seq];
    const [first] = live.sort((a, b) => compareRanks(rank(a), rank(b)));
    const top = first && this.#rules.rank(first.pluginId)[0];
    if (how === 'own' && top !== 0) return { pluginId: 'annai', chosen: false };
    // A keyed name annai's official plugin provides is never a third party's.
    if (first && !(Number(top) <= 1) && KEYED.has(kind) && this.#rules.official?.(kind, name)) return null;
    return first ? { pluginId: first.pluginId, chosen: false } : null;
  }

  /** Whether a choice may move a name. @param {string} kind @param {string} name */
  choosable(kind, name) {
    return !KEYED.has(kind) && this.#rules.reserved(kind, name) !== 'only';
  }

  /** A plugin's names that it doesn't own, or that the user chose: its page's Names. @param {string} pluginId @returns {Clash[]} */
  clashes(pluginId) {
    /** @type {Clash[]} */
    const out = [];
    for (const [kind, read] of Object.entries(NAMED)) {
      const all = this.#items.get(kind) ?? [];
      for (const name of new Set(all.filter((e) => e.pluginId === pluginId).map((e) => read(e.item)))) {
        const o = this.owner(kind, name);
        if (o?.pluginId === pluginId && !o.chosen) continue;
        out.push({ kind, name, owner: o?.pluginId ?? ((KEYED.has(kind) && this.#rules.official?.(kind, name)) || pluginId), used: o?.pluginId === pluginId, reserved: !this.choosable(kind, name), chosen: Boolean(o?.chosen) });
      }
    }
    return out;
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

  /** A call into a plugin worked: its run of failures is over. @param {string} pluginId */
  succeeded(pluginId) {
    this.#failures.set(pluginId, 0);
  }

  /** Counts a failure of a plugin's code that annai caught outside guard(), e.g. while reading a stream. @param {string} pluginId @param {string} name @param {unknown} e */
  fail(pluginId, name, e) {
    this.#fail(pluginId, name, e);
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

  /** Told each time a plugin is switched off after repeated errors (spec §5.5: "with a card saying why"). @param {(info: { pluginId: string, why: DisabledWhy, message: string }) => void} fn */
  onDisabled(fn) {
    this.#offs.add(fn);
    return () => this.#offs.delete(fn);
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
    if (n >= this.maxFailures) this.disable(pluginId, { kind: 'failed', count: n }, String(e?.message ?? e));
  }

  /**
   * Switches a plugin off until enable() is called (spec §5.5), and says so once: in the log and to
   * onDisabled's listeners, who make the card's words from why. @param {string} pluginId @param {DisabledWhy} why
   * @param {string} [message] the last error
   */
  disable(pluginId, why, message) {
    if (this.#disabled.has(pluginId)) return;
    this.#disabled.add(pluginId);
    const reason = disabledReason(why);
    this.#safeLog({ type: 'plugin.disabled', actor: 'system', data: { plugin: pluginId, reason, why } });
    for (const fn of this.#offs) {
      try {
        fn({ pluginId, why, message: message ?? reason });
      } catch (err) {
        console.warn('a registry listener failed', err);
      }
    }
    this.#emit();
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
