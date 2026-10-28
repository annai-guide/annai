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
    // Where even one line is more than the box holds (320 x 544), More is in the buttons, in view, and the text line goes; else
    // More is under the words.
    if (m.tight) await expect(card.getByRole('button', { name: 'More' })).toBeInViewport({ ratio: 1 });
    else expect(Math.abs(m.more - m.text), 'More starts where the words do').toBeLessThanOrEqual(2);
    if (!m.tight) expect(Math.abs(m.update - m.text), 'and so does Update').toBeLessThanOrEqual(2);
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

test("each of Shiori's lines names the model that wrote it, as written with it: the first model alone, another and that the first didn't answer or answered in its place; Koe's and Kokoro's notes too (item 12, and its second review)", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Alaska');
  const by = (/** @type {string} */ name, /** @type {string} */ first, tried = true) => ({ name, first, tried });
  await writeEvent(page, trip, { type: 'msg.user', data: { text: 'Where can I upload them?' } });
  await writeEvent(page, trip, { type: 'out.speak', data: { id: 's1', wake: 'w-koe', text: "I'm checking.", by: by('Claude Sonnet 5.5', 'Claude Sonnet 5.5') } });
  await writeEvent(page, trip, { type: 'note', data: { id: 'n1', from: 'koe', mode: 'append', why: 'tool', wake: 'w-koe', text: 'Where do bookings go?', by: by('Claude Sonnet 5.5', 'Claude Sonnet 5.5') } });
  await writeEvent(page, trip, { type: 'note', data: { id: 'n2', from: 'kokoro', mode: 'append', why: 'tool', wake: 'w-kokoro', text: 'Tell them to start a trip first.', by: by('Gemini 3.5 Flash Lite', 'Claude Opus 5.5') } });
  await writeEvent(page, trip, { type: 'out.speak', data: { id: 's2', wake: 'w-koe', text: 'Start a trip from Trips first.', by: by('Qwen3.8 Flash', 'Claude Sonnet 5.5', false) } });
  // A line no model wrote (a live voice's, annai's own), and one written before lines named their model, name none.
  await writeEvent(page, trip, { type: 'out.speak', data: { id: 's3', wake: 'w-live', text: 'Hello.', by: null } });
  await writeEvent(page, trip, { type: 'out.speak', data: { id: 's4', wake: 'w-old', text: 'From before.' } });
  await page.goto('/#/talk');
  const named = page.locator('.convo .by');
  await expect(named).toHaveText(['Claude Sonnet 5.5', 'Claude Sonnet 5.5', "Gemini 3.5 Flash Lite · Claude Opus 5.5 didn't answer", 'Qwen3.8 Flash · instead of Claude Sonnet 5.5']);
  for (const words of ['Hello.', 'From before.']) await expect(page.locator('.convo li', { hasText: words }).locator('.by')).toHaveCount(0);
  // Quiet: small, and not in what the announcer says of a line.
  expect(await named.first().evaluate((el) => el.classList.contains('sub'))).toBe(true);
});


test("a file of a trip that isn't open goes back to its own trip's Plan, not the open trip's (the review of item 8)", async ({ page }) => {
  await openApp(page);
  const first = await startTrip(page, 'Alaska');
  await writeRecords(page, first, { text: { '/files/avis.txt': 'Your Avis reservation' } });
  await page.goto('/#/trips');
  await startTrip(page, 'Kyoto'); // the open trip now
  const file = (/** @type {string} */ from) => `/#/trip/${encodeURIComponent(first)}/file?path=${encodeURIComponent('/files/avis.txt')}&from=${encodeURIComponent(from)}`;
  await page.goto(file('#/plan'));
  await expect(page.getByRole('main').locator('.crumbs a')).toHaveAttribute('href', `#/trip/${encodeURIComponent(first)}/plan`);
  await page.goto(file('#/now'));
  await expect(page.getByRole('main').locator('.crumbs a')).toHaveAttribute('href', `#/trip/${encodeURIComponent(first)}`);
  await expect(page.getByRole('navigation', { name: 'Main' }).locator('[aria-current="page"]')).toHaveText('Trips');
});

