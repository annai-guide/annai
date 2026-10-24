import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { openApp, unmarked, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply, startTrip, writeRecords, writeEvent, startServer, modelSetUp, buildAndSave, pastWelcome } from './helpers.js';
import { parseHeaders, headersFor } from '../../scripts/headers.mjs';
import { key } from '../../src/core/l10n.js';
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
  // Under Japanese screens, a title in Chinese, Cantonese or Korean does not take Japanese shapes.
  await page.evaluate(() => { document.documentElement.lang = 'ja'; });
  for (const lang of ['zh-Hans', 'zh-Hant', 'yue-Hant', 'ko']) {
    expect(await page.evaluate((l) => {
      const el = document.createElement('h2');
      el.lang = l;
      document.body.append(el);
      const v = getComputedStyle(el).getPropertyValue('--f-display');
      el.remove();
      return v;
    }, lang), lang).not.toContain('Hiragino');
  }
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

// Localization L4: the screens' language is a setting (the design, section 2). These need Japanese listed in l10n/languages.json, which phase B
// does with its words; until then they are skipped, and the one test that needs no catalog runs.
const listed = /** @type {{ tag: string, status: string }[]} */ (JSON.parse(readFileSync(new URL('../../l10n/languages.json', import.meta.url), 'utf8')));
const jaListed = listed.find((l) => l.tag === 'ja');
const needJapanese = () => test.skip(!jaListed, 'Japanese is not listed in l10n/languages.json yet: phase B turns this test on');
const JA = /** @type {Record<string, string>} */ (jaListed ? JSON.parse(readFileSync(new URL('../../l10n/ja.json', import.meta.url), 'utf8')) : {});
const TRIPS_JA = JA[key('Trips')];
const SCREENS = "annai's screens in";

/** Turns on Settings → Experimental → Unfinished translations, if Japanese needs it, and waits for it to be saved. @param {import('@playwright/test').Page} page */
async function allowUnfinished(page) {
  if (jaListed?.status !== 'experimental') return;
  await page.evaluate(() => { location.hash = '#/experimental'; });
  const panel = page.getByRole('region', { name: 'Unfinished translations' });
  await panel.getByRole('checkbox', { name: 'Unfinished translations' }).check();
  await expect(panel.getByText('Saved', { exact: true })).toBeVisible();
}
/** The catalog of a language in the worker's caches, by cache name: null where a cache lacks it. @param {import('@playwright/test').Page} page @param {string} tag */
const cachedWords = (page, tag) => page.evaluate(async (t) => {
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const name of await caches.keys()) {
    if (!name.startsWith('annai-shell-')) continue;
    const hit = await (await caches.open(name)).match(`/l10n/${t}.json`);
    out[name] = hit ? await hit.text() : null;
  }
  return out;
}, tag);

test('a choice kept on the device that annai no longer offers is the phone\'s language, not a failure', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('annai.ui', 'xx'); } catch { /* storage blocked */ } });
  await openApp(page, '#/trips');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.locator('html')).not.toHaveAttribute('data-l10n-failed', /./);
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect(page.getByRole('status').locator('.notice')).toHaveCount(0);
});

