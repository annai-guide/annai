// Handing Shiori files (the bookings-and-trips design, goals 1–4; the handing-over plan): the + in the type box, the waiting space, the
// trips she starts or files into, Undo, a pasted email, and the side task that reads a waiting file. The stand-in model plays her part.
// The booking files are synthetic (scripts/make-booking-fixtures.mjs).
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, addProvider, startModelServer, anthropicToolReply, modelSetUp, startTrip, writeRecords, breakOpen } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const fixture = async (/** @type {string} */ name, /** @type {string} */ mimeType) => ({ name, mimeType, buffer: await readFile(new URL(`../fixtures/bookings/${name}`, import.meta.url)) });
const MESSAGES = '/b/v1/messages';
/** A request as text, to find what annai chose (a stored file's path, a trip's id). @param {any} body */
const asText = (body) => JSON.stringify(body ?? {});
/** A booking she writes, from a file. @param {string} id @param {string} kind @param {string} source */
const booking = (id, kind, source) => ({ id, kind, status: 'unverified', source, title: `${kind} ${id}`, unsure: [] });

/** Shiori's main model on the stand-in (/b); no trip made, so the new conversation is open (timeline stage 7). @param {import('@playwright/test').Page} page @param {string} origin */
async function setUp(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'Stand-in · b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await expect(page.getByLabel('Add a model to main').locator('option', { hasText: 'b-model' })).toHaveCount(0);
  await page.goto('/#/talk'); // the open conversation: the new one, as nothing else is open; the dock at rest on home has no type button
  await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeAttached();
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

test('Trips, tapped while the handed-over files are still being kept, stays: the message goes when they are kept, and the screen is not taken back to the conversation', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: sse(anthropicToolReply([{ name: 'speak', input: { text: 'Got them.' } }, { name: 'sleep', input: {} }])) });
  try {
    await setUp(page, llm.origin);
    // Keeping each file takes 1.5 s, so the tap on Trips comes while they are being kept, whatever the machine's speed.
    await page.evaluate(async () => {
      const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
      const write = Workspace.prototype.write;
      Workspace.prototype.write = async function (/** @type {any[]} */ ...a) {
        if (String(a[1]).startsWith('/files/')) await new Promise((r) => setTimeout(r, 1500));
        return write.apply(this, /** @type {any} */ (a));
      };
    });
    await handOver(page, [await fixture('flight.pdf', 'application/pdf'), await fixture('hotel.png', 'image/png')]);
    await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
    await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBeGreaterThan(0); // kept, and the message went to her
    await page.waitForTimeout(1000); // past anything that would take the screen back
    expect(new URL(page.url()).hash).toBe('#/trips');
    await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
  } finally {
    await llm.stop();
  }
});

test('a screen the user goes to while Undo runs is kept: Undo does not take them back to the conversation', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([{ name: 'list_trips', input: {} }])),
    sse(anthropicToolReply([{ name: 'start_trip', input: { title: 'Kyoto', start: '2026-12-01', end: '2026-12-05', places: ['Kyoto'], files: ['/trip/files/flight.pdf'] } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'That one is for Kyoto: I started it.' } }, { name: 'sleep', input: {} }])),
    sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Big Sur', { dates: { start: '2026-11-20', end: '2026-11-27' } }); // a trip, which may start another
    await handOver(page, [await fixture('flight.pdf', 'application/pdf')]);
    await expect(page.locator('.convo').getByText('That one is for Kyoto: I started it.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Undo what Shiori did with these files' })).toBeVisible();
    await page.evaluate(() => { // Undo, and in the same moment a tap on Settings: Undo ends after it
      /** @type {HTMLButtonElement} */ (document.querySelector('button[aria-label="Undo what Shiori did with these files"]')).click();
      /** @type {HTMLAnchorElement} */ (document.querySelector('nav.topnav a[href="#/settings"]')).click();
    });
    await expect(page.getByText('Undone. Kyoto is removed, and your files are back in Big Sur.')).toBeVisible();
    await page.waitForTimeout(400);
    expect(new URL(page.url()).hash).toBe('#/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  } finally {
    await llm.stop();
  }
});

