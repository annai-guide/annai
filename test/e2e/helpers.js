import { expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

/**
 * Changes a Trace screen filter and waits until the list has redrawn for it (the list is aria-busy while it reloads),
 * so what a test reads next is the new list, not the one before the change.
 * @param {import('@playwright/test').Page} page
 * @param {{ kind?: string, type?: string }} filters
 */
export async function filterTrace(page, { kind, type }) {
  if (type !== undefined) await page.getByLabel('Type contains').fill(type);
  if (kind !== undefined) await page.getByLabel('Kind').selectOption(kind);
  await expect(page.locator('ol.trace')).toHaveAttribute('aria-busy', 'false');
}

/**
 * Starts a dev server of the test's own, so a test can take the network away for real by stopping it.
 * (Playwright's offline mode in WebKit also blocks requests the service worker answers itself.)
 * @param {number} port
 */
export async function startServer(port) {
  const script = fileURLToPath(new URL('../../scripts/serve.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--port', String(port)], { stdio: ['ignore', 'ignore', 'inherit'] });
  const origin = `http://127.0.0.1:${port}`;
  const stop = () => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
  try {
    await expect.poll(async () => { try { return (await fetch(`${origin}/_headers`)).ok; } catch { return false; } }).toBe(true);
  } catch (e) {
    await stop();
    throw e;
  }
  return { origin, stop };
}

/** Collects console errors and uncaught page errors. @param {import('@playwright/test').Page} page */
export function watchConsole(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Opens annai and waits for the first screen. Exports always download in tests (no share sheet). @param {import('@playwright/test').Page} page @param {string} [hash] */
export async function openApp(page, hash = '') {
  await page.addInitScript(() => { try { localStorage.setItem('annai.forceDownload', '1'); } catch { /* storage blocked */ } });
  await page.goto('/' + hash);
  await expect(page.locator('main.view > *')).toBeVisible();
}

/** @param {import('@playwright/test').Page} page */
export async function waitForServiceWorker(page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
}

/** Builds the file, then saves it with a separate tap (the iOS share sheet needs a fresh tap). @param {import('@playwright/test').Page} page */
export async function buildAndSave(page) {
  const save = page.getByRole('button', { name: 'Save file' });
  await expect(save).toBeHidden();
  await page.getByRole('button', { name: 'Build file' }).click();
  await expect(save).toBeVisible({ timeout: 60_000 });
  const downloading = page.waitForEvent('download');
  await save.click();
  const download = await downloading;
  return /** @type {string} */ (await download.path());
}

/**
 * A stand-in model server on its own port, for tests that need real CORS (WebKit can't route
 * requests from a page a service worker controls). A route is a reply, or a list of replies served
 * in turn (the last repeats); a reply may wait delayMs. bodies(path) gives what was posted: parsed JSON, or the bytes.
 * @param {Record<string, { status: number, type: string, body: string | Buffer, delayMs?: number } | { status: number, type: string, body: string | Buffer, delayMs?: number }[]>} routes
 */
export async function startModelServer(routes) {
  /** @type {Map<any, number>} */
  const served = new Map();
  /** @type {Map<string, any[]>} */
  const received = new Map();
  const server = http.createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'content-type'),
    };
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'POST') {
        const raw = Buffer.concat(chunks);
        /** @type {any} */
        let body = raw;
        try {
          body = JSON.parse(raw.toString('utf8') || 'null');
        } catch {
          // not JSON (a multipart upload): kept as bytes
        }
        received.set(path, [...(received.get(path) ?? []), body]);
      }
      const route = routes[path];
      const n = served.get(route) ?? 0;
      served.set(route, n + 1);
      const r = Array.isArray(route) ? route[Math.min(n, route.length - 1)] : route;
      if (!r) {
        res.writeHead(404, cors).end('not found');
        return;
      }
      setTimeout(() => {
        if (!res.destroyed) res.writeHead(r.status, { ...cors, 'content-type': r.type }).end(r.body);
      }, r.delayMs ?? 0);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    /** @param {string} path */
    bodies: (path) => received.get(path) ?? [],
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }),
  };
}

/**
 * From the Models screen: adds an endpoint from a template (installing its plugin), names it,
 * sets its base URL and key, adds one model by id, and comes back.
 * @param {import('@playwright/test').Page} page @param {string} template
 * @param {{ name: string, url: string, key: string, model: string }} o
 */
export async function addEndpoint(page, template, { name, url, key, model }) {
  await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
  await page.getByLabel('Add an endpoint').selectOption({ label: template });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: template })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Base URL').fill(url);
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  // Saving draws the screen again: wait for the new one (its key field says a key is saved), or what is typed next is lost.
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  await page.getByLabel('Add a model by id').fill(model);
  await page.getByRole('button', { name: 'Add model' }).click();
  await expect(page.getByRole('link', { name: new RegExp(`^${model}`) })).toBeVisible();
  await page.getByRole('link', { name: '← Models' }).click();
}

/**
 * An Anthropic Messages SSE reply that calls tools, with optional text first.
 * @param {{ name: string, input: any }[]} calls @param {string} [text]
 */
export function anthropicToolReply(calls, text = '') {
  const ev = (/** @type {string} */ type, /** @type {any} */ data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev('message_start', { message: { id: 'msg_e2e', type: 'message', role: 'assistant', usage: { input_tokens: 400, output_tokens: 1 } } });
  let i = 0;
  if (text) {
    out += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
    out += ev('content_block_delta', { index: i, delta: { type: 'text_delta', text } });
    out += ev('content_block_stop', { index: i++ });
  }
  for (const [n, c] of calls.entries()) {
    out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: `toolu_e2e_${n}_${Math.random().toString(36).slice(2, 8)}`, name: c.name, input: {} } });
    out += ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
    out += ev('content_block_stop', { index: i++ });
  }
  out += ev('message_delta', { delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } });
  return out + ev('message_stop', {});
}

/**
 * A fake microphone fed from WAV files (spec §18). Each time annai opens the microphone it hears
 * the next clip (the last one repeats), 0.4 s after opening, then silence. getUserMedia gives a
 * stream played by Web Audio, which works the same in Chromium and WebKit. window.__micOpens
 * counts the openings.
 * @param {import('@playwright/test').Page} page @param {string[]} clips paths of WAV files
 */
export async function fakeMicrophone(page, clips) {
  const data = await Promise.all(clips.map(async (p) => (await readFile(p)).toString('base64')));
  await page.addInitScript((wavs) => {
    const w = /** @type {any} */ (window);
    w.__micOpens = 0;
    if (typeof MediaDevices === 'undefined') return;
    // On the prototype: WebKit drops a method set on navigator.mediaDevices this early.
    MediaDevices.prototype.getUserMedia = async () => {
      const b64 = wavs[Math.min(w.__micOpens, wavs.length - 1)];
      w.__micOpens++;
      const ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const source = ctx.createBufferSource();
      source.buffer = await ctx.decodeAudioData(bytes.buffer);
      const out = ctx.createMediaStreamDestination();
      source.connect(out);
      source.start(ctx.currentTime + 0.4);
      for (const t of out.stream.getTracks()) {
        const stop = t.stop.bind(t);
        t.stop = () => { stop(); ctx.close().catch(() => {}); };
      }
      return out.stream;
    };
  }, data);
}
