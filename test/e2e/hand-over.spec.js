// Handing Shiori files (the bookings-and-trips design, goals 1–4; the handing-over plan): the + in the type box, the waiting space, the
// trips she starts or files into, Undo, a pasted email, and the side task that reads a waiting file. The stand-in model plays her part.
// The booking files are synthetic (scripts/make-booking-fixtures.mjs).
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, addProvider, startModelServer, anthropicToolReply, modelSetUp, startTrip, savedBy } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const fixture = async (/** @type {string} */ name, /** @type {string} */ mimeType) => ({ name, mimeType, buffer: await readFile(new URL(`../fixtures/bookings/${name}`, import.meta.url)) });
const TITLE = 'Anchorage · Nov 20–27';
const RECAP = 'A long weekend in Testville with Sam';
const MESSAGES = '/b/v1/messages';
/** A request as text, to find what annai chose (a stored file's path, a trip's id). @param {any} body */
const asText = (body) => JSON.stringify(body ?? {});
/** A booking she writes, from a file. @param {string} id @param {string} kind @param {string} source */
const booking = (id, kind, source) => ({ id, kind, status: 'unverified', source, title: `${kind} ${id}` });

/** Shiori's main model on the stand-in (/b), and with reader, a utility model too (/u); no trip made. @param {import('@playwright/test').Page} page @param {string} origin @param {{ reader?: boolean }} [o] */
async function setUp(page, origin, { reader = false } = {}) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await expect(page.getByLabel('Add a model to main').locator('option', { hasText: 'b-model' })).toHaveCount(0);
  if (reader) {
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Reader', url: `${origin}/u`, key: 'sk-test-u', model: 'u-model' });
    await page.getByLabel('Add a model to utility').selectOption({ label: 'u-model' });
    await page.getByRole('button', { name: 'Add to utility' }).click();
    await expect(page.getByLabel('Add a model to utility').locator('option', { hasText: 'u-model' })).toHaveCount(0);
    // The reader takes PDFs, set on its page (a custom model takes text alone until told).
    await page.getByRole('link', { name: /Reader/ }).click();
    await page.getByRole('link', { name: /^u-model/ }).click();
    await expect(page.getByLabel('Provider model id')).toHaveValue('u-model');
    await page.getByLabel('Takes PDFs').check();
    await expect(savedBy(page.getByLabel('Takes PDFs'))).toHaveText('Saved');
  }
  await page.goto('/#/trips');
  await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
}

/** Hands Shiori files from the type box, with words or none. @param {import('@playwright/test').Page} page @param {any[]} files @param {string} [words] */
async function handOver(page, files, words = '') {
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Give Shiori photos or files').setInputFiles(files);
  await expect(page.locator('.type-sheet .attach-chip')).toHaveCount(files.length);
  if (words) await page.getByLabel('Message to Shiori').fill(words);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
}

/** Pastes text into the type box, as a phone's paste does. @param {import('@playwright/test').Page} page @param {string} text */
async function paste(page, text) {
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Message to Shiori').evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

/** The no-trip conversation's log. @param {import('@playwright/test').Page} page @param {string[]} types */
const meLog = (page, types) => page.evaluate(async (types) => {
  const load = (/** @type {string} */ url) => import(url);
  const { createIdbStore } = await load('/src/core/store-idb.js');
  const store = await createIdbStore();
  const out = await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents('me', { types }));
  store.close();
  return out.map((/** @type {any} */ e) => ({ type: e.type, data: e.data }));
}, types);

/** With no trip open, she lists the trips, starts one for both files with her recap, and says so; there, she files the flight. */
const anchorage = () => [
  sse(anthropicToolReply([{ name: 'list_trips', input: {} }])),
  (/** @type {any} */ body) => sse(anthropicToolReply([{ name: 'start_trip', input: {
    title: TITLE, start: '2026-11-20', end: '2026-11-27', places: ['Anchorage'], recap: RECAP,
    files: ['/waiting/files/flight.pdf', /\/waiting\/files\/hotel\.[a-z]+/.exec(asText(body))?.[0] ?? '/waiting/files/hotel.png'],
  } }])),
  sse(anthropicToolReply([{ name: 'speak', input: { text: `I started ${TITLE}.` } }, { name: 'sleep', input: {} }])),
  sse(anthropicToolReply([{ name: 'write', input: { path: '/trip/bookings/flight.json', content: booking('flight', 'flight', '/files/flight.pdf') } }, { name: 'speak', input: { text: 'Your flight is on Nov 20.' } }, { name: 'sleep', input: {} }])),
  sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
];

