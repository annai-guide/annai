import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startSettled, pickProvider, addProvider } from './helpers.js';

// The screens' side of the user's iPhone findings (2026-10-22).

/** What the dock looks like to the eye: hidden is see-through and lets taps through, but stays in the page and its accessibility tree. @param {import('@playwright/test').Page} page */
const shown = (page) => page.locator('nav.dock').evaluate((el) => getComputedStyle(el).opacity === '1' && getComputedStyle(el).pointerEvents !== 'none');
/** A plain link, a checkbox and a button fixed where the dock is (under it, while it shows). @param {import('@playwright/test').Page} page */
async function underTheDock(page) {
  await page.evaluate(() => {
    const at = (/** @type {HTMLElement} */ el, /** @type {string} */ left) => {
      el.style.cssText = `position: fixed; left: ${left}; bottom: 12px; width: 120px; height: 44px; z-index: 1`;
      document.querySelector('main')?.append(el);
    };
    const link = document.createElement('a');
    link.id = 'under-link';
    link.href = '#under';
    link.textContent = 'A link under the dock';
    link.addEventListener('click', (e) => { e.preventDefault(); link.dataset.clicked = '1'; });
    at(link, '8px');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'under-box';
    at(box, '150px');
    const button = document.createElement('button');
    button.id = 'under-dock';
    button.textContent = 'Under the dock';
    button.addEventListener('click', () => { button.dataset.clicked = '1'; });
    at(button, '230px');
  });
}

test('the dock hides while a field outside it has focus, comes back when focus leaves, and its own box still types', async ({ page }) => {
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  const dock = page.locator('nav.dock');
  await expect(dock).toBeVisible();
  expect(await shown(page)).toBe(true);
  const before = await dock.boundingBox();
  const field = page.getByLabel(/Summarize at/);
  await field.focus();
  await expect.poll(() => shown(page)).toBe(false);
  // Only looked away from: its box stays, so the page doesn't move under the keyboard, and it stays in the accessibility tree,
  // so what it announces (the captions) still comes.
  expect(await dock.boundingBox()).toEqual(before);
  await expect(page.getByRole('navigation', { name: 'Shiori' })).toBeAttached();
  await field.blur();
  await expect.poll(() => shown(page)).toBe(true);
  // The dock's own box: the dock stays while it is typed in.
  await page.getByRole('button', { name: 'Type' }).click();
  const box = page.getByLabel('Message to Shiori');
  await expect(box).toBeFocused();
  await box.fill('hello');
  expect(await shown(page)).toBe(true);
  await expect(box).toHaveValue('hello');
});

test('a button under the dock still takes a click while a field has focus: the dock comes back after the press, not at it', async ({ page }) => {
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  await underTheDock(page);
  await page.getByLabel(/Summarize at/).focus();
  await expect.poll(() => shown(page)).toBe(false);
  await page.locator('#under-dock').click();
  await expect(page.locator('#under-dock')).toHaveAttribute('data-clicked', '1');
  await expect.poll(() => shown(page)).toBe(true);
});

// On a touch screen the events of a tap are pointerup, mousedown (which lets go of the field), mouseup and click: the dock must not
// come back between them, or the tap lands on it (the review of 2026-10-22).
test('a tap on a link, a checkbox or a button under the dock, while a field has focus, lands on it; then the dock is back', async ({ page }) => {
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  await underTheDock(page);
  /** @type {[string, () => Promise<void>][]} */
  const taps = [['#under-link', () => expect(page.locator('#under-link')).toHaveAttribute('data-clicked', '1')],
    ['#under-box', () => expect(page.locator('#under-box')).toBeChecked()],
    ['#under-dock', () => expect(page.locator('#under-dock')).toHaveAttribute('data-clicked', '1')]];
  for (const [id, done] of taps) {
    await page.getByLabel(/Summarize at/).focus();
    await expect.poll(() => shown(page)).toBe(false);
    await page.locator(id).tap();
    await done();
    await expect.poll(() => shown(page)).toBe(true);
  }
});

test('with a press that sends no click, the dock comes back soon after it ends', async ({ page }) => {
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  await page.getByLabel(/Summarize at/).focus();
  await expect.poll(() => shown(page)).toBe(false);
  // A press on bare page: it lets go of the field, and no click names a target that needs the dock to wait (a drag away sends none).
  await page.mouse.move(200, 300);
  await page.mouse.down();
  await page.mouse.move(260, 360);
  await page.mouse.up();
  await expect.poll(() => shown(page), { timeout: 3000 }).toBe(true);
});

