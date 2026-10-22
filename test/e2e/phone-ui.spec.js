import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startSettled, pickProvider } from './helpers.js';

// The screens' side of the user's iPhone findings (2026-10-22).

test('the dock hides while a field outside it has focus, comes back when focus leaves, and its own box still types', async ({ page }) => {
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  const dock = page.locator('nav.dock');
  await expect(dock).toBeVisible();
  const before = await dock.boundingBox();
  const field = page.getByLabel(/Summarize at/);
  await field.focus();
  await expect(dock).toBeHidden();
  // Hidden by visibility, not removed: its box stays, so the page doesn't move under the keyboard.
  expect(await dock.boundingBox()).toEqual(before);
  await field.blur();
  await expect(dock).toBeVisible();
  // The dock's own box: the dock stays while it is typed in.
  await page.getByRole('button', { name: 'Type' }).click();
  const box = page.getByLabel('Message to Shiori');
  await expect(box).toBeFocused();
  await box.fill('hello');
  await expect(dock).toBeVisible();
  await expect(box).toHaveValue('hello');
});

test('a button under the dock still takes a click while a field has focus: the dock comes back after the press, not at it', async ({ page }) => {
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  // A button where the dock is (under it, while it shows): pressing it lets go of the field.
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'under-dock';
    b.textContent = 'Under the dock';
    b.style.cssText = 'position: fixed; left: 8px; right: 8px; bottom: 8px; height: 40px; z-index: 1';
    b.addEventListener('click', () => { b.dataset.clicked = '1'; });
    document.querySelector('main')?.append(b);
  });
  await page.getByLabel(/Summarize at/).focus();
  await expect(page.locator('nav.dock')).toBeHidden();
  await page.locator('#under-dock').click();
  await expect(page.locator('#under-dock')).toHaveAttribute('data-clicked', '1');
  await expect(page.locator('nav.dock')).toBeVisible();
});

// "In the add, at model providers, if user type in something returns nothing, maybe we should put the 'another address' there ...
// same for voices and transcription. also maybe call that custom providers?" (the user, 2026-10-22)
for (const [filter, link, region] of [
  ['model providers', 'Add a provider', 'Model providers'],
  ['transcription', 'Add a provider for speech-in', 'Voices and transcription'],
  ['voice', 'Add a provider for speech-out', 'Voices and transcription'],
]) {
  test(`Add on ${filter}: a search that finds nothing offers Custom provider, by its address`, async ({ page }) => {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await startSettled(page);
    await page.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add' })).toBeVisible();
    await expect(page.getByRole('region', { name: region })).toBeVisible();
    const found = page.locator('.found');
    await page.getByLabel('Search the catalog').fill('zzqx');
    await expect(found.getByText('Not listed? Add it by its address.')).toBeVisible();
    await expect(found.locator('.card')).toHaveCount(1);
    await expect(found.locator('.card .name')).toHaveText('Custom provider');
    await expect(found.getByRole('button', { name: 'Add Custom provider' })).toBeVisible();
    // A search that finds something shows what it found, with no offer.
    await page.getByLabel('Search the catalog').fill('openai');
    await expect(found.getByText('Not listed?')).toHaveCount(0);
    await expect(found.getByRole('button', { name: 'Add OpenAI', exact: true })).toBeVisible();
  });
}

test('Add: nothing found among tools offers no Custom provider; and "custom" finds it by name', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await startSettled(page);
  await page.goto('/#/plugins');
  await page.getByRole('link', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Tools and MCP', exact: true }).click();
  await page.getByLabel('Search the catalog').fill('zzqx');
  await expect(page.getByText('Nothing here matches. Try other words, or take a chip off.')).toBeVisible();
  await expect(page.getByText('Not listed?')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tools and MCP', exact: true }).click();
  await page.getByLabel('Search the catalog').fill('custom');
  await expect(page.locator('.found .card .name')).toHaveText('Custom provider');
});

// "for local llama.cpp etc, the default address is http://localhost:… we require https to work right? ... maybe put a note somewhere
// explaining this? and suggest maybe look into tailscale serve?" (the user, 2026-10-22)
for (const provider of ['llama.cpp', 'Ollama', 'Custom provider']) {
  test(`${provider}'s page says what a phone, https and CORS mean for a server you run, with a tailscale serve example`, async ({ page }) => {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, provider);
    const note = page.getByText(/On a phone, localhost is the phone itself\./);
    await expect(note).toBeVisible();
    await expect(note).toContainText('needs an https address, because browsers won\'t let an https page call plain http on the network');
    await expect(note).toContainText('tailscale serve --https=8443 http://localhost:8080');
    await expect(note).toContainText('The server must also allow CORS from annai.guide.');
  });
}

