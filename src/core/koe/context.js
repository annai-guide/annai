import { tsv } from '../tsv.js';
import { escapeTags } from '../agent/blocks.js';

/** Koe's compact view of the trip, in its tail (plan decision 6); its words escaped. */
export const VIEW_MAX = 2000;
const DAY = 86_400_000;

/** A moment as "YYYY-MM-DD HH:MM" where the user is. @param {number} ms @param {string} timeZone */
function local(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** The JSON files of a folder of the trip. @param {import('../workspace.js').Workspace} ws @param {string} trip @param {string} dir */
async function items(ws, trip, dir) {
  const out = [];
  for (const f of await ws.list(trip, dir)) if (f.path.endsWith('.json')) out.push(await ws.readJSON(trip, f.path).catch(() => null));
  return out.filter((x) => x && typeof x === 'object');
}

/**
 * @param {{ ws: import('../workspace.js').Workspace, trip: string | null, now: number, timeZone: string, next: { due: number, text: string } | null }} c
 *   next: the next reminder of this conversation, if any
 * @returns {Promise<string>} `<today>…</today>`, at most VIEW_MAX characters
 */
export async function compactView({ ws, trip, now, timeZone, next }) {
  if (!trip) /* en */ return '<today>\nNo trip is open.\n</today>';
  const days = [local(now, timeZone).slice(0, 10), local(now + DAY, timeZone).slice(0, 10)];
  const at = (/** @type {any} */ t) => Date.parse(t?.at ?? '');
  const e = (/** @type {unknown} */ v) => escapeTags(String(v ?? ''));
  const plan = (await items(ws, trip, '/plan/'))
    .filter((it) => Number.isFinite(at(it.start)) && days.includes(local(at(it.start), timeZone).slice(0, 10)))
    .sort((a, b) => at(a.start) - at(b.start))
    .map((it) => [local(at(it.start), timeZone), Number.isFinite(at(it.end)) ? local(at(it.end), timeZone) : '', e(it.title), it.fixed ? 'yes' : 'no', e(it.place?.name)]);
  const bookings = (await items(ws, trip, '/bookings/'))
    .filter((b) => at(b.start) >= now - 6 * 3_600_000 && at(b.start) <= now + 2 * DAY)
    .sort((a, b) => at(a.start) - at(b.start))
    .map((b) => [local(at(b.start), timeZone), e(b.kind), e(b.title), e(b.status), e(b.confirmation)]);
  /* en */ const title = e((await ws.readJSON(trip, '/trip.json').catch(() => null))?.title ?? 'this trip');
  /** @param {number} n how many plan rows */
  const render = (n) => [
    '<today>',
    `trip: ${title}`,
    /* en */ `plan for ${days.join(' and ')}:`,
    plan.length ? tsv(['start', 'end', 'title', 'fixed', 'place'], plan.slice(0, n)) + (n < plan.length ? /* en */ `\n…and ${plan.length - n} more (read /trip/plan/)` : '') : /* en */ 'nothing planned',
    /* en */ 'bookings in the next 48 hours:',
    bookings.length ? tsv(['start', 'kind', 'title', 'status', 'confirmation'], bookings) : 'none',
    /* en */ `next reminder: ${next ? `${local(next.due, timeZone)} ${e(next.text)}` : 'none'}`,
    '</today>',
  ].join('\n');
  let n = plan.length;
  let out = render(n);
  while (out.length > VIEW_MAX && n > 0) out = render(--n);
  return out.length > VIEW_MAX ? `${out.slice(0, VIEW_MAX - 12)}…\n</today>` : out;
}
