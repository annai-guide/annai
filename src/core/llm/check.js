import { callOnce } from './call.js';
import { ProviderError, typeError, explain, sameOrigin, noRedirect } from './contract.js';
import { LEVELS, nearestLevel } from './reasoning.js';
import { fromBase64 } from '../bytes.js';
import { TEST_UPLOAD, REQUEST_MS, deleteUpload, sweepUploads } from './uploads.js';
import { t } from '../l10n.js';
import { sentences } from '../intl.js';

/** A 16×16 red PNG: the small image the Test button sends (spec §9.8). */
export const TEST_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4IydHEmIY1TCqYfhqAACaMxgQdrf9VwAAAABJRU5ErkJggg==';
/* en */
const REPORT = {
  name: 'report_color',
  description: 'Report the color of the square in the picture.',
  input: { type: 'object', properties: { color: { type: 'string', description: 'one word' } }, required: ['color'] },
};
/** @type {import('./contract.js').Request} */
const SAY_OK = { system: /* en */ 'This is a connection test.', messages: [{ role: 'user', parts: [{ type: 'text', text: /* en */ 'Reply with the word OK.' }] }] };
/**
 * Room for a model that thinks before it answers, which some can't turn off,
 * or the model's own limit when it is lower. @param {import('./config.js').Model} model
 */
const room = (model) => Math.min(4096, model.maxOutput ?? 4096);

/**
 * @typedef {{ step: 'access' | 'key' | 'tools' | 'images' | 'level' | 'upload' | 'live', ok: boolean, detail: string }} TestStep
 *   upload is advice: when it fails, photos still go in each request, so the model still passes; live: a realtime model answered aloud
 * @typedef {{ type: import('./contract.js').EndpointType, endpoint: import('./config.js').Endpoint, model: import('./config.js').Model,
 *   key: string | null, fetch?: import('./call.js').Fetch, probe?: (url: string) => Promise<boolean>, firstOutputMs?: number,
 *   role?: { id: string, level: string }, uploads?: import('./uploads.js').Uploads, ability?: import('./config.js').Ability }} TestCase  ability: the endpoint's, for its name where annai says its address is wrong; role: a role asking this model at a level of its own (main, koe-classic or utility);
 *   uploads: the endpoints' uploads, turned off where Test's own upload fails, or annai can't delete the test photo or read the list, and on again where Test passes
 *   detail: what the step found, in the screens' language
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
  const base = { type, endpoint, ability: c.ability, model, key, fetch: c.fetch, firstOutputMs: c.firstOutputMs ?? 60_000, level: 'off' };
  /** @type {TestStep[]} */
  const steps = [];
  try {
    const r = await callOnce({ ...base, request: { ...SAY_OK, maxOutput: room(model) } });
    steps.push({ step: 'access', ok: true, detail: t`annai can reach this address from the browser.` });
    steps.push({ step: 'key', ok: true, detail: t`The key works. The model said: "${r.text.trim().slice(0, 60)}".` });
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
    // takes no photos is tested on the tool alone (DeepSeek answered in words).
    /* en */
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
          detail: call ? t`Tool calls work.` : cut ? t`The model ran out of room before calling the test tool; it may think at length first. Try a lower reasoning level.` : t`The model answered but didn't call the test tool.`,
        });
      }
      if (useImage) {
        const answer = call?.type === 'tool_call' ? JSON.stringify(call.input) : r.text;
        const red = /red/i.test(answer);
        steps.push({ step: 'images', ok: red, detail: red ? t`Photos work: it saw the red square.` : t`It didn't see the red square (it said ${answer.slice(0, 60)}).` });
      }
    } catch (e) {
      const err = asError(e);
      steps.push({ step: err.kind === 'image' || !useTools ? 'images' : 'tools', ok: false, detail: explain(err) });
    }
  }
  // What the role will send, if not off's.
  const { role } = c;
  if (role && nearestLevel(model.reasoning, role.level) !== nearestLevel(model.reasoning, 'off')) {
    try {
      await callOnce({ ...base, level: role.level, request: { ...SAY_OK, maxOutput: room(model) } });
      steps.push({ step: 'level', ok: true, detail: alsoAnswers(role) });
    } catch (e) {
      const err = asError(e);
      // Only a provider that read the request and refused it (REFUSALS: a 400, a 413 or a 404) refused the level, and the level is the
      // traveller's to lower; a key, credit, a rate or time limit, a server's failure or a dropped connection says nothing about it.
      steps.push({ step: 'level', ok: false, detail: REFUSALS.has(err.kind) ? sentences(refusedAt(role, err.message), lowerLevel(role)) : explain(err) });
    }
  }
  if (useImage && type.uploadRequest && type.readUpload && endpoint.tunables?.uploads !== false) steps.push(await testUpload(c));
  return { ok: steps.every((s) => s.ok || s.step === 'upload'), steps };
}

/**
 * Uploads the test photo, expiring in an hour, the shortest a provider allows (spec §9.8). An upload that fails turns uploads off there,
 * as a call's does: photos go in each request until annai restarts, or a new key or address, or a Test that passes. Where the provider
 * keeps files until they are deleted, annai then deletes the photo by the id the upload gave, as it will delete each photo: a key that
 * can't (a refusal, a 404 for the file it just made, or any other 4xx but a 408 or a 429) turns them off the same way; a delete that
 * gets no answer, a 408, a 429 or a server error says nothing about the key, and the upload worked, so photos stay on and the sweep
 * deletes the test photo with the others. A delete that passes reads the list once, as a sweep does (Uploads.listed).
 * @param {TestCase} c @returns {Promise<TestStep>}
 */
