import { h, crumb, t, tc, twoStep } from '../dom.js';
import { bookingFacts, BOOKING_KINDS, fileHref, bookingHref, itemHref, day, fileLine } from '../format.js';
import { checkOf } from '../../core/bookings.js';
import { normPath, inTrip, isGivenFile } from '../../core/paths.js';
import { readTripFiles, fileDetails } from '../../core/trip-files.js';
import { readNames, shortName } from '../../core/names.js';
import { mapsUrl } from '../cards.js';
import { platform } from '../platform.js';
import { askAboutButton } from '../composer.js';
import { filePreview } from '../preview.js';
import { saveFile } from '../save.js';
import { deleteGroup, afterDelete } from '../file-delete.js';
import { cameFrom, backLabel } from './file.js';

/**
 * The details screen (the file-details design): a file the user gave and every booking Shiori read from it, or a booking with no file.
 * `path` is a file under /files/ or a booking under /bookings/, and a booking whose file is there opens its file's screen at its block.
 * Each booking is a block (what she read, the "check" marks on details she is unsure of, the plan items that stand for it); then the
 * preview of the file and the buttons: Open, Download, Ask Shiori about this, Change it (the raw form), Open in Maps. Where it was opened
 * from is the crumb. @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route
 */
export async function renderBooking(ctx, route) {
  const id = route.parts[1];
  const path = route.params.path ?? '';
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ x) => x.getScope(id));
  if (!scope || scope.kind !== 'trip') {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: t`This trip isn't on this device` }), h('p', {}, h('a', { href: '#/trips' }, t`Back to Trips`)));
  }
  const crumbs = backCrumb(ctx, id, route.params.from, { trip: scope.title });
  const all = await readTripFiles(ctx.ws, ctx.store, id);
  const d = fileDetails(all, path);
  if (!d) {
    return h('div', { class: 'screen' }, crumbs,
      path.startsWith('/files/') || path.startsWith('/trip/files/')
        ? [h('h1', { class: 'title', text: t`This file isn't in the trip` }), h('p', { class: 'sub', text: t`It may have been deleted or renamed.` })]
        : [h('h1', { class: 'title', text: t`This booking isn't in the trip` }), h('p', { class: 'sub', text: t`It may have been deleted or renamed. The plan lists the bookings there are.` })]);
  }
  const here = bookingHref(id, path, route.params.from);
  const { file, blocks, made } = d;
  const many = blocks.length > 1;
  const lone = blocks.length === 1 ? blocks[0] : null;
  /** @param {import('../../core/trip-files.js').Block} b */
  const kindOf = (b) => BOOKING_KINDS[b.booking.kind] ?? t`Booking`;
  /** @param {import('../../core/trip-files.js').Block} b */
  const titleOf = (b) => (typeof b.booking.title === 'string' && b.booking.title.trim() ? b.booking.title : '');
  /** @param {import('../../core/trip-files.js').Block} b */
  const unsureTitle = (b) => checkOf(b.booking).fields.includes('title');
  /** @param {import('../../core/trip-files.js').Block} b */
  const kindDay = (b) => [kindOf(b), b.day ? day(b.day, true) : null].filter(Boolean).join(' · ');
  const heading = file?.name ?? (titleOf(blocks[0]) || kindOf(blocks[0])); // no file means the one booking it is

  /**
   * @param {import('../../core/trip-files.js').Planned[]} items @param {string} level h2 or h3 @param {string} heading
   * @param {string} [label] the region's name, when heading alone would name two regions alike (each block's, by its block)
   */
  const planList = (items, level, heading, label) => h('section', { class: 'block-items', 'aria-label': label ?? heading },
    h(level, { class: 'section', text: heading }),
    h('ul', { class: 'plan-items' }, ...items.map((i) => h('li', {},
      h('a', { href: itemHref(id, i.path, here), dir: 'auto', text: [typeof i.item.title === 'string' && i.item.title.trim() ? i.item.title : t`Plan item`, i.day ? day(i.day, true) : null].filter(Boolean).join(' · ') }),
      typeof i.item.notes === 'string' && i.item.notes.trim() ? h('p', { class: 'sub notes', dir: 'auto', text: i.item.notes }) : null))));

  const blockViews = blocks.map((b, i) => {
    const facts = bookingFacts(b.booking, { fallbackTz: all.fallbackTz });
    const marks = checkOf(b.booking);
    const title = titleOf(b);
    /** @type {HTMLElement | null} */
    let top = null;
    if (many) {
      top = h('h2', { class: 'section', id: `block-${i}`, tabindex: '-1', dir: 'auto' }, title || kindDay(b), unsureTitle(b) && title ? [' ', checkMark()] : null);
    } else if (title && title !== heading) {
      top = h('h2', { class: 'section', dir: 'auto' }, title, unsureTitle(b) ? [' ', checkMark()] : null);
    }
    return h('section', { class: 'booking-block', 'aria-labelledby': many ? `block-${i}` : null },
      top,
      many && !title ? null : h('p', { class: 'sub', text: kindDay(b) }), // an untitled block's heading says it already
      // A booking from before single details were marked: the whole of it, until she is told it's right.
      marks.whole ? h('p', { class: 'check-banner', role: 'note', text: t`Check this: Shiori read it before annai marked single details. Tell her if it's right, or what's wrong.` }) : null,
      facts.length ? h('dl', { class: 'facts' }, ...facts.flatMap((f) => [
        h('dt', { lang: f.lang, text: f.label }),
        h('dd', {}, h('span', { dir: 'auto' }, ...zoned(f.value, f.zone)), f.unsure ? [' ', checkMark()] : null)])) : null,
      b.items.length ? planList(b.items, many ? 'h3' : 'h2', t`On the plan`, many ? t`On the plan: ${title || kindDay(b)}` : undefined) : null,
      many ? h('div', { class: 'acts' },
        b.booking.place?.name ? h('a', { class: 'btn', href: mapsUrl(b.booking.place, platform()), target: '_blank', rel: 'noopener noreferrer' }, t`Open in Maps`) : null,
        h('a', { class: 'btn', href: fileHref(id, b.path, here) }, t`Change it`)) : null);
  });

  // The file, as stored: its preview, and the words the original is named by.
  const bytes = file ? await ctx.ws.read(id, file.path).catch(() => undefined) : undefined;
  // A booking with no file of its own: the file it names, when there is one (a note, say), or in words when one it gave is gone.
  const lonely = !file && lone ? inTrip(lone.booking.source) : '';
  const elsewhere = lonely && (isGivenFile(lonely) || all.files.some((f) => f.path === lonely)) ? await original(ctx, id, lonely, here) : null;
  const refs = [
    ...(file ? [{ scope: id, path: file.path, name: file.name }] : []),
    ...blocks.map((b) => ({ scope: id, path: b.path, name: titleOf(b) || kindOf(b) })),
  ];
  const screen = h('div', { class: 'screen details' }, crumbs,
    h('h1', { class: 'title', dir: 'auto' }, heading, lone && !file ? (unsureTitle(lone) && titleOf(lone) ? [' ', checkMark()] : null) : lone && file && heading === titleOf(lone) && unsureTitle(lone) ? [' ', checkMark()] : null),
    // What the file is, under its name: when it became nothing yet, or several bookings (one booking's block says it already).
    (!blocks.length && !made.length) || many ? (file && fileLine(file.became) ? h('p', { class: 'sub', text: fileLine(file.became) }) : null) : null,
    ...blockViews,
    made.length ? planList(made, 'h2', t`Plan items from a calendar`) : null,
    file ? h('section', { class: 'original', 'aria-label': many ? null : t`The original`, 'aria-labelledby': many ? 'the-file' : null },
      // With several bookings above, the file's own part is headed, so it doesn't read as the last booking's; the heading names the region.
      many ? h('h2', { class: 'section', id: 'the-file', text: t`The file` }) : null,
      opens(await filePreview(ctx, id, file.path, { name: file.name }), fileHref(id, file.path, here)),
      h('p', { class: 'sub', dir: 'auto', text: tc('a file')`From ${file.real}` })) : null,
    elsewhere,
    h('div', { class: 'acts' },
      file ? h('a', { class: 'btn', href: fileHref(id, file.path, here) }, t`Open`) : null,
      file && bytes ? h('button', { class: 'btn', type: 'button', onclick: () => saveFile(new Blob([/** @type {BlobPart} */ (bytes.bytes)], { type: bytes.entry.type }), file.real) }, t`Download`) : null,
      askAboutButton(ctx, refs),
      lone ? h('a', { class: 'btn', href: fileHref(id, lone.path, here) }, t`Change it`) : null,
      lone?.booking.place?.name ? h('a', { class: 'btn', href: mapsUrl(lone.booking.place, platform()), target: '_blank', rel: 'noopener noreferrer' }, t`Open in Maps`) : null,
      // The file and what Shiori read from it go together (the user, 2026-11-01); the Plan no longer shows them.
      twoStep(t`Delete`, t`Tap again to delete`, async () => {
        const gone = await deleteGroup(ctx, id, d);
        if (gone) ctx.go(afterDelete(cameFrom(route.params.from, id, ctx.agent?.trip ?? null)?.hash ?? `#/trip/${encodeURIComponent(id)}`, gone, id));
      })));
  // A tap on one of several bookings lands on its block; the shell's own scrollTo has run before this frame.
  const target = many && d.focus ? screen.querySelector(`#block-${blocks.findIndex((b) => b.path === d.focus)}`) : null;
  if (target instanceof HTMLElement) {
    requestAnimationFrame(() => {
      if (!target.isConnected) return;
      target.scrollIntoView({ block: 'start' });
      // The top bar sticks over the first of the screen: its block starts under it.
      const bar = document.querySelector('header.topbar');
      if (bar) scrollBy(0, -(bar.getBoundingClientRect().height + 8));
      target.focus({ preventScroll: true });
    });
  }
  return screen;
}

