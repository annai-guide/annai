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
 * with this it answers. Calls in earlier turns go unsigned, as Gemini accepts them (test/fixtures/gemini/current-turn).
 */
export const STAND_IN_SIGNATURE = 'skip_thought_signature_validator';
/** What a blocked tool result says in its place, so its call stays answered (blocked.js). */
export const LEFT_OUT = "[Left out: Google's safety filter blocked what was here.]";
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
  if (part.type === 'audio') {
    const t = String(part.mediaType).split(';')[0].trim().toLowerCase(); // a recorder's "audio/webm;codecs=opus" is audio/webm
    return { type: 'audio', data: part.data, mime_type: AUDIO[t] ?? t };
  }
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
 * user_input, or in one of its own after tool results. A user message Google's safety filter blocked
 * (leave) is left out: its tool results say so, and the rest of it goes nowhere. from: the first message
 * to send, after a turn Google keeps (the steps before it are on its side); the steps are worked out on
 * the whole conversation all the same, so a result is named by its call and the current turn is Gemini's.
 * @param {any[]} messages @param {{ model: string, tail?: string, leave?: (m: any) => boolean, from?: number }} o @returns {Step[]}
 */
export function toInput(messages, { model, tail, leave, from = 0 }) {
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const m of messages) for (const p of m.parts) if (p.type === 'tool_call') names.set(p.id, p.name);
  /** @type {Step[]} */
  const steps = [];
  /** @type {Step[][]} each assistant message's calls */
  const replies = [];
  let first = 0;
  for (const [i, m] of messages.entries()) {
    if (i === from) first = steps.length;
    if (m.role !== 'assistant') {
      steps.push(...userSteps(m.parts, names, leave?.(m) ?? false));
      continue;
    }
    const own = assistantSteps(m.parts, model);
    steps.push(...own);
    replies.push(own.filter((s) => s.type === 'function_call'));
  }
  if (tail) {
    const last = steps.at(-1);
    if (last?.type === 'user_input') last.content.push({ type: 'text', text: tail });
    else steps.push({ type: 'user_input', content: [{ type: 'text', text: tail }] });
  }
  // The current turn, as Gemini counts it: from the last user_input that doesn't follow function results. One that does
  // (a photo or heard words with a result, the now block) is part of the turn (measured 2026-10-19). A reply of the turn
  // another model wrote gets the stand-in on its calls; Gemini's own carries its signature on its first call.
  const start = steps.findLastIndex((s, i) => s.type === 'user_input' && steps[i - 1]?.type !== 'function_result');
  for (const calls of replies) {
    if (calls.length && !calls.some((c) => c.signature) && steps.indexOf(calls[0]) > start) for (const c of calls) c.signature = STAND_IN_SIGNATURE;
  }
  return from > 0 ? steps.slice(first) : steps;
}

/** @param {any[]} parts @param {Map<string, string>} names @param {boolean} left Google blocked it @returns {Step[]} */
function userSteps(parts, names, left) {
  /** @type {Step[]} */
  const out = parts.filter((p) => p.type === 'tool_result').map((p) => ({
    type: 'function_result', call_id: p.id, name: names.get(p.id) ?? 'tool', result: [{ type: 'text', text: left ? LEFT_OUT : p.content }], ...(p.isError && !left ? { is_error: true } : {}),
  }));
  const content = left ? [] : parts.flatMap((p) => (p.type === 'tool_result' ? [] : [toContent(p)].filter((c) => c !== null)));
  if (content.length) out.push({ type: 'user_input', content });
  return out;
}

/** @param {any[]} parts @param {string} model the model the request goes to @returns {Step[]} */
function assistantSteps(parts, model) {
  const signed = (/** @type {any} */ p) => p.model === model && isObject(p.extra) && typeof p.extra.signature === 'string';
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
      // A call whose arguments were cut short kept them as text; the API takes an object.
      out.push({ type: 'function_call', id: p.id, name: p.name, arguments: isObject(p.input) ? p.input : {}, ...(signed(p) ? { signature: p.extra.signature } : {}) });
    } else if (p.type === 'provider' && p.model === model) {
      out.push(p.block);
    }
  }
  return out;
}
