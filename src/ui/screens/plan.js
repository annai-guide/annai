import { h } from '../dom.js';
import { planRowOf } from './now.js';
import { planRows, planDays, legKm, distanceText, dayLabel, shioriUndos, PLAN_FILE, BOOKING_FILE } from '../../core/plan.js';
import { planToIcs } from '../../core/ics.js';
import { loadLinks, expandLink } from '../../core/links.js';
import { readAppSettings } from '../../core/settings.js';
import { validZone, deviceZone, dayIn } from '../../core/time.js';
import { platform } from '../platform.js';
import { saveFile } from '../save.js';
import { ask } from '../ask.js';
import { fileHref, bookingHref, dateRange } from '../format.js';

const KINDS = /** @type {Record<string, string>} */ ({ flight: 'Flight', lodging: 'Stay', car: 'Car', rail: 'Train', event: 'Event', restaurant: 'Restaurant', other: 'Booking' });

/**
 * The Plan (spec §16.2): day tabs, a timetable with ● fixed and ○ flexible, the legs between
 * stops, "Check this" chips (§7.3), the trip's bookings, and "Add to calendar" (§8).
 * @param {any} ctx @param {{ parts: string[] }} route
 */
export async function renderPlan(ctx, route) {
  const id = route.parts[0] === 'trip' ? route.parts[1] : (ctx.agent?.target ?? (await readAppSettings(ctx.ws)).activeTrip ?? null);
  const scope = id ? await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id)) : null;
  if (!id || !scope || scope.kind !== 'trip') {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'Plan' }), h('p', { class: 'empty' }, 'Open a trip to see its plan. ', h('a', { href: '#/trips' }, 'Go to Trips')));
  }
  const trip = (await ctx.ws.readJSON(id, '/trip.json').catch(() => null)) ?? {};
  const fallbackTz = [trip.timezones?.[0], deviceZone()].find(validZone) ?? 'UTC';
  const plan = await records(ctx, id, '/plan/', PLAN_FILE);
  const bookings = await records(ctx, id, '/bookings/', BOOKING_FILE);
  const locale = navigator.language || 'en-US';
  const rows = planRows(plan.list.map((x) => ({ path: x.path, item: x.value })), bookings.list.map((x) => ({ path: x.path, booking: x.value })), { fallbackTz, locale });
  const { days, untimed } = planDays(rows, trip);
  // Plan files Shiori changed last, and what Undo does (choice 9), from one read of the log.
  const undo = await shioriUndos(ctx.ws, id, plan.list);
  const links = await loadLinks({ ws: ctx.ws }).catch(() => null);

  const tabs = [...days.map((d) => ({ key: d.key, label: dayLabel(d.key, locale), rows: d.rows })), ...(untimed.length ? [{ key: '', label: `No time yet (${untimed.length})`, rows: untimed }] : [])];
  const today = dayIn(Date.now(), deviceZone());
  const first = tabs.find((t) => t.key === today) ?? tabs.find((t) => t.rows.length) ?? tabs[0];
  const panel = h('div', { class: 'plan-day', role: 'tabpanel' });
  /** @type {HTMLButtonElement[]} */
  const buttons = tabs.map((t) => h('button', { type: 'button', role: 'tab', class: 'tab', onclick: () => show(t) }, t.label));
  /** @param {typeof tabs[number]} t */
  function show(t) {
    buttons.forEach((b, i) => b.setAttribute('aria-selected', String(tabs[i] === t)));
    panel.setAttribute('aria-label', t.label);
    panel.replaceChildren(t.rows.length ? timetable(ctx, id, t.rows, links, locale, undo) : h('p', { class: 'empty', text: 'Nothing planned this day.' }));
  }
  if (first) show(first);

  const save = h('button', {
    class: 'btn', type: 'button', disabled: !rows.some((r) => r.at !== null),
    onclick: async () => {
      const { text, left } = planToIcs(plan.list.map((x) => x.value), { name: scope.title, tripId: id, now: Date.now() });
      const outcome = await saveFile(new Blob([text], { type: 'text/calendar' }), `${String(scope.title).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'plan'}.ics`);
      if (outcome === 'cancelled') return;
      ctx.notices.toast(left ? `Saved the plan. ${left === 1 ? "1 item has no time yet, so it isn't" : `${left} items have no time yet, so they aren't`} in it.` : 'Saved the plan.');
    },
  }, 'Add to calendar');
  const broken = plan.broken + bookings.broken;
  // "1 plan file and 2 booking files": each counted as what it is.
  const unread = /** @type {[number, string][]} */ ([[plan.broken, 'plan file'], [bookings.broken, 'booking file']])
    .filter(([n]) => n).map(([n, what]) => `${n} ${what}${n === 1 ? '' : 's'}`).join(' and ');
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: `#/trip/${encodeURIComponent(id)}` }, `← ${scope.title}`)),
    h('h1', { class: 'title', text: 'Plan' }),
    h('p', { class: 'sub', text: [scope.title, trip.start ? dateRange(trip.start, trip.end) : null].filter(Boolean).join(' · ') }),
    rows.length ? [h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Days' }, ...buttons), panel]
      : h('p', { class: 'empty', text: 'No plan yet. Ask Shiori to plan with you, or add a calendar file (.ics) to the trip.' }),
    broken ? h('p', { class: 'sub warn', text: `${unread} couldn't be read. Open the trip's files to fix ${broken === 1 ? 'it' : 'them'}.` }) : null,
    bookings.list.length ? h('section', { 'aria-label': 'Bookings' },
      h('h2', { class: 'section', text: 'Bookings' }),
      h('ul', { class: 'cards' }, ...bookings.list.map((b) => h('li', {}, h('a', { class: 'card', href: bookingHref(id, b.path) },
        h('span', { class: 'name', text: String(b.value.title || b.value.id || b.path) }),
        h('span', { class: 'sub', text: KINDS[b.value.kind] ?? 'Booking' }),
        b.value.status === 'confirmed' ? h('span', { class: 'chip ok', text: 'Confirmed' }) : h('span', { class: 'chip check', text: 'Check this' })))))) : null,
    h('div', { class: 'acts' }, save));
}

