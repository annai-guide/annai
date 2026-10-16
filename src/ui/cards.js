import { h } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { platform } from './platform.js';
import { fileHref } from './format.js';

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

/** @param {any} card @param {{ ctx: any, onChoice?: (option: string) => void }} o */
export function renderCard(card, { ctx, onChoice }) {
  const parts = [];
  if (card.title) parts.push(h('strong', { class: 'card-title', text: String(card.title) }));
  if (card.text) parts.push(renderMarkdown(String(card.text)));
  if (card.place?.name) {
    const p = card.place;
    parts.push(h('div', { class: 'card-place' },
      h('span', { text: p.address ? `${p.name}, ${p.address}` : p.name }),
      h('a', { class: 'btn', href: mapsUrl(p, platform()), target: '_blank', rel: 'noopener noreferrer' }, 'Open in Maps')));
  }
  const links = (Array.isArray(card.links) ? card.links : []).map((/** @type {any} */ l) => ({ label: String(l?.label ?? l?.url ?? ''), url: httpUrl(String(l?.url ?? '')) })).filter((/** @type {any} */ l) => l.url);
  if (links.length) parts.push(h('div', { class: 'acts' }, ...links.map((/** @type {any} */ l) => h('a', { class: 'btn', href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.label }))));
  const booking = card.booking ? tripPath(card.booking) : null;
  if (booking?.root === 'trip' && ctx.agent?.trip) parts.push(h('a', { class: 'btn', href: fileHref(ctx.agent.trip, booking.path) }, 'Open the booking'));
  const image = card.image ? tripPath(card.image) : null;
  if (image) {
    const img = h('img', { class: 'card-image', alt: card.title ? String(card.title) : 'A photo Shiori showed' });
    const scope = image.root === 'trip' ? ctx.agent?.trip : 'me';
    if (scope) {
      ctx.ws.read(scope, image.path).then((/** @type {any} */ got) => {
        if (got && got.entry.type.startsWith('image/')) img.src = URL.createObjectURL(new Blob([got.bytes], { type: got.entry.type }));
      }).catch(() => {});
      parts.push(img);
    }
  }
  if (Array.isArray(card.choice) && card.choice.length) {
    parts.push(h('div', { class: 'acts' }, ...card.choice.slice(0, 6).map((/** @type {any} */ c) => h('button', { class: 'btn', type: 'button', onclick: () => onChoice?.(String(c)) }, String(c)))));
  }
  return h('div', { class: 'card' }, ...parts);
}
