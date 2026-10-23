import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { webVia } from '../../src/core/agent/via.js';
import { STEP_MS } from '../../src/plugins/web/index.js';
import { cooldowns } from '../../src/core/web-search.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { readFile } from 'node:fs/promises';

async function setup() {
  for (const id of ['jina', 'exa', 'parallel', 'firecrawl', 'wiki']) cooldowns.clear(id);
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
  const settings = (/** @type {any} */ web) => updateAppSettings(ws, { web });
  return { registry, run, asked, setKey, settings };
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

test('fetch: long text in pieces; a PDF is returned as a document (the loop words it for a model that reads none), photos only for models that take them; a 404 is an answer', async () => {
  const { run } = await setup();
  const long = await run('fetch', { url: 'https://open.test/long' }, () => new Response('x'.repeat(35_000), { headers: { 'content-type': 'text/plain' } }));
  assert.match(long, /fetch again with from: 30000$/);
  const rest = await run('fetch', { url: 'https://open.test/long', from: 30_000 }, () => new Response('x'.repeat(35_000), { headers: { 'content-type': 'text/plain' } }));
  assert.match(rest, /\n\nx{5000}$/);
  const pdf = () => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { 'content-type': 'application/pdf' } });
  // A model that reads no PDFs gets the document too: the loop has one that can tell it in words (the second emulator pass).
  assert.equal((await run('fetch', { url: 'https://open.test/m.pdf' }, pdf)).document.name, 'm.pdf');
  const doc = await run('fetch', { url: 'https://open.test/m.pdf' }, pdf, { model: { input: ['text', 'pdf'] } });
  assert.deepEqual(doc.document, { mediaType: 'application/pdf', data: btoa('%PDF'), name: 'm.pdf' });
  await assert.rejects(run('fetch', { url: 'https://open.test/gone' }, () => new Response('nope', { status: 404 })), /answered 404/);
  await assert.rejects(run('fetch', { url: 'javascript:alert(1)' }, () => html('')), /http/);
});

/** A recorded answer of a service: the files in test/fixtures/search, as they came. @param {string} name */
const fixture = (name) => readFile(new URL(`../fixtures/search/${name}`, import.meta.url), 'utf8');
const sse = async (/** @type {string} */ name) => new Response(await fixture(name), { headers: { 'content-type': 'text/event-stream' } });
const jsonFile = async (/** @type {string} */ name) => new Response(await fixture(name), { headers: { 'content-type': 'application/json' } });
/** An MCP answer that has no results. @param {string} text */
const mcpText = (text) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const EXA = 'https://mcp.exa.ai/mcp';
const PARALLEL = 'https://search.parallel.ai/mcp';
const FIRECRAWL = 'https://mcp.firecrawl.dev/v2/mcp';
const rpc = (/** @type {any} */ init) => JSON.parse(init.body);
/** The Wikimedia and Nominatim answers the floor reads, as those services shape them. @param {string} url */
function wikiAnswer(url) {
  const u = new URL(url);
  const j = (/** @type {any} */ x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'nominatim.openstreetmap.org') return j([{ name: 'Nepenthe', display_name: 'Nepenthe, Highway 1, Big Sur, California', extratags: { website: 'http://www.nepenthebigsur.com' } }, { name: 'No site', extratags: {} }]);
  if (u.searchParams.get('list') === 'search') {
    return j(u.hostname === 'en.wikivoyage.org' ? { query: { search: [{ title: 'Big Sur' }] } } : { query: { search: [{ title: 'Nepenthe (restaurant)', snippet: 'a <span class="searchmatch">restaurant</span> in Big Sur' }] } });
  }
  return j({ query: { pages: { 1: { title: 'Big Sur', extract: 'Intro.\n1 Nepenthe, 48510 Highway 1. Lunch from 11:30AM-4:30PM; Dinner from 5-10PM. Picturesque restaurant.\n2 Bixby Bridge (11 mi north of Big Sur Village). Iconic bridge built in 1933.' } } } });
}
/** All the services as the research recorded them. */
async function services(/** @type {string} */ url, /** @type {any} */ init) {
  if (url === EXA) return sse('exa-search.sse');
  if (url === PARALLEL) return jsonFile('parallel-search.json');
  if (url === FIRECRAWL) return sse('firecrawl-search.sse');
  return wikiAnswer(url);
}

