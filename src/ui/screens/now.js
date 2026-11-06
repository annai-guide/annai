import { h, t, tc } from '../dom.js';
import { reminderParts } from './talk.js';
import { upcoming } from '../../core/now.js';
import { storedTexts } from '../../core/agent/log.js';
import { readAppSettings } from '../../core/settings.js';
import { shownSettings } from '../../core/shown.js';
import { shownCard, cardWho } from '../cards.js';
import { tripRows } from '../trip-rows.js';
import { detailsHref, rowName, wording, sentenceGap } from '../format.js';
import { packLine } from '../offline-pack.js';
import { component, mount } from '../slots.js';
import { nowOf, todayTop } from '../today.js';

/**
 * Now (spec §16.2), the home screen during a trip: where you are, golden hour and other chips, the
 * next items as a timetable, and the latest card.
 * @param {any} ctx
 */
export async function renderNow(ctx) {
  await ctx.agent?.opening.catch(() => {});
  const id = ctx.agent?.trip;
  if (!id) {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: t`Now` }),
      h('p', { class: 'empty' }, t`Open a trip to see where you are and what is next.`, sentenceGap(), h('a', { href: '#/trips' }, t`Go to Trips`)));
  }
  const { scope, tz, rows } = await tripRows(ctx, id);
  const live = ctx.live;
  const next = upcoming(rows, nowOf(live), 4);
  const latest = await latestCard(ctx, id);
  const title = String(scope?.title ?? t`Now`);
  const pack = await packLine(ctx, id);
  return h('div', { class: 'screen now' },
    h('h1', { class: 'title', text: title }),
    todayTop(ctx, { title, rows, tz }),
    h('section', { 'aria-label': tc('coming up')`Next` },
      h('h2', { class: 'section', text: tc('coming up')`Next` }),
      next.length ? h('ol', { class: 'timetable' }, ...next.map((r) => planRowOf(ctx, id, r, r.time, () => nowRow(id, r)))) : h('p', { class: 'empty', text: t`Nothing more is planned.` }),
      h('p', {}, h('a', { href: '#/plan' }, t`The whole itinerary`))),
    pack,
    latest ? h('section', { 'aria-label': t`Latest` }, h('h2', { class: 'section', text: t`Latest` }), latest) : null,
    h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/drive' }, t`Driving`)));
}

/**
 * A timetable row: a plugin's (spec §16.4: plan-row) when one replaces annai's, else annai's own, which
 * also takes the place of a plugin's that fails, at once or later.
 * @param {any} ctx @param {string} trip @param {import('../../core/plan.js').PlanRow} r @param {string} when @param {() => HTMLElement} own
 */
export function planRowOf(ctx, trip, r, when, own) {
  const c = component(ctx, 'plan-row');
  if (!c) return own();
  const it = r.item;
  const li = h('li', { class: ['plan-row', 'plugin-row', it.fixed ? 'fixed' : 'flexible'] });
  const row = { trip, path: r.path, when, title: rowName(r), fixed: Boolean(it.fixed), place: it.place?.name ? String(it.place.name) : '', kind: String(it.kind ?? '') };
  /** @type {HTMLElement | null} */
  let instead = null;
  mount(ctx, c, li, (ui) => c.item.render(li, row, ui), {
    what: 'plan-row',
    onFail: () => {
      instead = own();
      li.parentNode?.replaceChild(instead, li); // a later failure: the row is already in its list
    },
  });
  return instead ?? li;
}

/** @param {string} id @param {import('../../core/plan.js').PlanRow} r */
function nowRow(id, r) {
  const it = r.item;
  return h('li', { class: ['plan-row', it.fixed ? 'fixed' : 'flexible'] },
    h('span', { class: 'when', text: r.time }),
    h('span', { class: 'mark', 'aria-hidden': 'true', text: it.fixed ? '●' : '○' }),
    h('a', { class: 'what', href: detailsHref(id, r, '#/now') },
      h('span', { class: 'visually-hidden', text: it.fixed ? t`Fixed:` : t`Flexible:` }), ' ',
      h('span', { class: 'name', text: rowName(r) }),
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
  const app = await readAppSettings(ctx.ws);
  const hers = wording(app, true);
  const who = () => h('span', { class: 'who', text: t`Shiori` });
  if (e.type === 'out.show') return h('div', { class: 'shiori-card' }, h('span', { class: 'who', text: cardWho(ctx, d.card ?? {}) }), shownCard(d, { ctx, onChoice: (o) => ctx.agent.send(o, { chose: true }), say: hers }));
  if (e.type === 'reminder') return h('p', { class: 'system-line' }, ...reminderParts(d, wording(app)));
  const text = String({ ...d, ...(await storedTexts(ctx.store, e)) }.text ?? '');
  if (!d.voice) return h('div', { class: 'shiori-card' }, who(), h('p', { ...hers(text), text }));
  // Said aloud: its words show, marked; with "Show what she says" off they fold away until asked (spec §2 principle 4, §16.1).
  if (shownSettings(app).showWords) return h('div', { class: 'shiori-card' }, h('span', { class: 'who-row' }, who(), h('span', { class: 'sub said-mark', text: t`said aloud` })), h('p', { ...hers(text), class: 'said-words', text }));
  const words = h('p', { ...hers(text), text, hidden: true });
  const show = h('button', { class: 'btn ghost', type: 'button', onclick: () => { words.hidden = false; show.remove(); } }, t`Show what she said`);
  return h('div', { class: 'shiori-card' }, who(), h('span', { class: 'sub', text: t`Said aloud` }), show, words);
}

