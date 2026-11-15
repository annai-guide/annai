// Opt-in: talks to the real providers with your own keys, a few tokens each (spec §18). Never in CI.
//   ANNAI_LIVE_OPENROUTER_KEY=sk-or-… ANNAI_LIVE_ANTHROPIC_KEY=sk-ant-… npm run test:live
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate as chat } from '../../plugins-official/chat-completions/index.js';
import { activate as anthropic } from '../../plugins-official/anthropic-messages/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { callOnce } from '../../src/core/llm/call.js';
import { testModel } from '../../src/core/llm/check.js';
import { readFile } from 'node:fs/promises';
import { Uploads, sweepUploads, OURS } from '../../src/core/llm/uploads.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { toBase64 } from '../../src/core/bytes.js';
import { createMemoryStore } from '../fakes/store-memory.js';

/** @param {(annai: any) => unknown} activate @returns {any} */
function load(activate) {
  /** @type {any} */
  let t = null;
  activate({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'live' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return t;
}
const model = (/** @type {any} */ over) => ({ id: 'live', provider: 'live', ability: 'chat', name: 'live', input: ['text', 'image'], tools: true, contextWindow: null, maxOutput: null, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, ...over });
const orType = load(chat);
const anType = load(anthropic);
const cases = [
  {
    env: 'ANNAI_LIVE_OPENROUTER_KEY', type: orType,
    endpoint: { id: 'live-or/chat', provider: 'live-or', ability: 'chat', type: 'chat-completions', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: { 'X-Title': 'annai tests' }, tunables: { ...orType.tunables, reasoningField: 'reasoning' }, extraBody: {} },
    model: model({ providerId: 'anthropic/claude-haiku-5.5', reasoning: { low: { reasoning: { effort: 'low' } } } }),
  },
  {
    env: 'ANNAI_LIVE_ANTHROPIC_KEY', type: anType,
    endpoint: { id: 'live-an/chat', provider: 'live-an', ability: 'chat', type: 'anthropic-messages', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', headers: {}, tunables: { ...anType.tunables }, extraBody: {} },
    model: model({ providerId: 'claude-haiku-5-5', reasoning: { off: { thinking: { type: 'disabled' } } } }),
  },
];

for (const c of cases) {
  const key = process.env[c.env];
  const skip = key ? false : `${c.env} is not set`;
  test(`${c.endpoint.name}: the Test button passes against the real API`, { skip }, async () => {
    const r = await testModel({ type: c.type, endpoint: c.endpoint, model: c.model, key: key ?? null });
    assert.equal(r.ok, true, JSON.stringify(r.steps));
  });
  test(`${c.endpoint.name}: a reply streams in, with usage`, { skip }, async () => {
    /** @type {string[]} */
    const pieces = [];
    const reply = await callOnce({
      type: c.type, endpoint: c.endpoint, model: c.model, key: key ?? null, level: 'off',
      request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Count from 1 to 20, separated by spaces.' }] }], maxOutput: 300 },
      onEvent: (e) => { if (e.type === 'text') pieces.push(e.text); },
    });
    assert.ok(pieces.length > 1, 'the text arrived in pieces');
    assert.match(reply.text, /20/);
    assert.ok(reply.usage.output > 0);
  });
  test(`${c.endpoint.name}: a wrong key is a key problem`, { skip }, async () => {
    await assert.rejects(callOnce({ type: c.type, endpoint: c.endpoint, model: c.model, key: 'sk-wrong-0000000000000000', request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }], maxOutput: 16 } }),
      (e) => e instanceof ProviderError && e.kind === 'auth');
  });
  test(`${c.endpoint.name}: the model list`, { skip }, async () => {
    const r = c.type.listRequest({ endpoint: c.endpoint, key });
    const res = await fetch(r.url, { headers: r.headers });
    assert.equal(res.status, 200);
    assert.ok(c.type.readList(await res.json()).some((/** @type {any} */ m) => m.providerId === c.model.providerId));
  });
}

