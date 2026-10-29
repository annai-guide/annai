import { messageOf } from './dom.js';
import { addFiles } from './add-files.js';
import { importCalendar, newFilesText } from '../core/imports.js';
import { validZone, deviceZone } from '../core/time.js';

/**
 * Files kept in a scope (spec §7.3): under /files/ (photos through ingest), and in a trip, calendar files made into plan items (§8).
 * Shiori isn't told: the caller does that (bringIn, or a hand-over from the type box).
 * @param {any} ctx @param {string} scope @param {(Blob & { name?: string })[]} files @param {(done: number, total: number) => void} [progress]
 * @returns {Promise<{ paths: string[], notes: string[], problems: string[], planned: string[], plannedBy: Record<string, number> }>}
 *   notes: about photos (addFiles); problems: calendar files that couldn't be read; plannedBy: how many plan items each calendar file made
 */
export async function keepFiles(ctx, scope, files, progress) {
  const { paths, notes } = await addFiles(ctx, scope, files, progress);
  /** @type {string[]} */ const planned = [];
  /** @type {string[]} */ const problems = [];
  /** @type {Record<string, number>} */ const plannedBy = {};
  // Calendar files handed over with no trip open wait as files: Shiori reads them like any other once they are in a trip.
  if (!scope.startsWith('trip-')) return { paths, notes, problems, planned, plannedBy };
  const trip = await ctx.ws.readJSON(scope, '/trip.json').catch(() => null);
  const defaultTz = [trip?.timezones?.[0], deviceZone()].find(validZone) ?? 'UTC';
  const typeOf = new Map((await ctx.ws.list(scope, '/files/')).map((/** @type {any} */ f) => [f.path, f.type]));
  // A calendar by its name, or by its type: a shared invite's name may have no ".ics".
  const calendar = (/** @type {string} */ p) => /\.ics$/i.test(p) || /^text\/calendar\s*(;|$)/i.test(typeOf.get(p) ?? '');
  for (const path of paths.filter(calendar)) {
    try {
      const made = await importCalendar(ctx.ws, scope, path, { defaultTz });
      planned.push(...made);
      if (made.length) plannedBy[path] = made.length;
    } catch (e) {
      problems.push(`${path}: ${messageOf(e)}`);
    }
  }
  return { paths, notes, problems, planned, plannedBy };
}

/**
 * Files the user adds to a trip (spec §7.3): kept (keepFiles), and Shiori woken once to look for bookings among them. She isn't
 * woken when no model is set up, so adding photos never brings up a "no model" card.
 * @param {any} ctx @param {string} scope @param {(Blob & { name?: string })[]} files @param {(done: number, total: number) => void} [progress]
 * @returns {Promise<{ paths: string[], notes: string[], problems: string[], planned: string[] }>}
 */
export async function bringIn(ctx, scope, files, progress) {
  const kept = await keepFiles(ctx, scope, files, progress);
  const { paths, planned } = kept;
  const main = (await ctx.llm?.config().catch(() => null))?.roles?.main?.models ?? [];
  if (paths.length && main.length && ctx.agent) {
    const typeOf = new Map((await ctx.ws.list(scope, '/files/')).map((/** @type {any} */ f) => [f.path, f.type]));
    // For a trip that isn't open, the wake is written into its conversation: wait, so it's there when the trip opens.
    await ctx.agent.wake({ kind: 'file', scope, files: paths, text: newFilesText(paths.map((p) => ({ path: p, type: typeOf.get(p) ?? 'application/octet-stream' })), planned) });
  }
  return kept;
}
