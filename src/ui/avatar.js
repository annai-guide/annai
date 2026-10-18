import { h } from './dom.js';

/**
 * Shiori, the character (spec §16.3): a white fox in a vermilion scarf, with her trail-tape hairpin at her left ear.
 * Her art is the user's art kit, traced by scripts/shiori-art/ into ART: parts that move on their own, like a puppet's,
 * and other drawings of some (ears folded or angled out, her head turned or asleep) that take their place. States move
 * the parts with transforms and transitions (shiori.css); her eyes and her streamer are drawn here, as shapes that
 * change smoothly, never swapped pictures. Her only loops: breathing while asleep, and her tail's tip and the
 * streamer on her marker while she works. A named component: setState, setLevel, glance, blink. Built without innerHTML.
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
/** A part in a group of its own, to move. @param {string} cls @param {...string} ids */
const group = (cls, ...ids) => s('g', { class: cls }, ...ids.map(part));

// Her eyes, in the art's units (3 pixels of the kit's front master), measured by scripts/shiori-art/eyes.mjs: an oval
// (24 points round it), a lash, and a highlight [x, y, rx, ry]. Front: her right eye, on your left; her left mirrors it.
const OPEN = [396, 563, 394, 552, 390, 542, 385, 531, 378, 520, 367, 510, 353, 502, 335, 501, 324, 513, 316, 527, 311, 539, 308, 551,
  306, 563, 307, 576, 310, 588, 316, 600, 326, 609, 339, 615, 353, 617, 367, 615, 380, 611, 391, 601, 396, 588, 397, 575];
const LASH = [339, 501, 322, 504, 304, 514, 289, 527, 280, 540, 274, 554, 280, 577, 287, 560, 296, 543, 307, 529, 319, 519, 327, 514, 333, 510];
const MIRROR = 957.7; // her left eye is at MIRROR - x
const CX = 352; // the middle of her right eye
const HALF = 45.5; // half its width
// Turned three-quarters (Thinking): the far eye, then the near one, glancing up and to the side.
const FAR = {
  iris: [288, 498, 289, 491, 290, 482, 290, 471, 287, 457, 279, 440, 263, 447, 252, 456, 243, 463, 242, 477, 239, 484, 237, 491, 234, 498,
    232, 506, 231, 516, 233, 529, 240, 539, 251, 542, 263, 539, 272, 532, 278, 523, 282, 516, 284, 510, 286, 504],
  lash: [280, 440, 290, 441, 296, 445, 300, 449, 306, 460, 309, 471, 310, 484, 309, 496, 305, 507, 304, 491, 300, 473, 294, 460, 287, 454, 281, 441],
  light: [260.4, 472.7, 9.3, 13.5],
};
const NEAR = {
  iris: [527, 542, 528, 528, 525, 513, 517, 499, 509, 481, 491, 480, 474, 484, 460, 490, 449, 498, 440, 508, 433, 518, 427, 529, 422, 542,
    419, 557, 421, 572, 432, 584, 445, 592, 460, 596, 474, 596, 488, 594, 501, 588, 511, 579, 519, 568, 525, 555],
  lash: [511, 481, 528, 486, 548, 498, 564, 514, 577, 534, 584, 550, 563, 575, 564, 553, 561, 540, 555, 528, 540, 509, 526, 499, 517, 496, 512, 482],
  light: [466.5, 517.1, 15.7, 15.6],
};

/** @typedef {{ iris: number[], lash: number[], light: number[] }} Eye outlines [x, y, ...]; light [x, y, rx, ry] */
/** @typedef {{ eyes: Eye[], look: number[] }} Gaze both eyes, and how far they look aside */
/** @param {number[]} pts @param {(x: number, y: number, i: number) => number[]} f */
const each = (pts, f) => pts.flatMap((v, i) => (i % 2 ? [] : f(v, pts[i + 1], i / 2)));
/** Across her right eye, -1 (outer corner) to 1 (inner). @param {number} x */
const across = (x) => Math.max(-1, Math.min(1, (x - CX) / HALF));
/** A front gaze: her right eye, and her left mirroring it. @param {Eye} e */
const front = (e) => ({ eyes: [e, { iris: each(e.iris, (x, y) => [MIRROR - x, y]), lash: each(e.lash, (x, y) => [MIRROR - x, y]), light: [MIRROR - e.light[0], ...e.light.slice(1)] }], look: [0, 0] });
/** Points 1 to 11 of an oval are its top half, 13 to 23 its bottom half. @param {number} i */
const top = (i) => i <= 12;

