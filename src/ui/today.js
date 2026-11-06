import { h, t } from './dom.js';
import { sunPlace } from '../core/now.js';
import { sunChips } from '../core/sun.js';
import { dayIn, deviceZone } from '../core/time.js';
import { liveText, knownFix } from './live-chip.js';
import { distance } from './format.js';
import { component, mount, slotEntries } from './slots.js';
import { parseHash } from './router.js';

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
 * Where the shell goes as the activity changes, or null. Once per change, and never from under someone typing. Driving shows the open
 * trip, so it needs one; a plugin's screen doesn't.
 * @param {{ activity: string, was: string | undefined, screens: { pluginId: string, item: any }[], on: boolean, hash: string, typing: boolean, trip: string | null }} o
 * @returns {string | null}
 */
export function takeover({ activity, was, screens, on, hash, typing, trip }) {
  const to = handover(activity, was, screens);
  if (!to || !on || typing || !TAKEN_FROM.has(parseHash(hash).name)) return null;
  return to === '#/drive' && !trip ? null : to;
}

/** A field being typed in. @param {Element | null} el */
export const isField = (el) => Boolean(el?.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=file])'));

/** Driving's ←, to where it was entered from. @param {string | undefined} from @returns {{ href: string, label: string }} */
export const driveBack = (from = '#/now') => ({ href: from, label: from === '#/now' ? t`Now` : t`Back` });

/**
 * What Now and the Itinerary's today open with: where you are, the chips, then plugins' sections. A plugin may draw the
 * first part itself (spec §16.4: now-card); annai's own when there is none or it fails. It keeps itself current until
 * its nodes leave the page, so a tab hides it rather than removing it.
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
    const sunAt = sunPlace(live ? knownFix(live, now) : null, rows, now);
    const words = [live ? liveText(live) : null, ...(sunAt ? sunChips(now, sunAt.lat, sunAt.lng, tz) : []), live && !live.online ? t`Offline · reminders still work` : null];
    chips.replaceChildren(...words.filter(Boolean).map((w) => h('span', { class: 'chip', text: String(w) })));
    start.replaceChildren(...(live && !live.on ? [h('button', { class: 'btn pri', type: 'button', onclick: () => live.setLive(true) }, t`Turn GPS on`)] : []));
  };
  draw();
  const off = live?.onChange(() => {
    if (!place.isConnected && !top.isConnected) {
      off?.();
      return;
    }
    draw();
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
