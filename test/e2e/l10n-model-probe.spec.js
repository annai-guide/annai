import { test, expect } from '@playwright/test';
import { startModelServer, modelSetUp, koeSetUp, anthropicToolReply } from './helpers.js';
import { accented } from '../../src/core/l10n-pseudo.js';

// A model's words stay English (localization L5h, the L5f review's probe made a test): a whole session under the en-XA pseudo-locale,
// every request the model gets recorded. A message, tools that answer and tools that refuse, a card, a model that fails and the turn
// after it, and the model's Test: if any of annai's words a model reads went through t, its pseudo text would be in a request.
// Only the quick asks (asUser, the user's own words) may be pseudo text, and this session sends none. A second session has Shiori as two
// halves (Koe · Classic in front of Kokoro), and a file brought into the trip wakes her: the halves' instructions, blocks and notes,
// and annai's wake lines.

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const reply = (/** @type {{ name: string, input: any }[]} */ calls, text = '') => sse(anthropicToolReply(calls, text));
/** en-XA's marks: its brackets, and letters no English or test data here has. */
const PSEUDO = /[⟦⟧ƀƒĝĥĵķļɱṕǫŕśţṽŵẋžḂḞĜĤĴĶĻṀṔǪŔŢṼŴẊ]/;

/** Where a pseudo word reached a model, by request. @param {any[]} bodies @param {string} who */
const leaksIn = (bodies, who) => bodies.flatMap((b, i) => {
  const text = JSON.stringify(b);
  const at = text.search(PSEUDO);
  return at < 0 ? [] : [`${who} request ${i + 1}: …${text.slice(Math.max(0, at - 80), at + 80)}…`];
});
/** Opens the dock's text box and sends a message. @param {import('@playwright/test').Page} page @param {string} text */
async function say(page, text) {
  await page.getByRole('button', { name: accented('Type'), exact: true }).click();
  await page.locator('#dock-text').fill(text);
  await page.locator('#dock-text').press('Enter');
}

test("under en-XA, every request a model gets is annai's English: tools, refusals, a card, a failed turn and the model's Test", async ({ page }) => {
  test.setTimeout(120_000);
  const llm = await startModelServer({
    '/b/v1/messages': [
      // A message: tools that answer, tools that refuse (a missing file, a path outside the trip, a watch it can't set).
      reply([{ name: 'read', input: { path: '/trip/missing.md' } }, { name: 'list', input: { path: '/nowhere/' } }, { name: 'watch_set', input: { when: { type: 'time', at: 'tomorrow' }, reminder: 'Tea' } }]),
      reply([{ name: 'show', input: { title: 'Morning', text: 'Coffee at Nepenthe.' } }, { name: 'speak', input: { text: 'Here is the plan.' } }, { name: 'sleep', input: {} }]),
      // The next message: the model refuses it, so the turn fails and the user sees a card.
      { status: 400, type: 'application/json', body: '{"type":"error","error":{"type":"invalid_request_error","message":"Bad request"}}' },
      // The one after: the model reads what happened in between.
      reply([{ name: 'speak', input: { text: 'Back again.' } }, { name: 'sleep', input: {} }]),
    ],
  });
  try {
    await modelSetUp(page, llm.origin, 'Big Sur', { look: false });
    await page.goto('/?l10n=en-XA#/talk');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
    const asked = () => llm.bodies('/b/v1/messages').length;
    await say(page, 'Plan our morning');
    await expect.poll(asked, { timeout: 30_000 }).toBe(2);
    await expect(page.locator('main').getByText('Here is the plan.').first()).toBeVisible();
    await say(page, 'And the afternoon?');
    await expect.poll(asked, { timeout: 30_000 }).toBe(3);
    await say(page, 'Try again');
    await expect.poll(asked, { timeout: 30_000 }).toBe(4);
    await expect(page.locator('main').getByText('Back again.').first()).toBeVisible();
    // The model's Test from its page: its prompt and its tools are English too.
    await page.goto('/?l10n=en-XA#/models');
    await page.locator('main a[href^="#/models/model?id="]').first().click();
    await page.getByRole('button', { name: accented('Test'), exact: true }).click();
    await expect.poll(asked, { timeout: 30_000 }).toBeGreaterThan(4);
    await expect(page.locator('main li.ok, main li.bad').first()).toBeVisible({ timeout: 30_000 });
    expect(leaksIn(llm.bodies('/b/v1/messages'), 'main')).toEqual([]);
    // The probe can see a leak: the screens around it are pseudo text.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  } finally {
    await llm.stop();
  }
});

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:tea@example', 'DTSTART:20261127T160000Z', 'DTEND:20261127T170000Z', 'SUMMARY:Tea at the inn', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

test("under en-XA, Shiori as two halves and a wake from a file brought in: every request either half gets is annai's English", async ({ page }) => {
  test.setTimeout(120_000);
  const sleep = { name: 'sleep', input: {} };
  const llm = await startModelServer({
    '/koe/v1/messages': [
      reply([{ name: 'speak', input: { text: "I'm checking." } }, { name: 'tell_kokoro', input: { text: 'Is Nepenthe open now?' } }, sleep]),
      reply([{ name: 'speak', input: { text: 'It is open till ten.' } }, sleep]),
      reply([sleep]),
    ],
    '/kokoro/v1/messages': [
      reply([{ name: 'read', input: { path: '/trip/missing.md' } }, { name: 'tell_koe', input: { text: 'Nepenthe is open till 10 tonight.' } }, sleep]),
      reply([sleep]),
    ],
  });
  try {
    await koeSetUp(page, llm.origin);
    const trip = await page.evaluate(() => decodeURIComponent(location.hash.split('/')[2] ?? ''));
    await page.goto('/?l10n=en-XA#/talk');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
    await say(page, 'Is Nepenthe open?');
    await expect(page.locator('main').getByText('It is open till ten.').first()).toBeVisible({ timeout: 20_000 });
    const asked = () => llm.bodies('/koe/v1/messages').length + llm.bodies('/kokoro/v1/messages').length;
    const before = asked();
    // A calendar brought into the trip: a plan item is made from it, and Shiori is woken with what came in.
    await page.evaluate((id) => { location.hash = `#/trip/${encodeURIComponent(id)}`; }, trip);
    await page.locator('#upload-file').setInputFiles({ name: 'tea.ics', mimeType: 'text/calendar', buffer: Buffer.from(ICS) });
    await expect.poll(asked, { timeout: 30_000 }).toBeGreaterThan(before);
    const all = [...llm.bodies('/koe/v1/messages'), ...llm.bodies('/kokoro/v1/messages')].map((b) => JSON.stringify(b)).join('\n');
    expect(all).toContain('# Working behind Koe');
    expect(all).toContain('tea.ics');
    expect([...leaksIn(llm.bodies('/koe/v1/messages'), 'Koe'), ...leaksIn(llm.bodies('/kokoro/v1/messages'), 'Kokoro')]).toEqual([]);
  } finally {
    await llm.stop();
  }
});
