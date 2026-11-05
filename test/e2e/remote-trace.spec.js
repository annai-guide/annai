import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModelServer, anthropicToolReply, addProvider, openApp, waitForServiceWorker, startTrip, fakeMicrophone } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const TOKEN = 'e2e-trace-token-0123456789abcdef';
const KEY = 'sk-e2e-remote-trace-model-key-0123';

/**
 * scripts/trace-sink.mjs as a developer runs it, on a port of its own (port 0: never one of annai's), taking
 * batches from the page's origin and writing them to a file in a folder of its own.
 * @param {string} origin
 */
async function startSink(origin) {
  const dir = await mkdtemp(join(tmpdir(), 'annai-e2e-sink-'));
  const out = join(dir, 'trace.jsonl');
  const script = fileURLToPath(new URL('../../scripts/trace-sink.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--port', '0', '--token', TOKEN, '--out', out, '--origin', origin], { stdio: ['ignore', 'pipe', 'inherit'] });
  /** @type {string} */
  const url = await new Promise((resolve, reject) => {
    let said = '';
    child.stdout.on('data', (d) => {
      said += String(d);
      const m = /(http:\/\/127\.0\.0\.1:\d+)\//.exec(said);
      if (m) resolve(m[1]);
    });
    child.once('exit', () => reject(new Error(`the sink exited: ${said}`)));
  });
  const text = () => readFile(out, 'utf8').catch(() => '');
  return {
    url, text, dir,
    /** @returns {Promise<any[]>} */
    lines: async () => (await text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once('exit', r); child.kill(); });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('Remote trace, installed from the catalog, sends a conversation to a sink the test runs, without the token or the key; its chip shows while it is on, and Off stops it', async ({ page }) => {
  const origin = new URL(String(test.info().project.use.baseURL)).origin;
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'The fog lifts by noon.' } }, { name: 'sleep', input: {} }]))] });
  const sink = await startSink(origin);
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: KEY, model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/trips');
    await startTrip(page, 'Big Sur');

    await page.goto('/#/add');
    await page.getByRole('button', { name: 'Install Remote trace (for developers)' }).click();
    await expect(page.getByText('Installed Remote trace (for developers).')).toBeVisible();
    await page.getByRole('link', { name: 'Open Remote trace (for developers)' }).click();
    await expect(page.getByRole('heading', { name: 'Remote trace (for developers)' })).toBeVisible();
    // Off until configured: no chip yet.
    await expect(page.getByRole('button', { name: 'Sending trace' })).toHaveCount(0);
    // Plain settings save as they change; the token has a Save button of its own (spec §16.1). Send, ticked
    // before the token is saved, saves at once and the plugin's chip appears: the token typed is still there (review, 2026-10-18).
    await page.getByLabel('Server address').fill(`${sink.url}/trace`);
    await page.getByLabel('Token').fill(TOKEN);
    await page.getByRole('checkbox', { name: 'Send', exact: true }).check();
    const chip = page.getByRole('button', { name: 'Sending trace' });
    await expect(chip).toBeVisible();
    await page.waitForTimeout(300); // longer than the shell takes to draw the screen again after the chip
    await expect(page.getByLabel('Token')).toHaveValue(TOKEN);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByLabel('Token')).toHaveAttribute('placeholder', 'saved');

    // The chip, short in the dock's row; a tap opens the plugin's page.
    await expect(chip).toHaveText('Trace');
    const box = await chip.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(40);
    expect(box?.width).toBeLessThanOrEqual(64);
    await page.goto('/#/trips');
    await chip.click();
    await expect(page.getByRole('heading', { name: 'Remote trace (for developers)' })).toBeVisible();

    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill(`Will the fog lift? My token is ${TOKEN}, my key ${KEY}.`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo .shiori p')).toHaveText('The fog lifts by noon.');

    // Within a few seconds, the conversation is in the sink's file, one entry a line.
    await expect.poll(async () => (await sink.lines()).map((l) => l.type), { timeout: 20_000 }).toEqual(expect.arrayContaining(['wake', 'msg.user', 'net.request', 'model.turn', 'out.speak']));
    const lines = await sink.lines();
    const said = lines.find((l) => l.type === 'msg.user');
    expect(said.data.text).toBe('Will the fog lift? My token is «key», my key «key».');
    expect(lines.find((l) => l.type === 'out.speak').data.text).toBe('The fog lifts by noon.');
    expect(new Set(lines.map((l) => l.device)).size).toBe(1);
    expect(lines[0].device).toMatch(/^[0-9a-f]{16}$/);
    expect(lines[0].build).toMatch(/^[0-9a-f]{12}$/);
    expect(lines.every((l) => Date.parse(l.received) > 0 && typeof l.scope === 'string' && typeof l.seq === 'number')).toBe(true);
    const all = await sink.text();
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(KEY);
    // Its own requests are in annai's trace, and never in what it sent.
    expect(lines.some((l) => l.data?.tool === 'plugin:remote-trace')).toBe(false);

    // A reload's app.start reaches the sink: the plugin is running by the time it is written.
    await page.reload();
    await expect.poll(async () => (await sink.lines()).filter((l) => l.type === 'app.start').length, { timeout: 20_000 }).toBeGreaterThan(0);

    // Its page shows the device id the lines carry, so two phones can be told apart.
    await page.goto('/#/plugins/remote-trace');
    await expect(page.getByLabel('Device id')).toHaveValue(lines[0].device);
    // Off: the chip goes at once, and nothing more arrives.
    await page.getByRole('checkbox', { name: 'Send', exact: true }).uncheck();
    await expect(page.getByRole('button', { name: 'Sending trace' })).toHaveCount(0);
    await page.waitForTimeout(1000);
    const before = (await sink.lines()).length;
    await page.goto('/#/trips');
    await startTrip(page, 'Carmel');
    await page.waitForTimeout(4000);
    expect((await sink.lines()).length).toBe(before);
  } finally {
    await llm.stop();
    await sink.stop();
  }
});

