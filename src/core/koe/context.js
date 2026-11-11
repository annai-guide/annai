import { tsv } from '../tsv.js';
import { escapeTags } from '../agent/blocks.js';
import { planRows } from '../plan.js';

/** Koe's compact view of the trip, in its tail; its words escaped. */
export const VIEW_MAX = 2000;
const DAY = 86_400_000;

/** A moment as "YYYY-MM-DD HH:MM" where the user is. @param {number} ms @param {string} timeZone */
function local(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** The JSON files of a folder of the trip, with their paths. @param {import('../workspace.js').Workspace} ws @param {string} trip @param {string} dir */
async function items(ws, trip, dir) {
  const out = [];
  for (const f of await ws.list(trip, dir)) if (f.path.endsWith('.json')) out.push({ path: f.path, value: await ws.readJSON(trip, f.path).catch(() => null) });
  return out.filter((x) => x.value && typeof x.value === 'object');
}

/** What the end of something over several days is, as the Plan says it. */
/* en */ const ENDS = /** @type {Record<string, string>} */ ({ lodging: 'Check out', car: 'Return', flight: 'Arrive', rail: 'Arrive' });

/**
 * @param {{ ws: import('../workspace.js').Workspace, trip: string | null, now: number, timeZone: string, next: { when: string, text: string } | null }} c
 *   next: the next reminder of this conversation, if any: its time in the words Kokoro reads for it (dueWords), and what it says
 * @returns {Promise<string>} `<today>…</today>`, at most VIEW_MAX characters
 */
export async function compactView({ ws, trip, now, timeZone, next }) {
  if (!trip) /* en */ return '<today>\nNo trip is open.\n</today>';
  const days = [local(now, timeZone).slice(0, 10), local(now + DAY, timeZone).slice(0, 10)];
  const at = (/** @type {any} */ t) => Date.parse(t?.at ?? '');
  const e = (/** @type {unknown} */ v) => escapeTags(String(v ?? ''));
  const planFiles = await items(ws, trip, '/plan/');
  const bookingFiles = await items(ws, trip, '/bookings/');
  // The plan's items, and the ends of what runs over several days (a check-out, a return, an arrival) at their times, as the Plan shows.
  const rows = planRows(planFiles.map((f) => ({ path: f.path, item: f.value })), bookingFiles.map((f) => ({ path: f.path, booking: f.value })), { fallbackTz: timeZone });
  const plan = rows.filter((r) => r.at !== null && (r.from === 'item' || r.from === 'end') && days.includes(local(r.at, timeZone).slice(0, 10)))
    .sort((a, b) => /** @type {number} */ (a.at) - /** @type {number} */ (b.at))
    .map((r) => {
      const end = r.from === 'item' ? at(r.item.end) : NaN;
      const name = r.from === 'end' ? `${ENDS[r.set?.kind ?? ''] ?? 'Ends'} · ${r.item.title}` : r.item.title;
      return [local(/** @type {number} */ (r.at), timeZone), Number.isFinite(end) ? local(end, timeZone) : '', e(name), r.item.fixed ? 'yes' : 'no', e(r.item.place?.name)];
    });
  const bookings = bookingFiles.map((f) => f.value)
    .filter((b) => at(b.start) >= now - 6 * 3_600_000 && at(b.start) <= now + 2 * DAY)
    .sort((a, b) => at(a.start) - at(b.start))
    .map((b) => [local(at(b.start), timeZone), e(b.kind), e(b.title), e(b.status), e(b.confirmation)]);
  const tj = await ws.readJSON(trip, '/trip.json').catch(() => null);
  /* en */ const title = e(tj?.title ?? 'this trip');
  // A conversation with no dates has no plan of its own: an empty one there says nothing of the user's trips, which Kokoro reads (Koe
  // answered "nothing planned for tomorrow" from it, first and wrong, in stage 5's real-model pass).
  const dated = Boolean(tj?.start);
  /** @param {number} n how many plan rows */
  const render = (n) => [
    '<today>',
    /* en */ `trip: ${title}${dated ? '' : " (a conversation with no dates: what is on, and where and when, is in the user's trips, which Kokoro reads)"}`,
    ...(dated || plan.length ? [
      /* en */ `plan for ${days.join(' and ')}:`,
      plan.length ? tsv(['start', 'end', 'title', 'fixed', 'place'], plan.slice(0, n)) + (n < plan.length ? /* en */ `\n…and ${plan.length - n} more (read /trip/plan/)` : '') : /* en */ 'nothing planned',
    ] : []),
    ...(dated || bookings.length ? [/* en */ 'bookings in the next 48 hours:', bookings.length ? tsv(['start', 'kind', 'title', 'status', 'confirmation'], bookings) : 'none'] : []),
    /* en */ `next reminder: ${next ? `${e(next.when)} ${e(next.text)}` : 'none'}`,
    '</today>',
  ].join('\n');
  let n = plan.length;
  let out = render(n);
  while (out.length > VIEW_MAX && n > 0) out = render(--n);
  return out.length > VIEW_MAX ? `${out.slice(0, VIEW_MAX - 12)}…\n</today>` : out;
}
