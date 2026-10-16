import { normPath } from '../paths.js';
import { ME } from '../scopes.js';
import { readAppSettings, updateAppSettings } from '../settings.js';

/**
 * Tools (spec §5.4, §7.2). The loop's own tools come first, then every running plugin's, in the
 * order they registered; switches come from the app settings, so they cover any plugin's tool.
 * @typedef {{ mediaType: string, hash?: string, data?: string, path?: string, region?: number[], name?: string }} Media
 * @typedef {{ content: string, images?: Media[], document?: Media, isError?: boolean, heard?: string[], endTurn?: boolean }} ToolOutput
 *   heard: segments the user said in answer, which follow the result (spec §10.3); endTurn: the turn ends after this step (chatter heard, §10.4)
 * @typedef {{ id: string, scope: string, trip: string | null, signal: AbortSignal, model: import('../llm/config.js').Model | null, wake: string,
 *   fetch: (url: string, init?: RequestInit) => Promise<Response>, llm: any, author: 'shiori', providerOff?: string[], voice?: boolean, sleeping?: boolean,
 *   photos?: { copy(source: import('../request-photos.js').Source, crop?: import('../request-photos.js').Crop): Promise<import('../request-photos.js').Copy> } }} ToolCall
 *   photos: request copies and crops of stored photos (spec §4.8); voice: voice is on for this turn (§10.5); sleeping: sleep came in the same reply
 *   providerOff: the provider tools switched off, for a tool that asks a model to use its own (spec §9.5)
 * @typedef {{ name: string, description: string, input: Record<string, any>, run: (input: any, call: ToolCall) => any, group?: string }} Tool
 */

export const TALK = Object.freeze(['speak', 'show', 'ask', 'wait', 'sleep']);
/** "Every tool can be switched off, except show, ask, wait and sleep" (spec §7.2). */
export const ALWAYS_ON = Object.freeze(['show', 'ask', 'wait', 'sleep']);
/** A tool name every provider accepts. */
export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** The most of a tool's result the model sees at once; the rest is cut, with a note. */
export const RESULT_MAX = 40_000;

/** What is wrong with a tool, or null. @param {any} t @returns {string | null} */
export function checkTool(t) {
  if (typeof t?.name !== 'string' || !TOOL_NAME.test(t.name)) return `its name "${t?.name}" must be 1 to 64 letters, digits, "_" or "-"`;
  if (typeof t.description !== 'string' || !t.description.trim()) return `the tool ${t.name} needs a description`;
  if (!t.input || typeof t.input !== 'object' || Array.isArray(t.input)) return `the tool ${t.name} needs an input JSON Schema object`;
  if (typeof t.run !== 'function') return `the tool ${t.name} has no run() function`;
  return null;
}

/**
 * The tools Shiori has now: the loop's, then plugins'; the first tool with a name wins, and a
 * switched-off tool is left out.
 * @param {{ registry: import('../registry.js').Registry, switches: Record<string, boolean>, loop?: (Tool & { pluginId: string })[] }} c
 * @returns {(Tool & { pluginId: string })[]}
 */
export function toolList({ registry, switches, loop = [] }) {
  /** @type {(Tool & { pluginId: string })[]} */
  const out = [];
  const taken = new Set();
  for (const t of [...loop, ...registry.entries('tool').map((e) => ({ ...e.item, pluginId: e.pluginId }))]) {
    if (taken.has(t.name) || checkTool(t)) continue;
    taken.add(t.name);
    if (switches[t.name] === false && !ALWAYS_ON.includes(t.name)) continue;
    out.push(t);
  }
  return out;
}

/** @param {Tool[]} tools @returns {import('../llm/contract.js').ToolDef[]} */
export function definitions(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, input: t.input }));
}

/** @param {any} out @returns {ToolOutput} */
function normalize(out) {
  if (typeof out === 'string') return { content: out };
  if (out && typeof out === 'object' && typeof out.content === 'string' && (out.images || out.document || out.heard || out.endTurn || out.isError !== undefined || Object.keys(out).length === 1)) {
    return /** @type {ToolOutput} */ (out);
  }
  if (out === undefined || out === null) return { content: 'done' };
  return { content: JSON.stringify(out) };
}

/** @param {string} s */
function cut(s) {
  if (s.length <= RESULT_MAX) return s;
  return `${s.slice(0, RESULT_MAX)}\n… ${s.length - RESULT_MAX} more characters were cut.`;
}

/**
 * Runs a tool. Errors become results the model sees (spec §6.7); a stop by the user ends a tool
 * that hangs; a huge result is cut.
 * @param {Tool} tool @param {any} input @param {ToolCall} call @returns {Promise<{ output: ToolOutput, ms: number }>}
 */
export async function runTool(tool, input, call) {
  const started = Date.now();
  /** @type {Promise<never>} */
  const stopped = new Promise((_, reject) => {
    const why = () => reject(Object.assign(new Error('Stopped by the user.'), { stopped: true }));
    if (call.signal.aborted) why();
    else call.signal.addEventListener('abort', why, { once: true });
  });
  /** @type {ToolOutput} */
  let output;
  try {
    output = normalize(await Promise.race([Promise.resolve().then(() => tool.run(input, call)), stopped]));
  } catch (e) {
    const err = /** @type {any} */ (e);
    output = { content: err?.stopped ? 'Stopped by the user.' : `Error: ${err?.message ?? err}`, isError: true };
  }
  return { output: { ...output, content: cut(output.content) }, ms: Date.now() - started };
}

/** Stuck-loop detection (spec §6.6): three identical tool calls in a row with identical results. */
export class Stuck {
  /** @type {string[]} */
  #last = [];
  /** @param {string} name @param {any} input @param {string} content @returns {boolean} */
  see(name, input, content) {
    this.#last.push(JSON.stringify([name, input, content]));
    if (this.#last.length > 3) this.#last.shift();
    return this.#last.length === 3 && this.#last.every((x) => x === this.#last[0]);
  }
}

/**
 * A path Shiori gives, as a scope and a path in it (spec §4.3): /trip/… is the open trip, /me/…
 * is the user's own files. Nothing else is in her view.
 * @param {string} path @param {string | null} trip @returns {{ scope: string, path: string }}
 */
export function resolvePath(path, trip) {
  const p = String(path ?? '');
  const m = /^\/(trip|me)(\/.*)?$/.exec(p);
  if (!m) throw new Error(`Paths start with /trip/ or /me/, not ${p || 'nothing'}.`);
  if (m[1] === 'trip' && !trip) throw new Error('No trip is open, so /trip/ has nothing in it. Use /me/ for your own notes.');
  // A folder keeps its trailing slash, and /trip or /me alone is the root.
  const raw = (m[2] || '/').replace(/\/{2,}/g, '/');
  const inner = raw === '/' ? '/' : `${normPath(raw.replace(/\/$/, ''))}${raw.endsWith('/') ? '/' : ''}`;
  if (inner === '/.annai' || inner.startsWith('/.annai/')) throw new Error('/.annai is reserved for annai itself.');
  return { scope: m[1] === 'trip' ? /** @type {string} */ (trip) : ME, path: inner };
}

/** @param {import('../workspace.js').Workspace} ws @returns {Promise<Record<string, boolean>>} */
export async function toolSwitches(ws) {
  return (await readAppSettings(ws)).tools ?? {};
}

/** Only "off" is stored. @param {import('../workspace.js').Workspace} ws @param {string} name @param {boolean} on */
export function setToolSwitch(ws, name, on) {
  return updateAppSettings(ws, { tools: { [name]: on ? null : false } });
}
