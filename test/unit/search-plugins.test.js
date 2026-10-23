import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { checkManifest, checkSearchDesc, originsOf, inspectPackage } from '../../src/core/packages.js';
import { addressProblem } from '../../src/core/llm/provider-desc.js';
import { keysNote, whatItBrings } from '../../src/ui/screens/plugin-install.js';
import { cooldowns } from '../../src/core/web-search.js';
import { Registry } from '../../src/core/registry.js';
import { activate as tavily } from '../../plugins-official/search-tavily/index.js';
import { activate as serper } from '../../plugins-official/search-serper/index.js';
import { activate as searxng } from '../../plugins-official/search-searxng/index.js';

const IDS = ['search-tavily', 'search-serper', 'search-searxng'];
const manifest = async (/** @type {string} */ id) => JSON.parse(await readFile(new URL(`../../plugins-official/${id}/annai-plugin.json`, import.meta.url), 'utf8'));

/** The plugin as annai gives it its api: its own secrets and settings, and where it registers. */
function host(/** @type {Record<string, any>} */ secrets = {}, /** @type {Record<string, any>} */ settings = {}) {
  /** @type {any} */
  let provider = null;
  const annai = {
    register: (/** @type {string} */ kind, /** @type {any} */ item) => { assert.equal(kind, 'search'); provider = item; return () => {}; },
    secrets: { get: async (/** @type {string} */ n) => secrets[n] ?? null },
    settings: { get: async () => settings },
    helpers: { addressProblem },
  };
  return { annai, get provider() { return provider; } };
}
const never = new AbortController().signal;
const ok = (/** @type {any} */ body, /** @type {number} */ status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the official search plugins have valid manifests: an id, the origins they send to, and a key that is a write-only setting', async () => {
  for (const id of IDS) {
    const m = await manifest(id);
    checkManifest(m);
    assert.equal(m.search.id, m.provides.search[0]);
    assert.equal(m.category, 'tools');
    if (m.search.key) assert.equal(m.settings.properties[m.search.key.setting].writeOnly, true);
  }
  assert.deepEqual(originsOf(await manifest('search-tavily')), ['https://api.tavily.com']);
  assert.deepEqual(originsOf(await manifest('search-serper')), ['https://google.serper.dev']);
  assert.deepEqual(originsOf(await manifest('search-searxng')), []);
});

