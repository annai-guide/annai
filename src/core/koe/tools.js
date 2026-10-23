import { resolvePath } from '../agent/tools.js';

/** Koe's quick tools (the Koe and Kokoro design): Shiori's own, found by name, so switched off where Kokoro's are. */
export const KOE_TOOLS = Object.freeze(['watch_set', 'watch_list', 'watch_cancel', 'recall', 'list', 'read', 'nearby', 'guide', 'write', 'edit', 'patch']);
const LIGHT = ['write', 'edit', 'patch'];
const OFFLINE = ['nearby', 'guide'];
const MOVABLE = ['start', 'end', 'notes', 'priority'];
export const BIGGER = "That's a bigger change: ask Kokoro with tell_kokoro.";
/** Koe settles a note of Kokoro's it has told the user already (§6.8), text or live: annai doesn't show it for Koe. */
export const ALREADY_TOLD = Object.freeze({
  name: 'already_told', pluginId: 'core', group: 'Talk',
  description: "Kokoro's latest note adds nothing to what you have already told the user: call this instead of saying it again, so annai doesn't show it for you. It never answers the user: when they speak, answer them.",
  input: { type: 'object', properties: {} },
  run: async () => 'Noted: the user has it already.',
});
const NOTE = /^\/trip\/notes\/(?!\.\.?$)[^/]+$/;
const ITEM = /^\/trip\/plan\/(?!\.\.?\.json$)[^/]+\.json$/;

/**
 * Why a change is too big for Koe, or null (plan decision 7): Koe may write or edit one note, move one
 * flexible plan item (its start, end, notes or priority), or add one new flexible one. Each is one
 * file, undone from its history (spec §4.2), and never touches a fixed commitment or money.
 * @param {string} name @param {any} input @param {{ ws: import('../workspace.js').Workspace, trip: string | null }} c
 * @returns {Promise<string | null>}
 */
export async function lightChange(name, input, { ws, trip }) {
  const path = String(input?.path ?? '');
  if ((name === 'write' || name === 'edit') && NOTE.test(path)) return null;
  if ((name === 'write' || name === 'patch') && ITEM.test(path) && trip) {
    const { scope, path: inner } = resolvePath(path, trip);
    const item = await ws.readJSON(scope, inner).catch(() => null);
    // A record may come as its JSON text (a model on Gemini writes it so), which write takes the same.
    if (name === 'write' && !item && recordOf(input?.content)?.fixed === false) return null;
    if (name === 'patch' && item?.fixed === false && input?.changes && Object.keys(input.changes).every((k) => MOVABLE.includes(k))) return null;
  }
  return BIGGER;
}

/** A write's content as the record it stores: an object, or text that is one. @param {unknown} content @returns {Record<string, any> | null} */
function recordOf(content) {
  let value = content;
  if (typeof content === 'string') {
    try {
      value = JSON.parse(content);
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : null;
}

/**
 * @param {{ find: (name: string) => import('../agent/loop.js').LoopTool | import('../agent/tools.js').Tool | undefined, ws: import('../workspace.js').Workspace }} c
 *   find: Shiori's tool of a name, now
 * @returns {import('../agent/loop.js').LoopTool[]}
 */
export function koeTools({ find, ws }) {
  return KOE_TOOLS.map((name) => ({
    name, pluginId: 'core', group: 'Koe',
    get description() {
      const d = find(name)?.description;
      return d && LIGHT.includes(name) ? `${d} Koe: only light changes: a note in /trip/notes/, one flexible plan item's start, end, notes or priority, or one new flexible plan item (fixed: false). Anything bigger: ask Kokoro.` : /** @type {string} */ (d);
    },
    get input() {
      return /** @type {Record<string, any>} */ (find(name)?.input);
    },
    run: async (/** @type {any} */ i, /** @type {any} */ call) => {
      const tool = find(name);
      if (!tool) throw new Error(`There is no ${name} tool now.`);
      const no = LIGHT.includes(name) ? await lightChange(name, i, { ws, trip: call.trip }) : null;
      if (no) return { content: no, isError: true };
      return tool.run(i, OFFLINE.includes(name) ? { ...call, offline: true } : call);
    },
  }));
}
