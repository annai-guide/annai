import { h } from './dom.js';

/**
 * Shiori, the character (spec §16.3): a white fox in a vermilion scarf, with her trail-tape hairpin at her left ear.
 * Her art is the user's art kit, traced by scripts/shiori-art/ into ART: parts that move on their own, like a puppet's.
 * States move the parts with transforms and transitions (shiori.css); her eyes are drawn here, as shapes that change
 * smoothly, never swapped pictures. The only loop is her breathing while asleep. A named component: setState,
 * setLevel, glance, blink. Built without innerHTML.
 * @typedef {'sleeping' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'waiting' | 'away' | 'offline'} AvatarState
 */

const NS = 'http://www.w3.org/2000/svg';
/** Her parts, one file the service worker keeps for offline use. */
export const ART = '/assets/shiori.svg';

/** @param {string} tag @param {Record<string, string | number>} [attrs] @param {...SVGElement} children */
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}
/** One part of her art. @param {string} id */
const part = (id) => s('use', { href: `${ART}#${id}` });

// Her eyes, in the art's units (3 pixels of the kit's master): her right eye, on your left; her left eye mirrors it.
// The open eye and its lash are the master's; the other shapes are made from them, as the kit's README describes.
const OPEN = [396, 563, 394, 552, 390, 542, 385, 531, 378, 520, 367, 510, 353, 502, 335, 501, 324, 513, 316, 527, 311, 539, 308, 551,
  306, 563, 307, 576, 310, 588, 316, 600, 326, 609, 339, 615, 353, 617, 367, 615, 380, 611, 391, 601, 396, 588, 397, 575];
const LASH = [339, 501, 322, 504, 304, 514, 289, 527, 280, 540, 274, 554, 280, 577, 287, 560, 296, 543, 307, 529, 319, 519, 327, 514, 333, 510];
const MIRROR = 957.7; // her left eye is at MIRROR - x
const CX = 352; // the middle of her right eye
const HALF = 45.5; // half its width

/** @typedef {{ iris: number[], lash: number[], light: number[], look: number[] }} Eye outlines [x, y, ...]; light [x, y, r]; look moves both */
/** @param {number[]} pts @param {(x: number, y: number, i: number) => number[]} f */
const each = (pts, f) => pts.flatMap((v, i) => (i % 2 ? [] : f(v, pts[i + 1], i / 2)));
/** Across the eye, -1 to 1. @param {number} x */
const across = (x) => Math.max(-1, Math.min(1, (x - CX) / HALF));
/** A thick crescent bowed downward (‿), as in her icon. Points 0 to 11 of the open eye (its right end and top) go
 * along the crescent's top from its inner end, 12 to 23 along its bottom. @returns {Eye} */
function crescent() {
  const q = (/** @type {number} */ t, /** @type {number[]} */ [a, b, c]) => (1 - t) ** 2 * a + 2 * t * (1 - t) * b + t * t * c;
  const at = (/** @type {number} */ t) => [q(t, [265, 328, 398]), q(t, [555, 620, 569])]; // outer end to inner end
  const iris = [];
  for (let i = 0; i < 24; i++) {
    const t = i < 12 ? 1 - i / 12 : (i - 12) / 12;
    const [x, y] = at(t);
    const [x2, y2] = at(t + 0.001);
    const n = Math.hypot(x2 - x, y2 - y);
    const w = i % 12 ? (10 + 5 * Math.sin(Math.PI * t)) * (i < 12 ? -1 : 1) : 0; // half its thickness, above or below
    const end = i === 0 ? 10 : i === 12 ? -10 : 0; // its round ends
    iris.push(x + ((x2 - x) * end - (y2 - y) * w) / n, y + ((y2 - y) * end + (x2 - x) * w) / n);
  }
  const [lx, ly] = at(0.16);
  const [mx, my] = at(0.5);
  return { iris, lash: each(LASH, (x, y) => [lx + (x - 300) / 25, ly + (y - 540) / 25]), light: [mx, my, 0], look: [0, 0] };
}

