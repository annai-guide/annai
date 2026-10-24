import { test, expect } from '@playwright/test';
import { openApp, unmarked, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply, startTrip, writeRecords, writeEvent } from './helpers.js';
import { accented } from '../../src/core/l10n-pseudo.js';

test('the pseudo-locale en-XA says its language, and ar-XB its direction', async ({ page }) => {
  await openApp(page, '?l10n=en-XA#/trips');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.goto('/?l10n=ar-XB#/trips');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar-XB');
});

test('the Trips screen speaks through t: its words, its form and its cards are pseudo text under en-XA', async ({ page }) => {
  await openApp(page, '?l10n=en-XA#/trips');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(accented('Trips'));
  await expect(page.locator('p.empty')).toHaveText(accented('No trips yet. Start one below, or open a trip someone sent you.'));
  await expect(page.getByRole('heading', { level: 2, name: accented('Start a trip') })).toBeVisible();
  await expect(page.getByLabel(accented('Starts'))).toBeVisible();
  await expect(page.getByLabel(accented('Ends'))).toBeVisible();
  await expect(page.getByPlaceholder(accented('Big Sur · Thanksgiving'))).toBeVisible();
  await expect(page.locator('p.sub').last()).toHaveText(accented('No backup yet. Export everything from Settings, or set up automatic backups there.'));
  await page.getByLabel(accented('Trip name')).fill('Kyoto Spring');
  await page.getByRole('button', { name: accented('Start trip') }).click();
  await expect(page.getByRole('heading', { name: 'Kyoto Spring' })).toBeVisible();
  await page.evaluate(() => { location.hash = '#/trips'; });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(accented('Trips'));
  const facts = page.locator('.trip-card .sub');
  await expect(facts).toContainText(accented('not backed up'));
  await expect(facts).toContainText(/⟦úṕðáţéð [^⟧]*⟧/);
  // A report for whoever extracts a screen next, not an assertion: what is still plain English here.
  console.log(`unmarked on Trips (en-XA):\n  ${(await unmarked(page, ['Kyoto Spring'])).join('\n  ') || 'nothing'}`);
});

test('without a pseudo-locale the page is English, in the phone\'s region, and says so', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-l10n-failed', /./);
});

test('a pseudo-locale that does not exist is ignored', async ({ page }) => {
  await openApp(page, '?l10n=xx#/trips');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
});

test('the Languages section speaks through t under en-XA, its statuses whole', async ({ page }) => {
  await openApp(page, '?l10n=en-XA#/shiori');
  const panel = page.getByRole('region', { name: accented('Languages') });
  await expect(panel.getByRole('heading', { name: accented('Languages') })).toBeVisible();
  await expect(panel.getByRole('list', { name: accented('Languages you speak') })).toBeVisible();
  await expect(panel.getByLabel(accented('Add a language'))).toBeVisible();
  await expect(panel.getByLabel(accented('Shiori answers in'))).toBeVisible();
  await panel.getByLabel(accented('Add a language')).selectOption('ja');
  await panel.getByRole('button', { name: accented('Add'), exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(accented('Added {0}. Saved').replace('{0}', 'Japanese'));
});

// Localization L3: Chinese and Japanese drawn right (the design, section 6). The same Han character has a Japanese and a Chinese shape; a
// browser picks the font by the text's lang, and only when the stack names no CJK font before it.
const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const speak = (/** @type {string} */ text) => sse(anthropicToolReply([{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }]));
const CHINESE = '直角三角形的骨架，这是我们说的。';
const JAPANESE = '直角三角形の骨組みです。';

test('a conversation with a Chinese line, a Japanese line and an English one: each carries its language, and no line is drawn with a Japanese font first', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [speak(CHINESE), speak(JAPANESE), speak('The frame is a right triangle.')] });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/trips');
    await startTrip(page, 'Big Sur');
    const lines = page.locator('.convo li p');
    let n = 0;
    for (const words of [CHINESE, JAPANESE, 'Say it in English']) {
      await page.getByRole('button', { name: 'Type', exact: true }).click();
      await page.getByLabel('Message to Shiori').fill(words);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
      n += 2;
      await expect(lines).toHaveCount(n, { timeout: 20_000 });
      await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
    }
    // The user's lines and Shiori's, in order: Chinese, Chinese, Japanese, Japanese, English, English.
    const langs = await lines.evaluateAll((els) => els.map((el) => el.getAttribute('lang')));
    expect(langs).toEqual(['zh-Hans', 'zh-Hans', 'ja', 'ja', null, null]);
    expect(await lines.evaluateAll((els) => els.map((el) => el.getAttribute('dir')))).toEqual(Array(6).fill('auto'));
    // The label over her lines is annai's, not hers: it keeps the screens' language.
    await expect(page.locator('.convo .who').first()).not.toHaveAttribute('lang', /./);
    const stacks = await page.evaluate(() => {
      const ff = (/** @type {Element | null} */ el) => (el ? getComputedStyle(el).fontFamily : '');
      return { body: ff(document.body), english: ff(document.querySelectorAll('.convo li p')[5]), chinese: ff(document.querySelectorAll('.convo li p')[1]), japanese: ff(document.querySelectorAll('.convo li p')[3]) };
    });
    console.log(`computed font-family (${test.info().project.name}): ${JSON.stringify(stacks)}`);
    for (const [where, stack] of Object.entries(stacks)) expect(stack, where).not.toMatch(/Hiragino|Noto Sans JP/);
    // The line is what carries the language, so a Chinese line reaches the platform's Chinese font: the stack names none first.
    expect(stacks.chinese).toBe(stacks.english);
  } finally {
    await llm.stop();
  }
});