/**
 * A fact's words with its zone note ("(Anchorage time)", brackets and all) kept whole on one line. @param {string} value
 * @param {string} [zone] the zone's words, within value @returns {(string | HTMLElement)[]}
 */
function zoned(value, zone) {
  const i = zone ? value.lastIndexOf(zone) : -1;
  if (!zone || i < 0) return [value];
  const from = /[(（]/.test(value[i - 1] ?? '') ? i - 1 : i;
  const to = /[)）]/.test(value[i + zone.length] ?? '') ? i + zone.length + 1 : i + zone.length;
  return [value.slice(0, from), h('span', { class: 'zone-note', text: value.slice(from, to) }), value.slice(to)];
}

/** A file card stands for the file: a tap opens it, as Open does; a picture is left as it is. @param {HTMLElement | null} preview @param {string} href */
function opens(preview, href) {
  return preview?.classList.contains('file-card') ? h('a', { class: 'file-card-link', href }, preview) : preview;
}

/** A detail Shiori isn't sure of: a light mark, with words for screen readers. */
export function checkMark() {
  return h('span', { class: 'chip check mark-check' },
    h('span', { 'aria-hidden': 'true', text: tc('a detail to check')`check` }),
    h('span', { class: 'visually-hidden', text: t`Shiori isn't sure of this` }));
}

