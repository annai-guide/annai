import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { readConfig, modelOf, getKey } from '../../src/core/llm/config.js';
import { signInUrl, callbackFrom, exchange, finishSignIn, AUTH_URL, KEYS_URL } from '../../src/ui/openrouter.js';

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
  assert.equal(saved.at, 1000);
  const code = new URL(await signInUrl({ callback: null, storage }));
  assert.equal(code.searchParams.get('callback_url'), null, 'without a callback, OpenRouter shows a code to paste');
  assert.equal(code.searchParams.get('state'), null);
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
  await assert.rejects(exchange({ code: 'c', state: saved.state, fetch, storage, now: 1000 + 16 * 60_000 }), /expired/);
  assert.equal(await exchange({ code: ' c ', state: saved.state, fetch, storage, now: 2000 }), 'sk-or-new');
  assert.equal(sent.url, KEYS_URL);
  assert.deepEqual(sent.body, { code: 'c', code_verifier: saved.verifier, code_challenge_method: 'S256' });
  assert.equal(storage.getItem('annai.openrouter'), null, 'the verifier is used once');
  await signInUrl({ callback: null, storage, now: 3000 });
  await assert.rejects(exchange({ code: 'c', state: null, pasted: true, fetch: async () => new Response('{}'), storage, now: 3000 }), /didn't send a key/);
  await assert.rejects(exchange({ code: 'c', state: null, pasted: true, fetch: async () => new Response('no', { status: 403 }), storage, now: 3000 }), /HTTP 403/);
});

test('finishing a sign-in: the address is cleaned, the endpoint, key and free models are set up, and the user is told', async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const catalog = JSON.parse(await readFile(new URL('../../catalog/templates.json', import.meta.url), 'utf8'));
  const storage = memoryStorage();
  const url = new URL(await signInUrl({ callback: 'https://annai.guide/', storage }));
  /** @type {string[]} */
  const toasts = [];
  /** @type {string[]} */
  const replaced = [];
  const ctx = {
    ws, store,
    llm: { templates: async () => catalog, ensureType: async () => {} },
    notices: { toast: (/** @type {string} */ t) => toasts.push(t), card: (/** @type {any} */ c) => { throw new Error(c.body); } },
  };
  const was = await finishSignIn(ctx, {
    location: /** @type {any} */ ({ search: `?code=abc&state=${url.searchParams.get('state')}`, pathname: '/' }),
    history: /** @type {any} */ ({ replaceState: (/** @type {any} */ _s, /** @type {any} */ _t, /** @type {string} */ to) => replaced.push(to) }),
    fetch: async () => new Response(JSON.stringify({ key: 'sk-or-signed-in' })),
    storage,
  });
  assert.equal(was, true);
  assert.deepEqual(replaced, ['/#/models']);
  const cfg = await readConfig(ws);
  const [endpoint] = Object.values(cfg.endpoints);
  assert.equal(endpoint.template?.id, 'openrouter');
  assert.equal(await getKey(store, endpoint.id), 'sk-or-signed-in');
  assert.deepEqual(cfg.roles.main.models.map((id) => modelOf(cfg.models[id]).name), ['Google: Gemma 4 31B (free)']);
  assert.match(toasts[0], /Signed in with OpenRouter/);
  assert.equal(await finishSignIn(ctx, { location: /** @type {any} */ ({ search: '', pathname: '/' }) }), false);
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