test('web_search: free search starts with Exa, a single request with the query alone, as TSV with the answer in the snippet', async () => {
  const { run, asked } = await setup();
  const out = await run('web_search', { query: 'Is Nepenthe restaurant in Big Sur open today' }, services);
  const [head, ...rows] = out.split('\n');
  assert.equal(head, 'title\turl\tsnippet');
  assert.ok(rows.length >= 3 && rows.length <= 8);
  const first = rows[0].split('\t');
  assert.deepEqual(first.slice(0, 2), ['Hours and Directions', 'https://www.nepenthe.com/directions-and-hours']);
  assert.match(first[2], /Open daily for full service dining from 11:30am-10:00pm/);
  assert.ok(first[2].length <= 400);
  // One request, to Exa alone: no initialize, no session, no key, nothing but the words searched.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, EXA);
  assert.deepEqual(Object.keys(asked[0].init.headers).sort(), ['Accept', 'Content-Type', 'x-exa-source']);
  const msg = rpc(asked[0].init);
  assert.equal(msg.method, 'tools/call');
  assert.deepEqual(msg.params, { name: 'web_search_exa', arguments: { query: 'Is Nepenthe restaurant in Big Sur open today', objective: 'Is Nepenthe restaurant in Big Sur open today', numResults: 8 } });
});

test('web_search: when a service is limited (429) or down (5xx), the next is asked, and the one that failed is left alone for a while', async () => {
  const { run, asked } = await setup();
  const out = await run('web_search', { query: 'nepenthe hours' }, (url, init) => (url === EXA ? new Response('slow down', { status: 429 }) : services(url, init)));
  assert.match(out, /nepenthebigsur\.com/);
  assert.deepEqual(asked.map((a) => a.url), [EXA, PARALLEL]);
  assert.ok(cooldowns.left('exa') > 0);
  // The next search does not ask Exa at all.
  asked.length = 0;
  await run('web_search', { query: 'bixby bridge' }, (url, init) => (url === PARALLEL ? new Response('', { status: 503 }) : services(url, init)));
  assert.deepEqual(asked.map((a) => a.url), [PARALLEL, FIRECRAWL]);
  assert.ok(cooldowns.left('parallel') > 0);
  // All three limited: the floor answers, and Shiori is told nothing she needs.
  const down = (/** @type {string} */ url) => (url.startsWith('https://mcp.') || url.startsWith('https://search.') ? new Response('', { status: 429 }) : wikiAnswer(url));
  const floor = await run('web_search', { query: 'nepenthe lunch' }, down);
  assert.match(floor, /Big Sur \(Wikivoyage\)\thttps:\/\/en\.wikivoyage\.org\/wiki\/Big_Sur\t.*Lunch from 11:30AM-4:30PM/);
  assert.match(floor, /Nepenthe\thttp:\/\/www\.nepenthebigsur\.com\//);
  assert.match(floor, /Nepenthe \(restaurant\) \(Wikipedia\)\thttps:\/\/en\.wikipedia\.org\/wiki\/Nepenthe_\(restaurant\)\ta restaurant in Big Sur/);
});

test('web_search: a service that finds nothing, or answers what is no result, hands on to the next; the first answer with rows wins; Parallel and Firecrawl are read as they send', async () => {
  const { run, asked } = await setup();
  const empty = (/** @type {string} */ url, /** @type {any} */ init) => (url === EXA ? mcpText('No results found.') : services(url, init));
  const viaParallel = await run('web_search', { query: 'nepenthe hours' }, empty);
  assert.deepEqual(asked.map((a) => a.url), [EXA, PARALLEL]);
  assert.match(viaParallel, /^title\turl\tsnippet\nNepenthe\thttps:\/\/www\.nepenthebigsur\.com\/\t/);
  asked.length = 0;
  const parallelEmpty = new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"results":[]}' }] } }), { headers: { 'content-type': 'application/json' } });
  const viaFirecrawl = await run('web_search', { query: 'nepenthe hours' }, (url, init) => (url === PARALLEL ? parallelEmpty : empty(url, init)));
  assert.deepEqual(asked.map((a) => a.url), [EXA, PARALLEL, FIRECRAWL]);
  assert.match(viaFirecrawl, /Nepenthe - Big Sur CA - Facebook/);
  // Nothing anywhere is an answer, not a failure; nobody is left resting for it.
  const nothing = await run('web_search', { query: 'zzzz qqqq' }, (url) => (url.includes('wikivoyage') || url.includes('wikipedia') ? new Response('{"query":{"search":[]}}') : url.includes('nominatim') ? new Response('[]') : mcpText('{"results":[],"data":{"web":[]}}')));
  assert.equal(nothing, 'Nothing found for "zzzz qqqq".');
  assert.equal(cooldowns.left('exa'), 0);
});