/** The user's evening: on Trips with no trip open, the flight PDF and the hotel screenshot handed over with no words. @param {import('@playwright/test').Page} page */
async function handAnchorage(page) {
  await handOver(page, [await fixture('flight.pdf', 'application/pdf'), await fixture('hotel.png', 'image/png')]);
  await expect(page.locator('.convo').getByText('Your flight is on Nov 20.')).toBeVisible({ timeout: 60_000 });
}

test('with no trip open, + hands Shiori a flight PDF and a hotel screenshot: she starts "Anchorage · Nov 20–27", it opens, and its conversation starts with the hand-over and her recap', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: anchorage() });
  try {
    await setUp(page, llm.origin);
    await handAnchorage(page);
    await expect(page.locator('.screen > .sub').first()).toHaveText(TITLE);
    const lines = page.locator('.convo > li');
    await expect(lines.nth(0)).toHaveClass(/you/);
    await expect(lines.nth(0).locator('.attach-chip')).toHaveText(['flight.pdf', 'hotel.png']);
    await expect(lines.nth(0).locator('p')).toHaveCount(0); // handed with no words
    await expect(lines.nth(1)).toHaveText(new RegExp(RECAP));
    await expect(page.locator('.convo .shiori .acts button')).toHaveCount(0); // nothing asked where a file goes
    await lines.nth(0).getByRole('link', { name: 'flight.pdf' }).click();
    await expect(page.getByRole('heading', { name: '/files/flight.pdf' })).toBeVisible();
    await page.goto('/#/trips');
    await expect(page.locator('.trip-card', { hasText: TITLE })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Waiting with Shiori' })).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test('the no-trip conversation keeps its lines, and one saying where the files went', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: anchorage() });
  try {
    await setUp(page, llm.origin);
    await handAnchorage(page);
    const log = await meLog(page, ['msg.user', 'out.speak', 'handover.moved']);
    expect(log.map((e) => e.type)).toEqual(['msg.user', 'handover.moved', 'out.speak']);
    expect(log[0].data.handed.map((/** @type {any} */ f) => f.name)).toEqual(['flight.pdf', 'hotel.png']);
    expect(log[1].data).toMatchObject({ started: true, count: 2 });
    expect(log[2].data.text).toBe(`I started ${TITLE}.`);
  } finally {
    await llm.stop();
  }
});

test('Undo takes back what she did; the trip she started goes, and the files wait with Shiori again', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: anchorage() });
  try {
    await setUp(page, llm.origin);
    await handAnchorage(page);
    await page.getByRole('button', { name: 'Undo what Shiori did with these files' }).click();
    await expect(page.getByText(`Undone. ${TITLE} is removed, and your files are waiting with Shiori.`)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
    await expect(page.locator('.trip-card', { hasText: TITLE })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Waiting with Shiori' })).toBeVisible();
    await expect(page.locator('.waiting-file .path')).toHaveText([/^flight\.pdf$/, /^hotel\.[a-z]+$/]);
  } finally {
    await llm.stop();
  }
});