/**
 * The records in a folder, and how many couldn't be read. Only files directly in it count: those are what the
 * format check and the booking rule cover, so nothing in a subfolder shows as a plan item or a confirmed booking.
 * @param {any} ctx @param {string} id @param {string} prefix @param {RegExp} shape
 */
async function records(ctx, id, prefix, shape) {
  /** @type {{ path: string, value: Record<string, any>, author: string }[]} */
  const list = [];
  let broken = 0;
  for (const f of await ctx.ws.list(id, prefix)) {
    if (!shape.test(f.path)) continue;
    try {
      const value = await ctx.ws.readJSON(id, f.path);
      if (value && typeof value === 'object' && !Array.isArray(value)) list.push({ path: f.path, value, author: f.author });
      else broken++;
    } catch {
      broken++;
    }
  }
  return { list, broken };
}

/** @param {any} ctx @param {string} id @param {import('../../core/plan.js').PlanRow[]} rows @param {any} links @param {string} locale @param {Map<string, { restore: string } | { remove: true }>} undo */
function timetable(ctx, id, rows, links, locale, undo) {
  /** @type {HTMLElement[]} */
  const out = [];
  rows.forEach((r, i) => {
    const km = i ? legKm(rows[i - 1], r) : null;
    if (km !== null) out.push(leg(rows[i - 1], r, km, links, locale));
    out.push(row(ctx, id, r, undo));
  });
  return h('ol', { class: 'timetable' }, ...out);
}

