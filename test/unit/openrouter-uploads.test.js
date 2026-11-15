// OpenRouter photo uploads (spec §4.8): Chat Completions' upload hooks and file part, its dead-id rule, and the sweep that deletes
// annai's own uploads from the provider's list. The stand-in answers in the real API's shapes (test/fakes/openrouter-files.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../../plugins-official/chat-completions/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { callOnce } from '../../src/core/llm/call.js';
import { Uploads, sweepUploads, OURS, uploadName, TEST_UPLOAD } from '../../src/core/llm/uploads.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { openRouterFiles } from '../fakes/openrouter-files.js';

/** @returns {any} */
function load() {
  /** @type {any} */
  let type = null;
  activate({ providers: { register: (/** @type {any} */ t) => { type = t; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return type;
}
const type = load();
const BASE = 'https://openrouter.ai/api/v1';
/** @param {any} [over] */
const endpoint = (over = {}) => ({ id: 'or-1/chat', provider: 'or-1', ability: 'chat', type: 'chat-completions', name: 'OpenRouter', baseUrl: BASE, headers: { 'X-Title': 'annai' }, tunables: { ...type.tunables, uploads: true }, extraBody: {}, ...over });
/** @param {any} [over] */
const model = (over = {}) => ({ id: 'm-1', provider: 'or-1', ability: 'chat', name: 'Nano', providerId: 'openai/gpt-4.1-nano', input: ['text', 'image'], tools: true, contextWindow: 1000000, maxOutput: 100, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, ...over });
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-14T12:00:00Z');
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
/** A photo the conversation sends. */
const photo = { messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data: 'UklGRgAAAABXRUJQ', hash: 'h1' }, { type: 'text', text: 'What is it?' }] }] };
async function uploadsOf() {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  return new Uploads(ws);
}

