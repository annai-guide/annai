// Renders the PNG app icons from assets/shiori.svg with Playwright's Chromium (dev-only tool).
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const svg = await readFile(new URL('../assets/shiori.svg', import.meta.url), 'utf8');
const out = new URL('../assets/icons/', import.meta.url);
await mkdir(out, { recursive: true });
const targets = [
  { file: 'icon-192.png', size: 192, pad: 0.08 },
  { file: 'icon-512.png', size: 512, pad: 0.08 },
  { file: 'apple-touch-icon.png', size: 180, pad: 0.08 },
  { file: 'icon-maskable-512.png', size: 512, pad: 0.2 },
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
  const inner = Math.round(t.size * (1 - 2 * t.pad));
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${t.size}px;height:${t.size}px;display:grid;place-items:center;background:#fbe5e1"><div style="width:${inner}px;height:${inner}px">${svg}</div></body></html>`);
  await writeFile(new URL(t.file, out), await page.screenshot({ type: 'png' }));
}
await browser.close();
console.log('icons written to assets/icons/');
