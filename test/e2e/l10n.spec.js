import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { openApp, unmarked, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply, startTrip, writeRecords, writeEvent, startServer, modelSetUp, buildAndSave, pastWelcome } from './helpers.js';
import { parseHeaders, headersFor } from '../../scripts/headers.mjs';
import { key } from '../../src/core/l10n.js';
import { accented } from '../../src/core/l10n-pseudo.js';
import { seedMorning } from './after-kit.js';

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
  await openApp(page, '?l10n=en-XA#/languages');
  const panel = page.getByRole('region', { name: accented('Languages') });
  await expect(page.getByRole('heading', { level: 1, name: accented('Languages') })).toBeVisible();
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
  await page.goto('/#/languages');
  const panel = page.getByRole('region', { name: 'Languages' });
  await panel.getByLabel('Add a language').selectOption('ja');
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Added Japanese. Saved');
  await expect(panel.locator('.role-item [lang="ja"]')).toHaveText('日本語');
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

test("a personality tuning's card is titled in the screens' words on Talk, Now and the replay, never the stored English (L5h review 7)", async ({ page }) => {
  await openApp(page, '#/trips');
  const trip = await startTrip(page, 'Kyoto Spring');
  await writeEvent(page, trip, { type: 'out.show', data: { id: 'tune-1', card: { title: 'I adjusted my personality', text: '少し短く話すことにしました。' }, tune: { name: 'default', old: null } } });
  const title = accented('I adjusted my personality');
  await page.goto('/?l10n=en-XA#/talk');
  await expect(page.locator('.convo .card-title')).toHaveText(title);
  await expect(page.locator('.convo .card-title')).not.toHaveAttribute('lang', /./);
  await expect(page.locator('.convo .md')).toHaveAttribute('lang', 'ja');
  await page.evaluate(() => { location.hash = '#/now'; });
  await expect(page.locator('.shiori-card .card-title')).toHaveText(title);
  await page.evaluate((id) => { location.hash = `#/trip/${encodeURIComponent(id)}/replay`; }, trip);
  const timeline = page.locator('main ol, main ul').filter({ hasText: title }).first();
  await timeline.getByRole('button', { name: new RegExp(title.slice(0, 8)) }).first().click();
  await expect(page.locator('.replay-shown .card-title')).toHaveText(title);
});