test('annai\'s screens in: As this phone is set (English), then each language by its own name; Japanese only while Unfinished translations is on', async ({ page }) => {
  needJapanese();
  test.skip(jaListed?.status !== 'experimental', 'Japanese ships, so it needs no switch');
  await openApp(page, '#/shiori');
  const panel = page.getByRole('region', { name: 'Languages' });
  const screens = panel.getByLabel(SCREENS);
  // It is the first row, above the languages you speak.
  expect(await panel.locator('.field-label, h3').allTextContents()).toEqual([SCREENS, 'Languages you speak', 'Add a language', 'Shiori answers in']);
  await expect(screens.locator('option')).toHaveText(['As this phone is set (English)', 'English']);
  await page.evaluate(() => { location.hash = '#/experimental'; });
  await expect(page.getByRole('heading', { level: 1, name: 'Experimental' })).toBeVisible();
  await allowUnfinished(page);
  await page.evaluate(() => { location.hash = '#/shiori'; });
  await expect(screens.locator('option')).toContainText(['As this phone is set (English)', 'English', '日本語']);
  await expect(screens.locator('option[value="ja"]')).toHaveAttribute('lang', 'ja');
  await expect(screens.locator('option[value="en"]')).toHaveAttribute('lang', 'en');
  // Turned off again, it is gone.
  await page.evaluate(() => { location.hash = '#/experimental'; });
  await page.getByRole('region', { name: 'Unfinished translations' }).getByRole('checkbox', { name: 'Unfinished translations' }).uncheck();
  await expect(page.getByRole('region', { name: 'Unfinished translations' }).getByText('Saved', { exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = '#/shiori'; });
  await expect(screens.locator('option')).toHaveText(['As this phone is set (English)', 'English']);
});

test('choosing 日本語 keeps its words, restarts annai in Japanese, and it stays Japanese offline', async ({ page }, testInfo) => {
  needJapanese();
  const server = await startServer(8831 + testInfo.parallelIndex);
  try {
    await page.goto(`${server.origin}/#/shiori`);
    await expect(page.getByRole('heading', { level: 1, name: 'Shiori' })).toBeVisible();
    await waitForServiceWorker(page);
    await allowUnfinished(page);
    await page.evaluate(() => { location.hash = '#/shiori'; });
    const restarted = page.waitForEvent('load');
    await page.getByRole('region', { name: 'Languages' }).getByLabel(SCREENS).selectOption('ja');
    await restarted;
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    expect(await page.evaluate(() => localStorage.getItem('annai.ui'))).toBe('ja');
    await page.evaluate(() => { location.hash = '#/trips'; });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(TRIPS_JA);
    // The worker holds the catalog.
    const kept = Object.values(await cachedWords(page, 'ja'));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((text) => text !== null && Object.hasOwn(JSON.parse(text), key('Trips')))).toBe(true);
    // The network goes: annai still opens in Japanese.
    await server.stop();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(TRIPS_JA);
    // The row says what was chosen; "As this phone is set" is English again, with the copy on the device taken away.
    await page.evaluate(() => { location.hash = '#/shiori'; });
    const screens = page.locator('#language-ui');
    await expect(screens).toHaveValue('ja');
    const back = page.waitForEvent('load');
    await screens.selectOption('');
    await back;
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    expect(await page.evaluate(() => localStorage.getItem('annai.ui'))).toBeNull();
  } finally {
    await server.stop();
  }
});

test.describe('on a phone set to Japanese', () => {
  test.use({ locale: 'ja-JP' });
  test('the choice 日本語 on a phone set to Japanese keeps its region: ja-JP', async ({ page }) => {
    needJapanese();
    await openApp(page, '#/shiori');
    await expect(page.locator('html')).toHaveAttribute('lang', jaListed?.status === 'shipped' ? 'ja-JP' : 'en');
    await allowUnfinished(page);
    await page.evaluate(() => { location.hash = '#/shiori'; });
    const restarted = page.waitForEvent('load');
    await page.getByRole('region', { name: 'Languages' }).getByLabel(SCREENS).selectOption('ja');
    await restarted;
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja-JP');
    expect(await page.evaluate(() => localStorage.getItem('annai.ui'))).toBe('ja');
  });
});

