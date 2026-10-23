import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, startServer, addProvider, anthropicToolReply, filterTrace, savedBy, modelSetUp, writeEvent, startTrip } from './helpers.js';

test('the avatar: states change her look, the level reaches the seat, and there is no innerHTML or style attribute', async ({ page }) => {
  await page.goto('/#/trips');
  await page.evaluate(async () => {
    // A browser URL, not a file on disk: pass it as a value so the type checker doesn't resolve it.
    const at = (/** @type {string} */ p) => p;
    const { createAvatar } = await import(at('/src/ui/avatar.js'));
    const a = createAvatar({ size: 'big', label: 'Shiori' });
    a.el.id = 'probe';
    document.body.append(a.el);
    a.setState('thinking');
    a.setLevel(0.5, 'you');
    /** @type {any} */ (window).__a = a;
  });
  const av = page.locator('#probe .av');
  await expect(av).toHaveAttribute('data-state', 'thinking');
  await expect(page.locator('#probe')).toHaveAttribute('data-glow', 'you');
  expect(await page.locator('#probe').evaluate((el) => getComputedStyle(el).getPropertyValue('--amp').trim())).toBe('0.5');
  expect(await page.locator('#probe svg [style]').count()).toBe(0);
  expect(await page.locator('#probe svg use[href="/assets/shiori.svg#marker"]').count()).toBe(1);
  await page.evaluate(() => /** @type {any} */ (window).__a.setState('away'));
  await expect(av).toHaveAttribute('data-state', 'away');
});

/**
 * Puts one avatar per state on the page, as #av-<state>.
 * @param {import('@playwright/test').Page} page
 */
async function everyState(page) {
  await page.goto('/#/trips');
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createAvatar } = await import(at('/src/ui/avatar.js'));
    for (const state of ['sleeping', 'listening', 'hearing', 'thinking', 'speaking', 'waiting', 'away', 'offline']) {
      const a = createAvatar({ size: 'big' });
      a.el.id = `av-${state}`;
      // On screen, where she moves (off it, she keeps still).
      a.el.style.setProperty('position', 'fixed');
      a.el.style.setProperty('top', '0');
      document.body.append(a.el);
      a.setState(state);
    }
  });
}

/**
 * What one avatar shows: how opaque its parts are (each of its ears' drawings; its head front, asleep or turned), its
 * seat's filter, the shape of her right eye and its highlight, the tail tip's animation, and the streamers.
 * @param {import('@playwright/test').Page} page @param {string} state
 */
const look = (page, state) => page.locator(`#av-${state}`).evaluate((seat) => {
  const opacity = (/** @type {string} */ sel) => Number(getComputedStyle(/** @type {Element} */ (seat.querySelector(sel))).opacity);
  const iris = /** @type {SVGPathElement} */ (seat.querySelector('.head > .eyes .iris'));
  const box = iris.getBBox();
  // The eye's far left: where a ‿ has its ends, higher than its middle.
  let left = { x: Infinity, y: 0 };
  for (let l = 0; l < iris.getTotalLength(); l += 2) {
    const p = iris.getPointAtLength(l);
    if (p.x < left.x) left = { x: p.x, y: p.y };
  }
  // Her lid's edge: the top of the oval, at its outer quarter and its inner quarter.
  const topAt = (/** @type {number} */ x) => {
    let y = Infinity;
    for (let l = 0; l < iris.getTotalLength(); l += 1) {
      const p = iris.getPointAtLength(l);
      if (Math.abs(p.x - x) < 1.5 && p.y < y) y = p.y;
    }
    return y;
  };
  const part = (/** @type {string} */ id) => /** @type {SVGGraphicsElement} */ (seat.querySelector(`use[href$="#${id}"]`)).getBBox().width;
  return {
    fox: opacity('.fox'), curl: opacity('.curl'), away: opacity('.away'),
    ears: ['.ear-r', '.ear-l', '.flat-r', '.flat-l', '.out-l'].map(opacity).join(' '),
    face: [opacity('.front'), opacity('.asleep'), opacity('.turned')].join(' '),
    streamer: opacity('.pin .streamer'), tape: opacity('.pin .tape'),
    filter: getComputedStyle(seat).filter,
    wide: box.width / box.height, endsUp: left.y < box.y + box.height / 2,
    sad: topAt(box.x + box.width * 0.35) - topAt(box.x + box.width * 0.85),
    light: Number(seat.querySelector('.head > .eyes .light')?.getAttribute('rx')),
    drawn: !/NaN/.test(iris.getAttribute('d') ?? 'NaN'),
    wag: seat.querySelector('.tip')?.getAttribute('transform') ?? '',
    head: part('head'), marker: part('marker'), grass: part('grass'), turned: part('head-turned'), asleep: part('head-asleep'), tail: part('tail-asleep'),
  };
});