test('Detailed trace: it stays off with no server; on, a turn the microphone heard reaches the sink as a clip named by its heard entry, Flag sends the screen without what is in a field, and off stops it', async ({ page }) => {
  const origin = new URL(String(test.info().project.use.baseURL)).origin;
  const SECRET = 'sk-e2e-typed-into-a-field-0123456789';
  const clip = fileURLToPath(new URL('../fixtures/voice/where-eat.wav', import.meta.url));
  const json = (/** @type {any} */ o) => ({ status: 200, type: 'application/json', body: JSON.stringify(o) });
  const llm = await startModelServer({
    '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'Tacos.' } }, { name: 'sleep', input: {} }]))],
    '/ears/audio/transcriptions': [json({ text: 'Where should we eat?' })],
  });
  const sink = await startSink(origin);
  try {
    await fakeMicrophone(page, [clip]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: KEY, model: 'b-model' });
    await addProvider(page, 'Custom provider', { ability: 'Transcription', name: 'Ears', url: `${llm.origin}/ears`, key: 'sk-e2e-ears-key-0123456789', model: 'ears' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await expect(page.getByText('1. b-model')).toBeVisible();
    await page.getByLabel('Add a model to speech-in').selectOption({ label: 'ears' });
    await page.getByRole('button', { name: 'Add to speech-in' }).click();
    await expect(page.getByText('2. ears')).toBeVisible();
    await page.goto('/#/voice');
    await page.getByRole('radio', { name: 'On', exact: true }).check();
    await expect(page.getByText('Voice is on.')).toBeVisible();

    await page.goto('/#/add');
    await page.getByRole('button', { name: 'Install Remote trace (for developers)' }).click();
    await page.getByRole('link', { name: 'Open Remote trace (for developers)' }).click();
    const detailed = page.getByRole('checkbox', { name: 'Detailed trace', exact: true });
    const flag = page.getByRole('button', { name: 'Flag this moment' });
    // The warning is on the switch, and off is the default.
    await expect(page.getByText('Recordings include passengers and whatever is playing.')).toBeVisible();
    await expect(detailed).not.toBeChecked();
    await expect(flag).toHaveCount(0);

    // Nowhere to send to: there is nothing to turn on, and it says so.
    await detailed.click();
    await expect(page.getByText('Detailed trace stayed off')).toBeVisible();
    await expect(detailed).not.toBeChecked();
    await expect(flag).toHaveCount(0);
    await page.reload();
    await expect(detailed).not.toBeChecked();

    await page.getByLabel('Server address').fill(`${sink.url}/trace`);
    await page.waitForTimeout(300); // the form draws again after the address saves, and a token typed meanwhile is lost (as the first test waits)
    await page.getByLabel('Token').fill(TOKEN);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByLabel('Token')).toHaveAttribute('placeholder', 'saved');
    await page.getByRole('checkbox', { name: 'Send', exact: true }).check();
    await expect(page.getByRole('button', { name: 'Sending trace' })).toBeVisible();
    await detailed.check();
    await expect(flag).toBeVisible();

    // A tap with a key typed into a field: the page's words go, the field's don't.
    await page.getByLabel('Token').fill(SECRET);
    await page.getByLabel('Token').blur(); // the dock steps aside for a field being typed in
    await flag.click();
    await expect(page.getByText('Flagged', { exact: true })).toBeVisible();
    await expect.poll(async () => (await sink.lines()).filter((l) => l.type === 'trace.flag').length, { timeout: 20_000 }).toBe(1);
    const lines = await sink.lines();
    const flagged = lines.find((l) => l.type === 'trace.flag');
    const copy = lines.find((l) => l.type === 'trace.screen' && l.data.flag === flagged.data.at);
    expect(copy.data.text).toContain('Recordings include passengers');
    expect(copy.data.text).toContain('[nav: Shiori]');
    expect(flagged.data.route).toBe('#/plugins/remote-trace');
    expect(flagged.data.screen).toBeUndefined(); // the copy is its own entry
    expect(await sink.text()).not.toContain(SECRET);
    expect(await sink.text()).not.toContain(TOKEN);
    expect(copy.data.text).not.toContain(`${sink.url}/trace`); // an address in a field stays there too

    // A route change sends a copy of the new screen.
    await page.goto('/#/talk');
    await expect.poll(async () => (await sink.lines()).filter((l) => l.type === 'trace.screen' && l.data.route === '#/talk').length, { timeout: 20_000 }).toBe(1);

    // A real turn through the browser's microphone path: its clip is on the sink's disk, named by the heard entry.
    await page.getByRole('button', { name: 'Shiori' }).click();
    await expect.poll(async () => (await sink.lines()).filter((l) => l.type === 'trace.clip').length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await sink.lines()).filter((l) => l.type === 'heard').length, { timeout: 30_000 }).toBeGreaterThan(0);
    const after = await sink.lines();
    const entry = after.find((l) => l.type === 'trace.clip');
    expect(entry.data.id).toBe(after.find((l) => l.type === 'heard').data.id);
    expect(entry.data.kind).toBe('turn');
    const file = join(sink.dir, 'clips', entry.device, `${entry.data.id}.${entry.data.format}`);
    await expect.poll(async () => (await readFile(file).catch(() => Buffer.alloc(0))).length, { timeout: 20_000 }).toBe(entry.data.bytes);

    // It's in the Trace too.
    await page.goto('/#/trace?type=trace.flag');
    await expect(page.locator('.trace li').filter({ hasText: 'trace.flag' }).first()).toBeVisible();
    // Its rows are not screen text: the Trace screen's copy is its route and nothing else, and no row's JSON reaches the sink.
    await expect.poll(async () => (await sink.lines()).filter((l) => l.type === 'trace.screen' && l.data.route.startsWith('#/trace')).length, { timeout: 20_000 }).toBeGreaterThan(0);
    for (const l of (await sink.lines()).filter((x) => x.type === 'trace.screen' && x.data.route.startsWith('#/trace'))) expect(l.data.text).toBe('');

    // Leaving Trace with a row open, Flag at once: the old screen is still drawn under the new route, and its rows stay out of the copy.
    await page.locator('.trace li').first().locator('summary').click();
    await expect(page.locator('.trace li').first().locator('pre')).toBeVisible();
    await flag.evaluate((el) => { location.hash = '#/talk'; /** @type {HTMLElement} */ (el).click(); });
    await expect.poll(async () => (await sink.lines()).filter((l) => l.type === 'trace.screen' && l.data.route === '#/talk' && l.data.flag !== undefined).length, { timeout: 20_000 }).toBe(1);
    const left = (await sink.lines()).find((l) => l.type === 'trace.screen' && l.data.route === '#/talk' && l.data.flag !== undefined);
    expect(left.data.text).not.toContain('"actor"');
    expect(left.data.text).not.toContain('trace.flag');

    // Off: the flag goes at once.
    await page.goto('/#/plugins/remote-trace');
    await detailed.uncheck();
    await expect(flag).toHaveCount(0);
  } finally {
    await llm.stop();
    await sink.stop();
  }
});