const LIGHT = [361, 541, 14.5];
/** @type {Record<string, Eye>} */
const SHAPES = {
  open: { iris: OPEN, lash: LASH, light: LIGHT, look: [0, 0] },
  // Hearing you: about 110% eye and 120% highlight.
  wide: { iris: each(OPEN, (x, y) => [CX + (x - CX) * 1.1, 560 + (y - 560) * 1.1]), lash: each(LASH, (x, y) => [CX + (x - CX) * 1.1, 560 + (y - 560) * 1.1]), light: [362, 539, 17.4], look: [0, 0] },
  closed: crescent(),
  // A lid over the top half, its edge curving with the eye (a flat one reads as annoyed).
  drowsy: { iris: each(OPEN, (x, y, i) => (i <= 12 ? [x, 578 - 23 * Math.sqrt(1 - across(x) ** 2)] : [x, y])), lash: each(LASH, (x, y) => [x, y + 52]), light: [362, 589, 9], look: [0, 0] },
  // Narrowed from below, looking up and to one side.
  thinking: { iris: each(OPEN, (x, y, i) => [x, i > 12 ? Math.min(y, 592 - 10 * across(x) ** 2) : y]), lash: LASH, light: LIGHT, look: [-9, -8] },
  // The lower edge lifted by an upward curve.
  smiling: { iris: each(OPEN, (x, y, i) => [x, i > 12 ? Math.min(y, 600 - 20 * (1 - across(x) ** 2)) : y]), lash: LASH, light: [361, 543, 14.5], look: [0, 0] },
};
SHAPES.offline = { ...SHAPES.drowsy, light: [362, 589, 0] };
/** The eyes each state shows. @type {Record<string, string>} */
const EYES = { sleeping: 'closed', hearing: 'wide', thinking: 'thinking', speaking: 'smiling', offline: 'offline' };

/** @param {Eye} a @param {Eye} b @param {number} k 0..1 @returns {Eye} */
const mix = (a, b, k) => /** @type {Eye} */ (Object.fromEntries(Object.entries(a).map(([n, v]) => [n, v.map((x, i) => x + (b[/** @type {keyof Eye} */ (n)][i] - x) * k)])));
const f = (/** @type {number} */ v) => Math.round(v * 10) / 10;
/** A closed outline through the points (Catmull-Rom, as Bézier curves): soft, never jagged. @param {number[]} p */
function outline(p) {
  const n = p.length / 2;
  const pt = (/** @type {number} */ i) => [p[((i + n) % n) * 2], p[((i + n) % n) * 2 + 1]];
  let d = `M${f(p[0])} ${f(p[1])}`;
  for (let i = 0; i < n; i++) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = [pt(i - 1), pt(i), pt(i + 1), pt(i + 2)];
    d += `C${f(x1 + (x2 - x0) / 6)} ${f(y1 + (y2 - y0) / 6)} ${f(x2 - (x3 - x1) / 6)} ${f(y2 - (y3 - y1) / 6)} ${f(x2)} ${f(y2)}`;
  }
  return `${d}Z`;
}

