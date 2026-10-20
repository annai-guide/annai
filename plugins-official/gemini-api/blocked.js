/**
 * Messages Google's safety filter blocked. The whole conversation goes to Gemini every turn, and a block
 * ends a turn as a refusal, so one blocked message would have every later turn refused too. Once Gemini
 * refuses a request for safety, its last user message stays out of what Gemini is sent from then on; it
 * stays in the conversation, and other models still get it. Each is kept by a fingerprint of its content,
 * never the content, in the plugin's own settings file (/plugin-settings/gemini-api.json, named as everything
 * stored is, spec §4.9), the latest 200.
 */
const MAX = 200;

/** @param {string} s @param {number} seed FNV-1a, 32 bits, as hex */
function fnv(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** @param {unknown} data a sample of base64: its length, start and end */
const sample = (data) => {
  const s = String(data ?? '');
  return `${s.length}:${s.slice(0, 64)}:${s.slice(-64)}`;
};

/**
 * A message's fingerprint: its words, a photo by its hash (an upload's id aside), audio and documents by a sample.
 * @param {{ parts: any[] }} m @returns {string}
 */
export function fingerprint(m) {
  const s = m.parts.map((p) => (p.type === 'text' ? `t${p.text}` : p.type === 'tool_result' ? `r${p.id}\u0001${p.content}`
    : p.type === 'image' ? `i${p.hash ?? sample(p.data)}` : p.type === 'audio' || p.type === 'document' ? `${p.type}${sample(p.data)}` : p.type)).join('\u0000');
  return fnv(s, 0x811c9dc5) + fnv(s, 0x2166136a);
}

/**
 * What Google blocked, read from the plugin's settings when it starts, and kept there.
 * @param {{ get?: () => Promise<any>, set?: (changes: any) => Promise<unknown> } | undefined} settings annai.settings
 */
export function blockedMessages(settings) {
  /** @type {string[]} */
  let kept = [];
  settings?.get?.().then((s) => {
    if (Array.isArray(s?.blocked)) kept = [...new Set([...s.blocked.filter((x) => typeof x === 'string'), ...kept])].slice(-MAX);
  }).catch(() => {});
  return {
    /** Whether a user message is one Google blocked. @param {{ parts: any[] }} m */
    has: (m) => kept.length > 0 && kept.includes(fingerprint(m)),
    /** Leaves out a request's last user message from now on; false when it has none. @param {any[]} messages */
    add(messages) {
      const m = messages.findLast((x) => x.role === 'user');
      if (!m) return false;
      const fp = fingerprint(m);
      if (!kept.includes(fp)) {
        kept = [...kept, fp].slice(-MAX);
        settings?.set?.({ blocked: kept })?.catch?.(() => {});
      }
      return true;
    },
  };
}
