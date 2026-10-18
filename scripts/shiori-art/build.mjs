#!/usr/bin/env node
// Builds Shiori's art, assets/shiori.svg, from the user's art kit (a dev-time tool; nothing here ships).
//   node scripts/shiori-art/build.mjs <kit folder> [--debug <folder>]
// The kit's master decides every visible shape, position and colour. The tool cuts the master into the parts that
// move on their own (body, ears, head, hairpin, tape tail), fills what each part hid with what was around it, adds
// the parts the master doesn't show (the ears' other poses, the turned head, the curled tail, the tail's tip, the
// trail marker), splits each part into flat colour layers, traces each layer with potrace (in Docker), and writes
// the layers as one SVG of named groups. scripts/shiori-art/eyes.mjs measures the eyes, which are drawn live.
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng, encodePng } from './png.mjs';
import { rgb, classify, where, union, minus, and, region, fillHoles, distance, grow, inpaint, polygon, place, pbm, blank } from './raster.mjs';
import { tracedPath } from './paths.mjs';
import { TURNED } from './eyes.mjs';

const kit = process.argv[2];
if (!kit) {
  console.error('usage: node scripts/shiori-art/build.mjs <kit folder> [--debug <folder>]');
  process.exit(2);
}
const debugAt = process.argv.indexOf('--debug');
const debug = debugAt > 0 ? process.argv[debugAt + 1] : null;
const out = new URL('../../assets/shiori.svg', import.meta.url);

// The canvas: the master's pixels, with room around them for the parts that reach past it (the seat is larger).
const OX = 160;
const OY = 200;
const W = 2880 + 2 * OX;
const H = 2880 + 2 * OY;
/** Master pixels per unit of the SVG. */
const UNIT = 3;
/** Master points to canvas points. @param {number[][]} pts */
const pts = (pts) => pts.map(([x, y]) => [x + OX, y + OY]);

/**
 * Where the kit's other parts go, in front-master pixels: the part's pixel `from` lands on `to`, scaled, and turned
 * by `angle` degrees clockwise. Sized by the README and fitted by eye to the expression sheet and pose portraits.
 * @typedef {{ file: string, scale: number, angle?: number, from: number[], to: number[] }} At
 * @type {Record<string, At>}
 */
const AT = {
  tailSleep: { file: 'parts/tail_sleep.png', scale: 2.16, angle: -45, from: [700, 500], to: [1139, 2961] },
  tailTip: { file: 'parts/tail_tip.png', scale: 1.05, angle: -35, from: [702, 450], to: [2924, 1813] },
  marker: { file: 'parts/trail_marker.png', scale: 1.37, angle: 14, from: [392, 1620], to: [860, 2600] },
  earFlatRight: { file: 'parts/ears/ear_flat_right.png', scale: 1.92, angle: -10, from: [540, 260], to: [940, 1080] },
  earFlatLeft: { file: 'parts/ears/ear_flat_left.png', scale: 1.92, angle: 10, from: [116, 260], to: [1940, 1050] },
  earOutLeft: { file: 'parts/ears/ear_out_left.png', scale: 1.066, angle: -22.4, from: [25, 201], to: [1875, 933] },
};
/** A part's pixel, in front-master pixels. @param {At} at @param {number[]} p */
const onMaster = (at, [x, y]) => {
  const a = ((at.angle ?? 0) * Math.PI) / 180;
  const [dx, dy] = [(x - at.from[0]) * at.scale, (y - at.from[1]) * at.scale];
  return [at.to[0] + dx * Math.cos(a) - dy * Math.sin(a), at.to[1] + dx * Math.sin(a) + dy * Math.cos(a)];
};
/** A turned-master pixel, in front-master pixels. @param {number[]} p */
const fromTurned = ([x, y]) => [(x - TURNED.knot[0]) * TURNED.scale + TURNED.front[0], (y - TURNED.knot[1]) * TURNED.scale + TURNED.front[1]];

