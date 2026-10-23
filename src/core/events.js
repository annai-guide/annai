/** @typedef {import('./types.js').Store} Store */

/**
 * Appends one event to a scope in its own transaction. It names no stored content: an entry that does is written by
 * record() (agent/log.js), which holds its names to the rule of spec §4.1.
 * @param {Store} store
 * @param {string} scope
 * @param {{ type: string, actor?: string, data?: any, refs?: string[] }} ev
 */
export async function logEvent(store, scope, ev, now = Date.now()) {
  if (blobsOf(ev).length) throw new Error('A log entry that names stored content is written with record().');
  return store.tx(['events'], 'readwrite', (t) => t.appendEvent(scope, { ts: now, actor: 'system', ...ev }));
}

/** Whether a value names stored content: a SHA-256 fingerprint, 64 lowercase hex digits (spec §4.1). @param {unknown} h @returns {boolean} */
export const isName = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

/**
 * Every blob an event names: a file version's old and new content, then its refs (spec §4.5). Only fingerprints name
 * content, so a plugin's { old: 'Tokyo' } names none.
 * @param {{ data?: any, refs?: string[] }} e @returns {string[]}
 */
export function blobsOf(e) {
  return [e.data?.old, e.data?.new, ...(e.refs ?? [])].filter(isName);
}
