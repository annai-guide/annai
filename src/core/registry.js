/** Words said of plugins in several places. */
const OWN = "annai's own plugin uses this name";
/** A package from elsewhere can't take one of annai's own ids (security review). */
export const TAKEN = `${OWN}, so a package from elsewhere can't have it. Ask its author to rename it.`;
/** One from elsewhere that holds one is never used as annai's own (security review). */
export const NOT_OWN = `${OWN}, but the one installed came from elsewhere, so annai won't use it. Remove it in Settings → Plugins, then try again.`;
/** A plugin the user switched off stays off (security review). */
export const TURN_ON = 'Turn it on in Settings → Plugins, then try again.';

/** A named item's name, read from its field f. */
const by = (/** @type {string} */ f) => (/** @type {any} */ x) => String(x?.[f]);
/** The kinds whose items have a name one plugin holds (milestone 6), with how it is read; hooks and adding slots never clash. @type {Record<string, (item: any) => string>} */
export const NAMED = Object.freeze({
  tool: by('name'), 'endpoint-type': by('type'), 'storage-type': by('type'), skill: by('name'), personality: by('name'), 'ui:component': by('name'), 'ui:card-type': by('type'), search: by('id'),
});
/** Kinds handed the keys the user gives: a protocol gets a provider's, a kind of backup place a place's. Rank alone owns them, never a choice. */
export const KEYED = new Set(['endpoint-type', 'storage-type']);

/**
 * How a name's owner is found. rank: lower first (built-ins 0, official 1, third-party 2, then install time, then id);
 * choice: the user's; reserved: 'only' for a name annai keeps (the loop's own tools), 'own' for one annai has its own
 * of (its components, a built-in's provides), used unless the user chooses a plugin's.
 * official: the official plugin whose manifest provides a keyed name, which nobody else owns.
 * @typedef {{ rank: (pluginId: string) => (number | string)[], choice: (kind: string, name: string) => string | undefined,
 *   reserved: (kind: string, name: string) => 'only' | 'own' | null, official?: (kind: string, name: string) => string | undefined }} Rules
 * @typedef {{ kind: string, name: string, owner: string, used: boolean, reserved: boolean, chosen: boolean }} Clash
 *   reserved: no choice can change the owner
 */
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
export class Registry {
  /** @type {Map<string, { pluginId: string, item: any, seq: number }[]>} */ #items = new Map();
  #seq = 0;
  /** @type {Rules} */ #rules = FIRST;
  /** @type {Map<string, number>} */ #failures = new Map();
  /** @type {Set<string>} */ #disabled = new Set();
  /** @type {Set<() => void>} */ #listeners = new Set();
  /** @type {Set<(info: { pluginId: string, reason: string, message: string }) => void>} */ #offs = new Set();

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

  /** Contributions of a kind from plugins that are not switched off; of a named kind, each name's owner's. @param {string} kind */
  list(kind) {
    return this.entries(kind).map((e) => e.item);
  }

  /**
   * Contributions of a kind with the plugin each came from: of a named kind, one per name, its owner's. all:
   * every one, also those not used and those of plugins switched off after repeated errors.
   * @param {string} kind @param {{ all?: boolean }} [o] @returns {{ pluginId: string, item: any }[]}
   */
  entries(kind, { all = false } = {}) {
    const name = NAMED[kind];
    /** @type {Map<string, string | undefined>} */
    const owners = new Map();
    const live = (this.#items.get(kind) ?? []).filter((e) => all || !this.#disabled.has(e.pluginId));
    return live.filter((e) => {
      if (all || !name) return true;
      const n = name(e.item);
      if (!owners.has(n)) owners.set(n, this.owner(kind, n)?.pluginId);
      if (owners.get(n) !== e.pluginId) return false;
      owners.set(n, undefined); // one per name: a second of the owner's own isn't used
      return true;
    }).map((e) => ({ pluginId: e.pluginId, item: e.item }));
  }

  /** How owners are found from now on (see Rules); screens draw again. @param {Rules} rules */
  setRules(rules) {
    this.#rules = rules;
    this.#emit();
  }

  /**
   * Who owns a name of a named kind: annai for a reserved name, else the plugin the user chose while it runs and
   * registers it, else the lowest rank among those running (annai, for a name it has its own of, when no
   * built-in registered it). null: nobody. @param {string} kind @param {string} name
   * @returns {{ pluginId: string, chosen: boolean } | null}
   */
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
    // A keyed name annai's official plugin provides is a built-in's or an official's, or nobody's: never a third party's.
    if (first && !(Number(top) <= 1) && KEYED.has(kind) && this.#rules.official?.(kind, name)) return null;
    return first ? { pluginId: first.pluginId, chosen: false } : null;
  }

  /** Whether the user's choice may move a name: not one annai keeps, nor a protocol's or a kind of backup place's. @param {string} kind @param {string} name */
  choosable(kind, name) {
    return !KEYED.has(kind) && this.#rules.reserved(kind, name) !== 'only';
  }

  /**
   * The names a plugin registers that someone else also has, or that the user chose for, with their owners: what
   * its page says (Not used, or used by choice). @param {string} pluginId @returns {Clash[]}
   */
  clashes(pluginId) {
    /** @type {Clash[]} */
    const out = [];
    for (const [kind, read] of Object.entries(NAMED)) {
      const all = this.#items.get(kind) ?? [];
      for (const name of new Set(all.filter((e) => e.pluginId === pluginId).map((e) => read(e.item)))) {
        const o = this.owner(kind, name);
        const others = all.some((e) => e.pluginId !== pluginId && !this.#disabled.has(e.pluginId) && read(e.item) === name);
        if (o?.pluginId === pluginId && !o.chosen && !others) continue;
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

  /** Told each time a plugin is switched off after repeated errors (spec §5.5: "with a card saying why"). @param {(info: { pluginId: string, reason: string, message: string }) => void} fn */
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
    if (n >= this.maxFailures) this.disable(pluginId, `failed ${n} times in a row`, String(e?.message ?? e));
  }

  /**
   * Switches a plugin off until enable() is called (spec §5.5), and says so once: in the log and to
   * onDisabled's listeners. @param {string} pluginId @param {string} reason @param {string} [message] the last error
   */
  disable(pluginId, reason, message = reason) {
    if (this.#disabled.has(pluginId)) return;
    this.#disabled.add(pluginId);
    this.#safeLog({ type: 'plugin.disabled', actor: 'system', data: { plugin: pluginId, reason } });
    for (const fn of this.#offs) {
      try {
        fn({ pluginId, reason, message });
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
