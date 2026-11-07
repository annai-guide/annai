import { h, t } from './dom.js';
import { sunPlace } from '../core/now.js';
import { sunChips } from '../core/sun.js';
import { dayIn, deviceZone } from '../core/time.js';
import { liveText, knownFix } from './live-chip.js';
import { distance } from './format.js';
import { component, mount, slotEntries } from './slots.js';
import { parseHash } from './router.js';
import { updateAppSettings } from '../core/settings.js';

/** Now, by live mode's own clock: a simulation's while one runs (spec §13). @param {any} live */
export const nowOf = (live) => live?.clock?.now() ?? Date.now();

/** Today's date on live mode's clock and zone, so a simulation's day counts. @param {any} live */
export const todayOf = (live) => dayIn(nowOf(live), live?.timeZone?.() ?? deviceZone());

/** Where the user is, in words for them (Shiori's are in the now block). @param {any} live */
export function whereWords(live) {
  if (!live || !live.on) return t`GPS is off, so annai isn't following where you are.`;
  const f = knownFix(live);
  if (!f) {
    if (live.gps === 'denied') return t`Location isn't allowed for annai. Open Driving to say where you are.`;
    return live.gps === 'unavailable' ? t`No GPS signal right now. Open Driving to say where you are.` : t`Finding where you are…`;
  }
  const near = live.near(f);
  if (near) return near.m < 100 ? t`At ${near.name}` : t`Near ${near.name}, ≈ ${distance(near.m / 1000)}`;
  return `${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}`;
}

/**
 * Where the activity changing hands over to: a running plugin's screen for that activity (the last one
 * registered), else Driving for moving fast, else nowhere.
 * @param {string} activity @param {string | undefined} was @param {{ pluginId: string, item: any }[]} screens @returns {string | null}
 */
export function handover(activity, was, screens) {
  if (activity === was) return null;
  const home = screens.filter((e) => e.item?.homeFor === activity).pop();
  if (home) return `#/ext/${encodeURIComponent(home.pluginId)}/${encodeURIComponent(home.item.id)}`;
  return activity === 'moving-fast' ? '#/drive' : null;
}

/** The screens a take-over may leave: where the user looks at the trip, not where they are doing something else. */
const TAKEN_FROM = new Set(['trips', 'talk', 'plan', 'now']);

/**
 * Where the shell goes as the activity changes, or null. Once per drive: not from under someone typing, and not when moving fast starts again after a light
 * (same). Driving shows a trip (drivingTrip), so it needs one; a plugin's screen doesn't.
 * @param {{ activity: string, was: string | undefined, screens: { pluginId: string, item: any }[], on: boolean, hash: string, typing: boolean, trip: string | null, same: boolean }} o
 * @returns {string | null}
 */
export function takeover({ activity, was, screens, on, hash, typing, trip, same }) {
  const to = handover(activity, was, screens);
  if (!to || !on || typing || (same && activity === 'moving-fast') || !TAKEN_FROM.has(parseHash(hash).name)) return null;
  return to === '#/drive' && !trip ? null : to;
}

/**
 * Follows the activity for the shell: Driving, or a plugin's screen, takes over as it changes. The returned function seeds what "changed" is measured
 * from, once live mode has restored the drive record (a reload does that after the shell starts).
 * @param {any} live @param {{ screens: () => any[], hash: () => string, typing: () => boolean, trip: () => string | null, go: (to: string) => void }} o @returns {() => void}
 */
export function followDrive(live, o) {
  let was = live?.activity;
  live?.onChange(() => {
    const to = takeover({ activity: live.activity, was, screens: o.screens(), on: live.on, hash: o.hash(), typing: o.typing(), trip: o.trip(), same: live.sameDrive });
    was = live.activity;
    if (to) o.go(to);
  });
  return () => { was = live?.activity; };
}

/** The trip Driving shows: the one in play, which is the open one when none is happening. A quick chat doesn't take the road with it. @param {any} ctx @returns {string | null} */
export const drivingTrip = (ctx) => ctx.live?.play ?? null;