// Android's Back hides the keyboard and keeps the focus: the dock follows the keyboard, not the focus (the review of 2026-10-22).
test('the dock comes back when the keyboard goes while the field keeps focus, and hides again when it returns', async ({ page }) => {
  await page.addInitScript(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    Object.defineProperty(vv, 'height', { get: () => /** @type {any} */ (window).fakeVvHeight ?? innerHeight });
  });
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  const resize = (/** @type {number | null} */ h) => page.evaluate((h) => { /** @type {any} */ (window).fakeVvHeight = h ?? undefined; visualViewport?.dispatchEvent(new Event('resize')); }, h);
  await page.getByLabel(/Summarize at/).focus();
  await expect.poll(() => shown(page)).toBe(false);
  await resize(300); // the keyboard comes up
  expect(await shown(page)).toBe(false);
  await resize(null); // the keyboard goes: Back, and the field keeps its focus
  await expect.poll(() => shown(page)).toBe(true);
  await expect(page.getByLabel(/Summarize at/)).toBeFocused();
  await resize(300);
  await expect.poll(() => shown(page)).toBe(false);
});

// A mouse and a hardware keyboard have no keyboard that covers the dock: every click into a field would hide it for nothing.
test('with a mouse (no coarse pointer) the dock stays while a field has focus', async ({ page }) => {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => (q.includes('pointer: coarse') ? real('(pointer: none) and (pointer: fine)') : real(q));
  });
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  await page.getByLabel(/Summarize at/).focus();
  await page.waitForTimeout(300);
  expect(await shown(page)).toBe(true);
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
/** @type {[string, number][]} */
const SERVERS = [['llama.cpp', 9931], ['Ollama', 11434], ['Custom provider', 8080]];
for (const [provider, port] of SERVERS) {
  test(`${provider}'s page says what a phone, https, the tailnet and CORS mean for a server you run, with a Tailscale Serve command for its own port`, async ({ page }) => {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, provider);
    const note = page.locator('[data-note="local-server"]');
    await expect(note).toBeVisible();
    await expect(note).toContainText('On a phone, localhost is the phone itself. A server on another computer needs an https address: annai calls only https addresses on your network, since browsers block plain http from an https page.');
    await expect(note).toContainText(`tailscale serve --bg --https=8443 http://localhost:${port} where the server is, then give annai https://<machine>.<tailnet>.ts.net:8443/v1.`);
    await expect(note).toContainText('with the phone on your tailnet');
    await expect(note).toContainText('The server must also allow CORS from annai.guide. Chrome 142 and later may ask you to allow local network access.');
  });
}

// A warning on a phone only while the address is one that can't work there.
test('the note is a warning on a phone only while the address is http localhost or 127.0.0.1', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'llama.cpp');
  const note = page.locator('[data-note="local-server"]');
  const address = page.getByLabel('Address', { exact: true });
  await expect(address).toHaveValue('http://localhost:9931/v1');
  await expect(note).toHaveClass(/\bwarn\b/);
  await address.fill('http://127.0.0.1:9931/v1');
  await expect(note).toHaveClass(/\bwarn\b/);
  await address.fill('https://llama.example.ts.net:8443/v1');
  await expect(note).not.toHaveClass(/\bwarn\b/);
  await expect(note).toBeVisible();
});

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

// Roles: "if the user click on the model name, they can enter the model settings page"; "instead of the up down button, make it
// possible to drag a model to reorder it" (the user, 2026-10-22).
/** A role entry's handle, by its model's name whatever its place says. @param {import('@playwright/test').Locator} list @param {string} m */
const gripOf = (list, m) => list.getByRole('button', { name: new RegExp(`^Reorder ${m}, \\d of \\d$`) });
/** A main list of three models, a1, a2 and a3. @param {import('@playwright/test').Page} page */
async function threeModels(page) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  for (const m of ['a1', 'a2', 'a3']) {
    await addProvider(page, 'Custom provider', { ability: 'Chat Completions', name: `Endpoint ${m}`, url: `https://${m}.example.test/v1`, key: `sk-test-${m}`, model: m, look: false });
    await page.getByLabel('Add a model to main').selectOption({ label: m });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await expect(page.getByText(new RegExp(`\\d\\. ${m}$`))).toBeVisible();
  }
  const main = page.locator('.role', { has: page.getByRole('heading', { name: 'Main: talks with you' }) });
  const order = () => main.locator('.role-item > span').allTextContents();
  await expect.poll(order).toEqual(['1. a1', '2. a2', '3. a3']);
  return { main, order };
}

test('Roles: a model\'s name links to its page; the up and down buttons are gone', async ({ page }) => {
  const { main } = await threeModels(page);
  await expect(main.getByRole('button', { name: /Move a1 (up|down)/ })).toHaveCount(0);
  await main.getByRole('link', { name: 'a2' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'a2' })).toBeVisible();
  await expect(page.getByLabel('Provider model id')).toHaveValue('a2');
});