test('Chat Completions: uploads start off, and the hooks speak OpenRouter’s files API (the file alone, list pages, deletion by id)', async () => {
  assert.equal(type.tunables.uploads, false);
  const up = type.uploadRequest({ endpoint: endpoint({ baseUrl: `${BASE}/` }), key: 'sk-or-test', bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/webp', name: 'annai-0123456789abcdef.webp', expiresInSeconds: 172_800 });
  assert.equal(up.url, `${BASE}/files`);
  assert.equal(up.headers.authorization, 'Bearer sk-or-test');
  assert.deepEqual([...up.body.keys()], ['file'], 'no purpose or expiry: OpenRouter lists only the file');
  const f = /** @type {File} */ (up.body.get('file'));
  assert.equal(f.name, 'annai-0123456789abcdef.webp');
  assert.equal(f.type, 'image/webp');
  assert.deepEqual(type.readUpload({ _shape: 'openrouter', id: 'or_file_x1', type: 'file', created_at: '2026-11-14T00:00:00Z' }), { id: 'or_file_x1' }, 'no expiry: the core’s 48 hours apply');
  assert.throws(() => type.readUpload({ type: 'file' }));
  const del = type.deleteUploadRequest({ endpoint: endpoint(), key: 'k', id: 'or_file_a/b' });
  assert.deepEqual([del.url, del.method], [`${BASE}/files/or_file_a%2Fb`, 'DELETE']);
  assert.equal(type.listUploadsRequest({ endpoint: endpoint(), key: 'k', cursor: null }).url, `${BASE}/files?limit=1000`);
  assert.equal(type.listUploadsRequest({ endpoint: endpoint(), key: 'k', cursor: 'eyJ+/=' }).url, `${BASE}/files?limit=1000&cursor=eyJ%2B%2F%3D`);
});

test('Chat Completions: a files list is read strictly; a shape it can’t read throws', () => {
  const page = type.readUploads({
    _shape: 'openrouter', has_more: true, cursor: 'c2', first_id: 'a', last_id: 'd',
    data: [
      { _shape: 'openrouter', id: 'a', type: 'file', filename: 'annai-test.png', created_at: '2026-11-14T00:48:52.528Z' },
      { id: 'b', filename: 'notes.pdf', created_at: 1_763_000_000 },
      { id: 'c', filename: 'annai-0000000000000000.webp', created_at: 'yesterday' },
      { id: 7, filename: 'x' }, null, { id: 'd' },
    ],
  });
  assert.deepEqual(page.cursor, 'c2');
  assert.deepEqual(page.files.map((x) => [x.id, x.name]), [['a', 'annai-test.png'], ['b', 'notes.pdf'], ['c', 'annai-0000000000000000.webp']]);
  assert.equal(page.files[0].createdAt, Date.parse('2026-11-14T00:48:52.528Z'));
  assert.equal(page.files[1].createdAt, 1_763_000_000_000, "OpenAI's shape: seconds");
  assert.ok(Number.isNaN(page.files[2].createdAt));
  assert.equal(type.readUploads({ data: [], has_more: false, cursor: 'stale' }).cursor, null, 'the last page has no next');
  assert.throws(() => type.readUploads({ data: [], has_more: true, cursor: null }), 'more pages and no cursor');
  assert.throws(() => type.readUploads({ files: [], has_more: false }));
  assert.throws(() => type.readUploads({ data: [] }));
  assert.throws(() => type.readUploads(null));
});

test('Chat Completions: an uploaded photo goes as a file part by its id; one not uploaded still goes as image_url', () => {
  const parts = [{ type: 'image', mediaType: 'image/webp', data: 'AAAA', fileId: 'or_file_x1' }, { type: 'image', mediaType: 'image/png', data: 'BBBB' }, { type: 'text', text: 'Which?' }];
  const s = { endpoint: endpoint(), model: model(), key: 'k', tunables: endpoint().tunables, request: { messages: [{ role: 'user', parts }] } };
  const content = type.build(s).body.messages[0].content;
  assert.deepEqual(content[0], { type: 'file', file: { file_id: 'or_file_x1' } });
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } });
  // Claude through OpenRouter: the cache marker's block may be the file part.
  const claude = { ...s, model: model({ providerId: 'anthropic/claude-haiku-5.5' }), tunables: { ...s.tunables, cacheMarkers: ['anthropic/'] },
    request: { system: 'Be brief.', cacheTtl: '5m', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Which?' }, parts[0]] }] } };
  assert.deepEqual(type.build(claude).body.messages.at(-1).content.at(-1), { type: 'file', file: { file_id: 'or_file_x1' }, cache_control: { type: 'ephemeral' } });
});

test('Chat Completions: OpenRouter’s "Invalid file_id" is a dead upload, in a response or in the stream; a refusal of the part is not', async () => {
  assert.equal(type.classify(400, JSON.stringify({ error: { message: 'Invalid file_id: or_file_x1', code: 400 } })), 'upload');
  assert.equal(type.classify(400, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid file_id: or_file_x1', error_type: 'invalid_request' } })), 'upload');
  assert.equal(type.classify(404, JSON.stringify({ error: { message: 'The file_id or_file_x1 was not found.' } })), 'upload', 'a rewording still matches');
  assert.equal(type.classify(400, JSON.stringify({ error: { message: 'file_id is not supported for this model', code: 400 } })), null);
  assert.equal(type.classify(400, JSON.stringify({ error: { message: 'Invalid image', code: 400 } })), null);
  assert.equal(type.classify(401, JSON.stringify({ error: { code: 'invalid_api_key', message: 'Invalid file_id' } })), 'auth', 'a code annai knows comes first');
  const s = { endpoint: endpoint(), model: model(), key: 'k', tunables: endpoint().tunables, request: { messages: [] } };
  const stream = `data: ${JSON.stringify({ error: { message: 'Invalid file_id: or_file_x1', code: 400 } })}\n\n`;
  await assert.rejects(async () => { for await (const _ of type.read(new Response(stream), s)); }, (e) => e instanceof ProviderError && e.kind === 'upload');
});

test('a photo is uploaded once, named by the shared rule, and sent by id on later calls; a dead id is an upload error', async () => {
  const or = openRouterFiles({ now: () => NOW });
  const uploads = await uploadsOf();
  const c = { type, endpoint: endpoint(), model: model(), key: 'sk-or-test', request: /** @type {any} */ (photo), fetch: /** @type {any} */ (or.fetch), uploads, now: () => NOW };
  await callOnce(c);
  await callOnce(c);
  assert.equal(or.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/files')).length, 1);
  assert.equal(or.held.length, 1);
  assert.match(or.held[0].filename, OURS);
  assert.deepEqual(or.chats.map((b) => b.messages.at(-1).content[0]), [0, 1].map(() => ({ type: 'file', file: { file_id: or.held[0].id } })));
  // Deleted on OpenRouter's side (another device's sweep): the chat answers 400, which is kind upload (fallback.js uploads it again).
  or.held.splice(0);
  await assert.rejects(callOnce(c), (e) => e instanceof ProviderError && e.kind === 'upload');
  await uploads.forget('or-1/chat');
  await callOnce(c);
  assert.equal(or.held.length, 1, 'uploaded again');
});

test('a Chat Completions provider whose uploads are off sends exactly what it sent before: the photo in the request, nothing uploaded', async () => {
  const or = openRouterFiles();
  const uploads = await uploadsOf();
  await callOnce({ type, endpoint: endpoint({ tunables: { ...type.tunables } }), model: model(), key: 'k', request: /** @type {any} */ (photo), fetch: /** @type {any} */ (or.fetch), uploads });
  assert.deepEqual(or.requests.map((r) => r.method + ' ' + new URL(r.url).pathname), ['POST /api/v1/chat/completions']);
  assert.equal(or.chats[0].messages[0].content[0].type, 'image_url');
});

test('the name rule: what annai uploads matches, and nothing else does', () => {
  assert.equal(uploadName('0123456789abcdef0123', 'image/webp'), 'annai-0123456789abcdef.webp');
  assert.equal(uploadName('0123456789abcdef0123', 'image/avif'), 'annai-0123456789abcdef.bin');
  for (const n of [uploadName('fedcba9876543210ff', 'image/jpeg'), TEST_UPLOAD, 'annai-0123456789abcdef.bin']) assert.match(n, OURS);
  for (const n of ['annai-0123456789ABCDEF.webp', 'annai-0123456789abcde.webp', 'annai-test.png.exe', 'my-annai-0123456789abcdef.webp', 'annai-testing.png', 'annai-0123456789abcdef', 'annai.png']) assert.doesNotMatch(n, OURS);
});

/** A workspace with annai's files of several ages and other apps' files, three to a list page. */
const mixed = () => openRouterFiles({
  page: 3, now: () => NOW,
  files: [
    { filename: 'annai-aaaaaaaaaaaaaaaa.webp', created_at: iso(NOW - 72 * HOUR) },
    { filename: 'trip-report.pdf', created_at: iso(NOW - 90 * HOUR) },
    { filename: 'annai-bbbbbbbbbbbbbbbb.jpg', created_at: iso(NOW - 48 * HOUR - 1) },
    { filename: 'annai-cccccccccccccccc.webp', created_at: iso(NOW - 47 * HOUR) },
    { filename: 'annai-test.png', created_at: iso(NOW - 49 * HOUR) },
    { filename: 'annai-dddddddddddddddd.webp', created_at: 'not a time' },
    { filename: 'annai-photo.webp', created_at: iso(NOW - 100 * HOUR) },
  ],
});

test('the sweep: every page read, annai’s own files over 48 hours old deleted, the rest left; the all form takes annai’s at any age', async () => {
  const or = mixed();
  /** @type {any[]} */
  const traced = [];
  const trace = /** @type {any} */ ({ secret: () => {}, request: (/** @type {any} */ i) => { traced.push(i); } });
  const r = await sweepUploads({ type, endpoint: endpoint(), key: 'sk-or-test', fetch: or.fetch, trace, now: () => NOW });
  assert.deepEqual(r, { outcome: 'done', deleted: 3, left: 0 });
  assert.deepEqual(or.held.map((f) => f.filename), ['trip-report.pdf', 'annai-cccccccccccccccc.webp', 'annai-dddddddddddddddd.webp', 'annai-photo.webp']);
  assert.equal(or.requests.filter((x) => x.method === 'GET').length, 3, 'three pages of three');
  // Traced without ids or cursors, never with the key.
  assert.deepEqual(traced.map((x) => x.kind), ['upload-list', 'upload-list', 'upload-list', 'upload-delete', 'upload-delete', 'upload-delete']);
  for (const x of traced) {
    assert.doesNotMatch(x.url, /or_file|\?|cursor/);
    assert.equal(x.outcome, 'ok');
  }
  assert.ok(traced.some((x) => x.url === `${BASE}/files/…`));
  assert.ok(or.requests.every((x) => x.headers.authorization === 'Bearer sk-or-test'));
  const all = await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: or.fetch, now: () => NOW, all: true });
  assert.deepEqual(all, { outcome: 'done', deleted: 2, left: 0 });
  assert.deepEqual(or.held.map((f) => f.filename), ['trip-report.pdf', 'annai-photo.webp']);
});

test('the sweep: only picks by name (Test’s photo), and a cursor that comes back ends the reading', async () => {
  const or = mixed();
  const r = await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: or.fetch, now: () => NOW, all: true, only: (n) => n === TEST_UPLOAD });
  assert.deepEqual(r, { outcome: 'done', deleted: 1, left: 0 });
  let gets = 0;
  const loop = /** @type {any} */ (async () => { gets++; return new Response(JSON.stringify({ data: [], has_more: true, cursor: 'same' })); });
  assert.deepEqual(await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: loop }), { outcome: 'done', deleted: 0, left: 0 });
  assert.equal(gets, 2);
});