// "The OpenRouter sign-in card is cut off": its body stopped mid-sentence inside the box of a quarter of the screen (the user, 2026-10-22).
const OPENROUTER_CARD = "Shiori thinks with free models to start, so trying annai costs nothing. annai also added OpenRouter's transcription and voices, behind the phone's own dictation and the browser voice. Its free voice comes first: each sentence it says uses one of the free requests a day the chat models use too. The others cost a little, from credits you buy at OpenRouter. To use them first, move them up under Roles.";

test("a card whose text is longer than the box gets More, which opens it to its full height and Less closes; Dismiss stays in view (390 x 844)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, '#/trips');
  await page.evaluate(async (body) => {
    const { createNotices } = await import(/** @type {string} */ ('/src/ui/notices.js'));
    const notices = createNotices();
    notices.el.id = 'test-notices';
    document.querySelector('header.topbar')?.after(notices.el);
    notices.card({ tone: 'ok', title: 'Signed in with OpenRouter', body });
    notices.card({ tone: 'info', title: 'A short card', body: 'Nothing to expand here.' });
  }, OPENROUTER_CARD);
  const box = page.locator('#test-notices');
  const card = page.locator('.notice', { hasText: 'Signed in with OpenRouter' });
  const more = card.getByRole('button', { name: 'More' });
  await expect(more).toBeVisible();
  // The short card has no More; the box stays within a quarter of the screen.
  await expect(page.locator('.notice', { hasText: 'A short card' }).getByRole('button', { name: 'More' })).toHaveCount(0);
  const cap = 844 * 0.25;
  expect((await box.boundingBox())?.height ?? 0).toBeLessThanOrEqual(cap + 1);
  await expect(card.getByRole('button', { name: 'Dismiss' })).toBeInViewport();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  // Closed, the text stops short of its end; open, all of it shows, and so does Dismiss.
  const shown = () => card.locator('p').evaluate((p) => p.scrollHeight - p.clientHeight);
  expect(await shown()).toBeGreaterThan(0);
  await more.click();
  await expect(card.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true');
  expect(await shown()).toBeLessThanOrEqual(1);
  await expect(card.locator('p')).toContainText('move them up under Roles.');
  await expect(card.getByRole('button', { name: 'Dismiss' })).toBeInViewport();
  expect((await box.boundingBox())?.height ?? 0).toBeGreaterThan(cap);
  await card.getByRole('button', { name: 'Less' }).click();
  expect(await shown()).toBeGreaterThan(0);
  expect((await box.boundingBox())?.height ?? 0).toBeLessThanOrEqual(cap + 1);
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toHaveCount(0);
});

// "The caption box looks exactly like the input box (when the input box is not focused), so maybe make some distinction?" (the user, 2026-10-22)
for (const scheme of ['light', 'dark']) {
  test(`the Captions chip opens a caption box that looks nothing like the text box, in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: /** @type {'light' | 'dark'} */ (scheme) });
    await page.addInitScript(() => {
      if (typeof MediaDevices !== 'undefined') MediaDevices.prototype.enumerateDevices = async () => /** @type {any} */ ([{ kind: 'audioinput', label: 'AirPods Pro', deviceId: '1', groupId: '1' }]);
    });
    await openApp(page, '#/trips');
    await expect(page.locator('.voice-chip')).toHaveText('Voice on · headphones');
    // The chip is Captions, and is off the dock's words "Show what she's saying".
    const chip = page.getByRole('button', { name: 'Captions', exact: true });
    await expect(page.getByRole('button', { name: "Show what she's saying" })).toHaveCount(0);
    await chip.click();
    const caption = page.locator('.dock .caption');
    await expect(caption).toBeVisible();
    await page.getByRole('button', { name: 'Type' }).click();
    const box = page.getByLabel('Message to Shiori');
    await expect(box).toBeVisible();
    await page.locator('main').click({ position: { x: 5, y: 5 }, force: true }); // the box is not focused
    const look = (/** @type {import('@playwright/test').Locator} */ l) => l.evaluate((el) => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderLeftWidth} ${s.borderLeftColor}`, style: s.fontStyle };
    });
    const a = await look(caption);
    const b = await look(box);
    expect(a.background).not.toBe(b.background);
    expect(a.border).not.toBe(b.border);
    expect(a.style).toBe('italic');
    expect(b.style).toBe('normal');
    // Its tail: the bubble points at her.
    expect(await caption.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('""');
  });
}