test('Roles: the handle takes the arrow keys, and a tap on it offers Move up and Move down', async ({ page }) => {
  const { main, order } = await threeModels(page);
  const grip = (/** @type {string} */ m) => gripOf(main, m);
  await grip('a1').focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(order).toEqual(['1. a2', '2. a1', '3. a3']);
  await expect(grip('a1')).toBeFocused(); // keys go on
  await page.keyboard.press('ArrowDown');
  await expect.poll(order).toEqual(['1. a2', '2. a3', '3. a1']);
  await page.keyboard.press('ArrowUp');
  await expect.poll(order).toEqual(['1. a2', '2. a1', '3. a3']);
  // A menu, for a screen reader and a finger that doesn't drag.
  await grip('a3').click();
  const menu = main.getByRole('group', { name: 'Move a3' });
  await expect(menu.getByRole('button', { name: 'Move down' })).toBeDisabled();
  await menu.getByRole('button', { name: 'Move up' }).click();
  await expect.poll(order).toEqual(['1. a2', '2. a3', '3. a1']);
  await page.reload();
  await expect.poll(order).toEqual(['1. a2', '2. a3', '3. a1']);
});

test('Roles: dragging the handle with a mouse reorders, and the order is kept', async ({ page }) => {
  const { main, order } = await threeModels(page);
  const centre = async (/** @type {import('@playwright/test').Locator} */ l) => { const b = /** @type {any} */ (await l.boundingBox()); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const from = await centre(gripOf(main, 'a1'));
  const to = await centre(gripOf(main, 'a3'));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y + 8, { steps: 4 });
  await gripOf(main, 'a1').evaluate((el) => el.setAttribute('data-seen', ''));
  await page.mouse.up();
  await expect.poll(order).toEqual(['1. a2', '2. a3', '3. a1']);
  // The screen is drawn again once the list is saved (the grip marked before the drop is gone): wait for that before reloading.
  await expect(main.locator('[data-seen]')).toHaveCount(0);
  // A drag opens no menu.
  await expect(main.getByRole('group', { name: /^Move / })).toHaveCount(0);
  await page.reload();
  await expect.poll(order).toEqual(['1. a2', '2. a3', '3. a1']);
});

test('Roles: dragging the handle with a finger reorders, and the page does not scroll under it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch events are sent through the DevTools protocol, Chromium only');
  const { main, order } = await threeModels(page);
  const cdp = await page.context().newCDPSession(page);
  const centre = async (/** @type {import('@playwright/test').Locator} */ l) => { const b = /** @type {any} */ (await l.boundingBox()); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const from = await centre(gripOf(main, 'a3'));
  const to = await centre(gripOf(main, 'a1'));
  const touch = (/** @type {'touchStart' | 'touchMove' | 'touchEnd'} */ type, /** @type {number} */ y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: from.x, y }] });
  const scrolled = await page.evaluate(() => scrollY);
  await touch('touchStart', from.y);
  for (let k = 1; k <= 6; k++) await touch('touchMove', from.y + ((to.y - 6 - from.y) * k) / 6);
  await touch('touchEnd', to.y);
  await expect.poll(order).toEqual(['1. a3', '2. a1', '3. a2']);
  expect(await page.evaluate(() => scrollY)).toBe(scrolled);
});

// The review of 2026-10-22: on a 320 x 544 screen every card had a More, and the wrapped, sticky row of buttons covered a short card's title.
/** Notices of the test's own, under the top bar. @param {import('@playwright/test').Page} page @param {{ title: string, body: string }[]} cards */
async function raise(page, cards) {
  await page.evaluate(async (cards) => {
    const { createNotices } = await import(/** @type {string} */ ('/src/ui/notices.js'));
    const notices = createNotices();
    notices.el.id = 'test-notices';
    document.querySelector('header.topbar')?.after(notices.el);
    for (const c of cards) notices.card({ tone: 'info', ...c });
  }, cards);
}

test('at 320 x 544 a short card has no More and its title shows; the long sign-in card still gets More, beside the text and not in the buttons', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 544 });
  await openApp(page, '#/trips');
  await raise(page, [{ title: 'Signed in with OpenRouter', body: OPENROUTER_CARD }]);
  const long = page.locator('.notice', { hasText: 'Signed in with OpenRouter' });
  await expect(long.getByRole('button', { name: 'More' })).toBeVisible();
  await expect(long.locator('.acts').getByRole('button', { name: 'More' })).toHaveCount(0);
  await long.getByRole('button', { name: 'Dismiss' }).click();
  await raise(page, [{ title: 'Open a trip first', body: 'Photos are kept in a trip. Open one from Trips, then take the photo again.' }]);
  const short = page.locator('.notice', { hasText: 'Open a trip first' });
  await expect(short).toBeVisible();
  await expect(short.getByRole('button', { name: 'More' })).toHaveCount(0);
  // Its title is clear of the buttons that stay at the foot of the box.
  const gap = await short.evaluate((card) => {
    const title = /** @type {HTMLElement} */ (card.querySelector('strong')).getBoundingClientRect();
    const acts = /** @type {HTMLElement} */ (card.querySelector('.acts')).getBoundingClientRect();
    return acts.top - title.bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(0);
});