/** @param {any} ctx @param {string} id @param {import('../../core/plan.js').PlanRow} r @param {Map<string, { restore: string } | { remove: true }>} undo */
function row(ctx, id, r, undo) {
  const it = r.item;
  // "22:00–05:30 +1 EST": an end on a later day, or in another zone, says so.
  const later = r.endDays ? `${r.endDays > 0 ? '+' : '−'}${Math.abs(r.endDays)}` : '';
  const when = it.kind === 'all-day' ? 'All day' : r.end ? [`${r.time}–${r.end}`, later, r.endZone].filter(Boolean).join(' ') : r.time;
  // A plugin's row (spec §16.4: plan-row), or annai's own, also when the plugin's fails.
  return planRowOf(ctx, id, r, when, () => h('li', { class: ['plan-row', it.fixed ? 'fixed' : 'flexible'] },
    h('span', { class: 'when', text: when }),
    h('span', { class: 'mark', 'aria-hidden': 'true', text: it.fixed ? '●' : '○' }),
    h('a', { class: 'what', href: fileHref(id, r.path) },
      h('span', { class: 'visually-hidden', text: it.fixed ? 'Fixed: ' : 'Flexible: ' }),
      h('span', { class: 'name', text: String(it.title ?? r.path) }),
      it.place?.name ? h('span', { class: 'sub', text: String(it.place.name) }) : null),
    r.check || r.missing || undo.has(r.path) ? h('span', { class: 'chips' },
      r.check && r.bookingPath ? h('a', { class: 'chip check', href: bookingHref(id, r.bookingPath) }, 'Check this') : null,
      r.missing ? h('span', { class: 'chip warn', text: 'Booking missing' }) : null,
      undoChip(ctx, id, r, undo.get(r.path))) : null,
    r.note ? h('span', { class: 'note sub warn', text: r.note }) : null));
}

/**
 * Undo for an item Shiori changed: back as it was before her changes, or, one she added, removed
 * after asking (its history keeps it, spec §4.9).
 * @param {any} ctx @param {string} id @param {import('../../core/plan.js').PlanRow} r @param {{ restore: string } | { remove: true } | undefined} u
 */
function undoChip(ctx, id, r, u) {
  if (!u) return null;
  const title = String(r.item.title ?? r.path);
  if ('remove' in u) {
    return h('button', {
      class: 'chip undo', type: 'button',
      onclick: async () => {
        if (!(await ask({ title, body: 'Shiori added this to the plan. Remove it?', yes: 'Remove' }))) return;
        await ctx.ws.delete(id, r.path, { author: 'user' });
        ctx.notices.toast(`Undone: ${title} is off the plan.`);
        ctx.render();
      },
    }, 'Added by Shiori · Undo');
  }
  return h('button', {
    class: 'chip undo', type: 'button',
    onclick: async () => {
      await ctx.ws.restore(id, r.path, u.restore, { author: 'user' });
      ctx.notices.toast(`Undone: ${title} is back as it was before Shiori changed it.`);
      ctx.render();
    },
  }, 'Changed by Shiori · Undo');
}

/** The leg between two stops: how far apart, and directions in the phone's maps app. */
function leg(/** @type {any} */ a, /** @type {any} */ b, /** @type {number} */ km, /** @type {any} */ links, /** @type {string} */ locale) {
  const prefer = platform() === 'ios' ? 'apple' : 'google';
  const maps = links?.maps?.find((/** @type {any} */ m) => m.id === prefer && m.modes.drive) ?? links?.maps?.find((/** @type {any} */ m) => m.modes.drive);
  const p = a.item.place;
  const q = b.item.place;
  const url = maps ? expandLink(maps.directions, { origin: `${p.lat},${p.lng}`, destination: `${q.lat},${q.lng}`, mode: maps.modes.drive }) : null;
  return h('li', { class: 'leg' },
    h('span', { text: `${distanceText(km, locale)} apart` }),
    url ? h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Directions') : null);
}
