// OpenRouter photo uploads through annai's model service (spec §4.8, §4.9): on by default for OpenRouter, deleted by annai from
// OpenRouter's own list at start and on coming online (over 48 hours old), and all of them as the key, the address or the provider
// goes, at Erase and when the switch goes off. The stand-in answers in the real API's shapes (test/fakes/openrouter-files.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readConfig, saveProvider, setKey } from '../../src/core/llm/config.js';
import { createLlm } from '../../src/core/llm/service.js';
import { hostKit } from './package-kit.js';
import { SYS } from '../../src/core/scopes.js';
import { openRouterFiles } from '../fakes/openrouter-files.js';

const root = new URL('../../', import.meta.url);
const KEY = 'sk-or-v1-stand-in-0123456789';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HOUR = 3_600_000;
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

/**
 * annai with OpenRouter added (its key, the recommended roles); OpenRouter is the stand-in, other addresses annai's own files.
 * @param {Parameters<typeof openRouterFiles>[0]} [o] @param {string} [plugin]
 */
async function kit(o = {}, plugin = 'provider-openrouter') {
  const k = await hostKit();
  const or = openRouterFiles(o);
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = new URL(String(url), 'http://annai.test');
    if (u.origin === 'https://openrouter.ai' || u.origin === 'https://api.groq.com') return or.fetch(String(url), init);
    return new Response(await readFile(new URL(`.${u.pathname}`, root)).catch(() => 'not found'));
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
  const id = await llm.addProvider(plugin, { key: KEY, roles: 'recommended' });
  const modelId = async () => Object.values((await readConfig(k.ws)).models).find((m) => m.provider === id && m.ability === 'chat' && /haiku|llama/.test(m.template?.values?.providerId ?? m.user?.providerId ?? ''))?.id
    ?? Object.values((await readConfig(k.ws)).models).find((m) => m.provider === id && m.ability === 'chat')?.id ?? '';
  const send = () => llm.call({ role: 'utility', request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'What is this?' }, { type: 'image', mediaType: 'image/png', data: PNG, hash: 'stand-in-hash' }] }] } });
  /** How the last chat request sent the photo: "file" or "image_url". */
  const sentAs = () => or.chats.at(-1)?.messages.flatMap((/** @type {any} */ m) => (Array.isArray(m.content) ? m.content : [])).find((/** @type {any} */ b) => b.type === 'file' || b.type === 'image_url')?.type;
  const ours = () => or.held.filter((f) => f.filename.startsWith('annai-')).map((f) => f.filename);
  /** The same annai started again on this device: a new service over the same store and plugins. */
  const restart = () => createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
  /** Saves the chat ability's switch as the provider page saves it. @param {boolean} on */
  const uploadsSwitch = async (on) => {
    const rec = (await readConfig(k.ws)).providers[id];
    await saveProvider(k.ws, { ...rec, user: { ...rec.user, abilities: { ...rec.user?.abilities, chat: { ...rec.user?.abilities?.chat, tunables: { uploads: on } } } } });
  };
  return { ...k, or, llm, id, modelId, send, sentAs, ours, restart, uploadsSwitch };
}
/** Waits, at most 2 s, for what a background sweep does. @param {() => boolean} done */
const until = async (done) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(done(), 'in time');
};

test('OpenRouter: photo uploads are on by default, the photo goes once and then as a file part by its id', async () => {
  const k = await kit();
  assert.equal(await k.llm.uploading(await k.modelId()), true);
  await k.send();
  await k.send();
  assert.equal(k.or.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/files')).length, 1);
  assert.equal(k.sentAs(), 'file');
  assert.equal(k.or.chats.at(-1).messages.at(-1).content.find((/** @type {any} */ b) => b.type === 'file').file.file_id, k.or.held[0].id);
});

test('another Chat Completions provider sends exactly what it sent before: no switch default, no upload, no sweep', async () => {
  const k = await kit({}, 'provider-groq');
  await k.llm.sweepUploads();
  assert.equal(await k.llm.uploading(await k.modelId()), false);
  assert.equal(k.or.requests.some((r) => new URL(r.url).pathname.endsWith('/files')), false);
});

test('at start and on coming online, annai’s uploads over 48 hours old are deleted from the list; younger ones and other files stay', async () => {
  const now = Date.now();
  const k = await kit({ files: [
    { filename: 'annai-aaaaaaaaaaaaaaaa.webp', created_at: iso(now - 50 * HOUR) },
    { filename: 'annai-bbbbbbbbbbbbbbbb.webp', created_at: iso(now - 2 * HOUR) },
    { filename: 'my-notes.pdf', created_at: iso(now - 500 * HOUR) },
  ] });
  // The service just made has already swept once, before the provider existed: nothing then. Started again, it sweeps.
  k.restart();
  await until(() => k.ours().length === 1);
  assert.deepEqual(k.ours(), ['annai-bbbbbbbbbbbbbbbb.webp']);
  assert.ok(k.or.held.some((f) => f.filename === 'my-notes.pdf'));
  k.or.held.push({ id: 'or_file_old', filename: 'annai-cccccccccccccccc.jpg', created_at: iso(now - 49 * HOUR), mime_type: 'image/jpeg', size_bytes: 1 });
  await k.llm.sweepUploads();
  assert.deepEqual(k.ours(), ['annai-bbbbbbbbbbbbbbbb.webp']);
  // Traced without ids.
  const lines = (await k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS))).filter((e) => e.type === 'net.request' && /^upload-/.test(e.data.kind));
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((e) => !JSON.stringify(e.data).includes('or_file') && !JSON.stringify(e.data).includes(KEY)));
});

