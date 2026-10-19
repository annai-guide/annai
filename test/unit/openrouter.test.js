import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { readConfig, modelOf, getKey } from '../../src/core/llm/config.js';
import { createLlm } from '../../src/core/llm/service.js';
import { hostKit } from './package-kit.js';
import { signInUrl, codeSignIn, tapCode, callbackFrom, exchange, finishSignIn, signingIn, AUTH_URL, KEYS_URL } from '../../src/ui/openrouter.js';

/** A Storage-like map. */
function memoryStorage() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return { getItem: (/** @type {string} */ k) => m.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, v); }, removeItem: (/** @type {string} */ k) => { m.delete(k); }, m };
}
/** @param {Uint8Array} b */
const b64url = (b) => Buffer.from(b).toString('base64url');

test('the sign-in address carries a PKCE challenge of the stored verifier, and a state (spec §9.8)', async () => {
  const storage = memoryStorage();
  const url = new URL(await signInUrl({ callback: 'https://annai.guide/', storage, now: 1000 }));
  assert.equal(`${url.origin}${url.pathname}`, AUTH_URL);
  const saved = JSON.parse(/** @type {string} */ (storage.getItem('annai.openrouter')));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saved.verifier)));
  assert.equal(url.searchParams.get('code_challenge'), b64url(digest));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('callback_url'), 'https://annai.guide/');
  assert.equal(url.searchParams.get('state'), saved.state);
  assert.equal(url.searchParams.get('key_label'), 'annai', "the key is named annai in the user's OpenRouter keys");
  assert.equal(saved.at, 1000);
  const code = new URL(await signInUrl({ callback: null, storage }));
  assert.equal(code.searchParams.get('callback_url'), null, 'without a callback, OpenRouter shows a code to paste');
  assert.equal(code.searchParams.get('state'), null);
  assert.equal(code.searchParams.get('key_label'), 'annai');
});

test('the callback is read from the address', () => {
  assert.deepEqual(callbackFrom('?code=abc&state=xyz'), { code: 'abc', state: 'xyz' });
  assert.equal(callbackFrom(''), null);
});

test('exchange: the code and the verifier buy a key; a strange state, an old sign-in or no key are refused', async () => {
  const storage = memoryStorage();
  await signInUrl({ callback: 'https://annai.guide/', storage, now: 1000 });
  const saved = JSON.parse(/** @type {string} */ (storage.getItem('annai.openrouter')));
  /** @type {any} */
  let sent = null;
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => { sent = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ key: 'sk-or-new' })); };
  await assert.rejects(exchange({ code: 'c', state: 'not-ours', fetch, storage, now: 2000 }), /didn't start in this browser/);
  assert.equal(await exchange({ code: ' c ', state: saved.state, fetch, storage, now: 2000 }), 'sk-or-new');
  assert.equal(sent.url, KEYS_URL);
  assert.deepEqual(sent.body, { code: 'c', code_verifier: saved.verifier, code_challenge_method: 'S256' });
  assert.equal(storage.getItem('annai.openrouter'), null, 'the verifier is used once');
  await signInUrl({ callback: null, storage, now: 3000 });
  await assert.rejects(exchange({ code: 'c', state: null, pasted: true, fetch: async () => new Response('{}'), storage, now: 3000 }), /didn't send a key/);
  await assert.rejects(exchange({ code: 'c', state: null, pasted: true, fetch: async () => new Response('no', { status: 500 }), storage, now: 3000 }), /HTTP 500/);
  await signInUrl({ callback: 'https://annai.guide/', storage, now: 1000 });
  await assert.rejects(exchange({ code: 'c', state: 'any', fetch, storage, now: 1000 + 16 * 60_000 }), /expired/);
});

test("a code OpenRouter won't take, an old sign-in and an empty paste each say what to do next, in words", async () => {
  const storage = memoryStorage();
  await signInUrl({ callback: null, storage, now: 1000 });
  const expired = async () => Response.json({ error: { code: 403, message: 'Authorization code expired' } }, { status: 403 });
  // OpenRouter's codes work once, for 10 minutes: a 403 says so, and the same sign-in takes a new code.
  await assert.rejects(exchange({ code: 'old', state: null, pasted: true, fetch: expired, storage, now: 2000 }), /works once, for 10 minutes.*Tap Sign in with OpenRouter/);
  assert.ok(storage.getItem('annai.openrouter'), 'kept: a new code from the same sign-in still fits');
  await assert.rejects(exchange({ code: '  ', state: null, pasted: true, fetch: expired, storage, now: 2000 }), /Paste the code/);
  // Past annai's own limit: the waiting sign-in is dropped, so the next tap starts a new one.
  await assert.rejects(exchange({ code: 'late', state: null, pasted: true, fetch: expired, storage, now: 1000 + 16 * 60_000 }), /expired.*Tap Sign in with OpenRouter to start again/);
  assert.equal(storage.getItem('annai.openrouter'), null);
  // Nothing waiting (the code was used already, or the sign-in began in another browser): signed in or not, there is nothing to start again.
  await assert.rejects(exchange({ code: 'again', state: 'x', fetch: expired, storage, now: 2000 }), /^Error: annai has no sign-in waiting for this code: it was used already, or began in another browser\.$/);
});

