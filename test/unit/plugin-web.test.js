import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { webVia } from '../../src/core/agent/via.js';

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/web/index.js', import.meta.url).href);
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  /** @type {any[]} */
  const asked = [];
  /** @param {(url: string, init: any) => Response | Promise<Response>} answer @param {any} [over] */
  const run = (name, input, answer, over = {}) => tools[name].run(input, {
    scope: 'me', trip: null, signal: new AbortController().signal, model: { input: ['text'] }, wake: 'w', author: 'shiori', providerOff: [],
    fetch: async (/** @type {string} */ url, /** @type {any} */ init = {}) => { asked.push({ url, init }); return answer(url, init); },
    llm: { call: async () => { throw new Error('no model'); } },
    ...over,
  });
  const setKey = (/** @type {string} */ k) => store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:web:jina', k));
  return { registry, run, asked, setKey };
}
const html = (/** @type {string} */ body) => new Response(`<html><head><title>T</title></head><body><main>${body}</main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const blocked = () => { throw new TypeError('Failed to fetch'); };

test('fetch: a site that allows browsers is read directly', async () => {
  const { run } = await setup();
  const out = await run('fetch', { url: 'https://open.test/page' }, () => html('<p>Hello</p>'));
  assert.equal(out, 'Source: https://open.test/page (read directly)\nTitle: T\n\nHello');
});

test('fetch: otherwise through Jina Reader, with the key when there is one', async () => {
  const { run, asked, setKey } = await setup();
  await setKey('jina_test_key');
  const out = await run('fetch', { url: 'https://closed.test/page' }, (url) => (url.startsWith('https://r.jina.ai/') ? new Response('Title: T\n\nReader text') : blocked()));
  assert.match(out, /^Source: https:\/\/closed\.test\/page \(read through Jina Reader\)\n/);
  assert.equal(asked[1].url, 'https://r.jina.ai/https://closed.test/page');
  assert.equal(asked[1].init.headers.authorization, 'Bearer jina_test_key');
});

test("fetch: then the model's own fetch tool; else a plain error that says what to do", async () => {
  const { run } = await setup();
  const reader401 = (/** @type {string} */ url) => (url.startsWith('https://r.jina.ai/') ? new Response('{"code":401}', { status: 401 }) : blocked());
  /** @type {any} */
  let request = null;
  const viaModel = await run('fetch', { url: 'https://closed.test/a' }, reader401, {
    llm: { call: async (/** @type {any} */ c) => { request = c.request; return { reply: { text: 'Page text from the model.' }, answeredBy: 'Claude Haiku' }; } },
  });
  assert.equal(request.needsProviderTool, 'fetch');
  assert.match(request.messages[0].parts[0].text, /https:\/\/closed\.test\/a/);
  assert.match(viaModel, /\(read with Claude Haiku's fetch tool\)\n\nPage text from the model\.$/);
  await assert.rejects(run('fetch', { url: 'https://closed.test/a' }, reader401), (/** @type {any} */ e) => /doesn't let web apps read it/.test(e.message) && /Jina key/.test(e.message));
});

test('fetch: long text in pieces; PDFs and photos only for models that take them; a 404 is an answer', async () => {
  const { run } = await setup();
  const long = await run('fetch', { url: 'https://open.test/long' }, () => new Response('x'.repeat(35_000), { headers: { 'content-type': 'text/plain' } }));
  assert.match(long, /fetch again with from: 30000$/);
  const rest = await run('fetch', { url: 'https://open.test/long', from: 30_000 }, () => new Response('x'.repeat(35_000), { headers: { 'content-type': 'text/plain' } }));
  assert.match(rest, /\n\nx{5000}$/);
  const pdf = () => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { 'content-type': 'application/pdf' } });
  assert.match(await run('fetch', { url: 'https://open.test/m.pdf' }, pdf), /can't read PDFs/);
  const doc = await run('fetch', { url: 'https://open.test/m.pdf' }, pdf, { model: { input: ['text', 'pdf'] } });
  assert.deepEqual(doc.document, { mediaType: 'application/pdf', data: btoa('%PDF'), name: 'm.pdf' });
  await assert.rejects(run('fetch', { url: 'https://open.test/gone' }, () => new Response('nope', { status: 404 })), /answered 404/);
  await assert.rejects(run('fetch', { url: 'javascript:alert(1)' }, () => html('')), /http/);
});

test('web_search: Jina Search with a key, as TSV; without a key, what to do', async () => {
  const { run, setKey } = await setup();
  await assert.rejects(run('web_search', { query: 'nepenthe' }, () => new Response('')), /Jina Search needs a key/);
  await setKey('jina_test_key');
  const out = await run('web_search', { query: 'nepenthe hours' }, (url, init) => {
    assert.equal(url, 'https://s.jina.ai/?q=nepenthe%20hours');
    assert.equal(init.headers.accept, 'application/json');
    return new Response(JSON.stringify({ data: [{ title: 'Nepenthe', url: 'https://www.nepenthe.com/', description: 'Open daily\tuntil 10.' }] }));
  });
  assert.equal(out, 'title\turl\tsnippet\nNepenthe\thttps://www.nepenthe.com/\tOpen daily<sep>until 10.');
});

test('search via and fetch via: one search tool, never two competing ones (spec §9.5)', () => {
  const search = { id: 'a-search', name: 'S', kind: 'search', patch: {} };
  const fetchTool = { id: 'a-fetch', name: 'F', kind: 'fetch', patch: {} };
  const withTools = /** @type {any} */ ({ providerTools: [search, fetchTool] });
  const plain = /** @type {any} */ ({ providerTools: [] });
  assert.deepEqual(webVia({ web: {}, model: withTools, switches: {} }), { hide: ['web_search'], kinds: ['search'], off: [] });
  assert.deepEqual(webVia({ web: {}, model: plain, switches: {} }), { hide: [], kinds: [], off: [] });
  assert.deepEqual(webVia({ web: { searchVia: 'annai', fetchVia: 'provider' }, model: withTools, switches: {} }), { hide: ['fetch'], kinds: ['fetch'], off: [] });
  assert.deepEqual(webVia({ web: { searchVia: 'off', fetchVia: 'off' }, model: withTools, switches: {} }), { hide: ['web_search', 'fetch'], kinds: [], off: [] });
  assert.deepEqual(webVia({ web: {}, model: withTools, switches: { 'provider:a-search': false } }), { hide: [], kinds: [], off: ['a-search'] });
});