test("the replay's card and the user's words carry their language, as in the Conversation", async ({ page }) => {
  await openApp(page, '#/trips');
  const trip = await startTrip(page, 'Kyoto Spring');
  await seedMorning(page, trip);
  await writeEvent(page, trip, { type: 'out.show', data: { card: { title: '清水寺', text: '直角三角形的骨架，这是我们说的。' } } });
  await writeEvent(page, trip, { type: 'msg.user', data: { text: '清水寺は何時に開きますか？' } });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/replay`);
  await expect(page.getByRole('heading', { level: 1, name: 'Replay' })).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await timeline.getByRole('button', { name: /Shiori: 清水寺/ }).click();
  await expect(page.locator('.replay-shown .card-title')).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.locator('.replay-shown .who')).not.toHaveAttribute('lang', /./);
  await timeline.getByRole('button', { name: /You: 清水寺は/ }).click();
  await expect(page.locator('.replay-shown p')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('.replay-shown p')).toHaveAttribute('dir', 'auto');
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

// Localization L4: the screens' language is a setting (the design, section 2). Japanese and Chinese ship since L6.
const JA = /** @type {Record<string, string>} */ (JSON.parse(readFileSync(new URL('../../l10n/ja.json', import.meta.url), 'utf8')));
const TRIPS_JA = JA[key('Trips')];
const ZH = /** @type {Record<string, string>} */ (JSON.parse(readFileSync(new URL('../../l10n/zh-Hans.json', import.meta.url), 'utf8')));
const HANT = /** @type {Record<string, string>} */ (JSON.parse(readFileSync(new URL('../../l10n/zh-Hant.json', import.meta.url), 'utf8')));
// Traditional Chinese is offered under Experimental until its review, then ships (l10n-zh-Hant): the tests hold for either.
const HANT_SHIPPED = /** @type {{ tag: string, status: string }[]} */ (JSON.parse(readFileSync(new URL('../../l10n/languages.json', import.meta.url), 'utf8'))).some((l) => l.tag === 'zh-Hant' && l.status === 'shipped');
const SCREENS = "annai's screens in";

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

test("annai's screens in: As this phone is set (English), then English, 日本語 and 简体中文 by their own names, with nothing to turn on, and 繁體中文 once it ships; Distances beside it (localization L6)", async ({ page }) => {
  await openApp(page, '#/languages');
  const panel = page.getByRole('region', { name: 'Languages' });
  const screens = panel.getByLabel(SCREENS);
  // The first rows, above the languages you speak.
  expect(await panel.locator('.field-label, h3').allTextContents()).toEqual([SCREENS, 'Distances', 'Languages you speak', 'Add a language', 'Shiori answers in']);
  const shipped = HANT_SHIPPED ? ['en', 'ja', 'zh-Hans', 'zh-Hant'] : ['en', 'ja', 'zh-Hans'];
  await expect(screens.locator('option')).toHaveText(['As this phone is set (English)', 'English', '日本語', '简体中文', ...(HANT_SHIPPED ? ['繁體中文'] : [])]);
  for (const tag of shipped) await expect(screens.locator(`option[value="${tag}"]`)).toHaveAttribute('lang', tag);
  // Japanese and Chinese ship; Traditional Chinese is Experimental's only unfinished translation until it does.
  await page.evaluate(() => { location.hash = '#/experimental'; });
  await expect(page.getByRole('heading', { level: 1, name: 'Experimental' })).toBeVisible();
  const unfinished = page.getByRole('region', { name: 'Unfinished translations' });
  if (HANT_SHIPPED) await expect(unfinished).toHaveCount(0);
  else await expect(unfinished.locator('li')).toHaveText(['繁體中文']);
});


test('Distances: Kilometres on an American phone shows kilometres at once and after a reload; Automatic is miles again (localization L6)', async ({ page }) => {
  await openApp(page, '#/languages');
  const distances = () => page.getByRole('region', { name: 'Languages' }).getByLabel('Distances');
  const shown = () => page.evaluate(async () => (await import(/** @type {string} */ ('/src/core/intl.js'))).distance(42.3));
  await expect(distances()).toHaveValue('');
  await expect(distances().locator('option')).toHaveText(['Automatic', 'Kilometres', 'Miles']);
  expect(await shown()).toBe('26 mi');
  await distances().selectOption('km');
  await expect.poll(shown).toBe('42 km');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Languages' })).toBeVisible();
  await expect(distances()).toHaveValue('km');
  expect(await shown()).toBe('42 km');
  await distances().selectOption('');
  await expect.poll(shown).toBe('26 mi');
  await page.reload();
  await expect(distances()).toHaveValue('');
});

test("the welcome's first step has the screens' language to choose, and choosing 日本語 restarts annai on the welcome, in Japanese (L6 review 2)", async ({ page }) => {
  await openApp(page, '#/welcome');
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to annai' })).toBeVisible();
  const screens = page.locator('main').getByLabel(SCREENS);
  await expect(screens).toHaveValue('');
  await expect(screens.locator('option')).toHaveText(['As this phone is set (English)', 'English', '日本語', '简体中文', ...(HANT_SHIPPED ? ['繁體中文'] : [])]);
  const restarted = page.waitForEvent('load');
  await screens.selectOption('ja');
  await restarted;
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(JA[key('Welcome to annai')]);
  await expect(page.locator('main #language-ui')).toHaveValue('ja');
  // The rest of the welcome goes on from there.
  await page.getByRole('button', { name: JA[key('Next')] }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(JA[key('Shiori, Koe and Kokoro')]);
});

test('choosing 日本語 keeps its words, restarts annai in Japanese, and it stays Japanese offline', async ({ page }, testInfo) => {
  const server = await startServer(8831 + testInfo.parallelIndex);
  try {
    await page.goto(`${server.origin}/#/languages`);
    await expect(page.getByRole('heading', { level: 1, name: 'Languages' })).toBeVisible();
    await waitForServiceWorker(page);
    await page.evaluate(() => { location.hash = '#/languages'; });
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
    await page.evaluate(() => { location.hash = '#/languages'; });
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
  test('As this phone is set opens annai in Japanese with its region, ja-JP, and the welcome offers it; choosing 日本語 itself needs no restart (localization L6)', async ({ page }) => {
    await openApp(page, '#/welcome');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja-JP');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(JA[key('Welcome to annai')]);
    await expect(page.locator('main #language-ui option').first()).toHaveText(JA[key('As this phone is set ({0})')].replace('{0}', '日本語'));
    await page.evaluate(() => { location.hash = '#/trips'; });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(TRIPS_JA);
    await page.evaluate(() => { location.hash = '#/languages'; });
    const screens = page.locator('#language-ui');
    await expect(screens).toHaveValue('');
    await expect(screens.locator('option').first()).toHaveText(JA[key('As this phone is set ({0})')].replace('{0}', '日本語'));
    await screens.selectOption('ja');
    await expect(page.getByText(JA[key('Saved')], { exact: true }).first()).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja-JP');
    expect(await page.evaluate(() => localStorage.getItem('annai.ui'))).toBe('ja');
  });
});