test('a manifest\'s search is refused when it names no id or kind, an address that is no https origin, or a key that is not write-only', () => {
  const m = { settings: { properties: { key: { type: 'string', writeOnly: true }, plain: { type: 'string' } } } };
  const good = { id: 'x-search', kind: 'web', origins: ['https://api.example.com'], key: { setting: 'key', url: 'https://example.com/keys' } };
  assert.deepEqual(checkSearchDesc(good, m), []);
  const { id: _, ...noId } = good;
  assert.match(checkSearchDesc(noId, m).join(), /id: is required/);
  assert.match(checkSearchDesc({ ...good, kind: 'news' }, m).join(), /kind: must be one of/);
  assert.match(checkSearchDesc({ ...good, origins: ['http://api.example.com'] }, m).join(), /must be an https origin/);
  assert.match(checkSearchDesc({ ...good, origins: ['https://api.example.com/search'] }, m).join(), /must be an https origin/);
  assert.match(checkSearchDesc({ ...good, origins: ['nope'] }, m).join(), /isn't an address/);
  assert.match(checkSearchDesc({ ...good, key: { setting: 'plain' } }, m).join(), /plain must be a writeOnly setting/);
  assert.throws(() => checkManifest({ id: 'x-search', name: 'X', version: '1.0.0', api: 1, search: { ...good, kind: 'news' } }), /its search isn't valid/);
});

test('the install screen says where searches and the key go, and an update that adds an origin is told', async () => {
  const pkg = await inspectPackage(new Map([['annai-plugin.json', new TextEncoder().encode(JSON.stringify(await manifest('search-tavily')))], ['index.js', new TextEncoder().encode('export function activate() {}')]]));
  assert.equal(pkg.search?.id, 'tavily');
  assert.equal(keysNote(pkg), 'Your search words and the key you give it are sent to https://api.tavily.com.');
  assert.equal(keysNote({ search: { origins: [] } }), 'Your search words are sent only to the address you give it.');
  assert.deepEqual(whatItBrings({ code: true, skills: [], personalities: [], search: pkg.search, origins: ['https://api.tavily.com'] }),
    ['Code that runs in annai', 'A search provider for web_search', 'Its searches and key now go to https://api.tavily.com']);
});

test('Tavily, against a stand-in of its API: the bearer key, a JSON body, rows from results[].content; its limits and refusals in words', async () => {
  const h = host({ key: 'tvly-test-key-0000' }, { depth: 'advanced' });
  tavily(h.annai);
  assert.deepEqual(await h.provider.ready(), { ok: true });
  const keyless = host();
  tavily(keyless.annai);
  assert.deepEqual(await keyless.provider.ready(), { ok: false, why: 'needs a key (Settings → Plugins → Tavily Search)' });
  /** @type {any[]} */
  const seen = [];
  // Recorded from Tavily's documentation: POST /search → { query, answer, images, results[{ title, url, content, score, raw_content }], response_time }.
  const api = async (/** @type {string} */ url, /** @type {any} */ init) => {
    seen.push({ url, init });
    if (init.headers.authorization !== 'Bearer tvly-test-key-0000') return ok({ detail: { error: 'Unauthorized: missing or invalid API key.' } }, 401);
    return ok({ query: 'q', answer: null, images: [], results: [{ title: 'Nepenthe', url: 'https://www.nepenthe.com/', content: 'Open daily 11:30am-10:00pm.', score: 0.9, raw_content: null }, { title: 'No content', url: 'https://b.test/', content: null }], response_time: 0.9 });
  };
  const rows = await h.provider.search('nepenthe hours', { fetch: api, signal: never, limit: 5 });
  assert.deepEqual(rows[0], { title: 'Nepenthe', url: 'https://www.nepenthe.com/', snippet: 'Open daily 11:30am-10:00pm.' });
  assert.equal(seen[0].url, 'https://api.tavily.com/search');
  assert.equal(seen[0].init.method, 'POST');
  // Only headers Tavily's preflight allows a web app to send (authorization, content-type).
  assert.deepEqual(Object.keys(seen[0].init.headers).sort(), ['authorization', 'content-type']);
  assert.deepEqual(JSON.parse(seen[0].init.body), { query: 'nepenthe hours', search_depth: 'advanced', max_results: 5, include_answer: false });
  const wrong = host({ key: 'bad' });
  tavily(wrong.annai);
  await assert.rejects(wrong.provider.search('q', { fetch: api, signal: never }), (/** @type {any} */ e) => e.status === 401 && e.message === 'Tavily refused the key');
  for (const s of [432, 433]) await assert.rejects(h.provider.search('q', { fetch: async () => ok({ detail: { error: 'limit' } }, s), signal: never }), (/** @type {any} */ e) => e.status === 429 && /out of credits/.test(e.message));
  assert.deepEqual(await h.provider.search('q', { fetch: async () => new Response('<html>'), signal: never }), []);
});

test('Serper, against a stand-in of its API: X-API-KEY, { q, num }, the answer box then organic[].link; out of credits comes as a limit', async () => {
  const h = host({ key: 'serper-test-key-0000' });
  serper(h.annai);
  assert.deepEqual(await h.provider.ready(), { ok: true });
  /** @type {any[]} */
  const seen = [];
  // Recorded from Serper's documentation: { searchParameters, answerBox{ title, snippet, link }, organic[{ title, link, snippet, position }], relatedSearches }.
  const api = async (/** @type {string} */ url, /** @type {any} */ init) => {
    seen.push({ url, init });
    if (init.headers['x-api-key'] !== 'serper-test-key-0000') return ok({ message: 'Unauthorized. Sign up for a free account.' }, 403);
    return ok({ searchParameters: { q: 'q', type: 'search' }, answerBox: { title: 'Nepenthe hours', snippet: 'Open daily 11:30 AM - 10 PM', link: 'https://www.nepenthe.com/hours' },
      organic: [{ title: 'Nepenthe', link: 'https://www.nepenthe.com/', snippet: 'Restaurant in Big Sur.', position: 1 }], relatedSearches: [{ query: 'x' }] });
  };
  const rows = await h.provider.search('nepenthe hours', { fetch: api, signal: never, limit: 6 });
  assert.deepEqual(rows, [{ title: 'Nepenthe hours', url: 'https://www.nepenthe.com/hours', snippet: 'Open daily 11:30 AM - 10 PM' }, { title: 'Nepenthe', url: 'https://www.nepenthe.com/', snippet: 'Restaurant in Big Sur.' }]);
  assert.equal(seen[0].url, 'https://google.serper.dev/search');
  assert.deepEqual(Object.keys(seen[0].init.headers).sort(), ['content-type', 'x-api-key']); // what Serper's preflight allows
  assert.deepEqual(JSON.parse(seen[0].init.body), { q: 'nepenthe hours', num: 6 });
  const wrong = host({ key: 'bad' });
  serper(wrong.annai);
  await assert.rejects(wrong.provider.search('q', { fetch: api, signal: never }), (/** @type {any} */ e) => e.status === 403 && e.message === 'Serper refused the key');
  await assert.rejects(h.provider.search('q', { fetch: async () => ok({ message: 'Not enough credits', statusCode: 400 }, 400), signal: never }), (/** @type {any} */ e) => e.status === 402 && /out of credits/.test(e.message));
  assert.deepEqual(await h.provider.search('q', { fetch: async () => ok({ organic: 'nope' }), signal: never }), []);
});

/** A stand-in SearXNG: /search?q=…&format=json as its documentation shows, with the CORS header an operator adds. @param {{ json?: boolean }} [o] */
async function searx({ json = true } = {}) {
  /** @type {string[]} */
  const urls = [];
  const server = http.createServer((req, res) => {
    urls.push(req.url ?? '');
    const u = new URL(req.url ?? '/', 'http://x');
    const cors = { 'access-control-allow-origin': 'https://annai.guide' };
    if (u.pathname !== '/search' || u.searchParams.get('format') !== 'json' || !json) return res.writeHead(403, cors).end('Forbidden');
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({
      query: u.searchParams.get('q'), number_of_results: 0, answers: [], suggestions: [], unresponsive_engines: [['qwant', 'CAPTCHA']],
      results: Array.from({ length: 12 }, (_, i) => ({ url: `https://r${i}.test/page`, title: `Result ${i}`, content: `Snippet ${i}`, engine: 'duckduckgo', engines: ['duckduckgo'], score: 1, category: 'general' })),
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return { url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, urls, stop: () => new Promise((r) => server.close(() => r(null))) };
}

test('SearXNG, against a stand-in instance: a plain GET of /search with format=json (no preflight), rows from results[].content, and the address it needs', async () => {
  const s = await searx();
  try {
    const h = host({}, { url: `${s.url}/` });
    searxng(h.annai);
    assert.deepEqual(await h.provider.ready(), { ok: true });
    const rows = await h.provider.search('bixby bridge viewpoint', { fetch, signal: never, limit: 5 });
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0], { title: 'Result 0', url: 'https://r0.test/page', snippet: 'Snippet 0' });
    assert.deepEqual(s.urls, ['/search?q=bixby%20bridge%20viewpoint&format=json']);
    /** @type {[string, RegExp][]} */
    const bad = [['', /address of your instance/], ['search.example.com', /isn't a web address/], ['http://nas.local:8080', /must start with https/]];
    for (const [url, why] of bad) {
      const wrong = host({}, { url });
      searxng(wrong.annai);
      const r = await wrong.provider.ready();
      assert.ok(!r.ok && why.test(r.why), r.why);
    }
  } finally {
    await s.stop();
  }
  // JSON switched off in the instance: told how to turn it on. Not reachable at all: told what to check.
  const off = await searx({ json: false });
  try {
    const h = host({}, { url: off.url });
    searxng(h.annai);
    await assert.rejects(h.provider.search('q', { fetch, signal: never }), (/** @type {any} */ e) => /json under search: formats:/.test(e.message) && e.status === 403);
  } finally {
    await off.stop();
  }
  const h = host({}, { url: off.url });
  searxng(h.annai);
  await assert.rejects(h.provider.search('q', { fetch, signal: never }), (/** @type {any} */ e) => e.kind === 'cors' && /Access-Control-Allow-Origin/.test(e.message));
});

test('a plugin\'s search provider joins the chain before the free services, and the user can switch it off', async () => {
  for (const id of ['tavily', 'serper', 'searxng', 'exa', 'parallel', 'firecrawl', 'wiki']) cooldowns.clear(id);
  const { PluginHost } = await import('../../src/core/plugins.js');
  const { createMemoryStore } = await import('../../src/core/store-memory.js');
  const { Workspace } = await import('../../src/core/workspace.js');
  const { ensureBaseScopes } = await import('../../src/core/scopes.js');
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const plugins = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await plugins.addBuiltin(new URL('../../src/plugins/web/index.js', import.meta.url).href);
  registry.add('search-tavily', 'search', { id: 'tavily', name: 'Tavily', kind: 'web', ready: async () => ({ ok: true }), search: async () => [{ title: 'From Tavily', url: 'https://t.test/', snippet: 's' }] });
  const tool = registry.entries('tool').map((e) => e.item).find((t) => t.name === 'web_search');
  const call = { scope: 'me', trip: null, signal: new AbortController().signal, fetch: async () => { throw new TypeError('Failed to fetch'); } };
  assert.match(await tool.run({ query: 'q' }, call), /From Tavily/);
  await updateAppSettings(ws, { web: { searchOff: ['tavily'] } });
  await assert.rejects(tool.run({ query: 'q' }, call), /Web search didn't work: .*Exa couldn't be reached/);
});
