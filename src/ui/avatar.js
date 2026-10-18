import { h } from './dom.js';

/**
 * Shiori, the character (spec §16.3): a white fox in a vermilion scarf, with her trail-tape
 * hairpin at her left ear. Her gaze carries the state. Movement comes from events and transitions;
 * the only loop is her breathing while asleep. A named component: setState, setLevel, glance,
 * blink. Built without innerHTML.
 * @typedef {'sleeping' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'waiting' | 'away' | 'offline'} AvatarState
 */

const NS = 'http://www.w3.org/2000/svg';
/** Her outlines, eyes and nose: dark brown, on any background, as in her icon. */
const INK = '#3b2a24';
const FUR = '#fffaf4';
const INNER = '#f8c4a8';
const TIP = '#f8c4a8';
const BLUSH = '#f7b39a';
const TAPE = '#f05a87';
const TAPE2 = '#e3487a';
const SCARF = '#d9473a';
const LEAF = '#7fb069';

/** @param {string} tag @param {Record<string, string | number>} [attrs] @param {...SVGElement} children */
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

/** The tape tails on her hairpin, which move with her voice. @param {number} x @param {number} y @param {number} len */
const tails = (x, y, len) => s('g', { class: 'tails' },
  s('path', { d: `M${x} ${y}c-1.5 3-1.3 5.5-3 ${len}`, fill: 'none', stroke: TAPE, 'stroke-width': 2.8, 'stroke-linecap': 'round' }),
  s('path', { d: `M${x + 1} ${y + 0.5}c1 3 .5 5.5 1.5 ${len + 0.5}`, fill: 'none', stroke: TAPE2, 'stroke-width': 2.8, 'stroke-linecap': 'round' }));

