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
import { Uploads, sweepUploads, deleteUpload, OURS, uploadName, TEST_UPLOAD } from '../../src/core/llm/uploads.js';
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

test('the sweep: a cursor that comes back ends the reading', async () => {
  let gets = 0;
  const loop = /** @type {any} */ (async () => { gets++; return new Response(JSON.stringify({ data: [], has_more: true, cursor: 'same' })); });
  assert.deepEqual(await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: loop }), { outcome: 'done', deleted: 0, left: 0 });
  assert.equal(gets, 2);
});

test('the sweep: a refused key, a list it can’t read (a 404 too: a type that lists must find its list), and no answer each say so; deletions that fail are left for the next', async () => {
  const at = (/** @type {(m: string, p: string) => number | null} */ status) => sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: openRouterFiles({ files: mixed().held, status }).fetch, now: () => NOW });
  assert.equal((await at((m, p) => (m === 'GET' && p === '/files' ? 404 : null))).outcome, 'unreadable');
  assert.equal((await at((m, p) => (m === 'GET' && p === '/files' ? 401 : null))).outcome, 'refused');
  assert.equal((await at((m, p) => (m === 'GET' && p === '/files' ? 403 : null))).outcome, 'refused');
  assert.equal((await at((m, p) => (m === 'GET' && p === '/files' ? 503 : null))).outcome, 'unreachable');
  assert.equal((await at((m, p) => (m === 'GET' && p === '/files' ? 429 : null))).outcome, 'unreachable');
  assert.deepEqual(await at((m) => (m === 'DELETE' ? 503 : null)), { outcome: 'unreachable', deleted: 0, left: 3 });
  assert.equal((await at((m) => (m === 'DELETE' ? 403 : null))).outcome, 'refused');
  const odd = /** @type {any} */ (async () => new Response(JSON.stringify({ object: 'list', files: [] })));
  assert.equal((await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: odd })).outcome, 'unreadable');
  const notJson = /** @type {any} */ (async () => new Response('<html>a captive portal</html>'));
  assert.equal((await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: notJson })).outcome, 'unreadable', 'a body that arrived and is not a list');
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

test('the sweep: a list whose body breaks off on its way, or stalls past the time limit, is no answer (waits), not a list annai can’t read', async () => {
  // What a browser does with a connection that drops after the headers, and with the 15 s limit running out on a body: the read rejects.
  const after = (/** @type {string} */ sent, /** @type {unknown} */ why) => /** @type {any} */ (async () => new Response(new ReadableStream({ start(c) { if (sent) c.enqueue(new TextEncoder().encode(sent)); c.error(why); } }), { status: 200 }));
  assert.deepEqual(await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: after('{"data":[{"id"', new TypeError('network error')) }), { outcome: 'unreachable', deleted: 0, left: 0 });
  assert.equal((await sweepUploads({ type, endpoint: endpoint(), key: 'k', fetch: after('', new DOMException('The operation timed out.', 'TimeoutError')) })).outcome, 'unreachable');
});