async function testUpload({ type, endpoint, model, key, fetch: get = (url, init) => fetch(url, init), uploads }) {
  /** @type {{ id: string }} */
  let up;
  /** @type {Response | undefined} */
  let res;
  try {
    const r = /** @type {NonNullable<typeof type.uploadRequest>} */ (type.uploadRequest)({
      endpoint, key, tunables: { ...endpoint.tunables, ...model.tunables }, bytes: fromBase64(TEST_IMAGE), mediaType: 'image/png', name: TEST_UPLOAD, expiresInSeconds: 3600,
    });
    sameOrigin(endpoint, r.url);
    // The sweeps' time limit for each list or delete request (REQUEST_MS): a stall ends in no answer, as a failed connection does (a 2xx's body included; a failed
    // answer's body that stalls or breaks off is read as empty, and its status decides).
    res = await get(r.url, { method: 'POST', headers: r.headers, body: r.body, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_MS) });
    noRedirect(res, endpoint);
    // A failed answer is read as the first step reads it (typeError: the protocol's and the provider's reading first; a body that breaks off is read as empty), but a 408,
    // which is no answer. A 402, a 429 or a server error says nothing about the key. Unlike after the delete below, where the upload worked, uploads go off for each.
    if (!res.ok) throw res.status === 408 ? new ProviderError('unreachable', 'HTTP 408') : typeError(type, res.status, await res.text().catch(() => ''), res.headers);
    // A body that breaks off or stalls is no answer, as the sweep's list reads it; only a body that arrived and isn't an upload is the key's.
    const body = await res.text().catch(() => {
      throw new ProviderError('unreachable', 'no answer');
    });
    up = /** @type {NonNullable<typeof type.readUpload>} */ (type.readUpload)(JSON.parse(body));
  } catch (e) {
    // The key's words are for an answer that refused the key or wasn't an upload. A redirect, no answer (no reply, a stall, a 2xx body that broke off, a 408), a 402, a 429
    // and a server error are not the key's: each but no answer is read as the first step reads it; no answer says annai couldn't reach the address.
    const said = e instanceof ProviderError ? (['redirect', 'unreachable', 'rate', 'credit', 'overloaded', 'server'].includes(e.kind) ? e : null) : !res ? new ProviderError('unreachable', 'no answer') : null;
    // As a call's failed upload does, so the words are true: photos go in each request until annai restarts, or a new key or address, or a Test that passes.
    uploads?.off(endpoint.id);
    return { step: 'upload', ok: false, detail: sentences(said ? explain(said) : t`Uploading photos didn't work with this key.`, t`annai will send photos in each request instead.`) };
  }
  if (!type.deleteUploadRequest) {
    uploads?.retry(endpoint.id);
    return { step: 'upload', ok: true, detail: t`Photo uploads work: each photo is uploaded once, and expires after 48 hours.` };
  }
  const status = await deleteUpload({ type, endpoint, key, fetch: get, id: up.id });
  if (status >= 200 && status < 300) {
    // The list too: the sweep deletes what is over 48 hours old by it, so a list annai can't read means files it couldn't find.
    if (uploads?.listed(endpoint.id, await sweepUploads({ type, endpoint, key, fetch: get }).catch(() => null), { test: true })) {
      return { step: 'upload', ok: false, detail: sentences(t`Photos upload, but annai can't read the list of its photos there, which it needs to delete them.`, t`annai will send photos in each request instead.`) };
    }
    uploads?.retry(endpoint.id);
    return { step: 'upload', ok: true, detail: t`Photo uploads work: each photo is uploaded once, and annai deletes it after 48 hours (it just deleted the test photo).` };
  }
  if (status === 0 || status === 408 || status === 429 || status >= 500) {
    return { step: 'upload', ok: false, detail: sentences(t`Photos upload, but annai couldn't check just now that it can delete the test photo.`, t`Tap Test again later. annai deletes the test photo with the others, after 48 hours.`) };
  }
  uploads?.off(endpoint.id);
  return { step: 'upload', ok: false, detail: sentences(t`Photos upload, but annai couldn't delete the test photo with this key.`, t`annai will send photos in each request instead.`) };
}

/**
 * The error kinds of an answer that refused the request itself (kindOf: a 400 by its words, a 413 by its status). Not-found is one too: the
 * access step just reached this model at this address, so a 404 at the level step is the level's.
 */
const REFUSALS = new Set(['bad-request', 'context', 'image', 'not-found']);
/** A role by the name the screens give it, a label of its own. @param {{ id: string }} role */
const roleName = ({ id }) => (id === 'koe-classic' ? t`Koe · Chat` : id === 'utility' ? t`Utility` : t`Main`);
/** @param {{ id: string, level: string }} role */
const alsoAnswers = (role) => t`It also answers at ${roleName(role)}'s level (${role.level}).`;
/** @param {{ id: string, level: string }} role @param {string} said the model's refusal, as it gave it */
const refusedAt = (role, said) => t`At ${roleName(role)}'s level (${role.level}), this model refused: ${said}`;
/** @param {{ id: string }} role */
const lowerLevel = (role) => t`Lower ${roleName(role)}'s level in Settings → Models, or change this model's Reasoning levels on its page.`;

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
