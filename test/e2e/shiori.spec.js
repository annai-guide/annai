import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply } from './helpers.js';

test('the avatar: states change her look, the level reaches the seat, and there is no innerHTML or style attribute', async ({ page }) => {
  await page.goto('/');
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
  expect(await page.locator('#probe svg .marker').count()).toBe(1);
  await page.evaluate(() => /** @type {any} */ (window).__a.setState('away'));
  await expect(av).toHaveAttribute('data-state', 'away');
});

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

/** A trip, and Shiori's main model on a stand-in Anthropic endpoint. @param {any} page @param {string} origin */
async function setUp(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
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
    await addEndpoint(page, 'Other: Chat Completions', { name: 'Endpoint A', url: `${llm.origin}/a/v1`, key: 'sk-test-secret-a', model: 'a-model' });
    await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Endpoint B', url: `${llm.origin}/b`, key: 'sk-test-secret-b', model: 'b-model' });
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
    await expect(page.locator('.talk-label')).toHaveText('Thinking');
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
    await page.getByLabel('Kind').selectOption('Models');
    await expect(page.getByText(/a-model · credit \(402\)/).first()).toBeVisible();
    await expect(page.getByText(/b-model · ok \(200\)/).first()).toBeVisible();
    await page.getByLabel('Kind').selectOption('Tools');
    await expect(page.getByText(/^write \{"path":"\/trip\/notes\/dinner\.md"/)).toBeVisible();
    await expect(page.getByText(/^write · ok · \d+ ms · Wrote \/trip\/notes\/dinner\.md/)).toBeVisible();
    await page.getByLabel('Kind').selectOption('Conversation');
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
    await expect(page.locator('.talk-label')).toHaveText('Thinking');
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
    await addEndpoint(page, 'Other: Chat Completions', { name: 'Endpoint A', url: `${llm.origin}/a/v1`, key: 'sk-test-secret-a', model: 'a-model' });
    await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Endpoint B', url: `${llm.origin}/b`, key: 'sk-test-secret-b', model: 'b-model' });
    // Both take photos: a model that doesn't is skipped for a photo turn, and A is meant to be tried.
    for (const [ep, m] of [['Endpoint A', 'a-model'], ['Endpoint B', 'b-model']]) {
      await page.goto('/#/models');
      await page.getByRole('link', { name: new RegExp(ep) }).click();
      await page.getByRole('link', { name: new RegExp(`^${m}`) }).click();
      await page.getByLabel('Takes photos').check();
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByLabel('Takes photos')).toBeChecked();
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
    await page.getByLabel('Type contains').fill('');
    await page.getByLabel('Kind').selectOption('Models');
    await expect(page.getByText(/a-model · credit \(402\)/).first()).toBeVisible();
    await expect(page.getByText(/b-model · image \(400\)/).first()).toBeVisible();
    await expect(page.getByText(/b-model · ok \(200\)/).first()).toBeVisible();
    for (const summary of await page.locator('ol.trace summary').all()) await summary.click();
    expect(await page.locator('ol.trace').innerText()).not.toContain('sk-test-secret');
  } finally {
    await llm.stop();
  }
});
