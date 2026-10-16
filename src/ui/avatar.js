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
  const earL = s('g', { class: 'ear-l' },
    s('path', { d: 'M12 25L16.5 2 30 14z', fill: FUR, stroke: OUT, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }),
    s('path', { d: 'M16 19l2.5-10.5L26 15z', fill: INNER }),
    s('path', { class: 'twig', d: 'M21 15C16 11 11 8.5 4.5 8', fill: 'none', 'stroke-width': 2.4, 'stroke-linecap': 'round' }),
    s('path', { d: 'M13 10.5c-1.6-3.4-.4-6.4 2.8-7.6.9 3.2-.4 6-2.8 7.6z', fill: LEAF }),
    tails(8.5, 9, 8),
    s('rect', { x: 5.5, y: 5.6, width: 6, height: 4.6, rx: 1.4, fill: TAPE, transform: 'rotate(-20 8.5 7.9)' }));
  const earR = s('g', { class: 'ear-r' },
    s('path', { d: 'M52 25L47.5 2 34 14z', fill: FUR, stroke: OUT, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }),
    s('path', { d: 'M48 19l-2.5-10.5L38 15z', fill: INNER }));
  const eye = (/** @type {number} */ cx) => [s('ellipse', { class: 'eye', cx, cy: 28.5, rx: 2.7, ry: 3.4 }), s('circle', { cx: cx + 1, cy: 27.3, r: 1, fill: '#fff' })];
  const face = s('g', { class: 'face' },
    s('path', { d: 'M10.5 31c3 9 11 12 16 13 2.2.5 3.8 3 5.5 3s3.3-2.5 5.5-3c5-1 13-4 16-13-5 5-11 6-15 5.5-3-.4-4.5 1-6.5 1s-3.5-1.4-6.5-1C21.5 37 15.5 36 10.5 31z', fill: '#ffffff' }),
    s('ellipse', { cx: 18.5, cy: 35, rx: 3.2, ry: 1.9, fill: '#f6a4a4', opacity: 0.7 }),
    s('ellipse', { cx: 45.5, cy: 35, rx: 3.2, ry: 1.9, fill: '#f6a4a4', opacity: 0.7 }),
    s('g', { class: 'eyes' }, s('g', { class: 'lid' }, ...eye(24), ...eye(40))),
    s('path', { class: 'closed', d: 'M21 29q3 2.6 6 0M37 29q3 2.6 6 0', fill: 'none', 'stroke-width': 1.9, 'stroke-linecap': 'round' }),
    // The nose, redrawn as a small rounded triangle so it doesn't read as a mouth (spec §16.3 polish list).
    s('path', { class: 'nose', d: 'M30.2 40.4q1.8-.8 3.6 0-.7 1.5-1.8 2.1-1.1-.6-1.8-2.1z' }));
  const fox = s('g', { class: 'fox' },
    earL, earR,
    s('path', { d: 'M32 10c14 0 22 8 22 19 0 9-6 14-11 17-4 2.5-7 6-11 6s-7-3.5-11-6c-5-3-11-8-11-17 0-11 8-19 22-19z', fill: FUR, stroke: OUT, 'stroke-width': 1.2 }),
    s('path', { d: 'M19.5 47.5Q32 55 44.5 47.5l-.8 4.2Q32 59 20.3 51.7z', fill: SCARF }),
    s('circle', { cx: 32, cy: 55, r: 2.6, fill: SCARF }),
    s('path', { d: 'M31 56.5l-4 6.5 4.2-1zM33 56.5l4 6.5-4.2-1z', fill: SCARF }),
    face);
  const marker = s('g', { class: 'marker' },
    s('path', { class: 'twig', d: 'M33 64C31.5 52 33.5 40 32 22', fill: 'none', 'stroke-width': 3.6, 'stroke-linecap': 'round' }),
    s('path', { class: 'twig', d: 'M32.6 38C36 35 39 33.5 43 33', fill: 'none', 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
    s('path', { d: 'M43 33c2-3 5-3.8 7.5-2.8-1.4 2.8-4.2 3.8-7.5 2.8z', fill: LEAF }),
    tails(33, 28, 12),
    s('rect', { x: 28, y: 23.5, width: 9, height: 6, rx: 1.8, fill: TAPE, transform: 'rotate(-12 32.5 26.5)' }));
  return /** @type {SVGSVGElement} */ (s('svg', { class: 'avsvg', viewBox: '-10 -10 84 84', 'aria-hidden': 'true', focusable: 'false' }, fox, marker));
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
