#!/usr/bin/env node
// Measures the shapes src/ui/avatar.js draws live, in the kit's art (a dev-time tool): Shiori's eyes, and the streamer.
//   node scripts/shiori-art/measure.mjs <kit folder>
// For each open eye: its oval as 24 points around it (rays from its middle to where the dark ends), its lash as an
// outline of points, and its highlight as an ellipse. For each closed eye asleep: the curve along its middle (its outer
// end, a control point, its inner end) and its thickness. For the streamer: the middle of its outline along its top
// and bottom edges and its end's corners, from the middle of its straight root edge. All in the SVG's units (3 pixels
// of the front master); the asleep eyes on her head before it dips (build.mjs DIP).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import { rgb, classify, where, region, fillHoles, and, minus, polygon, grow } from './raster.mjs';

const kit = process.argv[2];
if (!kit) {
  console.error('usage: node scripts/shiori-art/measure.mjs <kit folder>');
  process.exit(2);
}
const refs = ['3E1A10', 'FFFFFE', 'FFCBAE', 'EC3F29', 'FE3972', '790B32', '5F3926', '5C842F'].map(rgb);
/** The turned master on the front master's pixels: registered at the scarf's knot (README "Turned head"). */
export const TURNED = { scale: 1.1, knot: [1567, 2144], front: [1430, 2389] };

/**
 * @param {string} file @param {{ seed: number[], centre: number[] }} eye @param {(x: number, y: number) => number[]} to
 */
async function measure(file, eye, to) {
  const img = decodePng(await readFile(join(kit, file)));
  const L = classify(img, refs);
  const ink = where(L, (l) => l === 1);
  const whole = fillHoles(region(ink, eye.seed[0], eye.seed[1]));
  const [cx, cy] = eye.centre;
  const at = (/** @type {number} */ x, /** @type {number} */ y) => whole.data[Math.round(y) * img.width + Math.round(x)];
  /** @type {number[][]} */
  const oval = [];
  for (let a = 0; a < 360; a += 15) {
    const t = (a * Math.PI) / 180;
    let r = 0;
    while (at(cx + Math.cos(t) * r, cy - Math.sin(t) * r)) r += 0.5;
    oval.push([cx + Math.cos(t) * r, cy - Math.sin(t) * r]);
  }
  // The lash: what is left of the eye once the oval (and a little round it) is taken away.
  const lash = largest(minus(whole, grow(polygon(img.width, img.height, oval), 4)));
  const light = and(whole, where(L, (l) => l !== 1));
  let n = 0;
  let sx = 0;
  let sy = 0;
  light.data.forEach((v, p) => { if (v) [n, sx, sy] = [n + 1, sx + (p % img.width), sy + Math.floor(p / img.width)]; });
  const [lx, ly] = [sx / n, sy / n];
  let vx = 0;
  let vy = 0;
  light.data.forEach((v, p) => { if (v) [vx, vy] = [vx + ((p % img.width) - lx) ** 2, vy + (Math.floor(p / img.width) - ly) ** 2]; });
  const units = (/** @type {number[][]} */ pts) => pts.flatMap(([x, y]) => to(x, y).map((v) => Math.round(v)));
  const [ux, uy] = to(lx, ly);
  const k = to(1, 0)[0] - to(0, 0)[0]; // units per pixel of this master
  return {
    iris: units(oval),
    lash: units(simplify(trace(lash, img.width), 2.5)),
    light: [ux, uy, 2 * Math.sqrt(vx / n) * k, 2 * Math.sqrt(vy / n) * k].map((v) => Math.round(v * 10) / 10),
  };
}

/** The largest 4-connected region of a mask. @param {import('./raster.mjs').Mask} m */
function largest(m) {
  let best = m;
  let size = 0;
  const seen = new Uint8Array(m.data.length);
  for (let p = 0; p < m.data.length; p++) {
    if (!m.data[p] || seen[p]) continue;
    const r = region(m, p % m.width, Math.floor(p / m.width));
    let n = 0;
    r.data.forEach((v, q) => { if (v) { seen[q] = 1; n++; } });
    if (n > size) [best, size] = [r, n];
  }
  return best;
}

/** The outline of a region, walked round its edge pixels (Moore neighbours). @param {import('./raster.mjs').Mask} m @param {number} w */
function trace(m, w) {
  const set = (/** @type {number} */ x, /** @type {number} */ y) => x >= 0 && y >= 0 && x < w && y < m.height && m.data[y * w + x] === 1;
  let start = m.data.indexOf(1);
  const steps = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  let [x, y] = [start % w, Math.floor(start / w)];
  const out = [[x, y]];
  let dir = 6;
  for (let i = 0; i < 100000; i++) {
    let moved = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8;
      const [nx, ny] = [x + steps[d][0], y + steps[d][1]];
      if (set(nx, ny)) {
        [x, y, dir, moved] = [nx, ny, d, true];
        break;
      }
    }
    if (!moved || (x === start % w && y === Math.floor(start / w))) break;
    out.push([x, y]);
  }
  return out;
}

