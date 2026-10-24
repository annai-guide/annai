import { h, crumb, t } from '../dom.js';
import { routeStrip } from '../../core/now.js';
import { loadLinks, mapsLinks } from '../../core/links.js';
import { tripRows } from '../trip-rows.js';
import { distance, duration, sentenceGap } from '../format.js';
import { knownFix } from '../live-chip.js';
import { latestCard, eventCard, nowOf } from './now.js';

/** Big quick-ask buttons (spec §16.2): what each says to Shiori, as the user's own words, so in their language. */
const QUICK = [
  [t`What's around here?`, t`What is around us right now that is worth knowing about?`],
  [t`Food`, t`Where can we eat along the way?`],
  [t`Fuel`, t`Where is the next fuel station or charger?`],
  [t`Restroom`, t`Where is the nearest restroom?`],
];

/** How far and how long to a stop, for the road ahead: "≈ 26 mi · about 1 hr, 12 min"; a minute at least, even standing at it. @param {{ km: number | null, minutes: number | null }} s */
export const roadText = (s) => (s.km === null ? '' : `≈ ${distance(s.km)} · ${t`about ${duration(Math.max(1, s.minutes ?? 0) * 60_000)}`}`);

/** Keep the screen on, for what live mode says the user is doing: a whole message each. @param {string} activity */
const keepOnText = (activity) => (activity === 'moving-fast' ? t`Keep the screen on while driving or riding` : activity === 'walking' ? t`Keep the screen on while walking`
  : activity === 'still' ? t`Keep the screen on while stopped` : t`Keep the screen on while GPS is on`);

/**
 * Driving (spec §16.2): the route strip, a maps card, big quick-ask buttons, and the big dock
 * ("voice layouts, such as driving, enlarge the dock"). Shiori's latest words or card show here, so
 * nothing needs the Conversation while driving.
 * @param {any} ctx
 */
export async function renderDrive(ctx) {
  await ctx.agent?.opening.catch(() => {});
  const id = ctx.agent?.trip;
  if (!id) {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: t`Driving` }),
      h('p', { class: 'empty' }, t`Open a trip to see the road ahead.`, sentenceGap(), h('a', { href: '#/trips' }, t`Go to Trips`)));
  }
  const { rows } = await tripRows(ctx, id);
  const live = ctx.live;
  const links = await loadLinks({ ws: ctx.ws }).catch(() => null);
  const strip = h('ol', { class: 'route-strip', 'aria-label': t`The road ahead` });
  const maps = h('div', { class: 'maps-card' });
  const ask = h('div', { class: 'quick-ask' });
  const awake = h('div', { class: 'acts' });
  const latest = h('div', { class: 'drive-latest', 'aria-live': 'polite' });
  const draw = () => {
    const here = live ? knownFix(live) : null; // not a position from before the GPS was lost
    const stops = routeStrip(rows, here, nowOf(live), live?.activity ?? 'unknown');
    strip.replaceChildren(
      h('li', { class: 'you' }, here ? t`You` : live?.on ? t`You (finding where)` : t`You (GPS off)`),
      ...stops.map((s) => h('li', {},
        h('span', { class: 'name', text: s.name }),
        h('span', { class: 'sub', text: [s.row.time ? t`at ${s.row.time}` : '', roadText(s)].filter(Boolean).join(' · ') }))),
      ...(stops.length ? [] : [h('li', { class: 'empty', text: t`Nothing more is planned with a place.` })]));
    const next = stops[0];
    maps.replaceChildren(...(!next ? [] : links ? [
      h('strong', { class: 'card-title', text: t`Directions to ${next.name}` }),
      h('div', { class: 'acts' }, ...mapsLinks(links, { destination: `${next.place.lat},${next.place.lng}`, ...(here ? { origin: `${here.lat},${here.lng}` } : {}), mode: 'drive' })
        .map((l) => h('a', { class: 'btn', href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.label }))),
    ] : [h('p', { class: 'sub', text: t`annai hasn't downloaded its maps links yet; it needs to be online once.` })]));
    const quick = [...QUICK, [t`How long?`, next ? t`How long until we reach ${next.name}?` : t`How long until our next stop?`]];
    ask.replaceChildren(...quick.map(([label, text]) => h('button', {
      class: 'btn big', type: 'button',
      onclick: () => {
        ctx.agent.send(text);
        ctx.notices.toast(t`Asked Shiori: ${text}`);
      },
    }, label)));
    const a = ctx.awake;
    awake.replaceChildren(...(live?.on && a?.available
      ? [h('button', { class: 'btn', type: 'button', 'aria-pressed': String(a.chosen), onclick: async () => { await a.choose(!a.chosen); draw(); } }, keepOnText(live.activity))]
      : live && !live.on ? [h('button', { class: 'btn pri', type: 'button', onclick: () => live.setLive(true) }, t`Turn GPS on`)] : []));
  };
  draw();
  const first = await latestCard(ctx, id);
  if (first) latest.replaceChildren(first);
  const offLive = live?.onChange(() => {
    if (!strip.isConnected) {
      offLive?.();
      return;
    }
    draw();
  });
  const offEvents = ctx.agent.on('event', async (/** @type {any} */ e) => {
    if (!strip.isConnected) {
      offEvents();
      return;
    }
    if (e.scope === id && ['out.show', 'out.speak', 'reminder'].includes(e.type)) latest.replaceChildren(await eventCard(ctx, e));
  });
  // The big dock while Driving is on screen.
  ctx.dock?.setLarge(true);
  const leave = () => {
    if (location.hash.startsWith('#/drive')) return;
    ctx.dock?.setLarge(false);
    removeEventListener('hashchange', leave);
  };
  addEventListener('hashchange', leave);
  return h('div', { class: 'screen drive' },
    h('h1', { class: 'title', text: t`Driving` }),
    strip, maps, ask, latest, awake,
    h('p', {}, crumb('#/now', t`Now`)));
}
