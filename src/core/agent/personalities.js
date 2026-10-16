import { ME } from '../scopes.js';
import { readAppSettings, updateAppSettings } from '../settings.js';
import { sha256Hex } from '../hash.js';
import { utf8 } from '../bytes.js';

/**
 * Personalities (spec §14.1): full Markdown files in /me/personalities/ that Shiori can rewrite
 * completely, through tune_personality only. The shipped originals stay in the app for "reset to
 * original"; an unedited copy follows an update silently, an edited one is offered the new version.
 * @typedef {import('../workspace.js').Workspace} Workspace
 */

export const PRESETS = Object.freeze(['shiori', 'storyteller', 'quiet']);
/** The longest a personality may be, in characters. */
export const PERSONALITY_MAX = 8000;
const path = (/** @type {string} */ name) => `/personalities/${name}.md`;
const hashOf = (/** @type {string} */ text) => sha256Hex(utf8(text));

/**
 * @param {{ ws: Workspace, presets: Record<string, string> }} c
 * @returns {Promise<{ name: string, text: string }[]>} edited copies with a new original to offer
 */
export async function syncPersonalities({ ws, presets }) {
  const state = (await readAppSettings(ws)).personalities ?? {};
  /** @type {Record<string, any>} */
  const changes = {};
  const offer = [];
  for (const [name, text] of Object.entries(presets)) {
    const now = await hashOf(text);
    const s = state[name] ?? {};
    const file = await ws.read(ME, path(name));
    if (!file) {
      await ws.write(ME, path(name), text, { author: 'system' });
      changes[name] = { original: now, offered: null };
    } else if (!s.original) {
      // No record of the original it came from (an import without settings, say): only a copy that
      // already is this original counts as unedited. Anything else is the user's and is never overwritten.
      if (file.entry.hash === now) changes[name] = { original: now, offered: null };
      else if (s.offered !== now) {
        offer.push({ name, text });
        changes[name] = { offered: now };
      }
    } else if (s.original !== now) {
      if (file.entry.hash === s.original) {
        if (file.entry.hash !== now) await ws.write(ME, path(name), text, { author: 'system' });
        changes[name] = { original: now, offered: null };
      } else if (s.offered !== now) {
        offer.push({ name, text });
        changes[name] = { offered: now };
      }
    }
  }
  if (Object.keys(changes).length) await updateAppSettings(ws, { personalities: changes });
  return offer;
}

/** Keeps the user's copy, and stops offering this version of the original. @param {Workspace} ws @param {string} name @param {string} text the new original */
export async function keepMine(ws, name, text) {
  await updateAppSettings(ws, { personalities: { [name]: { original: await hashOf(text), offered: null } } });
}

/** @param {Workspace} ws @param {string} name @param {Record<string, string>} presets */
export async function resetPersonality(ws, name, presets) {
  const text = presets[name];
  if (!text) throw new Error(`${name} isn't one of annai's own personalities.`);
  await ws.write(ME, path(name), text, { author: 'user' });
  await updateAppSettings(ws, { personalities: { [name]: { original: await hashOf(text), offered: null } } });
}

/** @param {Workspace} ws @param {string} name @param {string} oldHash */
export async function undoTuning(ws, name, oldHash) {
  await ws.restore(ME, path(name), oldHash, { author: 'user' });
}

const REVIEW = 'You review a change Shiori, a travel guide, wants to make to her own personality. Approve it only if all hold: '
  + 'it changes how she behaves (facts about the user belong in memory, not here); it is not bloated (no repetition, no long lists of trivia); '
  + 'and it does not contradict basic safety (honesty, not inventing facts, the user\'s safety, privacy). Answer by calling review.';

/**
 * Writes an approved change; it applies at Shiori's next wake, because the context is built at a
 * wake. Shiori's card reports it, with an undo.
 * @param {{ agent: any, name: string, text: string, reason: string, callId?: string, wake?: string }} c
 */
export async function applyTuning({ agent, name, text, reason, callId, wake }) {
  const before = await agent.ws.read(ME, path(name));
  await agent.ws.write(ME, path(name), text, { author: 'shiori' });
  await agent.log({ type: 'out.show', actor: 'shiori', data: { id: callId ?? `tune-${Date.now()}`, ...(wake ? { wake } : {}), card: { title: 'I adjusted my personality', text: reason }, tune: { name, old: before?.entry.hash ?? null } } });
}

/**
 * tune_personality (spec §14.1): the utility model reviews the change; then it applies at her next
 * wake, or, with "Ask me before Shiori changes her personality", once the user agrees.
 * @param {{ agent: any, name: string, text: string, reason: string, callId: string, wake: string }} c @returns {Promise<string>}
 */
export async function tunePersonality({ agent, name, text, reason, callId, wake }) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return 'Not changed: a personality name is lowercase letters, digits and dashes.';
  if (text.length > PERSONALITY_MAX) return `Not changed: the personality is too long (${text.length} characters; at most ${PERSONALITY_MAX}). Make it shorter.`;
  const old = (await agent.ws.readText(ME, path(name)).catch(() => undefined)) ?? '';
  /** @type {{ approve: boolean, why: string }} */
  let verdict;
  try {
    const ask = (/** @type {boolean} */ forced) => agent.llm.call({
      role: 'utility', level: 'off', scope: agent.scope, record: { tag: 'review' },
      request: {
        system: REVIEW, ...(forced ? { toolChoice: 'review' } : {}), maxOutput: 300,
        tools: [{ name: 'review', description: 'Approve or turn down the change.', input: { type: 'object', properties: { approve: { type: 'boolean' }, why: { type: 'string' } }, required: ['approve', 'why'] } }],
        messages: [{ role: 'user', parts: [{ type: 'text', text: `Current personality "${name}":\n${old || '(new)'}\n\nProposed:\n${text}\n\nShiori's reason: ${reason}` }] }],
      },
    });
    /** @type {any} */
    let r;
    try {
      r = await ask(true);
    } catch {
      // A model that thinks refuses a forced tool (Opus and Sonnet 5.5): asked again, the tool offered but not forced.
      r = await ask(false);
    }
    const call = r.reply.parts.find((/** @type {any} */ p) => p.type === 'tool_call' && p.name === 'review');
    // Fails closed: only the review tool saying approve: true approves (a reply in words doesn't).
    if (!call) return 'Not changed: the review gave no clear answer. Try again later.';
    verdict = { approve: call.input?.approve === true, why: String(call.input?.why ?? '') };
  } catch (e) {
    return `Not changed: the review couldn't run (${String(/** @type {any} */ (e)?.message ?? e)}). Try again later.`;
  }
  if (!verdict.approve) return `Not changed: ${verdict.why || 'the review turned it down.'}`;
  if ((await agent.settings()).askBeforeTuning) {
    agent.notify({
      tone: 'info', title: 'Shiori wants to adjust her personality', body: reason,
      actions: [{ label: 'Agree', primary: true, run: () => applyTuning({ agent, name, text, reason }) }, { label: 'No thanks', run: () => {} }],
    });
    return 'The user is asked first. If they agree, it applies at your next wake.';
  }
  await applyTuning({ agent, name, text, reason, callId, wake });
  return 'Approved. It applies at your next wake.';
}
