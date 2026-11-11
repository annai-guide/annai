// Moving into a trip (the timeline design, "Moving into a trip"; stage 6): in a chat the user asks to carry on in Kyoto, and Shiori takes them
// there. Kyoto gets the user's last line and her recap and she answers there; the chat stays, its last lines saying where she went. Where
// the user is looking decides what the screen does (Review Focus 5): from home the address follows; Details and Settings stay where they
// are. The stand-in model plays her part. Synthetic data only: Kyoto and the ramen place are made up.
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, addProvider, startModelServer, anthropicToolReply, startTrip, goToHash } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const LINE = "Let's carry on in Kyoto";
const RECAP = 'We were looking for the ramen place by the station.';
const TAKING = 'Taking you to Kyoto.';
const ANSWER = 'Here in Kyoto: shall I put the ramen place on the plan?';

/**
 * Her part: in the chat she moves them to Kyoto (a moment's thought first, while the test goes elsewhere), then says where she is taking
 * them; in Kyoto, told she moved them there, she answers. @param {{ id: string }} kyoto its id, known once the trip is made
 */
const shiori = (kyoto) => (/** @type {any} */ body) => {
  const all = JSON.stringify(body?.messages ?? []);
  const last = JSON.stringify(body?.messages?.at(-1) ?? {});
  if (all.includes('You moved the user here')) return sse(anthropicToolReply([{ name: 'speak', input: { text: ANSWER } }, { name: 'sleep', input: {} }]));
  if (/"tool_result"/.test(last)) return sse(anthropicToolReply([{ name: 'speak', input: { text: TAKING } }, { name: 'sleep', input: {} }]));
  return { ...sse(anthropicToolReply([{ name: 'open_trip', input: { trip: kyoto.id, recap: RECAP } }])), delayMs: 2500 };
};

const hashOf = (/** @type {import('@playwright/test').Page} */ page) => new URL(page.url()).hash;
/** What Shiori said in a conversation, as the page's store has it. @param {import('@playwright/test').Page} page @param {string} scope */
const herLines = (page, scope) => page.evaluate(async (scope) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  const lines = await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['out.speak'] }));
  store.close();
  return lines.map((/** @type {any} */ e) => String(e.data?.text ?? ''));
}, scope);

/**
 * The stand-in as her model, Kyoto (dated), and a chat with the user's line sent in it.
 * @param {import('@playwright/test').Page} page @param {string} origin @param {{ id: string }} kyoto
 */
async function moveFromChat(page, origin, kyoto) {
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
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Message to Shiori').fill(LINE);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.convo .you p').last()).toHaveText(LINE);
  return chat;
}

test('from home, the address follows her into Kyoto: the line came with a way back, her recap, her answer there; the chat ends saying where she went', async ({ page }) => {
  const kyoto = { id: '' };
  const server = await startModelServer({ '/b/v1/messages': shiori(kyoto) });
  try {
    const chat = await moveFromChat(page, server.origin, kyoto);
    await goToHash(page, '#/trips'); // home, while she thinks
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await expect.poll(() => hashOf(page), { timeout: 30_000 }).toBe(`#/trip/${kyoto.id}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Kyoto');
    // Kyoto's first line is the user's, saying where it came from, a way back there; then her recap, as her line; then her answer.
    const first = page.locator('.convo > li').first();
    await expect(first.locator('p')).toHaveText(LINE);
    await expect(first.getByRole('link', { name: 'From Ramen crawl' })).toHaveAttribute('href', `#/trip/${chat}/talk`);
    await expect(page.locator('.convo .shiori p', { hasText: RECAP })).toHaveCount(1);
    await expect(page.locator('.convo .shiori p').last()).toHaveText(ANSWER, { timeout: 15_000 });
    await expect(page.getByText('Shiori woke to look at the files you added.')).toHaveCount(0); // no files went
    // The chat stays: every line, and where she went, a way to Kyoto's conversation.
    await first.getByRole('link', { name: 'From Ramen crawl' }).click();
    await expect.poll(() => hashOf(page)).toBe(`#/trip/${chat}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Ramen crawl');
    await expect(page.locator('.convo .you p')).toHaveText([LINE]);
    await expect(page.locator('.convo .shiori p')).toHaveText([TAKING]);
    await expect(page.locator('.convo .system-line a', { hasText: 'Shiori moved this to Kyoto.' })).toHaveAttribute('href', `#/trip/${kyoto.id}/talk`);
  } finally {
    await server.stop();
  }
});

for (const where of ['Details', 'Settings']) {
  test(`a ${where} screen stays where it is while she moves them into Kyoto, and she answers there`, async ({ page }) => {
    const kyoto = { id: '' };
    const server = await startModelServer({ '/b/v1/messages': shiori(kyoto) });
    try {
      const chat = await moveFromChat(page, server.origin, kyoto);
      const to = where === 'Details' ? `#/trip/${chat}` : '#/settings';
      await goToHash(page, to); // while she thinks
      await expect(page.getByRole('heading', { level: 1, name: where === 'Details' ? 'Ramen crawl' : 'Settings' })).toBeVisible();
      await expect.poll(() => herLines(page, kyoto.id), { timeout: 30_000 }).toEqual([ANSWER]);
      await page.waitForTimeout(500); // past the redraw `went` asks for
      expect(hashOf(page)).toBe(to);
      await expect(page.getByRole('heading', { level: 1, name: where === 'Details' ? 'Ramen crawl' : 'Settings' })).toBeVisible();
    } finally {
      await server.stop();
    }
  });
}