// Colour classes, as the README's palette (sampled from the master).
const [INK, FUR, PINK, SCARF, TAPE, BOW, TWIG, GRASS] = [1, 2, 3, 4, 5, 6, 7, 8];
/** @type {Record<number, string | null>} */
const FILL = { [INK]: '#3E1A10', [FUR]: '#FFFFFE', [PINK]: '#FFCBAE', [SCARF]: '#EC3F29', [TAPE]: '#FE3972', [BOW]: '#790B32', [TWIG]: '#583623', [GRASS]: '#5C842F' };
/** What each class looks like in a picture: the master's twig is #5F3926 and the marker's lighter. @param {string} twig */
const refs = (twig) => ['3E1A10', 'FFFFFE', 'FFCBAE', 'EC3F29', 'FE3972', '790B32', twig, '5C842F'].map(rgb);

const png = async (/** @type {string} */ f) => decodePng(await readFile(join(kit, f)));
/** A kit part on the canvas, as classes. @param {At} at */
const placed = async (at, twig = '5F3926') =>
  classify(place(await png(at.file), { ...at, to: [at.to[0] + OX, at.to[1] + OY] }, W, H), refs(twig));

/** Labels kept where the mask is set. @param {import('./raster.mjs').Labels} L @param {import('./raster.mjs').Mask} m */
const cut = (L, m) => ({ ...L, data: L.data.map((l, p) => (m.data[p] ? l : 0)) });
/** @param {import('./raster.mjs').Labels} L @param {number[]} classes */
const is = (L, classes) => where(L, (l) => classes.includes(l));
/** The region of a mask holding a point, in master pixels. @param {import('./raster.mjs').Mask} m @param {number[]} p */
const seed = (m, [x, y]) => region(m, Math.round(x) + OX, Math.round(y) + OY);

/**
 * A head's own pixels: the white fur joined to its face, its holes (eyes, nose, blush, inner ears, hairpin) and the
 * outline round it, and the body's own. Where the two meet, each gets the whole line, so either can move off it.
 * @param {import('./raster.mjs').Labels} L @param {number[]} face a point on the face @param {number[][]} [more] points in an ear its outline cuts off
 */
function headOf(L, face, more = []) {
  const all = fillHoles(union(seed(is(L, [FUR]), face), ...more.map((p) => seed(is(L, [FUR, PINK]), p))));
  const bodyLight = minus(is(L, [FUR, SCARF]), all);
  const dHead = distance(all).dist;
  const dBody = distance(bodyLight).dist;
  const OUTLINE = 40; // a little over the outline's width
  return {
    all,
    // Each keeps the outline next to its own fur; where an outline is next to neither, the nearer one has it.
    head: union(all, where(L, (l, p) => l === INK && (dHead[p] <= OUTLINE || (dBody[p] > OUTLINE && dHead[p] <= dBody[p])))),
    body: union(bodyLight, where(L, (l, p) => l === INK && dBody[p] <= OUTLINE)),
  };
}

/**
 * A bow's pieces that move apart: its knot (on top), its tails (they swing under the knot, so they reach up under it),
 * and what stays; where the knot and tails hid the twig, the twig carried on straight.
 * @param {import('./raster.mjs').Labels} L @param {{ knot: number[], tails: number[][], stem: number[][], twig: import('./raster.mjs').Mask, edge: number }} bow
 */
function bowPieces(L, { knot: k, tails: t, stem, twig, edge }) {
  const tape = is(L, [TAPE]);
  const lines = is(L, [INK, BOW, TAPE]);
  const knotIn = seed(tape, k);
  const knot = and(grow(knotIn, edge), lines);
  const tailsIn = union(...t.map((p) => seed(tape, p)));
  const tails = minus(and(grow(tailsIn, edge), lines), knot);
  const hidden = and(minus(union(knot, tails), twig), polygon(W, H, pts(stem)));
  const seen = cut(L, minus(twig, hidden));
  const stays = { ...L, data: L.data.map((l, p) => (knot.data[p] || (tails.data[p] && !twig.data[p]) ? 0 : l)) };
  const filled = cut(inpaint(seen, hidden, (l) => l === INK || l === TWIG), union(twig, hidden));
  return {
    hidden,
    stays: { ...stays, data: stays.data.map((l, p) => (hidden.data[p] ? filled.data[p] : l)) },
    tails: { ...L, data: L.data.map((l, p) => (tails.data[p] ? l : knotIn.data[p] ? TAPE : 0)) },
    knot: cut(L, knot),
  };
}

