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

// Her eyes, in the art's units (3 pixels of the kit's front master): an oval (24 points round it), a lash, and a
// highlight [x, y, rx, ry]. Front: her right eye, on your left; her left mirrors it. The turned eyes (FAR, NEAR), the
// asleep ones and the streamer are scripts/shiori-art/measure.mjs's numbers as it prints them. The front open eye is
// tuned by hand and differs from what the tool prints, on purpose, so a re-run of the tool doesn't change it:
//   - OPEN is the tool's oval, but for its 8th and 9th points (by the lash's root), which come from the first round's
//     measurement and are 1 to 3 units off what the tool prints now;
//   - LASH was traced by hand from the master, along the lash's outer edge and back along its inner one; the tool
//     traces the same stroke as a different 13-point outline;
//   - LIGHT is round: the tool measures 14.5 by 14.8.
// Don't paste the tool's front-eye numbers over these without looking at her eyes.
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

// One query for every avatar (reduced motion), read at load; each avatar on screen listens for it to change.
const motion = typeof matchMedia === 'function' ? matchMedia(/* en */ '(prefers-reduced-motion: reduce)') : null;
const reduced = () => Boolean(motion?.matches);

/**
 * A pair of eyes that change from one gaze to another smoothly, or at once when still() says so.
 * @param {Record<string, Gaze>} gazes @param {string} first @param {() => boolean} still
 */
