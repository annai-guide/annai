/**
 * annai's messages as Gemini Interactions input steps: what the user said as `user_input` content,
 * the model's own steps (thought, output, calls) exactly as they came back, signatures included,
 * and tool results as `function_result` steps. Pure: no network, no annai.
 * @typedef {Record<string, any>} Step
 * @typedef {Record<string, any>} Content
 */

/**
 * The signature Google's docs give for a call no Gemini model wrote. Gemini 3 refuses a call in the
 * current turn without one (400 "invalid argument", measured 2026-10-19), as after a fallback mid-turn;
 * with this it answers. Calls in earlier turns go unsigned, as Gemini accepts them.
 */
export const STAND_IN_SIGNATURE = 'skip_thought_signature_validator';
/** Audio by the names Gemini's API takes: the phone's AAC in MP4 is m4a there. @type {Record<string, string>} */
const AUDIO = { 'audio/mp4': 'audio/m4a', 'audio/x-m4a': 'audio/m4a', 'audio/x-wav': 'audio/wav' };

/** @param {unknown} x @returns {x is Record<string, unknown>} */
const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * One part of a user message as Interactions content, or null for one that isn't sent (a photo
 * whose bytes are gone, or a part only the model writes).
 * @param {any} part @returns {Content | null}
 */
export function toContent(part) {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.missing) return null;
  if (part.type === 'image') return part.fileId ? { type: 'image', uri: part.fileId, mime_type: part.mediaType } : { type: 'image', data: part.data, mime_type: part.mediaType };
  if (part.type === 'audio') return { type: 'audio', data: part.data, mime_type: AUDIO[part.mediaType] ?? part.mediaType };
  if (part.type === 'document') return { type: 'document', data: part.data, mime_type: part.mediaType };
  return null;
}

/** A tool annai offers, as a function tool. @param {{ name: string, description: string, input: Record<string, any> }} t */
export function toolSchema(t) {
  return { type: 'function', name: t.name, description: t.description, parameters: t.input };
}

/**
 * The conversation as steps. A user message's tool results come first, then the rest as one
 * user_input. An assistant message keeps its order: thoughts this model signed, its words, its
 * calls with their signatures, and its own server-tool steps. The now block goes last, in the final
 * user_input, or in one of its own after tool results.
 * @param {any[]} messages @param {{ model: string, tail?: string }} o @returns {Step[]}
 */
export function toInput(messages, { model, tail }) {
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const m of messages) for (const p of m.parts) if (p.type === 'tool_call') names.set(p.id, p.name);
  // The current turn starts after the last user message that isn't only tool results.
  const turn = messages.findLastIndex((m) => m.role === 'user' && m.parts.some((/** @type {any} */ p) => p.type !== 'tool_result'));
  /** @type {Step[]} */
  const steps = [];
  for (const [i, m] of messages.entries()) {
    if (m.role === 'assistant') steps.push(...assistantSteps(m.parts, model, i > turn));
    else steps.push(...userSteps(m.parts, names));
  }
  if (tail) {
    const last = steps.at(-1);
    if (last?.type === 'user_input') last.content.push({ type: 'text', text: tail });
    else steps.push({ type: 'user_input', content: [{ type: 'text', text: tail }] });
  }
  return steps;
}

/** @param {any[]} parts @param {Map<string, string>} names @returns {Step[]} */
function userSteps(parts, names) {
  /** @type {Step[]} */
  const out = parts.filter((p) => p.type === 'tool_result').map((p) => ({
    type: 'function_result', call_id: p.id, name: names.get(p.id) ?? 'tool', result: [{ type: 'text', text: p.content }], ...(p.isError ? { is_error: true } : {}),
  }));
  const content = parts.flatMap((p) => (p.type === 'tool_result' ? [] : [toContent(p)].filter((c) => c !== null)));
  if (content.length) out.push({ type: 'user_input', content });
  return out;
}

/**
 * @param {any[]} parts @param {string} model the model the request goes to
 * @param {boolean} current the message is in the current turn @returns {Step[]}
 */
function assistantSteps(parts, model, current) {
  const signed = (/** @type {any} */ p) => p.model === model && isObject(p.extra) && typeof p.extra.signature === 'string';
  // The stand-in only for a reply another model wrote: Gemini's own carries its signature on its first call.
  const stand = current && !parts.some((p) => p.type === 'tool_call' && signed(p));
  /** @type {Step[]} */
  const out = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (!p.text) continue;
      const last = out.at(-1);
      if (last?.type === 'model_output') last.content[0].text += p.text;
      else out.push({ type: 'model_output', content: [{ type: 'text', text: p.text }] });
    } else if (p.type === 'reasoning') {
      if (p.signature && p.model === model) out.push({ type: 'thought', signature: p.signature, ...(p.text ? { summary: [{ type: 'text', text: p.text }] } : {}) });
    } else if (p.type === 'tool_call') {
      const signature = signed(p) ? p.extra.signature : stand ? STAND_IN_SIGNATURE : undefined;
      // A call whose arguments were cut short kept them as text; the API takes an object.
      out.push({ type: 'function_call', id: p.id, name: p.name, arguments: isObject(p.input) ? p.input : {}, ...(signature ? { signature } : {}) });
    } else if (p.type === 'provider' && p.model === model) {
      out.push(p.block);
    }
  }
  return out;
}
