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
  // The old key is refused while it is let go; the list read with the new key, once it is saved, decides.
  await k.llm.reconnect(k.id, async () => {
    await setKey(k.store, k.id, 'sk-or-v1-new-key-9876543210');
    revoked = false;
  });
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

test('a dead key met at start turns uploads off, and a new key (Sign in again, or typed) turns them on again, with no restart', async () => {
  let dead = true;
  const k = await kit({ status: (m, p) => (dead && m === 'GET' && p === '/files' ? 401 : null) });
  await k.llm.sweepUploads(); // a start, or coming online, with the old key
  await k.send();
  assert.equal(k.sentAs(), 'image_url');
  dead = false;
  await k.llm.reconnect(k.id, () => setKey(k.store, k.id, 'sk-or-v1-new-key-9876543210'));
  await k.send();
  assert.equal(k.sentAs(), 'file');
  assert.equal(await k.llm.uploading(await k.modelId()), true);
});

test('a new address of the ability turns uploads on again too: what failed at the old one says nothing about the new', async () => {
  let dead = true;
  const k = await kit({ status: (m, p) => (dead && m === 'GET' && p === '/files' ? 401 : null) });
  await k.llm.sweepUploads();
  assert.equal(await k.llm.uploading(await k.modelId()), false);
  dead = false;
  await k.llm.reconnect(k.id, async () => {
    const rec = (await readConfig(k.ws)).providers[k.id];
    await saveProvider(k.ws, { ...rec, user: { ...rec.user, abilities: { ...rec.user?.abilities, chat: { ...rec.user?.abilities?.chat, baseUrl: 'https://openrouter.ai/api/v1/' } } } });
  });
  assert.equal(await k.llm.uploading(await k.modelId()), true);
});

test('a key change that fails leaves what it found as it was', async () => {
  const k = await kit({ status: (m, p) => (m === 'GET' && p === '/files' ? 401 : null) });
  await k.llm.sweepUploads();
  await assert.rejects(k.llm.reconnect(k.id, async () => { throw new Error('the store is full'); }), /store is full/);
  assert.equal(await k.llm.uploading(await k.modelId()), false, 'still off: nothing changed');
});

