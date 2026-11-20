import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { webVia } from '../../src/core/agent/via.js';
import { STEP_MS, READY_MS } from '../../src/plugins/web/index.js';
import { cooldowns, CHAIN } from '../../src/core/web-search.js';
import { tracedFetch } from '../../src/core/agent/net.js';
import { NOMINATIM_GAP, nominatimReset, nominatimTurn } from '../../src/core/nominatim.js';
import { forgetClients, knowledgeFloor, FLOOR_MS, FLOOR_ROWS } from '../../src/plugins/web/free.js';
import { readingOrder } from '../../src/core/languages.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { readFile } from 'node:fs/promises';

/** The recorded MCP answers carry id 1; a client that keeps its session across searches counts on, as a real server echoes the request's id. @param {any} init @param {Response} res */
async function withId(init, res) {
  if (init?.method !== 'POST' || typeof init.body !== 'string' || !init.body.includes('"jsonrpc"') || !(res instanceof Response) || res.status !== 200) return res;
  const id = JSON.parse(init.body).id;
  if (!id || id === 1) return res;
  return new Response((await res.text()).replace(/"id":1([,}])/, `"id":${id}$1`), { status: res.status, headers: res.headers });
}

async function setup({ traced = false } = {}) {
  NOMINATIM_GAP.ms = 1;
  nominatimReset();
  forgetClients();
  for (const id of ['jina', 'exa', 'parallel', 'firecrawl', 'wiki', 'stuck', 'slow', 'tavily']) cooldowns.clear(id);
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
    fetch: traced
      ? tracedFetch(store, 'me', { tool: name }, async (/** @type {string} */ url, /** @type {any} */ init = {}) => { asked.push({ url, init }); return withId(init, await answer(url, init)); })
      : async (/** @type {string} */ url, /** @type {any} */ init = {}) => { asked.push({ url, init }); return withId(init, await answer(url, init)); },
    llm: { call: async () => { throw new Error('no model'); } },
    ...over,
  });
  const setKey = (/** @type {string} */ k) => store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:web:jina', k));
  const settings = (/** @type {any} */ web) => updateAppSettings(ws, { web });
  return { registry, run, asked, setKey, settings, ws, store };
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
  if (u.searchParams.get('list') === 'search') return j({ query: { search: [{ title: 'Nepenthe (restaurant)', snippet: 'a <span class="searchmatch">restaurant</span> in Big Sur' }] } });
  // English Wikivoyage's best match with its text, in one answer (generator=search).
  return j({ query: { pages: [{ title: 'Big Sur', index: 1, extract: 'Intro.\n1 Nepenthe, 48510 Highway 1. Lunch from 11:30AM-4:30PM; Dinner from 5-10PM. Picturesque restaurant.\n2 Bixby Bridge (11 mi north of Big Sur Village). Iconic bridge built in 1933.' }] } });
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
  assert.match(floor, /Nepenthe \(restaurant\) \(Wikipedia\)\thttps:\/\/en\.wikipedia\.org\/wiki\/Nepenthe_%28restaurant%29\ta restaurant in Big Sur/);
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

/** Wikipedia's real answers to the floor's searches for "Kiyomizu temple opening hours" and its fewer words (2026-11-19; text under CC BY-SA 4.0). */
const KIYOMIZU_SEARCH = /** @type {Record<string, string>} */ ({
  'ja.wikipedia.org kiyomizu temple opening hours': 'wiki-search-ja.json', 'ja.wikipedia.org kiyomizu temple opening': 'wiki-search-ja-3.json',
  'ja.wikipedia.org kiyomizu temple': 'wiki-search-ja-2.json', 'en.wikipedia.org kiyomizu temple opening hours': 'wiki-search-en.json',
});
/** The floor's services: those saved answers, nothing from Wikivoyage, no website from Nominatim. @param {string} url */
async function kiyomizuFloor(url) {
  const u = new URL(url);
  const j = (/** @type {any} */ x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'nominatim.openstreetmap.org') return j([]);
  const saved = KIYOMIZU_SEARCH[`${u.hostname} ${u.searchParams.get('srsearch')}`];
  return saved ? jsonFile(`../places/${saved}`) : j({ batchcomplete: '', query: { searchinfo: { totalhits: 0 }, search: [] } });
}

