import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, addProvider, koeSetUp, startModelServer, anthropicToolReply, filterTrace } from './helpers.js';

// Koe and Kokoro, K1: the text split (docs/superpowers/specs/2026-10-19-koe-kokoro-design.md).

test("Models shows Koe's two lists right after Main, each with a line on when it is used: Realtime takes realtime models, Classic chat models (the user, 2026-10-22)", async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  const roles = page.getByRole('region', { name: 'Roles' });
  await expect(roles.locator('h3')).toHaveText([
    'Main: talks with you', 'Koe · Realtime: hears you and speaks in one stream', 'Koe · Classic: a chat model, with Speech in and Speech out',
    'Utility: summaries and small jobs', 'Quick decision: yes-or-no checks', 'Speech in: how Shiori hears you', "Speech out: Shiori's voice",
  ]);
  const realtime = roles.locator('.role').nth(1);
  const classic = roles.locator('.role').nth(2);
  await expect(realtime.getByText('Koe uses it while voice is on and Realtime is chosen on the voice chip. When none here can answer, Classic does.')).toBeVisible();
  await expect(realtime.getByText('Empty: Koe has no realtime voice, so Classic answers.', { exact: false })).toBeVisible();
  await expect(classic.getByText("Koe uses it when Classic is chosen, while voice is off, and when Realtime can't answer", { exact: false })).toBeVisible();
  await expect(classic.getByText('Empty: in Classic, Shiori is one half, the main model. Add a fast model here to give her a quick voice in front.')).toBeVisible();
  // A live session takes no level and has its own wait: Realtime shows neither.
  await expect(realtime.getByLabel('Reasoning for Koe · Realtime')).toHaveCount(0);
  await expect(realtime.getByLabel('Wait for the first words (seconds)')).toHaveCount(0);
  await expect(classic.getByLabel('Reasoning for Koe · Classic')).toHaveValue('low');
  await expect(classic.getByLabel('Wait for the first words (seconds)')).toHaveAttribute('placeholder', '8');
  await addProvider(page, 'Custom provider', { ability: 'Chat Completions', name: 'Fast', url: 'https://fast.example.test/v1', key: 'sk-fast', model: 'fast-model', look: false });
  await expect(page.getByLabel('Add a model to Koe · Realtime')).toHaveCount(0);
  await page.getByLabel('Add a model to Koe · Classic').selectOption({ label: 'fast-model' });
  await page.getByRole('button', { name: 'Add to Koe · Classic' }).click();
  await expect(roles.locator('.role').nth(2).getByText('1. fast-model')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Roles' }).locator('.role').nth(2).getByText('1. fast-model')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Roles' }).locator('.role').nth(0).getByText('No models yet. Add one.')).toBeVisible();
});

/** The stand-ins: Koe defers and asks; Kokoro answers through Koe after a while; Koe says it in its own words. @param {number} kokoroMs */
function halves(kokoroMs) {
  const sse = (/** @type {{ name: string, input: any }[]} */ calls) => ({ status: 200, type: 'text/event-stream', body: anthropicToolReply(calls) });
  const sleep = { name: 'sleep', input: {} };
  return {
    '/koe/v1/messages': [
      sse([{ name: 'speak', input: { text: "I'm checking." } }, { name: 'tell_kokoro', input: { text: 'Is Nepenthe open now?' } }, sleep]),
      sse([{ name: 'speak', input: { text: "Good news: it's open till 10 tonight." } }, sleep]),
    ],
    '/kokoro/v1/messages': [
      { ...sse([{ name: 'tell_koe', input: { text: 'Nepenthe is open till 10 tonight (nepenthe.com).' } }, sleep]), delayMs: kokoroMs },
      sse([sleep]),
    ],
  };
}