console.log('reading the master');
const master = classify(place(await png('master/shiori_master.png'), { to: [OX, OY] }, W, H), refs('5F3926'));

// The hairpin: twig, bow and tape, and the twig's dark outline, in a box around it.
const pinBox = polygon(W, H, pts([[1780, 760], [2400, 760], [2400, 1450], [1780, 1450]]));
// The twig, from its three ends (a few edge pixels elsewhere blend to the twig's colour).
const twigClass = is(master, [TWIG]);
const twigFill = union(seed(twigClass, [1890, 940]), seed(twigClass, [2100, 870]), seed(twigClass, [2130, 1320]));
const twigAll = union(twigFill, and(and(grow(twigFill, 34), is(master, [INK])), pinBox));
const bowAll = and(is(master, [TAPE, BOW]), pinBox);
const pin = union(twigAll, bowAll);

// Her eyes are drawn live (src/ui/avatar.js), so the traced head has fur where they were.
const inkMask = is(master, [INK]);
const eyes = grow(union(fillHoles(seed(inkMask, [1060, 1750])), fillHoles(seed(inkMask, [1820, 1750]))), 4);

console.log('filling under the eyes and the hairpin');
const face = inpaint(inpaint(master, eyes, (l) => l === FUR), pin, (l) => l === FUR || l === PINK);
const { all: headAll, head, body: bodyOwn } = headOf(face, [1440, 1300]);

// Ears: everything past a line across each ear's base, from the notch where the ruff starts to the corner where the
// ear meets the top of her head; the line dips under the inner ear's tip. Below the line, a stub of white fur that the
// head covers. src/ui/shiori.css leans each ear about its base line (printed at the end), so the seam never opens.
/** Each ear's base line, from the ruff's notch toward her head, in master pixels. */
const EAR_LINE = { right: [[510, 1315], [1188, 915]], left: [[2362, 1314], [1645, 910]] };
const earPoly = {
  right: polygon(W, H, pts([[0, -OY], [1260, -OY], [1260, 846], [1225, 883], [1165, 945], [900, 1105], [700, 1270], [640, 1300], [545, 1335], [475, 1295], [300, 1240], [0, 1240]])),
  left: polygon(W, H, pts([[2880, -OY], [1600, -OY], [1600, 840], [1638, 878], [1650, 942], [1960, 1100], [2200, 1240], [2270, 1300], [2325, 1333], [2400, 1295], [2580, 1240], [2880, 1240]])),
};
const innerEar = { right: seed(is(face, [PINK]), [760, 760]), left: seed(is(face, [PINK]), [2160, 700]) };
/** @type {Record<string, import('./raster.mjs').Labels>} */
const ears = {};
let headOnly = head;
for (const side of /** @type {const} */ (['right', 'left'])) {
  const ear = and(union(earPoly[side], grow(innerEar[side], 26)), head);
  const stub = minus(and(grow(ear, 150), is(face, [FUR])), ear);
  ears[side] = { ...face, data: face.data.map((l, p) => (ear.data[p] ? l : stub.data[p] && headAll.data[p] ? FUR : 0)) };
  headOnly = minus(headOnly, ear);
}
const headPart = cut(face, headOnly);

// Her skull under each ear: a curve from where the ear meets the top of her head, carrying on its line, round to the
// ruff's notch. The upright ears hide it; with an ear folded flat or angled out, it is the top of her head.
const caps = blank(W, H);
const capLine = blank(W, H);
for (const [[ox, oy], [ix, iy]] of Object.values(EAR_LINE)) {
  const out = Math.sign(ox - ix); // which way is outward
  const curve = [[ix, iy], [ix + out * 290, iy + 68], [ox, oy - 280], [ox, oy]];
  /** @type {number[][]} */
  const along = [];
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    const b = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
    along.push([0, 1].map((k) => b.reduce((s, w, j) => s + w * curve[j][k], 0)));
  }
  const inside = polygon(W, H, pts([...along, [ox - out * 200, oy + 250], [ix - out * 50, iy + 250]]));
  inside.data.forEach((v, p) => { if (v) caps.data[p] = 1; });
  for (const [x, y] of along) capLine.data[(Math.round(y) + OY) * W + Math.round(x) + OX] = 1;
}
const capInk = grow(capLine, 32);
const capPart = { width: W, height: H, data: caps.data.map((v, p) => (capInk.data[p] ? INK : v ? FUR : 0)) };

