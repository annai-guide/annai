import { callOnce } from './call.js';
import { ProviderError, explain } from './contract.js';
import { LEVELS } from './reasoning.js';

/** A 16×16 red PNG: the small image the Test button sends (spec §9.8). */
export const TEST_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4IydHEmIY1TCqYfhqAACaMxgQdrf9VwAAAABJRU5ErkJggg==';
const REPORT = {
  name: 'report_color',
  description: 'Report the color of the square in the picture.',
  input: { type: 'object', properties: { color: { type: 'string', description: 'one word' } }, required: ['color'] },
};
/** @type {import('./contract.js').Request} */
const SAY_OK = { system: 'This is a connection test.', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Reply with the word OK.' }] }], maxOutput: 256 };

/**
 * @typedef {{ step: 'access' | 'key' | 'tools' | 'images', ok: boolean, detail: string }} TestStep
 * @typedef {{ type: import('./contract.js').EndpointType, endpoint: import('./config.js').Endpoint, model: import('./config.js').Model,
 *   key: string | null, fetch?: import('./call.js').Fetch, probe?: (url: string) => Promise<boolean>, firstOutputMs?: number }} TestCase
 */

/** @param {unknown} e */
const asError = (e) => (e instanceof ProviderError ? e : new ProviderError('plugin', String(/** @type {any} */ (e)?.message ?? e)));

/**
 * The Test button (spec §9.8): one tiny request, then one with a small tool and a small image.
 * It says in plain words what works. "This endpoint blocks web apps" is told apart from
 * "annai couldn't reach it" by asking again in a way that skips the browser's access check
 * (the probe), which only reaches a server that is there.
 * @param {TestCase} c @returns {Promise<{ ok: boolean, steps: TestStep[] }>}
 */
export async function testModel(c) {
  const { type, endpoint, model, key, probe } = c;
  const base = { type, endpoint, model, key, fetch: c.fetch, firstOutputMs: c.firstOutputMs ?? 60_000, level: 'off' };
  /** @type {TestStep[]} */
  const steps = [];
  try {
    const r = await callOnce({ ...base, request: SAY_OK });
    steps.push({ step: 'access', ok: true, detail: 'annai can reach this endpoint from the browser.' });
    steps.push({ step: 'key', ok: true, detail: `The key works. The model said: "${r.text.trim().slice(0, 60)}".` });
  } catch (e) {
    const err = asError(e);
    if (err.kind === 'unreachable' && probe && type.build) {
      const { url } = type.build({ endpoint, model, key, tunables: { ...endpoint.tunables, ...model.tunables }, request: { messages: [] } });
      if (await probe(url)) err.kind = 'blocked';
    }
    steps.push({ step: err.kind === 'auth' || err.kind === 'credit' ? 'key' : 'access', ok: false, detail: explain(err) });
    return { ok: false, steps };
  }
  const useImage = model.input.includes('image');
  const useTools = model.tools !== false;
  if (useImage || useTools) {
    const ask = useTools ? 'What color is the square? Answer by calling report_color.' : 'What color is the square? Answer in one word.';
    /** @type {import('./contract.js').Part[]} */
    const parts = [...(useImage ? [/** @type {const} */ ({ type: 'image', mediaType: 'image/png', data: TEST_IMAGE })] : []), { type: 'text', text: ask }];
    try {
      const r = await callOnce({ ...base, request: { messages: [{ role: 'user', parts }], ...(useTools ? { tools: [REPORT] } : {}), maxOutput: 512 } });
      const call = r.parts.find((p) => p.type === 'tool_call' && p.name === REPORT.name);
      if (useTools) steps.push({ step: 'tools', ok: Boolean(call), detail: call ? 'Tool calls work.' : "The model answered but didn't call the test tool." });
      if (useImage) {
        const answer = call?.type === 'tool_call' ? JSON.stringify(call.input) : r.text;
        const red = /red/i.test(answer);
        steps.push({ step: 'images', ok: red, detail: red ? 'Photos work: it saw the red square.' : `It didn't see the red square (it said ${answer.slice(0, 60)}).` });
      }
    } catch (e) {
      const err = asError(e);
      steps.push({ step: err.kind === 'image' || !useTools ? 'images' : 'tools', ok: false, detail: explain(err) });
    }
  }
  return { ok: steps.every((s) => s.ok), steps };
}

/**
 * "The Test button can try each level and record which ones work" (spec §9.3).
 * @param {TestCase} c @returns {Promise<Record<string, string>>} level → "ok", or the kind of error
 */
export async function testLevels(c) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const level of LEVELS.filter((l) => Object.hasOwn(c.model.reasoning ?? {}, l))) {
    try {
      await callOnce({ type: c.type, endpoint: c.endpoint, model: c.model, key: c.key, fetch: c.fetch, level, firstOutputMs: c.firstOutputMs ?? 60_000, request: SAY_OK });
      out[level] = 'ok';
    } catch (e) {
      out[level] = asError(e).kind;
    }
  }
  return out;
}