/** A thick crescent bowed downward (‿), as in her icon: along a curve from its outer end (a) round (b) to its inner end
 * (c), thickest in the middle. Points 0 to 11 of the open eye (its inner end and top) go along the crescent's top
 * from its inner end, 12 to 23 along its bottom. @param {number[][]} abc @param {number} half its half-thickness at the ends
 * @returns {Eye} */
function crescent([a, b, c], half) {
  const at = (/** @type {number} */ t) => [0, 1].map((k) => (1 - t) ** 2 * a[k] + 2 * t * (1 - t) * b[k] + t * t * c[k]);
  const iris = [];
  for (let i = 0; i < 24; i++) {
    const t = i < 12 ? 1 - i / 12 : (i - 12) / 12;
    const [x, y] = at(t);
    const [x2, y2] = at(t + 0.001);
    const n = Math.hypot(x2 - x, y2 - y);
    const w = i % 12 ? half * (1 + Math.sin(Math.PI * t) / 2) * (i < 12 ? -1 : 1) * Math.sign(c[0] - a[0]) : 0; // above or below
    const end = i === 0 ? half : i === 12 ? -half : 0; // its round ends
    iris.push(x + ((x2 - x) * end - (y2 - y) * w) / n, y + ((y2 - y) * end + (x2 - x) * w) / n);
  }
  const [lx, ly] = at(0.16);
  const [mx, my] = at(0.5);
  return { iris, lash: each(LASH, (x, y) => [lx + (x - 300) / 25, ly + (y - 540) / 25]), light: [mx, my, 0, 0] };
}

/** Half-lidded and sad (Offline): the lid slopes down toward the outer corner, never flat, and ends past it in a
 * short round stroke. */
function sad() {
  const lid = (/** @type {number} */ x) => 556 - 11 * across(x) - 2 * (1 - across(x) ** 2);
  const lash = [];
  for (let a = 0; a < 13; a++) { // as many points as LASH, so one shape can turn into the other
    const t = (a / 13) * 2 * Math.PI;
    const x = 305 + 17 * Math.cos(t);
    lash.push(x, lid(x) + 5 * Math.sin(t) + 1);
  }
  return { iris: each(OPEN, (x, y, i) => (top(i) ? [x, lid(x)] : [x, y])), lash, light: [362, 585, 0, 0] };
}

/** A blink's end for the turned eyes: each oval squashed toward its lower third, bowed down. @param {Eye} e @returns {Eye} */
function squashed(e) {
  const ys = e.iris.filter((_, i) => i % 2);
  const xs = e.iris.filter((_, i) => !(i % 2));
  const [y0, y1, x0, x1] = [Math.min(...ys), Math.max(...ys), Math.min(...xs), Math.max(...xs)];
  const low = y0 + (y1 - y0) * 0.66;
  const to = (/** @type {number} */ x, /** @type {number} */ y) => [x, low + (y - low) * 0.15 + (y1 - y0) * 0.12 * (1 - ((2 * x - x0 - x1) / (x1 - x0)) ** 2)];
  return { iris: each(e.iris, to), lash: each(e.lash, to), light: [e.light[0], low, 0, 0] };
}