test('web_search: a service the user unticked is never asked; the floor is always on', async () => {
  const { run, asked, settings } = await setup();
  await settings({ searchOff: ['exa', 'parallel', 'wiki'] });
  await run('web_search', { query: 'nepenthe hours' }, services);
  assert.deepEqual(asked.map((a) => a.url), [FIRECRAWL]);
  await settings({ searchOff: ['exa', 'parallel', 'firecrawl'] });
  asked.length = 0;
  const out = await run('web_search', { query: 'nepenthe' }, services);
  assert.ok(asked.every((a) => !/mcp\.|search\.parallel/.test(a.url)) && asked.length >= 2);
  assert.match(out, /Wikivoyage/);
});

test('web_search: Jina Search goes first when its key is set; without the key it is passed over and the free services answer', async () => {
  const { run, asked, setKey } = await setup();
  const out = await run('web_search', { query: 'nepenthe hours' }, services);
  assert.equal(asked[0].url, EXA);
  assert.match(out, /Hours and Directions/);
  await setKey('jina_test_key');
  asked.length = 0;
  const viaJina = await run('web_search', { query: 'nepenthe hours' }, (url, init) => {
    if (!url.startsWith('https://s.jina.ai/')) return services(url, init);
    assert.equal(url, 'https://s.jina.ai/?q=nepenthe%20hours');
    assert.equal(init.headers.accept, 'application/json');
    assert.equal(init.headers.authorization, 'Bearer jina_test_key');
    return new Response(JSON.stringify({ data: [{ title: 'Nepenthe', url: 'https://www.nepenthe.com/', description: 'Open daily\tuntil 10.' }] }));
  });
  assert.equal(viaJina, 'title\turl\tsnippet\nNepenthe\thttps://www.nepenthe.com/\tOpen daily until 10.');
  assert.equal(asked.length, 1);
  // A refused key is told in words, and the chain goes on.
  asked.length = 0;
  const refused = await run('web_search', { query: 'q' }, (url, init) => (url.startsWith('https://s.jina.ai/') ? new Response('', { status: 401 }) : services(url, init)));
  assert.match(refused, /Hours and Directions/);
  assert.equal(cooldowns.left('jina'), 0); // a refused key is not a rest: it is for the user to fix
});

