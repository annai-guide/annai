import { resolvePath } from '../agent/tools.js';

/**
 * Koe's quick tools (the Koe and Kokoro design, "Tools: who has what"): timers, recall, reads on the
 * device, places from the offline pack, and light changes. Each is Shiori's own tool, found by name
 * when it is offered and run, so Koe has what Kokoro has, switched off where Kokoro's is.
 */

/** Koe's tools after its talking ones, in the order offered; tell_kokoro follows. */
export const KOE_TOOLS = Object.freeze(['watch_set', 'watch_list', 'watch_cancel', 'recall', 'list', 'read', 'nearby', 'guide', 'write', 'edit', 'patch']);
const LIGHT = ['write', 'edit', 'patch'];
const OFFLINE = ['nearby', 'guide'];
/** What a plan item's patch from Koe may change. */
const MOVABLE = ['start', 'end', 'notes', 'priority'];
export const BIGGER = "That's a bigger change: ask Kokoro with tell_kokoro.";
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
    if (name === 'write' && !item && input?.content?.fixed === false) return null;
    if (name === 'patch' && item?.fixed === false && input?.changes && Object.keys(input.changes).every((k) => MOVABLE.includes(k))) return null;
  }
  return BIGGER;
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
