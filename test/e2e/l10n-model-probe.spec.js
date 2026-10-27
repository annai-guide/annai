import { test, expect } from '@playwright/test';
import { startModelServer, modelSetUp, anthropicToolReply } from './helpers.js';
import { accented } from '../../src/core/l10n-pseudo.js';

// A model's words stay English (localization L5h, the L5f review's probe made a test): a whole session under the en-XA pseudo-locale,
// every request the model gets recorded. A message, tools that answer and tools that refuse, a card, a model that fails and the turn
// after it, and the model's Test: if any of annai's words a model reads went through t, its pseudo text would be in a request.
// Only the quick asks (asUser, the user's own words) may be pseudo text, and this session sends none.

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const reply = (/** @type {{ name: string, input: any }[]} */ calls, text = '') => sse(anthropicToolReply(calls, text));
/** en-XA's marks: its brackets, and letters no English or test data here has. */
const PSEUDO = /[⟦⟧ƀƒĝĥĵķļɱṕǫŕśţṽŵẋžḂḞĜĤĴĶĻṀṔǪŔŢṼŴẊ]/;

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
    const say = async (/** @type {string} */ text) => {
      await page.getByRole('button', { name: accented('Type'), exact: true }).click();
      await page.locator('#dock-text').fill(text);
      await page.locator('#dock-text').press('Enter');
    };
    const asked = () => llm.bodies('/b/v1/messages').length;
    await say('Plan our morning');
    await expect.poll(asked, { timeout: 30_000 }).toBe(2);
    await expect(page.locator('main').getByText('Here is the plan.').first()).toBeVisible();
    await say('And the afternoon?');
    await expect.poll(asked, { timeout: 30_000 }).toBe(3);
    await say('Try again');
    await expect.poll(asked, { timeout: 30_000 }).toBe(4);
    await expect(page.locator('main').getByText('Back again.').first()).toBeVisible();
    // The model's Test from its page: its prompt and its tools are English too.
    await page.goto('/?l10n=en-XA#/models');
    await page.locator('main a[href^="#/models/model?id="]').first().click();
    await page.getByRole('button', { name: accented('Test'), exact: true }).click();
    await expect.poll(asked, { timeout: 30_000 }).toBeGreaterThan(4);
    await expect(page.locator('main li.ok, main li.bad').first()).toBeVisible({ timeout: 30_000 });
    const leaks = llm.bodies('/b/v1/messages').flatMap((b, i) => {
      const text = JSON.stringify(b);
      const at = text.search(PSEUDO);
      return at < 0 ? [] : [`request ${i + 1}: …${text.slice(Math.max(0, at - 80), at + 80)}…`];
    });
    expect(leaks).toEqual([]);
    // The probe can see a leak: the screens around it are pseudo text.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  } finally {
    await llm.stop();
  }
});