test("the floor's Wikipedia search: each edition of the reading order asks at once with its own tries; the rows are every edition's that found any, taken in turn in the order, 8 in all", async () => {
  const { run, asked, settings, ws } = await setup();
  await updateAppSettings(ws, { languages: { spoken: ['ja'], answer: 'follow' } });
  await settings({ searchOff: ['exa', 'parallel', 'firecrawl'] });
  const wiki = () => asked.filter((a) => a.url.includes('wikipedia.org')).map((a) => `${new URL(a.url).hostname} ${new URL(a.url).searchParams.get('srsearch')}`);
  // [ja, en]: Japanese finds nothing for the whole question or three words and 清水寺 for two; English has seven hits for the whole question,
  // about other places. The traveller's language first (the user, 2026-11-14: "Read the traveller's language first, English when that has no article"),
  // and English's too, each edition heard (2026-11-19: "can we pull the english and their edition?"): 清水寺, then English's seven.
  const out = await run('web_search', { query: 'Kiyomizu temple opening hours' }, kiyomizuFloor);
  assert.deepEqual(wiki().sort(), ['en.wikipedia.org kiyomizu temple opening hours', 'ja.wikipedia.org kiyomizu temple', 'ja.wikipedia.org kiyomizu temple opening', 'ja.wikipedia.org kiyomizu temple opening hours']);
  // Both editions' first requests are in flight before either answers: asked together, not one after the other.
  assert.deepEqual(wiki().slice(0, 2), ['ja.wikipedia.org kiyomizu temple opening hours', 'en.wikipedia.org kiyomizu temple opening hours']);
  // (A search row's address is written as the browser would send it: normalizeRows.)
  assert.match(out, /\n清水寺 \(Wikipedia\)\thttps:\/\/ja\.wikipedia\.org\/wiki\/%E6%B8%85%E6%B0%B4%E5%AF%BA\t/);
  const articles = (/** @type {string} */ text) => text.split('\n').filter((r) => r.includes(' (Wikipedia)\t')).map((r) => r.split(' (Wikipedia)\t')[0]);
  assert.deepEqual(articles(out), ['清水寺', 'Tobu World Square', 'Legoland Japan Resort', 'Japanese garden', 'Konpira Grand Theatre', 'Onoe Kikugorō VIII', 'Heya (sumo)', 'Onbashira']);
  // Nominatim names places in the order's languages too.
  assert.equal(new URL(asked.find((a) => a.url.includes('nominatim'))?.url ?? '').searchParams.get('accept-language'), 'ja,en');
  // English first: English's first, then Japanese's, then English's others, 8 in all.
  await updateAppSettings(ws, { languages: { spoken: ['en', 'ja'], answer: 'follow' } });
  asked.length = 0;
  const english = await run('web_search', { query: 'Kiyomizu temple opening hours' }, kiyomizuFloor);
  assert.match(english, /\nTobu World Square \(Wikipedia\)\thttps:\/\/en\.wikipedia\.org\/wiki\/Tobu_World_Square\t/);
  assert.deepEqual(articles(english), ['Tobu World Square', '清水寺', 'Legoland Japan Resort', 'Japanese garden', 'Konpira Grand Theatre', 'Onoe Kikugorō VIII', 'Heya (sumo)', 'Onbashira']);
  // An edition that fails is left out: English not answering, Japanese's two words find 清水寺; Japanese not answering, English's rows come.
  await updateAppSettings(ws, { languages: { spoken: ['ja'], answer: 'follow' } });
  const enDown = await run('web_search', { query: 'Kiyomizu temple opening hours' }, (url) => (url.includes('en.wikipedia.org') ? new Response('', { status: 503 }) : kiyomizuFloor(url)));
  assert.match(enDown, /\n清水寺 \(Wikipedia\)\t/);
  const jaDown = await run('web_search', { query: 'Kiyomizu temple opening hours' }, (url) => (url.includes('ja.wikipedia.org') ? new Response('', { status: 503 }) : kiyomizuFloor(url)));
  assert.match(jaDown, /\nTobu World Square \(Wikipedia\)\t/);
  assert.doesNotMatch(jaDown, /清水寺/);
});

/** FLOOR_MS set to ms while fn runs. @param {number} ms @param {() => Promise<void>} fn */
async function withFloor(ms, fn) {
  const was = FLOOR_MS.ms;
  FLOOR_MS.ms = ms;
  try {
    await fn();
  } finally {
    FLOOR_MS.ms = was;
  }
}
/** The floor on its own, reading the languages given. @param {string[]} spoken */
const floorOf = (spoken) => knowledgeFloor(async () => readingOrder({ languages: { spoken, answer: 'follow' } }, 'en-US'));
/** One search of a floor, the services answering as `answer` says. @param {ReturnType<typeof knowledgeFloor>} floor @param {(url: string, init: any) => any} answer @param {string} [query] @param {AbortSignal} [signal] */
const search = (floor, answer, query = 'kiyomizu temple', signal = new AbortController().signal) => floor.search(query, { fetch: async (/** @type {string} */ url, /** @type {any} */ init) => answer(url, init), signal, limit: 8 });
/** Wikipedia's answer to a search that finds these titles. */
const found = (/** @type {string[]} */ ...titles) => new Response(JSON.stringify({ query: { search: titles.map((title) => ({ title, snippet: 'a temple' })) } }));
const nothing = () => new Response(JSON.stringify({ query: { search: [] } }));

test("the floor has one time for the whole of it: an edition that never answers costs the others and the guide no more than that, and what came is the answer", async () => {
  const { run, ws, settings } = await setup();
  await updateAppSettings(ws, { languages: { spoken: ['ja'], answer: 'follow' } });
  await settings({ searchOff: ['exa', 'parallel', 'firecrawl'] });
  await withFloor(60, async () => {
    const t0 = Date.now();
    const out = await run('web_search', { query: 'Kiyomizu temple opening hours' }, (url, init) => (url.includes('ja.wikipedia.org') ? hang(init) : url.includes('wikivoyage') ? wikiAnswer(url) : kiyomizuFloor(url)));
    assert.ok(Date.now() - t0 < 2000, "not the chain's limit for it");
    assert.match(out, /\nTobu World Square \(Wikipedia\)\t/, "Japanese never answered: English's rows");
    assert.match(out, /\(Wikivoyage\)\t/);
    // Both Wikipedia hosts hung and nothing else has rows: the floor fails, in words, naming the part that was late and not the floor's three.
    await assert.rejects(run('web_search', { query: 'Kiyomizu temple opening hours' }, (url, init) => (url.includes('wikipedia.org') ? hang(init) : kiyomizuFloor(url))), (/** @type {any} */ e) => /Web search didn't work: ja\.wikipedia\.org didn't answer in time/.test(e.message) && !/Nominatim/.test(e.message));
    assert.equal(cooldowns.left('wiki'), 0, 'and the floor does not rest');
  });
});

test("the floor: a Nominatim that answers after the floor's time loses only its own rows; the guide's and Wikipedia's come", async () => {
  const { run, ws, settings } = await setup();
  await updateAppSettings(ws, { languages: { spoken: ['en'], answer: 'follow' } });
  await settings({ searchOff: ['exa', 'parallel', 'firecrawl'] });
  await withFloor(100, async () => {
    const t0 = Date.now();
    const out = await run('web_search', { query: 'nepenthe lunch' }, (url, init) => (url.includes('nominatim') ? hang(init) : wikiAnswer(url)));
    assert.ok(Date.now() - t0 < 2000);
    assert.match(out, /Big Sur \(Wikivoyage\)\t/);
    assert.match(out, /Nepenthe \(restaurant\) \(Wikipedia\)\t/);
    assert.doesNotMatch(out, /nepenthebigsur/);
  });
});