function eyes(gazes, first, still) {
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
  /** Moves the eyes to a gaze over ms, then calls then (unless another move replaces this one). @param {string} name @param {number} ms @param {() => void} [then] */
  const to = (name, ms, then) => {
    cancelAnimationFrame(frame);
    const target = gazes[name];
    if (ms <= 0 || still()) {
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
 * A streamer's shape on a knot: its wave travels along it, from nothing at its root to `a` units at its end.
 * @param {number[]} at where its root goes @param {number} k its size @param {number} turn its angle at rest, in degrees
 * @returns {(phase: number, a: number) => string} its path
 */
const band = (at, k, turn) => {
  const [c, sn] = [Math.cos((turn * Math.PI) / 180), Math.sin((turn * Math.PI) / 180)];
  return (phase, a) => outline(each(STREAMER, (x, y) => {
    const w = y + a * (x / LONG) ** 1.3 * Math.sin((1.6 * Math.PI * x) / LONG - phase);
    return [at[0] + k * (x * c - w * sn), at[1] + k * (x * sn + w * c)];
  }));
};
/** On her hairpin's bow (shiori.css swings it about the knot), and on her marker's knot, larger. */
const HAIR = band([689, 361], 1, 38);
const FLAG = band([406, 353], 1.3, -8);
/** @param {string} d */
const streamer = (d) => {
  const path = s('path', { class: 'band', d });
  return { el: s('g', { class: 'streamer' }, path), path };
};

// Working: one wave of the marker's streamer, and her tail's tip wagging, as frames worked out once and stepped through
// at STEP ms, rather than redrawn every frame for as long as she works.
const STEP = 1000 / 15;
const WAVE = 30; // frames in a wave: 2 s
const WAG = 42; // frames in a wag: 2.8 s
/** @type {string[]} */
let waves = [];
const flagAt = (/** @type {number} */ n) => (waves[n % WAVE] ??= FLAG((2 * Math.PI * (n % WAVE)) / WAVE, 9));
const wagAt = (/** @type {number} */ n) => `rotate(${f(6 * Math.cos((2 * Math.PI * (n % WAG)) / WAG))} 975 604)`;

/** The wait before the next blink. @param {number} random 0..1 */
export function nextBlinkMs(random) {
  return Math.round(2600 + random * 5200);
}

/** What a glance of 1 moves her eyes, in the art's units. */
const GLANCE = 14;
/** How far her head's swap (front, asleep) waits into a dip: halfway through the move, as shiori.css's ear swaps. */
const SWAP_MS = 200;

/** @param {{ size?: 'sm' | 'md' | 'dock' | 'big', label?: string }} [o] */
export function createAvatar({ size = 'md', label } = {}) {
  // Off screen, off the page, or with reduced motion, nothing moves on its own: eyes and heads change at once.
  let visible = false;
  const still = () => !visible || reduced();
  const look = eyes(FRONT, 'asleep', still);
  const aside = eyes(TURNED, 'open', still);
  const hair = streamer(HAIR(0, 0));
  const flag = streamer(FLAG(0, 0));
  const tip = group('tip', 'tail-tip');
  // Back to front, as the kit's README lays them: what she leaves while working; her body; her tail, wrapped round her
  // while she sleeps; her head (ears in their other poses, her skull under the upright ears, her head and hairpin; or
  // her head asleep; her eyes; or her head turned). The hairpin leans with her left ear; her voice swings its streamer.
  const body = part('body');
  const svg = s('svg', { class: 'avsvg', viewBox: '-27 -34 1014 1014', 'aria-hidden': 'true', focusable: 'false' },
    s('g', { class: 'away' },
      s('g', { class: 'marker' }, part('marker'), group('grass', 'grass'), flag.el, part('marker-knot')),
      group('paws', 'paws'), tip),
    s('g', { class: 'fox' },
      body,
      group('curl', 'tail-asleep'),
      s('g', { class: 'head' },
        s('g', { class: 'front' },
          group(/* en */ 'alt flat-r', 'ear-flat-right'), group(/* en */ 'alt flat-l', 'ear-flat-left'), group(/* en */ 'alt out-l', 'ear-out-left'),
          part('caps'), group(/* en */ 'ear ear-r', 'ear-right'), group(/* en */ 'ear ear-l', 'ear-left'), part('head'),
          s('g', { class: 'pin' }, part('pin'), group('tape', 'tape'), hair.el, part('loop'), part('knot'))),
        group('asleep', 'head-asleep'),
        look.el,
        s('g', { class: 'turned' }, part('head-turned'), aside.el))));
  // Until her art has arrived, the seat shows alone (data-art="wait"), never eyes floating on it.
  const av = h('span', { class: 'av', dataset: { state: 'sleeping', face: 'asleep', art: 'wait', hidden: '' } }, svg);
  const el = h('span', { class: ['seat', size], dataset: { glow: 'her' }, ...(label ? { role: 'img', 'aria-label': label } : {}) }, av);
  const state = () => av.dataset.state ?? '';
  const gaze = () => EYES[state()] ?? 'open';
  /** The head she should show: turned while thinking, asleep while asleep, else her front one (no data-face). */
  const want = () => (state() === 'thinking' ? 'turned' : state() === 'sleeping' ? 'asleep' : undefined);
  /** @param {string | undefined} face */
  const show = (face) => {
    if (face === av.dataset.face) return;
    if (face) av.dataset.face = face;
    else delete av.dataset.face;
  };
  const turned = () => av.dataset.face === 'turned';

  // Her head and eyes settle on what her state asks for. The turned head comes and goes in the middle of a blink,
  // which hides the cut (there is no half-turned one); her asleep head takes over halfway through her head's dip.
  let swapping = false;
  /** @type {any} */
  let reopen;
  /** @type {any} */
  let dip;
  /** @param {number} ms */
  const settle = (ms) => {
    if ((want() === 'turned') !== turned()) {
      swap();
      return;
    }
    (turned() ? aside : look).to(turned() ? 'open' : gaze(), ms);
  };
  const swap = () => {
    if (swapping) return;
    swapping = true;
    clearTimeout(reopen);
    clearTimeout(dip);
    (turned() ? aside : look).to('closed', 90, () => {
      swapping = false;
      show(want());
      (turned() ? aside : look).to('closed', 0);
      settle(150);
    });
  };

  const eyesOpen = () => !['sleeping', 'away', 'offline'].includes(state());
  const blink = () => {
    if (still() || swapping || !eyesOpen()) return;
    clearTimeout(reopen);
    // The eye squashes toward its lower third, ending on the closed shape, and opens again on whatever she is now.
    (turned() ? aside : look).to('closed', 75, () => { reopen = setTimeout(() => settle(120), 40); });
  };
  /** @type {any} */
  let blinking;
  const blinks = () => {
    clearTimeout(blinking);
    if (still() || !eyesOpen()) return;
    blinking = setTimeout(() => {
      blink();
      blinks();
    }, nextBlinkMs(Math.random()));
  };

  // Her streamer waves with her voice while she talks (redrawn only when it has moved enough to see), and on her
  // marker while she works, with her tail's tip, stepped through frames worked out once.
  let level = 0;
  let px = 64; // her seat's size on screen
  let frame = 0;
  /** @type {any} */
  let stepping;
  let n = 0;
  let phase = 0;
  let last = 0;
  let drawn = [0, 0]; // the phase and wave last drawn
  /** @param {number} now */
  const talk = (now) => {
    frame = 0;
    if (still() || state() !== 'speaking') return;
    phase = (phase + (last ? Math.min(0.1, (now - last) / 1000) : 0) * (3 + 6 * level)) % (2 * Math.PI);
    last = now;
    const a = 3 + 16 * level;
    // Half a pixel on screen, in the art's units: what moves less is not drawn.
    const seen = (0.5 * 1014) / px;
    const turn = Math.abs(phase - drawn[0]);
    if (Math.abs(a - drawn[1]) > seen || a * Math.min(turn, 2 * Math.PI - turn) > seen) {
      hair.path.setAttribute('d', HAIR(phase, a));
      drawn = [phase, a];
    }
    frame = requestAnimationFrame(talk);
  };
  const work = () => {
    stepping = undefined;
    if (still() || state() !== 'away') return;
    n = (n + 1) % (WAVE * WAG);
    flag.path.setAttribute('d', flagAt(n));
    tip.setAttribute('transform', wagAt(n));
    stepping = setTimeout(work, STEP);
  };
  /** Starts or stops what moves on its own, for her state and whether she is seen. */
  const loops = () => {
    blinks();
    if (state() === 'speaking' && !still()) {
      if (!frame) {
        last = 0;
        frame = requestAnimationFrame(talk);
      }
    } else {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (state() === 'away' && !still()) {
      if (!stepping) stepping = setTimeout(work, STEP);
    } else {
      clearTimeout(stepping);
      stepping = undefined;
    }
  };
  const onMotion = () => loops();

  // Her art has arrived once a part has a size; until then she waits, asking every 100 ms while seen, for up to 10 s.
  let asked = 0;
  /** @type {any} */
  let asking;
  const arrived = () => {
    try {
      return /** @type {SVGGraphicsElement} */ (/** @type {unknown} */ (body)).getBBox().width > 0;
    } catch {
      return false;
    }
  };
  const ask = () => {
    clearTimeout(asking);
    if (av.dataset.art !== 'wait' || !visible || asked >= 100) return;
    if (arrived()) {
      delete av.dataset.art;
      return;
    }
    asked++;
    asking = setTimeout(ask, 100);
  };

  // Whether she is seen: on the page and on screen. Out of sight, every loop stops (shiori.css pauses its own).
  /** @param {boolean} seen @param {number} [width] */
  const see = (seen, width) => {
    if (width) px = width;
    if (seen === visible) return;
    visible = seen;
    if (seen) {
      delete av.dataset.hidden;
      motion?.addEventListener('change', onMotion);
    } else {
      av.dataset.hidden = '';
      motion?.removeEventListener('change', onMotion);
    }
    loops();
    ask();
  };
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      see(e.isIntersecting && el.isConnected, e.boundingClientRect.width);
    }).observe(el);
  } else see(true);

  /** @type {any} */
  let glancing;
  const api = {
    el,
    get state() { return state() || 'sleeping'; },
    /** @param {import('./avatar.js').AvatarState | string} next */
    setState(next) {
      const was = state();
      if (next === was) return;
      av.dataset.state = next;
      clearTimeout(dip);
      if (!swapping) {
        if ((want() === 'turned') !== turned()) swap();
        else {
          // Falling asleep or waking, her eyes pass through the drowsy shape, whose lid curves with the eye, and her
          // asleep head takes over (or gives way) halfway through her head's dip.
          if ((was === 'sleeping' || next === 'sleeping') && was !== 'offline') look.to('drowsy', 260, () => settle(360));
          else settle(320);
          if (want() !== av.dataset.face) {
            if (still()) show(want());
            else dip = setTimeout(() => !swapping && !turned() && show(want()), SWAP_MS);
          }
        }
      }
      if (next !== 'speaking' && next !== 'hearing') api.setLevel(0);
      loops();
    },
    /** The seat's glow follows the sound: her voice, or yours in grey (spec §16.3). @param {number} value 0..1 @param {'her' | 'you'} [who] */
    setLevel(value, who = 'her') {
      const v = Math.max(0, Math.min(1, Number(value) || 0));
      if (el.dataset.glow !== who) el.dataset.glow = who;
      if (v === level) return;
      level = v;
      el.style.setProperty('--amp', String(v)); // .av and her parts inherit it
    },
    /** A look toward something, such as a new card: her eyes and their highlights move together. @param {number} dx @param {number} dy */
    glance(dx, dy) {
      if (still()) return;
      const clamp = (/** @type {number} */ v) => Math.max(-3, Math.min(3, Number(v) || 0)) * GLANCE;
      clearTimeout(glancing);
      for (const e of [look.el, aside.el]) e.style.transform = /* en */ `translate(${clamp(dx)}px, ${clamp(dy)}px)`;
      glancing = setTimeout(() => { for (const e of [look.el, aside.el]) e.style.transform = ''; }, 1100);
    },
    blink,
  };
  return api;
}
