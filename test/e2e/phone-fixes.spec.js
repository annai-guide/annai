import { test, expect } from '@playwright/test';
import { openApp, startTrip, writeRecords, writeEvent, waitForServiceWorker, addProvider } from './helpers.js';

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
        tight: Boolean(card.querySelector('.acts .more')),
      };
    });
    expect(m.scrolled, 'the box needs no scrolling to show the card').toBeLessThanOrEqual(0);
    expect(m.card.bottom).toBeLessThanOrEqual(m.box.bottom);
    expect(m.card.top).toBeGreaterThanOrEqual(m.box.top);
    expect(m.box.height).toBeLessThanOrEqual(height * 0.25 + 1);
    expect(m.line, 'a line parts the cards from the screen').not.toBe('0px');
    // Where even one line is more than the box holds (320 x 544), More is in the buttons, in view; else under the words.
    if (m.tight) await expect(card.getByRole('button', { name: 'More' })).toBeInViewport({ ratio: 1 });
    else expect(Math.abs(m.more - m.text), 'More starts where the words do').toBeLessThanOrEqual(2);
    expect(m.tight).toBe(height < 600);
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

// "the drag model also does not work as intended. the long press and hold text selection will show up..." (IMG_3014)
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

test('a reorderable row and its handle take no text selection, no callout and no long-press menu (item 4)', async ({ page }) => {
  const { main } = await threeModels(page);
  const looks = await gripOf(main, 'a2').evaluate((grip) => {
    const row = /** @type {HTMLElement} */ (grip.closest('li'));
    const of = (/** @type {Element} */ el) => {
      const s = /** @type {any} */ (getComputedStyle(el));
      // -webkit-touch-callout is iOS Safari's alone: the test's WebKit and Chromium don't report it.
      return { select: s.webkitUserSelect || s.userSelect, callout: s.webkitTouchCallout ?? 'none' };
    };
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    const opened = grip.dispatchEvent(menu);
    return { row: of(row), grip: of(grip), link: of(/** @type {Element} */ (row.querySelector('a'))), opened };
  });
  for (const part of [looks.row, looks.grip, looks.link]) expect(part).toEqual({ select: 'none', callout: 'none' });
  expect(looks.opened, "a long press opens no menu of the browser's").toBe(false);
});

test('a finger held on the handle, then moved, still drags: nothing is selected and the order is kept (item 4)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch events are sent through the DevTools protocol, Chromium only');
  const { main, order } = await threeModels(page);
  const cdp = await page.context().newCDPSession(page);
  const centre = async (/** @type {import('@playwright/test').Locator} */ l) => { const b = /** @type {any} */ (await l.boundingBox()); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const from = await centre(gripOf(main, 'a1'));
  const to = await centre(gripOf(main, 'a3'));
  const touch = (/** @type {'touchStart' | 'touchMove' | 'touchEnd'} */ type, /** @type {number} */ y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: from.x, y }] });
  await touch('touchStart', from.y);
  await page.waitForTimeout(900); // held, as a long press
  for (let k = 1; k <= 6; k++) await touch('touchMove', from.y + ((to.y + 6 - from.y) * k) / 6);
  await touch('touchEnd', to.y);
  await expect.poll(order).toEqual(['1. a2', '2. a3', '3. a1']);
  expect(await page.evaluate(() => String(getSelection()))).toBe('');
});

