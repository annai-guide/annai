/**
 * Hooks (spec §5.4: "subscribe to log appends; read-only in v1"). A watched store reports the log
 * entries each committed write appended; each running plugin's hooks get frozen copies, never of
 * an entry their own plugin appended (so a hook that logs can't feed itself).
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
      return store.tx(stores, mode, (t) => fn({
        ...t,
        appendEvent: async (scope, ev) => {
          const rec = await t.appendEvent(scope, ev);
          appended.push(rec);
          return rec;
        },
      })).then((result) => {
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

/**
 * Hands each running plugin's hooks the entries of the types they asked for, after the current task,
 * each call guarded: an error counts against its plugin and is never thrown here.
 * @param {Registry} registry @param {EventRecord[]} events
 */
export function deliverHooks(registry, events) {
  const hooks = registry.entries('hook');
  if (!hooks.length) return;
  queueMicrotask(() => {
    for (const { pluginId, item } of hooks) {
      if (typeof item?.fn !== 'function') continue;
      const types = Array.isArray(item.types) ? item.types : null;
      for (const e of events) {
        if (e.actor === `plugin:${pluginId}` || (types && !types.includes(e.type))) continue;
        registry.guard(pluginId, 'hook', item.fn)(frozen(structuredClone(e))).catch(() => {});
      }
    }
  });
}