test("her states show the right parts and eyes, as the expression sheet draws them", async ({ page }) => {
  await everyState(page);
  // Her parts come from the art file, which has loaded.
  await expect.poll(async () => (await look(page, 'listening')).head).toBeGreaterThan(100);
  // Asleep: her asleep head on her tail, wrapped round her; ‿ eyes.
  await expect.poll(() => look(page, 'sleeping')).toMatchObject({ fox: 1, curl: 1, away: 0, light: 0, endsUp: true, face: '0 1 0', drawn: true });
  const asleep = await look(page, 'sleeping');
  expect(asleep.wide, 'a thick crescent, wider than tall').toBeGreaterThan(2);
  expect(asleep.tail, 'her tail, wider than her shoulders').toBeGreaterThan(700);
  expect(asleep.asleep).toBeGreaterThan(400);
  await expect.poll(() => look(page, 'listening')).toMatchObject({ fox: 1, curl: 0, away: 0, light: 14.5, ears: '1 1 0 0 0', face: '1 0 0', streamer: 0, tape: 1 });
  // She blinks from time to time, a blink lasts as long as the page's frames take to draw, and on a busy machine that is long enough to be
  // caught half shut: an open eye is waited for, not sampled once.
  await expect.poll(async () => (await look(page, 'listening')).wide, { message: 'an open eye' }).toBeLessThan(1.5);
  // Hearing you, her eyes are wide: a bigger highlight.
  await expect.poll(async () => (await look(page, 'hearing')).light).toBe(17.4);
  // Thinking: her head turned (in the middle of a blink).
  await expect.poll(() => look(page, 'thinking')).toMatchObject({ face: '0 0 1' });
  expect((await look(page, 'thinking')).turned).toBeGreaterThan(100);
  // Talking: open eyes, not smiling ones; the streamer in place of the tape's short tail.
  await expect.poll(() => look(page, 'speaking')).toMatchObject({ light: 14.5, ears: '1 1 0 0 0', streamer: 1, tape: 0 });
  // Your turn: her right ear up, her left angled out.
  await expect.poll(() => look(page, 'waiting')).toMatchObject({ ears: '1 0 0 0 1' });
  // Working: her marker in its grass, and her tail's tip wagging; no head.
  await expect.poll(() => look(page, 'away')).toMatchObject({ fox: 0, away: 1 });
  const wag = (await look(page, 'away')).wag;
  await expect.poll(async () => (await look(page, 'away')).wag).not.toBe(wag);
  expect((await look(page, 'away')).marker).toBeGreaterThan(100);
  expect((await look(page, 'away')).grass).toBeGreaterThan(200);
  // Offline: grey, ears folded flat, no highlight, and half-lidded eyes whose lids slope down toward the outer corner.
  await expect.poll(() => look(page, 'offline')).toMatchObject({ fox: 1, curl: 0, light: 0, filter: 'grayscale(1)', ears: '0 0 1 1 0', drawn: true });
  expect((await look(page, 'offline')).sad, 'the lid is lower at the outer corner').toBeGreaterThan(5);
  expect((await look(page, 'offline')).wide, 'half-lidded').toBeGreaterThan(1.3);
});