// "when all models error out, I cannot see it unless I goto the trace screen?" and "maybe we shall also mark which model is responding in
// the conversation tab as well?" (IMG_3017)
const ATTEMPTS = [{ name: 'Gemini 3.5 Flash Lite', outcome: 'timeout', error: 'No output started in time.', said: { code: 'late' } }, { name: 'Claude Opus 5.5', outcome: 'auth', error: 'The key was rejected.' }];
test('a turn or a tidy-up every model failed is a line in the Conversation, Kokoro\'s too; one the user stopped is not (item 6)', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Alaska');
  await writeEvent(page, trip, { type: 'msg.user', data: { text: 'Read these files again?' } });
  // Kokoro's, set aside while Koe talks: before, only the Trace had them.
  await writeEvent(page, trip, { type: 'error', data: { kind: 'model', half: 'kokoro', aside: true, wake: 'w-1', why: { attempts: ATTEMPTS }, message: 'Gemini 3.5 Flash Lite: No output started in time.' } });
  await writeEvent(page, trip, { type: 'error', data: { kind: 'compaction', half: 'kokoro', aside: true, wake: 'w-2', why: { attempts: ATTEMPTS }, message: 'Gemini 3.5 Flash Lite: No output started in time.' } });
  await writeEvent(page, trip, { type: 'error', data: { kind: 'stopped', half: 'koe', quiet: true, wake: 'w-3', message: 'Stopped by the user.' } });
  await page.goto('/#/talk');
  const lines = page.locator('.convo li.system');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0).locator('strong')).toHaveText("Shiori can't reach her model");
  await expect(lines.nth(0)).toContainText('Claude Opus 5.5');
  await expect(lines.nth(1).locator('strong')).toHaveText("Shiori couldn't tidy up the conversation");
  // Set aside, it offers no Try again: Koe is the one who talks.
  await expect(lines.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test("each of Shiori's lines names the model that wrote it, and says so when it wasn't the first; Koe's and Kokoro's notes too (item 12)", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Alaska');
  const turn = (/** @type {string} */ wake, /** @type {string} */ role, /** @type {string} */ by, /** @type {any[]} */ attempts) => writeEvent(page, trip, { type: 'model.turn', data: { role, level: 'low', answeredBy: by, attempts, wake } });
  await writeEvent(page, trip, { type: 'msg.user', data: { text: 'Where can I upload them?' } });
  await turn('w-koe', 'koe-classic', 'Claude Sonnet 5.5', [{ name: 'Claude Sonnet 5.5', outcome: 'ok' }]);
  await writeEvent(page, trip, { type: 'out.speak', data: { id: 's1', wake: 'w-koe', text: "I'm checking." } });
  await writeEvent(page, trip, { type: 'note', data: { id: 'n1', from: 'koe', mode: 'append', why: 'tool', wake: 'w-koe', text: 'Where do bookings go?' } });
  await turn('w-kokoro', 'main', 'Gemini 3.5 Flash Lite', [{ name: 'Claude Opus 5.5', outcome: 'bad-request' }, { name: 'Gemini 3.5 Flash Lite', outcome: 'ok' }]);
  await writeEvent(page, trip, { type: 'note', data: { id: 'n2', from: 'kokoro', mode: 'append', why: 'tool', wake: 'w-kokoro', text: 'Tell them to start a trip first.' } });
  await turn('w-koe', 'koe-classic', 'Qwen3.8 Flash', [{ name: 'Claude Sonnet 5.5', outcome: 'bad-request' }, { name: 'Qwen3.8 Flash', outcome: 'ok' }]);
  await writeEvent(page, trip, { type: 'out.speak', data: { id: 's2', wake: 'w-koe', text: 'Start a trip from Trips first.' } });
  // A line no model turn stands for (an older one, or a live voice's) names nothing.
  await writeEvent(page, trip, { type: 'out.speak', data: { id: 's3', wake: 'w-live', text: 'Hello.' } });
  await page.goto('/#/talk');
  const by = page.locator('.convo .by');
  await expect(by).toHaveText(['Claude Sonnet 5.5', 'Claude Sonnet 5.5', "Gemini 3.5 Flash Lite · Claude Opus 5.5 didn't answer", "Qwen3.8 Flash · Claude Sonnet 5.5 didn't answer"]);
  await expect(page.locator('.convo li', { hasText: 'Hello.' }).locator('.by')).toHaveCount(0);
  // Quiet: small, and not in what the announcer says of a line.
  expect(await by.first().evaluate((el) => el.classList.contains('sub'))).toBe(true);
});
