import { callOnce } from './call.js';
import { ProviderError, explain, sameOrigin } from './contract.js';
import { LEVELS } from './reasoning.js';
import { fromBase64 } from '../bytes.js';

/** A 16×16 red PNG: the small image the Test button sends (spec §9.8). */
export const TEST_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4IydHEmIY1TCqYfhqAACaMxgQdrf9VwAAAABJRU5ErkJggg==';
const REPORT = {
  name: 'report_color',
  description: 'Report the color of the square in the picture.',
  input: { type: 'object', properties: { color: { type: 'string', description: 'one word' } }, required: ['color'] },
};
/** @type {import('./contract.js').Request} */
const SAY_OK = { system: 'This is a connection test.', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Reply with the word OK.' }] }] };
/**
 * Room for a model that thinks before it answers, which some can't turn off (the user, 2026-10-18),
 * or the model's own limit when it is lower. @param {import('./config.js').Model} model
 */
const room = (model) => Math.min(4096, model.maxOutput ?? 4096);

/**
 * @typedef {{ step: 'access' | 'key' | 'tools' | 'images' | 'upload', ok: boolean, detail: string }} TestStep
 *   upload is advice: when it fails, photos still go in each request, so the model still passes
 * @typedef {{ type: import('./contract.js').EndpointType, endpoint: import('./config.js').Endpoint, model: import('./config.js').Model,
 *   key: string | null, fetch?: import('./call.js').Fetch, probe?: (url: string) => Promise<boolean>, firstOutputMs?: number }} TestCase
 */

/** Whether a URL is at the endpoint's own address. @param {any} endpoint @param {string} url */
const originOk = (endpoint, url) => {
  try {
    sameOrigin(endpoint, url);
    return true;
  } catch {
    return false;
  }
};

/** @param {unknown} e */
const asError = (e) => (e instanceof ProviderError ? e : new ProviderError('plugin', String(/** @type {any} */ (e)?.message ?? e)));

/**
 * The Test button (spec §9.8): one tiny request, then one with a small tool and a small image.
 * It says in plain words what works. "This address blocks web apps" is told apart from
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
    const r = await callOnce({ ...base, request: { ...SAY_OK, maxOutput: room(model) } });
    steps.push({ step: 'access', ok: true, detail: 'annai can reach this address from the browser.' });
    steps.push({ step: 'key', ok: true, detail: `The key works. The model said: "${r.text.trim().slice(0, 60)}".` });
  } catch (e) {
    const err = asError(e);
    if (err.kind === 'unreachable' && probe && type.build) {
      const { url } = type.build({ endpoint, model, key, tunables: { ...endpoint.tunables, ...model.tunables }, request: { messages: [] } });
      if (originOk(endpoint, url) && (await probe(url))) err.kind = 'blocked';
    }
    steps.push({ step: err.kind === 'auth' || err.kind === 'credit' ? 'key' : 'access', ok: false, detail: explain(err) });
    return { ok: false, steps };
  }
  const useImage = model.input.includes('image');
  const useTools = model.tools !== false;
  if (useImage || useTools) {
    // Without a picture there is no square to look at, so the question carries its answer: a model that
    // takes no photos is tested on the tool alone (the user's DeepSeek answered in words, 2026-10-18).
    const ask = !useImage ? 'The square is red. Report its color by calling report_color.'
      : useTools ? 'What color is the square? Answer by calling report_color.' : 'What color is the square? Answer in one word.';
    /** @type {import('./contract.js').Part[]} */
    const parts = [...(useImage ? [/** @type {const} */ ({ type: 'image', mediaType: 'image/png', data: TEST_IMAGE })] : []), { type: 'text', text: ask }];
    try {
      const r = await callOnce({ ...base, request: { messages: [{ role: 'user', parts }], ...(useTools ? { tools: [REPORT] } : {}), maxOutput: room(model) } });
      const call = r.parts.find((p) => p.type === 'tool_call' && p.name === REPORT.name);
      const cut = r.stop === 'length';
      if (useTools) {
        steps.push({
          step: 'tools', ok: Boolean(call),
          detail: call ? 'Tool calls work.' : cut ? 'The model ran out of room before calling the test tool; it may think at length first. Try a lower reasoning level.' : "The model answered but didn't call the test tool.",
        });
      }
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
  if (useImage && type.uploadRequest && type.readUpload && endpoint.tunables?.uploads !== false) steps.push(await testUpload(c));
  return { ok: steps.every((s) => s.ok || s.step === 'upload'), steps };
}

/** Uploads the test photo, expiring in an hour, the shortest a provider allows (spec §9.8). @param {TestCase} c @returns {Promise<TestStep>} */
async function testUpload({ type, endpoint, model, key, fetch: get = (url, init) => fetch(url, init) }) {
  try {
    const r = /** @type {NonNullable<typeof type.uploadRequest>} */ (type.uploadRequest)({
      endpoint, key, tunables: { ...endpoint.tunables, ...model.tunables }, bytes: fromBase64(TEST_IMAGE), mediaType: 'image/png', name: 'annai-test.png', expiresInSeconds: 3600,
    });
    sameOrigin(endpoint, r.url);
    const res = await get(r.url, { method: 'POST', headers: r.headers, body: r.body });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    /** @type {NonNullable<typeof type.readUpload>} */ (type.readUpload)(await res.json());
    return { step: 'upload', ok: true, detail: 'Photo uploads work: each photo is uploaded once, and expires after 48 hours.' };
  } catch {
    return { step: 'upload', ok: false, detail: "Uploading photos didn't work with this key. annai will send photos in each request instead." };
  }
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
      await callOnce({ type: c.type, endpoint: c.endpoint, model: c.model, key: c.key, fetch: c.fetch, level, firstOutputMs: c.firstOutputMs ?? 60_000, request: { ...SAY_OK, maxOutput: room(c.model) } });
      out[level] = 'ok';
    } catch (e) {
      out[level] = asError(e).kind;
    }
  }
  return out;
}
