import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readConfig, saveProvider, diffLayer } from '../../src/core/llm/config.js';
import { createLlm } from '../../src/core/llm/service.js';
import { hostKit } from './package-kit.js';

// Anthropic's files API refuses a browser: its CORS preflight answers 400, "Disallowed CORS origin", with no
// Access-Control-Allow-Origin (checked 2026-11-13; /v1/messages answers 200 with *). So a photo sent with an Anthropic
// model goes in the request, with no upload tried first; a server that does take uploads gets them once its switch is on.

const root = new URL('../../', import.meta.url);
const KEY = 'sk-ant-stand-in-0123456789';
/** A tiny PNG, as a photo part carries it. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** The Anthropic Messages type's tunables as anthropic-messages 0.5.1 had them: what a provider page saved against. */
const OLD = { path: '/v1/messages', version: '2023-06-01', browserAccess: true, beta: '', defaultMaxTokens: 8192, uploads: true };
/** A short streamed reply, as the Messages API sends one. */
const REPLY = [
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A red square.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
].map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`).join('');

/** annai with Anthropic added, its key and recommended roles; every request to Anthropic is recorded. */
async function kit() {
  const k = await hostKit();
  /** @type {{ url: string, body: any }[]} */
  const seen = [];
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = new URL(String(url), 'http://annai.test');
    if (u.origin !== 'https://api.anthropic.com') return new Response(await readFile(new URL(`.${u.pathname}`, root)).catch(() => 'not found'));
    seen.push({ url: String(url), body: init.body });
    if (u.pathname === '/v1/files') return Response.json({ id: 'file_stand_in', expires_at: new Date(Date.now() + 172_800_000).toISOString() });
    if (u.pathname === '/v1/messages') return new Response(REPLY, { headers: { 'content-type': 'text/event-stream' } });
    return new Response('not found', { status: 404 });
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
  const id = await llm.addProvider('provider-anthropic', { key: KEY, roles: 'recommended' });
  const send = () => llm.call({ role: 'main', request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'What is this?' }, { type: 'image', mediaType: 'image/png', data: PNG, hash: 'stand-in-hash' }] }] } });
  /** The photo as the last request sent it. */
  const photo = () => JSON.parse(seen.filter((s) => s.url.endsWith('/v1/messages')).at(-1)?.body).messages[0].content.find((/** @type {any} */ c) => c.type === 'image');
  const files = () => seen.filter((s) => s.url.endsWith('/v1/files')).length;
  /** Saves the chat ability's user layer, as the provider page saves it. @param {any} layer */
  const layer = async (layer) => {
    const rec = (await readConfig(k.ws)).providers[id];
    await saveProvider(k.ws, { ...rec, user: { ...rec.user, abilities: { ...rec.user?.abilities, chat: layer } } });
  };
  const uploading = async () => llm.uploading(Object.values((await readConfig(k.ws)).models).find((m) => m.provider === id)?.id ?? '');
  return { send, photo, files, layer, uploading };
}

test('with Anthropic, a photo goes in the request, and no upload to its files API is tried: the browser is refused there', async () => {
  const k = await kit();
  assert.equal(await k.uploading(), false, 'its size counts as the photo, not an id');
  await k.send();
  assert.equal(k.files(), 0, 'no request to /v1/files');
  assert.deepEqual(k.photo()?.source, { type: 'base64', media_type: 'image/png', data: PNG });
});

test('with Anthropic saved as the page saved it before (the upload switch on, the Tunables saved with it): still no upload', async () => {
  const k = await kit();
  // The page saves what differs from the type's tunables as they were: the switch turned off and on again, and the
  // Tunables (JSON) saved with a beta added, "uploads": true showing in it.
  await k.layer(diffLayer({ tunables: { ...OLD, uploads: true, beta: 'files-api-2025-04-14' } }, { tunables: OLD }));
  await k.send();
  assert.equal(k.files(), 0, 'no request to /v1/files');
  assert.equal(k.photo()?.source?.type, 'base64');
});

test('a server that takes uploads gets them once its switch is on: one upload, then the photo by its id', async () => {
  const k = await kit();
  await k.layer({ tunables: { uploads: true } });
  assert.equal(await k.uploading(), true);
  await k.send();
  await k.send();
  assert.equal(k.files(), 1, 'uploaded once');
  assert.deepEqual(k.photo()?.source, { type: 'file', file_id: 'file_stand_in' });
});