// The second review of phone-fixes-1: every kind of card, in English, Japanese and Chinese, on small, low and sideways phones.
/** Builds each kind of card, one at a time, in a box of the test's own, and says how its parts show. @param {import('@playwright/test').Page} page */
const cardsShown = (page) => page.evaluate(async () => {
  const at = (/** @type {string} */ p) => p;
  const { t } = await import(at('/src/core/l10n.js'));
  const { createNotices } = await import(at('/src/ui/notices.js'));
  const { offerCard } = await import(at('/src/ui/plugin-updates.js'));
  const { reloadCard } = await import(at('/src/ui/plugin-cards.js'));
  const { newerText, sentences } = await import(at('/src/ui/format.js'));
  for (const n of document.querySelectorAll('.notices, .risk')) /** @type {HTMLElement} */ (n).style.display = 'none';
  const updates = [['gemini-api', 'Gemini API', '0.9.0', '0.10.1'], ['custom-provider', 'Custom provider', '2.1.4', '2.2.1'], ['openrouter', 'OpenRouter', '2.2.0', '2.3.1'], ['remote-trace', 'Remote trace', '0.1.2', '0.2.1'], ['anthropic', 'Anthropic', '1.1.0', '1.2.0']]
    .map(([id, name, installed, available]) => ({ id, name, installed, available }));
  const target = { name: 'GitHub', hold: { kind: 'newer', remote: { label: 'iPhone', at: Date.now() - 3 * 3600e3 } }, last: Date.now() - 5 * 3600e3 };
  const run = () => {};
  /** @type {Record<string, (n: any) => void>} */
  const kinds = {
    updates: (n) => offerCard({ notices: n, plugins: {} }, updates),
    backup: (n) => n.card({ tone: 'warn', title: t`A newer backup is on ${'GitHub'}`, body: newerText(target, { where: 'me/annai-backup', noun: 'phone', tree: true }),
      actions: [{ label: t`Import it as a copy`, primary: true, run }, { label: t`Back up this phone over it`, run }] }),
    personality: (n) => n.card({ title: t`A new version of the ${'Concise'} personality`, body: t`Yours has your own edits, so it was kept as it is.`,
      actions: [{ label: t`Compare`, run }, { label: t`Keep mine`, run }, { label: t`Let Shiori merge`, primary: true, run }] }),
    large: (n) => n.card({ title: t`A large backup is waiting`, body: sentences(t`This backup uploads ${'48 MB'} to ${'GitHub'}.`, t`annai can't tell whether this phone is on Wi-Fi, so larger backups wait for your OK.`),
      actions: [{ label: t`Back up now`, primary: true, run }, { label: t`Open Backups`, run }] }),
    reload: (n) => n.card(reloadCard(['Gemini API', 'OpenRouter'], run)),
    titleOnly: (n) => n.card({ tone: 'warn', title: t`Some plugins weren't updated` }),
    stopped: (n) => n.card({ tone: 'warn', title: t`Backups to ${'GitHub'} stopped`, body: t`Open Backups to fix it.`, en: 'GitHub answered 409 Conflict: the branch main was updated by another device while this one was uploading, and the upload was refused. Back up again once the other device has finished.', actions: [{ label: t`Open Backups`, run }] }),
    stack: (n) => { for (let i = 0; i < 2; i++) n.card({ tone: 'warn', title: t`Something went wrong`, body: t`annai kept running. The details are in Trace.` }); },
  };
  /** @type {string[]} */
  const wrong = [];
  for (const [kind, make] of Object.entries(kinds)) {
    document.getElementById('tn')?.remove();
    const n = createNotices();
    n.el.id = 'tn';
    document.querySelector('header.topbar')?.after(n.el);
    make(n);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    scrollTo(0, 0);
    const card = /** @type {HTMLElement} */ (n.el.firstElementChild);
    const r = (/** @type {Element} */ el) => el.getBoundingClientRect();
    /** Whether a part shows whole and on top, as it is now: nothing scrolled. @param {HTMLElement} el */
    const shows = (el) => {
      const b = r(el);
      const box = r(n.el);
      const inside = b.height > 0 && b.top >= Math.max(r(card).top, box.top, 0) - 0.5 && b.bottom <= Math.min(r(card).bottom, box.bottom, innerHeight) + 0.5;
      const hit = document.elementFromPoint(b.left + Math.min(6, b.width / 2), b.top + b.height / 2);
      return inside && Boolean(hit && el.contains(hit));
    };
    const title = /** @type {HTMLElement} */ (card.querySelector(':scope > strong'));
    if (!shows(title)) wrong.push(`${kind}: the title`);
    for (const b of /** @type {HTMLElement[]} */ ([...card.querySelectorAll(':scope > .acts > button, :scope > .more')]).filter((x) => !x.hidden)) if (!shows(b)) wrong.push(`${kind}: ${b.textContent}`);
    const acts = /** @type {HTMLElement} */ (card.querySelector(':scope > .acts'));
    for (const p of /** @type {HTMLElement[]} */ ([...card.querySelectorAll(':scope > p')])) {
      if (p.offsetHeight > 1 && getComputedStyle(acts).position === 'sticky' && r(p).bottom > r(acts).top + 1) wrong.push(`${kind}: words behind the buttons`);
    }
  }
  return wrong;
});