/** Her two eyes: an iris with its lash, and a highlight, each. */
function eyes() {
  const both = [0, 1].map(() => [s('path', { class: 'iris' }), s('circle', { class: 'light' })]);
  const el = s('g', { class: 'eyes' }, ...both.map((e) => s('g', { class: 'eye' }, ...e)));
  /** @param {Eye} e */
  const draw = (e) => both.forEach(([iris, light], side) => {
    const place = (/** @type {number} */ x) => (side ? MIRROR - x : x) + e.look[0];
    const at = (/** @type {number[]} */ pts) => outline(each(pts, (x, y) => [place(x), y + e.look[1]]));
    iris.setAttribute('d', at(e.iris) + at(e.lash));
    light.setAttribute('cx', String(f(place(e.light[0]))));
    light.setAttribute('cy', String(f(e.light[1] + e.look[1])));
    light.setAttribute('r', String(f(e.light[2])));
  });
  return { el, draw };
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

/** What a glance of 1 moves her eyes, in the art's units. */
const GLANCE = 14;

/** @param {{ size?: 'sm' | 'md' | 'dock' | 'big', label?: string }} [o] */
export function createAvatar({ size = 'md', label } = {}) {
  const look = eyes();
  // Back to front, as the kit's README lays them: what she leaves while working; her body; her curled tail; her ears
  // under her head; her eyes; the hairpin, which leans with her left ear, its tape tail swinging under the knot.
  const svg = s('svg', { class: 'avsvg', viewBox: '-27 -34 1014 1014', 'aria-hidden': 'true', focusable: 'false' },
    s('g', { class: 'away' }, part('marker'), part('paws'), part('tail-tip')),
    s('g', { class: 'fox' },
      part('body'),
      s('g', { class: 'curl' }, part('tail-sleep')),
      s('g', { class: 'head' },
        s('g', { class: 'ear ear-r' }, part('ear-right')),
        s('g', { class: 'ear ear-l' }, part('ear-left')),
        part('head'),
        look.el,
        s('g', { class: 'pin' }, part('pin'), s('g', { class: 'tape' }, part('tape')), part('knot')))));
  const av = h('span', { class: 'av', dataset: { state: 'sleeping' } }, svg);
  const el = h('span', { class: ['seat', size], dataset: { glow: 'her' }, ...(label ? { role: 'img', 'aria-label': label } : {}) }, av);

  let shown = SHAPES.closed;
  let frame = 0;
  /** Moves her eyes to a shape over ms. @param {Eye} to @param {number} ms @param {() => void} [then] */
  const eyesTo = (to, ms, then) => {
    cancelAnimationFrame(frame);
    if (ms <= 0 || reduced()) {
      look.draw(shown = to);
      then?.();
      return;
    }
    const from = shown;
    const start = performance.now();
    const step = (/** @type {number} */ now) => {
      const k = Math.min(1, (now - start) / ms);
      look.draw(shown = mix(from, to, k < 0.5 ? 2 * k * k : 1 - (2 - 2 * k) ** 2 / 2));
      if (k < 1) frame = requestAnimationFrame(step);
      else then?.();
    };
    frame = requestAnimationFrame(step);
  };
  look.draw(shown);
  const stateEyes = () => SHAPES[EYES[av.dataset.state ?? ''] ?? 'open'];

  const eyesOpen = () => !['sleeping', 'away', 'offline'].includes(av.dataset.state ?? '');
  let started = false;
  const blink = () => {
    if (reduced() || !eyesOpen()) return;
    // The eye squashes toward its lower third, ending on the closed shape, and opens again.
    eyesTo(SHAPES.closed, 75, () => setTimeout(() => eyesOpen() && eyesTo(stateEyes(), 120), 40));
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
      const was = av.dataset.state;
      av.dataset.state = state;
      // Falling asleep or waking, her eyes pass through the drowsy shape, whose lid curves with the eye.
      if (state !== was) {
        if ((was === 'sleeping' || state === 'sleeping') && was !== 'offline') eyesTo(SHAPES.drowsy, 260, () => eyesTo(stateEyes(), 360));
        else eyesTo(stateEyes(), 320);
      }
      if (state !== 'speaking' && state !== 'hearing') api.setLevel(0);
    },
    /** The seat's glow follows the sound: her voice, or yours in grey (spec §16.3). @param {number} level 0..1 @param {'her' | 'you'} [who] */
    setLevel(level, who = 'her') {
      const v = String(Math.max(0, Math.min(1, Number(level) || 0)));
      el.dataset.glow = who;
      el.style.setProperty('--amp', v);
      av.style.setProperty('--amp', v);
    },
    /** A look toward something, such as a new card: her eyes and their highlights move together. @param {number} dx @param {number} dy */
    glance(dx, dy) {
      if (reduced()) return;
      const clamp = (/** @type {number} */ v) => Math.max(-3, Math.min(3, Number(v) || 0)) * GLANCE;
      look.el.style.transform = `translate(${clamp(dx)}px, ${clamp(dy)}px)`;
      setTimeout(() => { look.el.style.transform = ''; }, 1100);
    },
    blink,
  };
  return api;
}
