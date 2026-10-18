#!/usr/bin/env node
// Builds Shiori's art, assets/shiori.svg, from the user's art kit (a dev-time tool; nothing here ships).
//   node scripts/shiori-art/build.mjs <kit folder> [--debug <folder>]
// The kit's master decides every visible shape, position and colour. The tool cuts the master into the parts that
// move on their own (body, ears, head, hairpin, tape tail), fills what each part hid with what was around it, adds
// the parts the master doesn't show (the curled tail, the tail's tip, the trail marker), splits each part into flat
// colour layers, traces each layer with potrace (in Docker), and writes the layers as one SVG of named groups.
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng, encodePng } from './png.mjs';
import { rgb, classify, where, union, minus, and, region, fillHoles, distance, grow, inpaint, polygon, place, pbm } from './raster.mjs';
import { tracedPath } from './paths.mjs';

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

// Colour classes, as the README's palette (sampled from the master).
const [INK, FUR, PINK, SCARF, TAPE, BOW, TWIG, GRASS] = [1, 2, 3, 4, 5, 6, 7, 8];
const FILL = { [INK]: '#3E1A10', [FUR]: '#FFFFFE', [PINK]: '#FFCBAE', [SCARF]: '#EC3F29', [TAPE]: '#FE3972', [BOW]: '#790B32', [TWIG]: '#583623', [GRASS]: '#5C842F' };
/** What each class looks like in a picture: the master's twig is #5F3926 and the marker's lighter. @param {string} twig */
const refs = (twig) => ['3E1A10', 'FFFFFE', 'FFCBAE', 'EC3F29', 'FE3972', '790B32', twig, '5C842F'].map(rgb);

const png = async (/** @type {string} */ f) => decodePng(await readFile(join(kit, f)));
/** A kit image on the canvas, scaled by s with its pixel (px, py) at master (mx, my), as classes. */
const placed = async (/** @type {string} */ f, /** @type {number} */ s, /** @type {number[]} */ [px, py], /** @type {number[]} */ [mx, my], twig = '5F3926') =>
  classify(place(await png(f), s, mx + OX - px * s, my + OY - py * s, W, H), refs(twig));

/** Labels kept where the mask is set. @param {import('./raster.mjs').Labels} L @param {import('./raster.mjs').Mask} m */
const cut = (L, m) => ({ ...L, data: L.data.map((l, p) => (m.data[p] ? l : 0)) });
/** @param {import('./raster.mjs').Labels} L @param {number[]} classes */
const is = (L, classes) => where(L, (l) => classes.includes(l));
/** The region of a mask holding a point, in master pixels. @param {import('./raster.mjs').Mask} m @param {number} x @param {number} y */
const seed = (m, x, y) => region(m, x + OX, y + OY);

console.log('reading the master');
const master = classify(place(await png('master/shiori_master.png'), 1, OX, OY, W, H), refs('5F3926'));

// The hairpin: twig, bow and tape, and the twig's dark outline, in a box around it.
const pinBox = polygon(W, H, pts([[1780, 760], [2400, 760], [2400, 1450], [1780, 1450]]));
// The twig, from its three ends (a few edge pixels elsewhere blend to the twig's colour).
const twigClass = is(master, [TWIG]);
const twigFill = union(seed(twigClass, 1890, 940), seed(twigClass, 2100, 870), seed(twigClass, 2130, 1320));
const twigInk = and(and(grow(twigFill, 34), is(master, [INK])), pinBox);
const bowAll = and(is(master, [TAPE, BOW]), pinBox);
const pin = union(twigFill, twigInk, bowAll);

// Her eyes are drawn live (src/ui/avatar.js), so the traced head has fur where they were.
const inkMask = is(master, [INK]);
const eyes = grow(union(fillHoles(seed(inkMask, 1060, 1750)), fillHoles(seed(inkMask, 1820, 1750))), 4);

console.log('filling under the eyes and the hairpin');
const face = inpaint(inpaint(master, eyes, (l) => l === FUR), pin, (l) => l === FUR || l === PINK);

// Head and ears: the white fur joined to her face, with its holes (nose, blush, inner ears) and its outline.
const headFur = seed(is(face, [FUR]), 1440, 1300);
const headAll = fillHoles(headFur);
const bodyLight = minus(is(face, [FUR, SCARF]), headAll);
const dHead = distance(headAll).dist;
const dBody = distance(bodyLight).dist;
const OUTLINE = 80; // a little over the outline's width
const head = union(headAll, where(face, (l, p) => l === INK && (dHead[p] <= OUTLINE || dHead[p] <= dBody[p])));
const bodyOwn = union(bodyLight, where(face, (l, p) => l === INK && (dBody[p] <= OUTLINE || dBody[p] < dHead[p])));

// Ears: everything past a line across each ear's base, from the notch where the ruff starts to the corner where the
// ear meets the top of her head; the line dips under the inner ear's tip. Below the line, a stub of white fur that the
// head covers. src/ui/shiori.css leans each ear about its base line (printed at the end), so the seam never opens.
/** Each ear's base line, from the ruff's notch toward her head, in master pixels. */
const EAR_LINE = { right: [[510, 1315], [1188, 915]], left: [[2362, 1314], [1645, 910]] };
const earPoly = {
  right: polygon(W, H, pts([[0, -OY], [1260, -OY], [1260, 846], [1225, 883], [1165, 945], [900, 1105], [700, 1270], [640, 1300], [545, 1335], [475, 1295], [300, 1240], [0, 1240]])),
  left: polygon(W, H, pts([[2880, -OY], [1600, -OY], [1600, 840], [1638, 878], [1650, 942], [1960, 1100], [2200, 1240], [2270, 1300], [2325, 1333], [2400, 1295], [2580, 1240], [2880, 1240]])),
};
const innerEar = { right: seed(is(face, [PINK]), 760, 760), left: seed(is(face, [PINK]), 2160, 700) };
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