for (const ui of ['', 'ja', 'zh-Hans']) {
  for (const [width, height] of [[320, 544], [360, 640], [393, 659], [390, 844], [667, 375]]) {
    test(`every kind of card shows its title and every button, and no words behind them${ui ? `, in ${ui}` : ''}, at ${width} x ${height} (the second review of item 3)`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      if (ui) await page.addInitScript((tag) => { try { localStorage.setItem('annai.ui', tag); } catch { /* storage blocked */ } }, ui);
      await openApp(page, '#/trips');
      if (ui) await expect(page.locator('html')).toHaveAttribute('lang', ui);
      await page.evaluate(() => document.fonts.ready);
      expect(await cardsShown(page)).toEqual([]);
    });
  }
}

test("a card's words behind More are still read by a screen reader (the second review of item 3)", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 544 });
  await openApp(page, '#/trips');
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createNotices } = await import(at('/src/ui/notices.js'));
    const n = createNotices();
    n.el.id = 'tn';
    document.querySelector('header.topbar')?.after(n.el);
    n.card({ tone: 'warn', title: 'A newer backup is on GitHub', body: 'An iPhone backed up to me/annai-backup 3 hours ago. That was after this phone\'s last backup, 5 hours ago.', actions: [{ label: 'Import it as a copy', primary: true, run() {} }, { label: 'Back up this phone over it', run() {} }] });
  });
  const card = page.locator('#tn > .notice');
  await expect(card).toHaveClass(/\bbrief\b/);
  expect(await card.ariaSnapshot()).toContain("That was after this phone's last backup");
});

// The third review of phone-fixes-1: a card's fit, when it comes, when a stack folds back, after Less, with More focused, and an open stack.
/** A box of the test's own in place of the app's, with window.__n its notices and window.__backup() a backup-conflict card. @param {import('@playwright/test').Page} page */
const ownBox = (page) => page.evaluate(async () => {
  const at = (/** @type {string} */ p) => p;
  const { createNotices } = await import(at('/src/ui/notices.js'));
  const n = createNotices();
  n.el.id = 'tn';
  document.querySelector('.notices')?.replaceWith(n.el);
  for (const r of document.querySelectorAll('.risk')) /** @type {HTMLElement} */ (r).style.display = 'none';
  const w = /** @type {any} */ (window);
  w.__n = n;
  w.__backup = () => n.card({ tone: 'warn', title: 'A newer backup is on GitHub', body: "An iPhone backed up to me/annai-backup 3 hours ago. That was after this phone's last backup, 5 hours ago.",
    actions: [{ label: 'Import it as a copy', primary: true, run() {} }, { label: 'Back up this phone over it', run() {} }] });
});
/** Whether a part shows on top, as things are now. @param {import('@playwright/test').Locator} part */
const onTop = (part) => part.evaluate((el) => {
  const b = el.getBoundingClientRect();
  const hit = document.elementFromPoint(b.left + Math.min(6, b.width / 2), b.top + b.height / 2);
  return b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && Boolean(hit && el.contains(hit));
});
const frames = (/** @type {import('@playwright/test').Page} */ page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test('a card that comes while the page is scrolled down leaves what is seen where it was, its fit and all (third review, 1)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await ownBox(page);
  await page.evaluate(() => scrollTo(0, 400));
  const mark = page.locator('main.view a[href]').filter({ hasNotText: /^$/ }).nth(3);
  const was = await mark.evaluate((el) => el.getBoundingClientRect().top);
  await page.evaluate(() => /** @type {any} */ (window).__backup());
  await frames(page);
  await expect(page.locator('#tn > .notice')).toHaveClass(/\bbrief\b/); // a card its fit changed
  expect(Math.abs((await mark.evaluate((el) => el.getBoundingClientRect().top)) - was)).toBeLessThanOrEqual(1);
});

