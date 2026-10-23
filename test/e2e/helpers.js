import { expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { ZipWriter } from '../../src/core/zip.js';

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

/**
 * Opens annai and waits for the first screen. Exports always download in tests (no share sheet).
 * It opens Trips by its address, not annai's plain start, where a fresh device is welcomed first
 * (welcome.spec.js tests that).
 * @param {import('@playwright/test').Page} page @param {string} [hash]
 */
export async function openApp(page, hash = '#/trips') {
  await page.addInitScript(() => { try { localStorage.setItem('annai.forceDownload', '1'); } catch { /* storage blocked */ } });
  await page.goto('/' + hash);
  await expect(page.locator('main.view > *')).toBeVisible();
}

/**
 * After Erase, annai starts as on a new device: the welcome, at the plain start. Goes on to Trips by the top bar.
 * @param {import('@playwright/test').Page} page
 */
export async function pastWelcome(page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to annai' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
}

/**
 * Turns on Settings → Experimental → "Swipe sideways to move between tabs", which is off by default,
 * and waits until the shell takes swipes.
 * @param {import('@playwright/test').Page} page
 */
export async function turnOnSwipes(page) {
  await page.evaluate(() => { location.hash = '#/experimental'; });
  await page.getByRole('checkbox', { name: 'Swipe sideways to move between tabs' }).check();
  await expect(page.locator('main.view')).toHaveClass(/\bswipes\b/);
}

/**
 * The quiet "Saved" by a setting that saves as it changes (spec §16.1). Saves run one after another,
 * so once a setting's says Saved, every change before it is written too.
 * @param {import('@playwright/test').Locator} control
 */
export function savedBy(control) {
  return control.locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " saving ")][1]').getByRole('status');
}

/**
 * Commits a field (leaving it) and waits for its "Saved". A "Saved" from an earlier save stays up 4 s, and WebKit may send the change a
 * moment after blur() returns, so reading the note's text can mistake that one for this save's (the next step then ran before the save,
 * and read what was there before it). It counts the times the note becomes "Saved" and waits for one more. The note is found again
 * after the blur, each time: if the screen is drawn again meanwhile the new note counts from nothing, and "Saved" on it is this save's.
 * @param {import('@playwright/test').Locator} control
 */
