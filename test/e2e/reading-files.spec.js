// Reading files (the bookings design, goals 11 and 12): a PDF read by a model that sees photos but reads no PDFs, through the official
// PDF pages plugin, and the note naming the setting when nothing here can read it.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startModelServer, anthropicToolReply, modelSetUp, savedBy, openTalk } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const pdf = async (/** @type {string} */ name) => ({ name, mimeType: 'application/pdf', buffer: await readFile(new URL(`../fixtures/pdf/${name}`, import.meta.url)) });
const booking = () => pdf('booking.pdf');

/** The stand-in model sees photos and reads no PDFs, set on its page (not left to a provider's defaults). @param {import('@playwright/test').Page} page */
async function seesPhotosReadsNoPdfs(page) {
  await page.goto('/#/models');
  await page.getByRole('region', { name: 'Providers' }).getByRole('link', { name: /Stand-in/ }).click();
  await page.getByRole('link', { name: /^b-model/ }).click();
  await expect(page.getByLabel('Provider model id')).toHaveValue('b-model');
  await page.getByLabel('Takes photos').check();
  await expect(savedBy(page.getByLabel('Takes photos'))).toHaveText('Saved');
  if (await page.getByLabel('Takes PDFs').isChecked()) {
    await page.getByLabel('Takes PDFs').uncheck();
    await expect(savedBy(page.getByLabel('Takes PDFs'))).toHaveText('Saved');
  }
}

/** The stand-in reads the PDF it is told was added, then says when the flight leaves. */
const replies = (name = 'booking.pdf') => [
  sse(anthropicToolReply([{ name: 'read', input: { path: `/trip/files/${name}` } }])),
  sse(anthropicToolReply([{ name: 'speak', input: { text: 'Your flight leaves at 8:05.' } }, { name: 'sleep', input: {} }])),
];

test("installed from the catalog, PDF pages shows a PDF's pages to a model that sees photos but reads no PDFs", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': replies() });
  try {
    await modelSetUp(page, llm.origin);
    const trip = page.url();
    await seesPhotosReadsNoPdfs(page);
    await page.goto('/#/add');
    await page.getByRole('button', { name: 'Install PDF pages' }).click();
    await expect(page.getByText('Installed PDF pages.')).toBeVisible();
    await page.goto(trip);
    await page.getByLabel('Add photos or files').setInputFiles(await booking());
    await expect.poll(() => llm.bodies('/b/v1/messages').length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await openTalk(page);
    await expect(page.getByRole('list').getByText('Your flight leaves at 8:05.')).toBeVisible({ timeout: 30_000 });
    const second = JSON.stringify(llm.bodies('/b/v1/messages')[1].messages.at(-1));
    expect(second.match(/"type":"image"/g) ?? []).toHaveLength(3); // the pages, wherever Anthropic Messages puts a tool's pictures
    expect(second).not.toContain('"type":"document"');
    expect(second).toContain('pages 1–3 of 3');
  } finally {
    await llm.stop();
  }
});

test("a page of small print over a photo's 256 KiB goes to the model as a copy under it, as a photo's does (pdf-pages-cap-next)", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': replies('fine-print.pdf') });
  try {
    await modelSetUp(page, llm.origin);
    const trip = page.url();
    await seesPhotosReadsNoPdfs(page);
    await page.goto('/#/add');
    await page.getByRole('button', { name: 'Install PDF pages' }).click();
    await expect(page.getByText('Installed PDF pages.')).toBeVisible();
    await page.goto(trip);
    await page.getByLabel('Add photos or files').setInputFiles(await pdf('fine-print.pdf'));
    await expect.poll(() => llm.bodies('/b/v1/messages').length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    const second = JSON.stringify(llm.bodies('/b/v1/messages')[1].messages.at(-1));
    expect(second).toContain('page 1 of 1');
    const images = [...second.matchAll(/"source":\{"type":"base64","media_type":"(image\/[a-z]+)","data":"([^"]+)"/g)];
    expect(images).toHaveLength(1);
    const bytes = Buffer.from(images[0][2], 'base64');
    // Drawn at 1600 px as JPEG, the page is about 480 KB in both engines (2026-11-25); its copy, the photo encoder's, is under the cap, and WebP in
    // both test engines (a page sent as drawn would be its JPEG, so this tells a copy from a page that happened to fit).
    expect(images[0][1]).toBe('image/webp');
    expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
  } finally {
    await llm.stop();
  }
});

test('with nothing here that reads it, Shiori is told which setting fixes it, and nothing fails', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': replies() });
  try {
    await modelSetUp(page, llm.origin);
    const trip = page.url();
    await seesPhotosReadsNoPdfs(page);
    await page.goto(trip);
    await page.getByLabel('Add photos or files').setInputFiles(await booking());
    await expect.poll(() => llm.bodies('/b/v1/messages').length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await openTalk(page);
    await expect(page.getByRole('list').getByText('Your flight leaves at 8:05.')).toBeVisible({ timeout: 30_000 });
    const second = JSON.stringify(llm.bodies('/b/v1/messages')[1].messages.at(-1));
    expect(second).toContain('Takes PDFs on its page in Settings → Models');
    expect(second).toContain('PDF pages plugin');
    expect(second).not.toContain('"type":"document"');
    await expect(page.getByText("Shiori can't reach her model")).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});