test('a list that refuses the key at start sends photos in each request until annai restarts: annai never makes files it can’t delete', async () => {
  let refuse = false;
  const k = await kit({ status: (m, p) => (refuse && m === 'GET' && p === '/files' ? 401 : null) });
  refuse = true;
  await k.llm.sweepUploads();
  await k.send();
  assert.equal(k.sentAs(), 'image_url');
  assert.equal(k.or.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/files')).length, 0);
});

test('a list annai can’t read turns uploads off too; no answer leaves them on, for the next try', async () => {
  const k = await kit({ status: (m, p) => (m === 'GET' && p === '/files' ? 503 : null) });
  await k.llm.sweepUploads();
  await k.send();
  assert.equal(k.sentAs(), 'file', 'a 503 changes nothing');
  let odd = false;
  const o = await kit({ list: (x) => (odd ? { object: 'list', items: x.data } : x) });
  odd = true;
  await o.llm.sweepUploads();
  await o.send();
  assert.equal(o.sentAs(), 'image_url');
});

test('removing OpenRouter deletes every upload of annai’s there with its key, first, and leaves the other files', async () => {
  const k = await kit({ files: [{ filename: 'their-photo.jpg', created_at: iso(Date.now()) }] });
  await k.send();
  k.or.held.push({ id: 'or_file_other_device', filename: 'annai-dddddddddddddddd.webp', created_at: iso(Date.now()), mime_type: 'image/webp', size_bytes: 1 });
  assert.equal(k.ours().length, 2);
  await k.llm.removeProvider(k.id);
  assert.deepEqual(k.ours(), []);
  assert.deepEqual(k.or.held.map((f) => f.filename), ['their-photo.jpg']);
  assert.ok(k.or.requests.filter((r) => r.method === 'DELETE').every((r) => r.headers.authorization === `Bearer ${KEY}`));
});

test('a new key deletes annai’s uploads with the old key first, then forgets their ids: the next photo is uploaded with the new key', async () => {
  const k = await kit();
  await k.send();
  const NEW = 'sk-or-v1-new-key-9876543210';
  await k.llm.reconnect(k.id, () => setKey(k.store, k.id, NEW));
  assert.deepEqual(k.ours(), []);
  assert.equal(k.or.requests.find((r) => r.method === 'DELETE')?.headers.authorization, `Bearer ${KEY}`);
  await k.send();
  const posts = k.or.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/files'));
  assert.equal(posts.length, 2);
  assert.equal(posts[1].headers.authorization, `Bearer ${NEW}`);
  assert.equal(k.sentAs(), 'file');
});

test('a revoked old key at a new key changes nothing for the new one: uploads stay on', async () => {
  let revoked = false;
  const k = await kit({ status: (m, p) => (revoked && m === 'GET' && p === '/files' ? 401 : null) });
  revoked = true;
  await k.llm.reconnect(k.id, () => setKey(k.store, k.id, 'sk-or-v1-new-key-9876543210'));
  revoked = false;
  await k.send();
  assert.equal(k.sentAs(), 'file');
});

test('Erase deletes every upload of annai’s there, beside the kept turns, within its time', async () => {
  const k = await kit();
  await k.send();
  assert.equal(k.ours().length, 1);
  await k.llm.forgetAll({ timeoutMs: 2000 });
  assert.deepEqual(k.ours(), []);
});

test('the switch off deletes them all; one that fails then is deleted at the next start, which takes all while the switch is off', async () => {
  let down = false;
  const k = await kit({ status: (m) => (down && m === 'DELETE' ? 503 : null) });
  await k.send();
  down = true;
  await k.uploadsSwitch(false);
  await k.llm.forgetUploads(`${k.id}/chat`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(k.ours().length, 1, 'not deleted yet: no answer');
  down = false;
  k.restart();
  await until(() => k.ours().length === 0);
  await k.send();
  assert.equal(k.sentAs(), 'image_url', 'off: in the request');
  await k.uploadsSwitch(true);
  await k.send();
  assert.equal(k.sentAs(), 'file');
});

test('Test uploads its photo, finds it in the list and deletes it; a key that can’t delete sends photos in each request', async () => {
  const k = await kit();
  const r = await k.llm.test(await k.modelId());
  const upload = r.steps.find((s) => s.step === 'upload');
  assert.equal(upload?.ok, true, JSON.stringify(r.steps));
  assert.match(upload?.detail ?? '', /deleted the test photo/);
  assert.deepEqual(k.ours(), []);
  const no = await kit({ status: (m) => (m === 'DELETE' ? 403 : null) });
  const r2 = await no.llm.test(await no.modelId());
  const u2 = r2.steps.find((s) => s.step === 'upload');
  assert.equal(u2?.ok, false);
  await no.send();
  assert.equal(no.sentAs(), 'image_url');
});
