import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModelServer, anthropicToolReply, addEndpoint, openApp, waitForServiceWorker, startTrip } from './helpers.js';

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
    url, text,
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
    await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${llm.origin}/b`, key: KEY, model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/trips');
    await startTrip(page, 'Big Sur');

    await page.goto('/#/plugins');
    await page.getByRole('button', { name: 'Install Remote trace (for developers)' }).click();
    await expect(page.getByText('Installed Remote trace (for developers).')).toBeVisible();
    await page.getByRole('link', { name: /^Remote trace \(for developers\)/ }).click();
    await expect(page.getByRole('heading', { name: 'Remote trace (for developers)' })).toBeVisible();
    // Off until configured: no chip yet.
    await expect(page.getByRole('button', { name: 'Sending trace' })).toHaveCount(0);
    await page.getByLabel('Server address').fill(`${sink.url}/trace`);
    await page.getByLabel('Token').fill(TOKEN);
    await page.getByRole('checkbox', { name: 'Send', exact: true }).check();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    // The chip, short in the dock's row; a tap opens the plugin's page.
    const chip = page.getByRole('button', { name: 'Sending trace' });
    await expect(chip).toBeVisible();
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

    // Its page shows the device id the lines carry, so two phones can be told apart.
    await page.goto('/#/plugins/remote-trace');
    await expect(page.getByLabel('Device id')).toHaveValue(lines[0].device);
    // Off: the chip goes at once, and nothing more arrives.
    await page.getByRole('checkbox', { name: 'Send', exact: true }).uncheck();
    await page.getByRole('button', { name: 'Save' }).click();
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