test('in a trip, a pasted confirmation email becomes a chip, then a text file in its Files, and Shiori is told about it', async ({ page }) => {
  const text = (await fixture('confirmation.txt', 'text/plain')).buffer.toString('utf8');
  const llm = await startModelServer({ [MESSAGES]: [
    (/** @type {any} */ body) => {
      const path = /\/trip\/files\/pasted-[0-9-]+\.txt/.exec(asText(body))?.[0] ?? '/trip/files/pasted.txt';
      return sse(anthropicToolReply([{ name: 'write', input: { path: '/trip/bookings/car.json', content: booking('car', 'car', path.slice('/trip'.length)) } }, { name: 'speak', input: { text: 'Your car is on the plan.' } }, { name: 'sleep', input: {} }]));
    },
    sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    const trip = page.url();
    await paste(page, text);
    await expect(page.locator('.type-sheet .attach-chip')).toHaveText([/^pasted-\d{4}-\d{2}-\d{2}-\d{4}\.txt/]);
    await expect(page.getByLabel('Message to Shiori')).toHaveValue('');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('Your car is on the plan.')).toBeVisible({ timeout: 60_000 });
    const [first] = llm.bodies(MESSAGES);
    expect(asText(first.messages.at(-1))).toMatch(/The user handed you a file: \\"\/trip\/files\/pasted-[0-9-]+\.txt\\" \(text\/plain\)/);
    expect(asText(first.messages.at(-1))).not.toContain('Midnight Test Rentals'); // the email is a file she reads, not words in the message
    await page.goto(trip);
    await expect(page.getByRole('link', { name: /\/files\/pasted-[0-9-]+\.txt/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /\/bookings\/car\.json/ })).toBeVisible();
  } finally {
    await llm.stop();
  }
});

test("with no trip open, a pasted text that is not a booking is dropped: once she deletes it, Waiting with Shiori doesn't list it", async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    (/** @type {any} */ body) => sse(anthropicToolReply([
      { name: 'delete', input: { path: /\/waiting\/files\/pasted-[0-9-]+\.txt/.exec(asText(body))?.[0] ?? '/waiting/files/pasted.txt' } },
      { name: 'speak', input: { text: 'That was a note, not a booking, so I let it go.' } }, { name: 'sleep', input: {} },
    ])),
    sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
  ] });
  try {
    await setUp(page, llm.origin);
    await paste(page, 'Thanks for dinner last night!\nIt was lovely to see you.\nSee you at the reunion.\nSam');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('That was a note, not a booking, so I let it go.')).toBeVisible({ timeout: 60_000 });
    await page.goto('/#/trips');
    await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Waiting with Shiori' })).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test("with no trip open, a handed PDF reaches the stand-in only through the side task: the conversation's requests carry its words, never the PDF", async ({ page }) => {
  const llm = await startModelServer({
    [MESSAGES]: [
      sse(anthropicToolReply([{ name: 'read', input: { path: '/waiting/files/flight.pdf' } }])),
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'A flight on Nov 20.' } }, { name: 'sleep', input: {} }])),
      sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
    ],
    '/u/v1/messages': sse(anthropicToolReply([], 'ANNAI AIR, flight AN 123, Seattle 11:20 to Anchorage 14:05, Fri Nov 20 2026.')),
  });
  try {
    await setUp(page, llm.origin, { reader: true });
    await handOver(page, [await fixture('flight.pdf', 'application/pdf')]);
    await expect(page.locator('.convo').getByText('A flight on Nov 20.')).toBeVisible({ timeout: 60_000 });
    expect(llm.bodies('/u/v1/messages').some((b) => asText(b).includes('"type":"document"'))).toBe(true);
    expect(llm.bodies(MESSAGES).some((b) => asText(b).includes('"type":"document"'))).toBe(false);
    const after = asText(llm.bodies(MESSAGES)[1]);
    expect(after).toContain('read by a side task');
    expect(after).toContain('AN 123');
  } finally {
    await llm.stop();
  }
});

test("a booking for another trip, while in a trip: she moves the file there and says so; that trip's card says a file is waiting to be read", async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([{ name: 'list_trips', input: {} }])),
    (/** @type {any} */ body) => sse(anthropicToolReply([{ name: 'move_file', input: { path: '/trip/files/flight.pdf', trip: /(trip-[a-z0-9]+)\\tKyoto/.exec(asText(body))?.[1] ?? 'none' } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'That one is for Kyoto: I moved it there.' } }, { name: 'sleep', input: {} }])),
    sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Big Sur');
    const bigSur = page.url();
    await page.goto('/#/trips');
    await startTrip(page, 'Kyoto');
    await page.goto(bigSur);
    await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
    await handOver(page, [await fixture('flight.pdf', 'application/pdf')]);
    await expect(page.locator('.convo').getByText('That one is for Kyoto: I moved it there.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('link', { name: 'Shiori took 1 file to Kyoto.' })).toBeVisible();
    await page.goto('/#/trips');
    await expect(page.locator('.trip-card', { hasText: 'Kyoto' })).toContainText('1 file waiting to be read');
  } finally {
    await llm.stop();
  }
});

test('a short paste stays words; a long one into an empty box becomes a chip, which can be put back as words', async ({ page }) => {
  await openApp(page);
  await paste(page, 'Seat 14D\nAisle, please');
  await expect(page.locator('.type-sheet .attach-chip')).toHaveCount(0);
  const text = (await fixture('confirmation.txt', 'text/plain')).buffer.toString('utf8');
  await page.getByLabel('Message to Shiori').fill('');
  await page.getByLabel('Message to Shiori').evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await expect(page.locator('.type-sheet .attach-chip')).toHaveCount(1);
  await page.getByRole('button', { name: 'Put back as text' }).click();
  await expect(page.locator('.type-sheet .attach-chip')).toHaveCount(0);
  // Its lines are words with spaces between, never glued together (a one-line box drops line breaks).
  await expect(page.getByLabel('Message to Shiori')).toHaveValue(text.trim().replace(/\s*\n\s*/g, ' '));
});