/** @returns {SVGSVGElement} */
export function foxSvg() {
  // Drawn after the user's app icon and state sheet (2026-10-18): dark outlines, tall ears, a ruff of fur at her
  // cheeks, big round eyes, a small rounded nose (never a mouth), a bow, and her hairpin at her left ear.
  // The drawing is the seat's circle: 64 across, centred on 32.25.
  const ink = { stroke: INK, 'stroke-width': 1.15, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
  const earL = s('g', { class: 'ear-l' },
    s('path', { d: 'M28 21.5C22 15.5 17.5 11.5 13.75 9.25 11.6 15.5 10.6 22.5 11.2 32L16 33 24 26z', fill: FUR }),
    s('path', { d: 'M23.5 20.6C20.5 17.2 17.6 14.6 15.2 13.2 13.9 17.6 13.4 22.5 13.6 27.6 15.5 25 18.5 22.5 23.5 20.6z', fill: INNER }),
    s('path', { d: 'M21.2 21.6l-1.4-2.6 2.9.4c-1.8.4-3.6 1.6-5.2 3.4l1.4-3.3z', fill: FUR }),
    s('path', { d: 'M26.5 20.9C22 15.5 17.5 11.5 13.75 9.25 11.6 15.5 10.6 22.5 11.2 31.9', fill: 'none', ...ink }));
  const earR = s('g', { class: 'ear-r' },
    s('path', { d: 'M36.5 21.5C42.5 15.5 47 11.5 50.75 9.25 52.9 15.5 53.9 22.5 53.3 32L48.5 33 40.5 26z', fill: FUR }),
    s('path', { d: 'M41 20.6C44 17.2 46.9 14.6 49.3 13.2 50.6 17.6 51.1 22.5 50.9 27.6 49 25 46 22.5 41 20.6z', fill: INNER }),
    s('path', { d: 'M43.3 21.6l1.4-2.6-2.9.4c1.8.4 3.6 1.6 5.2 3.4l-1.4-3.3z', fill: FUR }),
    s('path', { d: 'M38 20.9C42.5 15.5 47 11.5 50.75 9.25 52.9 15.5 53.9 22.5 53.3 31.9', fill: 'none', ...ink }),
    // Her hairpin: a forked twig with a pink bow, worn where her left ear meets her head.
    s('path', { class: 'twig', d: 'M44.6 23.2l3.6 11M44.6 23.2l-2.2-1.8M45.5 25.9l2-3.1', fill: 'none', 'stroke-width': 1.25, 'stroke-linecap': 'round' }),
    tails(47.4, 27.3, 6.5),
    s('path', { d: 'M47.4 26.6l-2.9-2.2.1 4.1zM47.4 26.6l3.1-1.9-.2 4.1z', fill: TAPE, stroke: '#8a1f45', 'stroke-width': 0.5, 'stroke-linejoin': 'round' }),
    s('circle', { cx: 47.4, cy: 26.6, r: 0.95, fill: TAPE2 }));
  const eye = (/** @type {number} */ cx) => [
    s('ellipse', { class: 'eye', cx, cy: 41.2, rx: 3.6, ry: 3.95 }),
    s('circle', { cx: cx + 1.35, cy: 39.6, r: 1.45, fill: '#fff' }),
    s('circle', { cx: cx - 1.25, cy: 43, r: 0.65, fill: '#fff' }),
  ];
  const face = s('g', { class: 'face' },
    s('ellipse', { cx: 16.8, cy: 45.9, rx: 2.9, ry: 1.8, fill: BLUSH, opacity: 0.85 }),
    s('ellipse', { cx: 47.7, cy: 45.9, rx: 2.9, ry: 1.8, fill: BLUSH, opacity: 0.85 }),
    s('g', { class: 'eyes' }, s('g', { class: 'lid' }, ...eye(22.3), ...eye(42.2))),
    // Closed, her eyes are thick crescents, as in her icon.
    s('path', { class: 'closed', d: 'M17.6 40.2Q22.3 45.8 27 40.6M37.5 40.6Q42.2 45.8 46.9 40.2', fill: 'none', 'stroke-width': 2.3, 'stroke-linecap': 'round' }),
    s('path', { class: 'nose', d: 'M30.4 45.6Q32.25 44.9 34.1 45.6 33.6 47.4 32.25 48 30.9 47.4 30.4 45.6z' }));
  // Asleep, she curls up with her tail across her front (the user, 2026-10-18).
  const tail = s('g', { class: 'tail' },
    s('path', { d: 'M18 66C21 57.5 31 52.6 42 53.4 50 54 56 57.8 58 63.5V66z', fill: FUR }),
    s('path', { d: 'M47.5 54.4l1.1 3.1 2.8-1.5.4 3.4 3.2-.9-.4 3.1 3.4 1.9V66H44z', fill: TIP }),
    s('path', { d: 'M18 66C21 57.5 31 52.6 42 53.4 50 54 56 57.8 58 63.5', fill: 'none', ...ink }));
  const fox = s('g', { class: 'fox' },
    // Her chest, under her head and the bow.
    s('path', { d: 'M17.5 50C17 56 16 61 15 67h34.5c-1-6-2-11-2.5-17z', fill: FUR, ...ink }),
    // Her head, with a ruff of fur at each cheek and tufts at her chin.
    s('path', {
      d: 'M25 21.5C28.5 19.6 36 19.6 39.5 21.5 44 23 48.5 26 53.3 31.9l2.2 1.7-3.4 1.9 6.3 5.1-6.8.7 5 4.3-7.6.7 3.8 3.7-7.5-.6-1.9 3.1-3.1-1.5-3.1 2.3-2.9-1.7-2.05 2-2.05-2-2.9 1.7-3.1-2.3-3.1 1.5-1.9-3.1-7.5.6 3.8-3.7-7.6-.7 5-4.3-6.8-.7 6.3-5.1-3.4-1.9 2.2-1.7C14 27 19.5 23.3 25 21.5z',
      fill: FUR, ...ink,
    }),
    earL, earR,
    // Her scarf, tied in a bow under her chin.
    s('path', { d: 'M30.5 54.5C26 51.8 21.5 51.3 19.2 52.6 18 55.5 19.6 58.8 21.6 59.6 24.5 58.6 27.8 57.2 30.5 56.4zM34 54.5C38.5 51.8 43 51.3 45.3 52.6 46.5 55.5 44.9 58.8 42.9 59.6 40 58.6 36.7 57.2 34 56.4z', fill: SCARF, ...ink, 'stroke-width': 0.9 }),
    s('path', { d: 'M30.6 57.2l-3 7.3 4-1.3.65-4.7zM33.9 57.2l3 7.3-4-1.3-.65-4.7z', fill: SCARF, ...ink, 'stroke-width': 0.9 }),
    s('circle', { cx: 32.25, cy: 55.6, r: 2.8, fill: SCARF, ...ink, 'stroke-width': 0.9 }),
    face, tail);
  /** A paw print, as she leaves. @param {number} x @param {number} y @param {number} turn degrees */
  const paw = (x, y, turn) => s('g', { transform: `rotate(${turn} ${x} ${y})`, fill: INK, opacity: 0.6 },
    s('ellipse', { cx: x, cy: y, rx: 1.5, ry: 1.2 }),
    s('circle', { cx: x - 1.5, cy: y - 1.7, r: 0.55 }), s('circle', { cx: x, cy: y - 2.3, r: 0.55 }), s('circle', { cx: x + 1.5, cy: y - 1.7, r: 0.55 }));
  // Working: she has stepped out, leaving her trail marker, her paw prints, and the tip of her tail going.
  const marker = s('g', { class: 'marker' },
    s('path', { d: 'M22.5 62l1-4 1 4M25.5 62.5l1.5-5 .6 5M33 62l1-3.5 1 3.5', fill: 'none', stroke: LEAF, 'stroke-width': 0.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    s('path', { class: 'twig', d: 'M28.5 63L33 34M31.6 43l4.4-3.4M33 34l-2-2.4', fill: 'none', 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
    tails(33.6, 38, 10),
    s('path', { d: 'M33.4 37.4l-3.6-2.6.2 4.6zM33.4 37.4l3.8-2.2-.2 4.6z', fill: TAPE, stroke: '#8a1f45', 'stroke-width': 0.5, 'stroke-linejoin': 'round' }),
    s('circle', { cx: 33.4, cy: 37.4, r: 1.1, fill: TAPE2 }),
    paw(40, 58, 75), paw(45.5, 54.5, 65), paw(50, 59, 80),
    s('path', { d: 'M66 50C60 49.5 54.5 51.5 52.5 55 55.5 57.5 61 58 66 57z', fill: FUR }),
    s('path', { d: 'M52.5 55c.8-1.6 2-2.7 3.5-3.4l.3 2.2 1.9-1.3-.2 3 2-.3-1.4 2.4c-2.3-.2-4.4-1.1-6.1-2.6z', fill: TIP }),
    s('path', { d: 'M66 50C60 49.5 54.5 51.5 52.5 55 55.5 57.5 61 58 66 57', fill: 'none', ...ink }));
  return /** @type {SVGSVGElement} */ (s('svg', { class: 'avsvg', viewBox: '-3.5 -2.5 71.5 71.5', 'aria-hidden': 'true', focusable: 'false' }, fox, marker));
}

/** The wait before the next blink. @param {number} random 0..1 */
export function nextBlinkMs(random) {
  return Math.round(2600 + random * 5200);
}

const reduced = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** @param {{ size?: 'sm' | 'md' | 'dock' | 'big', label?: string }} [o] */
export function createAvatar({ size = 'md', label } = {}) {
  const av = h('span', { class: 'av', dataset: { state: 'sleeping' } });
  av.append(foxSvg());
  const el = h('span', { class: ['seat', size], dataset: { glow: 'her' }, ...(label ? { role: 'img', 'aria-label': label } : {}) }, av);
  const eyesOpen = () => !['sleeping', 'away', 'offline'].includes(av.dataset.state ?? '');
  let started = false;
  const blink = () => {
    if (reduced() || !eyesOpen()) return;
    av.classList.add('blink');
    setTimeout(() => av.classList.remove('blink'), 130);
  };
  const schedule = () => setTimeout(() => {
    if (started && !el.isConnected) return; // removed from the page: stop
    if (el.isConnected) {
      started = true;
      blink();
    }
    schedule();
  }, nextBlinkMs(Math.random()));
  if (!reduced()) schedule();
  const api = {
    el,
    get state() { return av.dataset.state ?? 'sleeping'; },
    /** @param {import('./avatar.js').AvatarState | string} state */
    setState(state) {
      av.dataset.state = state;
      if (state !== 'speaking' && state !== 'hearing') api.setLevel(0);
    },
    /** The seat's glow follows the sound: her voice, or yours in grey (spec §16.3). @param {number} level 0..1 @param {'her' | 'you'} [who] */
    setLevel(level, who = 'her') {
      const v = String(Math.max(0, Math.min(1, Number(level) || 0)));
      el.dataset.glow = who;
      el.style.setProperty('--amp', v);
      av.style.setProperty('--amp', v);
    },
    /** A look toward something, such as a new card. @param {number} dx @param {number} dy */
    glance(dx, dy) {
      if (reduced()) return;
      const eyes = /** @type {SVGGElement | null} */ (av.querySelector('.eyes'));
      if (!eyes) return;
      eyes.style.transform = `translate(${dx}px, ${dy}px)`;
      setTimeout(() => { eyes.style.transform = ''; }, 1100);
    },
    blink,
  };
  return api;
}