/** annai served from a port of the test's own, except the files in `changed`: a new sw.js, as if annai had shipped a new build. */
async function startSite() {
  const rules = parseHeaders(await readFile(new URL('../../_headers', import.meta.url), 'utf8'));
  /** @type {Map<string, string>} */
  const changed = new Map();
  const root = new URL('../../', import.meta.url);
  const types = /** @type {Record<string, string>} */ ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8' });
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = path.endsWith('/') ? `${path}index.html` : path;
    for (const [k, v] of headersFor(rules, path)) res.setHeader(k, v);
    try {
      const body = changed.get(file) ?? await readFile(new URL(`.${file}`, root));
      res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return { origin: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`, changed, stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
}

test('a new version of annai installs with the chosen catalog in its own cache', async ({ page }) => {
  needJapanese();
  const site = await startSite();
  try {
    await page.goto(`${site.origin}/#/shiori`);
    await expect(page.getByRole('heading', { level: 1, name: 'Shiori' })).toBeVisible();
    await waitForServiceWorker(page);
    await allowUnfinished(page);
    await page.evaluate(() => { location.hash = '#/shiori'; });
    const restarted = page.waitForEvent('load');
    await page.getByRole('region', { name: 'Languages' }).getByLabel(SCREENS).selectOption('ja');
    await restarted;
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    const before = Object.keys(await cachedWords(page, 'ja'));
    expect(before.length).toBeGreaterThan(0);
    const sw = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
    site.changed.set('/sw.js', sw.replace(/const BUILD = '[^']+';/, "const BUILD = 'e2e-next';"));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    // The new version caches the shell and the language chosen in the settings, as one.
    await expect.poll(async () => (await cachedWords(page, 'ja'))['annai-shell-0.1.0-e2e-next'] ?? null, { timeout: 30_000 }).not.toBeNull();
  } finally {
    await site.stop();
  }
});

test('words that cannot be loaded leave English and a card that says why, and Try again gets them once there is a connection', async ({ page }, testInfo) => {
  needJapanese();
  const port = 8831 + testInfo.parallelIndex;
  let server = await startServer(port);
  try {
    await page.goto(`${server.origin}/#/trips`);
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await waitForServiceWorker(page);
    await allowUnfinished(page);
    // Japanese is chosen, but its words were never kept, and there is no connection.
    await page.evaluate(async () => {
      const at = (/** @type {string} */ p) => p;
      const { createIdbStore } = await import(at('/src/core/store-idb.js'));
      const { Workspace } = await import(at('/src/core/workspace.js'));
      const { updateAppSettings } = await import(at('/src/core/settings.js'));
      const store = await createIdbStore();
      await updateAppSettings(new Workspace(store), { languages: { ui: 'ja' } });
      store.close();
      localStorage.setItem('annai.ui', 'ja');
      for (const name of await caches.keys()) await (await caches.open(name)).delete('/l10n/ja.json');
    });
    await server.stop();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-l10n-failed', 'ja');
    await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
    await page.evaluate(() => { location.hash = '#/trips'; });
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    const card = page.getByRole('status').locator('.notice', { hasText: "日本語 couldn't be loaded" });
    await expect(card).toContainText('annai shows English until it is online.');
    server = await startServer(port);
    const retried = page.waitForEvent('load');
    await card.getByRole('button', { name: 'Try again' }).click();
    await retried;
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    // What came from the network is kept: the next start, offline, is Japanese and has no card.
    await server.stop();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(page.locator('html')).not.toHaveAttribute('data-l10n-failed', /./);
  } finally {
    await server.stop();
  }
});

test('a setting the device\'s copy does not match writes the copy and offers a restart', async ({ page }) => {
  needJapanese();
  await openApp(page, '#/trips');
  await allowUnfinished(page);
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { updateAppSettings } = await import(at('/src/core/settings.js'));
    const store = await createIdbStore();
    await updateAppSettings(new Workspace(store), { languages: { ui: 'ja' } });
    store.close();
    localStorage.removeItem('annai.ui');
  });
  await page.reload();
  const card = page.getByRole('status').locator('.notice', { hasText: 'Restart to show annai in 日本語' });
  await expect(card).toContainText("Your settings say annai's screens are in 日本語, but this device is showing something else.");
  expect(await page.evaluate(() => localStorage.getItem('annai.ui'))).toBe('ja');
  const restarted = page.waitForEvent('load');
  await card.getByRole('button', { name: 'Restart annai' }).click();
  await restarted;
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
});

