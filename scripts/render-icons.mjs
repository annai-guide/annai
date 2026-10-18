// Renders Android's maskable icon from the user's app icon (a dev-time tool, with Playwright's Chromium and Docker):
//   node scripts/render-icons.mjs <the icon's head on a transparent background, a PNG>
// Her head goes on a flat vermilion square, the icon's own, sized so all of it, her ears too, is inside the middle
// circle (80% across) that Android keeps whatever the mask. The other icons in assets/icons/ are the user's own files.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodePng } from './shiori-art/png.mjs';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/render-icons.mjs <icon head PNG>');
  process.exit(2);
}
const VERMILION = '#ed6849'; // sampled from the icon's seat
const SIZE = 512;
const SAFE = 0.4 * SIZE * 0.96; // the safe circle's radius, less a little room

const png = await readFile(src);
const { width, height, data } = decodePng(png);
const solid = (/** @type {number} */ x, /** @type {number} */ y) => x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3] >= 128;
/** Her outline: solid pixels next to clear ones. */
const edge = [];
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) if (solid(x, y) && !(solid(x - 1, y) && solid(x + 1, y) && solid(x, y - 1) && solid(x, y + 1))) edge.push([x, y]);
}
/** The farthest edge pixel from (cx, cy). @param {number} cx @param {number} cy */
const reach = (cx, cy) => Math.max(...edge.map(([x, y]) => Math.hypot(x - cx, y - cy)));
// The centre of the smallest circle around her, found on a coarse grid and then a fine one.
let best = { cx: width / 2, cy: height / 2, r: reach(width / 2, height / 2) };
for (const step of [32, 4, 1]) {
  const around = best;
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      const r = reach(around.cx + dx * step, around.cy + dy * step);
      if (r < best.r) best = { cx: around.cx + dx * step, cy: around.cy + dy * step, r };
    }
  }
}
const scale = SAFE / best.r;
const browser = await chromium.launch();
const page = await browser.newPage();
const url = await page.evaluate(async ({ b64, size, colour, scale, cx, cy }) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  g.fillStyle = colour;
  g.fillRect(0, 0, size, size);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, size / 2 - cx * scale, size / 2 - cy * scale, img.width * scale, img.height * scale);
  return canvas.toDataURL('image/png');
}, { b64: png.toString('base64'), size: SIZE, colour: VERMILION, scale, cx: best.cx, cy: best.cy });
await browser.close();
const icons = new URL('../assets/icons/', import.meta.url);
await writeFile(new URL('icon-maskable-512.png', icons), Buffer.from(url.split(',')[1], 'base64'));
// Made smaller without changing a pixel (oxipng, lossless, in Docker), as the other icons are.
execFileSync('docker', ['run', '--rm', '-v', `${fileURLToPath(icons)}:/t`, 'alpine:3.20', 'sh', '-c',
  'apk add --no-cache oxipng >/dev/null && oxipng -o max --strip safe /t/icon-maskable-512.png'], { stdio: 'inherit' });
console.log(`assets/icons/icon-maskable-512.png: her head within ${(best.r * scale / SIZE * 200).toFixed(1)}% of the icon across (safe: 80%)`);
