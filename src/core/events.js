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

/**
 * Every blob an event points at: a file version's old and new content, then its refs (spec §4.5).
 * @param {{ data?: any, refs?: string[] }} e @returns {string[]}
 */
export function blobsOf(e) {
  /** @type {string[]} */
  const out = [];
  for (const h of [e.data?.old, e.data?.new]) if (typeof h === 'string') out.push(h);
  for (const r of e.refs ?? []) if (typeof r === 'string') out.push(r);
  return out;
}