const LIGHT = [361, 541, 14.5, 14.5];
/** The front gazes, by name. @type {Record<string, Gaze>} */
const FRONT = {
  open: front({ iris: OPEN, lash: LASH, light: LIGHT }),
  // Hearing you: about 110% eye and 120% highlight.
  wide: front({ iris: each(OPEN, (x, y) => [CX + (x - CX) * 1.1, 560 + (y - 560) * 1.1]), lash: each(LASH, (x, y) => [CX + (x - CX) * 1.1, 560 + (y - 560) * 1.1]), light: [362, 539, 17.4, 17.4] }),
  closed: front(crescent([[265, 555], [328, 620], [398, 569]], 10)),
  // Asleep, on her asleep head (measured by scripts/shiori-art/measure.mjs, before her head dips).
  asleep: { eyes: [crescent([[287.7, 561.7], [350.8, 614.3], [413.3, 577.2]], 7.4), crescent([[682.7, 562.7], [616, 613.8], [549.3, 577.2]], 7.4)], look: [0, 0] },
  // Falling asleep or waking: a lid over the top half, its edge curving with the eye (a flat one reads as annoyed).
  drowsy: front({ iris: each(OPEN, (x, y, i) => (top(i) ? [x, 578 - 23 * Math.sqrt(1 - across(x) ** 2)] : [x, y])), lash: each(LASH, (x, y) => [x, y + 52]), light: [362, 589, 9, 9] }),
  sad: front(sad()),
};
/** The turned gazes. @type {Record<string, Gaze>} */
const TURNED = { open: { eyes: [FAR, NEAR], look: [0, 0] }, closed: { eyes: [squashed(FAR), squashed(NEAR)], look: [0, 0] } };
/** The front eyes each state shows. @type {Record<string, string>} */
const EYES = { sleeping: 'asleep', hearing: 'wide', offline: 'sad' };

/** @template T @param {T} a @param {T} b @param {number} k 0..1 @returns {T} */
const mix = (a, b, k) => /** @type {any} */ (typeof a === 'number' ? a + (/** @type {number} */ (b) - a) * k
  : Array.isArray(a) ? a.map((v, i) => mix(v, /** @type {any} */ (b)[i], k)) : Object.fromEntries(Object.entries(/** @type {any} */ (a)).map(([n, v]) => [n, mix(v, /** @type {any} */ (b)[n], k)])));
const f = (/** @type {number} */ v) => Math.round(v * 10) / 10;
/** A closed outline through the points (Catmull-Rom, as Bézier curves): soft, never jagged. Always drawn the same way
 * round, so outlines that overlap in one path add up rather than cancel. @param {number[]} p */
function outline(p) {
  const n = p.length / 2;
  let area = 0;
  for (let i = 0; i < n; i++) area += p[i * 2] * p[((i + 1) % n) * 2 + 1] - p[((i + 1) % n) * 2] * p[i * 2 + 1];
  if (area < 0) p = each(p, (x, y, i) => [p[(n - 1 - i) * 2], p[(n - 1 - i) * 2 + 1]]);
  const pt = (/** @type {number} */ i) => [p[((i + n) % n) * 2], p[((i + n) % n) * 2 + 1]];
  let d = `M${f(p[0])} ${f(p[1])}`;
  for (let i = 0; i < n; i++) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = [pt(i - 1), pt(i), pt(i + 1), pt(i + 2)];
    d += `C${f(x1 + (x2 - x0) / 6)} ${f(y1 + (y2 - y0) / 6)} ${f(x2 - (x3 - x1) / 6)} ${f(y2 - (y3 - y1) / 6)} ${f(x2)} ${f(y2)}`;
  }
  return `${d}Z`;
}

const reduced = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/**
 * A pair of eyes that change from one gaze to another smoothly. @param {Record<string, Gaze>} gazes @param {string} first
 */
function eyes(gazes, first) {
  const both = [0, 1].map(() => [s('path', { class: 'iris' }), s('ellipse', { class: 'light' })]);
  const el = s('g', { class: 'eyes' }, ...both.map((e) => s('g', { class: 'eye' }, ...e)));
  /** @param {Gaze} g */
  const draw = (g) => both.forEach(([iris, light], i) => {
    const e = g.eyes[i];
    const at = (/** @type {number[]} */ pts) => outline(each(pts, (x, y) => [x + g.look[0], y + g.look[1]]));
    iris.setAttribute('d', at(e.iris) + at(e.lash));
    for (const [k, v] of [['cx', e.light[0] + g.look[0]], ['cy', e.light[1] + g.look[1]], ['rx', e.light[2]], ['ry', e.light[3]]]) light.setAttribute(/** @type {string} */ (k), String(f(/** @type {number} */ (v))));
  });
  let shown = gazes[first];
  let frame = 0;
  /** Moves the eyes to a gaze over ms, then calls then. @param {string} name @param {number} ms @param {() => void} [then] */
  const to = (name, ms, then) => {
    cancelAnimationFrame(frame);
    const target = gazes[name];
    if (ms <= 0 || reduced()) {
      draw(shown = target);
      then?.();
      return;
    }
    const from = shown;
    const start = performance.now();
    const step = (/** @type {number} */ now) => {
      const k = Math.min(1, (now - start) / ms);
      draw(shown = mix(from, target, k < 0.5 ? 2 * k * k : 1 - (2 - 2 * k) ** 2 / 2));
      if (k < 1) frame = requestAnimationFrame(step);
      else then?.();
    };
    frame = requestAnimationFrame(step);
  };
  draw(shown);
  return { el, to };
}