test('under a Japanese interface the display stack gets Hiragino Maru Gothic back, and under no other', async ({ page }) => {
  await openApp(page, '#/trips');
  const display = () => page.evaluate(() => getComputedStyle(document.querySelector('h1.title') ?? document.body).fontFamily);
  expect(await display()).not.toContain('Hiragino');
  await page.evaluate(() => { document.documentElement.lang = 'ja'; });
  expect(await display()).toContain('Hiragino Maru Gothic ProN');
  await page.evaluate(() => { document.documentElement.lang = 'zh-Hans'; });
  expect(await display()).not.toContain('Hiragino');
});

test('Japanese headings break between phrases where the browser can', async ({ page }) => {
  await openApp(page, '#/trips');
  const got = await page.evaluate(() => {
    const probe = (/** @type {string} */ tag, /** @type {string} */ lang) => {
      const el = document.createElement(tag);
      el.lang = lang;
      document.body.append(el);
      const v = getComputedStyle(el).wordBreak;
      el.remove();
      return v;
    };
    return { supported: CSS.supports('word-break', 'auto-phrase'), ja: probe('h2', 'ja'), jaText: probe('p', 'ja'), en: probe('h2', 'en') };
  });
  expect(got.en).toBe('normal');
  expect(got.jaText, 'only headings').toBe('normal');
  expect(got.ja).toBe(got.supported ? 'auto-phrase' : 'normal');
});

test('Japanese lines break strictly, Korean at spaces, and no Chinese, Japanese or Korean line is slanted in the dock\'s bubble', async ({ page }) => {
  await openApp(page, '#/trips');
  const style = await page.evaluate(() => {
    const probe = (/** @type {string} */ lang) => {
      const p = document.createElement('p');
      p.className = 'caption';
      p.lang = lang;
      document.body.append(p);
      const cs = getComputedStyle(p);
      const out = { lineBreak: cs.lineBreak, wordBreak: cs.wordBreak, fontStyle: cs.fontStyle };
      p.remove();
      return out;
    };
    return { en: probe('en'), ja: probe('ja'), zh: probe('zh-Hans'), ko: probe('ko') };
  });
  expect(style.en).toMatchObject({ lineBreak: 'auto', wordBreak: 'normal', fontStyle: 'italic' });
  expect(style.ja).toMatchObject({ lineBreak: 'strict', fontStyle: 'normal' });
  expect(style.zh.fontStyle).toBe('normal');
  expect(style.ko).toMatchObject({ wordBreak: 'keep-all', fontStyle: 'normal' });
});