test("she blinks and glances, her head turns in the middle of a blink, her tail's tip wags and her streamers wave; with reduced motion she does none of it, and her states change at once", async ({ page }) => {
  await page.goto('/#/trips');
  const run = (/** @type {boolean} */ calm) => page.evaluate(async (calm) => {
    const at = (/** @type {string} */ p) => p;
    const { createAvatar } = await import(at('/src/ui/avatar.js'));
    const a = createAvatar({ size: 'big' });
    a.el.style.setProperty('position', 'fixed');
    a.el.style.setProperty('top', '0');
    document.body.append(a.el);
    const av = /** @type {HTMLElement} */ (a.el.querySelector('.av'));
    const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
    await wait(200); // she is seen
    const iris = /** @type {SVGPathElement} */ (a.el.querySelector('.head > .eyes .iris'));
    const eyes = /** @type {SVGGElement} */ (a.el.querySelector('.head > .eyes'));
    const light = /** @type {SVGEllipseElement} */ (a.el.querySelector('.light'));
    a.setState('hearing');
    const wideAtOnce = light.getAttribute('rx') === '17.4';
    a.setState('listening');
    await wait(900);
    const open = iris.getBBox().height;
    /** @type {number[]} */
    const heights = [];
    const watch = new MutationObserver(() => heights.push(iris.getBBox().height));
    watch.observe(iris, { attributes: true });
    a.blink();
    await wait(600);
    watch.disconnect();
    a.glance(1, 0.5);
    const glanced = eyes.style.transform;
    await wait(1300);
    // Thinking: how open her front eyes are when her head turns.
    /** @type {number[]} */
    const atTurn = [];
    const turn = new MutationObserver(() => atTurn.push(iris.getBBox().height));
    turn.observe(av, { attributes: true, attributeFilter: ['data-face'] });
    a.setState('thinking');
    await wait(500);
    turn.disconnect();
    const face = av.dataset.face;
    // Talking, then working: does the streamer change shape over half a second, and does her voice swing it?
    const band = (/** @type {string} */ sel) => /** @type {SVGPathElement} */ (a.el.querySelector(`${sel} .band`)).getAttribute('d');
    a.setState('speaking');
    a.setLevel(0);
    await wait(300);
    const quiet = getComputedStyle(/** @type {Element} */ (a.el.querySelector('.pin .streamer'))).transform;
    const talk = band('.pin');
    a.setLevel(1);
    await wait(500);
    const loud = getComputedStyle(/** @type {Element} */ (a.el.querySelector('.pin .streamer'))).transform;
    const talked = band('.pin') !== talk;
    a.setState('away');
    const flag = band('.marker');
    const tip = () => a.el.querySelector('.tip')?.getAttribute('transform') ?? '';
    const wagged = tip();
    await wait(500);
    const flew = band('.marker') !== flag;
    const wag = tip() !== wagged;
    return { wideAtOnce, open, least: Math.min(open, ...heights), after: iris.getBBox().height, glanced, back: eyes.style.transform, wag, face, atTurn, swings: quiet !== loud, talked, flew };
  }, calm);
  const moving = await run(false);
  expect(moving.least, 'the blink squashes her eye').toBeLessThan(moving.open * 0.6);
  expect(moving.after).toBeCloseTo(moving.open, 0);
  expect(moving.glanced).toBe('translate(14px, 7px)');
  expect(moving.back).toBe('');
  expect(moving.face).toBe('turned');
  expect(moving.atTurn.length).toBe(1);
  expect(moving.atTurn[0], 'her eyes are closed when her head turns').toBeLessThan(moving.open * 0.6);
  expect(moving).toMatchObject({ wag: true, swings: true, talked: true, flew: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const calm = await run(true);
  expect(calm.wideAtOnce).toBe(true);
  expect(calm.least).toBe(calm.open);
  expect(calm.glanced).toBe('');
  expect(calm.face).toBe('turned');
  // No waving or wagging; her voice still swings the streamer, as a pose.
  expect(calm).toMatchObject({ wag: false, swings: true, talked: false, flew: false });
});

test("taken off the page while working, her marker's streamer stops; out of sight, so does everything else", async ({ page }) => {
  await page.goto('/#/trips');
  const result = await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createAvatar } = await import(at('/src/ui/avatar.js'));
    const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
    const a = createAvatar({ size: 'big' });
    a.el.style.setProperty('position', 'fixed');
    a.el.style.setProperty('top', '0');
    document.body.append(a.el);
    a.setState('away');
    const band = /** @type {SVGPathElement} */ (a.el.querySelector('.marker .band'));
    const av = /** @type {HTMLElement} */ (a.el.querySelector('.av'));
    /** @type {number} */
    let changes = 0;
    const watch = new MutationObserver(() => { changes++; });
    watch.observe(band, { attributes: true, attributeFilter: ['d'] });
    // What a loaded machine does late (her observer's word, a step of her wave) is waited for, up to 10 s, rather than
    // counted in a fixed window: under load it flaked both ways (2026-10-18, a container held to 2 CPUs).
    const until = async (/** @type {() => boolean} */ ok) => {
      for (const end = Date.now() + 10_000; !ok() && Date.now() < end;) await wait(50);
      return ok();
    };
    const waved = await until(() => changes >= 5);
    a.el.remove();
    const gone = await until(() => av.dataset.hidden === ''); // her observer reports her gone
    changes = 0;
    await wait(1000);
    watch.disconnect();
    return { waved, gone, off: changes };
  });
  expect(result.waved, 'it waves on the page').toBe(true);
  expect(result.gone, 'she knows she is off it').toBe(true);
  expect(result.off, 'and stops off it').toBe(0);
});

