import { h, t, tc } from '../dom.js';
import { BOOKING_KINDS, fileHref, itemHref, bookingHref, when } from '../format.js';
import { PLAN_FILE, bookingRef } from '../../core/plan.js';
import { validZone, instantAt } from '../../core/time.js';
import { zone } from '../../core/intl.js';
import { mapsUrl } from '../cards.js';
import { platform } from '../platform.js';
import { askAboutButton } from '../composer.js';
import { backCrumb, tripZone, original } from './booking.js';

/**
 * A plan item's details (the bookings-and-trips design, goal 6: "what it is, when, where, notes, and the file it came from, if any"):
 * its title and kind, when (each end in its own zone, or All day), where, its notes as written, the booking it stands for, the file it
 * came from (a calendar's, or its booking's) with Open the original, then Ask Shiori about this and Change it (the raw form). Never the
 * raw JSON first. @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route
 */
export async function renderItem(ctx, route) {
  const id = route.parts[1];
  const path = route.params.path ?? '';
  const crumbs = backCrumb(ctx, id, route.params.from);
  const item = PLAN_FILE.test(path) ? await ctx.ws.readJSON(id, path).catch(() => undefined) : undefined;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return h('div', { class: 'screen' }, crumbs,
      h('h1', { class: 'title', text: t`This isn't on the plan` }),
      h('p', { class: 'sub' }, t`It may have been deleted or renamed.`, ' ', h('a', { href: `#/trip/${encodeURIComponent(id)}/plan` }, t`Go to the plan`)));
  }
  const here = itemHref(id, path, route.params.from);
  const tz = await tripZone(ctx, id);
  const ref = bookingRef(item.booking);
  const booking = ref ? await ctx.ws.readJSON(id, ref).catch(() => undefined) : undefined;
  const has = booking && typeof booking === 'object' && !Array.isArray(booking);
  // The file it came from: a calendar's (kept on the item's file), else its booking's.
  const entry = await ctx.store.tx(['files'], 'readonly', (/** @type {any} */ x) => x.getFile(id, path));
  const source = entry?.source ?? (has ? booking.source : undefined);
  const kind = typeof item.kind === 'string' && item.kind !== 'all-day' ? item.kind : '';
  const title = typeof item.title === 'string' && item.title.trim() ? item.title : t`Plan item`;
  /** @type {[string, string, 'en' | undefined][]} label, value, the value's language when it is a key as written */
  const facts = [];
  const start = timeText(item.start, tz, item.kind === 'all-day');
  const end = item.kind === 'all-day' ? null : timeText(item.end, tz, false);
  if (item.kind === 'all-day') facts.push([t`When`, start ? t`All day, ${start}` : t`All day`, undefined]);
  else if (start) facts.push([end ? tc('booking')`Starts` : t`When`, start, undefined]);
  if (end) facts.push([tc('booking')`Ends`, end, undefined]);
  if (item.place?.name) facts.push([t`Place`, item.place.address ? tc('booking')`${String(item.place.name)}, ${String(item.place.address)}` : String(item.place.name), undefined]);
  return h('div', { class: 'screen details' }, crumbs,
    h('h1', { class: 'title', dir: 'auto', text: title }),
    kind ? h('p', { class: 'sub' }, Object.hasOwn(BOOKING_KINDS, kind) ? BOOKING_KINDS[kind] : h('span', { lang: 'en', text: kind })) : null,
    facts.length ? h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { dir: 'auto', text: v })])) : null,
    typeof item.notes === 'string' && item.notes.trim() ? h('section', { 'aria-label': t`Notes` }, h('h2', { class: 'section', text: t`Notes` }), h('p', { class: 'notes', dir: 'auto', text: item.notes })) : null,
    has ? h('p', {}, h('a', { href: bookingHref(id, /** @type {string} */ (ref)) }, t`Booked: ${String(booking.title || BOOKING_KINDS[booking.kind] || t`Booking`)}`)) : null,
    await original(ctx, id, source, here, { none: true }),
    h('div', { class: 'acts' },
      item.place?.name ? h('a', { class: 'btn', href: mapsUrl(item.place, platform()), target: '_blank', rel: 'noopener noreferrer' }, t`Open in Maps`) : null,
      askAboutButton(ctx, { scope: id, path, name: title }),
      h('a', { class: 'btn', href: fileHref(id, path, here) }, t`Change it`)));
}

/** A time in its own zone, named (else the trip's): with the day; an all-day item's day alone. @param {any} time @param {string} tz @param {boolean} dayOnly */
function timeText(time, tz, dayOnly) {
  const own = validZone(time?.tz) ? time.tz : tz;
  const ms = instantAt(time?.at, own);
  if (!Number.isFinite(ms)) return null;
  if (dayOnly) return when(ms, own, { weekday: 'short', month: 'short', day: 'numeric' });
  return t`${when(ms, own, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${zone(ms, own)})`;
}