test('one upload’s deletion by its id: its status, 0 for no answer, a redirect, another origin or a type that can’t delete; Test’s photo is not found by a list', async () => {
  const or = openRouterFiles({ files: [{ id: 'or_file_one', filename: 'annai-test.png', created_at: iso(NOW) }] });
  const at = (/** @type {string} */ id, /** @type {any} */ f = or.fetch) => deleteUpload({ type, endpoint: endpoint(), key: 'sk-or-test', fetch: f, id });
  assert.equal(await at('or_file_one'), 200);
  assert.equal(or.held.length, 0);
  assert.equal(await at('or_file_one'), 404, 'already gone: the sweep counts it deleted, Test does not');
  assert.deepEqual(or.requests.map((r) => r.method), ['DELETE', 'DELETE'], 'no list');
  assert.equal(or.requests[0].headers.authorization, 'Bearer sk-or-test');
  assert.equal(await at('x', /** @type {any} */ (async () => { throw new TypeError('Failed to fetch'); })), 0);
  assert.equal(await at('x', /** @type {any} */ (async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/files/x' } }))), 0);
  assert.equal(await at('x', /** @type {any} */ (async () => new Response('{}', { status: 503 }))), 503);
  assert.equal(await deleteUpload({ type: { ...type, deleteUploadRequest: () => ({ url: 'https://evil.example/files/x', headers: {}, method: 'DELETE' }) }, endpoint: endpoint(), key: 'k', fetch: /** @type {any} */ (async () => new Response('{}')), id: 'x' }), 0);
  assert.equal(await deleteUpload({ type: { ...type, deleteUploadRequest: undefined }, endpoint: endpoint(), key: 'k', fetch: /** @type {any} */ (or.fetch), id: 'x' }), 0);
});

test('Uploads: an endpoint is off after a failure, and again on for a new key or address (its provider’s id) or a passing Test (its own); one whose provider is going is off while it goes', async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const going = new Set(['pv-3']);
  const uploads = new Uploads(ws, (id) => going.has(id.split('/')[0]));
  for (const e of ['pv-1/chat', 'pv-1/other', 'pv-10/chat']) uploads.off(e);
  uploads.retry('pv-1/chat');
  assert.deepEqual(['pv-1/chat', 'pv-1/other', 'pv-10/chat'].map((e) => uploads.isOff(e)), [false, true, true]);
  uploads.retry('pv-1');
  assert.deepEqual(['pv-1/chat', 'pv-1/other', 'pv-10/chat'].map((e) => uploads.isOff(e)), [false, false, true], 'pv-10 is another provider');
  assert.equal(uploads.isOff('pv-3/chat'), true);
  going.delete('pv-3');
  assert.equal(uploads.isOff('pv-3/chat'), false, 'a change that is over leaves nothing behind');
});

test('Uploads: what a read of the list found is one rule for the sweeps and Test: a refusal is the key’s, a list annai can’t read is the provider’s, which no key or address clears, only a Test that reads it', async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const uploads = new Uploads(ws);
  const r = (/** @type {'done' | 'none' | 'refused' | 'unreadable' | 'unreachable'} */ outcome) => ({ outcome, deleted: 0, left: 0 });
  // A refusal: off, and a new key or address (retry) turns it on again.
  assert.equal(uploads.listed('pv-1/chat', r('refused')), true);
  assert.equal(uploads.isOff('pv-1/chat'), true);
  uploads.retry('pv-1');
  assert.equal(uploads.isOff('pv-1/chat'), false);
  // No answer says nothing.
  assert.equal(uploads.listed('pv-1/chat', r('unreachable')), false);
  assert.equal(uploads.listed('pv-1/chat', null), false);
  assert.equal(uploads.isOff('pv-1/chat'), false);
  // A list annai can't read: off through a new key or address, and through a sweep that reads it again; a Test's read decides.
  assert.equal(uploads.listed('pv-1/chat', r('unreadable')), true);
  uploads.retry('pv-1');
  uploads.retry('pv-1/chat');
  assert.equal(uploads.isOff('pv-1/chat'), true, 'no key or address clears it');
  assert.equal(uploads.listed('pv-1/chat', r('done')), true, 'a sweep that reads it leaves it to a Test or a restart');
  assert.equal(uploads.listed('pv-1/chat', r('unreachable'), { test: true }), true, 'a Test that got no answer has not read it');
  assert.equal(uploads.isOff('pv-1/chat'), true);
  assert.equal(uploads.listed('pv-1/chat', r('done'), { test: true }), false);
  assert.equal(uploads.isOff('pv-1/chat'), false);
  assert.equal(uploads.isOff('pv-2/chat'), false, 'one endpoint’s list is its own');
});

test('an older Chat Completions (0.11: no upload hooks) under OpenRouter’s description, which turns uploads on, sends the photo in the request and is never swept', async () => {
  // provider-openrouter 2.5.0 on chat-completions 0.11 (a page whose plugins updated one at a time): nothing for the core to call.
  const { uploadRequest, readUpload, deleteUploadRequest, listUploadsRequest, readUploads, ...hooks } = type;
  void [uploadRequest, readUpload, deleteUploadRequest, listUploadsRequest, readUploads];
  const old = { ...hooks, tunables: { ...type.tunables } };
  delete old.tunables.uploads;
  const or = openRouterFiles();
  const uploads = await uploadsOf();
  await callOnce({ type: old, endpoint: endpoint({ tunables: { ...old.tunables, uploads: true } }), model: model(), key: 'k', request: /** @type {any} */ (photo), fetch: /** @type {any} */ (or.fetch), uploads });
  assert.deepEqual(or.requests.map((r) => r.method + ' ' + new URL(r.url).pathname), ['POST /api/v1/chat/completions']);
  assert.equal(or.chats[0].messages[0].content[0].type, 'image_url');
  assert.equal((await sweepUploads({ type: old, endpoint: endpoint(), key: 'k', fetch: /** @type {any} */ (or.fetch) })).outcome, 'none');
  assert.equal(or.requests.length, 1, 'no list either');
});
