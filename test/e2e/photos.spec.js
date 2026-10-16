import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, buildAndSave } from './helpers.js';
import { readZip } from '../../src/core/zip.js';
import { readPhotoMeta } from '../../src/core/photo-meta.js';
import { text } from '../../src/core/bytes.js';

/** A fixture photo, ready for setInputFiles. @param {string} name */
async function photo(name) {
  const mimeType = { heic: 'image/heic', png: 'image/png', webp: 'image/webp' }[/** @type {string} */ (name.split('.').pop())] ?? 'image/jpeg';
  return { name, mimeType, buffer: await readFile(new URL(`../fixtures/photos/${name}`, import.meta.url)) };
}

/** @param {import('@playwright/test').Page} page @param {string} title */
async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('several photos and files are added at once', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles([
    await photo('upright.jpg'), await photo('screenshot.png'), { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Nepenthe at 7') },
  ]);
  await expect(page.getByText('Added 3 files')).toBeVisible();
  await expect(page.getByRole('link', { name: /\/files\/2026-11-26-1230\.(webp|jpg)/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /\/files\/screenshot\.(webp|jpg)/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /\/files\/notes\.txt/ })).toBeVisible();
});

test("a HEIC photo this browser can't read is kept as it is, with a note", async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles(await photo('portrait.heic'));
  await expect(page.getByText('A photo was kept as it is')).toBeVisible();
  await expect(page.getByRole('link', { name: /\/files\/2026-11-26-1904\.heic/ })).toBeVisible();
});

/** The extension photos get in this browser: webp where it can write WebP, otherwise jpg. @param {import('@playwright/test').Page} page */
function savedAs(page) {
  return page.evaluate(async () => {
    const c = new OffscreenCanvas(1, 1);
    c.getContext('2d')?.fillRect(0, 0, 1, 1);
    return (await c.convertToBlob({ type: 'image/webp' })).type === 'image/webp' ? 'webp' : 'jpg';
  });
}

/** The colours at the top and the bottom of a shown photo: R, B or ?. @param {import('@playwright/test').Locator} img */
function topAndBottom(img) {
  return img.evaluate(async (/** @type {HTMLImageElement} */ el) => {
    await el.decode();
    const c = new OffscreenCanvas(el.naturalWidth, el.naturalHeight);
    const g = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
    g.drawImage(el, 0, 0);
    const at = (/** @type {number} */ y) => { const [r, , b] = g.getImageData(el.naturalWidth / 2, y, 1, 1).data; return r > 128 ? 'R' : b > 128 ? 'B' : '?'; };
    return [at(3), at(el.naturalHeight - 4)];
  });
}

test('a sideways photo is added upright and named by when it was taken, with when and where', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const ext = await savedAs(page);
  await page.getByLabel('Add photos or files').setInputFiles(await photo('portrait.jpg'));
  await page.getByRole('link', { name: new RegExp(`/files/2026-11-26-1904\\.${ext}`) }).click();
  const img = page.getByRole('img', { name: `/files/2026-11-26-1904.${ext}` });
  await expect(img).toBeVisible();
  expect(await topAndBottom(img)).toEqual(['R', 'B']);
  await expect(page.locator('figcaption')).toContainText('48 × 64');
  await expect(page.locator('figcaption')).toContainText(/Taken .*2026/);
  await expect(page.getByRole('link', { name: 'Where it was taken' })).toHaveAttribute('href', /mlat=36\.2219&mlon=-121\.7598/);
});

test('a 12-megapixel photo keeps its full size', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const bytes = await page.evaluate(async () => {
    const c = new OffscreenCanvas(4032, 3024);
    const g = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
    const sky = g.createLinearGradient(0, 0, 4032, 3024);
    sky.addColorStop(0, '#0a7');
    sky.addColorStop(1, '#a50');
    g.fillStyle = sky;
    g.fillRect(0, 0, 4032, 3024);
    return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer())];
  });
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'IMG_0001.JPG', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) });
  await page.getByRole('link', { name: /\/files\/IMG_0001\.(webp|jpg)/ }).click();
  await expect(page.locator('figcaption')).toContainText('4032 × 3024');
});

test('a photo opens full size, zooms, and closes', async ({ page, browserName }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles(await photo('portrait.jpg'));
  await page.getByRole('link', { name: /\/files\/2026-11-26-1904/ }).click();
  const open = page.getByRole('button', { name: 'Open the photo full size' });
  await open.click();
  const viewer = page.getByRole('dialog', { name: /^Photo / });
  await expect(viewer).toHaveAttribute('data-zoom', '1');
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await viewer.boundingBox());
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.dblclick(cx, cy); // double-tap zooms in
  await expect(viewer).toHaveAttribute('data-zoom', '2.5');
  await page.mouse.dblclick(cx, cy); // and back out
  await expect(viewer).toHaveAttribute('data-zoom', '1');
  if (browserName === 'chromium') { // Playwright's mobile WebKit has no mouse wheel
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => Number(await viewer.getAttribute('data-zoom'))).toBeGreaterThan(1.2);
  }
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("a photo this browser can't show says so, with what is known about it", async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles(await photo('portrait.heic'));
  await page.getByRole('link', { name: /\/files\/2026-11-26-1904\.heic/ }).click();
  await expect(page.getByText("This browser can't show this photo.")).toBeVisible();
  await expect(page.locator('figcaption')).toContainText('Stored as taken');
});

