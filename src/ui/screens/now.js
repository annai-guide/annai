import { h } from '../dom.js';
import { upcoming, sunPlace } from '../../core/now.js';
import { sunChips } from '../../core/sun.js';
import { distanceText } from '../../core/plan.js';
import { storedTexts } from '../../core/agent/log.js';
import { renderCard } from '../cards.js';
import { liveText, knownFix } from '../live-chip.js';
import { tripRows } from '../trip-rows.js';
import { fileHref } from '../format.js';
import { packLine } from '../offline-pack.js';

/**
 * Now (spec §16.2), the home screen during a trip: where you are, golden hour and other chips, the
 * next items as a timetable, and the latest card. When live mode says moving fast, it hands over
 * to Driving (choice 4).
 * @param {any} ctx
 */
export async function renderNow(ctx) {
  await ctx.agent?.opening.catch(() => {});
  const id = ctx.agent?.trip;
  if (!id) {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'Now' }),
      h('p', { class: 'empty' }, 'Open a trip to see where you are and what is next. ', h('a', { href: '#/trips' }, 'Go to Trips')));
  }
  const { scope, tz, rows } = await tripRows(ctx, id);
  const live = ctx.live;
  const locale = navigator.language || 'en-US';
  const place = h('p', { class: 'now-place' });
  const chips = h('div', { class: 'chips' });
  const start = h('div', { class: 'acts' });
  const draw = () => {
    const now = Date.now();
    place.textContent = whereWords(live, locale);
    const sunAt = sunPlace(live ? knownFix(live, now) : null, rows, now);
    const words = [live ? liveText(live) : null, ...(sunAt ? sunChips(now, sunAt.lat, sunAt.lng, tz) : []), live && !live.online ? 'Offline · reminders still work' : null];
    chips.replaceChildren(...words.filter(Boolean).map((t) => h('span', { class: 'chip', text: String(t) })));
    start.replaceChildren(...(live && !live.on ? [h('button', { class: 'btn pri', type: 'button', onclick: () => live.setLive(true) }, 'Turn on live mode')] : []));
  };
  draw();
  // Hands over when moving fast begins while Now is on screen: not on every fix of a drive already
  // going, so "← Now" from Driving stays on Now (choice 4).
  let was = live?.activity;
  const off = live?.onChange(() => {
    if (!place.isConnected) {
      off?.();
      return;
    }
    draw();
    const began = live.activity === 'moving-fast' && was !== 'moving-fast';
    was = live.activity;
    if (began && live.on && location.hash.startsWith('#/now')) ctx.go('#/drive');
  });
  const next = upcoming(rows, Date.now(), 4);
  const latest = await latestCard(ctx, id);
  return h('div', { class: 'screen now' },
    h('h1', { class: 'title', text: String(scope?.title ?? 'Now') }),
    place, chips, start,
    h('section', { 'aria-label': 'Next' },
      h('h2', { class: 'section', text: 'Next' }),
      next.length ? h('ol', { class: 'timetable' }, ...next.map((r) => nowRow(id, r))) : h('p', { class: 'empty', text: 'Nothing more is planned.' }),
      h('p', {}, h('a', { href: '#/plan' }, 'The whole plan'))),
    await packLine(ctx, id),
    latest ? h('section', { 'aria-label': 'Latest' }, h('h2', { class: 'section', text: 'Latest' }), latest) : null,
    h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/drive' }, 'Driving')));
}

/** Where the user is, in words for them (Shiori's are in the now block). @param {any} live @param {string} locale */
export function whereWords(live, locale) {
  if (!live || !live.on) return "Live mode is off, so annai isn't following where you are.";
  const f = knownFix(live);
  if (!f) {
    if (live.gps === 'denied') return "Location isn't allowed for annai. Tap Live below to say where you are.";
    return live.gps === 'unavailable' ? 'No GPS signal right now. Tap Live below to say where you are.' : 'Finding where you are…';
  }
  const near = live.near(f);
  if (near) return near.m < 100 ? `At ${near.name}` : `Near ${near.name}, ${distanceText(near.m / 1000, locale)}`;
  return `${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}`;
}

/** @param {string} id @param {import('../../core/plan.js').PlanRow} r */
function nowRow(id, r) {
  const it = r.item;
  return h('li', { class: ['plan-row', it.fixed ? 'fixed' : 'flexible'] },
    h('span', { class: 'when', text: r.time }),
    h('span', { class: 'mark', 'aria-hidden': 'true', text: it.fixed ? '●' : '○' }),
    h('a', { class: 'what', href: fileHref(id, r.path) },
      h('span', { class: 'visually-hidden', text: it.fixed ? 'Fixed: ' : 'Flexible: ' }),
      h('span', { class: 'name', text: String(it.title ?? r.path) }),
      it.place?.name ? h('span', { class: 'sub', text: String(it.place.name) }) : null));
}

/** The conversation's latest card: Shiori's card or words, or a reminder annai showed. @param {any} ctx @param {string} scope */
export async function latestCard(ctx, scope) {
  const [e] = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['out.show', 'out.speak', 'reminder'], reverse: true, limit: 1 }));
  return e ? eventCard(ctx, e) : null;
}

/** One of those, drawn: model output as text or through the card renderer, never innerHTML. @param {any} ctx @param {any} e */
export async function eventCard(ctx, e) {
  const d = e.data ?? {};
  const who = () => h('span', { class: 'who', text: 'SHIORI' });
  if (e.type === 'out.show') return h('div', { class: 'shiori-card' }, who(), renderCard(d.card ?? {}, { ctx, onChoice: (o) => ctx.agent.send(o) }));
  if (e.type === 'reminder') return h('p', { class: 'system-line', text: `Reminder${d.aloud ? ', said aloud' : ''}: ${String(d.text ?? '')}` });
  const text = String({ ...d, ...(await storedTexts(ctx.store, e)) }.text ?? '');
  if (!d.voice) return h('div', { class: 'shiori-card' }, who(), h('p', { text }));
  // Said aloud: hidden unless asked (spec §2 principle 4).
  const words = h('p', { text, hidden: true });
  const show = h('button', { class: 'btn ghost', type: 'button', onclick: () => { words.hidden = false; show.remove(); } }, 'Show what she said');
  return h('div', { class: 'shiori-card' }, who(), h('span', { class: 'sub', text: 'Said aloud' }), show, words);
}
