import { h } from './dom.js';

/**
 * Shiori, the character (spec §16.3): a white fox in a vermilion scarf, with her trail-tape
 * hairpin at her left ear. Her gaze carries the state. Movement comes from events and transitions;
 * the only loop is her breathing while asleep. A named component: setState, setLevel, glance,
 * blink. Built without innerHTML.
 * @typedef {'sleeping' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'waiting' | 'away' | 'offline'} AvatarState
 */

const NS = 'http://www.w3.org/2000/svg';
const OUT = '#e0cdb9';
const FUR = '#fbf5ee';
const INNER = '#f4a7a0';
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
  // Drawn after the user's reference sheet (2026-10-18): tall fox ears, a ruff of fur at her cheeks, round
  // eyes, a small nose high on the face (never a mouth), and her hairpin tucked behind her left ear.
  const earL = s('g', { class: 'ear-l' },
    s('path', { d: 'M29 15C24 9 19 3 13.5-3.5 10.5 4 9.5 14 11 25z', fill: FUR, stroke: OUT, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }),
    s('path', { d: 'M25.5 15.5C22 11 18.5 6.5 14.5 2 13 8 12.5 14 13.5 21z', fill: INNER }));
  const earR = s('g', { class: 'ear-r' },
    // The twig runs behind the ear; its tape is tied where it comes out, on the ear's outer side.
    s('path', { class: 'twig', d: 'M38.5 17.5C45 12 51 7 58.5 3', fill: 'none', 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
    s('path', { d: 'M57.5 3.4c1.2-2.8 3.6-3.8 6-3.2-1 2.6-3.3 3.8-6 3.2z', fill: LEAF }),
    s('path', { d: 'M35 15C40 9 45 3 50.5-3.5 53.5 4 54.5 14 53 25z', fill: FUR, stroke: OUT, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }),
    s('path', { d: 'M38.5 15.5C42 11 45.5 6.5 49.5 2 51 8 51.5 14 50.5 21z', fill: INNER }),
    tails(55.5, 8, 7),
    s('path', { d: 'M55.6 7.2l-3.6-2.9.3 5.2zM55.6 7.2l3.8-2.5-.3 5.2z', fill: TAPE }),
    s('circle', { cx: 55.6, cy: 7.2, r: 1.2, fill: TAPE2 }));
  // Big round eyes with two highlights, after the reference sheet.
  const eye = (/** @type {number} */ cx) => [
    s('ellipse', { class: 'eye', cx, cy: 29, rx: 3.6, ry: 4.2 }),
    s('circle', { cx: cx + 1.3, cy: 27.4, r: 1.35, fill: '#fff' }),
    s('circle', { cx: cx - 1.2, cy: 30.9, r: 0.6, fill: '#fff' }),
  ];
  const face = s('g', { class: 'face' },
    s('ellipse', { cx: 18.8, cy: 34.6, rx: 3.3, ry: 2, fill: '#f6aa9c', opacity: 0.75 }),
    s('ellipse', { cx: 45.2, cy: 34.6, rx: 3.3, ry: 2, fill: '#f6aa9c', opacity: 0.75 }),
    s('g', { class: 'eyes' }, s('g', { class: 'lid' }, ...eye(24), ...eye(40))),
    s('path', { class: 'closed', d: 'M20 29.5q4 3 8 0M36 29.5q4 3 8 0', fill: 'none', 'stroke-width': 1.9, 'stroke-linecap': 'round' }),
    // A small nose just under the eyes, where it reads as a nose and not a mouth (spec §16.3 polish list).
    s('path', { class: 'nose', d: 'M30.4 35.4q1.6-.7 3.2 0-.6 1.4-1.6 2-1-.6-1.6-2z' }));
  const fox = s('g', { class: 'fox' },
    // Her chest, under her head and the bow.
    s('path', { d: 'M20.5 46C22 56 26 63 32 63s10-7 11.5-17z', fill: FUR, stroke: OUT, 'stroke-width': 1.2 }),
    earL, earR,
    // Her head, with a ruff of fur at each cheek.
    s('path', {
      d: 'M32 9C42 9 50 14 52 23l4.5 4-4 1.5 3.5 4.5-5 .5 2 5h-5.5C44 44 38 47.5 32 48s-12-4-15.5-9.5H11l2-5-5-.5 3.5-4.5-4-1.5 4.5-4C14 14 22 9 32 9z',
      fill: FUR, stroke: OUT, 'stroke-width': 1.2, 'stroke-linejoin': 'round',
    }),
    // Her scarf, tied in a bow under her chin.
    s('path', { d: 'M29.5 50.3C24 46 19.3 46.2 18.4 48.9c-.6 3 4.6 5.6 11.1 2.6zM34.5 50.3C40 46 44.7 46.2 45.6 48.9c.6 3-4.6 5.6-11.1 2.6z', fill: SCARF, stroke: '#b8372c', 'stroke-width': 0.6, 'stroke-linejoin': 'round' }),
    s('path', { d: 'M30.6 52.6l-3.8 7.8 4.6-1.9zM33.4 52.6l3.8 7.8-4.6-1.9z', fill: SCARF, stroke: '#b8372c', 'stroke-width': 0.6, 'stroke-linejoin': 'round' }),
    s('circle', { cx: 32, cy: 50.8, r: 3.1, fill: SCARF, stroke: '#b8372c', 'stroke-width': 0.6 }),
    face);
  /** A paw print, as she leaves. @param {number} x @param {number} y @param {number} turn degrees */
  const paw = (x, y, turn) => s('g', { transform: `rotate(${turn} ${x} ${y})`, fill: 'var(--twig)', opacity: 0.7 },
    s('ellipse', { cx: x, cy: y, rx: 1.6, ry: 1.3 }),
    s('circle', { cx: x - 1.6, cy: y - 1.8, r: 0.6 }), s('circle', { cx: x, cy: y - 2.4, r: 0.6 }), s('circle', { cx: x + 1.6, cy: y - 1.8, r: 0.6 }));
  const marker = s('g', { class: 'marker' },
    paw(42, 58, 70), paw(49, 54, 60), paw(55, 59, 75), paw(61, 54, 65),
    s('path', { class: 'twig', d: 'M33 64C31.5 52 33.5 40 32 22', fill: 'none', 'stroke-width': 3.6, 'stroke-linecap': 'round' }),
    s('path', { class: 'twig', d: 'M32.6 38C36 35 39 33.5 43 33', fill: 'none', 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
    s('path', { d: 'M43 33c2-3 5-3.8 7.5-2.8-1.4 2.8-4.2 3.8-7.5 2.8z', fill: LEAF }),
    tails(33, 28, 12),
    s('rect', { x: 28, y: 23.5, width: 9, height: 6, rx: 1.8, fill: TAPE, transform: 'rotate(-12 32.5 26.5)' }));
  return /** @type {SVGSVGElement} */ (s('svg', { class: 'avsvg', viewBox: '-3 -6 70 70', 'aria-hidden': 'true', focusable: 'false' }, fox, marker));
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