test('a stack folding back to one card fits that card: its title is not behind its buttons (third review, 2)', async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await openApp(page, '#/trips');
  await ownBox(page);
  await page.evaluate(() => {
    const n = /** @type {any} */ (window).__n;
    const first = n.card({ tone: 'warn', title: 'Something went wrong', body: 'annai kept running. The details are in Trace.' });
    n.card({ tone: 'warn', title: 'Something went wrong', body: 'annai kept running. The details are in Trace.' });
    first();
  });
  await frames(page);
  const card = page.locator('#tn > .notice');
  await expect(card).not.toHaveClass(/notice-stack/);
  expect(await onTop(card.locator('strong'))).toBe(true);
  expect(await onTop(card.getByRole('button', { name: 'Dismiss' }))).toBe(true);
});

test('More, a turn of the phone, then Less: the card fits the screen it is on now (third review, 3)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, '#/trips');
  await ownBox(page);
  await page.evaluate((body) => /** @type {any} */ (window).__n.card({ title: 'Plugin updates are ready', body, actions: [{ label: 'Update', primary: true, run() {} }] }), OFFER);
  await frames(page);
  const card = page.locator('#tn > .notice');
  await card.getByRole('button', { name: 'More' }).click();
  await page.setViewportSize({ width: 844, height: 390 });
  await frames(page);
  await card.getByRole('button', { name: 'Less' }).click();
  await frames(page);
  const after = await card.evaluate((c) => [c.className, c.style.getPropertyValue('--lines')]);
  await page.evaluate(() => dispatchEvent(new Event('resize')));
  await frames(page);
  expect(after).toEqual(await card.evaluate((c) => [c.className, c.style.getPropertyValue('--lines')]));
});

test('More keeps the focus when the screen changes size (third review, 10)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 544 });
  await openApp(page, '#/trips');
  await ownBox(page);
  await page.evaluate(() => /** @type {any} */ (window).__backup());
  await frames(page);
  const more = page.locator('#tn > .notice').getByRole('button', { name: 'More' });
  await more.focus();
  await page.evaluate(() => dispatchEvent(new Event('resize')));
  await frames(page);
  await expect(more).toBeFocused();
});

test('an opened stack in a small box shows each of its cards whole: no Dismiss over a title (third review, 9)', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 659 });
  await openApp(page, '#/trips');
  await ownBox(page);
  await page.evaluate(() => {
    const n = /** @type {any} */ (window).__n;
    for (let i = 0; i < 2; i++) n.card({ tone: 'warn', title: 'Something went wrong', body: 'annai kept running. The details are in Trace.' });
  });
  await frames(page);
  await page.locator('#tn .notice-stack').getByRole('button', { name: /^Show/ }).click();
  await frames(page);
  // The box's cap is lifted, as for an opened card: it doesn't scroll, so no card's sticky Dismiss sits over another's title.
  expect(await page.locator('#tn').evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  for (const member of await page.locator('#tn .stack-list > .notice').all()) {
    await member.scrollIntoViewIfNeeded();
    expect(await onTop(member.locator('strong'))).toBe(true);
  }
});