test('a photo sent while the key is changing goes in the request, and the old key’s uploads are deleted with nothing new left behind', async () => {
  const k = await kit();
  await k.send();
  assert.equal(k.ours().length, 1);
  /** @type {string | undefined} */
  let during;
  await k.llm.reconnect(k.id, async () => {
    // The 10 s wait is over and the old key's files are deleted: a turn now is sent whole, to upload nothing there.
    assert.deepEqual(k.ours(), []);
    await k.send();
    during = k.sentAs();
    await setKey(k.store, k.id, 'sk-or-v1-new-key-9876543210');
  });
  assert.equal(during, 'image_url');
  assert.deepEqual(k.ours(), [], 'nothing was uploaded to the old workspace');
  await k.send();
  assert.equal(k.sentAs(), 'file', 'once the new key is saved, uploads go again');
  assert.equal(k.or.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/files')).length, 2);
});

test('a photo sent while the provider is removed, or at Erase, goes in the request', async () => {
  for (const how of ['removed', 'erased']) {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((r) => { release = () => r(undefined); });
    // The list is held back, so the removal or Erase is under way, not done, when the photo is sent.
    const k = await kit({ delay: (m) => (m === 'GET' ? gate : undefined) });
    const going = how === 'removed' ? k.llm.removeProvider(k.id) : k.llm.forgetAll({ timeoutMs: 2000 });
    await until(() => k.or.requests.some((r) => r.method === 'GET'));
    await k.send();
    assert.equal(k.sentAs(), 'image_url', how);
    assert.equal(k.or.requests.some((r) => r.method === 'POST' && r.url.endsWith('/files')), false, how);
    release();
    await going;
    assert.deepEqual(k.ours(), [], how);
  }
});

test('Test’s delete is by the id its upload gave: a 404 for that file, or a refusal, turns uploads off; no answer, a 408, a 429 or a server error turns nothing off and leaves the photo for the sweep', async () => {
  const stepOf = async (/** @type {Awaited<ReturnType<typeof kit>>} */ k) => (await k.llm.test(await k.modelId())).steps.find((s) => s.step === 'upload');
  // 404: annai can't delete there.
  const gone = await kit({ status: (m) => (m === 'DELETE' ? 404 : null) });
  const s404 = await stepOf(gone);
  assert.equal(s404?.ok, false);
  assert.match(s404?.detail ?? '', /couldn't delete the test photo with this key.*send photos in each request/);
  await gone.send();
  assert.equal(gone.sentAs(), 'image_url');
  // A refusal, as before.
  const no = await kit({ status: (m) => (m === 'DELETE' ? 401 : null) });
  assert.equal((await stepOf(no))?.ok, false);
  await no.send();
  assert.equal(no.sentAs(), 'image_url');
  // Transient: nothing turned off, the photo stays, and the sweep deletes it with the others after 48 hours.
  for (const code of [503, 429, 500, 408, 0]) {
    const k = await kit({ status: (m) => (m === 'DELETE' ? code : null) });
    const s = await stepOf(k);
    assert.equal(s?.ok, false, `${code}`);
    assert.match(s?.detail ?? '', /couldn't check just now that it can delete the test photo/);
    assert.doesNotMatch(s?.detail ?? '', /in each request/);
    assert.deepEqual(k.ours(), ['annai-test.png']);
    await k.send();
    assert.equal(k.sentAs(), 'file', `${code}: uploads stay on`);
    assert.equal(k.or.requests.filter((r) => r.method === 'GET').length, 0, 'no list: it deletes by id');
  }
});

test('Test is not fooled by a file in the list: it deletes what it uploaded, and only that', async () => {
  const k = await kit({ files: [{ filename: 'annai-test.png', created_at: iso(Date.now()) }] });
  const before = k.or.held.map((f) => f.id);
  const s = (await k.llm.test(await k.modelId())).steps.find((x) => x.step === 'upload');
  assert.equal(s?.ok, true);
  assert.deepEqual(k.or.held.map((f) => f.id), before, 'another device’s test photo is not touched; its own is deleted');
});

test('a Test that passes turns uploads on again where a refused list at start had turned them off, and Test then says what is true', async () => {
  let dead = true;
  const k = await kit({ status: (m, p) => (dead && m === 'GET' && p === '/files' ? 401 : null) });
  await k.llm.sweepUploads();
  await k.send();
  assert.equal(k.sentAs(), 'image_url');
  dead = false;
  const step = (await k.llm.test(await k.modelId())).steps.find((s) => s.step === 'upload');
  assert.equal(step?.ok, true);
  await k.send();
  assert.equal(k.sentAs(), 'file', 'Test said uploads work, and they do');
  // One that fails turns them off, as before.
  const no = await kit({ status: (m) => (m === 'DELETE' ? 403 : null) });
  await no.llm.test(await no.modelId());
  assert.equal(await no.llm.uploading(await no.modelId()), false);
});

test('a list annai can’t read keeps uploads off through a new key and a new address: the list read with the new ones decides, and no key means nothing is tried', async () => {
  let odd = true;
  const k = await kit({ list: (x) => (odd ? { object: 'list', items: x.data } : x) });
  await k.llm.sweepUploads(); // a start: the list is a shape annai can't read
  assert.equal(await k.llm.uploading(await k.modelId()), false);
  await k.llm.reconnect(k.id, () => setKey(k.store, k.id, 'sk-or-v1-new-key-9876543210'));
  assert.equal(await k.llm.uploading(await k.modelId()), false, 'a new key: the new key reads the same list');
  await k.send();
  assert.equal(k.sentAs(), 'image_url');
  assert.deepEqual(k.ours(), [], 'nothing made that no sweep can find');
  await k.llm.reconnect(k.id, async () => {
    const rec = (await readConfig(k.ws)).providers[k.id];
    await saveProvider(k.ws, { ...rec, user: { ...rec.user, abilities: { ...rec.user?.abilities, chat: { ...rec.user?.abilities?.chat, baseUrl: 'https://openrouter.ai/api/v1/' } } } });
  });
  assert.equal(await k.llm.uploading(await k.modelId()), false, 'a new address: the same');
  // The list can be read again: the next new key reads it, and uploads are on.
  odd = false;
  await k.llm.reconnect(k.id, () => setKey(k.store, k.id, 'sk-or-v1-another-key-1122334455'));
  assert.equal(await k.llm.uploading(await k.modelId()), true);
  await k.send();
  assert.equal(k.sentAs(), 'file');
  // Remove key: nothing is retried, and no photo goes up with no key.
  await k.llm.reconnect(k.id, () => setKey(k.store, k.id, null));
  const posts = k.or.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/files')).length;
  await k.send();
  assert.equal(k.or.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/files')).length, posts, 'no upload without a key');
  assert.equal(k.sentAs(), 'image_url');
});

test('Remove key does not turn uploads back on where a refused list had turned them off', async () => {
  let dead = true;
  const k = await kit({ status: (m, p) => (dead && m === 'GET' && p === '/files' ? 401 : null) });
  await k.llm.sweepUploads();
  assert.equal(await k.llm.uploading(await k.modelId()), false);
  dead = false;
  await k.llm.reconnect(k.id, () => setKey(k.store, k.id, null));
  assert.equal(await k.llm.uploading(await k.modelId()), false, 'still off: nothing was asked of a list with no key');
  await k.send();
  assert.equal(k.or.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/files')).length, 0);
});

test('a Test that finds the list unreadable (or refused) leaves uploads off and says so; one that can read it turns them on', async () => {
  let odd = false;
  const k = await kit({ list: (x) => (odd ? { object: 'list', items: x.data } : x) });
  odd = true;
  const bad = (await k.llm.test(await k.modelId())).steps.find((s) => s.step === 'upload');
  assert.equal(bad?.ok, false);
  assert.match(bad?.detail ?? '', /can't read the list of its photos there/);
  assert.match(bad?.detail ?? '', /send photos in each request/);
  assert.deepEqual(k.ours(), [], 'the test photo is deleted by its id all the same');
  assert.equal(await k.llm.uploading(await k.modelId()), false);
  await k.send();
  assert.equal(k.sentAs(), 'image_url');
  odd = false;
  const good = (await k.llm.test(await k.modelId())).steps.find((s) => s.step === 'upload');
  assert.equal(good?.ok, true);
  assert.equal(await k.llm.uploading(await k.modelId()), true);
  // A list refused to a key that can upload and delete by id does the same.
  let refuse = false;
  const r = await kit({ status: (m, p) => (refuse && m === 'GET' && p === '/files' ? 403 : null) });
  refuse = true;
  const step = (await r.llm.test(await r.modelId())).steps.find((s) => s.step === 'upload');
  assert.equal(step?.ok, false);
  assert.match(step?.detail ?? '', /can't read the list of its photos there/);
  assert.equal(await r.llm.uploading(await r.modelId()), false);
  // A list with no answer says nothing about it: nothing is turned off.
  const n = await kit({ status: (m, p) => (m === 'GET' && p === '/files' ? 503 : null) });
  assert.equal((await n.llm.test(await n.modelId())).steps.find((s) => s.step === 'upload')?.ok, true);
  assert.equal(await n.llm.uploading(await n.modelId()), true);
});

test('a photo whose upload is answered after a key change began is deleted at once, and goes in the request', async () => {
  /** @type {() => void} */
  let open = () => {};
  const gate = new Promise((r) => { open = () => r(undefined); });
  const k = await kit({ delay: (m, p) => (m === 'POST' && p === '/files' ? gate : undefined) });
  const sending = k.send();
  await until(() => k.or.requests.some((r) => r.method === 'POST' && r.url.endsWith('/files')));
  await k.llm.reconnect(k.id, async () => {
    // The upload is answered while the key is changing: its file would stay in the workspace being let go.
    open();
    await sending;
    await setKey(k.store, k.id, 'sk-or-v1-new-key-9876543210');
  });
  assert.equal(k.sentAs(), 'image_url', 'the photo went in the request');
  assert.deepEqual(k.ours(), [], 'the file was deleted by its id');
  assert.equal(k.or.requests.filter((r) => r.method === 'DELETE').length, 1);
  await k.send();
  assert.equal(k.sentAs(), 'file', 'once the new key is saved, uploads go again');
});

test('two releases at once: the first to end does not end the other’s hold; one that fails ends only its own', async () => {
  /** @type {() => void} */
  let open = () => {};
  const gate = new Promise((r) => { open = () => r(undefined); });
  const k = await kit();
  const slow = k.llm.reconnect(k.id, async () => { await gate; await setKey(k.store, k.id, 'sk-or-v1-new-key-9876543210'); });
  await until(() => k.or.requests.length > 0);
  await k.llm.reconnect(k.id, async () => {}); // a second, which ends first
  assert.equal(await k.llm.uploading(await k.modelId()), false, 'the first is still going');
  await k.send();
  assert.equal(k.sentAs(), 'image_url');
  assert.deepEqual(k.ours(), []);
  open();
  await slow;
  assert.equal(await k.llm.uploading(await k.modelId()), true);
  // A release that fails leaves the provider as it was, and uploads going again.
  await assert.rejects(k.llm.reconnect(k.id, async () => { throw new Error('the store is full'); }), /store is full/);
  assert.equal(await k.llm.uploading(await k.modelId()), true);
});

test('Test makes no photo of its own while the provider’s uploads are going', async () => {
  /** @type {() => void} */
  let open = () => {};
  const gate = new Promise((r) => { open = () => r(undefined); });
  // Only the removal's own list read is held back, so a Test that goes on regardless fails here and doesn't hang.
  let first = true;
  const k = await kit({ delay: (m) => { if (m !== 'GET' || !first) return undefined; first = false; return gate; } });
  const going = k.llm.removeProvider(k.id);
  await until(() => k.or.requests.some((r) => r.method === 'GET'));
  const r = await k.llm.test(await k.modelId());
  assert.equal(r.steps.some((s) => s.step === 'upload'), false, 'no upload step');
  assert.equal(k.or.requests.some((x) => x.method === 'POST' && x.url.endsWith('/files')), false);
  open();
  await going;
});