/**
 * Hears the trip in play move. It's told with reminders, whose trip it is: after the rows load and at midnight. A tell on onChange at start would beat followDrive's seed and take over.
 * @param {any} live @param {() => string | null} trip @param {() => void} moved
 */
export function followPlay(live, trip, moved) {
  let was = trip();
  live?.onReminders(() => {
    if (trip() === was) return;
    was = trip();
    moved();
  });
}

/**
 * A quick ask from Driving, in the trip in play now: opened first, unless a live session is open, which opening would close; it then goes to the
 * open conversation. A trip that won't open throws, and nothing is asked. @param {any} ctx @param {string} text
 */
export async function askIn(ctx, text) {
  const id = drivingTrip(ctx);
  if (id !== ctx.agent.target && !ctx.agent.sessionOpen) {
    await updateAppSettings(ctx.ws, { activeTrip: id });
    await ctx.agent.open(id);
  }
  ctx.agent.send(text, { chose: true });
}

/** A field being typed in. @param {Element | null} el */
export const isField = (el) => Boolean(el?.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=file])'));

/** Driving's ←, to where it was entered from. @param {string | undefined} from @returns {{ href: string, label: string }} */
export const driveBack = (from = '#/now') => ({ href: from, label: from === '#/now' ? t`Now` : t`Back` });

/**
 * What Now and the Itinerary's today open with: where you are, the chips, then plugins' sections. A plugin may draw the first part itself (spec §16.4: now-card); annai's own
 * when there is none or it fails. It keeps itself current until its nodes leave the page, so a tab hides it rather than removing it.
 * @param {any} ctx @param {{ title: string, rows: import('../core/plan.js').PlanRow[], tz: string }} o @returns {HTMLElement[]}
 */
export function todayTop(ctx, { title, rows, tz }) {
  const live = ctx.live;
  const place = h('p', { class: 'now-place' });
  const chips = h('div', { class: 'chips' });
  const start = h('div', { class: 'acts' });
  const top = h('div', { class: 'now-card' });
  const draw = () => {
    const now = nowOf(live);
    place.textContent = whereWords(live);
    const here = live ? knownFix(live, now) : null;
    place.classList.toggle('at', Boolean(here));
    const sunAt = sunPlace(here, rows, now);
    const words = [live ? liveText(live) : null, ...(sunAt ? sunChips(now, sunAt.lat, sunAt.lng, tz) : []), live && !live.online ? t`Offline · reminders still work` : null];
    chips.replaceChildren(...words.filter(Boolean).map((w) => h('span', { class: 'chip', text: String(w) })));
    start.replaceChildren(...(live && !live.on ? [h('button', { class: 'btn pri', type: 'button', onclick: () => live.setLive(true) }, t`Turn GPS on`)] : []));
  };
  draw();
  const off = live?.onChange(() => {
    if (!top.isConnected) {
      off?.();
      return;
    }
    const was = top.getBoundingClientRect();
    draw();
    const by = top.getBoundingClientRect().bottom - was.bottom;
    if (was.top < 0 && by) scrollBy(0, by); // no anchoring here (base.css): rows being read hold still; nothing to move, no scroll (a flick on an older iPhone)
  });
  const card = component(ctx, 'now-card');
  if (card) {
    const words = [live ? liveText(live) : null, live && !live.online ? t`Offline · reminders still work` : null].filter(Boolean);
    mount(ctx, card, top, (ui) => card.item.render(top, ui, { title, place: whereWords(live), chips: words, liveOn: Boolean(live?.on) }), {
      what: 'now-card', onFail: () => { top.hidden = false; top.replaceChildren(place, chips, start); },
    });
  } else {
    top.append(place, chips, start);
  }
  return [top, ...slotEntries(ctx, 'ui:now-section').map((e) => {
    const el = h('section', { class: 'now-section', 'aria-label': String(e.item.title) });
    mount(ctx, e, el, (ui) => e.item.render(el, ui), { what: /* en */ `Now section ${e.item.id}` });
    return el;
  })];
}
