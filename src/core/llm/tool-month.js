import { SYS_DEVICE, ensureDeviceScope } from '../scopes.js';
import { forget as forgetHistory } from '../forget.js';

/**
 * Provider tools with a monthly free allowance (the Gemini design, "Google Search, built in"): Google gives a paid
 * project 5,000 searches a month, then charges for each. annai counts this device's calls of each such tool per
 * calendar month (UTC), so a call is priced only past the allowance. It's an estimate: other devices on the same
 * project use the same allowance. The count is this device's (/llm/tool-calls.json in "This device"): no backup
 * carries it, and it keeps no history, one count a month rather than a version per call.
 * @typedef {{ month: string, counts: Record<string, number> }} ToolCalls
 */

const PATH = '/llm/tool-calls.json';

export class ToolMonth {
  /** @type {Promise<unknown>} */
  #lock = Promise.resolve();

  /** @param {{ ws: import('../workspace.js').Workspace, now?: () => number }} c */
  constructor({ ws, now = Date.now }) {
    this.ws = ws;
    this.now = now;
  }

  /**
   * Counts a call's uses of a tool; how many of them are past its free allowance this month.
   * @param {string} toolId @param {number} count @param {number} freePerMonth @returns {Promise<number>}
   */
  bill(toolId, count, freePerMonth) {
    if (!(count > 0)) return Promise.resolve(0);
    const run = this.#lock.then(async () => {
      const now = this.now();
      const month = new Date(now).toISOString().slice(0, 7);
      const j = await this.ws.readJSON(SYS_DEVICE, PATH).catch(() => null);
      /** @type {Record<string, number>} */
      const counts = j?.month === month && j.counts && typeof j.counts === 'object' ? { ...j.counts } : {};
      const before = Number(counts[toolId]) || 0;
      counts[toolId] = before + count;
      await ensureDeviceScope(this.ws.store, now);
      await this.ws.write(SYS_DEVICE, PATH, /** @type {ToolCalls} */ ({ month, counts }), { author: 'system' });
      await forgetHistory(this.ws.store, SYS_DEVICE, { history: (p) => p === PATH });
      return Math.max(0, before + count - freePerMonth) - Math.max(0, before - freePerMonth);
    });
    this.#lock = run.catch(() => {});
    return run;
  }
}