// OpenRouter's files (spec §4.8): photos uploaded once and sent by id as a file part, and deleted by annai from the workspace's list.
// The pictures carry made-up text, so a model that quotes it saw the picture. Each case cleans up what it uploaded.
{
  const key = process.env.ANNAI_LIVE_OPENROUTER_KEY;
  const skip = key ? false : 'ANNAI_LIVE_OPENROUTER_KEY is not set';
  const or = cases[0];
  const ep = { ...or.endpoint, id: 'live-or/files', tunables: { ...orType.tunables, reasoningField: 'reasoning', uploads: true } };
  const picture = async (/** @type {string} */ name) => toBase64(new Uint8Array(await readFile(new URL(`../fixtures/llm/files/${name}`, import.meta.url))));
  const uploadsHere = async () => {
    const ws = new Workspace(createMemoryStore());
    await ensureBaseScopes(ws);
    return new Uploads(ws);
  };
  /** @param {string} data @param {string} mediaType @param {string} hash */
  const ask = (data, mediaType, hash) => ({ messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('image'), mediaType, data, hash }, { type: /** @type {const} */ ('text'), text: 'What text does the picture say? Quote it exactly, and nothing else.' }] }], maxOutput: 400 });
  const tokens = (/** @type {any} */ u) => (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
  /** annai's own files in the key's workspace. */
  const ours = async () => {
    const r = orType.listUploadsRequest({ endpoint: ep, key, cursor: null });
    const page = orType.readUploads(await (await fetch(r.url, { headers: r.headers })).json());
    return page.files.filter((/** @type {any} */ f) => OURS.test(f.name));
  };
  const cleanUp = () => sweepUploads({ type: orType, endpoint: ep, key: key ?? null, fetch: (u, i) => fetch(u, i), all: true });

  test('OpenRouter files: Test uploads its photo and deletes it by the id the upload gave, with this key', { skip }, async () => {
    /** @type {string[]} */
    const off = [];
    const r = await testModel({ type: orType, endpoint: ep, model: model({ providerId: 'openai/gpt-4.1-nano' }), key: key ?? null, uploads: /** @type {any} */ ({ off: (/** @type {string} */ x) => off.push(x), retry: () => {} }) });
    const step = r.steps.find((s) => s.step === 'upload');
    assert.equal(step?.ok, true, JSON.stringify(r.steps));
    assert.match(step?.detail ?? '', /deleted the test photo/);
    assert.deepEqual(off, []);
    assert.deepEqual((await ours()).filter((f) => f.name === 'annai-test.png'), []);
  });

  for (const providerId of ['openai/gpt-4.1-nano', 'anthropic/claude-haiku-5.5', 'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free']) {
    test(`OpenRouter files: ${providerId} reads a photo sent by id as it reads it inline, for no more tokens`, { skip }, async (t) => {
      const data = await picture('made-up-sign.webp');
      const m = model({ providerId });
      // A free model can take long to start on a busy day: Test's minute, and more.
      const firstOutputMs = 120_000;
      const inline = await callOnce({ type: orType, endpoint: { ...ep, tunables: { ...ep.tunables, uploads: false } }, model: m, key: key ?? null, request: ask(data, 'image/webp', 'live-sign'), firstOutputMs });
      const uploads = await uploadsHere();
      /** @type {string[]} */
      const sent = [];
      const watch = /** @type {any} */ ((/** @type {string} */ u, /** @type {any} */ i) => { if (u.endsWith('/chat/completions')) sent.push(String(i.body)); return fetch(u, i); });
      try {
        const byId = await callOnce({ type: orType, endpoint: ep, model: m, key: key ?? null, request: ask(data, 'image/webp', 'live-sign'), uploads, fetch: watch, firstOutputMs });
        t.diagnostic(`${providerId}: inline ${tokens(inline.usage)} prompt tokens ($${inline.usage.cost ?? '?'}), by id ${tokens(byId.usage)} ($${byId.usage.cost ?? '?'}); said inline ${JSON.stringify(inline.text.slice(0, 40))}, by id ${JSON.stringify(byId.text.slice(0, 40))}`);
        assert.match(sent[0], /"type":"file","file":\{"file_id":"or_file_/);
        assert.ok(!sent[0].includes(data.slice(0, 40)), 'the photo itself is not in the request');
        assert.match(inline.text, /LYCHEE\s*9T27/i);
        assert.match(byId.text, /LYCHEE\s*9T27/i);
        assert.ok(tokens(byId.usage) <= tokens(inline.usage) * 1.05, 'by id costs no more than inline');
      } finally {
        await cleanUp();
      }
    });
  }

  test('OpenRouter files: Claude’s cache marks on a file part are taken, and the second call reads the cache', { skip }, async (t) => {
    const data = await picture('made-up-text.png');
    const m = model({ providerId: 'anthropic/claude-haiku-5.5', cacheTtls: ['5m'] });
    const marked = { ...ep, tunables: { ...ep.tunables, cacheMarkers: ['anthropic/'] } };
    // Past the smallest prompt Claude caches (4096 tokens for Haiku): a long system text of plain words.
    const system = `You read pictures for a travel app. ${'Answer only with the text the picture shows, exactly as written, with no other words. '.repeat(260)}`;
    const uploads = await uploadsHere();
    const request = { ...ask(data, 'image/png', 'live-text'), system, cacheTtl: /** @type {const} */ ('5m') };
    try {
      const first = await callOnce({ type: orType, endpoint: marked, model: m, key: key ?? null, request, uploads });
      const second = await callOnce({ type: orType, endpoint: marked, model: m, key: key ?? null, request, uploads });
      t.diagnostic(`first: written ${first.usage.cacheWrite}, read ${first.usage.cacheRead}; second: written ${second.usage.cacheWrite}, read ${second.usage.cacheRead}; costs $${first.usage.cost ?? '?'} and $${second.usage.cost ?? '?'}`);
      assert.match(second.text, /KUMQUAT\s*5R83/i);
      assert.ok(second.usage.cacheRead > 0, 'the second call read the cache');
    } finally {
      await cleanUp();
    }
  });

  // The list's paging was never seen for real (the real checks of 2026-11-14 listed one file): two of annai's files, listed with the smallest
  // page OpenRouter's schema allows (limit 1 to 1000), read across the pages by annai's own sweep.
  test('OpenRouter files: two of annai’s files listed one to a page are read across the pages and deleted', { skip }, async () => {
    const small = { ...orType, listUploadsRequest: (/** @type {any} */ c) => { const r = orType.listUploadsRequest(c); return { ...r, url: r.url.replace('limit=1000', 'limit=1') }; } };
    const bytes = new Uint8Array(await readFile(new URL('../fixtures/llm/files/made-up-text.png', import.meta.url)));
    let lists = 0;
    const counting = /** @type {any} */ ((/** @type {string} */ u, /** @type {any} */ i) => { if (!i?.method || i.method === 'GET') lists++; return fetch(u, i); });
    try {
      for (const name of ['annai-aaaaaaaaaaaaaaaa.png', 'annai-bbbbbbbbbbbbbbbb.png']) {
        const up = orType.uploadRequest({ endpoint: ep, key, bytes, mediaType: 'image/png', name, expiresInSeconds: 3600 });
        const res = await fetch(up.url, { method: 'POST', headers: up.headers, body: up.body });
        assert.equal(res.status, 200, `uploading ${name}`);
      }
      const first = small.listUploadsRequest({ endpoint: ep, key, cursor: null });
      const page = orType.readUploads(await (await fetch(first.url, { headers: first.headers })).json());
      assert.equal(page.files.length, 1, 'one file to a page: OpenRouter takes limit=1');
      assert.ok(page.cursor, 'and says there is another page');
      const swept = await sweepUploads({ type: small, endpoint: ep, key: key ?? null, fetch: counting, all: true });
      assert.equal(swept.outcome, 'done');
      assert.ok(swept.deleted >= 2, 'both, whatever else of annai’s the workspace held');
      assert.ok(lists >= 2, 'a page for each of the two');
      assert.deepEqual(await ours(), []);
    } finally {
      await cleanUp();
    }
  });

  test('OpenRouter files: a dead id is an upload error, and uploading again answers', { skip }, async () => {
    const data = await picture('made-up-text.png');
    const m = model({ providerId: 'openai/gpt-4.1-nano' });
    const uploads = await uploadsHere();
    try {
      await callOnce({ type: orType, endpoint: ep, model: m, key: key ?? null, request: ask(data, 'image/png', 'live-dead'), uploads });
      const [mine] = await ours();
      assert.ok(mine, 'uploaded and listed');
      const d = orType.deleteUploadRequest({ endpoint: ep, key, id: mine.id });
      assert.equal((await fetch(d.url, { method: d.method, headers: d.headers })).status, 200);
      await assert.rejects(callOnce({ type: orType, endpoint: ep, model: m, key: key ?? null, request: ask(data, 'image/png', 'live-dead'), uploads }), (e) => e instanceof ProviderError && e.kind === 'upload');
      await uploads.forget(ep.id); // what the fallback does for kind upload (spec §9.9)
      const again = await callOnce({ type: orType, endpoint: ep, model: m, key: key ?? null, request: ask(data, 'image/png', 'live-dead'), uploads });
      assert.match(again.text, /KUMQUAT\s*5R83/i);
    } finally {
      await cleanUp();
      assert.deepEqual(await ours(), [], 'nothing of annai’s left in the workspace');
    }
  });
}