test("Undo that sends a file back to this trip, with a tap on the trip it removes: this conversation, and a Forward later shows nothing new", async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([{ name: 'list_trips', input: {} }])),
    sse(anthropicToolReply([{ name: 'start_trip', input: { title: 'Kyoto', start: '2026-12-01', end: '2026-12-05', places: ['Kyoto'], files: ['/trip/files/flight.pdf'] } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'That one is for Kyoto: I started it.' } }, { name: 'sleep', input: {} }])),
    sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
  ] });
  const hash = () => new URL(page.url()).hash;
  try {
    await modelSetUp(page, llm.origin, 'Big Sur', { dates: { start: '2026-11-20', end: '2026-11-27' } }); // a trip, which may start another
    const details = hash();
    await handOver(page, [await fixture('flight.pdf', 'application/pdf')]);
    await expect(page.locator('.convo').getByText('That one is for Kyoto: I started it.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Undo what Shiori did with these files' })).toBeVisible();
    await page.evaluate(() => { // Undo, and in the same moment the line's link to the trip it removes: Undo ends after it
      /** @type {HTMLButtonElement} */ (document.querySelector('button[aria-label="Undo what Shiori did with these files"]')).click();
      /** @type {HTMLAnchorElement} */ ([...document.querySelectorAll('.convo a')].find((a) => a.textContent === 'Shiori started Kyoto with these files.')).click();
    });
    await expect(page.getByText('Undone. Kyoto is removed, and your files are back in Big Sur.')).toBeVisible();
    await expect.poll(hash).toBe(`${details}/talk`);
    await page.goBack(); // over Kyoto's Details and the conversation's entry before it
    await expect.poll(hash).toBe(details);
    await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
    await page.goForward();
    await expect.poll(hash).toBe(`${details}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Big Sur'); // drawn: a Forward inside its drawing is not one a person makes
    const at = await page.evaluate(() => history.state?.annaiIdx);
    await page.goForward(); // Kyoto's Details, then this conversation again: nothing new ahead
    await page.waitForTimeout(500);
    expect(hash()).toBe(`${details}/talk`);
    expect(await page.evaluate(() => history.state?.annaiIdx)).toBe(at);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Big Sur');
  } finally {
    await llm.stop();
  }
});

test("after a reload on the conversation Undo left, a Forward over the removed trip's entry still reaches the screen ahead", async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([{ name: 'list_trips', input: {} }])),
    sse(anthropicToolReply([{ name: 'start_trip', input: { title: 'Kyoto', start: '2026-12-01', end: '2026-12-05', places: ['Kyoto'], files: ['/trip/files/flight.pdf'] } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'That one is for Kyoto: I started it.' } }, { name: 'sleep', input: {} }])),
    sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
  ] });
  const hash = () => new URL(page.url()).hash;
  try {
    await modelSetUp(page, llm.origin, 'Big Sur', { dates: { start: '2026-11-20', end: '2026-11-27' } }); // a trip, which may start another
    const details = hash();
    await handOver(page, [await fixture('flight.pdf', 'application/pdf')]);
    await expect(page.locator('.convo').getByText('That one is for Kyoto: I started it.')).toBeVisible({ timeout: 60_000 });
    await page.evaluate(() => { // as in the test above: Big Sur's conversation, then Kyoto's Details (gone), then the conversation again
      /** @type {HTMLButtonElement} */ (document.querySelector('button[aria-label="Undo what Shiori did with these files"]')).click();
      /** @type {HTMLAnchorElement} */ ([...document.querySelectorAll('.convo a')].find((a) => a.textContent === 'Shiori started Kyoto with these files.')).click();
    });
    await expect(page.getByText('Undone. Kyoto is removed, and your files are back in Big Sur.')).toBeVisible();
    await expect.poll(hash).toBe(`${details}/talk`);
    await page.getByRole('link', { name: 'Settings', exact: true }).click(); // a screen ahead
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Big Sur');
    await page.reload(); // as an iPhone reloads an app it set aside
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Big Sur', { timeout: 30_000 });
    await page.goBack(); // over Kyoto's Details and the conversation's entry before it
    await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Big Sur');
    await page.goForward(); // over Kyoto's Details and this conversation again, to Settings
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    expect(hash()).toBe('#/settings');
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
    // In the trip's Files, with what it became.
    await expect(page.getByRole('region', { name: 'Files', exact: true }).locator('.trip-file', { hasText: 'car car' }).locator('.became')).toHaveText('Car');
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
    await startTrip(page, 'Kyoto', { start: '2026-12-01', end: '2026-12-05' }); // dated: a card, which says what waits to be read
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

test("Undo sends the file back to a trip that then won't open: a card says so", async ({ page }) => {
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
    await breakOpen(page);
    await page.getByRole('button', { name: 'Undo what Shiori did with these files' }).click();
    await expect(page.getByText('Undone. Your files are back in Big Sur.')).toBeVisible();
    await expect(page.getByText("That conversation didn't open")).toBeVisible();
  } finally {
    await llm.stop();
  }
});

test("Undo names a trip of the user's that stays but lost what she did there: the file she moved to Kyoto and its booking", async ({ page }) => {
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
    await page.getByRole('button', { name: 'Undo what Shiori did with these files' }).click();
    await expect(page.getByText('Undone. Your files are back in Big Sur. What Shiori did in Kyoto is undone too.', { exact: true })).toBeVisible();
  } finally {
    await llm.stop();
  }
});

test('a short paste stays words; a long one into an empty box becomes a chip, which can be put back as words', async ({ page }) => {
  await openApp(page, '#/talk'); // the dock at rest on home has no type button (timeline stage 4)
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

/** A flight booking in the open trip, with the seat she is unsure of; its details are open. @param {import('@playwright/test').Page} page */
async function flightDetails(page) {
  const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  await writeRecords(page, trip, { write: { '/bookings/flight.json': { id: 'flight', kind: 'flight', status: 'unverified', source: '/files/flight.pdf', title: 'ANNAI AIR AN 123', unsure: ['seat'], fields: { seat: '14C' }, start: { at: '2026-11-20T11:20:00-08:00', tz: 'America/Los_Angeles' } } } });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/booking?path=${encodeURIComponent('/bookings/flight.json')}`);
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
  return trip;
}

