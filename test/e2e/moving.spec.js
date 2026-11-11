// Moving into a trip (the timeline design, "Moving into a trip"; stage 6, as annai's card since the user's pick of 2026-11-11, "She asks, I
// tap or say yes"): in a chat the user asks to carry on in Kyoto, Shiori calls open_trip, and annai's own card asks "Carry on in Kyoto, …?".
// Open opens Kyoto at once, with the user's last line and her recap, and she answers there; the chat stays, its last line saying where they
// went. Not now keeps them there, nothing moved. Where the user is looking when an answer arrives (a spoken yes; here the page's agent answers
// the card) decides what the screen does: from home the address follows, as a new entry, so Back returns home; Details and Settings stay
// where they are. The stand-in model plays her part. Synthetic data only: Kyoto and the ramen place are made up.
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, addProvider, startModelServer, anthropicToolReply, startTrip, goToHash } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const LINE = "Let's carry on in Kyoto";
const RECAP = 'We were looking for the ramen place by the station.';
const STAYING = 'We stay here, then.';
const ANSWER = 'Here in Kyoto: shall I put the ramen place on the plan?';
/** annai's question: Kyoto's name and dates, as the screens write them (en, the page's default). */
const ASKED = /^Carry on in Kyoto, Apr 1\s*[–-]\s*8(, 2027)?\?$/;

/**
 * Her part: in the chat she calls open_trip, and with its result (they didn't choose Open) she carries on there; in Kyoto, told they came, she
 * answers. @param {{ id: string }} kyoto its id, known once the trip is made
 */
const shiori = (kyoto) => (/** @type {any} */ body) => {
  const all = JSON.stringify(body?.messages ?? []);
  const last = JSON.stringify(body?.messages?.at(-1) ?? {});
  if (all.includes('You moved the user here')) return sse(anthropicToolReply([{ name: 'speak', input: { text: ANSWER } }, { name: 'sleep', input: {} }]));
  if (/"tool_result"/.test(last)) return sse(anthropicToolReply([{ name: 'speak', input: { text: STAYING } }, { name: 'sleep', input: {} }]));
  return sse(anthropicToolReply([{ name: 'open_trip', input: { trip: kyoto.id, recap: RECAP } }]));
};

const hashOf = (/** @type {import('@playwright/test').Page} */ page) => new URL(page.url()).hash;
/** A conversation's lines of a kind, as the page's store has them. @param {import('@playwright/test').Page} page @param {string} scope @param {string} type */
const linesIn = (page, scope, type) => page.evaluate(async ({ scope, type }) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  const lines = await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: [type] }));
  store.close();
  return lines.map((/** @type {any} */ e) => String(e.data?.text ?? ''));
}, { scope, type });

/**
 * The stand-in as her model, Kyoto (dated), and a chat with the user's line sent in it, until annai's card shows. The page's agent is kept
 * from that send on (window.agent), so a test can answer the card as a spoken yes would, from wherever the user is.
 * @param {import('@playwright/test').Page} page @param {string} origin @param {{ id: string }} kyoto
 */
async function cardInChat(page, origin, kyoto) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await expect(page.getByLabel('Add a model to main').locator('option', { hasText: 'b-model' })).toHaveCount(0);
  await page.goto('/#/trips');
  kyoto.id = await startTrip(page, 'Kyoto', { start: '2027-04-01', end: '2027-04-08' });
  await page.goto('/#/trips');
  const chat = await startTrip(page, 'Ramen crawl');
  await page.goto(`/#/trip/${chat}/talk`);
  await expect(page.getByRole('heading', { level: 1, name: 'Conversation' })).toBeVisible();
  await page.evaluate(async () => {
    const { Halves } = await import(/** @type {string} */ ('/src/core/agent/halves.js'));
    const send = Halves.prototype.send;
    Halves.prototype.send = function (/** @type {any[]} */ ...a) {
      /** @type {any} */ (window).agent = this;
      return send.apply(this, a);
    };
  });
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Message to Shiori').fill(LINE);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.convo .you p').last()).toHaveText(LINE);
  const card = page.locator('.convo li', { has: page.locator('p', { hasText: ASKED }) });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('.who')).toHaveText('annai');
  return { chat, card };
}

/** The page answers annai's card as a heard yes would: wherever the user is looking. @param {import('@playwright/test').Page} page */
const answerOpen = (page) => page.evaluate(() => {
  const agent = /** @type {any} */ (window).agent;
  agent.answer(agent.kokoro.pendingId, 'Open');
});

