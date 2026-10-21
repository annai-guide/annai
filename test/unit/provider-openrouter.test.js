import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readConfig, modelOf, getKey, saveRoles, STAND_INS } from '../../src/core/llm/config.js';
import { createLlm } from '../../src/core/llm/service.js';
import { speechBehind } from '../../src/core/llm/providers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';
import { setupUi } from '../../src/ui/provider-setup.js';
import { hostKit } from './package-kit.js';
import { AUTH_URL, KEYS_URL, signInUrl, codeSignIn, tapCode, exchange, freeLimit, openRouter } from '../../plugins-official/provider-openrouter/index.js';

// Sign in with OpenRouter is OpenRouter's plugin's own setup (milestone 4): OAuth with PKCE, a code to paste on
// an iPhone Home Screen app, one provider with one key for chat, transcription and voice, its speech models
// behind the phone's own (the user, 2026-10-18), and its free-model limit read as too many requests.
// OpenRouter is stood in for: no request leaves this test.

const root = new URL('../../', import.meta.url);
const KEY = 'sk-or-v1-stand-in-key-0123456789abcdef';
const WAV = encodeWav(new Float32Array(1600), 16000);

/** A Storage-like map. */
function memoryStorage() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return { getItem: (/** @type {string} */ k) => m.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, v); }, removeItem: (/** @type {string} */ k) => { m.delete(k); }, m };
}
/** @param {Uint8Array} b */
const b64url = (b) => Buffer.from(b).toString('base64url');
/** The sign-in waiting in storage. @param {any} storage */
const saved = (storage) => JSON.parse(/** @type {string} */ (storage.getItem('annai.openrouter')));

/** OpenRouter's lists, by what the models put out, as its /models answers with output_modalities. */
const LISTS = /** @type {Record<string, any[]>} */ ({
  transcription: [{ id: 'openai/whisper-large-v3-turbo', name: 'OpenAI: Whisper Large V3 Turbo' }],
  speech: [{ id: 'x-ai/grok-voice-tts-1.0', name: 'SpaceXAI: Grok Voice TTS 1.0' }],
  text: [{ id: 'google/gemma-4-31b-it:free', name: 'Google: Gemma 4 31B (free)' }],
});

/**
 * A device with annai's model service, its official plugins installed on demand from this repository, and a
 * stand-in OpenRouter. chat: what its chat completions answer.
 */