test('what the user wrote is told apart from annai\'s words: dir="auto" on trip names, file names and crumbs, and a language name in its own script carries its language', async ({ page }) => {
  await openApp(page, '#/trips');
  const trip = await startTrip(page, 'טיול לקיוטו');
  await writeRecords(page, trip, { text: { '/notes/שלום.md': 'hello' } });
  await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute('dir', 'auto');
  await page.goto('/#/trips');
  await expect(page.locator('.trip-card .name')).toHaveAttribute('dir', 'auto');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
  // A path reads left to right as a whole; only the file's name is turned by its own letters.
  const row = page.locator('.file-row .path', { hasText: 'שלום.md' });
  await expect(row).toHaveAttribute('dir', 'ltr');
  await expect(row).toHaveText('/notes/שלום.md');
  await expect(row.locator('span')).toHaveAttribute('dir', 'auto');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/recap`);
  await expect(page.getByRole('heading', { level: 1, name: 'Recap' })).toBeVisible();
  await expect(page.locator('.crumbs [dir="auto"]')).toHaveText('טיול לקיוטו');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/file?path=${encodeURIComponent('/notes/שלום.md')}`);
  await expect(page.getByRole('heading', { level: 1, name: '/notes/שלום.md' })).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1 }).locator('span')).toHaveAttribute('dir', 'auto');
  await page.goto('/#/shiori');
  const panel = page.getByRole('region', { name: 'Languages' });
  await panel.getByLabel('Add a language').selectOption('ja');
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Added Japanese. Saved');
  await expect(panel.locator('.lang-name [lang="ja"]')).toHaveText('日本語');
});