test('a card is looked at again when the screen turns: More comes and goes with how much of the text fits', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 544 });
  await openApp(page, '#/trips');
  await raise(page, [{ title: 'Heads up', body: 'This card says a little more than a narrow screen can show in its first three lines, but a wide screen holds all of it in three lines, with room to spare at the end.' }]);
  const card = page.locator('.notice', { hasText: 'Heads up' });
  await expect(card.getByRole('button', { name: 'More' })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 544 });
  await expect(card.getByRole('button', { name: 'More' })).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 544 });
  await expect(card.getByRole('button', { name: 'More' })).toBeVisible();
});

test('Roles: the handle says where its model stands, the menu is wired for a screen reader, and a drag closes it', async ({ page }) => {
  const { main } = await threeModels(page);
  await expect(gripOf(main, 'a1')).toHaveAccessibleName('Reorder a1, 1 of 3');
  await expect(gripOf(main, 'a3')).toHaveAccessibleName('Reorder a3, 3 of 3');
  const grip = gripOf(main, 'a2');
  await expect(grip).not.toHaveAttribute('aria-haspopup', /.*/);
  await grip.click();
  await expect(grip).toHaveAttribute('aria-expanded', 'true');
  const menu = main.getByRole('group', { name: 'Move a2' });
  await expect(grip).toHaveAttribute('aria-controls', /.+/);
  expect(await menu.getAttribute('id')).toBe(await grip.getAttribute('aria-controls'));
  // The focus goes into the menu, and Escape gives it back to the handle.
  await expect(menu.getByRole('button', { name: 'Move up' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(grip).toBeFocused();
  await expect(grip).toHaveAttribute('aria-expanded', 'false');
  // A drag that begins with the menu open closes it, and says so.
  await grip.click();
  await expect(grip).toHaveAttribute('aria-expanded', 'true');
  const b = /** @type {any} */ (await grip.boundingBox());
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 12, { steps: 3 });
  await expect(grip).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.up();
});

test('Roles: a drag that is cancelled leaves the list and its numbers as they were', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch events are sent through the DevTools protocol, Chromium only');
  const { main, order } = await threeModels(page);
  const cdp = await page.context().newCDPSession(page);
  const b = /** @type {any} */ (await gripOf(main, 'a1').boundingBox());
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  const touch = (/** @type {'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel'} */ type, /** @type {number} */ at) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y: at }] });
  await touch('touchStart', y);
  for (let k = 1; k <= 4; k++) await touch('touchMove', y + k * 40);
  await expect.poll(order).not.toEqual(['1. a1', '2. a2', '3. a3']); // it was being dragged
  await touch('touchCancel', y + 160);
  await expect.poll(order).toEqual(['1. a1', '2. a2', '3. a3']);
  await expect(gripOf(main, 'a1')).toHaveAccessibleName('Reorder a1, 1 of 3');
});

test('Roles: a touch that moves less than 8 px is a tap, which opens the menu, and does not reorder', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch events are sent through the DevTools protocol, Chromium only');
  const { main, order } = await threeModels(page);
  const cdp = await page.context().newCDPSession(page);
  const b = /** @type {any} */ (await gripOf(main, 'a2').boundingBox());
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  const touch = (/** @type {'touchStart' | 'touchMove' | 'touchEnd'} */ type, /** @type {number} */ at) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: at }] });
  await touch('touchStart', y);
  await touch('touchMove', y + 6); // a finger shakes
  await touch('touchEnd', y + 6);
  await expect(main.getByRole('group', { name: 'Move a2' })).toBeVisible();
  expect(await order()).toEqual(['1. a1', '2. a2', '3. a3']);
});

test("Roles: a speech list's entries link to their model's page too", async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Custom provider', { ability: 'Voice', name: 'A voice', url: 'https://v.example.test/v1', key: 'sk-test-v', model: 'tts-x', look: false });
  await page.getByLabel('Add a model to speech-out').selectOption({ label: 'tts-x' });
  await page.getByRole('button', { name: 'Add to speech-out' }).click();
  const out = page.locator('.role', { has: page.getByRole('heading', { name: "Speech out: Shiori's voice" }) });
  await expect(out.getByRole('link', { name: 'tts-x' })).toBeVisible();
  // The browser voice is a stand-in with no page: plain text.
  await expect(out.getByRole('link', { name: /Browser voice/ })).toHaveCount(0);
  await out.getByRole('link', { name: 'tts-x' }).click();
  await expect(page.getByLabel('Provider model id')).toHaveValue('tts-x');
});