test.describe('on a phone set to Chinese (China)', () => {
  test.use({ locale: 'zh-CN' });
  test('As this phone is set opens annai in Simplified Chinese with its region, zh-Hans-CN (localization L6)', async ({ page }) => {
    await openApp(page, '#/trips');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans-CN');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ZH[key('Trips')]);
    await page.evaluate(() => { location.hash = '#/languages'; });
    await expect(page.locator('#language-ui option').first()).toHaveText(ZH[key('As this phone is set ({0})')].replace('{0}', '简体中文'));
  });
});

test.describe('on a phone set to Chinese (Taiwan)', () => {
  test.use({ locale: 'zh-TW' });
  test('Traditional Chinese is not Simplified: annai opens in Traditional Chinese with its region, zh-Hant-TW, once it ships, and in English until then (l10n-zh-Hant)', async ({ page }) => {
    await openApp(page, '#/trips');
    if (!HANT_SHIPPED) {
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
      return;
    }
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant-TW');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(HANT[key('Trips')]);
    await page.evaluate(() => { location.hash = '#/languages'; });
    await expect(page.locator('#language-ui option').first()).toHaveText(HANT[key('As this phone is set ({0})')].replace('{0}', '繁體中文'));
  });

  test('Traditional Chinese, chosen, opens in Traditional characters with the phone\'s region, zh-Hant-TW, and draws in the platform\'s Chinese fonts, never Japanese (l10n-zh-Hant)', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('annai.ui', 'zh-Hant'); } catch { /* storage blocked */ } });
    await openApp(page, '#/trips');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant-TW');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(HANT[key('Trips')]);
    const fonts = await page.evaluate(() => ({
      body: getComputedStyle(document.body).fontFamily,
      title: getComputedStyle(document.querySelector('h1.title') ?? document.body).fontFamily,
      display: getComputedStyle(document.documentElement).getPropertyValue('--f-display'),
      zh: document.documentElement.matches(':lang(zh)'),
    }));
    // No CJK font is named, so the browser picks the Traditional Chinese one by the page's lang (PingFang TC, Noto Sans CJK TC).
    for (const [where, stack] of Object.entries(fonts)) if (typeof stack === 'string') expect(stack, where).not.toMatch(/Hiragino|Noto Sans JP|Noto Sans CJK|PingFang SC|SC\b/);
    expect(fonts.zh).toBe(true);
  });
});