/** @param {import('@playwright/test').Page} page @param {string} text */
async function type(page, text) {
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Message to Shiori').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Switches off "Show what the halves tell each other" in Settings → Shiori, and waits for it to save. @param {import('@playwright/test').Page} page */
async function hideHalves(page) {
  await page.goto('/#/shiori');
  await page.getByLabel('Show what the halves tell each other').uncheck();
  await expect(page.locator('.saving', { hasText: 'Show what the halves tell each other' }).locator('.saved')).toHaveText('Saved');
}

test('a typed question: Koe\'s bubble at once, the "Kokoro is working" sign, then Koe\'s answer from Kokoro; with the halves\' notes hidden, the conversation shows only you and Koe', async ({ page }) => {
  const llm = await startModelServer(halves(2500));
  try {
    await koeSetUp(page, llm.origin);
    await hideHalves(page);
    await type(page, 'Is Nepenthe open?');
    const said = page.locator('.convo .shiori p');
    await expect(said.first()).toHaveText("I'm checking.");
    const sign = page.getByRole('status').filter({ hasText: 'Kokoro is working' });
    await expect(sign).toBeVisible();
    await expect(said.last()).toHaveText("Good news: it's open till 10 tonight.", { timeout: 15_000 });
    await expect(sign).toBeHidden();
    await expect(page.locator('.convo > li')).toHaveCount(3);
    await expect(page.locator('.convo .system-line, .convo .halves-note')).toHaveCount(0);
    expect(llm.bodies('/kokoro/v1/messages')[0].system.at(-1).text).toContain('# Working behind Koe');
  } finally {
    await llm.stop();
  }
});

test("Trace shows both halves' turns and their notes; the notes show in the conversation by default, and Settings → Shiori hides them", async ({ page }) => {
  const llm = await startModelServer(halves(300));
  try {
    await koeSetUp(page, llm.origin);
    await type(page, 'Is Nepenthe open?');
    await expect(page.locator('.convo .shiori p').last()).toHaveText("Good news: it's open till 10 tonight.", { timeout: 15_000 });
    await page.getByRole('link', { name: 'Trace' }).click();
    await filterTrace(page, { kind: 'Halves' });
    await expect(page.getByText('Koe to Kokoro · append · Is Nepenthe open now?')).toBeVisible();
    await expect(page.getByText('Kokoro to Koe · append · Nepenthe is open till 10 tonight (nepenthe.com).')).toBeVisible();
    await filterTrace(page, { kind: 'Models', type: 'model.turn' });
    await expect(page.getByText(/Koe · koe-classic: koe-model · 1 attempt/).first()).toBeVisible();
    await expect(page.getByText(/Kokoro · main: kokoro-model · 1 attempt/).first()).toBeVisible();
    // On by default (the user, 2026-10-23: "always on by default and able to be turned off in the settings"), and no switch on the conversation.
    await page.goto('/#/talk');
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await expect(page.locator('.convo .halves-note').filter({ hasText: 'Koe to Kokoro: Is Nepenthe open now?' })).toBeVisible();
    await expect(page.locator('.convo .halves-note').filter({ hasText: 'Kokoro to Koe: Nepenthe is open till 10 tonight' })).toBeVisible();
    await expect(page.getByLabel('Show what the halves tell each other')).toHaveCount(0);
    await page.goto('/#/shiori');
    const toggle = page.getByLabel('Show what the halves tell each other');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible();
    await page.goto('/#/talk');
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await expect(page.locator('.convo .shiori p').last()).toHaveText("Good news: it's open till 10 tonight.");
    await expect(page.locator('.convo .halves-note')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await expect(page.locator('.convo .shiori p').last()).toBeVisible();
    await expect(page.locator('.convo .halves-note')).toHaveCount(0);
    await page.goto('/#/shiori');
    await expect(page.getByLabel('Show what the halves tell each other')).not.toBeChecked();
  } finally {
    await llm.stop();
  }
});

test("the halves' notes are notes of their own, set apart from her reminders; annai's blocks to them stay in the Trace; the announcer says her lines, never the notes or what you typed (fix pass 2, item 9)", async ({ page }) => {
  const llm = await startModelServer(halves(300));
  try {
    await koeSetUp(page, llm.origin);
    await page.goto('/#/talk');
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      const announcer = /** @type {HTMLElement} */ (document.querySelector('main [aria-live="polite"]'));
      w.announced = [];
      new MutationObserver(() => w.announced.push(announcer.textContent)).observe(announcer, { childList: true, characterData: true, subtree: true });
    });
    await type(page, 'Is Nepenthe open?');
    await expect(page.locator('.convo .shiori p').last()).toHaveText("Good news: it's open till 10 tonight.", { timeout: 15_000 });
    const notes = page.locator('.convo .halves-note');
    // Each ends with the model that wrote it (phone-fixes-1 item 12).
    await expect(notes).toHaveText([/^Koe to Kokoro: Is Nepenthe open now\?/, /^Kokoro to Koe: Nepenthe is open till 10 tonight \(nepenthe\.com\)\./]);
    await expect(notes.locator('.by')).toHaveCount(2);
    expect(await notes.first().evaluate((el) => [el.classList.contains('system-line'), getComputedStyle(el).borderTopStyle])).toEqual([false, 'dashed']);
    await expect(page.locator('.convo li', { hasText: /^annai to / })).toHaveCount(0);
    expect(await page.evaluate(() => /** @type {any} */ (window).announced)).toEqual(["Shiori: I'm checking.", "Shiori: Good news: it's open till 10 tonight."]);
  } finally {
    await llm.stop();
  }
});

test("the sign's Stop ends Kokoro's turn and leaves Koe", async ({ page }) => {
  const llm = await startModelServer(halves(20_000));
  try {
    await koeSetUp(page, llm.origin);
    await type(page, 'Is Nepenthe open?');
    await expect(page.locator('.convo .shiori p').first()).toHaveText("I'm checking.");
    const sign = page.getByRole('status').filter({ hasText: 'Kokoro is working' });
    await expect(sign).toBeVisible();
    await page.getByRole('button', { name: 'Stop Kokoro' }).click();
    await expect(sign).toBeHidden();
    await expect(page.locator('.convo .shiori p')).toHaveText(["I'm checking."]);
    await expect(page.getByText("Shiori can't reach her model")).toHaveCount(0);
    // Koe still talks.
    await type(page, 'Thanks');
    await expect(page.locator('.convo .shiori p').last()).toHaveText("Good news: it's open till 10 tonight.");
  } finally {
    await llm.stop();
  }
});