/** annai's model service on a fresh device, its official plugins served from this repository. */
async function device() {
  const k = await hostKit();
  const root = new URL('../../', import.meta.url);
  const fetch = async (/** @type {any} */ url) => {
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  return { ...k, llm: createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch }) };
}

test('finishing a sign-in: the address is cleaned, one OpenRouter provider, its one key and free models are set up, and the user is told', async () => {
  const { ws, store, llm } = await device();
  const storage = memoryStorage();
  const url = new URL(await signInUrl({ callback: 'https://annai.guide/', storage }));
  /** @type {any[]} */
  const cards = [];
  /** @type {string[]} */
  const replaced = [];
  /** @type {boolean[]} */
  const drawn = [];
  const ctx = {
    ws, store, llm,
    notices: { toast: () => {}, card: (/** @type {any} */ c) => cards.push(c) },
    // The Models screen is drawn as soon as the address is clean, saying the sign-in is being finished.
    render: () => drawn.push(signingIn()),
  };
  const was = await finishSignIn(ctx, {
    location: /** @type {any} */ ({ search: `?code=abc&state=${url.searchParams.get('state')}`, pathname: '/' }),
    history: /** @type {any} */ ({ replaceState: (/** @type {any} */ _s, /** @type {any} */ _t, /** @type {string} */ to) => replaced.push(to) }),
    fetch: async () => new Response(JSON.stringify({ key: 'sk-or-signed-in' })),
    storage,
  });
  assert.equal(was, true);
  assert.deepEqual(replaced, ['/#/models']);
  assert.deepEqual(drawn, [true]);
  assert.equal(signingIn(), false);
  const cfg = await readConfig(ws);
  const providers = Object.values(cfg.providers);
  assert.deepEqual(providers.map((p) => p.plugin), ['provider-openrouter'], 'one provider');
  assert.equal(await getKey(store, providers[0].id), 'sk-or-signed-in');
  assert.deepEqual(await store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), [`llm:${providers[0].id}`], 'one key');
  assert.deepEqual(cfg.roles.main.models.map((id) => modelOf(cfg.models[id]).name), ['Google: Gemma 4 31B (free)']);
  assert.deepEqual(cards.map((c) => [c.tone, c.title]), [['ok', 'Signed in with OpenRouter']]);
  assert.match(cards[0].body, /also added OpenRouter's transcription and voices, behind the phone's own dictation/);
  assert.equal(await finishSignIn(ctx, { location: /** @type {any} */ ({ search: '', pathname: '/' }) }), false);
});

test("a sign-in that came back but didn't finish says why on a card, and isn't left finishing", async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const storage = memoryStorage();
  const url = new URL(await signInUrl({ callback: 'https://annai.guide/', storage }));
  /** @type {any[]} */
  const cards = [];
  const { llm } = await device();
  const ctx = { ws, store, llm, notices: { toast: () => {}, card: (/** @type {any} */ c) => cards.push(c) } };
  await finishSignIn(ctx, {
    location: /** @type {any} */ ({ search: `?code=abc&state=${url.searchParams.get('state')}`, pathname: '/' }),
    history: /** @type {any} */ ({ replaceState: () => {} }),
    fetch: async () => Response.json({ error: { code: 403, message: 'Invalid code or code_verifier' } }, { status: 403 }),
    storage,
  });
  assert.equal(cards[0].tone, 'warn');
  assert.match(cards[0].body, /didn't take the code/);
  assert.equal(signingIn(), false);
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

test('the iPhone Home Screen sign-in is ready before the tap, and a pending one is kept: the same address, the same verifier, until it expires', async () => {
  /** @type {Map<string, string>} */
  const m = new Map();
  const storage = { getItem: (/** @type {string} */ k) => m.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, v); }, removeItem: (/** @type {string} */ k) => { m.delete(k); } };
  const first = await codeSignIn({ storage, now: 1000 });
  assert.equal(first.pending, false);
  const u = new URL(first.url);
  assert.equal(u.origin + u.pathname, AUTH_URL);
  assert.equal(u.searchParams.get('callback_url'), null, 'OpenRouter shows the code when there is no callback');
  assert.ok(u.searchParams.get('code_challenge'));
  const verifier = JSON.parse(m.get('annai.openrouter') ?? '{}').verifier;
  // Drawn again (a redraw, or annai reopened after a trip to Safari): the same sign-in, so the code still fits.
  const again = await codeSignIn({ storage, now: 1000 + 5 * 60_000 });
  assert.deepEqual(again, { url: first.url, pending: true });
  assert.equal(JSON.parse(m.get('annai.openrouter') ?? '{}').verifier, verifier);
  // Too old: a new one.
  const later = await codeSignIn({ storage, now: 1000 + 16 * 60_000 });
  assert.equal(later.pending, false);
  assert.notEqual(later.url, first.url);
  // A sign-in that came back by itself (not a code) is not reused for a code.
  await signInUrl({ callback: 'https://annai.guide/', storage, now: 2_000_000 });
  assert.equal((await codeSignIn({ storage, now: 2_000_001 })).pending, false);
});