test("web_search: a plugin's provider says by ready() whether it can run, reads its own key, and is handed none of Jina's, even one called jina that the user chose", async () => {
  const { registry, run, setKey, settings } = await setup();
  await setKey('jina_test_key');
  /** @type {any[]} */
  const handed = [];
  registry.add('other', 'search', { id: 'jina', name: 'Other', search: async (/** @type {string} */ _q, /** @type {any} */ c) => { handed.push(c.key); return [{ title: 'T', url: 'https://x.test/', snippet: 's' }]; } });
  registry.setRules({ rank: (id) => [id === 'web' ? 0 : 2], choice: (kind) => (kind === 'search' ? 'other' : undefined), reserved: () => null });
  assert.match(await run('web_search', { query: 'q' }, () => new Response('')), /^title/);
  assert.deepEqual(handed, [undefined]);
  // A keyed plugin's provider that has no key is passed over, with its words; one that has runs.
  registry.setRules({ rank: () => [0], choice: () => undefined, reserved: () => null });
  let keyed = false;
  registry.add('tav', 'search', { id: 'tavily', name: 'Tavily', ready: async () => (keyed ? { ok: true } : { ok: false, why: 'needs a key' }), search: async () => [{ title: 'Tav', url: 'https://tav.test/', snippet: 's' }] });
  await settings({ search: ['tavily'], searchOff: ['jina', 'exa', 'parallel', 'firecrawl', 'wiki'] });
  const down = () => new Response('', { status: 500 });
  await assert.rejects(run('web_search', { query: 'q' }, down), /Web search didn't work: .*Tavily needs a key\. Or turn on/);
  keyed = true;
  assert.match(await run('web_search', { query: 'q' }, down), /^title\turl\tsnippet\nTav\thttps:\/\/tav\.test\//);
  // Off in the list, it is never asked, ready or not.
  await settings({ searchOff: ['jina', 'tavily', 'exa', 'parallel', 'firecrawl'] });
  await assert.rejects(run('web_search', { query: 'q' }, down), (/** @type {any} */ e) => !/Tavily/.test(e.message));
});

test('fetch: after the site and Jina Reader, Exa reads the page with no key; not when the user unticked Exa or Exa is resting', async () => {
  const { run, asked, settings } = await setup();
  const closed = (/** @type {string} */ url, /** @type {any} */ _init) => (url.startsWith('https://r.jina.ai/') ? new Response('{"code":401}', { status: 401 }) : url === EXA ? sse('exa-fetch.sse') : blocked());
  const out = await run('fetch', { url: 'https://www.nepenthe.com/directions-and-hours' }, closed);
  assert.match(out, /^Source: https:\/\/www\.nepenthe\.com\/directions-and-hours \(read through Exa\)\n\n# Hours and Directions/);
  assert.match(out, /Open daily for full service dining from 11:30am-10:00pm/);
  const msg = rpc(asked.at(-1).init);
  assert.deepEqual(msg.params, { name: 'web_fetch_exa', arguments: { urls: ['https://www.nepenthe.com/directions-and-hours'], maxCharacters: 31_000 } });
  assert.deepEqual(asked.map((a) => new URL(a.url).hostname), ['www.nepenthe.com', 'r.jina.ai', 'mcp.exa.ai']);
  // Unticked: the model's own fetch is next, and the error says every way tried.
  await settings({ searchOff: ['exa'] });
  asked.length = 0;
  await assert.rejects(run('fetch', { url: 'https://www.nepenthe.com/x' }, closed), (/** @type {any} */ e) => !asked.some((a) => a.url === EXA) && /Jina Reader asked for a key/.test(e.message) && !/Exa/.test(e.message));
  await settings({ searchOff: [] });
  asked.length = 0;
  await assert.rejects(run('fetch', { url: 'https://www.nepenthe.com/y' }, (url) => (url === EXA ? new Response('', { status: 429 }) : closed(url, {}))), /Exa answered 429 \(its free limit\)/);
  asked.length = 0;
  await assert.rejects(run('fetch', { url: 'https://www.nepenthe.com/z' }, closed), (/** @type {any} */ e) => !asked.some((a) => a.url === EXA));
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

// Review R5: a site that never answered held fetch for the whole tool limit, and Jina and the model were never tried.
/** A request that never answers until its signal ends it. @param {any} init */
const hang = (init) => new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });

test('fetch and web_search: each step has its own time limit, and the next way is tried', async () => {
  const was = STEP_MS.ms;
  STEP_MS.ms = 30;
  try {
    const { run, setKey } = await setup();
    const read = await run('fetch', { url: 'https://slow.test/page' }, (url, init) => (url.startsWith('https://r.jina.ai/') ? new Response('Reader text') : hang(init)));
    assert.match(read, /^Source: https:\/\/slow\.test\/page \(read through Jina Reader\)/);
    await assert.rejects(run('fetch', { url: 'https://slow.test/page' }, (_url, init) => hang(init)),
      { message: "Couldn't read https://slow.test/page: the site didn't answer in time; Jina Reader didn't answer in time; Exa didn't answer in time; no model with a fetch tool could read it." });
    await setKey('jina_test_key');
    cooldowns.clear('exa'); // the reader above timed out, and Exa rests for it
    await assert.rejects(run('web_search', { query: 'tide pools' }, (_url, init) => hang(init)), /Jina Search didn't answer in time; Exa didn't answer in time; Parallel didn't answer in time; Firecrawl didn't answer in time; Wikivoyage and Wikipedia didn't answer in time/);
    // The user's stop is still a stop.
    STEP_MS.ms = 5_000;
    const stop = new AbortController();
    setTimeout(() => stop.abort(new DOMException('stopped', 'AbortError')), 10);
    await assert.rejects(run('fetch', { url: 'https://slow.test/page' }, (_url, init) => hang(init), { signal: stop.signal }), { name: 'AbortError' });
  } finally {
    STEP_MS.ms = was;
  }
});
