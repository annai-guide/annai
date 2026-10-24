import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addProvider, savedBy } from './helpers.js';

// Item 24 (2026-10-18): a server that never streams, as the user's own LLM router doesn't, answers `stream: true` with
// one whole application/json reply. annai reads it as a stream's events: the Test button passes, and Shiori talks.
const json = (/** @type {any} */ body) => ({ status: 200, type: 'application/json', body: JSON.stringify(body) });
/** A whole Chat Completions reply: words, or tool calls. @param {{ text?: string, calls?: { name: string, input: any }[] }} o */
const completion = ({ text, calls = [] }) => json({
  id: 'chatcmpl-whole', object: 'chat.completion', model: 'router-model',
  choices: [{ index: 0, message: { role: 'assistant', content: text ?? null, ...(calls.length ? { tool_calls: calls.map((c, i) => ({ id: `call_${i + 1}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 400, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 100 } },
});
/** A whole Responses reply. @param {{ text?: string, calls?: { name: string, input: any }[] }} o */
const response = ({ text, calls = [] }) => json({
  id: 'resp_whole', object: 'response', status: 'completed', error: null, model: 'router-model',
  output: [
    ...(text ? [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] : []),
    ...calls.map((c, i) => ({ id: `fc_${i + 1}`, type: 'function_call', status: 'completed', call_id: `call_${i + 1}`, name: c.name, arguments: JSON.stringify(c.input) })),
  ],
  usage: { input_tokens: 400, output_tokens: 12 },
});

for (const kind of /** @type {const} */ (['Chat Completions', 'OpenAI Responses'])) {
  test(`a ${kind} server that never streams: the Test button passes, with the tool and the photo, and Shiori shows a card with one tool call`, async ({ page }) => {
    const reply = kind === 'Chat Completions' ? completion : response;
    const path = kind === 'Chat Completions' ? '/v1/chat/completions' : '/v1/responses';
    const llm = await startModelServer({
      // Responses' photos go to the files API first (spec §4.8).
      '/v1/files': json({ id: 'file-whole', object: 'file', purpose: 'vision', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
      [path]: [
        reply({ text: 'OK' }), // Test: the tiny request
        reply({ calls: [{ name: 'report_color', input: { color: 'red' } }] }), // Test: the tool and the photo
        reply({ calls: [{ name: 'show', input: { card: { title: 'Nepenthe', text: 'Open till 10.' } } }] }),
        reply({ text: 'Shown.' }),
      ],
    });
    try {
      await openApp(page, '#/models');
      await waitForServiceWorker(page);
      await addProvider(page, 'Custom provider', { ability: kind, name: 'Router', url: `${llm.origin}/v1`, key: 'sk-test-secret-w', model: 'router-model' });
      await page.getByRole('link', { name: /Router/ }).click();
      await page.getByRole('link', { name: /^router-model/ }).click();
      await page.getByLabel('Takes photos').check();
      await expect(savedBy(page.getByLabel('Takes photos'))).toHaveText('Saved');
      await page.getByRole('link', { name: 'Router', exact: true }).click();
      // The model's page has a Test button too: its provider's page first (CI, 2026-10-19).
      await expect(page.getByRole('heading', { level: 1, name: 'Router', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Test', exact: true }).click();
      await expect(page.getByText('Everything works.')).toBeVisible();
      await expect(page.getByText('✓ Tool calls work.')).toBeVisible();
      await expect(page.getByText('✓ Photos work: it saw the red square.')).toBeVisible();
      expect(llm.bodies(path).every((/** @type {any} */ b) => b.stream === true), 'a stream is still asked for').toBe(true);
      // A conversation with one tool call.
      await page.getByRole('link', { name: 'Models', exact: true }).click();
      await page.getByLabel('Add a model to main').selectOption({ label: 'router-model' });
      await page.getByRole('button', { name: 'Add to main' }).click();
      await expect(page.getByText('1. router-model')).toBeVisible();
      await page.goto('/#/trips');
      await page.getByLabel('Trip name').fill('Big Sur');
      await page.getByRole('button', { name: 'Start trip' }).click();
      await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
      await page.getByRole('button', { name: 'Type' }).click();
      await page.getByLabel('Message to Shiori').fill('When does Nepenthe close?');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.locator('.convo .card-title')).toHaveText('Nepenthe');
      await expect.poll(() => llm.bodies(path).length).toBe(4);
      expect(JSON.stringify(llm.bodies(path)[3])).toContain(kind === 'Chat Completions' ? '"role":"tool"' : '"function_call_output"');
    } finally {
      await llm.stop();
    }
  });
}