test("the floor: a Nominatim turn that comes after the floor's time is not waited for: the floor ends at its time with Wikipedia's rows, Nominatim is not asked, and with no rows the failure is Nominatim's lateness", async () => {
  const wiki = (/** @type {string} */ url) => (url.includes('nominatim') ? new Response('[]') : url.includes('en.wikipedia.org') ? found('Kiyomizu-dera') : nothing());
  try {
    // The app's gate is booked for 2 s (another request's turns, queued ahead of the floor's); the floor's time is 100 ms.
    NOMINATIM_GAP.ms = 2000;
    nominatimReset();
    await nominatimTurn();
    await withFloor(100, async () => {
      /** @type {string[]} */
      const asked = [];
      const t0 = Date.now();
      const rows = await search(floorOf(['en']), (url) => (asked.push(url), wiki(url)));
      assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms: at the floor's time, not at Nominatim's turn`);
      assert.deepEqual(rows.map((r) => r.title), ['Kiyomizu-dera (Wikipedia)']);
      assert.deepEqual(asked.filter((u) => u.includes('nominatim')), [], 'no request to Nominatim after its time');
      const t1 = Date.now();
      const failure = await search(floorOf(['en']), () => nothing()).then(() => null, (/** @type {any} */ e) => e);
      assert.ok(Date.now() - t1 < 1000);
      assert.equal(failure?.message, "nominatim.openstreetmap.org didn't answer in time");
      assert.equal(failure?.late, true);
      // The user's stop ends the wait too, as itself.
      const stop = new AbortController();
      setTimeout(() => stop.abort(new DOMException('stopped', 'AbortError')), 20);
      const t2 = Date.now();
      const stopped = await search(floorOf(['en']), () => nothing(), 'kiyomizu temple', stop.signal).then(() => null, (/** @type {any} */ e) => e);
      assert.ok(Date.now() - t2 < 1000);
      assert.equal(stopped?.name, 'AbortError');
      // A floor whose time ran out before its parts began (a slow settings read) ends at once, without waiting for a turn.
      const t3 = Date.now();
      const slowRead = knowledgeFloor(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return readingOrder({ languages: { spoken: ['en'], answer: 'follow' } }, 'en-US');
      });
      const late = await search(slowRead, (_url, init) => (init.signal.aborted ? Promise.reject(init.signal.reason) : nothing())).then(() => null, (/** @type {any} */ e) => e);
      assert.ok(Date.now() - t3 < 1000);
      assert.match(late?.message, /didn't answer in time/);
    });
  } finally {
    NOMINATIM_GAP.ms = 1;
    nominatimReset();
  }
});

test("the floor on a slow link: every answer takes its time, English alone is asked three times in series and Kiyomizu-dera comes with the third, as before editions", async () => {
  // Each answer 200 ms: the guide's and Wikipedia's three tries are 600 ms, inside the floor's 1.5 s (on a real slow link 2.5 s an answer, 7.5 s, inside its 9).
  // English Wikipedia finds it only with the two words; everything else finds nothing.
  const slow = (/** @type {string} */ url, /** @type {any} */ init) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 200, url.includes('en.wikipedia.org') && new URL(url).searchParams.get('srsearch') === 'kiyomizu temple' ? found('Kiyomizu-dera') : url.includes('nominatim') ? new Response('[]') : nothing());
    init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
  });
  await withFloor(1500, async () => {
    const rows = await search(floorOf(['en']), slow, 'Kiyomizu temple opening hours');
    assert.deepEqual(rows.map((r) => r.title), ['Kiyomizu-dera (Wikipedia)']);
  });
});

test("the floor's result: the rows of what answered; no rows and something failed (late, refused, an error answer) is the failure in words; no rows and nothing failed is nothing found", async () => {
  const down = () => new Response('', { status: 503 });
  const maxlag = () => new Response(JSON.stringify({ error: { code: 'maxlag', info: 'Waiting for a database server: 6 seconds lagged.' } }));
  const empty = (/** @type {string} */ url) => (url.includes('nominatim') ? new Response('[]') : nothing());
  const floor = floorOf(['ja']);
  // Everything refused.
  await assert.rejects(search(floor, down), /answered 503/);
  // Wikipedia refused in both editions, Wikivoyage and Nominatim answered with nothing: a failure, not "nothing found".
  await assert.rejects(search(floor, (url) => (url.includes('wikipedia.org') ? down() : empty(url))), /wikipedia\.org answered 503/);
  // Wikipedia's error answer (HTTP 200): the same.
  await assert.rejects(search(floor, (url) => (url.includes('wikipedia.org') ? maxlag() : empty(url))), /said: Waiting for a database server: 6 seconds lagged$/);
  // The same failures with rows from another part: the rows.
  const rows = await search(floor, (url) => (url.includes('ja.wikipedia.org') ? down() : url.includes('en.wikipedia.org') ? found('Kiyomizu-dera') : empty(url)));
  assert.deepEqual(rows.map((r) => r.title), ['Kiyomizu-dera (Wikipedia)']);
  const guideRows = await search(floor, (url) => (url.includes('wikipedia.org') ? maxlag() : url.includes('wikivoyage') ? new Response(JSON.stringify({ query: { pages: [{ title: 'Kyoto', index: 1, extract: 'Kiyomizu-dera is a temple that opens at six every morning.' }] } })) : empty(url)));
  assert.deepEqual(guideRows.map((r) => r.title), ['Kyoto (Wikivoyage)']);
  // Everything answered, nothing found.
  assert.deepEqual(await search(floor, empty), []);
  // Japanese answered and found nothing: English's rows.
  assert.deepEqual((await search(floor, (url) => (url.includes('ja.wikipedia.org') ? nothing() : url.includes('en.wikipedia.org') ? found('Kiyomizu-dera') : empty(url)))).map((r) => r.title), ['Kiyomizu-dera (Wikipedia)']);
  // Every edition that found any, taken in turn in the order: Japanese's first, though English answered first.
  const order = await search(floor, (url) => (url.includes('ja.wikipedia.org') ? new Promise((r) => setTimeout(r, 40, found('清水寺', '金閣寺'))) : url.includes('en.wikipedia.org') ? found('Kiyomizu-dera', 'Kinkaku-ji', 'Ryōan-ji') : empty(url)));
  assert.deepEqual(order.map((r) => r.title), ['清水寺 (Wikipedia)', 'Kiyomizu-dera (Wikipedia)', '金閣寺 (Wikipedia)', 'Kinkaku-ji (Wikipedia)', 'Ryōan-ji (Wikipedia)']);
  assert.deepEqual(order.map((r) => new URL(r.url).hostname), ['ja.wikipedia.org', 'en.wikipedia.org', 'ja.wikipedia.org', 'en.wikipedia.org', 'en.wikipedia.org']);
  // 8 in all: two editions of eight each give four of each.
  const eight = (/** @type {string} */ p) => Array.from({ length: 8 }, (_, k) => `${p} ${k}`);
  const full = await search(floor, (url) => (url.includes('ja.wikipedia.org') ? found(...eight('寺')) : url.includes('en.wikipedia.org') ? found(...eight('Temple')) : empty(url)));
  assert.deepEqual(full.map((r) => r.title.replace(' (Wikipedia)', '')), ['寺 0', 'Temple 0', '寺 1', 'Temple 1', '寺 2', 'Temple 2', '寺 3', 'Temple 3']);
  // The user's stop is a stop.
  const stop = new AbortController();
  setTimeout(() => stop.abort(new DOMException('stopped', 'AbortError')), 10);
  await assert.rejects(search(floor, (_url, init) => hang(init), 'kiyomizu temple', stop.signal), { name: 'AbortError' });
});

test("the floor never rests: one of its services down with nothing found is a failure that names that service, and the next search asks the floor again", async () => {
  const { run, settings } = await setup();
  await settings({ searchOff: ['exa', 'parallel', 'firecrawl'] });
  const answer = (/** @type {boolean} */ up) => (/** @type {string} */ url) => (url.includes('nominatim') ? (up ? new Response('[]') : new Response('', { status: 503 })) : url.includes('en.wikipedia.org') && up ? found('Kiyomizu-dera') : nothing());
  await assert.rejects(run('web_search', { query: 'kiyomizu temple' }, answer(false)), (/** @type {any} */ e) => /nominatim\.openstreetmap\.org answered 503/.test(e.message) && !/Wikivoyage, Wikipedia and Nominatim/.test(e.message));
  assert.equal(cooldowns.left('wiki'), 0);
  assert.match(await run('web_search', { query: 'kiyomizu temple' }, answer(true)), /Kiyomizu-dera \(Wikipedia\)/);
});

test("the floor's error names only the part that was late: a Nominatim that never answers is nominatim's, not the floor's three", async () => {
  const { run, settings } = await setup();
  await settings({ searchOff: ['exa', 'parallel', 'firecrawl'] });
  await withFloor(60, async () => {
    await assert.rejects(run('web_search', { query: 'kiyomizu temple' }, (url, init) => (url.includes('nominatim') ? hang(init) : nothing())), (/** @type {any} */ e) => /Web search didn't work: nominatim\.openstreetmap\.org didn't answer in time/.test(e.message) && !/Wikivoyage/.test(e.message));
  });
});

test("web_search: 'Nothing found' is said only when nothing failed; a service that failed while the rest found nothing is the failure, in words", async () => {
  const { run } = await setup();
  const none = (/** @type {string} */ url) => (url.includes('wikivoyage') || url.includes('wikipedia') ? nothing() : url.includes('nominatim') ? new Response('[]') : mcpText('{"results":[],"data":{"web":[]}}'));
  await assert.rejects(run('web_search', { query: 'zzzz qqqq' }, (url) => (url === EXA ? new Response('slow down', { status: 429 }) : none(url))), /Web search didn't work: Exa answered 429 \(its free limit\)/);
});

test("the floor's time starts with its search, before it reads the settings: a slow read leaves its requests no more than what is left", async () => {
  /** @type {boolean[]} */
  const stopped = [];
  const floor = knowledgeFloor(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return readingOrder({ languages: { spoken: ['en'], answer: 'follow' } }, 'en-US');
  });
  /** @type {any} */
  let failure = null;
  await withFloor(60, async () => {
    failure = await search(floor, (_url, init) => {
      stopped.push(init.signal.aborted);
      return init.signal.aborted ? Promise.reject(init.signal.reason) : hang(init);
    }).then(() => null, (/** @type {any} */ e) => e);
  });
  // The time had run out when the settings came: no request goes out (Wikimedia's turn and Nominatim's turn see the time is up first).
  assert.ok(stopped.every(Boolean), 'none with time left');
  assert.match(failure?.message, /didn't answer in time/);
});

test("FLOOR_MS has its reason: three answers of 2.5 s in series, and a second inside what the chain keeps for the floor", () => {
  assert.ok(FLOOR_MS.ms >= 3 * 2500);
  assert.equal(FLOOR_MS.ms, CHAIN.reserve - 1_000);
});

test("the floor's addresses: a Wikivoyage guide's keeps its title as written with the brackets encoded, as a Wikipedia article's does", async () => {
  const rows = await search(floorOf(['en']), (url) => (url.includes('wikivoyage')
    ? new Response(JSON.stringify({ query: { pages: [{ title: 'Cambria (California)', index: 1, extract: 'Cambria is a seaside town on the coast.' }] } })) : url.includes('nominatim') ? new Response('[]') : found('Cambria, California (town)')));
  assert.deepEqual(rows.map((r) => r.url), ['https://en.wikivoyage.org/wiki/Cambria_%28California%29', 'https://en.wikipedia.org/wiki/Cambria,_California_%28town%29']);
});

test("the floor's guide: English's best match with its links in one request, and, by the titles it links to, its page in each of the traveller's other editions that has one, a row each in the reading order; an edition's search is never used", async () => {
  // English Wikivoyage's answer shape to generator=search (2026-11-20): the best page, with its text and links, formatversion 2.
  const kyoto = { batchcomplete: true, query: { pages: [{ pageid: 18579, ns: 0, title: 'Kyoto', index: 1, extract: 'Kyoto was the capital of Japan for over a millennium.\nKiyomizu-dera, the wooden temple on the hill, opens at six.', langlinks: [{ lang: 'de', title: 'Kyōto' }, { lang: 'ja', title: '京都市' }, { lang: 'zh', title: '京都' }] }] } };
  const ja = { batchcomplete: true, query: { pages: [{ ns: 0, title: '京都市', extract: '京都市は京都府の府庁所在地で、千年にわたって都だった。\n清水寺は東山にある寺で、朝六時に開門する。' }] } };
  /** @type {string[]} */
  const asked = [];
  const answer = (/** @type {string} */ url) => {
    const u = new URL(url);
    asked.push(`${u.hostname} ${u.searchParams.get('generator') ?? u.searchParams.get('prop')} ${u.searchParams.get('gsrsearch') ?? u.searchParams.get('titles')}`);
    if (u.hostname === 'en.wikivoyage.org') return new Response(JSON.stringify(kyoto));
    if (u.hostname === 'ja.wikivoyage.org') return new Response(JSON.stringify(ja));
    return url.includes('nominatim') ? new Response('[]') : nothing();
  };
  const rows = await search(floorOf(['ja']), answer, 'kiyomizu temple');
  assert.deepEqual(rows.map((r) => [r.title, r.url]), [['京都市 (Wikivoyage)', 'https://ja.wikivoyage.org/wiki/京都市'], ['Kyoto (Wikivoyage)', 'https://en.wikivoyage.org/wiki/Kyoto']]);
  assert.equal(rows[1].snippet, 'Kiyomizu-dera, the wooden temple on the hill, opens at six.', "English's line that shares the query's words");
  assert.equal(rows[0].snippet, '京都市は京都府の府庁所在地で、千年にわたって都だった。 清水寺は東山にある寺で、朝六時に開門する。', 'none shares them: its first lines');
  const voyage = asked.filter((a) => a.includes('wikivoyage'));
  assert.deepEqual(voyage, ['en.wikivoyage.org search kiyomizu temple', 'ja.wikivoyage.org extracts 京都市'], 'one request for English, no search of Japanese Wikivoyage, and nothing of Chinese, which is not listed');
  // Japanese's page not coming: English's row all the same.
  const down = await search(floorOf(['ja']), (url) => (url.includes('ja.wikivoyage') ? new Response('', { status: 503 }) : answer(url)), 'kiyomizu temple');
  assert.deepEqual(down.map((r) => r.title), ['Kyoto (Wikivoyage)']);
});

/** Wikivoyage's and Wikipedia's answers for the floor with five editions: a guide in each, three websites and the articles of Japanese Wikipedia. */
function fiveEditions(/** @type {string} */ url) {
  const u = new URL(url);
  const j = (/** @type {any} */ x) => new Response(JSON.stringify(x));
  if (u.hostname === 'nominatim.openstreetmap.org') return j([1, 2, 3].map((k) => ({ name: `Site ${k}`, display_name: `Site ${k}, Kyoto`, extratags: { website: `https://site${k}.test/` } })));
  if (u.hostname === 'en.wikivoyage.org') return j({ query: { pages: [{ title: 'Kyoto', index: 1, extract: 'Kyoto is the old capital with a thousand temples.', langlinks: ['ja', 'zh', 'fr', 'de'].map((lang) => ({ lang, title: `Kyoto ${lang}` })) }] } });
  if (u.hostname.endsWith('.wikivoyage.org')) return j({ query: { pages: [{ title: String(u.searchParams.get('titles')), extract: 'A guide to the old capital with a thousand temples.' }] } });
  return j({ query: { search: Array.from({ length: 8 }, (_, k) => ({ title: `Article ${k}`, snippet: 'a temple' })) } });
}

test("the floor's rows are what its parts give, not the chain's 8: five editions' guides, three websites and the articles all come", async () => {
  assert.equal(FLOOR_ROWS, 24 + 3 + 8, 'a guide for each of the 24 Wikivoyage hosts, the websites, the articles asked of an edition');
  assert.equal('rows' in knowledgeFloor(async () => []), false, 'the chain gives the floor its rows by what it is, not by a field it carries');
  const { run, ws, settings, asked } = await setup();
  await updateAppSettings(ws, { languages: { spoken: ['ja', 'zh-Hant', 'fr', 'de'], answer: 'follow' } });
  await settings({ searchOff: ['exa', 'parallel', 'firecrawl'] });
  const out = await run('web_search', { query: 'kyoto temples' }, fiveEditions);
  // Each edition is still asked for 8 articles, not for as many as the floor's rows.
  assert.deepEqual([...new Set(asked.filter((a) => a.url.includes('wikipedia.org')).map((a) => new URL(a.url).searchParams.get('srlimit')))], ['8']);
  const rows = out.split('\n').slice(1);
  assert.equal(rows.filter((r) => r.includes('(Wikivoyage)')).length, 5, 'a guide in each edition');
  assert.equal(rows.filter((r) => r.includes('Site ')).length, 3);
  assert.equal(rows.filter((r) => r.includes('(Wikipedia)')).length, 8, "the first edition's articles");
  assert.equal(rows.length, 16);
});

test("the floor at 2.5 s an answer, the speed FLOOR_MS is sized for, with three editions listed: the three guides come, and each edition's article", async () => {
  /** Lets what has started run for a few turns (real time: the timers are faked). */
  const turns = async () => {
    for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
  };
  const reply = (/** @type {string} */ url) => {
    const u = new URL(url);
    const j = (/** @type {any} */ x) => new Response(JSON.stringify(x));
    if (u.hostname === 'nominatim.openstreetmap.org') return j([]);
    if (u.hostname === 'en.wikivoyage.org') return j({ query: { pages: [{ title: 'Kyoto', index: 1, extract: 'Kyoto is the old capital with a thousand temples.', langlinks: [{ lang: 'ja', title: '京都市' }, { lang: 'zh', title: '京都' }] }] } });
    if (u.hostname.endsWith('.wikivoyage.org')) return j({ query: { pages: [{ title: String(u.searchParams.get('titles')), extract: 'A guide to the old capital with a thousand temples.' }] } });
    return j({ query: { search: [{ title: { ja: '清水寺', zh: '清水寺 (京都)' }[u.hostname.split('.')[0]] ?? 'Kiyomizu-dera', snippet: 'a temple' }] } });
  };
  mock.timers.enable({ apis: /** @type {any[]} */ (['setTimeout', 'AbortSignal.timeout']) });
  try {
    // Every answer comes 2.5 s after it is asked, as FLOOR_MS (9 s) counts on: Wikipedia's three editions first, then English's guide (one request),
    // then the two other editions' pages at once: three answers' time.
    const answer = (/** @type {string} */ url, /** @type {any} */ init) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 2500, reply(url));
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
    /** @type {any} */
    let rows = null;
    const done = search(floorOf(['ja', 'zh-Hant']), answer, 'kiyomizu temple').then((r) => { rows = r; });
    for (let k = 0; k < 6 && rows === null; k++) {
      await turns();
      mock.timers.tick(2500);
    }
    await done;
    assert.deepEqual(rows.map((/** @type {any} */ r) => r.title), ['京都市 (Wikivoyage)', '京都 (Wikivoyage)', 'Kyoto (Wikivoyage)', '清水寺 (Wikipedia)', '清水寺 (京都) (Wikipedia)', 'Kiyomizu-dera (Wikipedia)']);
  } finally {
    mock.timers.reset();
  }
});

test("the floor's guide: a page another edition's link names that is missing there gives no row", async () => {
  const kyoto = { query: { pages: [{ title: 'Kyoto', index: 1, extract: 'Kyoto is the old capital with a thousand temples.', langlinks: [{ lang: 'ja', title: '京都市' }] }] } };
  const rows = await search(floorOf(['ja']), (url) => (url.includes('ja.wikivoyage') ? new Response(JSON.stringify({ query: { pages: [{ ns: 0, title: '京都市', missing: true }] } }))
    : url.includes('en.wikivoyage') ? new Response(JSON.stringify(kyoto)) : url.includes('nominatim') ? new Response('[]') : nothing()), 'kiyomizu temple');
  assert.deepEqual(rows.map((r) => r.title), ['Kyoto (Wikivoyage)']);
});

test("the floor takes Wikimedia's turns, 3 requests at once: Wikipedia's editions first, in the reading order, then the guide, which waits for a turn", async () => {
  // Chinese, Japanese and English: three editions' searches and the guide's, four requests to Wikimedia; the fourth waits.
  /** @type {string[]} */
  const started = [];
  /** @type {(() => void)[]} */
  const finish = [];
  const answer = (/** @type {string} */ url, /** @type {any} */ init) => {
    if (url.includes('nominatim')) return new Response('[]');
    started.push(new URL(url).hostname);
    return new Promise((resolve, reject) => {
      finish.push(() => resolve(nothing()));
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  const done = search(floorOf(['zh', 'ja']), answer, 'kiyomizu temple opening hours');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(started, ['zh.wikipedia.org', 'ja.wikipedia.org', 'en.wikipedia.org'], 'three at once, the editions first');
  finish.shift()?.();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(started.slice(3), ['en.wikivoyage.org'], 'one ends: the guide has its turn, before the next try of the one that ended');
  // The rest answer one at a time, each as it is asked: three tries an edition and the guide's three searches, 12 in all, never more than 3
  // waiting at once; then the floor ends with nothing found.
  for (let k = 1; k < 12; k++) {
    for (let wait = 0; !finish.length && wait < 200; wait++) await new Promise((r) => setTimeout(r, 2));
    assert.ok(finish.length > 0 && finish.length <= 3, `request ${k + 1}: ${finish.length} waiting`);
    finish.shift()?.();
  }
  assert.deepEqual(await done, []);
  assert.equal(started.length, 12);
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
    await assert.rejects(run('web_search', { query: 'tide pools' }, (_url, init) => hang(init)), /Jina Search didn't answer in time; Exa didn't answer in time; Parallel didn't answer in time; Firecrawl didn't answer in time; Wikivoyage, Wikipedia and Nominatim didn't answer in time/);
    // The user's stop is still a stop.
    STEP_MS.ms = 5_000;
    const stop = new AbortController();
    setTimeout(() => stop.abort(new DOMException('stopped', 'AbortError')), 10);
    await assert.rejects(run('fetch', { url: 'https://slow.test/page' }, (_url, init) => hang(init), { signal: stop.signal }), { name: 'AbortError' });
  } finally {
    STEP_MS.ms = was;
  }
});


// The fix pass after the review.

/** Everything off but the floor and one stand-in provider, so a test sees one thing. @param {any} t @param {any} item */
async function alone(t, item) {
  t.registry.add('third', 'search', { id: 'stuck', name: 'Stuck', ...item });
  await t.settings({ search: ['stuck'], searchOff: ['jina', 'exa', 'parallel', 'firecrawl'] });
}
/** An answer that settles after ms whatever the signal says: a provider that ignores it. @param {number} ms */
const ignoring = (ms) => new Promise((resolve) => setTimeout(() => resolve([]), ms));

test('S1: a ready() that never settles is passed over after a moment; a search() that ignores its signal ends at its step limit; the next providers answer', async () => {
  const was = [READY_MS.ms, STEP_MS.ms];
  READY_MS.ms = 40;
  STEP_MS.ms = 60;
  try {
    const t = await setup();
    await alone(t, { ready: () => new Promise(() => {}), search: async () => [] });
    const out = await t.run('web_search', { query: 'nepenthe hours' }, services);
    assert.match(out, /Wikivoyage/);
    t.registry.add('third2', 'search', { id: 'slow', name: 'Slow', search: () => new Promise(() => {}) });
    await t.settings({ search: ['slow'], searchOff: ['jina', 'exa', 'parallel', 'firecrawl', 'stuck'] });
    const started = Date.now();
    assert.match(await t.run('web_search', { query: 'nepenthe hours' }, services), /Wikivoyage/);
    assert.ok(Date.now() - started < 1000);
    // The user's stop still ends a provider that ignores it.
    const stop = new AbortController();
    setTimeout(() => stop.abort(new DOMException('stopped', 'AbortError')), 10);
    STEP_MS.ms = 5_000;
    cooldowns.clear('slow');
    await t.settings({ search: ['slow'], searchOff: ['jina', 'exa', 'parallel', 'firecrawl', 'stuck', 'wiki'] });
    await assert.rejects(t.run('web_search', { query: 'q' }, services, { signal: stop.signal }), { name: 'AbortError' });
  } finally {
    [READY_MS.ms, STEP_MS.ms] = was;
  }
});

test('S2: a third-party provider that says it is always on or the knowledge floor is asked only while ticked', async () => {
  const t = await setup();
  let asked = 0;
  t.registry.add('third', 'search', { id: 'sticky', name: 'Sticky', always: true, kind: 'knowledge', free: true, search: async () => { asked++; return [{ title: 'S', url: 'https://s.test/', snippet: 's' }]; } });
  await t.settings({ searchOff: ['sticky'] });
  await t.run('web_search', { query: 'q' }, services);
  assert.equal(asked, 0);
});

test("a provider of another plugin gets the chain's 8 rows whatever it says of itself (the knowledge floor, rows of its own): only the floor, the web plugin's, has more", async () => {
  const t = await setup();
  t.registry.add('third', 'search', { id: 'greedy', name: 'Greedy', kind: 'knowledge', always: true, rows: 100, search: async (/** @type {string} */ q, /** @type {any} */ c) => {
    assert.equal(c.limit, 8);
    return Array.from({ length: 30 }, (_, k) => ({ title: `T${k}`, url: `https://g.test/${k}`, snippet: 's' }));
  } });
  await t.settings({ searchOff: ['exa', 'parallel', 'firecrawl'], searchOrder: ['greedy'] });
  const out = await t.run('web_search', { query: 'q' }, services);
  assert.equal(out.split('\n').length, 1 + 8, 'a header and eight rows');
});

test("S3: a request the browser could not make, through the traced fetch, rests Jina like any other and not the floor, which the next search asks again (the traced fetch marks it a network failure)", async () => {
  const t = await setup({ traced: true });
  await t.setKey('jina_test_key');
  await t.settings({ searchOff: ['exa', 'parallel', 'firecrawl'] });
  await assert.rejects(t.run('web_search', { query: 'nepenthe hours' }, blocked), /Web search didn't work/);
  assert.ok(cooldowns.left('jina') > 0, 'Jina rests');
  assert.equal(cooldowns.left('wiki'), 0, 'the floor never does');
  // The floor is asked again, and answers.
  t.asked.length = 0;
  const again = await t.run('web_search', { query: 'nepenthe hours' }, services);
  assert.match(again, /Big Sur \(Wikivoyage\)/);
  assert.ok(t.asked.some((a) => a.url.includes('wikivoyage')), 'asked');
  // And the failure is told as itself.
  const e = await tracedFetch(t.store, 'me', { tool: 'web_search' }, blocked)('https://x.test/').catch((/** @type {any} */ x) => x);
  assert.equal(e.kind, 'network');
  assert.ok(e.cause instanceof TypeError);
});

test('S7: a keyless service that now answers 401 or 403 is told as asking for a key, and rests', async () => {
  const t = await setup();
  const out = await t.run('web_search', { query: 'nepenthe hours' }, (url, init) => (url === EXA ? new Response('', { status: 401 }) : services(url, init)));
  assert.match(out, /nepenthebigsur\.com/);
  assert.ok(cooldowns.left('exa') > 0);
  cooldowns.clear('exa');
  await t.settings({ searchOff: ['parallel', 'firecrawl', 'wiki'] });
  await assert.rejects(t.run('web_search', { query: 'q' }, (url) => new Response('', { status: url === EXA ? 403 : 500 })), /Exa now asks for a key/);
});

test("S9: when every service that ran failed by timeout or network, nobody climbs; the floor, which failed with them, does not rest, and the next search asks it again", async () => {
  const was = STEP_MS.ms;
  STEP_MS.ms = 30;
  try {
    const t = await setup();
    await t.settings({ searchOff: ['jina'] });
    await assert.rejects(t.run('web_search', { query: 'q' }, (_url, init) => hang(init)), /didn't answer in time/);
    for (const id of ['exa', 'parallel', 'firecrawl']) assert.equal(cooldowns.left(id) <= 60_000 && cooldowns.left(id) > 0, true, id);
    assert.equal(cooldowns.left('wiki'), 0, 'the floor does not rest');
    // The three are resting now; the floor is asked and answers, under the step's own time again (30 ms was for the first search).
    STEP_MS.ms = was;
    t.asked.length = 0;
    const out = await t.run('web_search', { query: 'nepenthe hours' }, services);
    assert.match(out, /Big Sur \(Wikivoyage\)/);
    assert.ok(t.asked.length > 0 && t.asked.every((a) => !/mcp\.|search\.parallel/.test(a.url)), 'only the floor was asked');
  } finally {
    STEP_MS.ms = was;
  }
});

test('S10: a search ends by its deadline, with a reserve kept for the floor, which answers', async () => {
  const was = [CHAIN.ms, CHAIN.reserve];
  // In seconds, not a fraction of one: on a host loaded far past its CPUs (load about 300 on 32 CPUs) the event loop stalled for 200 to 400 ms, a
  // stall ate the old 150 ms reserve, and the floor was left out (this test failed once in a real `npm run check` at that load). The stuck provider
  // gets 2.5 s; the floor's 1.5 s holds its 100 ms least room past three such stalls.
  CHAIN.ms = 4_000;
  CHAIN.reserve = 1_500;
  try {
    const t = await setup();
    await alone(t, { search: () => ignoring(60_000) });
    const started = Date.now();
    const out = await t.run('web_search', { query: 'nepenthe hours' }, services);
    assert.match(out, /Wikivoyage/);
    const took = Date.now() - started;
    // At least the stuck provider's 2.5 s (the deadline is fixed when the search starts, so it is given the 4 s less the floor's 1.5 s whenever it is
    // asked; the 100 ms under that is slack); at most the deadline and 2 s of stalls, where a search that waited on the provider would take its
    // 60 s, or the 25 s step limit (STEP_MS).
    assert.ok(took >= 2_400 && took < 6_000, `took ${took} ms`);
  } finally {
    [CHAIN.ms, CHAIN.reserve] = was;
  }
});

test('Parallel gets one random session_id per conversation, kept in memory; a new conversation gets a new one', async () => {
  const t = await setup();
  await t.settings({ searchOff: ['exa', 'jina'] });
  const sessions = [];
  const answer = (/** @type {string} */ url, /** @type {any} */ init) => { if (url === PARALLEL) sessions.push(JSON.parse(init.body).params.arguments.session_id); return services(url, init); };
  await t.run('web_search', { query: 'one' }, answer);
  await t.run('web_search', { query: 'two' }, answer);
  await t.run('web_search', { query: 'three' }, answer, { scope: 'trip-b' });
  assert.match(sessions[0], /^[0-9a-f-]{20,}$/);
  assert.equal(sessions[0], sessions[1]);
  assert.notEqual(sessions[2], sessions[0]);
  const stored = JSON.stringify(await t.store.tx(['files', 'events', 'secrets'], 'readonly', async (/** @type {any} */ tx) => [await tx.listFiles('sys:settings'), await tx.listSecretIds()]));
  assert.ok(!stored.includes(sessions[0]));
});

test('S5: Exa, Parallel and Firecrawl are sent only the words searched (and Exa its name); no location, trip or key', async () => {
  const t = await setup();
  await t.settings({});
  await t.run('web_search', { query: 'nepenthe hours' }, services, { trip: 'trip-1', scope: 'trip-1' });
  const sent = JSON.stringify(t.asked.map((a) => [a.url, a.init.headers, a.init.body]));
  assert.ok(!/trip-1|authorization|lat|lng/i.test(sent), sent);
});

test('S4: the floor asks Nominatim no faster than places does, from one shared gate, and says who is asking', async () => {
  try {
    const t = await setup();
    NOMINATIM_GAP.ms = 80;
    await t.settings({ searchOff: ['jina', 'exa', 'parallel', 'firecrawl'] });
    const at = /** @type {number[]} */ ([]);
    const answer = (/** @type {string} */ url, /** @type {any} */ init) => {
      if (url.includes('nominatim')) {
        at.push(Date.now());
        assert.equal(init.referrerPolicy, 'origin');
      }
      return wikiAnswer(url);
    };
    await t.run('web_search', { query: 'nepenthe lunch' }, answer);
    await t.run('web_search', { query: 'bixby bridge' }, answer);
    // A places call in between takes its turn from the same gate.
    assert.equal(at.length, 2);
    assert.ok(at[1] - at[0] >= 75, `${at[1] - at[0]} ms apart`);
  } finally {
    NOMINATIM_GAP.ms = 1;
  }
});

test('the floor reads no more of an answer than annai reads', async () => {
  const t = await setup();
  await t.settings({ searchOff: ['jina', 'exa', 'parallel', 'firecrawl'] });
  const huge = () => new Response('x', { headers: { 'content-length': String(9 * 2 ** 20), 'content-type': 'application/json' } });
  await assert.rejects(t.run('web_search', { query: 'nepenthe lunch' }, huge), /more than annai reads/);
});


test('a server that wants a session first is given one once: two searches make one initialize, and the session is reused', async () => {
  const t = await setup();
  await t.settings({ searchOff: ['jina', 'parallel', 'firecrawl'] });
  const fixtureText = await fixture('exa-search.sse');
  /** @type {{ method: string, session: string | null }[]} */
  const seen = [];
  const answer = (/** @type {string} */ url, /** @type {any} */ init) => {
    if (url !== EXA) return wikiAnswer(url);
    const body = JSON.parse(init.body);
    const session = new Headers(init.headers).get('mcp-session-id');
    seen.push({ method: body.method, session });
    if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (!session) return new Response('no session', { status: 400 });
    return new Response(fixtureText.replace(/"id":1\}/, `"id":${body.id}}`), { headers: { 'content-type': 'text/event-stream' } });
  };
  assert.match(await t.run('web_search', { query: 'nepenthe hours' }, answer), /Hours and Directions/);
  assert.match(await t.run('web_search', { query: 'bixby bridge' }, answer), /Hours and Directions/);
  assert.equal(seen.filter((m) => m.method === 'initialize').length, 1);
  assert.deepEqual(seen.filter((m) => m.method === 'tools/call').map((m) => m.session), [null, 'sess-1', 'sess-1']);
});

test('ready() is charged to the search\'s deadline: several slow ones cannot hold it past its time, and the floor still answers', async () => {
  const was = [CHAIN.ms, CHAIN.reserve, READY_MS.ms];
  // In seconds, as S10 (a stall of a loaded host ate a 150 ms reserve): the floor's 1.5 s past three 400 ms stalls. Each ready() may take twice
  // the whole search, so only the search's deadline can end the four of them in time.
  CHAIN.ms = 5_000;
  CHAIN.reserve = 1_500;
  READY_MS.ms = 10_000;
  try {
    const t = await setup();
    for (const n of ['a', 'b', 'c', 'd']) t.registry.add(`third-${n}`, 'search', { id: `slow-${n}`, name: `Slow ${n}`, ready: () => new Promise(() => {}), search: async () => [] });
    await t.settings({ search: ['slow-a', 'slow-b', 'slow-c', 'slow-d'], searchOff: ['jina', 'exa', 'parallel', 'firecrawl'] });
    const started = Date.now();
    const out = await t.run('web_search', { query: 'nepenthe hours' }, services);
    assert.match(out, /Wikivoyage/);
    const took = Date.now() - started;
    // The deadline and 2 s of stalls; one ready() given its own limit would take 10 s.
    assert.ok(took < 7_000, `took ${took} ms`);
  } finally {
    [CHAIN.ms, CHAIN.reserve, READY_MS.ms] = was;
  }
});