test('a restore writes the device\'s copy of the screens\' language before its restart', async ({ page }) => {
  needJapanese();
  const llm = await startModelServer({ '/b/v1/messages': [] });
  try {
    await modelSetUp(page, llm.origin);
    await allowUnfinished(page);
    await page.evaluate(async () => {
      const at = (/** @type {string} */ p) => p;
      const { createIdbStore } = await import(at('/src/core/store-idb.js'));
      const { Workspace } = await import(at('/src/core/workspace.js'));
      const { updateAppSettings } = await import(at('/src/core/settings.js'));
      const store = await createIdbStore();
      await updateAppSettings(new Workspace(store), { languages: { ui: 'ja' } });
      store.close();
    });
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Export everything' }).click();
    const file = await buildAndSave(page);
    await page.getByLabel('Type ERASE to confirm').fill('ERASE');
    await page.getByRole('button', { name: 'Erase now' }).click();
    await pastWelcome(page);
    expect(await page.evaluate(() => localStorage.getItem('annai.ui'))).toBeNull();
    await page.getByLabel('Open a trip someone sent you').setInputFiles(file);
    await page.getByLabel('Replace my settings').check();
    await page.getByRole('button', { name: 'Import' }).click();
    await expect(page.getByText('Restart annai to use the imported settings and plugins.')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => localStorage.getItem('annai.ui'))).toBe('ja');
  } finally {
    await llm.stop();
  }
});

test('under Japanese screens an English line is English, a script annai cannot tell is no language, and a Chinese title gets no Maru', async ({ page }) => {
  needJapanese();
  await openApp(page, '#/trips');
  const trip = await startTrip(page, 'Kyoto Spring');
  await writeEvent(page, trip, { type: 'out.speak', data: { text: 'Kiyomizu-dera opens at 6.' } });
  await writeEvent(page, trip, { type: 'out.speak', data: { text: '清水寺は朝6時に開きます。' } });
  await writeEvent(page, trip, { type: 'out.speak', data: { text: 'আমি কিয়োটো যাচ্ছি' } });
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { updateAppSettings } = await import(at('/src/core/settings.js'));
    const store = await createIdbStore();
    await updateAppSettings(new Workspace(store), { languages: { spoken: ['en', 'ja'], ui: 'ja' } });
    store.close();
    localStorage.setItem('annai.ui', 'ja');
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.evaluate(() => { location.hash = '#/talk'; });
  const lines = page.locator('.convo li.shiori > p');
  await expect(lines).toHaveCount(3);
  // Not the screens' Japanese: the English line is English, the Bengali one has none (an empty lang, not an absent one).
  expect(await lines.evaluateAll((els) => els.map((el) => el.getAttribute('lang')))).toEqual(['en', 'ja', '']);
  const fonts = await page.evaluate(() => {
    const display = (/** @type {string} */ lang) => {
      const el = document.createElement('h2');
      el.lang = lang;
      document.body.append(el);
      const v = getComputedStyle(el).getPropertyValue('--f-display');
      el.remove();
      return v;
    };
    return { page: getComputedStyle(document.documentElement).getPropertyValue('--f-display'), ja: display('ja'), zh: display('zh-Hans'), ko: display('ko') };
  });
  expect(fonts.page).toContain('Hiragino Maru Gothic ProN');
  expect(fonts.ja).toContain('Hiragino Maru Gothic ProN');
  expect(fonts.zh).not.toContain('Hiragino');
  expect(fonts.ko).not.toContain('Hiragino');
});