// The streamer (README "Streamer"), measured by scripts/shiori-art/measure.mjs from the kit's tape_streamer: the middle
// of its outline along its top edge, its end's two corners, along its bottom edge, and its root's bottom corner, in
// the art's units from the middle of its straight root edge. It waves as a path, its root tucked under a bow's knot.
const STREAMER = [1.3, -22.7, 25.3, -20.7, 49.3, -12.8, 73.3, -3.8, 97.3, 1, 121.3, -3.8, 145.3, -15.3, 169.3, -30.2, 189, -45.5,
  216.7, 27.5, 169.3, 48.7, 145.3, 53.8, 121.3, 54.7, 97.3, 52, 73.3, 46.8, 49.3, 40.3, 25.3, 31, 1.7, 21.5];
const LONG = 217; // its length
/**
 * A streamer on a knot. @param {number[]} at where its root goes @param {number} k its size @param {number} turn its angle at rest, in degrees
 */
function streamer(at, k, turn) {
  const band = s('path', { class: 'band' });
  const el = s('g', { class: 'streamer' }, band);
  const [c, sn] = [Math.cos((turn * Math.PI) / 180), Math.sin((turn * Math.PI) / 180)];
  /** Its wave: travelling along it, from nothing at its root to `a` units at its end. @param {number} phase @param {number} a */
  const draw = (phase, a) => band.setAttribute('d', outline(each(STREAMER, (x, y) => {
    const w = y + a * (x / LONG) ** 1.3 * Math.sin((1.6 * Math.PI * x) / LONG - phase);
    return [at[0] + k * (x * c - w * sn), at[1] + k * (x * sn + w * c)];
  })));
  draw(0, 0);
  return { el, draw };
}

/** The wait before the next blink. @param {number} random 0..1 */
export function nextBlinkMs(random) {
  return Math.round(2600 + random * 5200);
}

/** What a glance of 1 moves her eyes, in the art's units. */
const GLANCE = 14;