test('Shiori\'s cards, the card on Now and the recap carry the language of their words', async ({ page }) => {
  await openApp(page, '#/trips');
  const trip = await startTrip(page, 'Kyoto Spring');
  await writeEvent(page, trip, { type: 'out.show', data: { card: { title: '清水寺', text: '直角三角形的骨架，这是我们说的。', place: { name: '清水寺', address: '京都市东山区' }, choice: ['好的'] } } });
  await writeEvent(page, trip, { type: 'out.speak', data: { text: '直角三角形の骨組みです。' } });
  await writeRecords(page, trip, { text: { '/recap.md': '# 京都\n\n直角三角形の骨組みです。' } });
  await page.goto('/#/talk');
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  const card = page.locator('.convo .card');
  await expect(card.locator('.card-title')).toHaveAttribute('lang', 'zh-Hans');
  await expect(card.locator('.md')).toHaveAttribute('lang', 'zh-Hans');
  await expect(card.locator('.card-place span')).toHaveAttribute('lang', 'zh-Hans');
  await expect(card.getByRole('button', { name: '好的' })).toHaveAttribute('lang', 'zh-Hans');
  await expect(card.getByRole('link', { name: 'Open in Maps' })).not.toHaveAttribute('lang', /./);
  await expect(page.locator('.convo .who').first()).not.toHaveAttribute('lang', /./);
  await expect(page.locator('.convo li.shiori > p').last()).toHaveAttribute('lang', 'ja');
  await page.goto('/#/now');
  await expect(page.locator('.shiori-card p')).toHaveAttribute('lang', 'ja');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/recap`);
  await expect(page.getByRole('heading', { level: 1, name: 'Recap' })).toBeVisible();
  await expect(page.locator('.recap-text .md')).toHaveAttribute('lang', 'ja');
});

test('the language Shiori answers in does not override what her words are: a Japanese line is ja though she answers in English, an English one is en; Google\'s snippets are told by their script alone', async ({ page }) => {
  await openApp(page, '#/trips');
  const trip = await startTrip(page, 'Kyoto Spring');
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { updateAppSettings } = await import(at('/src/core/settings.js'));
    const store = await createIdbStore();
    await updateAppSettings(new Workspace(store), { languages: { spoken: ['en', 'ja'], answer: 'en' } });
    store.close();
  });
  await writeEvent(page, trip, { type: 'out.speak', data: { text: 'Kiyomizu-dera opens at 6.' } });
  await writeEvent(page, trip, { type: 'out.speak', data: { text: '清水寺は朝6時に開きます。' } });
  await writeEvent(page, trip, { type: 'out.show', data: { card: { title: 'Kiyomizu-dera', place: { name: 'Kiyomizu-dera', address: '1 Chome-294 Kiyomizu' }, links: [{ label: 'https://example.com/kiyomizu', url: 'https://example.com/kiyomizu' }] } } });
  await writeEvent(page, trip, { type: 'grounded', data: { source: 'Google Search', text: 'Le temple ouvre à six heures.' } });
  await page.goto('/#/talk');
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  const lines = page.locator('.convo li.shiori > p');
  await expect(lines).toHaveCount(3);
  expect(await lines.evaluateAll((els) => els.map((el) => el.getAttribute('lang')))).toEqual(['en', 'ja', null]);
  await expect(page.locator('.convo .card-place span')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.convo .card .acts a')).not.toHaveAttribute('lang', /./);
});

test('the announcer tags only her words: the label before them, the choices after them and annai\'s own lines have no language of their own', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [speak('清水寺は朝6時に開きます。'), { status: 400, type: 'application/json', body: '{"error":{"type":"invalid_request_error","message":"bad request"}}' }] });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/trips');
    await startTrip(page, 'Big Sur');
    // She answers in Japanese: the setting that used to tag every line announced.
    await page.evaluate(async () => {
      const at = (/** @type {string} */ p) => p;
      const { createIdbStore } = await import(at('/src/core/store-idb.js'));
      const { Workspace } = await import(at('/src/core/workspace.js'));
      const { updateAppSettings } = await import(at('/src/core/settings.js'));
      const store = await createIdbStore();
      await updateAppSettings(new Workspace(store), { languages: { spoken: ['en', 'ja'], answer: 'ja' } });
      store.close();
    });
    await page.goto('/#/talk');
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      const announcer = /** @type {HTMLElement} */ (document.querySelector('main [aria-live="polite"]'));
      w.announced = [];
      new MutationObserver(() => w.announced.push(announcer.innerHTML)).observe(announcer, { childList: true, subtree: true });
    });
    for (const words of ['Tell me about Kiyomizu-dera', 'And again']) {
      await page.getByRole('button', { name: 'Type', exact: true }).click();
      await page.getByLabel('Message to Shiori').fill(words);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
      if (words.startsWith('Tell')) await expect(page.locator('.convo li.shiori > p')).toHaveCount(1, { timeout: 20_000 });
    }
    await expect(page.locator('.convo li.system')).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).announced.length)).toBeGreaterThan(1);
    const html = /** @type {string[]} */ (await page.evaluate(() => /** @type {any} */ (window).announced));
    expect(html).toContain('<span>Shiori: <span lang="ja">清水寺は朝6時に開きます。</span></span>');
    // Her error is annai\'s own English: nothing in it says Japanese.
    expect(html.some((h) => h.includes('lang="ja"') && /reach|ended|budget/i.test(h))).toBe(false);
    expect(html.filter((h) => !h.includes('清水寺')).every((h) => !h.includes('lang='))).toBe(true);
  } finally {
    await llm.stop();
  }
});

test('a reminder\'s label is annai\'s: only its words carry their language', async ({ page }) => {
  await openApp(page, '#/trips');
  const trip = await startTrip(page, 'Kyoto Spring');
  await writeEvent(page, trip, { type: 'reminder', data: { title: 'Reminder', aloud: true, text: '京都駅で会いましょう。' } });
  await page.goto('/#/talk');
  const line = page.locator('.convo li.system-line');
  await expect(line).toHaveText('Reminder, said aloud: 京都駅で会いましょう。');
  await expect(line).not.toHaveAttribute('lang', /./);
  await expect(line.locator('span')).toHaveAttribute('lang', 'ja');
  await page.goto('/#/now');
  const card = page.locator('p.system-line');
  await expect(card).toHaveText('Reminder, said aloud: 京都駅で会いましょう。');
  await expect(card).not.toHaveAttribute('lang', /./);
  await expect(card.locator('span')).toHaveAttribute('lang', 'ja');
});

test('a recap\'s blocks turn on their own letters, not on the first of the whole text: an English paragraph after a Hebrew place name stays left to right', async ({ page }) => {
  await openApp(page, '#/trips');
  const trip = await startTrip(page, 'Kyoto Spring');
  await writeRecords(page, trip, { text: { '/recap.md': 'שלום\n\nWe walked to the temple and ate lunch.\n\n- one\n- two' } });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/recap`);
  await expect(page.getByRole('heading', { level: 1, name: 'Recap' })).toBeVisible();
  const md = page.locator('.recap-text .md');
  await expect(md).not.toHaveAttribute('dir', /./);
  expect(await md.locator('> *').evaluateAll((els) => els.map((el) => el.getAttribute('dir')))).toEqual(['auto', 'auto', 'auto']);
  expect(await md.locator('p').nth(1).evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
});
