/**
 * Quick decisions (spec §9.7): decide({prompt, options}) → {optionId: probability}. A chat model
 * is shown the options as A, B, C…. Where it reports token probabilities, those over the letters
 * are the answer; otherwise its choice counts with confidence 1.0. Below the threshold, the main
 * model decides.
 * @typedef {import('./contract.js').Request} Request
 * @typedef {{ id: string, label: string }} Option
 * @typedef {(role: string, request: Request) => Promise<{ reply: { parts: import('./contract.js').Part[], text: string, logprobs?: { token: string, logprob: number }[] } }>} Call
 */

export const DECIDE_THRESHOLD = 0.6;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SYSTEM = 'You make one quick decision. Answer with the letter of the best option and nothing else.';

/**
 * @param {{ prompt: string, options: Option[], threshold?: number, call: Call, logprobs?: boolean, parts?: import('./contract.js').Part[], fallback?: boolean }} c
 *   parts: more of the question, such as heard speech (spec §10.4); fallback false: below the threshold, or with no readable answer, the
 *   result is 'unsure' and the main model isn't asked
 * @returns {Promise<{ probabilities: Record<string, number>, by: 'decide' | 'main' | 'unsure' }>}
 */
export async function decide({ prompt, options, threshold = DECIDE_THRESHOLD, call, logprobs = false, parts = [], fallback = true }) {
  if (options.length < 2 || options.length > LETTERS.length) throw new Error('A decision needs 2 to 26 options.');
  const letters = LETTERS.slice(0, options.length).split('');
  const text = `${prompt}\n\n${options.map((o, i) => `${letters[i]}. ${o.label}`).join('\n')}`;
  const messages = [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text }, ...parts] }];
  const tool = { name: 'decide', description: 'Choose one option by its letter.', input: { type: 'object', properties: { option: { enum: letters } }, required: ['option'] } };
  /** @type {Awaited<ReturnType<Call>> | null} */
  let first = null;
  try {
    first = await call('decide', logprobs
      ? { system: SYSTEM, messages, maxOutput: 1, logprobs: 10 }
      : { system: SYSTEM, messages, tools: [tool], toolChoice: 'decide', maxOutput: 64 });
  } catch {
    // A decide model that thinks refuses a forced tool (Opus and Sonnet 5.5): the main model decides, by letter.
  }
  const spread = first ? read(first.reply, letters) : null;
  if (spread && Math.max(...spread) >= threshold) return { probabilities: byId(options, spread), by: 'decide' };
  if (!fallback) return { probabilities: spread ? byId(options, spread) : {}, by: 'unsure' };
  // Not sure enough, or no readable answer: the main model decides, by letter (it may be thinking, which forced tools don't allow).
  const second = await call('main', { system: SYSTEM, messages, maxOutput: 64 });
  const chosen = read({ ...second.reply, logprobs: undefined }, letters) ?? letters.map((_, i) => (i === 0 ? 1 : 0));
  return { probabilities: byId(options, chosen), by: 'main' };
}

/**
 * Probabilities per letter from a reply, or null when it gives none.
 * @param {{ parts: any[], text: string, logprobs?: { token: string, logprob: number }[] }} reply @param {string[]} letters
 * @returns {number[] | null}
 */
function read(reply, letters) {
  if (reply.logprobs?.length) {
    const p = letters.map(() => 0);
    for (const { token, logprob } of reply.logprobs) {
      const i = letters.indexOf(String(token).trim().toUpperCase());
      if (i >= 0 && Number.isFinite(logprob)) p[i] += Math.exp(logprob);
    }
    const sum = p.reduce((a, b) => a + b, 0);
    if (sum > 0) return p.map((x) => x / sum);
  }
  const called = reply.parts.find((p) => p.type === 'tool_call' && p.name === 'decide');
  const letter = String(called?.input?.option ?? /^\s*\(?([A-Z])\b/.exec(reply.text ?? '')?.[1] ?? '').toUpperCase();
  const i = letters.indexOf(letter);
  return i >= 0 ? letters.map((_, j) => (j === i ? 1 : 0)) : null;
}

/** @param {Option[]} options @param {number[]} p @returns {Record<string, number>} */
function byId(options, p) {
  return Object.fromEntries(options.map((o, i) => [o.id, p[i]]));
}
