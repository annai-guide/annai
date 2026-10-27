import { h, crumb, t, linkIn, showError } from '../dom.js';
import { bookingLines, fileHref, sentences } from '../format.js';
import { isBookingPath } from '../../core/bookings.js';
import { normPath } from '../../core/paths.js';
import { mapsUrl } from '../cards.js';
import { platform } from '../platform.js';
import { explainStorageFull } from '../storage-full.js';

/**
 * Booking confirmation (spec §16.2, §7.3): what a booking says, beside the original it was read
 * from, and "Looks right" to confirm it. Only the user confirms a booking (§4.4).
 * @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route
 */
export async function renderBooking(ctx, route) {
  const id = route.parts[1];
  const path = route.params.path ?? '';
  const crumbs = h('p', { class: 'crumbs' }, crumb(`#/trip/${encodeURIComponent(id)}/plan`, t`Plan`));
  const booking = isBookingPath(id, path) ? await ctx.ws.readJSON(id, path).catch(() => undefined) : undefined;
  if (!booking || typeof booking !== 'object' || Array.isArray(booking)) {
    return h('div', { class: 'screen' }, crumbs,
      h('h1', { class: 'title', text: t`This booking isn't in the trip` }),
      h('p', { class: 'sub', text: t`It may have been deleted or renamed. The plan lists the bookings there are.` }));
  }
  const confirmed = booking.status === 'confirmed';
  const problem = h('p', { class: 'sub warn', role: 'alert', hidden: true });
  /** @type {HTMLButtonElement | null} */
  const confirm = confirmed ? null : h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      if (!confirm) return;
      confirm.disabled = true;
      problem.hidden = true;
      try {
        await ctx.ws.patch(id, path, { status: 'confirmed' }, { author: 'user' });
        ctx.notices.toast(t`Confirmed`);
        await ctx.render();
      } catch (e) {
        if (!explainStorageFull(ctx, e)) {
          // A schema's refusal stays its English (showError), inside the sentence.
          const why = h('span');
          showError(why, e);
          problem.replaceChildren(...linkIn(sentences(t`It wasn't confirmed: ${why.textContent}`, t`Try again.`), why));
          problem.hidden = false;
        }
        confirm.disabled = false;
      }
    },
  }, t`Looks right`);
  return h('div', { class: 'screen' }, crumbs,
    h('h1', { class: 'title', text: String(booking.title || booking.id || t`Booking`) }),
    h('p', {}, confirmed ? h('span', { class: 'chip ok', text: t`Confirmed` }) : h('span', { class: 'chip check', text: t`Check this against the original, then confirm it.` })),
    h('dl', { class: 'facts' }, ...bookingLines(booking).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
    booking.place?.name ? h('div', { class: 'acts' }, h('a', { class: 'btn', href: mapsUrl(booking.place, platform()), target: '_blank', rel: 'noopener noreferrer' }, t`Open in Maps`)) : null,
    await original(ctx, id, booking.source),
    h('div', { class: 'acts' }, confirm, h('a', { class: 'btn', href: fileHref(id, path) }, t`Change it`)),
    problem);
}

/** The original a booking was read from: a photo is shown, anything else is a link. @param {any} ctx @param {string} id @param {unknown} source */
async function original(ctx, id, source) {
  const path = typeof source === 'string' ? source.replace(/^\/trip(?=\/)/, '') : '';
  /** @type {any} */
  let entry = null;
  try {
    entry = path ? await ctx.store.tx(['files'], 'readonly', (/** @type {any} */ t) => t.getFile(id, normPath(path))) : null;
  } catch {
    entry = null; // not a path
  }
  if (!entry) return h('p', { class: 'sub warn', text: path ? t`The original, ${path}, isn't in the trip.` : t`This booking doesn't say which file it came from.` });
  const link = h('a', { class: 'btn', href: fileHref(id, entry.path) }, t`Open the original`);
  if (!entry.type.startsWith('image/')) return h('div', { class: 'original' }, h('p', { class: 'sub', text: t`From ${entry.path}` }), h('div', { class: 'acts' }, link));
  const img = h('img', { class: 'card-image', alt: t`The original, ${entry.path}` });
  ctx.ws.read(id, entry.path).then((/** @type {any} */ got) => {
    if (got) img.src = URL.createObjectURL(new Blob([got.bytes], { type: got.entry.type }));
  }).catch(() => {});
  return h('div', { class: 'original' }, img, h('div', { class: 'acts' }, link));
}