// Body: the master's body where it shows, and the kit's body part under her head and below the master's bottom edge.
// The part is registered at the scarf's knot and set 90 pixels lower, so its scarf stays inside the master's: when
// her head lifts, the neck shows above one outline, not two.
console.log('placing the body part');
const bodyKit = await placed('parts/body.png', 1.94, [443.8, 362.6], [1430, 2478]);
const bodyPart = {
  ...face,
  data: face.data.map((l, p) => {
    if (bodyOwn.data[p]) return l;
    const y = Math.floor(p / W) - OY;
    return head.data[p] || y >= 2878 ? bodyKit.data[p] : 0;
  }),
};

// The hairpin's pieces: the knot sits on top, the tape's tail hangs from it and moves with her voice, and the twig
// and the bow's loop stay put. What the knot and the tail hide of the twig is the twig, carried on straight.
const tapeAll = is(master, [TAPE]);
const knotIn = seed(tapeAll, 2075, 1085);
const loopIn = seed(tapeAll, 2215, 1010);
const tailIn = seed(tapeAll, 2240, 1230);
const knot = and(grow(knotIn, 30), bowAll);
const tail = minus(and(grow(tailIn, 30), bowAll), knot);
const loop = minus(and(grow(loopIn, 30), bowAll), knot);
const stem = polygon(W, H, pts([[2000, 990], [2080, 960], [2190, 1420], [2110, 1440]]));
const twigAll = union(twigFill, twigInk);
const underBow = and(minus(union(knot, tail), twigAll), stem);
const twigSeen = cut(master, minus(twigAll, underBow));
const twig = cut(inpaint(twigSeen, underBow, (l) => l === INK || l === TWIG), union(twigAll, underBow));
const pinBack = { ...twig, data: twig.data.map((l, p) => (loop.data[p] ? master.data[p] : l)) };
const knotPart = cut(master, knot);
// The tail reaches up under the knot, so it can swing without a gap.
const tailPart = { ...master, data: master.data.map((l, p) => (tail.data[p] ? l : knotIn.data[p] ? TAPE : 0)) };

// The parts the master doesn't show, sized by the README: the curled tail about as wide as her shoulders, the
// marker about as tall as her head and ears, the tail's tip leaving past the seat's edge.
console.log('placing the tails and the marker');
const tailSleep = await placed('parts/tail_sleep.png', 1.19, [643, 1180], [1434, 2826]);
const tailTip = await placed('parts/tail_tip.png', 0.8, [702, 575], [3010, 1900]);
const marker = await placed('parts/trail_marker.png', 1.2, [392, 1620], [880, 2640], '734930');

/**
 * A part's layers, back to front: a colour, the classes it covers, and the outline classes it reaches a little way
 * under. Fills go first and lines last, so an edge with no outline (where parts meet) is only ever the fill's own.
 * @typedef {{ id: string, labels: import('./raster.mjs').Labels, layers: [number, number[], number[]?][] }} Part
 */
const fur = /** @type {[number, number[], number[]][]} */ ([[FUR, [FUR, PINK], [INK]], [PINK, [PINK], [INK]], [INK, [INK], []]]);
const bow = /** @type {[number, number[], number[]][]} */ ([[TAPE, [TAPE], [BOW]], [BOW, [BOW], []]]);
/** @type {Part[]} */
const PARTS = [
  { id: 'marker', labels: marker, layers: [[TWIG, [TWIG], [INK, BOW]], [GRASS, [GRASS], [INK, BOW]], [TAPE, [TAPE], [INK, BOW]], [INK, [INK, BOW], []]] },
  { id: 'tail-tip', labels: tailTip, layers: fur },
  { id: 'body', labels: bodyPart, layers: [[FUR, [FUR, SCARF], [INK]], [SCARF, [SCARF], [INK]], [INK, [INK], []]] },
  { id: 'tail-sleep', labels: tailSleep, layers: fur },
  { id: 'ear-right', labels: ears.right, layers: fur },
  { id: 'ear-left', labels: ears.left, layers: fur },
  { id: 'head', labels: headPart, layers: fur },
  { id: 'pin', labels: pinBack, layers: [[TWIG, [TWIG], [INK]], [INK, [INK], []], ...bow] },
  { id: 'tape', labels: tailPart, layers: bow },
  { id: 'knot', labels: knotPart, layers: bow },
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
      if (d) layers.push(`<path fill="${FILL[colour]}" d="${d}"/>`);
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
  let n = 0;
  let sx = 0;
  let sy = 0;
  knotIn.data.forEach((v, p) => { if (v) [n, sx, sy] = [n + 1, sx + (p % W) - OX, sy + Math.floor(p / W) - OY]; });
  console.log(`tape: origin ${u(sx / n)}px ${u(sy / n)}px (the knot)`);
} finally {
  await rm(work, { recursive: true, force: true });
}

/** A few paw prints, for Working (the README: drawn in SVG), in the avatar's colour for them (light or dark). */
function paws() {
  const print = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ turn) =>
    `<g transform="rotate(${turn} ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="24" ry="20"/><circle cx="${x - 24}" cy="${y - 27}" r="9"/><circle cx="${x - 8}" cy="${y - 37}" r="9"/><circle cx="${x + 8}" cy="${y - 37}" r="9"/><circle cx="${x + 24}" cy="${y - 27}" r="9"/></g>`;
  return `<g id="paws" fill="currentColor" opacity=".7">${print(540, 770, 70)}${print(650, 835, 95)}${print(760, 765, 75)}</g>`;
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
      const c = l ? rgb(FILL[l].slice(1)) : [197, 214, 184];
      data.set([...c, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}