test('Ask Shiori about this: the booking is a chip in the type box with Read it again under it; one tap sends it, and Shiori is asked about that booking', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [sse(anthropicToolReply([{ name: 'speak', input: { text: 'I read it again: seat 14C.' } }, { name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin, 'Anchorage');
    await flightDetails(page);
    await page.getByRole('button', { name: 'Ask Shiori about this' }).click();
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await expect(page.locator('.type-sheet .attach-chip .attach-name')).toHaveText(['ANNAI AIR AN 123']);
    await page.getByRole('button', { name: 'Read it again' }).click();
    await expect(page.locator('.convo').getByText('I read it again: seat 14C.')).toBeVisible({ timeout: 60_000 });
    // The chips cleared, and her request named that booking.
    await expect(page.locator('.type-sheet .attach-chip')).toHaveCount(0);
    const last = asText(llm.bodies(MESSAGES).at(-1).messages.at(-1));
    expect(last).toContain('Read it again');
    expect(last).toContain('The user is asking about the booking \\"/trip/bookings/flight.json\\"');
    // The chip on the sent line opens the booking's details, never its raw JSON (the review of seeing-bookings, E1).
    const chip = page.locator('.convo .chips.handed .attach-chip').first();
    await expect(chip).toHaveAttribute('href', /\/booking\?path=/);
    await expect(chip).toHaveAttribute('href', /from=%23%2Ftrip%2F[^&]*%2Ftalk$/); // back to its conversation, by its own address
    await chip.click();
    await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
    await expect(page.locator('textarea')).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test('with "the seat is 14D" typed under the chip, her patch fixes the seat', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([{ name: 'patch', input: { path: '/trip/bookings/flight.json', changes: { fields: { seat: '14D' }, unsure: [] } } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'Seat 14D it is.' } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Anchorage');
    const trip = await flightDetails(page);
    await page.getByRole('button', { name: 'Ask Shiori about this' }).click();
    await expect(page.locator('.type-sheet .attach-chip .attach-name')).toHaveText(['ANNAI AIR AN 123']);
    await page.getByLabel('Message to Shiori').fill('the seat is 14D');
    // Typing hides Read it again: what is typed is sent, with the chip.
    await expect(page.getByRole('button', { name: 'Read it again' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('Seat 14D it is.')).toBeVisible({ timeout: 60_000 });
    expect(asText(llm.bodies(MESSAGES)[0].messages.at(-1))).toContain('/trip/bookings/flight.json');
    await page.goto(`/#/trip/${encodeURIComponent(trip)}/booking?path=${encodeURIComponent('/bookings/flight.json')}`);
    await expect(page.locator('dl.facts')).toContainText('14D');
    await expect(page.locator('dl.facts .chip.check')).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test('once Shiori names a file, its chip, its Files row and its screen show the short name; its screen shows the real file name too', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([{ name: 'patch', input: { path: '/trip/names.json', changes: { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' } } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'Named it.' } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Anchorage');
    const trip = page.url();
    await handOver(page, [await fixture('flight.pdf', 'application/pdf')]);
    await expect(page.locator('.convo').getByText('Named it.')).toBeVisible({ timeout: 60_000 });
    // The chip on the user's line, drawn again: the short name, the real name as its title.
    await page.goto(trip);
    await page.goto('/#/talk');
    const chip = page.locator('.convo .chips.handed .attach-chip');
    await expect(chip.locator('.attach-name')).toHaveText(['ANNAI AIR flight · Nov 20']);
    await expect(chip).toHaveAttribute('title', 'flight.pdf');
    // Its Files row.
    await page.goto(trip);
    const row = page.getByRole('region', { name: 'Files', exact: true }).locator('.trip-file').first();
    await expect(row.locator('.name')).toHaveText('ANNAI AIR flight · Nov 20');
    // Its details: the short name, then the real file name beneath the preview; Open leads to the raw screen, with its path.
    await row.getByRole('link').first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'ANNAI AIR flight · Nov 20' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'The original' })).toContainText('From flight.pdf');
    await page.getByRole('link', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ANNAI AIR flight · Nov 20' })).toBeVisible();
    await expect(page.getByText('File name: flight.pdf')).toBeVisible();
    await expect(page.getByText('/files/flight.pdf')).toBeVisible();
  } finally {
    await llm.stop();
  }
});
