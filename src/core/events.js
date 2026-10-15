/** @typedef {import('./types.js').Store} Store */

/**
 * Appends one event to a scope in its own transaction.
 * @param {Store} store
 * @param {string} scope
 * @param {{ type: string, actor?: string, data?: any, refs?: string[] }} ev
 */
export function logEvent(store, scope, ev, now = Date.now()) {
  return store.tx(['events'], 'readwrite', (t) => t.appendEvent(scope, { ts: now, actor: 'system', ...ev }));
}