async function device({ chat = /** @type {() => Response} */ (() => new Response('not found', { status: 404 })) } = {}) {
  const k = await hostKit();
  /** @type {{ url: string, headers: Record<string, string> }[]} */
  const seen = [];
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = new URL(String(url), 'http://annai.test');
    if (u.origin !== 'https://openrouter.ai') {
      try {
        return new Response(await readFile(new URL(`.${u.pathname}`, root)));
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
    const headers = { ...(init.headers ?? {}) };
    seen.push({ url: String(url), headers });
    if (headers.authorization !== `Bearer ${KEY}`) return Response.json({ error: { code: 401, message: 'No cookie auth credentials found' } }, { status: 401 });
    if (u.pathname === '/api/v1/audio/transcriptions') return Response.json({ text: ' Where should we stop for lunch? ', usage: { seconds: 2, cost: 0.0000067 } });
    if (u.pathname === '/api/v1/audio/speech') return new Response(new Uint8Array([0xff, 0xf3, 1, 2]), { headers: { 'content-type': 'audio/mpeg' } });
    if (u.pathname === '/api/v1/models') return Response.json({ data: LISTS[u.searchParams.get('output_modalities') ?? 'text'] ?? [] });
    if (u.pathname === '/api/v1/chat/completions') return chat();
    return new Response('not found', { status: 404 });
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
  /** @type {any[]} */
  const cards = [];
  /** @type {number[]} */
  const renders = [];
  const ctx = { llm, ws: k.ws, store: k.store, registry: k.registry, plugins: k.host, go: () => {}, render: () => renders.push(1), notices: { card: (/** @type {any} */ c) => cards.push(c), toast: () => {} } };
  return { ...k, llm, ctx, cards, renders, seen };
}

/**
 * Signs in as OpenRouter's callback comes back: the plugin's setup takes annai's address with the code.
 * @param {Awaited<ReturnType<typeof device>>} d @param {{ provider?: string | null, keys?: () => Promise<Response> }} [o]
 */
async function signIn(d, { provider = null, keys = async () => new Response(JSON.stringify({ key: KEY })) } = {}) {
  const storage = memoryStorage();
  const url = new URL(await signInUrl({ callback: 'https://annai.guide/', provider, storage }));
  const setup = openRouter({ storage, fetch: keys, card: (c) => d.cards.push(c) });
  await setup.returned(new URLSearchParams(`?code=abc&state=${url.searchParams.get('state')}`), setupUi(d.ctx, 'provider-openrouter'));
  return storage;
}

/** Every text annai keeps: files, log entries and stored content. @param {any} store */
const everything = (store) => store.tx(['files', 'events', 'blobs', 'scopes'], 'readonly', async (/** @type {any} */ t) => {
  const out = [];
  for (const s of await t.listScopes()) out.push(JSON.stringify(await t.listFiles(s.id)), JSON.stringify(await t.listEvents(s.id)));
  for (const b of await t.listBlobs()) out.push(new TextDecoder().decode(new Uint8Array((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0))));
  return out.join('\n');
});

/** The OpenRouter provider, and the models of one of its abilities by provider id. @param {import('../../src/core/llm/config.js').ModelConfig} cfg @param {string} ability */
function made(cfg, ability) {
  const p = Object.values(cfg.providers).find((x) => x.plugin === 'provider-openrouter');
  assert.ok(p, 'no OpenRouter provider');
  return { id: p.id, models: Object.fromEntries(Object.values(cfg.models).filter((m) => m.provider === p.id && m.ability === ability).map((m) => [modelOf(m).providerId, m.id])) };
}

test("OpenRouter's Claude models don't ask for a required tool call: OpenRouter passes \"required\" on as Anthropic's any, which Claude refuses (review A1)", async () => {
  const desc = JSON.parse(await readFile(new URL('plugins-official/provider-openrouter/annai-plugin.json', root), 'utf8'));
  const chat = desc.provider.abilities.chat.models;
  for (const m of chat) assert.equal(m.tunables?.requireTool === false, m.providerId.startsWith('anthropic/'), m.providerId);
});

test('the sign-in address carries a PKCE challenge of the stored verifier, and a state (spec §9.8)', async () => {
  const storage = memoryStorage();
  const url = new URL(await signInUrl({ callback: 'https://annai.guide/', storage, now: 1000 }));
  assert.equal(`${url.origin}${url.pathname}`, AUTH_URL);
  const s = saved(storage);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.verifier)));
  assert.equal(url.searchParams.get('code_challenge'), b64url(digest));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('callback_url'), 'https://annai.guide/');
  assert.equal(url.searchParams.get('state'), s.state);
  assert.equal(url.searchParams.get('key_label'), 'annai', "the key is named annai in the user's OpenRouter keys");
  assert.equal(s.at, 1000);
  assert.equal(s.provider, null, 'a new provider, not a key for one already set up');
  const code = new URL(await signInUrl({ callback: null, storage }));
  assert.equal(code.searchParams.get('callback_url'), null, 'without a callback, OpenRouter shows a code to paste');
  assert.equal(code.searchParams.get('state'), null);
  assert.equal(code.searchParams.get('key_label'), 'annai');
});

test('exchange: the code and the verifier buy a key; a strange state, an old sign-in or no key are refused', async () => {
  const storage = memoryStorage();
  await signInUrl({ callback: 'https://annai.guide/', storage, now: 1000 });
  const s = saved(storage);
  /** @type {any} */
  let sent = null;
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => { sent = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ key: 'sk-or-new' })); };
  await assert.rejects(exchange({ code: 'c', state: 'not-ours', fetch, storage, now: 2000 }), /didn't start in this browser/);
  assert.equal(await exchange({ code: ' c ', state: s.state, fetch, storage, now: 2000 }), 'sk-or-new');
  assert.equal(sent.url, KEYS_URL);
  assert.deepEqual(sent.body, { code: 'c', code_verifier: s.verifier, code_challenge_method: 'S256' });
  assert.equal(storage.getItem('annai.openrouter'), null, 'the verifier is used once');
  await signInUrl({ callback: null, storage, now: 3000 });
  await assert.rejects(exchange({ code: 'c', state: null, pasted: true, fetch: async () => new Response('{}'), storage, now: 3000 }), /didn't send a key/);
  await assert.rejects(exchange({ code: 'c', state: null, pasted: true, fetch: async () => new Response('no', { status: 500 }), storage, now: 3000 }), /HTTP 500/);
  await signInUrl({ callback: 'https://annai.guide/', storage, now: 1000 });
  await assert.rejects(exchange({ code: 'c', state: 'any', fetch, storage, now: 1000 + 16 * 60_000 }), /expired/);
});