test("her art is kept for offline use: after the first visit she shows with no network", async ({ page }, testInfo) => {
  // A port for each worker running at once, as both browsers may run this test together.
  const server = await startServer(8811 + testInfo.parallelIndex);
  try {
    await page.goto(`${server.origin}/#/trips`);
    await expect(page.getByRole('navigation', { name: 'Shiori' })).toBeVisible();
    await waitForServiceWorker(page);
    await server.stop();
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Shiori' })).toBeVisible();
    expect(await page.evaluate(async () => (await fetch('/assets/shiori.svg')).ok)).toBe(true);
    // The dock's avatar draws her parts from the kept file.
    await expect.poll(() => page.locator('.dock .seat use[href$="#head"]').evaluate((u) => /** @type {SVGGraphicsElement} */ (u).getBBox().width)).toBeGreaterThan(100);
  } finally {
    await server.stop();
  }
});

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

/** A trip, and Shiori's main model on a stand-in Anthropic endpoint. @param {any} page @param {string} origin */
async function setUp(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await page.goto('/#/trips');
  await page.getByLabel('Trip name').fill('Big Sur');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
}

test('the dock is on every screen; typing to Shiori shows her answer in the conversation', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'Nepenthe is 25 minutes south.' } }, { name: 'sleep', input: {} }]))] });
  try {
    await setUp(page, llm.origin);
    for (const hash of ['#/trips', '#/settings', '#/trace']) {
      await page.goto(`/${hash}`);
      await expect(page.getByRole('navigation', { name: 'Shiori' })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Where should we eat?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await expect(page.locator('.convo .you')).toHaveText('Where should we eat?');
    await expect(page.locator('.convo .shiori p')).toHaveText('Nepenthe is 25 minutes south.');
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
  } finally {
    await llm.stop();
  }
});

test("a turn that said nothing: the conversation's own note offers Try again (the card is at the page's top), and everything goes once she answers (the second emulator pass)", async ({ page }) => {
  const plain = sse(anthropicToolReply([], 'Big Sur is known for its coast.'));
  const llm = await startModelServer({ '/b/v1/messages': [plain, plain, sse(anthropicToolReply([{ name: 'speak', input: { text: 'Its wild coast.' } }, { name: 'sleep', input: {} }]))] });
  try {
    await setUp(page, llm.origin);
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('What is Big Sur known for?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    const card = page.locator('.notice', { hasText: "Shiori didn't answer" });
    await expect(card).toBeVisible();
    const note = page.locator('.convo .system', { hasText: 'Her turn ended' });
    await expect(note).toBeVisible();
    await note.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.convo .shiori p')).toHaveText('Its wild coast.');
    await expect(card).toHaveCount(0);
    await expect(note.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test("no model answers: the card and the conversation's note say the same, \"Shiori can't reach her model\", and the note offers Try again", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [{ status: 401, type: 'application/json', body: '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}' }, sse(anthropicToolReply([{ name: 'speak', input: { text: 'Back again.' } }, { name: 'sleep', input: {} }]))] });
  try {
    await setUp(page, llm.origin);
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Hello?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    const card = page.locator('.notice', { hasText: "Shiori can't reach her model" });
    await expect(card).toBeVisible();
    const note = page.locator('.convo .system', { hasText: "Shiori can't reach her model" });
    await expect(note).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    // The model rests for a few minutes after a refused key: the user may try it again from Settings; here, a new message.
    await expect(note.getByRole('button', { name: 'Try again' })).toBeVisible();
  } finally {
    await llm.stop();
  }
});

test('hostile model output in a card stays text: no HTML, no javascript: links', async ({ page }) => {
  const card = { title: '<b>Hi</b>', text: '<img src=x onerror="window.__pwned=1"> [bad](javascript:window.__pwned=1) and [good](https://example.com/)', links: [{ label: 'evil', url: 'javascript:alert(1)' }] };
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'show', input: { card } }, { name: 'sleep', input: {} }]))] });
  try {
    await setUp(page, llm.origin);
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Show me');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .card-title')).toHaveText('<b>Hi</b>');
    expect(await page.locator('.convo img').count()).toBe(0);
    expect(await page.locator('.convo a[href^="javascript"]').count()).toBe(0);
    await expect(page.locator('.convo a[href="https://example.com/"]')).toHaveText('good');
    expect(await page.evaluate(() => /** @type {any} */ (window).__pwned)).toBeUndefined();
  } finally {
    await llm.stop();
  }
});