/** Fewer points along the same outline (Douglas-Peucker). @param {number[][]} pts @param {number} tolerance */
function simplify(pts, tolerance) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = /** @type {number[]} */ (stack.pop());
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1;
    let worst = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > worst) [far, worst] = [i, d];
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * A closed eye asleep: its middle at its two ends and halfway, as a quadratic curve, and its thickness there.
 * @param {string} file @param {number[]} box x0, x1, y0, y1 @param {(x: number, y: number) => number[]} to
 */
async function arc(file, [x0, x1, y0, y1], to) {
  const img = decodePng(await readFile(join(kit, file)));
  const ink = where(classify(img, refs), (l) => l === 1);
  const sx = Math.round((x0 + x1) / 2);
  let sy = y0;
  while (!ink.data[sy * img.width + sx]) sy++;
  const m = region(ink, sx, sy);
  const column = (/** @type {number} */ x) => {
    let [t, b] = [-1, -1];
    for (let y = y0 - 10; y <= y1 + 10; y++) if (m.data[y * img.width + x]) [t, b] = [t < 0 ? y : t, y];
    return [(t + b) / 2, b - t];
  };
  const [ends, middle] = [[x0 + 5, x1 - 5], Math.round((x0 + x1) / 2)];
  const [a, c, mid] = [ends[0], ends[1], middle].map((x) => [x, column(x)[0]]);
  // The control point that puts the curve through the middle halfway along it.
  const b = [2 * mid[0] - (a[0] + c[0]) / 2, 2 * mid[1] - (a[1] + c[1]) / 2];
  const k = to(1, 0)[0] - to(0, 0)[0];
  return { curve: [a, b, c].map(([x, y]) => to(x, y).map((v) => Math.round(v * 10) / 10)), thick: Math.round(column(middle)[1] * k * 10) / 10 };
}

/** The streamer's edges: the middle of its outline, from the middle of its root edge. @param {string} file */
async function streamer(file) {
  const { width: w, height: h, data } = decodePng(await readFile(join(kit, file)));
  const solid = (/** @type {number} */ x, /** @type {number} */ y) => data[(y * w + x) * 4 + 3] > 128;
  const dark = (/** @type {number} */ x, /** @type {number} */ y) => solid(x, y) && data[(y * w + x) * 4] < 190;
  // The root edge is the straight left side: its top and bottom corners.
  const left = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w / 8; x++) if (solid(x, y)) { left.push([x, y]); break; }
  const [rx, ry] = [(left[0][0] + left[left.length - 1][0]) / 2, (left[0][1] + left[left.length - 1][1]) / 2];
  const u = (/** @type {number} */ x, /** @type {number} */ y) => [Math.round(((x - rx) / 3) * 10) / 10, Math.round(((y - ry) / 3) * 10) / 10];
  /** Half the outline's width, down from the edge (or up). @param {number} x @param {number} y @param {number} dy */
  const middle = (x, y, dy) => {
    let n = 0;
    while (dark(x, y + n * dy)) n++;
    return y + (n / 2) * dy;
  };
  const top = [];
  const bottom = [];
  for (let x = Math.round(rx + 4); x < w * 0.8; x += Math.round(w / 11)) {
    let t = 0;
    while (!solid(x, t)) t++;
    let b = h - 1;
    while (!solid(x, b)) b--;
    top.push(...u(x, middle(x, t, 1)));
    if (x > left[left.length - 1][0] + 10) bottom.push(...u(x, middle(x, b, -1)));
  }
  let [tc, rc] = [[0, h], [0, 0]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (solid(x, y)) { if (y < tc[1]) tc = [x, y]; if (x > rc[0]) rc = [x, y]; }
  const [lb] = [left[left.length - 1]];
  return { top, end: [...u(tc[0], tc[1] + 15), ...u(rc[0] - 15, rc[1])], bottom, root: u(lb[0], lb[1] - 15) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const front = (/** @type {number} */ x, /** @type {number} */ y) => [x / 3, y / 3];
  const turned = (/** @type {number} */ x, /** @type {number} */ y) => [
    ((x - TURNED.knot[0]) * TURNED.scale + TURNED.front[0]) / 3, ((y - TURNED.knot[1]) * TURNED.scale + TURNED.front[1]) / 3];
  console.log('front, her right eye', JSON.stringify(await measure('master/shiori_master.png', { seed: [1060, 1750], centre: [1058, 1690] }, front)));
  console.log('turned, far eye', JSON.stringify(await measure('master/shiori_master_turned.png', { seed: [960, 1380], centre: [985, 1330] }, turned)));
  console.log('turned, near eye', JSON.stringify(await measure('master/shiori_master_turned.png', { seed: [1560, 1520], centre: [1560, 1450] }, turned)));
  // On her head before it dips: the asleep master's pixels moved back by DIP (build.mjs).
  const asleep = (/** @type {number} */ x, /** @type {number} */ y) => [(x + 45) / 3, (y - 156) / 3];
  console.log('asleep, her right eye', JSON.stringify(await arc('master/shiori_master_asleep.png', [813, 1200, 1820, 1967], asleep)));
  console.log('asleep, her left eye', JSON.stringify(await arc('master/shiori_master_asleep.png', [1598, 2008, 1823, 1968], asleep)));
  console.log('streamer', JSON.stringify(await streamer('parts/tape_streamer.png')));
}
