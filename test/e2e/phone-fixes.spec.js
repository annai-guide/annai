import { test, expect } from '@playwright/test';
import { openApp, startTrip, writeRecords, writeEvent } from './helpers.js';

// The screens' side of the user's iPhone findings (2026-10-28, phone-fixes-1).

test("a backtick, an acute or a diaeresis on its own takes its own room: the Zen faces' marks don't sit on the next letter (item 7)", async ({ page }) => {
  await openApp(page);
  const widths = await page.evaluate(async () => {
    await document.fonts.load('400 16px "Zen Kaku Gothic New"', 'a`');
    await document.fonts.load('700 16px "Zen Maru Gothic"', 'a`');
    const width = (/** @type {string} */ font, /** @type {string} */ text) => {
      const s = document.createElement('span');
      s.style.cssText = `font: ${font}; white-space: pre; position: absolute`;
      s.textContent = text;
      document.body.append(s);
      const w = s.getBoundingClientRect().width;
      s.remove();
      return w;
    };
    return ['400 16px "Zen Kaku Gothic New"', '700 16px "Zen Maru Gothic"'].map((f) => ['`', '´', '¨', '¸', 'ˆ', '˚', '˜'].map((c) => width(f, `${c}signature${c}`) - width(f, 'signature')));
  });
  for (const row of widths) for (const extra of row) expect(extra).toBeGreaterThan(4);
});

// "The top box for update looks bit cut off and not very clear that is supposed to be a seperate box" (IMG_3013).
const OFFER = 'New versions: Gemini API 0.9.0 → 0.10.1, Custom provider 2.1.4 → 2.2.1, OpenRouter 2.2.0 → 2.3.1, Remote trace (for developers) 0.1.2 → 0.2.1, and Anthropic 1.1.0 → 1.2.0. Nothing changes until you update. An updated plugin that is running now is off until annai restarts.';

for (const [width, height] of [[420, 912], [390, 844], [320, 544]]) {
  test(`a card is whole at ${width} x ${height}: all four edges in the box, a line under the cards, and More lined up with the words (item 3)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openApp(page, '#/trips');
    await page.evaluate(async (body) => {
      const { createNotices } = await import(/** @type {string} */ ('/src/ui/notices.js'));
      const notices = createNotices();
      notices.el.id = 'test-notices';
      document.querySelector('header.topbar')?.after(notices.el);
      notices.card({ title: 'Plugin updates are ready', body, actions: [{ label: 'Update', primary: true, run: () => {} }] });
    }, OFFER);
    const card = page.locator('.notice', { hasText: 'Plugin updates are ready' });
    await expect(card.getByRole('button', { name: 'More' })).toBeVisible();
    const m = await page.locator('#test-notices').evaluate((box) => {
      const r = (/** @type {Element | null} */ el) => /** @type {Element} */ (el).getBoundingClientRect();
      const card = /** @type {HTMLElement} */ (box.querySelector('.notice'));
      const words = document.createRange();
      words.selectNodeContents(/** @type {Element} */ (card.querySelector('.more')));
      return {
        box: r(box), card: r(card), scrolled: box.scrollHeight - box.clientHeight, line: getComputedStyle(box).borderBottomWidth,
        text: r(card.querySelector('p')).left, more: words.getBoundingClientRect().left, update: r(card.querySelector('.acts .pri')).left,
      };
    });
    expect(m.scrolled, 'the box needs no scrolling to show the card').toBeLessThanOrEqual(0);
    expect(m.card.bottom).toBeLessThanOrEqual(m.box.bottom);
    expect(m.card.top).toBeGreaterThanOrEqual(m.box.top);
    expect(m.box.height).toBeLessThanOrEqual(height * 0.25 + 1);
    expect(m.line, 'a line parts the cards from the screen').not.toBe('0px');
    expect(Math.abs(m.more - m.text), 'More starts where the words do').toBeLessThanOrEqual(2);
    expect(Math.abs(m.update - m.text), 'and so does Update').toBeLessThanOrEqual(2);
    await expect(card.getByRole('button', { name: 'Dismiss' })).toBeInViewport();
  });
}

// "I clicked plan -> check this -> open the original, so dropping me to trip looks weird. Also the top tab shows I am in Trips when I am back to plan."
test('Plan → Check this → Open the original: back goes to the booking, then to the Plan, and the top bar says Plan all the way (item 8)', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Alaska');
  const tz = 'America/Anchorage';
  await writeRecords(page, trip, {
    patch: { '/trip.json': { start: '2026-11-20', end: '2026-11-27', timezones: [tz] } },
    write: {
      '/plan/car.json': { id: 'car', title: 'Avis at the airport', fixed: true, start: { at: '2026-11-20T20:58:00-09:00', tz }, booking: '/trip/bookings/car.json' },
      '/bookings/car.json': { id: 'car', kind: 'car', status: 'unverified', source: '/trip/files/avis.txt', title: 'Avis 24603608US1', start: { at: '2026-11-20T20:58:00-09:00', tz } },
    },
    text: { '/files/avis.txt': 'Your Avis reservation 24603608US1' },
  });
  const tab = () => page.getByRole('navigation', { name: 'Main' }).locator('[aria-current="page"]');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plan' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible();
  await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: 'Check this' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Avis 24603608US1' })).toBeVisible();
  await expect(tab()).toHaveText('Plan');
  await page.getByRole('link', { name: 'Open the original' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /avis\.txt/ })).toBeVisible();
  await expect(tab()).toHaveText('Plan');
  await page.getByRole('main').locator('.crumbs a').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Avis 24603608US1' })).toBeVisible();
  await expect(tab()).toHaveText('Plan');
  await page.getByRole('main').getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible();
  await expect(tab()).toHaveText('Plan');
  // From the trip's own files, back is the trip, as before.
  await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
  await page.getByRole('link', { name: /avis\.txt/ }).first().click();
  await expect(tab()).toHaveText('Trips');
  await page.getByRole('main').locator('.crumbs a').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Alaska' })).toBeVisible();
});

// "for the ridy up button, maybe put at the bottom of conversation instead of top?"
test('Tidy up is at the foot of the Conversation, under its last line, and its menu opens upward, in view (item 10)', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Alaska');
  for (let i = 0; i < 6; i++) {
    await writeEvent(page, trip, { type: 'msg.user', data: { text: `Question ${i}` } });
    await writeEvent(page, trip, { type: 'out.speak', data: { text: `Answer ${i}: a line long enough to take a little room on a phone.` } });
  }
  await page.goto('/#/talk');
  await expect(page.locator('.convo .shiori')).toHaveCount(6);
  const toggle = page.getByRole('button', { name: 'Tidy up' });
  await toggle.scrollIntoViewIfNeeded();
  const last = /** @type {any} */ (await page.locator('.convo > li').last().boundingBox());
  const at = /** @type {any} */ (await toggle.boundingBox());
  expect(at.y).toBeGreaterThanOrEqual(last.y + last.height);
  await toggle.click();
  const menu = page.getByRole('group', { name: 'Tidy up the conversation' });
  await expect(menu).toBeInViewport({ ratio: 1 });
  const m = /** @type {any} */ (await menu.boundingBox());
  expect(m.y + m.height).toBeLessThanOrEqual(at.y + 1);
  await expect(menu.getByRole('button', { name: 'Summarize now' })).toBeVisible();
});