test('the announcer reads a card with choices, a card with nothing to read and a question as her lines ("Shiori: …", "Shiori asks: …"), never the label run into the words', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([
    { name: 'show', input: { card: { title: 'Dinner', text: 'Nepenthe at 7.', choice: ['Book it', 'Not now'] } } },
    { name: 'show', input: { card: { image: '/trip/files/menu.jpg' } } },
    { name: 'ask', input: { question: 'Window seat?', options: ['Yes', 'No'] } },
    { name: 'sleep', input: {} },
  ]))] });
  try {
    await setUp(page, llm.origin);
    await page.goto('/#/talk');
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      const announcer = /** @type {HTMLElement} */ (document.querySelector('main [aria-live="polite"]'));
      w.announced = [];
      new MutationObserver(() => w.announced.push(announcer.textContent)).observe(announcer, { childList: true, characterData: true, subtree: true });
    });
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Plan dinner');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori').filter({ hasText: 'Window seat?' })).toBeVisible();
    expect(await page.evaluate(() => /** @type {any} */ (window).announced)).toEqual([
      'Shiori: Dinner Nepenthe at 7. Choices: Book it, Not now.',
      'Shiori: a photo',
      'Shiori asks: Window seat? Choices: Yes, No.',
    ]);
  } finally {
    await llm.stop();
  }
});

test('a tool switched off is not offered to Shiori; the Jina key is saved and never shown', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await setUp(page, llm.origin);
    await page.goto('/#/tools');
    await page.getByRole('checkbox', { name: 'fetch', exact: true }).uncheck();
    await page.getByLabel('Jina key').fill('jina_e2e_secret_key');
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByText('A key is set. It stays on this device')).toBeVisible();
    expect(await page.content()).not.toContain('jina_e2e_secret_key');
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Hi');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(0);
    const names = llm.bodies('/b/v1/messages')[0].tools.map((/** @type {any} */ t) => t.name);
    expect(names).toContain('speak');
    expect(names).not.toContain('fetch');
    expect(JSON.stringify(llm.bodies('/b/v1/messages'))).not.toContain('jina_e2e_secret_key');
  } finally {
    await llm.stop();
  }
});

test('done: a conversation with tool use, with fallback across two providers, survives a reload mid-turn, and the trace shows every request and everything read', async ({ page }) => {
  const llm = await startModelServer({
    '/a/v1/chat/completions': { status: 402, type: 'application/json', body: JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }) },
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'write', input: { path: '/trip/notes/dinner.md', content: '# Dinner\nNepenthe at 6:30\n' } }], 'Let me note that.')),
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'Noted: dinner at Nepenthe at 6:30.' } }, { name: 'sleep', input: {} }])),
      { ...sse(anthropicToolReply([{ name: 'speak', input: { text: 'Too late.' } }, { name: 'sleep', input: {} }])), delayMs: 4000 },
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'Yes, still here.' } }, { name: 'sleep', input: {} }])),
    ],
  });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Chat Completions', name: 'Endpoint A', url: `${llm.origin}/a/v1`, key: 'sk-test-secret-a', model: 'a-model' });
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Endpoint B', url: `${llm.origin}/b`, key: 'sk-test-secret-b', model: 'b-model' });
    for (const m of ['a-model', 'b-model']) {
      await page.getByLabel('Add a model to main').selectOption({ label: m });
      await page.getByRole('button', { name: 'Add to main' }).click();
    }
    await page.goto('/#/trips');
    await page.getByLabel('Trip name').fill('Big Sur');
    await page.getByRole('button', { name: 'Start trip' }).click();
    await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();

    // A turn with tool use: A is out of credit, B answers, writes a note, then speaks.
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Note dinner at Nepenthe at 6:30');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Noted: dinner at Nepenthe at 6:30.');
    await expect(page.locator('.convo')).not.toContainText('Let me note that.'); // her own text stays in the trace (spec §7.1)

    // A reload while she is thinking: after it, she answers the message anyway.
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Are you there?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.talk-label')).toHaveText('Thinking · tap to stop');
    // The dock says Thinking before the request is sent: reload once the stand-in has it.
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(3);
    await page.reload();
    await page.goto('/#/talk');
    await expect(page.locator('.convo .you').last()).toHaveText('Are you there?');
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Yes, still here.', { timeout: 15_000 });

    // The note is a file in the trip.
    await page.getByRole('link', { name: 'Trips' }).click();
    await page.getByRole('link', { name: /Big Sur/ }).click();
    await expect(page.getByText('/notes/dinner.md')).toBeVisible();

    // The trace: every model request, every tool call with what it sent, and what it read.
    await page.getByRole('link', { name: 'Trace' }).click();
    await filterTrace(page, { kind: 'Models' });
    await expect(page.getByText(/a-model · credit \(402\)/).first()).toBeVisible();
    await expect(page.getByText(/b-model · ok \(200\)/).first()).toBeVisible();
    await filterTrace(page, { kind: 'Tools' });
    await expect(page.getByText(/^write \{"path":"\/trip\/notes\/dinner\.md"/)).toBeVisible();
    await expect(page.getByText(/^write · ok · \d+ ms · Wrote \/trip\/notes\/dinner\.md/)).toBeVisible();
    await filterTrace(page, { kind: 'Conversation' });
    await expect(page.getByText(/the user wrote · (free|\$)/).first()).toBeVisible(); // the stand-in model has no prices
    for (const summary of await page.locator('ol.trace summary').all()) await summary.click();
    expect(await page.locator('ol.trace').innerText()).not.toContain('sk-test-secret');
  } finally {
    await llm.stop();
  }
});

