import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, startOpenRouterFiles, pickProvider, savedBy, leaveSaved } from './helpers.js';

// OpenRouter's photo uploads on annai's pages (spec §4.8, §4.9): the switch is on OpenRouter's page alone; annai deletes its own uploads
// from OpenRouter's list on coming online and once a day while it is open, all of them when the switch goes off, and, as the ability's
// address changes, at the old address with the old key. OpenRouter's Files API is stood in for by servers of their own, which the provider's
// address names (both browsers reach them), so nothing here reaches the real openrouter.ai.

const KEY = 'sk-or-test-uploads-123';
const HOUR = 3_600_000;
const ago = (/** @type {number} */ hours) => new Date(Date.now() - hours * HOUR).toISOString();
const SWITCH = /^Upload photos to this provider \(annai deletes each once it is 48 hours old/;

test("OpenRouter's page has the photo-uploads switch and another Chat Completions page has none; annai deletes its uploads from OpenRouter's list on coming online, once a day, all when the switch goes off, and at the old address with the old key when the ability's address changes", async ({ page }) => {
  // Files at OpenRouter: annai's, of two ages (a third, over 48 hours old, comes later), and someone else's.
  const old = await startOpenRouterFiles([
    { filename: 'annai-2222222222222222.webp', created_at: ago(30) },
    { filename: 'annai-3333333333333333.jpg', created_at: ago(1) },
    { filename: 'their-notes.pdf', created_at: ago(500) },
  ]);
  const next = await startOpenRouterFiles([]);
  const groq = await startModelServer({});
  try {
    // The page's clock runs on, and a day can be added to it.
    await page.clock.install({ time: Date.now() });
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, 'OpenRouter');
    await page.getByLabel('Address', { exact: true }).fill(`${old.origin}/api/v1`);
    await page.getByLabel('API key').fill(KEY);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);

    // Another provider on the same protocol: its page has no such switch (OpenRouter's description alone turns uploads on).
    await page.getByRole('link', { name: 'Models', exact: true }).click();
    await pickProvider(page, 'Groq');
    await page.getByLabel('Address', { exact: true }).fill(`${groq.origin}/openai/v1`);
    await page.getByLabel('API key').fill('gsk-test-uploads');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    await expect(page.getByRole('region', { name: 'Chat', exact: true })).toBeVisible();
    await expect(page.getByLabel(/^Upload photos to this provider/)).toHaveCount(0);

    // OpenRouter's: on, with its words.
    await page.getByRole('link', { name: 'Models', exact: true }).click();
    await page.getByRole('link', { name: /^OpenRouter/ }).click();
    const chat = page.getByRole('region', { name: 'Chat', exact: true });
    const uploads = chat.getByLabel(SWITCH);
    await expect(uploads).toBeChecked();
    await expect(chat.getByText(/^Photos are stored in your OpenRouter workspace's files until annai deletes them/)).toBeVisible();
    // The key just saved read the list once, with it (a new key's sweep, which says whether uploads can come on); no start, no coming online since.
    expect(old.requests.filter((r) => r.method === 'GET')).toHaveLength(1);
    expect(old.names()).toHaveLength(3);

    // Coming online: the list is read, and what is over 48 hours old goes; younger files and the other app's stay.
    old.held.push({ id: 'or_file_e2e_over', filename: 'annai-1111111111111111.webp', created_at: ago(50), mime_type: 'image/webp', size_bytes: 1 });
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await expect.poll(() => old.names()).toEqual(['annai-2222222222222222.webp', 'annai-3333333333333333.jpg', 'their-notes.pdf']);
    expect(old.requests.every((r) => r.headers.authorization === `Bearer ${KEY}`)).toBe(true);

    // A day later, with the page still open: the next sweep. The 30-hour-old file is 54 hours old now; the one made an hour ago is 25.
    await page.clock.fastForward('24:00:00');
    await expect.poll(() => old.names()).toEqual(['annai-3333333333333333.jpg', 'their-notes.pdf']);

    // The switch off: all of annai's go, whatever their age; the other app's file stays.
    await uploads.uncheck();
    await expect(savedBy(uploads)).toHaveText('Saved');
    await expect.poll(() => old.names()).toEqual(['their-notes.pdf']);

    // On again, and a new address for the ability: what annai has at the old one is deleted first, with the old key.
    await uploads.check();
    await expect(savedBy(uploads)).toHaveText('Saved');
    old.held.push({ id: 'or_file_e2e_late', filename: 'annai-4444444444444444.webp', created_at: ago(1), mime_type: 'image/webp', size_bytes: 1 });
    const asked = old.requests.length;
    const address = chat.getByLabel('Its own address');
    await address.fill(`${next.origin}/api/v1`);
    await leaveSaved(address);
    expect(old.names()).toEqual(['their-notes.pdf']);
    const after = old.requests.slice(asked);
    expect(after.filter((r) => r.method === 'DELETE')).toHaveLength(1);
    expect(after.every((r) => r.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(next.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Chat', exact: true }).getByLabel('Its own address')).toHaveValue(`${next.origin}/api/v1`);
    expect(await page.content()).not.toContain(KEY);
  } finally {
    await old.stop();
    await next.stop();
    await groq.stop();
  }
});