test('under Japanese screens the languages you speak are named in Japanese, each with its own name beside it', async ({ page }) => {
  needJapanese();
  // All through the screen, as a user does it: a write of the settings from the test could race annai's own at the start.
  await openApp(page, '#/shiori');
  await allowUnfinished(page);
  await page.evaluate(() => { location.hash = '#/shiori'; });
  const restarted = page.waitForEvent('load');
  await page.getByRole('region', { name: 'Languages' }).getByLabel(SCREENS).selectOption('ja');
  await restarted;
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  const panel = page.getByRole('region', { name: JA[key('Languages')], exact: true });
  const status = panel.getByRole('status');
  await panel.locator('#language-add').selectOption('ja');
  await panel.getByRole('button', { name: JA[key('Add')], exact: true }).click();
  await expect(status).toHaveText(JA[key('Added {0}. Saved')].replace('{0}', '日本語'));
  await expect(panel.locator('li[data-lang="en"] .lang-name')).toHaveText('英語 English');
  await expect(panel.locator('li[data-lang="ja"] .lang-name')).toHaveText('日本語');
  await expect(panel.locator('#language-answer option[value="en"]')).toHaveText(JA[key('{0} · {1}')].replace('{0}', '英語').replace('{1}', 'English'));
  await panel.locator('#language-answer').selectOption('en');
  await expect(status).toHaveText(JA[key('Shiori answers in {0}. Saved')].replace('{0}', '英語'));
  await panel.getByRole('button', { name: JA[key('Remove {0}')].replace('{0}', '英語') }).click();
  await expect(status).toHaveText(JA[key('{0} removed; Shiori answers in the language you speak to her again. Saved')].replace('{0}', '英語'));
});

test('under Japanese screens a trip card\'s name carries its own language, not the screens\'', async ({ page }) => {
  needJapanese();
  await openApp(page, '#/trips');
  for (const name of ['云南国庆之旅', '京都の紅葉', 'Kyoto Spring']) {
    await page.evaluate(() => { location.hash = '#/trips'; });
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await startTrip(page, name);
  }
  await allowUnfinished(page);
  await page.evaluate(() => { location.hash = '#/shiori'; });
  const restarted = page.waitForEvent('load');
  await page.getByRole('region', { name: 'Languages' }).getByLabel(SCREENS).selectOption('ja');
  await restarted;
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.evaluate(() => { location.hash = '#/trips'; });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(TRIPS_JA);
  const names = page.locator('.trip-card .name');
  await expect(names).toHaveCount(3);
  const langs = Object.fromEntries(await names.evaluateAll((els) => els.map((el) => [el.textContent, el.getAttribute('lang')])));
  expect(langs).toEqual({ '云南国庆之旅': 'zh-Hans', '京都の紅葉': 'ja', 'Kyoto Spring': 'en' });
  await expect(names.first()).toHaveAttribute('dir', 'auto');
});

test('Don\'t restart, on the card that waits for Shiori, gives the row back and says the change waits', async ({ page }) => {
  needJapanese();
  const reply = { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'Low tide is at 5:40.' } }, { name: 'sleep', input: {} }]), delayMs: 6000 };
  const llm = await startModelServer({ '/b/v1/messages': [reply] });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/trips');
    await startTrip(page, 'Big Sur');
    await allowUnfinished(page);
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('When is low tide?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1);
    await page.evaluate(() => { location.hash = '#/shiori'; });
    const row = page.locator('#language-ui');
    await row.selectOption('ja');
    const card = page.getByRole('status').locator('.notice', { hasText: 'annai restarts once Shiori has finished' });
    await expect(card).toBeVisible();
    await expect(row).toBeDisabled();
    await card.getByRole('button', { name: "Don't restart" }).click();
    await expect(row).toBeEnabled();
    await expect(row.locator('xpath=ancestor::div[contains(@class,"saving")]').locator('.saved')).toHaveText('Saved. It applies the next time annai restarts.');
    await expect(row).toHaveValue('ja');
  } finally {
    await llm.stop();
  }
});