for (const width of [320, 360, 390, 430]) {
  test(`${width} px: Flag takes the Trace chip's place, so the dock does not grow or move whatever the voice and GPS words are`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openApp(page, '#/voice');
    await page.getByRole('radio', { name: 'On', exact: true }).check();
    /** The dock's box and the row of chips, with the voice chip saying each of its words. */
    const measureWords = async () => {
      await page.goto('/#/talk');
      await expect(page.locator('nav.dock')).toHaveClass(/\bvoice\b/);
      const out = [];
      /** Where the Live chip is, for each of Voice's words. @type {Record<string, number>} */
      const liveAt = {};
      for (const words of ['Voice off', 'Voice on', 'Voice on · driving', 'Listening live']) {
        await page.locator('.koe-live-chip').evaluate((el) => { /** @type {HTMLElement} */ (el).hidden = false; el.textContent = 'Live off'; });
        await page.locator('.voice-chip').evaluate((el, w) => { el.textContent = w; }, words);
        // One line, whatever the words, with both voice chips whole and on the screen.
        const row = await page.evaluate(() => {
          const box = (/** @type {string} */ s) => /** @type {Element} */ (document.querySelector(s)).getBoundingClientRect();
          const whole = (/** @type {string} */ s) => { const e = /** @type {HTMLElement} */ (document.querySelector(s)); const b = e.getBoundingClientRect(); return e.scrollWidth <= e.clientWidth + 1 && b.left >= 0 && b.right <= innerWidth; };
          return { height: box('.voice-row').height, voice: whole('.voice-chip'), live: whole('.koe-live-chip'), wide: document.documentElement.scrollWidth <= innerWidth };
        });
        expect(row, words).toEqual({ height: expect.any(Number), voice: true, live: true, wide: true });
        expect(row.height, words).toBeLessThan(45);
        liveAt[words] = await page.locator('.koe-live-chip').evaluate((el) => el.getBoundingClientRect().x);
        out.push(await page.evaluate(() => ['nav.dock', '.dock-row', '.voice-row'].map((s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && [b.x, Math.round(b.y), b.width, Math.round(b.height)]; })));
      }
      // Driving starting changes Voice's words and nothing else: Live stays where it was.
      expect(Math.abs(liveAt['Voice on · driving'] - liveAt['Voice on']), 'Live moves when driving starts').toBeLessThan(2);
      // GPS's own words, each whole (no cut, no ellipsis), beside the widest of Voice's.
      for (const gps of ['GPS on', 'GPS off', 'GPS…', 'No GPS', 'Simulation']) {
        for (const words of ['Voice on · driving', 'Listening live']) {
          await page.locator('.voice-chip').evaluate((el, w) => { el.textContent = w; }, words);
          await page.locator('.live-chip').evaluate((el, w) => { el.textContent = w; }, gps);
          const row = await page.evaluate(() => {
            const whole = (/** @type {string} */ s) => { const e = /** @type {HTMLElement} */ (document.querySelector(s)); const b = e.getBoundingClientRect(); return e.scrollWidth <= e.clientWidth + 1 && b.left >= 0 && b.right <= innerWidth; };
            return { height: /** @type {Element} */ (document.querySelector('.voice-row')).getBoundingClientRect().height, gps: whole('.live-chip'), voice: whole('.voice-chip'), live: whole('.koe-live-chip'), wide: document.documentElement.scrollWidth <= innerWidth };
          });
          expect(row, `${gps} beside ${words}`).toEqual({ height: expect.any(Number), gps: true, voice: true, live: true, wide: true });
          expect(row.height, `${gps} beside ${words}`).toBeLessThan(45);
        }
      }
      return out;
    };
    const none = await measureWords();
    await page.goto('/#/add');
    // On a slow machine the list draws again once its catalog is in, which can take the tap with the button it replaced.
    const opens = page.getByRole('link', { name: 'Open Remote trace (for developers)' });
    await expect(async () => {
      const install = page.getByRole('button', { name: 'Install Remote trace (for developers)' });
      if (await install.count()) await install.click({ timeout: 3000 });
      await expect(opens).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 30_000 });
    await opens.click();
    await page.getByLabel('Server address').fill('https://sink.example/trace');
    await page.getByRole('checkbox', { name: 'Send', exact: true }).check();
    await expect(page.getByRole('button', { name: 'Sending trace' })).toBeVisible();
    const trace = await measureWords();
    await page.goto('/#/plugins/remote-trace');
    // A tall dock can cover the box on a short page: the click is the box's own.
    await page.getByRole('checkbox', { name: 'Detailed trace', exact: true }).evaluate((el) => /** @type {HTMLInputElement} */ (el).click());
    await expect(page.getByRole('checkbox', { name: 'Detailed trace', exact: true })).toBeChecked();
    const flag = await measureWords();
    await expect(page.getByRole('button', { name: 'Flag this moment' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sending trace' })).toHaveCount(0);
    // In Trace's place it costs the row nothing more than that chip did, and with the usual words the bar is as tall as with no chip at all.
    expect(flag).toEqual(trace);
    expect(flag[0]).toEqual(none[0]);
  });
}