test('Keep originals stores photos as taken, and JPEG can be chosen over WebP', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const trip = page.url();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Keep originals: store photos exactly as taken').check();
  await page.getByRole('button', { name: 'Save photo settings' }).click();
  await expect(page.getByText('Photo settings saved')).toBeVisible();
  await page.goto(trip);
  await page.getByLabel('Add photos or files').setInputFiles(await photo('portrait.jpg'));
  await page.getByRole('link', { name: /\/files\/2026-11-26-1904\.jpg/ }).click();
  await expect(page.locator('figcaption')).toContainText('Stored as taken');

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Keep originals: store photos exactly as taken').uncheck();
  await page.getByLabel('Save photos as').selectOption('jpeg');
  await page.getByRole('button', { name: 'Save photo settings' }).click();
  await expect(page.getByText('Photo settings saved').last()).toBeVisible();
  await page.goto(trip);
  await page.getByLabel('Add photos or files').setInputFiles(await photo('screenshot.png'));
  await expect(page.getByRole('link', { name: /\/files\/screenshot\.jpg/ })).toBeVisible();
});

test('a Share can leave out where photos were taken', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles(await photo('portrait.jpg'));
  await expect(page.getByRole('link', { name: /\/files\/2026-11-26-1904/ })).toBeVisible();
  await page.getByRole('button', { name: 'Export trip' }).click();
  const places = page.getByLabel('Include where photos were taken');
  await expect(places).toBeHidden(); // a Backup keeps everything
  await page.getByLabel('Share: plan, bookings, files and notes').check();
  await expect(places).toBeChecked();
  await places.uncheck();
  const entries = await readZip(new Uint8Array(await readFile(await buildAndSave(page))));
  const manifest = JSON.parse(text(/** @type {Uint8Array} */ (entries.get('annai-archive.json'))));
  const shot = manifest.files.find((/** @type {any} */ f) => f.path.startsWith('/files/2026-11-26-1904'));
  expect(shot.meta.taken).toBe('2026-11-26T19:04:12-08:00');
  expect(shot.meta.place).toBeUndefined();
  expect(readPhotoMeta(/** @type {Uint8Array} */ (entries.get(shot.name))).place).toBeUndefined();
});

test('photos shared from another app go to the trip you choose', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  await startTrip(page, 'Big Sur');
  const shared = [await photo('portrait.jpg'), await photo('screenshot.png')].map((p) => ({ name: p.name, type: p.mimeType, bytes: [...p.buffer] }));
  await page.evaluate(async (files) => {
    const form = new FormData();
    for (const f of files) form.append('files', new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
  }, shared);
  await page.goto('/#/import?inbox=1');
  await expect(page.getByRole('heading', { name: 'Add 2 photos' })).toBeVisible();
  await page.getByRole('button', { name: 'Add to Big Sur' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
  await expect(page.getByRole('link', { name: /\/files\/2026-11-26-1904/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /\/files\/screenshot/ })).toBeVisible();
});

test('Back closes the full-size photo and stays on its page', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles(await photo('portrait.jpg'));
  await page.getByRole('link', { name: /\/files\/2026-11-26-1904/ }).click();
  await page.getByRole('button', { name: 'Open the photo full size' }).click();
  const viewer = page.getByRole('dialog', { name: /^Photo / });
  await expect(viewer).toBeVisible();
  await page.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open the photo full size' })).toBeVisible();
});

test('only the latest share waits, and its photos are shown before they are added', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  await startTrip(page, 'Big Sur');
  /** Posts to the share target, as Android's share sheet (or any other site) can. @param {string[]} names */
  const share = async (names) => {
    const files = await Promise.all(names.map(async (n) => { const p = await photo(n); return { name: p.name, type: p.mimeType, bytes: [...p.buffer] }; }));
    await page.evaluate(async (files) => {
      const form = new FormData();
      for (const f of files) form.append('files', new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
      await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
    }, files);
  };
  await share(['portrait.jpg']); // left waiting, or planted by another site
  await share(['screenshot.png']);
  await page.goto('/#/import?inbox=1');
  await expect(page.getByRole('heading', { name: 'Add 1 photo' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'screenshot.png' })).toBeVisible();
});
