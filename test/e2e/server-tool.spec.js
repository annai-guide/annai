import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, modelSetUp } from './helpers.js';

// A reply that calls Anthropic's web search and one of Shiori's tools together ends with the search unanswered. annai 0.5.0 put words after the
// tool result in the next request, which the real API refuses ("`web_search` tool use ... was found without a corresponding result block", 400,
// 2026-11-09), and "Try again" met the same refusal. The stand-in refuses it too (helpers.js startModelServer), so a regression is a reply she never gives.
// A Custom provider model has no web search of its own, so here the call is left out of the history (the search left to run with its tool, which
// the API needs, is test/unit/keep-reasoning.test.js 8b, through the loop and the stand-in of the API's rules).

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const SEARCH = { id: 'srvtoolu_e2e_1', name: 'web_search', input: { query: 'Is Nepenthe open today' } };

test("a reply with a web search and a tool call in it, from a model with no search of its own: the next request goes without the call and the stand-in takes it; Shiori answers, then answers the next line too", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'list', input: { path: '/trip/' } }], 'Let me look.', { server: [SEARCH] })),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'It is open daily.' } }, { name: 'sleep', input: {} }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'Anytime.' } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Is Nepenthe open today?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText('It is open daily.');
    await expect(page.locator('.notice', { hasText: "can't reach her model" })).toHaveCount(0);
    const bodies = llm.bodies('/b/v1/messages');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].messages.at(-1).content.at(-1).type, 'the first request ends with its tail').toBe('text');
    expect(JSON.stringify(bodies[1].messages), 'a search no request can run is not sent back').not.toContain('server_tool_use');
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Thanks!');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Anytime.');
    expect(llm.bodies('/b/v1/messages')).toHaveLength(3);
  } finally {
    await llm.stop();
  }
});