// Body: the master's body where it shows, and the kit's body part under her head and below the master's bottom edge.
// The part is registered at the scarf's knot and set 90 pixels lower, so its scarf stays inside the master's: when
// her head lifts, the neck shows above one outline, not two.
console.log('placing the body part');
const bodyKit = await placed({ file: 'parts/body.png', scale: 1.94, from: [443.8, 362.6], to: [1430, 2478] });
// The scarf's knot is finished as the circle it is (fill 97 by 91 pixels, a 31-pixel outline), where her chin's tufts
// covered it, for when her head tilts off it.
const KNOT = { x: 1430, y: 2389, rx: 97, ry: 91, line: 31 };
const bodyPart = {
  ...face,
  data: face.data.map((l, p) => {
    const x = (p % W) - OX;
    const y = Math.floor(p / W) - OY;
    const e = (/** @type {number} */ grow) => ((x - KNOT.x) / (KNOT.rx + grow)) ** 2 + ((y - KNOT.y) / (KNOT.ry + grow)) ** 2;
    if (e(0) <= 1) return SCARF;
    if (bodyOwn.data[p]) return l;
    if (head.data[p] && e(KNOT.line) <= 1) return INK;
    return head.data[p] || y >= 2878 ? bodyKit.data[p] : 0;
  }),
};

// The hairpin's pieces: the twig, the tape's tail (it swings with her voice), the bow's loop over it, the knot on top.
const pinPieces = bowPieces(master, { knot: [2075, 1085], tails: [[2240, 1230]], stem: [[2000, 990], [2080, 960], [2190, 1420], [2110, 1440]], twig: twigAll, edge: 30 });
const loopIn = seed(is(master, [TAPE]), [2215, 1010]);
const loop = minus(and(grow(loopIn, 30), bowAll), and(grow(seed(is(master, [TAPE]), [2075, 1085]), 30), bowAll));
const pinTwig = cut(pinPieces.stays, union(twigAll, pinPieces.hidden));

// Her head turned three-quarters, for Thinking: the turned master on the front's pixels, registered at the scarf's
// knot; its ears and hairpin stay where it drew them, and its eyes are drawn live like the front ones.
console.log('reading the turned master');
const turned = classify(place(await png('master/shiori_master_turned.png'), { scale: TURNED.scale, from: TURNED.knot, to: [TURNED.front[0] + OX, TURNED.front[1] + OY] }, W, H), refs('5F3926'));
const turnedInk = is(turned, [INK]);
const turnedEyes = grow(union(fillHoles(seed(turnedInk, fromTurned([960, 1380]))), fillHoles(seed(turnedInk, fromTurned([1560, 1520])))), 4);
const turnedFace = inpaint(turned, turnedEyes, (l) => l === FUR);
const headTurned = cut(turnedFace, headOf(turnedFace, fromTurned([1250, 1150]), [fromTurned([1240, 600])]).head);

// The other ear poses (README "Ear poses"): folded flat for Asleep and Offline, her left ear angled out for Your turn.
console.log('placing the ears, tails and marker');
const earFlatRight = await placed(AT.earFlatRight);
const earFlatLeft = await placed(AT.earFlatLeft);
const earOutLeft = await placed(AT.earOutLeft);