test('removing the trip Shiori is working in: she stops first, and nothing of it is left behind (spec §4.9)', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [{ ...sse(anthropicToolReply([{ name: 'speak', input: { text: 'Too late.' } }, { name: 'sleep', input: {} }])), delayMs: 3000 }] });
  try {
    await setUp(page, llm.origin);
    const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Where should we eat?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.talk-label')).toHaveText('Thinking · tap to stop');
    await page.evaluate((trip) => { location.hash = `#/trip/${encodeURIComponent(trip)}`; }, id);
    await page.getByRole('button', { name: 'Remove trip' }).click();
    await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
    await page.waitForTimeout(500);
    const left = await page.evaluate((scope) => new Promise((resolve, reject) => {
      const r = indexedDB.open('annai');
      r.onsuccess = () => {
        const all = r.result.transaction('events').objectStore('events').getAll();
        all.onsuccess = () => { r.result.close(); resolve(all.result.filter((/** @type {any} */ e) => e.scope === scope).map((/** @type {any} */ e) => e.type)); };
        all.onerror = () => reject(all.error);
      };
      r.onerror = () => reject(r.error);
    }), id);
    expect(left).toEqual([]);
  } finally {
    await llm.stop();
  }
});

test('milestone 2 done: a photo conversation with tool use and fallback across two providers; a refused photo is repaired by itself; the trace shows it all', async ({ page }) => {
  // The longest flow here (two endpoints, a photo, three model calls, a reload, the trace): on a loaded machine it ran out of
  // the 90 s a test has before its end, the Trace filter (on a container held to 1 CPU, 6 of 6 in WebKit). Each step keeps its own limit.
  test.slow();
  const refusal = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 6000000 bytes > 4000 bytes' } });
  const llm = await startModelServer({
    '/a/v1/chat/completions': { status: 402, type: 'application/json', body: JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }) },
    '/b/v1/messages': [
      { status: 400, type: 'application/json', body: refusal },
      sse(anthropicToolReply([{ name: 'write', input: { path: '/trip/notes/menu.md', content: 'Ambrosia burger' } }], 'Noting the dish.')),
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'That is the Ambrosia burger.' } }, { name: 'sleep', input: {} }])),
    ],
  });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Chat Completions', name: 'Endpoint A', url: `${llm.origin}/a/v1`, key: 'sk-test-secret-a', model: 'a-model' });
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Endpoint B', url: `${llm.origin}/b`, key: 'sk-test-secret-b', model: 'b-model' });
    // Both take photos: a model that doesn't is skipped for a photo turn, and A is meant to be tried.
    for (const [ep, m] of [['Endpoint A', 'a-model'], ['Endpoint B', 'b-model']]) {
      await page.goto('/#/models');
      await page.getByRole('link', { name: new RegExp(ep) }).click();
      await page.getByRole('link', { name: new RegExp(`^${m}`) }).click();
      await page.getByLabel('Takes photos').check();
      await expect(savedBy(page.getByLabel('Takes photos'))).toHaveText('Saved');
    }
    await page.goto('/#/models');
    for (const m of ['a-model', 'b-model']) {
      await page.getByLabel('Add a model to main').selectOption({ label: m });
      await page.getByRole('button', { name: 'Add to main' }).click();
    }
    await page.goto('/#/trips');
    await page.getByLabel('Trip name').fill('Big Sur');
    await page.getByRole('button', { name: 'Start trip' }).click();
    await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
    // A photo over the request limits (2000 px), so Shiori is sent a copy, which the refusal then replaces.
    const big = await page.evaluate(async () => {
      const c = new OffscreenCanvas(3000, 2000);
      const g = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
      g.fillStyle = '#0a7';
      g.fillRect(0, 0, 3000, 2000);
      return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer())];
    });
    await page.locator('#dock-camera').setInputFiles({ name: 'IMG_0002.JPG', mimeType: 'image/jpeg', buffer: Buffer.from(big) });
    await expect(page.locator('.convo .you img')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.convo .shiori p').last()).toHaveText('That is the Ambrosia burger.', { timeout: 20_000 });
    // After a reload your bubble still shows the photo: the copy Shiori was sent in the end (spec §4.8).
    await page.reload();
    await page.goto('/#/talk');
    await expect(page.locator('.convo .you img')).toBeVisible();
    expect(await page.locator('.convo .you img').evaluate((/** @type {HTMLImageElement} */ i) => i.decode().then(() => i.naturalWidth))).toBeGreaterThan(0);
    await page.getByRole('link', { name: 'Trace' }).click();
    await page.getByLabel('Type contains').fill('photo.replace');
    await expect(page.locator('ol.trace > li')).toHaveCount(1);
    await filterTrace(page, { type: '', kind: 'Models' });
    await expect(page.getByText(/a-model · credit \(402\)/).first()).toBeVisible();
    await expect(page.getByText(/b-model · image \(400\)/).first()).toBeVisible();
    await expect(page.getByText(/b-model · ok \(200\)/).first()).toBeVisible();
    for (const summary of await page.locator('ol.trace summary').all()) await summary.click();
    expect(await page.locator('ol.trace').innerText()).not.toContain('sk-test-secret');
  } finally {
    await llm.stop();
  }
});

