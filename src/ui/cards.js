import { h, t } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { platform } from './platform.js';
import { bookingHref } from './format.js';
import { mount } from './slots.js';

/**
 * Shiori's cards (spec §7.1 show): text, a place, links, a booking, a photo, or a choice. Every
 * value from the model reaches the page as text or through the Markdown renderer.
 * @typedef {{ name: string, address?: string, lat?: number, lng?: number }} Place
 */

/** @param {Place} p @param {string} on 'ios' | 'android' | 'desktop' */
export function mapsUrl(p, on) {
  const where = typeof p.lat === 'number' && typeof p.lng === 'number' ? `${p.lat},${p.lng}` : p.address ?? p.name;
  if (on === 'ios') return `https://maps.apple.com/?q=${encodeURIComponent(p.name)}${typeof p.lat === 'number' ? `&ll=${p.lat},${p.lng}` : `&address=${encodeURIComponent(p.address ?? '')}`}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(where)}`;
}

/** @param {string} path @returns {{ root: 'trip' | 'me', path: string } | null} */
export function tripPath(path) {
  const m = /^\/(trip|me)(\/.+)$/.exec(String(path ?? ''));
  return m ? { root: /** @type {'trip' | 'me'} */ (m[1]), path: m[2] } : null;
}

/** An http(s) URL or null. @param {string} url */
const httpUrl = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
};

/** The running plugin's type a card names, or null. @param {any} ctx @param {any} card */
const typeOf = (ctx, card) => (typeof card?.type === 'string' ? (ctx?.registry?.entries('ui:card-type') ?? []).find((/** @type {any} */ e) => e.item?.type === card.type) ?? null : null);

/** The name of a plugin's kind of card, as its plugin gave it, or '' for annai's own cards. @param {any} ctx @param {any} card */
export const cardKind = (ctx, card) => String(typeOf(ctx, card)?.item.name ?? '');

/** The label over a card: Shiori, or Shiori · <kind> for a plugin's kind of card (spec §16.4), in capitals by CSS. @param {any} ctx @param {any} card */
export function cardWho(ctx, card) {
  const typed = typeOf(ctx, card);
  return typed ? t`Shiori · ${String(typed.item.name)}` : t`Shiori`;
}

/**
 * @param {any} card @param {{ ctx: any, onChoice?: (option: string) => void, say?: (text: string) => Record<string, any> }} o
 *   say: the attributes that mark someone's words (their language, their direction), for every piece of the card that is the model's words
 */
export function renderCard(card, { ctx, onChoice, say = () => ({}) }) {
  // A plugin's kind of card is drawn by its plugin (full trust, its own UI); annai draws the title as text.
  const typed = typeOf(ctx, card);
  if (typed) {
    const body = h('div', { class: 'card-body' });
    mount(ctx, typed, body, (ui) => typed.item.render(card.data && typeof card.data === 'object' ? card.data : {}, body, ui), { what: /* en */ `card type ${card.type}` });
    return h('div', { class: 'card card-typed' }, card.title ? h('strong', { ...say(String(card.title)), class: 'card-title', text: String(card.title) }) : null, body);
  }
  const parts = [];
  if (card.title) parts.push(h('strong', { ...say(String(card.title)), class: 'card-title', text: String(card.title) }));
  if (card.text) parts.push(renderMarkdown(String(card.text), say(String(card.text))));
  if (card.place?.name) {
    const p = card.place;
    const where = p.address ? `${p.name}, ${p.address}` : p.name;
    parts.push(h('div', { class: 'card-place' },
      h('span', { ...say(String(where)), text: where }),
      h('a', { class: 'btn', href: mapsUrl(p, platform()), target: '_blank', rel: 'noopener noreferrer' }, t`Open in Maps`)));
  }
  const links = (Array.isArray(card.links) ? card.links : []).map((/** @type {any} */ l) => ({ label: String(l?.label ?? l?.url ?? ''), url: httpUrl(String(l?.url ?? '')) })).filter((/** @type {any} */ l) => l.url);
  if (links.length) parts.push(h('div', { class: 'acts' }, ...links.map((/** @type {any} */ l) => h('a', { ...say(l.label), class: 'btn', href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.label }))));
  const booking = card.booking ? tripPath(card.booking) : null;
  if (booking?.root === 'trip' && ctx.agent?.trip) parts.push(h('a', { class: 'btn', href: bookingHref(ctx.agent.trip, booking.path) }, t`Open the booking`));
  const image = card.image ? tripPath(card.image) : null;
  if (image) {
    const img = h('img', { class: 'card-image', alt: card.title ? String(card.title) : t`A photo Shiori showed` });
    const scope = image.root === 'trip' ? ctx.agent?.trip : 'me';
    if (scope) {
      ctx.ws.read(scope, image.path).then((/** @type {any} */ got) => {
        if (got && got.entry.type.startsWith('image/')) img.src = URL.createObjectURL(new Blob([got.bytes], { type: got.entry.type }));
      }).catch(() => {});
      parts.push(img);
    }
  }
  if (Array.isArray(card.choice) && card.choice.length) {
    parts.push(h('div', { class: 'acts' }, ...card.choice.slice(0, 6).map((/** @type {any} */ c) => h('button', { ...say(String(c)), class: 'btn', type: 'button', onclick: () => onChoice?.(String(c)) }, String(c)))));
  }
  if (typeof card.type === 'string') parts.push(h('p', { class: 'sub', text: t`This card's kind (${card.type}) comes from a plugin that isn't on.` }));
  return h('div', { class: 'card' }, ...parts);
}
