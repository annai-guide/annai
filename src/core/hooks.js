/**
 * Hooks (spec §5.4: "subscribe to log appends; read-only in v1"). A watched store reports the log
 * entries each committed write appended; each running plugin's hooks get frozen copies, never of
 * an entry their own plugin caused: one it appended, or one annai logged for its fetch, model call
 * or wake (fix pass 8b-1). A plugin's hooks get at most HOOK_LIMIT entries in HOOK_WINDOW_MS; one more
 * is its failure and switches it off (§5.5, with its card), so two plugins can't feed each other for long.
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').EventRecord} EventRecord
 * @typedef {import('./registry.js').Registry} Registry
 */

/**
 * The same store, whose read-write transactions report what they appended once they have committed.
 * @param {Store} store @param {(events: EventRecord[]) => void} onAppend @returns {Store}
 */
export function watchAppends(store, onAppend) {
  return {
    tx(stores, mode, fn) {
      if (mode !== 'readwrite') return store.tx(stores, mode, fn);
      /** @type {EventRecord[]} */
      const appended = [];
      return store.tx(stores, mode, (t) => {
        appended.length = 0; // a store that tries again starts over (fix pass M1)
        return fn({
        ...t,
        appendEvent: async (scope, ev) => {
          const rec = await t.appendEvent(scope, ev);
          appended.push(rec);
          return rec;
        },
        });
      }).then((result) => {
        if (appended.length) {
          try {
            onAppend(appended);
          } catch {
            // telling the hooks must never break a write
          }
        }
        return result;
      });
    },
    close: () => store.close(),
  };
}

/** A copy nothing can change. @param {any} v @returns {any} */
function frozen(v) {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) frozen(x);
    return Object.freeze(v);
  }
  return v;
}

/** The most entries a plugin's hooks get in a window, and the window. */
export const HOOK_LIMIT = 1000;
export const HOOK_WINDOW_MS = 10_000;
const PLUGIN = /^plugin:(.+)$/;

/**
 * The plugin an entry was caused by, or null: its actor (an entry it appended), the plugin a fetch,
 * model call or decision was made for (data.tool, data.tag), or the plugin that woke Shiori.
 * @param {EventRecord} e @returns {string | null}
 */
export function causedBy(e) {
  for (const v of [e.actor, e.data?.tool, e.data?.tag]) {
    const m = typeof v === 'string' ? PLUGIN.exec(v) : null;
    if (m) return m[1];
  }
  if (e.type === 'wake' && Array.isArray(e.data?.reasons)) {
    const r = e.data.reasons.find((/** @type {any} */ x) => x?.kind === 'plugin' && typeof x.plugin === 'string');
    if (r) return r.plugin;
  }
  return null;
}

/** @type {WeakMap<Registry, Map<string, { from: number, count: number }>>} deliveries in the current window, by registry and plugin */
const windows = new WeakMap();

/**
 * Hands each running plugin's hooks the entries of the types they asked for, after the current task,
 * each call guarded: an error counts against its plugin and is never thrown here. Past HOOK_LIMIT in
 * a window, the entry is dropped, it counts as the plugin's failure, and the plugin is switched off.
 * @param {Registry} registry @param {EventRecord[]} events @param {() => number} [now]
 */
export function deliverHooks(registry, events, now = () => Date.now()) {
  const hooks = registry.entries('hook');
  if (!hooks.length) return;
  const counts = windows.get(registry) ?? new Map();
  windows.set(registry, counts);
  queueMicrotask(() => {
    for (const { pluginId, item } of hooks) {
      if (typeof item?.fn !== 'function') continue;
      const types = Array.isArray(item.types) ? item.types : null;
      for (const e of events) {
        if (causedBy(e) === pluginId || (types && !types.includes(e.type))) continue;
        if (registry.isDisabled(pluginId)) break;
        const t = now();
        let w = counts.get(pluginId);
        if (!w || t - w.from >= HOOK_WINDOW_MS) {
          w = { from: t, count: 0 };
          counts.set(pluginId, w);
        }
        if (++w.count > HOOK_LIMIT) {
          const why = `its hooks were handed more than ${HOOK_LIMIT} log entries in ${HOOK_WINDOW_MS / 1000} seconds, which looks like a loop`;
          registry.fail(pluginId, 'hook', new Error(why));
          registry.disable(pluginId, why);
          break;
        }
        registry.guard(pluginId, 'hook', item.fn)(frozen(structuredClone(e))).catch(() => {});
      }
    }
  });
}