/**
 * The crumb of a details screen: back to where it was opened from (the trip, the Plan, Now, the Conversation, a plan item), else the
 * trip when `o.trip` (its title) is given, else the trip's Plan.
 * @param {any} ctx @param {string} id @param {string | undefined} from @param {{ trip?: string }} [o]
 */
export function backCrumb(ctx, id, from, o = {}) {
  const back = cameFrom(from, id, ctx.agent?.trip ?? null);
  const trip = `#/trip/${encodeURIComponent(id)}`;
  const link = o.trip === undefined
    ? (back ? crumb(back.hash, backLabel(back.name)) : crumb(`${trip}/plan`, t`Plan`))
    : back && back.name !== 'trip' ? crumb(back.hash, backLabel(back.name)) : crumb(trip, h('span', { dir: 'auto', text: o.trip }));
  return h('p', { class: 'crumbs' }, link);
}

/**
 * The file something came from, for a plan item's details: its preview (or card) by its short name, and Open the original, which leads to
 * the file's details screen (its raw screen for a file outside /files/) and comes back here; in words when it isn't there. Nothing when
 * no file is named. @param {any} ctx @param {string} id @param {unknown} source @param {string} here
 */
export async function original(ctx, id, source, here) {
  const path = inTrip(source);
  if (!path) return null;
  const names = await readNames(ctx.ws, id);
  const name = shortName(names, path);
  /** @type {any} */
  let entry = null;
  try {
    entry = await ctx.store.tx(['files'], 'readonly', (/** @type {any} */ t) => t.getFile(id, normPath(path)));
  } catch {
    entry = null; // not a path
  }
  if (!entry) return h('p', { class: 'sub warn', text: t`The original, ${name}, isn't in the trip.` });
  const there = isGivenFile(entry.path);
  return h('section', { class: 'original', 'aria-label': t`The original` },
    await filePreview(ctx, id, entry.path, { name }),
    h('p', { class: 'sub', dir: 'auto', text: tc('a file')`From ${name}` }),
    h('div', { class: 'acts' }, h('a', { class: 'btn', href: there ? bookingHref(id, entry.path, here) : fileHref(id, entry.path, here) }, t`Open the original`)));
}
