import { h, crumb, t, tc } from '../dom.js';
import { bookingFacts, BOOKING_KINDS, fileHref, bookingHref, day } from '../format.js';
import { isBookingPath, checkOf } from '../../core/bookings.js';
import { PLAN_FILE, bookingRef } from '../../core/plan.js';
import { normPath } from '../../core/paths.js';
import { validZone, deviceZone, dayIn, instantAt } from '../../core/time.js';
import { readNames, shortName } from '../../core/names.js';
import { mapsUrl } from '../cards.js';
import { platform } from '../platform.js';
import { askAboutButton } from '../composer.js';
import { filePreview } from '../preview.js';
import { cameFrom, backLabel } from './file.js';

/**
 * A booking's details (spec §16.2; the bookings-and-trips design, goal 6 and screen 3): what Shiori read, a light "check" on just the
 * fields she is unsure of (My call 1: there is no confirming step), the file it came from with Open the original, then what can be done:
 * Open in Maps, Ask Shiori about this, Change it (the raw form). A tap on the Plan opens this first.
 * @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route
 */
export async function renderBooking(ctx, route) {
  const id = route.parts[1];
  const path = route.params.path ?? '';
  const crumbs = backCrumb(ctx, id, route.params.from);
  const booking = isBookingPath(id, path) ? await ctx.ws.readJSON(id, path).catch(() => undefined) : undefined;
  if (!booking || typeof booking !== 'object' || Array.isArray(booking)) {
    return h('div', { class: 'screen' }, crumbs,
      h('h1', { class: 'title', text: t`This booking isn't in the trip` }),
      h('p', { class: 'sub', text: t`It may have been deleted or renamed. The plan lists the bookings there are.` }));
  }
  const here = bookingHref(id, path, route.params.from);
  const tz = await tripZone(ctx, id);
  const marks = checkOf(booking);
  const kind = BOOKING_KINDS[booking.kind] ?? t`Booking`;
  const title = typeof booking.title === 'string' && booking.title.trim() ? booking.title : kind;
  const startTz = validZone(booking.start?.tz) ? booking.start.tz : tz;
  const start = instantAt(booking.start?.at, startTz);
  const on = Number.isFinite(start) ? dayIn(start, startTz) : null;
  const facts = bookingFacts(booking, { fallbackTz: tz });
  return h('div', { class: 'screen details' }, crumbs,
    h('h1', { class: 'title', dir: 'auto' }, title, marks.fields.includes('title') ? [' ', checkMark()] : null),
    h('p', { class: 'sub', text: [kind, on ? day(on, true) : null].filter(Boolean).join(' · ') }),
    // A booking from before single details were marked: the whole of it, until she is told it's right.
    marks.whole ? h('p', { class: 'check-banner', role: 'note', text: t`Check this: Shiori read it before annai marked single details. Tell her if anything is wrong.` }) : null,
    facts.length ? h('dl', { class: 'facts' }, ...facts.flatMap((f) => [
      h('dt', { lang: f.lang, text: f.label }),
      h('dd', {}, h('span', { dir: 'auto', text: f.value }), f.unsure ? [' ', checkMark()] : null)])) : null,
    await itemNotes(ctx, id, path),
    await original(ctx, id, booking.source, here),
    h('div', { class: 'acts' },
      booking.place?.name ? h('a', { class: 'btn', href: mapsUrl(booking.place, platform()), target: '_blank', rel: 'noopener noreferrer' }, t`Open in Maps`) : null,
      askAboutButton(ctx, { scope: id, path, name: title }),
      h('a', { class: 'btn', href: fileHref(id, path, here) }, t`Change it`)));
}

/**
 * The notes of the plan items that stand for this booking ("Terminal S, arrive 2 h early"): a tap on such an item opens these details,
 * so its notes are read here, each under its item's title when there are several. @param {any} ctx @param {string} id @param {string} path
 */
async function itemNotes(ctx, id, path) {
  /** @type {{ title: string, notes: string }[]} */
  const found = [];
  for (const f of await ctx.ws.list(id, '/plan/')) {
    if (!PLAN_FILE.test(f.path)) continue;
    const item = await ctx.ws.readJSON(id, f.path).catch(() => null);
    if (item && bookingRef(item.booking) === path && typeof item.notes === 'string' && item.notes.trim()) found.push({ title: String(item.title ?? ''), notes: item.notes });
  }
  if (!found.length) return null;
  return h('section', { class: 'item-notes', 'aria-label': t`Notes` }, h('h2', { class: 'section', text: t`Notes` }),
    ...found.map((n) => h('p', { class: 'sub notes', dir: 'auto' }, found.length > 1 && n.title ? [h('strong', { dir: 'auto', text: n.title }), ' '] : null, n.notes)));
}

/** A detail Shiori isn't sure of: a light mark, with words for screen readers. */
export function checkMark() {
  return h('span', { class: 'chip check mark-check' },
    h('span', { 'aria-hidden': 'true', text: tc('a detail to check')`check` }),
    h('span', { class: 'visually-hidden', text: t`Shiori isn't sure of this` }));
}

/**
 * The crumb of a details screen: back to where it was opened from (Now), else the trip's Plan.
 * @param {any} ctx @param {string} id @param {string | undefined} from
 */
export function backCrumb(ctx, id, from) {
  const back = cameFrom(from, id, ctx.agent?.trip ?? null);
  return h('p', { class: 'crumbs' }, back ? crumb(back.hash, backLabel(back.name)) : crumb(`#/trip/${encodeURIComponent(id)}/plan`, t`Plan`));
}

/** The zone for a time whose own zone annai doesn't know: the trip's first, else this phone's. @param {any} ctx @param {string} id */
export async function tripZone(ctx, id) {
  const trip = (await ctx.ws.readJSON(id, '/trip.json').catch(() => null)) ?? {};
  return [trip.timezones?.[0], deviceZone()].find(validZone) ?? 'UTC';
}

/**
 * The file something came from: its preview (or card) by its short name, and Open the original, whose screen comes back here; in words
 * when it isn't there, or none is named. @param {any} ctx @param {string} id @param {unknown} source @param {string} here
 * @param {{ none?: boolean }} [o] none: say nothing when no file is named (a plan item needn't come from one)
 */
export async function original(ctx, id, source, here, o = {}) {
  const path = typeof source === 'string' ? source.replace(/^\/trip(?=\/)/, '') : '';
  if (!path && o.none) return null;
  const names = path ? await readNames(ctx.ws, id) : {};
  const name = path ? shortName(names, path) : '';
  /** @type {any} */
  let entry = null;
  try {
    entry = path ? await ctx.store.tx(['files'], 'readonly', (/** @type {any} */ t) => t.getFile(id, normPath(path))) : null;
  } catch {
    entry = null; // not a path
  }
  if (!entry) return h('p', { class: 'sub warn', text: path ? t`The original, ${name}, isn't in the trip.` : t`This booking doesn't say which file it came from.` });
  return h('section', { class: 'original', 'aria-label': t`The original` },
    await filePreview(ctx, id, entry.path, { name }),
    h('p', { class: 'sub', dir: 'auto', text: t`From ${name}` }),
    h('div', { class: 'acts' }, h('a', { class: 'btn', href: fileHref(id, entry.path, here) }, t`Open the original`)));
}