test("Open, tapped on annai's card: Kyoto opens at once, its first line the user's with a way back, then her recap and her answer; the chat ends saying where they went", async ({ page }) => {
  const kyoto = { id: '' };
  const server = await startModelServer({ '/b/v1/messages': shiori(kyoto) });
  try {
    const { chat, card } = await cardInChat(page, server.origin, kyoto);
    // Nothing moved before the answer.
    expect(hashOf(page)).toBe(`#/trip/${chat}/talk`);
    expect(await linesIn(page, kyoto.id, 'msg.user')).toEqual([]);
    await card.getByRole('button', { name: 'Open', exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(`#/trip/${kyoto.id}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Kyoto');
    // Kyoto's first line is the user's, saying where it came from, a way back there; then her recap, as her line; then her answer.
    const first = page.locator('.convo > li').first();
    await expect(first.locator('p')).toHaveText(LINE);
    await expect(first.getByRole('link', { name: 'From Ramen crawl' })).toHaveAttribute('href', `#/trip/${chat}/talk`);
    await expect(page.locator('.convo .shiori p')).toHaveText([RECAP, ANSWER], { timeout: 15_000 });
    await expect(page.getByText('Shiori woke to look at the files you added.')).toHaveCount(0); // no files went
    // The chat stays: their line, annai's card (answered), and where they went, a way to Kyoto's conversation; nothing of hers about going.
    await first.getByRole('link', { name: 'From Ramen crawl' }).click();
    await expect.poll(() => hashOf(page)).toBe(`#/trip/${chat}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Ramen crawl');
    await expect(page.locator('.convo .you p').first()).toHaveText(LINE);
    await expect(page.locator('.convo .shiori p')).toHaveText([ASKED]);
    await expect(page.locator('.convo .shiori').getByRole('button', { name: 'Open', exact: true })).toBeDisabled();
    await expect(page.locator('.convo .system-line a', { hasText: 'Shiori moved this to Kyoto.' })).toHaveAttribute('href', `#/trip/${kyoto.id}/talk`);
  } finally {
    await server.stop();
  }
});

test("Not now on annai's card: they stay in the chat, nothing is written into Kyoto, and she carries on there", async ({ page }) => {
  const kyoto = { id: '' };
  const server = await startModelServer({ '/b/v1/messages': shiori(kyoto) });
  try {
    const { chat, card } = await cardInChat(page, server.origin, kyoto);
    await card.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText(STAYING, { timeout: 15_000 });
    expect(hashOf(page)).toBe(`#/trip/${chat}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Ramen crawl');
    expect(await linesIn(page, kyoto.id, 'msg.user')).toEqual([]);
    expect(await linesIn(page, kyoto.id, 'out.speak')).toEqual([]);
    await expect(page.locator('.convo .system-line', { hasText: 'moved this' })).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test('an answer that arrives with home showing: the address follows into Kyoto as a new entry, so Back returns home', async ({ page }) => {
  const kyoto = { id: '' };
  const server = await startModelServer({ '/b/v1/messages': shiori(kyoto) });
  try {
    await cardInChat(page, server.origin, kyoto);
    await goToHash(page, '#/trips'); // home, while the card waits
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await answerOpen(page);
    await expect.poll(() => hashOf(page)).toBe(`#/trip/${kyoto.id}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Kyoto');
    await expect(page.locator('.convo .shiori p').last()).toHaveText(ANSWER, { timeout: 15_000 });
    await page.goBack();
    await expect.poll(() => hashOf(page)).toBe('#/trips');
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  } finally {
    await server.stop();
  }
});

for (const where of ['Details', 'Settings']) {
  test(`a ${where} screen stays where it is when the answer arrives, and she answers in Kyoto`, async ({ page }) => {
    const kyoto = { id: '' };
    const server = await startModelServer({ '/b/v1/messages': shiori(kyoto) });
    try {
      const { chat } = await cardInChat(page, server.origin, kyoto);
      const to = where === 'Details' ? `#/trip/${chat}` : '#/settings';
      await goToHash(page, to); // while the card waits
      await expect(page.getByRole('heading', { level: 1, name: where === 'Details' ? 'Ramen crawl' : 'Settings' })).toBeVisible();
      await answerOpen(page);
      await expect.poll(() => linesIn(page, kyoto.id, 'out.speak'), { timeout: 30_000 }).toEqual([ANSWER]);
      await page.waitForTimeout(500); // past the redraw `went` asks for
      expect(hashOf(page)).toBe(to);
      await expect(page.getByRole('heading', { level: 1, name: where === 'Details' ? 'Ramen crawl' : 'Settings' })).toBeVisible();
    } finally {
      await server.stop();
    }
  });
}