test("the code and the verifier never follow a redirect: together they'd buy a key for whoever is at the other end (fix pass)", async () => {
  const storage = memoryStorage();
  await signInUrl({ callback: null, storage, now: 1000 });
  /** @type {any[]} */
  const inits = [];
  const answer = (/** @type {any} */ res) => async (/** @type {any} */ _url, /** @type {any} */ init) => { inits.push(init); return res; };
  const opaque = /** @type {any} */ ({ type: 'opaqueredirect', status: 0, ok: false, json: async () => ({ key: 'sk-or-elsewhere' }) });
  await assert.rejects(exchange({ code: 'c', state: null, pasted: true, fetch: answer(opaque), storage, now: 2000 }), /OpenRouter answered with a redirect, which annai doesn't follow with your sign-in/);
  const moved = new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/keys' } });
  await assert.rejects(exchange({ code: 'c', state: null, pasted: true, fetch: answer(moved), storage, now: 2000 }), /redirect/);
  assert.ok(inits.length === 2 && inits.every((i) => i.redirect === 'manual'));
});

test("a code OpenRouter won't take, an old sign-in and an empty paste each say what to do next, in words", async () => {
  const storage = memoryStorage();
  await signInUrl({ callback: null, storage, now: 1000 });
  const expired = async () => Response.json({ error: { code: 403, message: 'Authorization code expired' } }, { status: 403 });
  await assert.rejects(exchange({ code: 'old', state: null, pasted: true, fetch: expired, storage, now: 2000 }), /works once, for 10 minutes.*Tap Sign in with OpenRouter/);
  assert.ok(storage.getItem('annai.openrouter'), 'kept: a new code from the same sign-in still fits');
  await assert.rejects(exchange({ code: '  ', state: null, pasted: true, fetch: expired, storage, now: 2000 }), /Paste the code/);
  await assert.rejects(exchange({ code: 'late', state: null, pasted: true, fetch: expired, storage, now: 1000 + 16 * 60_000 }), /expired.*Tap Sign in with OpenRouter to start again/);
  assert.equal(storage.getItem('annai.openrouter'), null);
  await assert.rejects(exchange({ code: 'again', state: 'x', fetch: expired, storage, now: 2000 }), /^Error: annai has no sign-in waiting for this code: it was used already, or began in another browser\.$/);
});

test('a callback without the state is refused, and a code may be pasted only in a sign-in that asked for one (login CSRF)', async () => {
  const storage = memoryStorage();
  await signInUrl({ callback: 'https://annai.guide/', storage, now: 1000 });
  const fetch = async () => new Response(JSON.stringify({ key: 'sk-or-attacker' }));
  await assert.rejects(exchange({ code: 'attacker-code', state: null, fetch, storage, now: 2000 }), /didn't start in this browser/);
  await assert.rejects(exchange({ code: 'attacker-code', state: null, pasted: true, fetch, storage, now: 2000 }), /didn't start in this browser/);
  await signInUrl({ callback: null, storage, now: 3000 });
  assert.equal(await exchange({ code: 'mine', state: null, pasted: true, fetch, storage, now: 3000 }), 'sk-or-attacker');
});

test('the iPhone Home Screen sign-in is ready before the tap, and a pending one is kept: the same address, the same verifier, until it expires, and for the same provider only', async () => {
  const storage = memoryStorage();
  const first = await codeSignIn({ storage, now: 1000 });
  assert.equal(first.pending, false);
  const u = new URL(first.url);
  assert.equal(u.origin + u.pathname, AUTH_URL);
  assert.equal(u.searchParams.get('callback_url'), null, 'OpenRouter shows the code when there is no callback');
  assert.ok(u.searchParams.get('code_challenge'));
  const verifier = saved(storage).verifier;
  const again = await codeSignIn({ storage, now: 1000 + 5 * 60_000 });
  assert.deepEqual(again, { url: first.url, pending: true });
  assert.equal(saved(storage).verifier, verifier);
  assert.equal((await codeSignIn({ storage, provider: 'pv-1', now: 1000 + 6 * 60_000 })).pending, false, "another provider's page: a sign-in of its own");
  const later = await codeSignIn({ storage, provider: 'pv-1', now: 1000 + 22 * 60_000 });
  assert.equal(later.pending, false, 'too old: a new one');
  await signInUrl({ callback: 'https://annai.guide/', storage, now: 2_000_000 });
  assert.equal((await codeSignIn({ storage, now: 2_000_001 })).pending, false, 'one that comes back by itself is not reused for a code');
});

test('an expired sign-in is removed, not only written over: its verifier is gone even when a new one can\'t be made (fix pass)', async () => {
  const storage = memoryStorage();
  await codeSignIn({ storage, now: 0 });
  assert.ok(storage.getItem('annai.openrouter'));
  const full = { ...storage, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
  await assert.rejects(codeSignIn({ storage: full, now: 16 * 60_000 }), /full/);
  assert.equal(storage.getItem('annai.openrouter'), null);
});

test("on an iPhone Home Screen app, annai's 15 minutes count from the tap, not from when the sign-in was drawn (fix pass)", async () => {
  const storage = memoryStorage();
  const ok = async (/** @type {any} */ _url, /** @type {any} */ init) => new Response(JSON.stringify({ key: `sk-or-${JSON.parse(init.body).code}` }));
  const { url } = await codeSignIn({ storage, now: 0 });
  assert.equal(tapCode(url, { storage, now: 20 * 60_000 }), true);
  assert.deepEqual(await codeSignIn({ storage, now: 21 * 60_000 }), { url, pending: true }, 'drawn again after the tap: the same sign-in waits');
  assert.equal(await exchange({ code: 'fresh', state: null, pasted: true, fetch: ok, storage, now: 24 * 60_000 }), 'sk-or-fresh');
  assert.equal(tapCode(url, { storage, now: 25 * 60_000 }), false, 'used: no sign-in waits for this address any more');
  const second = await codeSignIn({ storage, now: 30 * 60_000 });
  assert.equal(tapCode(second.url, { storage, now: 31 * 60_000 }), true);
  const refused = async () => Response.json({ error: { code: 403, message: 'Invalid code or code_verifier' } }, { status: 403 });
  await assert.rejects(exchange({ code: 'typo', state: null, pasted: true, fetch: refused, storage, now: 32 * 60_000 }), /works once/);
  await assert.rejects(exchange({ code: 'late', state: null, pasted: true, fetch: ok, storage, now: 47 * 60_000 }), /expired/);
  const third = await codeSignIn({ storage, now: 47 * 60_000 });
  assert.notEqual(third.url, second.url);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saved(storage).verifier)));
  assert.equal(new URL(third.url).searchParams.get('code_challenge'), b64url(digest));
  assert.equal(tapCode(third.url, { storage, now: 48 * 60_000 }), true);
  assert.equal(await exchange({ code: 'new', state: null, pasted: true, fetch: ok, storage, now: 50 * 60_000 }), 'sk-or-new');
});

test('free models used up for the day are too many requests, not an account out of credit; a real 402 stays one', () => {
  // Its words ask for credits, which would read as "out of credit" to a key that never had any.
  const daily = JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' } });
  assert.equal(freeLimit(429, daily), 'rate');
  assert.equal(freeLimit(402, daily), 'rate', 'OpenRouter has been seen sending it as a 402 as well');
  assert.equal(freeLimit(429, JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-min.' } })), 'rate');
  assert.equal(freeLimit(402, JSON.stringify({ error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/credits' } })), null);
  assert.equal(freeLimit(500, 'not json'), null);
});

test('signing in: the address is taken, one OpenRouter provider with chat, transcription and voice and one key, free models in the chat roles, and a card says what it set up', async () => {
  const d = await device();
  const storage = await signIn(d);
  assert.equal(storage.getItem('annai.openrouter'), null, 'used');
  const cfg = await readConfig(d.ws);
  const providers = Object.values(cfg.providers);
  assert.deepEqual(providers.map((p) => p.plugin), ['provider-openrouter'], 'one provider');
  assert.deepEqual([...new Set(Object.values(cfg.models).map((m) => m.ability))].sort(), ['chat', 'transcription', 'voice']);
  assert.equal(await getKey(d.store, providers[0].id), KEY);
  assert.deepEqual(await d.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), [`llm:${providers[0].id}`], "one key, annai's, none in the plugin's own secrets");
  assert.deepEqual(cfg.roles.main.models.map((id) => modelOf(cfg.models[id]).name), ['Google: Gemma 4 31B (free)']);
  assert.deepEqual(d.cards.map((c) => [c.tone, c.title]), [['ok', 'Signed in with OpenRouter']]);
  assert.match(d.cards[0].body, /free models/);
  assert.match(d.cards[0].body, /transcription and voices, behind the phone's own dictation and the browser voice/);
  assert.match(d.cards[0].body, /Its free voice comes first: each sentence it says uses one of the free requests a day the chat models use too/);
  assert.match(d.cards[0].body, /The others cost a little/);
  assert.match(d.cards[0].body, /move them up under Roles/);
  // Its setup runs from its plugin, installed with what it requires.
  const setups = d.registry.entries('provider-setup').filter((e) => e.pluginId === 'provider-openrouter');
  assert.equal(setups.length, 1);
  assert.deepEqual(['panel', 'returned', 'classify'].map((p) => typeof setups[0].item[p]), ['function', 'function', 'function']);
});

test("the role order after sign-in: the free path first, OpenRouter's speech models behind the stand-ins, nothing priced ahead of it", async () => {
  const d = await device();
  await signIn(d);
  const cfg = await readConfig(d.ws);
  const ears = made(cfg, 'transcription');
  const voice = made(cfg, 'voice');
  assert.deepEqual(cfg.roles['speech-in'].models, ['send-audio', 'dictation', ears.models['openai/whisper-large-v3-turbo']]);
  assert.deepEqual(cfg.roles['speech-out'].models, ['browser-voice', voice.models['fish-audio/s2.1-pro-free:free'], voice.models['x-ai/grok-voice-tts-1.0']]);
  /** @param {string} id */
  const free = (id) => Boolean(STAND_INS[id]) || Object.values(modelOf(cfg.models[id]).prices ?? { x: 1 }).every((v) => v === 0);
  for (const [role, r] of Object.entries(cfg.roles)) {
    const priced = r.models.findIndex((id) => !free(id));
    assert.ok(priced === -1 || r.models.slice(priced).every((id) => !free(id)), `${role}: something free comes after something priced (${r.models})`);
  }
  for (const role of ['main', 'utility', 'decide']) assert.ok(cfg.roles[role].models.every(free), `${role}: free models only`);
});

test("signing in keeps the user's own speech lists: the OpenRouter models join at the end, and a list the user emptied stays empty", async () => {
  assert.deepEqual(speechBehind(['dictation', 'send-audio'], ['m-1']), ['dictation', 'send-audio', 'm-1']);
  assert.deepEqual(speechBehind([], ['m-3']), [], 'no voice of its own ahead, so none that costs money either');
  const d = await device();
  await saveRoles(d.ws, { ...(await readConfig(d.ws)).roles, 'speech-in': { models: ['dictation', 'send-audio'], level: 'off' }, 'speech-out': { models: [], level: 'off' } });
  await signIn(d);
  const cfg = await readConfig(d.ws);
  assert.deepEqual(cfg.roles['speech-in'].models, ['dictation', 'send-audio', made(cfg, 'transcription').models['openai/whisper-large-v3-turbo']]);
  assert.deepEqual(cfg.roles['speech-out'].models, []);
});

test('the key is in no file, log entry or trace: not after sign-in, nor after a transcription and a voice clip', async () => {
  const d = await device();
  await signIn(d);
  const cfg = await readConfig(d.ws);
  await d.llm.transcribe({ modelId: made(cfg, 'transcription').models['openai/whisper-large-v3-turbo'], audio: { data: WAV, mediaType: 'audio/wav', seconds: 0.1 } });
  await d.llm.synthesize({ modelId: made(cfg, 'voice').models['x-ai/grok-voice-tts-1.0'], text: 'Hello.' });
  const kept = await everything(d.store);
  assert.ok(kept.includes('net.request'), 'the speech requests are traced');
  assert.ok(!kept.includes(KEY));
  assert.ok(!JSON.stringify(d.cards).includes(KEY));
});

test("Sign in again on a provider's page keeps the new key on that provider; one removed meanwhile is said before OpenRouter is asked", async () => {
  const d = await device();
  await signIn(d);
  const id = made(await readConfig(d.ws), 'chat').id;
  d.cards.length = 0;
  let asked = 0;
  await signIn(d, { provider: id, keys: async () => { asked++; return new Response(JSON.stringify({ key: 'sk-or-v1-again-0123456789' })); } });
  assert.equal(asked, 1);
  assert.equal(await getKey(d.store, id), 'sk-or-v1-again-0123456789');
  assert.equal(Object.keys((await readConfig(d.ws)).providers).length, 1, 'no second provider');
  assert.deepEqual(d.cards.map((c) => [c.tone, c.title]), [['ok', 'Signed in with OpenRouter']]);
  await d.llm.removeProvider(id);
  await assert.rejects(signIn(d, { provider: id, keys: async () => { asked++; return new Response(JSON.stringify({ key: 'sk-or-lost' })); } }), /no longer exists.*Nothing was sent to OpenRouter yet/);
  assert.equal(asked, 1, 'no key made that annai would lose');
});

test("annai gets ready before it asks OpenRouter for a key: with annai's catalog out of reach, or a plugin that fails to install, no key is made that annai would lose (fix pass)", async () => {
  const d = await device();
  for (const why of ["catalog: annai's list of plugins couldn't be loaded. Check the connection and try again.", "speech-openai: couldn't be downloaded."]) {
    const ctx = { ...d.ctx, llm: { ...d.llm, addProvider: async () => { throw new Error(why); } } };
    const storage = memoryStorage();
    const url = new URL(await signInUrl({ callback: 'https://annai.guide/', storage }));
    let asked = 0;
    const setup = openRouter({ storage, card: () => {}, fetch: async () => { asked++; return new Response(JSON.stringify({ key: 'sk-or-lost' })); } });
    await assert.rejects(setup.returned(new URLSearchParams(`?code=abc&state=${url.searchParams.get('state')}`), setupUi(ctx, 'provider-openrouter')), (/** @type {any} */ e) => e.message.startsWith(why) && /Nothing was sent to OpenRouter yet: try again\.$/.test(e.message));
    assert.equal(asked, 0);
    assert.ok(storage.getItem('annai.openrouter'), 'the sign-in still waits, so trying again costs nothing');
  }
  assert.deepEqual(Object.keys((await readConfig(d.ws)).providers), []);
});

test("a chat model whose free requests are used up is resting for a while, not out of credit: the running plugin's classify is asked first", async () => {
  const d = await device({ chat: () => Response.json({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' } }, { status: 429 }) });
  await signIn(d);
  await assert.rejects(d.llm.call({ request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } }), (/** @type {any} */ e) => e.attempts?.[0]?.outcome === 'rate');
});

test("Sign in with OpenRouter's address is made before annai is told to expect it back: one that can't be made leaves no 15-minute note (fix pass)", async () => {
  /** A stand-in for annai's DOM builder: plain objects. @param {string} tag @param {any} attrs @param {...any} children */
  const h = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat() });
  /** @param {any} node @returns {any} */
  const button = (node) => (node?.tag === 'button' ? node : (node?.children ?? []).map(button).find(Boolean));
  /** @type {string[]} */
  const happened = [];
  const ui = { h, returnsElsewhere: false, render: () => {}, expectReturn: () => happened.push('expected') };
  const at = /** @type {any} */ (globalThis);
  at.location = { origin: 'https://annai.guide', assign: (/** @type {string} */ url) => happened.push(`went to ${new URL(url).origin}`) };
  try {
    const full = { getItem: () => null, setItem: () => { throw new DOMException('The storage is full.', 'QuotaExceededError'); }, removeItem: () => {} };
    await button(openRouter({ storage: full }).panel(ui, null)).attrs.onclick();
    assert.deepEqual(happened, [], 'no address, so nothing expected back');
    await button(openRouter({ storage: memoryStorage() }).panel(ui, null)).attrs.onclick();
    assert.deepEqual(happened, ['expected', 'went to https://openrouter.ai']);
  } finally {
    delete at.location;
  }
});