test('the sweep: no files API, a refused key, a list it can’t read, and no answer each say so; deletions that fail are left for the next', async () => {
  const at = (/** @type {(m: string, p: string) => number | null} */ status) => sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: openRouterFiles({ files: mixed().held, status }).fetch, now: () => NOW });
  assert.equal((await at((m, p) => (m === 'GET' && p === '/files' ? 404 : null))).outcome, 'none');
  assert.equal((await at((m, p) => (m === 'GET' && p === '/files' ? 401 : null))).outcome, 'refused');
  assert.equal((await at((m, p) => (m === 'GET' && p === '/files' ? 403 : null))).outcome, 'refused');
  assert.equal((await at((m, p) => (m === 'GET' && p === '/files' ? 503 : null))).outcome, 'unreachable');
  assert.equal((await at((m, p) => (m === 'GET' && p === '/files' ? 429 : null))).outcome, 'unreachable');
  assert.deepEqual(await at((m) => (m === 'DELETE' ? 503 : null)), { outcome: 'unreachable', deleted: 0, left: 3 });
  assert.equal((await at((m) => (m === 'DELETE' ? 403 : null))).outcome, 'refused');
  const odd = /** @type {any} */ (async () => new Response(JSON.stringify({ object: 'list', files: [] })));
  assert.equal((await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: odd })).outcome, 'unreadable');
  const down = /** @type {any} */ (async () => { throw new TypeError('Failed to fetch'); });
  assert.equal((await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: down })).outcome, 'unreachable');
  // A redirect is never followed: no answer.
  const moved = /** @type {any} */ (async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/files' } }));
  assert.equal((await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: moved })).outcome, 'unreachable');
  // A type that keeps files for a while by itself has no list: nothing to sweep.
  assert.equal((await sweepUploads({ type: { ...type, listUploadsRequest: undefined }, endpoint: endpoint(), key: 'k', fetch: down })).outcome, 'none');
});

test('the sweep: requests go only to the endpoint’s own address, and at most 6 deletions at once', async () => {
  const elsewhere = { ...type, listUploadsRequest: () => ({ url: 'https://evil.example/files', headers: {} }) };
  let sent = 0;
  const count = /** @type {any} */ (async () => { sent++; return new Response('{}'); });
  assert.equal((await sweepUploads({ type: elsewhere, endpoint: endpoint(), key: 'k', fetch: count })).outcome, 'unreachable');
  assert.equal(sent, 0);
  const files = Array.from({ length: 20 }, (_, i) => ({ filename: uploadName(i.toString(16).padStart(16, '0'), 'image/webp'), created_at: iso(NOW - 50 * HOUR) }));
  const or = openRouterFiles({ files, now: () => NOW });
  let open = 0;
  let most = 0;
  const slow = /** @type {any} */ (async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    if (init.method !== 'DELETE') return or.fetch(url, init);
    open++;
    most = Math.max(most, open);
    await new Promise((r) => setTimeout(r, 5));
    open--;
    return or.fetch(url, init);
  });
  assert.deepEqual(await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: slow, now: () => NOW }), { outcome: 'done', deleted: 20, left: 0 });
  assert.equal(most, 6);
});
