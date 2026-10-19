/**
 * Coming back to annai's address (decision 16): a plugin that sends the browser away to sign in says it
 * expects a return. The next load of annai's address with a query, within 15 minutes, is that plugin's,
 * once; any other query is no one's.
 * @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} KeyValue
 */
const SLOT = 'annai.return';
const MAX_AGE = 15 * 60_000;

/** Notes that a plugin expects annai's address back. @param {string} pluginId @param {{ storage?: KeyValue, now?: number }} [o] */
export function expectReturn(pluginId, { storage = localStorage, now = Date.now() } = {}) {
  storage.setItem(SLOT, JSON.stringify({ plugin: pluginId, at: now }));
}

/**
 * Whose return this page load is, or null; the note is used up by any query.
 * @param {string} search @param {{ storage?: KeyValue, now?: number }} [o]
 * @returns {{ plugin: string, params: URLSearchParams } | null}
 */
export function returnFor(search, { storage = localStorage, now = Date.now() } = {}) {
  const params = new URLSearchParams(search);
  if (!params.size) return null;
  /** @type {any} */
  let note = null;
  try {
    note = JSON.parse(storage.getItem(SLOT) ?? 'null');
  } catch {
    // unreadable: no one's
  }
  storage.removeItem(SLOT);
  const fresh = typeof note?.plugin === 'string' && typeof note.at === 'number' && now >= note.at && now - note.at <= MAX_AGE;
  return fresh ? { plugin: note.plugin, params } : null;
}