// The parts the master doesn't show: the curled tail big, turned so its tip rises in front of her (pose_asleep);
// the marker about as tall as her head and ears, its tape's tails flying free; the tail's tip leaving past the seat.
const tailSleep = await placed(AT.tailSleep);
const tailTip = await placed(AT.tailTip);
const marker = await placed(AT.marker, '734930');
const markerAt = (/** @type {number[]} */ p) => onMaster(AT.marker, p);
const markerTwig = seed(is(marker, [TWIG]), markerAt([300, 1200]));
const markerPieces = bowPieces(marker, {
  knot: markerAt([373, 457]), tails: [markerAt([567, 575]), markerAt([525, 742])],
  stem: [[250, 380], [430, 380], [412, 920], [250, 920]].map(markerAt), twig: union(markerTwig, and(grow(markerTwig, 34), is(marker, [INK]))), edge: 46,
});

/**
 * A part's layers, back to front: a colour, the classes it covers, and the outline classes it reaches a little way
 * under. Fills go first and lines last, so an edge with no outline (where parts meet) is only ever the fill's own.
 * A colour of null leaves the fill to the page (the marker's twig and lines, which are lighter on the dark seat).
 * @typedef {[string | null, number[], number[]?]} Layer
 * @typedef {{ id: string, labels: import('./raster.mjs').Labels, layers: Layer[] }} Part
 */
const fur = /** @type {Layer[]} */ ([[FILL[FUR], [FUR, PINK], [INK]], [FILL[PINK], [PINK], [INK]], [FILL[INK], [INK]]]);
const bow = /** @type {Layer[]} */ ([[FILL[TAPE], [TAPE], [BOW]], [FILL[BOW], [BOW]]]);
// The marker's twig takes the page's currentColor, and its lines the page's fill.
const markerLayers = /** @type {Layer[]} */ ([['currentColor', [TWIG], [INK, BOW]], [FILL[GRASS], [GRASS], [INK, BOW]], [FILL[TAPE], [TAPE], [INK, BOW]], [null, [INK, BOW]]]);
/** @type {Part[]} */
const PARTS = [
  { id: 'marker', labels: markerPieces.stays, layers: markerLayers },
  { id: 'marker-tape', labels: markerPieces.tails, layers: markerLayers },
  { id: 'marker-knot', labels: markerPieces.knot, layers: markerLayers },
  { id: 'tail-tip', labels: tailTip, layers: fur },
  { id: 'body', labels: bodyPart, layers: [[FILL[FUR], [FUR, SCARF], [INK]], [FILL[SCARF], [SCARF], [INK]], [FILL[INK], [INK]]] },
  { id: 'ear-flat-right', labels: earFlatRight, layers: fur },
  { id: 'ear-flat-left', labels: earFlatLeft, layers: fur },
  { id: 'ear-out-left', labels: earOutLeft, layers: fur },
  { id: 'caps', labels: capPart, layers: fur },
  { id: 'ear-right', labels: ears.right, layers: fur },
  { id: 'ear-left', labels: ears.left, layers: fur },
  { id: 'head', labels: headPart, layers: fur },
  { id: 'pin', labels: pinTwig, layers: [[FILL[TWIG], [TWIG], [INK]], [FILL[INK], [INK]]] },
  { id: 'tape', labels: pinPieces.tails, layers: bow },
  { id: 'loop', labels: cut(master, loop), layers: bow },
  { id: 'knot', labels: pinPieces.knot, layers: bow },
  { id: 'head-turned', labels: headTurned, layers: [[FILL[FUR], [FUR, PINK], [INK]], [FILL[PINK], [PINK], [INK]], [FILL[TWIG], [TWIG], [INK]], ...bow, [FILL[INK], [INK]]] },
  { id: 'tail-sleep', labels: tailSleep, layers: fur },
];
/** A layer's mask: its classes, and up to 6 pixels of the outline next to them. @param {Part} part @param {number[]} classes @param {number[]} [into] */
function layerMask(part, classes, into = []) {
  const own = is(part.labels, classes);
  return into.length ? union(own, and(grow(own, 6), is(part.labels, into))) : own;
}

if (debug) {
  await mkdir(debug, { recursive: true });
  for (const part of PARTS) await writeFile(join(debug, `${part.id}.png`), encodePng(preview(part.labels)));
}