export async function leaveSaved(control) {
  const note = savedBy(control);
  // Counts the times the element says Saved, from when it is first looked at: the count so far, or (given a count) whether it has gone past it.
  // An element seen for the first time after the blur is a new one, and it is this save's if it says Saved.
  const watch = (/** @type {any} */ el, /** @type {number | null} */ before) => {
    const first = el.savesSeen === undefined;
    if (first) {
      el.savesSeen = 0;
      new MutationObserver(() => { if (el.textContent === 'Saved') el.savesSeen += 1; }).observe(el, { childList: true, characterData: true, subtree: true });
    }
    return before === null ? el.savesSeen : first ? el.textContent === 'Saved' : el.savesSeen > before;
  };
  const before = await note.evaluate(watch, null, { timeout: 10_000 });
  await control.blur();
  await expect.poll(() => note.evaluate(watch, before), { timeout: 10_000, message: 'the field says Saved' }).toBe(true);
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
 * An empty request (no model: {}, or only an output limit), as Custom provider sends to look for what a server
 * offers, is refused with 400 on a route it has, as a real server refuses it, and is neither served a reply nor kept
 * among the bodies.
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
      const route = routes[path];
      if (req.method === 'POST') {
        const raw = Buffer.concat(chunks);
        /** @type {any} */
        let body = raw;
        try {
          body = JSON.parse(raw.toString('utf8') || 'null');
        } catch {
          // not JSON (a multipart upload): kept as bytes
        }
        if (route && body && typeof body === 'object' && !Array.isArray(body) && !(body instanceof Buffer) && !('model' in body)) {
          res.writeHead(400, { ...cors, 'content-type': 'application/json' }).end('{"error":{"type":"invalid_request_error","message":"model: Field required"}}');
          return;
        }
        received.set(path, [...(received.get(path) ?? []), body]);
      }
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
 * Models with no provider draws the one-tap start once its plugin has come in the background (milestone 4),
 * which moves what is below it: this waits until it has, so nothing moves under a tap.
 * @param {import('@playwright/test').Page} page
 */
export async function startSettled(page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Getting the sign-in ready…' })).toHaveCount(0, { timeout: 30_000 });
}

/**
 * From the Models screen: Add a provider opens the catalog on model providers; the provider is found by its
 * name and Add (or Add another, once one is set up) is tapped, its plugin installed with what it needs.
 * @param {import('@playwright/test').Page} page @param {string} provider its name in the catalog
 */
export async function tapAdd(page, provider) {
  await startSettled(page);
  await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
  await page.getByLabel('Search the catalog').fill(provider);
  const escaped = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('button', { name: new RegExp(`^Add (another )?${escaped}$`) }).click();
}

/**
 * From the Models screen: the provider is added (tapAdd), by hand where its plugin has an Add flow of its own
 * (OpenRouter's sign-in, Custom provider's look: milestone 5); then its page.
 * @param {import('@playwright/test').Page} page @param {string} provider its name in the catalog
 * @param {string} [heading] its page's title, when it isn't the provider's name
 */
export async function pickProvider(page, provider, heading = provider) {
  await tapAdd(page, provider);
  const byHand = page.getByRole('button', { name: 'Add by hand' });
  await expect(byHand.or(page.getByRole('button', { name: 'Remove provider' }))).toBeVisible({ timeout: 30_000 });
  if (await byHand.isVisible()) await byHand.click();
  await expect(page.getByRole('button', { name: 'Remove provider' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

/**
 * From the Models screen: Custom provider looks at an address (with its key) and is added with what it found,
 * at no cost; then its page, named by the address's host. @param {import('@playwright/test').Page} page
 * @param {{ url: string, key?: string }} o
 */
export async function lookAndAdd(page, { url, key }) {
  await tapAdd(page, 'Custom provider');
  await page.getByLabel('Address', { exact: true }).fill(url);
  if (key) await page.getByLabel('API key (optional)').fill(key);
  await page.getByRole('button', { name: 'Look for what it offers' }).click();
  await page.getByRole('button', { name: 'Add with these' }).click({ timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1, name: new URL(url).host })).toBeVisible({ timeout: 30_000 });
}

/**
 * From the Models screen: adds a provider (installing its plugin and what it needs), names it, gives
 * its address and key, switches on one ability, adds one model by id to it, and comes back. ability:
 * the ability's name, such as "Anthropic Messages" for Custom provider; a provider's only chat ability is "Chat".
 * Custom provider looks at the address and is added with what it found (lookAndAdd), unless look is false: an
 * address with nothing there, added by hand.
 * @param {import('@playwright/test').Page} page @param {string} provider its name in the catalog
 * @param {{ ability?: string, name: string, url: string, key: string, model: string, look?: boolean }} o
 */
export async function addProvider(page, provider, { ability = 'Chat', name, url, key, model, look = true }) {
  if (provider === 'Custom provider' && look) {
    // Its address and key were saved by Add with these: only the name, which saves as it changes.
    await lookAndAdd(page, { url, key });
    await page.getByLabel('Name', { exact: true }).fill(name);
    await leaveSaved(page.getByLabel('Name', { exact: true }));
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  } else {
    await pickProvider(page, provider);
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Address', { exact: true }).fill(url);
    await page.getByLabel('API key').fill(key);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    // Saving draws the screen again: wait for the new one (its key field says a key is saved), or what is typed next is lost.
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  }
  const panel = page.getByRole('region', { name: ability, exact: true });
  const use = panel.getByLabel(`Use ${ability}`);
  if (!(await use.isChecked())) {
    await use.check();
    await expect(savedBy(use)).toHaveText('Saved', { timeout: 30_000 }); // its protocol plugin, installed first
  }
  await panel.getByLabel('Add a model by id').fill(model);
  await panel.getByRole('button', { name: 'Add model' }).click();
  await expect(page.getByRole('link', { name: new RegExp(`^${model}`) })).toBeVisible();
  await page.getByRole('link', { name: '← Models' }).click();
}

/**
 * Installing from a file starts at the Add screen: picks the file there, and the install screen opens.
 * @param {import('@playwright/test').Page} page @param {{ name: string, mimeType: string, buffer: Buffer }} file
 */
export async function pickFile(page, file) {
  await page.goto('/#/add');
  await page.getByLabel('Install from a file').setInputFiles(file);
}

/** Installing from an address starts at the Add screen: Get it, and the install screen opens. @param {import('@playwright/test').Page} page @param {string} url */
export async function pickAddress(page, url) {
  await page.goto('/#/add');
  await page.getByLabel('Address of a plugin or skill').fill(url);
  await page.getByRole('button', { name: 'Get it' }).click();
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
 * An OpenAI Responses SSE reply: an encrypted reasoning item if given, text if given, then function calls.
 * @param {{ text?: string, calls?: { name: string, input: any }[], reasoning?: { id: string, summary: string, encrypted: string } }} r
 */
export function responsesReply({ text = '', calls = [], reasoning } = {}) {
  const ev = (/** @type {string} */ type, /** @type {any} */ data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev('response.created', { response: { id: 'resp_e2e', status: 'in_progress', output: [] } });
  let i = 0;
  if (reasoning) {
    out += ev('response.output_item.added', { output_index: i, item: { id: reasoning.id, type: 'reasoning', summary: [] } });
    out += ev('response.reasoning_summary_text.delta', { item_id: reasoning.id, output_index: i, summary_index: 0, delta: reasoning.summary });
    const item = { id: reasoning.id, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: reasoning.summary }], encrypted_content: reasoning.encrypted };
    out += ev('response.output_item.done', { output_index: i++, item });
  }
  if (text) {
    const id = `msg_e2e_${i}`;
    out += ev('response.output_item.added', { output_index: i, item: { id, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
    out += ev('response.output_text.delta', { item_id: id, output_index: i, content_index: 0, delta: text });
    out += ev('response.output_item.done', { output_index: i++, item: { id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } });
  }
  for (const [n, c] of calls.entries()) {
    const args = JSON.stringify(c.input);
    const item = { id: `fc_e2e_${n}`, type: 'function_call', call_id: `call_e2e_${n}_${Math.random().toString(36).slice(2, 8)}`, name: c.name, arguments: args };
    out += ev('response.output_item.added', { output_index: i, item: { ...item, status: 'in_progress', arguments: '' } });
    out += ev('response.function_call_arguments.delta', { item_id: item.id, output_index: i, delta: args });
    out += ev('response.output_item.done', { output_index: i++, item: { ...item, status: 'completed' } });
  }
  const usage = { input_tokens: 400, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 } };
  return out + ev('response.completed', { response: { id: 'resp_e2e', status: 'completed', output: [], usage } });
}

/**
 * A fake microphone fed from WAV files (spec §18). Each time annai opens the microphone it hears
 * the next clip (the last one repeats), 0.4 s after opening, then silence. getUserMedia gives a
 * stream played by Web Audio, which works the same in Chromium and WebKit. window.__micOpens
 * counts the openings. loopback: the phone's speaker heard by its microphone; whatever the page plays (anything
 * connected to an AudioContext's destination) goes into the microphone too, as loud as it was played.
 * @param {import('@playwright/test').Page} page @param {string[]} clips paths of WAV files @param {{ loopback?: boolean }} [o]
 */
export async function fakeMicrophone(page, clips, { loopback = false } = {}) {
  const data = await Promise.all(clips.map(async (p) => (await readFile(p)).toString('base64')));
  await page.addInitScript(([wavs, loop]) => {
    const w = /** @type {any} */ (window);
    w.__micOpens = 0;
    if (typeof MediaDevices === 'undefined') return;
    /** What each of the page's AudioContexts plays, as a stream, and the microphones that hear it. @type {MediaStream[]} */
    const played = [];
    /** @type {((s: MediaStream) => void)[]} */
    const ears = [];
    const connect = AudioNode.prototype.connect;
    if (loop) {
      /** @this {AudioNode} @param {any} dest @param {...any} rest */
      AudioNode.prototype.connect = /** @type {any} */ (function (dest, ...rest) {
        const r = /** @type {any} */ (connect).call(this, dest, ...rest);
        if (dest instanceof AudioDestinationNode) {
          const c = /** @type {any} */ (this.context);
          if (!c.__loop) {
            c.__loop = c.createMediaStreamDestination();
            played.push(c.__loop.stream);
            for (const ear of ears) ear(c.__loop.stream);
          }
          /** @type {any} */ (connect).call(this, c.__loop);
        }
        return r;
      });
    }
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
      if (loop) {
        const ear = (/** @type {MediaStream} */ s) => { /** @type {any} */ (connect).call(ctx.createMediaStreamSource(s), out); };
        played.forEach(ear);
        ears.push(ear);
      }
      for (const t of out.stream.getTracks()) {
        const stop = t.stop.bind(t);
        t.stop = () => { stop(); ctx.close().catch(() => {}); };
      }
      return out.stream;
    };
  }, /** @type {[string[], boolean]} */ ([data, loopback]));
}

/** Starts a trip from the Trips screen and returns its id. @param {import('@playwright/test').Page} page @param {string} title */
export async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  return decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
}

/**
 * Writes trip records through annai's own modules in the page, with no format check (so a broken
 * file can be written too); patches merge into existing JSON. author: who wrote them (the user's by default).
 * @param {import('@playwright/test').Page} page @param {string} trip
 * @param {{ write?: Record<string, any>, text?: Record<string, string>, patch?: Record<string, any>, author?: string }} c
 */
export async function writeRecords(page, trip, c) {
  await page.evaluate(async ({ trip, c }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const author = c.author ?? 'user';
    for (const [path, value] of Object.entries(c.write ?? {})) await ws.write(trip, path, value, { author });
    for (const [path, value] of Object.entries(c.text ?? {})) await ws.write(trip, path, value, { author, type: 'text/plain' });
    for (const [path, value] of Object.entries(c.patch ?? {})) await ws.patch(trip, path, value, { author });
    store.close();
  }, { trip, c });
}

/** Appends an entry to a scope's log through annai's own modules in the page. @param {import('@playwright/test').Page} page @param {string} scope @param {{ type: string, data: any }} ev */
export async function writeEvent(page, scope, ev) {
  await page.evaluate(async ({ scope, ev }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { logEvent } = await load('/src/core/events.js');
    const store = await createIdbStore();
    await logEvent(store, scope, { type: ev.type, actor: 'system', data: ev.data });
    store.close();
  }, { scope, ev });
}

/**
 * Every file of a package under test/fixtures/extensions/<dir>/, by its path inside the package.
 * @param {string} dir @returns {Promise<Record<string, Buffer>>}
 */
export async function fixtureFiles(dir) {
  const root = new URL(`../fixtures/extensions/${dir}/`, import.meta.url);
  /** @type {Record<string, Buffer>} */
  const out = {};
  for (const name of await readdir(root, { recursive: true })) {
    const url = new URL(name, root);
    if ((await stat(url)).isFile()) out[name.split('\\').join('/')] = await readFile(url);
  }
  return out;
}

/** A zip of a package's files, inside one top folder when top is given. @param {Record<string, Buffer>} files @param {string} [top] */
export async function zipOf(files, top) {
  const z = new ZipWriter();
  for (const [name, bytes] of Object.entries(files)) await z.add(top ? `${top}/${name}` : name, new Uint8Array(bytes));
  return Buffer.from(await z.finish().arrayBuffer());
}

/**
 * Shiori's main model on a stand-in Anthropic server at origin (/b), through Custom provider and its
 * Anthropic Messages ability, and a trip, from a fresh start. look: false for an address with nothing there.
 * @param {import('@playwright/test').Page} page @param {string} origin @param {string} [trip] @param {{ look?: boolean }} [o]
 */
export async function modelSetUp(page, origin, trip = 'Big Sur', { look = true } = {}) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model', look });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await page.goto('/#/trips');
  await page.getByLabel('Trip name').fill(trip);
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: trip })).toBeVisible();
}

/**
 * Shiori as two halves (the Koe and Kokoro design), from a fresh start: Kokoro (main) and Koe on stand-in
 * Anthropic servers at origin (/kokoro and /koe), through two Custom provider
 * providers, and a trip.
 * @param {import('@playwright/test').Page} page @param {string} origin @param {string} [trip]
 */
export async function koeSetUp(page, origin, trip = 'Big Sur') {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Kokoro stand-in', url: `${origin}/kokoro`, key: 'sk-test-kokoro', model: 'kokoro-model' });
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Koe stand-in', url: `${origin}/koe`, key: 'sk-test-koe', model: 'koe-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'kokoro-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await expect(page.getByText('1. kokoro-model')).toBeVisible();
  await page.getByLabel('Add a model to Koe · Classic').selectOption({ label: 'koe-model' });
  await page.getByRole('button', { name: 'Add to Koe · Classic' }).click();
  await expect(page.getByText('1. koe-model')).toBeVisible();
  await page.goto('/#/trips');
  await page.getByLabel('Trip name').fill(trip);
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: trip })).toBeVisible();
}