test('the conversation follows what comes, clear of the dock: your new question and her answer show without scrolling, and "Nothing yet" goes with the first message (the emulator pass)', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [{ ...sse(anthropicToolReply([{ name: 'speak', input: { text: 'Light rain around 1 PM.' } }, { name: 'sleep', input: {} }])), delayMs: 1500 }] });
  try {
    await page.setViewportSize({ width: 360, height: 640 });
    await modelSetUp(page, llm.origin);
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    /** Whether an element is on screen, above the dock. @param {import('@playwright/test').Locator} l */
    const clear = (l) => l.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= /** @type {Element} */ (document.querySelector('nav.dock')).getBoundingClientRect().top + 1;
    });
    const send = async (/** @type {string} */ text) => {
      await page.getByRole('button', { name: 'Type' }).click();
      await page.getByLabel('Message to Shiori').fill(text);
      await page.getByRole('button', { name: 'Send' }).click();
    };
    await page.goto('/#/talk');
    const empty = page.getByText('Nothing yet. Tap Shiori or Type below to talk.');
    await expect(empty).toBeVisible();
    await send('Hello');
    await expect(page.locator('.convo .you')).toHaveText('Hello');
    await expect(empty).toHaveCount(0);
    await expect(page.locator('.convo .shiori p')).toHaveText('Light rain around 1 PM.');
    // A long conversation, opened: its last words show above the dock.
    for (let i = 0; i < 12; i++) {
      await writeEvent(page, trip, { type: 'msg.user', data: { text: `Question ${i}` } });
      await writeEvent(page, trip, { type: 'out.speak', data: { text: `Answer ${i}, in a few words that take a line or two on a phone.` } });
    }
    await page.goto('/#/trips');
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await page.goto('/#/talk');
    const last = page.locator('.convo > li').last();
    await expect(last).toHaveText(/Answer 11/);
    await expect.poll(() => clear(last)).toBe(true);
    // Asked while she works: the question shows at once, then her answer.
    await send("What's the weather at Bixby Bridge today?");
    const mine = page.locator('.convo .you', { hasText: 'Bixby Bridge' });
    await expect(mine).toBeVisible();
    await expect(page.locator('.talk-label')).toHaveText('Thinking · tap to stop');
    await expect.poll(() => clear(mine)).toBe(true);
    const hers = page.locator('.convo .shiori').last();
    await expect(hers).toHaveText(/Light rain around 1 PM\./);
    await expect.poll(() => clear(hers)).toBe(true);
  } finally {
    await llm.stop();
  }
});

