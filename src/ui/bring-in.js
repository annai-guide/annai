import { addFiles } from './add-files.js';
import { importCalendar, newFilesText } from '../core/imports.js';
import { validZone, deviceZone } from '../core/time.js';

/**
 * Files the user adds to a trip (spec §7.3): kept under /files/ (photos through ingest),
 * calendar files made into plan items (§8), and Shiori woken once to look for bookings among
 * them. She isn't woken when no model is set up, so adding photos never brings up a "no model" card.
 * @param {any} ctx @param {string} scope @param {(Blob & { name?: string })[]} files @param {(done: number, total: number) => void} [progress]
 * @returns {Promise<{ paths: string[], notes: string[], problems: string[], planned: string[] }>}
 *   notes: about photos (addFiles); problems: calendar files that couldn't be read
 */
export async function bringIn(ctx, scope, files, progress) {
  const { paths, notes } = await addFiles(ctx, scope, files, progress);
  const trip = await ctx.ws.readJSON(scope, '/trip.json').catch(() => null);
  const defaultTz = [trip?.timezones?.[0], deviceZone()].find(validZone) ?? 'UTC';
  /** @type {string[]} */ const planned = [];
  /** @type {string[]} */ const problems = [];
  for (const path of paths.filter((p) => /\.ics$/i.test(p))) {
    try {
      planned.push(...(await importCalendar(ctx.ws, scope, path, { defaultTz })));
    } catch (e) {
      problems.push(`${path}: ${String(/** @type {any} */ (e)?.message ?? e)}`);
    }
  }
  const main = (await ctx.llm?.config().catch(() => null))?.roles?.main?.models ?? [];
  if (paths.length && main.length && ctx.agent) {
    const typeOf = new Map((await ctx.ws.list(scope, '/files/')).map((/** @type {any} */ f) => [f.path, f.type]));
    ctx.agent.wake({ kind: 'file', scope, text: newFilesText(paths.map((p) => ({ path: p, type: typeOf.get(p) ?? 'application/octet-stream' })), planned) });
  }
  return { paths, notes, problems, planned };
}
