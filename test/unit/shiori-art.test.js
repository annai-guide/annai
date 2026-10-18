import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tracedPath } from '../../scripts/shiori-art/paths.mjs';

const root = new URL('../../', import.meta.url);

test("Shiori's art is one file the service worker keeps, holding every part her avatar uses", async () => {
  const avatar = await readFile(new URL('src/ui/avatar.js', root), 'utf8');
  const art = /export const ART = '([^']+)'/.exec(avatar)?.[1];
  assert.equal(art, '/assets/shiori.svg');
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  assert.ok((/const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '').includes(`'${art}'`), 'in SHELL, so she shows offline');
  const svg = await readFile(new URL(art.slice(1), root), 'utf8');
  // part('id'), or group('class', 'id'): every part the avatar draws, back to front.
  const ids = [...avatar.matchAll(/(?:part\(|group\('[^']+', )'([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, ['body', 'caps', 'ear-flat-left', 'ear-flat-right', 'ear-left', 'ear-out-left', 'ear-right', 'grass', 'head', 'head-asleep',
    'head-turned', 'knot', 'loop', 'marker', 'marker-knot', 'paws', 'pin', 'tail-asleep', 'tail-tip', 'tape']);
  for (const id of ids) assert.match(svg, new RegExp(`<g id="${id}"[ >]`), id);
});

test('her art is plain shapes: no scripts, styles, links or event handlers', async () => {
  const svg = await readFile(new URL('assets/shiori.svg', root), 'utf8');
  assert.doesNotMatch(svg, /<script|<style|style=|href=|<image|<foreignObject|\son\w+=/i);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[-\d. ]+">/);
});

test("the art tool writes potrace's curves in whole units, relative to rounded points, so rounding never drifts", () => {
  // potrace writes tenths of a pixel, upside down; this square-ish loop is 10 pixels across, starting at (0, 0)
  const potrace = '<g transform="translate(0.000000,30.000000) scale(0.100000,-0.100000)"><path d="M0 300 c33 0 67 0 100 0 l0 -100 c-33 0 -67 0 -100 0 z"/></g>';
  const d = tracedPath(potrace, (x, y) => [x / 3, y / 3]); // 3 pixels to a unit, as for her art
  assert.equal(d, 'M0 0c1 0 2 0 3 0l0 3c-1 0-2 0-3 0z');
  // Steps of 0.47 units round to 0, 1, 1 and back to 0: each step counts from the rounded point before it, so the
  // path still ends where it started, and a step that rounds to nothing is left out.
  const odd = '<g transform="translate(0.000000,30.000000) scale(0.100000,-0.100000)"><path d="M0 300 l14 0 l14 0 l14 0 l-42 0 z"/></g>';
  assert.equal(tracedPath(odd, (x, y) => [x / 3, y / 3]), 'M0 0l1 0-1 0z');
});

test("the pivots the art tool works out are the ones shiori.css and avatar.js move her parts about", async () => {
  const svg = await readFile(new URL('assets/shiori.svg', root), 'utf8');
  const recorded = /<!-- pivots (\{.*\}) -->/.exec(svg)?.[1];
  assert.ok(recorded, 'scripts/shiori-art/build.mjs records them in the art');
  const p = JSON.parse(/** @type {string} */ (recorded));
  const css = await readFile(new URL('src/ui/shiori.css', root), 'utf8');
  const js = await readFile(new URL('src/ui/avatar.js', root), 'utf8');
  const px = (/** @type {number[]} */ [x, y]) => `${x}px ${y}px`;
  const [rx, ry, rTurn] = p['ear-r'];
  const [lx, ly, lTurn] = p['ear-l'];
  assert.match(css, new RegExp(`\\.ear-r \\{ transform-origin: ${px([rx, ry])}; transform: rotate\\(${rTurn}deg\\) .* rotate\\(${-rTurn}deg\\)`));
  assert.match(css, new RegExp(`\\.ear-l \\{ transform-origin: ${px([lx, ly])}; transform: rotate\\(${lTurn}deg\\) .* rotate\\(${-lTurn}deg\\)`));
  assert.match(css, new RegExp(`\\.pin \\{ transform-origin: ${px([lx, ly])};.* rotate\\(${lTurn}deg\\) .* rotate\\(${-lTurn}deg\\)`));
  assert.match(css, new RegExp(`\\.pin \\.streamer \\{ transform-origin: ${px(p.knot)};`));
  assert.match(css, new RegExp(`\\[data-state="sleeping"\\] \\{ --head-x: ${p.dip[0]}px; --head-y: ${p.dip[1]}px; \\}`));
  assert.ok(js.includes(`band([${p.knot.join(', ')}],`), 'the hairpin streamer on the knot');
  assert.ok(js.includes(`band([${p['marker-knot'].join(', ')}],`), "the marker's streamer on its knot");
  assert.ok(js.includes(`${p['tail-tip'].join(' ')})\``), "the tail tip's wag about its cut edge");
});