test.describe('on a phone set to Chinese (Hong Kong)', () => {
  test.use({ locale: 'zh-HK' });
  test('a Hong Kong phone gets the one Traditional catalog, with Taiwan\'s words, and its own region, zh-Hant-HK, once it ships (l10n-zh-Hant)', async ({ page }) => {
    await openApp(page, '#/trips');
    await expect(page.locator('html')).toHaveAttribute('lang', HANT_SHIPPED ? 'zh-Hant-HK' : 'en');
    if (HANT_SHIPPED) await expect(page.getByRole('heading', { level: 1 })).toHaveText(HANT[key('Trips')]);
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
  const site = await startSite();
  try {
    await page.goto(`${site.origin}/#/languages`);
    await expect(page.getByRole('heading', { level: 1, name: 'Languages' })).toBeVisible();
    await waitForServiceWorker(page);
    await page.evaluate(() => { location.hash = '#/languages'; });
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
  const port = 8831 + testInfo.parallelIndex;
  let server = await startServer(port);
  try {
    await page.goto(`${server.origin}/#/trips`);
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await waitForServiceWorker(page);
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
  await openApp(page, '#/trips');
  // Written where annai isn't running, so its own start can't write the copy back in between.
  await page.goto('/l10n/languages.json');
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
  await page.goto('/#/trips');
  const card = page.getByRole('status').locator('.notice', { hasText: 'Restart to show annai in 日本語' });
  await expect(card).toContainText("Your settings say annai's screens are in 日本語, but this device is showing something else.");
  expect(await page.evaluate(() => localStorage.getItem('annai.ui'))).toBe('ja');
  const restarted = page.waitForEvent('load');
  await card.getByRole('button', { name: 'Restart annai' }).click();
  await restarted;
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
});

test('a restore writes the device\'s copy of the screens\' language before its restart', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [] });
  try {
    await modelSetUp(page, llm.origin);
    await page.evaluate(async () => {
      const at = (/** @type {string} */ p) => p;
      const { createIdbStore } = await import(at('/src/core/store-idb.js'));
      const { Workspace } = await import(at('/src/core/workspace.js'));
      const { updateAppSettings } = await import(at('/src/core/settings.js'));
      const store = await createIdbStore();
      await updateAppSettings(new Workspace(store), { languages: { ui: 'ja' } });
      store.close();
    });
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
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
  // All through the screen, as a user does it: a write of the settings from the test could race annai's own at the start.
  await openApp(page, '#/languages');
  await page.evaluate(() => { location.hash = '#/languages'; });
  const restarted = page.waitForEvent('load');
  await page.getByRole('region', { name: 'Languages' }).getByLabel(SCREENS).selectOption('ja');
  await restarted;
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  const panel = page.getByRole('region', { name: JA[key('Languages')], exact: true });
  const status = panel.getByRole('status');
  await panel.locator('#language-add').selectOption('ja');
  await panel.getByRole('button', { name: JA[key('Add')], exact: true }).click();
  await expect(status).toHaveText(JA[key('Added {0}. Saved')].replace('{0}', '日本語'));
  await expect(panel.locator('li[data-id="en"] > span').first()).toHaveText('1. 英語 English');
  await expect(panel.locator('li[data-id="ja"] > span').first()).toHaveText('2. 日本語');
  await expect(panel.locator('#language-answer option[value="en"]')).toHaveText(JA[key('{0} · {1}')].replace('{0}', '英語').replace('{1}', 'English'));
  await panel.locator('#language-answer').selectOption('en');
  await expect(status).toHaveText(JA[key('Shiori answers in {0}. Saved')].replace('{0}', '英語'));
  await panel.getByRole('button', { name: JA[key('Remove {0}')].replace('{0}', '英語') }).click();
  await expect(status).toHaveText(JA[key('{0} removed; Shiori answers in the language you speak to her again. Saved')].replace('{0}', '英語'));
});

test('under Japanese screens a trip card\'s name carries its own language, not the screens\'', async ({ page }) => {
  await openApp(page, '#/trips');
  for (const name of ['云南国庆之旅', '京都の紅葉', 'Kyoto Spring']) {
    await page.evaluate(() => { location.hash = '#/trips'; });
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await startTrip(page, name);
  }
  await page.evaluate(() => { location.hash = '#/languages'; });
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

test('a language already on the device is chosen again offline: 日本語, then English, then 日本語 with no connection', async ({ page }, testInfo) => {
  const server = await startServer(8841 + testInfo.parallelIndex);
  try {
    await page.goto(`${server.origin}/#/languages`);
    await expect(page.getByRole('heading', { level: 1, name: 'Languages' })).toBeVisible();
    await waitForServiceWorker(page);
    for (const [pick, lang] of /** @type {const} */ ([['ja', /^ja$/], ['en', /^en/]])) {
      await page.evaluate(() => { location.hash = '#/languages'; });
      const restarted = page.waitForEvent('load');
      await page.locator('#language-ui').selectOption(pick);
      await restarted;
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
    }
    await server.stop();
    await page.evaluate(() => { location.hash = '#/languages'; });
    const restarted = page.waitForEvent('load');
    await page.locator('#language-ui').selectOption('ja');
    await restarted;
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  } finally {
    await server.stop();
  }
});

test('Don\'t restart, on the card that waits for Shiori, gives the row back and says the change waits', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('When is low tide?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1);
    await page.evaluate(() => { location.hash = '#/languages'; });
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

// The user, 2026-10-24: words annai sends as theirs go "in the screens' language when it's one you speak (your Languages list, or
// the phone's language if none); otherwise in English."
for (const [spoken, sent] of /** @type {const} */ ([['en', 'Where can we eat along the way?'], ['ja', JA[key('Where can we eat along the way?')]]])) {
  test(`under Japanese screens a quick ask goes to Shiori in ${spoken === 'ja' ? 'Japanese, which the user speaks' : "English, as the user doesn't speak Japanese"}`, async ({ page }) => {
    const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
    const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'ok' } }, { name: 'sleep', input: {} }]))] });
    try {
      await openApp(page, '#/models');
      await waitForServiceWorker(page);
      await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
      await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
      await page.getByRole('button', { name: 'Add to main' }).click();
      await page.goto('/#/trips');
      await startTrip(page, 'Big Sur');
      await page.evaluate(async (s) => {
        const at = (/** @type {string} */ p) => p;
        const { createIdbStore } = await import(at('/src/core/store-idb.js'));
        const { Workspace } = await import(at('/src/core/workspace.js'));
        const { updateAppSettings } = await import(at('/src/core/settings.js'));
        const store = await createIdbStore();
        await updateAppSettings(new Workspace(store), { languages: { spoken: [s], ui: 'ja' } });
        store.close();
        localStorage.setItem('annai.ui', 'ja');
      }, spoken);
      // A new hash alone doesn't restart annai: the reload does, in Japanese.
      await page.goto('/#/drive');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
      await page.locator('.quick-ask button').nth(1).click();
      await expect.poll(() => llm.bodies('/b/v1/messages').length, { timeout: 20_000 }).toBeGreaterThan(0);
      expect(JSON.stringify(llm.bodies('/b/v1/messages').at(-1).messages.at(-1))).toContain(sent);
    } finally {
      await llm.stop();
    }
  });
}

// On Japanese screens at 393 px the voice chip's menu broke オン and オフ one kana a line (the review of L5b and L5c, 2026-10-26):
// a row menu shrinks to its narrowest, and CJK breaks anywhere. phone-fit looks for overflow, not for wrapping.
test('under Japanese screens each of the voice menu\'s buttons is one line, at 393 px', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openApp(page, '#/trips');
  await startTrip(page, 'Big Sur');
  await page.evaluate(() => localStorage.setItem('annai.ui', 'ja'));
  await page.goto('/#/talk');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.locator('.voice-chip').click();
  const buttons = page.locator('#voice-menu .btn');
  await expect(buttons.first()).toBeVisible();
  const lines = await buttons.evaluateAll((all) => all.map((b) => {
    const range = document.createRange();
    range.selectNodeContents(b);
    return `${b.textContent}: ${new Set([...range.getClientRects()].filter((r) => r.width).map((r) => Math.round(r.top))).size}`;
  }));
  expect(lines.length).toBeGreaterThan(1);
  for (const l of lines) expect(l).toMatch(/: 1$/);
});