test("on an iPhone Home Screen app, annai's 15 minutes count from the tap, not from when Models was drawn (fix pass)", async () => {
  const storage = memoryStorage();
  const ok = async (/** @type {any} */ _url, /** @type {any} */ init) => new Response(JSON.stringify({ key: `sk-or-${JSON.parse(init.body).code}` }));
  const { url } = await codeSignIn({ storage, now: 0 });
  // Models left open 20 minutes, then the tap; the code OpenRouter shows comes back 4 minutes later.
  assert.equal(tapCode(url, { storage, now: 20 * 60_000 }), true);
  assert.deepEqual(await codeSignIn({ storage, now: 21 * 60_000 }), { url, pending: true }, 'drawn again after the tap: the same sign-in waits');
  assert.equal(await exchange({ code: 'fresh', state: null, pasted: true, fetch: ok, storage, now: 24 * 60_000 }), 'sk-or-fresh');
  assert.equal(tapCode(url, { storage, now: 25 * 60_000 }), false, 'used: no sign-in waits for this address any more');

  // A code refused, then pasted again more than 15 minutes after the tap: the sign-in is dropped, and the
  // next one has a new challenge whose verifier is the one stored, so its code works.
  const second = await codeSignIn({ storage, now: 30 * 60_000 });
  assert.equal(second.pending, false);
  assert.equal(tapCode(second.url, { storage, now: 31 * 60_000 }), true);
  const refused = async () => Response.json({ error: { code: 403, message: 'Invalid code or code_verifier' } }, { status: 403 });
  await assert.rejects(exchange({ code: 'typo', state: null, pasted: true, fetch: refused, storage, now: 32 * 60_000 }), /works once/);
  await assert.rejects(exchange({ code: 'late', state: null, pasted: true, fetch: ok, storage, now: 47 * 60_000 }), /expired/);
  const third = await codeSignIn({ storage, now: 47 * 60_000 });
  assert.equal(third.pending, false);
  assert.notEqual(third.url, second.url);
  const saved = JSON.parse(/** @type {string} */ (storage.getItem('annai.openrouter')));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saved.verifier)));
  assert.equal(new URL(third.url).searchParams.get('code_challenge'), b64url(digest));
  assert.equal(tapCode(third.url, { storage, now: 48 * 60_000 }), true);
  assert.equal(await exchange({ code: 'new', state: null, pasted: true, fetch: ok, storage, now: 50 * 60_000 }), 'sk-or-new');
});

test("annai gets ready before it asks OpenRouter for a key: with annai's catalog out of reach, or a plugin that fails to install, no key is made that annai would lose (fix pass)", async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  /** @param {any} llm */
  const attempt = async (llm) => {
    const storage = memoryStorage();
    const url = new URL(await signInUrl({ callback: 'https://annai.guide/', storage }));
    /** @type {any[]} */
    const cards = [];
    let asked = 0;
    await finishSignIn({ ws, store, llm, notices: { toast: () => {}, card: (/** @type {any} */ c) => cards.push(c) } }, {
      location: /** @type {any} */ ({ search: `?code=abc&state=${url.searchParams.get('state')}`, pathname: '/' }),
      history: /** @type {any} */ ({ replaceState: () => {} }),
      fetch: async () => { asked++; return new Response(JSON.stringify({ key: 'sk-or-lost' })); },
      storage,
    });
    return { asked, cards, waiting: storage.getItem('annai.openrouter') !== null };
  };
  const noCatalog = await attempt({ installProvider: async () => { throw new Error("catalog: annai's list of plugins couldn't be loaded. Check the connection and try again."); }, addProvider: async () => 'x' });
  assert.equal(noCatalog.asked, 0);
  assert.match(noCatalog.cards[0].body, /couldn't be loaded.*Nothing was sent to OpenRouter/);
  const noPlugin = await attempt({ installProvider: async () => { throw new Error("speech-openai: couldn't be downloaded."); }, addProvider: async () => 'x' });
  assert.equal(noPlugin.asked, 0, 'what it requires is installed before the code is traded, too');
  assert.match(noPlugin.cards[0].body, /couldn't be downloaded.*Nothing was sent to OpenRouter/);
  assert.equal(noPlugin.waiting, true, 'the sign-in still waits, so trying again costs nothing');
  assert.deepEqual(Object.keys((await readConfig(ws)).providers), []);
});