console.log('tracing');
const work = await mkdtemp(join(tmpdir(), 'shiori-art-'));
try {
  for (const part of PARTS) {
    for (const [i, [, classes, into]] of part.layers.entries()) await writeFile(join(work, `${part.id}.${i}.pbm`), pbm(layerMask(part, classes, into)));
  }
  execFileSync('docker', ['run', '--rm', '-v', `${work}:/t`, '-w', '/t', 'alpine:3.20', 'sh', '-c',
    'apk add --no-cache potrace >/dev/null && for f in *.pbm; do potrace "$f" -s -o "${f%.pbm}.svg" --turdsize 8 --alphamax 1.1 --opttolerance 0.4; done'], { stdio: 'inherit' });
  const groups = [];
  for (const part of PARTS) {
    const layers = [];
    for (const [i, [colour]] of part.layers.entries()) {
      const d = tracedPath(await readFile(join(work, `${part.id}.${i}.svg`), 'utf8'), (x, y) => [(x - OX) / UNIT, (y - OY) / UNIT]);
      if (d) layers.push(colour ? `<path fill="${colour}" d="${d}"/>` : `<path d="${d}"/>`);
    }
    groups.push(`<g id="${part.id}">${layers.join('')}</g>`);
  }
  groups.push(paws());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-27 -34 1014 1014">
<!-- Shiori's parts, traced from the user's art kit by scripts/shiori-art/build.mjs. Don't edit by hand; run the tool. -->
<defs>
${groups.join('\n')}
</defs>
</svg>
`;
  await writeFile(out, svg);
  console.log(`wrote assets/shiori.svg (${(svg.length / 1024).toFixed(1)} KiB)`);
  // What src/ui/shiori.css pivots the parts about, in the SVG's units.
  const u = (/** @type {number} */ v) => Math.round(v / UNIT);
  for (const [side, [[ox, oy], [ix, iy]]] of Object.entries(EAR_LINE)) {
    const turn = Math.atan2(side === 'right' ? iy - oy : oy - iy, side === 'right' ? ix - ox : ox - ix) * 180 / Math.PI;
    console.log(`ear-${side[0]}: origin ${u(ox)}px ${u(oy)}px, base turned ${turn.toFixed(1)}deg`);
  }
  const centre = (/** @type {import('./raster.mjs').Mask} */ m) => {
    let [n, sx, sy] = [0, 0, 0];
    m.data.forEach((v, p) => { if (v) [n, sx, sy] = [n + 1, sx + (p % W) - OX, sy + Math.floor(p / W) - OY]; });
    return `${u(sx / n)}px ${u(sy / n)}px`;
  };
  console.log(`tape: origin ${centre(seed(is(master, [TAPE]), [2075, 1085]))} (the knot)`);
  console.log(`marker-tape: origin ${centre(seed(is(marker, [TAPE]), markerAt([373, 457])))} (its knot)`);
  console.log(`tail-tip: origin ${AT.tailTip.to.map(u).join('px ')}px (the top of its cut edge, outside the seat)`);
} finally {
  await rm(work, { recursive: true, force: true });
}

/** A few paw prints, for Working (the README: drawn in SVG), in the avatar's colour for them (light or dark). */
function paws() {
  const print = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ turn) =>
    `<g transform="rotate(${turn} ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="32" ry="27"/><circle cx="${x - 32}" cy="${y - 36}" r="12"/><circle cx="${x - 11}" cy="${y - 50}" r="12"/><circle cx="${x + 11}" cy="${y - 50}" r="12"/><circle cx="${x + 32}" cy="${y - 36}" r="12"/></g>`;
  return `<g id="paws" fill="currentColor" opacity=".7">${print(460, 800, 70)}${print(585, 870, 95)}${print(700, 790, 75)}</g>`;
}

/** A small picture of a label map, to look at. @param {import('./raster.mjs').Labels} L */
function preview(L) {
  const s = 4;
  const w = Math.floor(L.width / s);
  const h = Math.floor(L.height / s);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = L.data[y * s * L.width + x * s];
      const c = l ? rgb((FILL[l] ?? '#888888').slice(1)) : [197, 214, 184];
      data.set([...c, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}