test('review S3: after a photo, the conversation keeps following: her answer shows above the dock once the photo has loaded and grown the page', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [{ ...sse(anthropicToolReply([{ name: 'speak', input: { text: 'That is the Ambrosia burger.' } }, { name: 'sleep', input: {} }])), delayMs: 2500 }] });
  try {
    await page.setViewportSize({ width: 360, height: 640 });
    await modelSetUp(page, llm.origin);
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await page.goto('/#/models');
    await page.getByRole('link', { name: /Stand-in/ }).click();
    await page.getByRole('link', { name: /^b-model/ }).click();
    await page.getByLabel('Takes photos').check();
    await expect(savedBy(page.getByLabel('Takes photos'))).toHaveText('Saved');
    for (let i = 0; i < 8; i++) {
      await writeEvent(page, trip, { type: 'msg.user', data: { text: `Question ${i}` } });
      await writeEvent(page, trip, { type: 'out.speak', data: { text: `Answer ${i}, in a few words that take a line or two on a phone.` } });
    }
    await page.goto('/#/talk');
    await expect(page.locator('.convo > li').last()).toHaveText(/Answer 7/);
    const big = await page.evaluate(async () => {
      const c = new OffscreenCanvas(1200, 1600);
      const g = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
      g.fillStyle = '#0a7';
      g.fillRect(0, 0, 1200, 1600);
      return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer())];
    });
    await page.locator('#dock-camera').setInputFiles({ name: 'IMG_0002.JPG', mimeType: 'image/jpeg', buffer: Buffer.from(big) });
    await expect(page.locator('.convo .you img')).toBeVisible({ timeout: 20_000 });
    const hers = page.locator('.convo .shiori p').last();
    await expect(hers).toHaveText('That is the Ambrosia burger.', { timeout: 20_000 });
    await expect.poll(() => hers.evaluate((el) => el.getBoundingClientRect().bottom <= /** @type {Element} */ (document.querySelector('nav.dock')).getBoundingClientRect().top + 1)).toBe(true);
  } finally {
    await llm.stop();
  }
});

test('review S3: a scroll of the user\'s own stops the following: what comes then stays where the user is reading', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [{ ...sse(anthropicToolReply([{ name: 'speak', input: { text: 'Light rain around 1 PM.' } }, { name: 'sleep', input: {} }])), delayMs: 1500 }] });
  try {
    await page.setViewportSize({ width: 360, height: 640 });
    await modelSetUp(page, llm.origin);
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    for (let i = 0; i < 12; i++) {
      await writeEvent(page, trip, { type: 'msg.user', data: { text: `Question ${i}` } });
      await writeEvent(page, trip, { type: 'out.speak', data: { text: `Answer ${i}, in a few words that take a line or two on a phone.` } });
    }
    await page.goto('/#/talk');
    await expect(page.locator('.convo > li').last()).toHaveText(/Answer 11/);
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Weather?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.talk-label')).toHaveText('Thinking · tap to stop');
    await page.evaluate(() => { // the user reads back, a wheel's turn (mobile WebKit takes no mouse wheel from Playwright)
      dispatchEvent(new WheelEvent('wheel', { deltaY: -600 }));
      scrollBy(0, -600);
    });
    const y = await page.evaluate(() => scrollY);
    expect(y).toBeGreaterThan(0);
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Light rain around 1 PM.');
    await page.waitForTimeout(300);
    expect(Math.abs(await page.evaluate(() => scrollY) - y)).toBeLessThan(2);
  } finally {
    await llm.stop();
  }
});

// The second emulator re-check: after Undo, the personality card still offered Undo, with nothing saying it was undone.
test('after Undo, the personality card says "Undone" and offers no second Undo; one for a change already back as it was starts that way', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  /** The personality file written twice, as Shiori tuned it, and the card that says so, through annai's own modules. */
  const tuned = await page.evaluate(async (trip) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { logEvent } = await load('/src/core/events.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    await ws.write('me', '/personalities/shiori.md', 'Be warm.', { author: 'user' });
    const old = (await ws.read('me', '/personalities/shiori.md')).entry.hash;
    await ws.write('me', '/personalities/shiori.md', 'Be warm and brief.', { author: 'shiori' });
    await logEvent(store, trip, { type: 'out.show', actor: 'shiori', data: { id: 'tune-1', card: { title: 'I adjusted my personality', text: 'You asked for brevity.' }, tune: { name: 'shiori', old } } });
    store.close();
    return old;
  }, trip);
  expect(tuned).toBeTruthy();
  await page.goto('/#/talk');
  const card = page.locator('.convo .shiori', { hasText: 'I adjusted my personality' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Undo' }).click();
  await expect(card.getByText('Undone', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  // Drawn again, the card knows: the file is back as it was.
  await page.goto('/#/trips');
  await page.goto('/#/talk');
  await expect(page.locator('.convo .shiori', { hasText: 'I adjusted my personality' }).getByText('Undone', { exact: true })).toBeVisible();
});
