// What Gemini Live's JSON messages become in the record: kinds and sizes, the transcripts, never the setup's instructions, the
// audio itself or the address (which holds the key).

/**
 * Gemini's messages, as kinds and sizes (the setup's instructions and the audio itself are not kept).
 * @param {'out' | 'in'} dir @param {string | Buffer} payload @param {number} at @returns {import('./analyse.mjs').Frame[]}
 */
export function framesOf(dir, payload, at) {
  /** @type {any} */
  let m;
  try {
    m = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
  } catch {
    return [];
  }
  /** @type {import('./analyse.mjs').Frame[]} */
  const out = [];
  const add = (/** @type {string} */ kind, /** @type {Partial<import('./analyse.mjs').Frame>} */ more = {}) => out.push({ at, dir, kind, ...more });
  const bytes = (/** @type {string} */ b64) => Math.floor((String(b64).length * 3) / 4) - (String(b64).endsWith('==') ? 2 : String(b64).endsWith('=') ? 1 : 0);
  if (dir === 'out') {
    if (m.setup) add('setup');
    const ri = m.realtimeInput;
    if (ri?.activityStart) add('activityStart');
    if (ri?.activityEnd) add('activityEnd');
    if (ri?.audio) add('audio', { bytes: bytes(ri.audio.data) });
    if (m.clientContent) add('text', { text: String(m.clientContent.turns?.[0]?.parts?.[0]?.text ?? '').slice(0, 160) });
    for (const r of m.toolResponse?.functionResponses ?? []) add('toolResponse', { name: String(r.name) });
    return out;
  }
  if (m.setupComplete) add('setupComplete');
  const sc = m.serverContent;
  for (const p of sc?.modelTurn?.parts ?? []) if (p?.inlineData?.data) add('audio', { bytes: bytes(p.inlineData.data) });
  if (sc?.inputTranscription?.text) add('heard', { text: sc.inputTranscription.text });
  if (sc?.outputTranscription?.text) add('said', { text: sc.outputTranscription.text });
  if (sc?.interrupted) add('interrupted');
  if (sc?.turnComplete) add('turnComplete');
  for (const c of m.toolCall?.functionCalls ?? []) add('toolCall', { name: String(c.name) });
  if (m.usageMetadata) add('usage');
  if (m.goAway) add('goAway');
  return out;
}
