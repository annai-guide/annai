import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, modelSetUp, filterTrace } from './helpers.js';
import { startMcpServer } from '../fakes/mcp.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const TOKEN = 'mcp-e2e-token-0123456789';

/** Everything annai keeps in IndexedDB, as one text: no secret may be in it. @param {any} page */
async function dumpAll(page) {
  return page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const store = await createIdbStore();
    const out = await store.tx(['files', 'events', 'blobs', 'scopes'], 'readonly', async (/** @type {any} */ t) => {
      const parts = [];
      for (const s of await t.listScopes()) parts.push(JSON.stringify(await t.listFiles(s.id)), JSON.stringify(await t.listEvents(s.id)));
      for (const b of await t.listBlobs()) parts.push(new TextDecoder().decode((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0)));
      return parts.join('\n');
    });
    store.close();
    return out;
  });
}

test('an MCP server added with a bearer token: its tools under Settings → Tools, called by Shiori, each request in the trace, the token in no trace or file; removed, it is gone (spec §5.1)', async ({ page }) => {
  const mcp = await startMcpServer({ token: TOKEN });
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'mcp_trail_echo', input: { text: 'Low tide at 5:40.' } }])),
    sse(anthropicToolReply([{ name: 'mcp_trail_whoami', input: {} }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'Low tide is at 5:40.' } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/tools');
    await page.getByRole('link', { name: 'MCP servers' }).click();
    await page.getByLabel('Name', { exact: true }).fill('trail');
    await page.getByLabel('Address').fill(mcp.url);
    await page.getByLabel('Key').selectOption('token');
    await page.getByLabel('Token', { exact: true }).fill(TOKEN);
    await page.getByRole('button', { name: 'Add server' }).click();
    await expect(page.locator('.card', { hasText: 'trail' }).getByText('A bearer token, kept on this device')).toBeVisible();
    await expect(page.getByText('mcp_trail_echo')).toBeVisible();
    await page.goto('/#/tools');
    await expect(page.getByRole('heading', { name: 'MCP: trail' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'mcp_trail_echo', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('When is low tide?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p')).toHaveText('Low tide is at 5:40.');
    const bodies = llm.bodies('/b/v1/messages').map((b) => JSON.stringify(b));
    expect(bodies[0]).toContain('mcp_trail_echo');
    expect(bodies[1]).toContain('Low tide at 5:40.');
    expect(bodies.join('\n')).not.toContain(TOKEN);
    expect(mcp.requests.filter((r) => r.rpc?.method === 'tools/call').map((r) => r.rpc.params.name)).toEqual(['echo', 'whoami']);
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Web' });
    await expect(page.locator('ol.trace li', { hasText: 'mcp_trail_echo' }).first()).toBeVisible();
    expect(await page.content()).not.toContain(TOKEN);
    expect(await dumpAll(page)).not.toContain(TOKEN);
    await page.goto('/#/mcp');
    await page.locator('.card', { hasText: 'trail' }).getByRole('button', { name: 'Remove' }).click();
    await page.locator('.card', { hasText: 'trail' }).getByRole('button', { name: 'Tap again to remove' }).click();
    await expect(page.getByText('mcp_trail_echo')).toHaveCount(0);
    await page.goto('/#/tools');
    await expect(page.getByRole('heading', { name: 'MCP: trail' })).toHaveCount(0);
  } finally {
    await llm.stop();
    await mcp.stop();
  }
});

test("a server that doesn't let web apps call it, or refuses the token, isn't added, and the screen says why", async ({ page }) => {
  const closed = await startMcpServer({ token: TOKEN, cors: false });
  try {
    await modelSetUp(page, 'http://127.0.0.1:9');
    await page.goto('/#/mcp');
    await page.getByLabel('Name', { exact: true }).fill('closed');
    await page.getByLabel('Address').fill(closed.url);
    await page.getByRole('button', { name: 'Add server' }).click();
    await expect(page.getByRole('alert')).toContainText('lets web apps call it (CORS)');
    await expect(page.locator('.card', { hasText: 'closed' })).toHaveCount(0);
  } finally {
    await closed.stop();
  }
});