/** @param {{ size?: 'sm' | 'md' | 'dock' | 'big', label?: string }} [o] */
export function createAvatar({ size = 'md', label } = {}) {
  const look = eyes(FRONT, 'asleep');
  const aside = eyes(TURNED, 'open');
  const hair = streamer([689, 361], 1, 38);
  const flag = streamer([406, 353], 1.3, -8);
  // Back to front, as the kit's README lays them: what she leaves while working; her body; her tail, wrapped round her
  // while she sleeps; her head (ears in their other poses, her skull under the upright ears, her head and hairpin; or
  // her head asleep; her eyes; or her head turned). The hairpin leans with her left ear; her voice swings its streamer.
  const svg = s('svg', { class: 'avsvg', viewBox: '-27 -34 1014 1014', 'aria-hidden': 'true', focusable: 'false' },
    s('g', { class: 'away' },
      s('g', { class: 'marker' }, part('marker'), group('grass', 'grass'), flag.el, part('marker-knot')),
      group('paws', 'paws'), group('tip', 'tail-tip')),
    s('g', { class: 'fox' },
      part('body'),
      group('curl', 'tail-asleep'),
      s('g', { class: 'head' },
        s('g', { class: 'front' },
          group('alt flat-r', 'ear-flat-right'), group('alt flat-l', 'ear-flat-left'), group('alt out-l', 'ear-out-left'),
          part('caps'), group('ear ear-r', 'ear-right'), group('ear ear-l', 'ear-left'), part('head'),
          s('g', { class: 'pin' }, part('pin'), group('tape', 'tape'), hair.el, part('loop'), part('knot'))),
        group('asleep', 'head-asleep'),
        look.el,
        s('g', { class: 'turned' }, part('head-turned'), aside.el))));
  const av = h('span', { class: 'av', dataset: { state: 'sleeping' } }, svg);
  const el = h('span', { class: ['seat', size], dataset: { glow: 'her' }, ...(label ? { role: 'img', 'aria-label': label } : {}) }, av);
  const state = () => av.dataset.state ?? '';
  const gaze = () => EYES[state()] ?? 'open';
  const turned = () => av.dataset.face === 'turned';

  const eyesOpen = () => !['sleeping', 'away', 'offline'].includes(state());
  let started = false;
  const blink = () => {
    if (reduced() || !eyesOpen()) return;
    // The eye squashes toward its lower third, ending on the closed shape, and opens again.
    const [pair, back] = turned() ? [aside, 'open'] : [look, gaze()];
    pair.to('closed', 75, () => setTimeout(() => eyesOpen() && pair.to(back, 120), 40));
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

  // Her head turns (Thinking, and back) in the middle of a blink, which hides the cut: there is no half-turned head.
  let swap = 0;
  /** @param {boolean} toTurned to the turned head, or back */
  const face = (toTurned) => {
    const id = ++swap;
    const [from, to] = toTurned ? [look, aside] : [aside, look];
    from.to('closed', 90, () => {
      if (id !== swap) return;
      if (toTurned) av.dataset.face = 'turned';
      else delete av.dataset.face;
      to.to('closed', 0);
      to.to(toTurned ? 'open' : gaze(), 150);
    });
  };

  // Her streamer waves with her voice while she talks, and on her marker while she works.
  let level = 0;
  let waving = 0;
  let phase = 0;
  let last = 0;
  let shown = false;
  /** @param {number} now */
  const wave = (now) => {
    const talking = state() === 'speaking';
    if ((!talking && state() !== 'away') || reduced() || (shown && !el.isConnected)) {
      waving = 0;
      return;
    }
    shown ||= el.isConnected;
    phase += (last ? Math.min(0.1, (now - last) / 1000) : 0) * (talking ? 3 + 6 * level : 3);
    last = now;
    if (talking) hair.draw(phase, 3 + 16 * level);
    else flag.draw(phase, 9);
    waving = requestAnimationFrame(wave);
  };
  const waves = () => {
    if (waving || reduced()) return;
    last = 0;
    waving = requestAnimationFrame(wave);
  };

  const api = {
    el,
    get state() { return state() || 'sleeping'; },
    /** @param {import('./avatar.js').AvatarState | string} next */
    setState(next) {
      const was = state();
      av.dataset.state = next;
      if ((next === 'thinking') !== turned()) face(next === 'thinking');
      // Falling asleep or waking, her eyes pass through the drowsy shape, whose lid curves with the eye.
      else if (next !== was && !turned()) {
        if ((was === 'sleeping' || next === 'sleeping') && was !== 'offline') look.to('drowsy', 260, () => look.to(gaze(), 360));
        else look.to(gaze(), 320);
      }
      if (next !== 'speaking' && next !== 'hearing') api.setLevel(0);
      waves();
    },
    /** The seat's glow follows the sound: her voice, or yours in grey (spec §16.3). @param {number} value 0..1 @param {'her' | 'you'} [who] */
    setLevel(value, who = 'her') {
      level = Math.max(0, Math.min(1, Number(value) || 0));
      el.dataset.glow = who;
      el.style.setProperty('--amp', String(level));
      av.style.setProperty('--amp', String(level));
    },
    /** A look toward something, such as a new card: her eyes and their highlights move together. @param {number} dx @param {number} dy */
    glance(dx, dy) {
      if (reduced()) return;
      const clamp = (/** @type {number} */ v) => Math.max(-3, Math.min(3, Number(v) || 0)) * GLANCE;
      for (const e of [look.el, aside.el]) e.style.transform = `translate(${clamp(dx)}px, ${clamp(dy)}px)`;
      setTimeout(() => { for (const e of [look.el, aside.el]) e.style.transform = ''; }, 1100);
    },
    blink,
  };
  return api;
}
