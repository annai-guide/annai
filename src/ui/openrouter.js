import { addFromTemplate } from '../core/llm/templates.js';
import { platform, isStandalone } from './platform.js';

/**
 * Sign in with OpenRouter (spec §9.8): OAuth with PKCE, with no client registration on annai's
 * side. The browser goes to OpenRouter, which sends it back with a code; the code, with a secret
 * only this browser knows (the verifier), buys a key. An iPhone Home Screen app keeps its storage
 * apart from Safari, where OpenRouter would send it back, so there OpenRouter shows the code
 * and the user pastes it instead.
 * @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} KeyValue
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 */
export const AUTH_URL = 'https://openrouter.ai/auth';
export const KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const SLOT = 'annai.openrouter';
const MAX_AGE = 15 * 60_000;

/** Whether sign-in must show a code to paste, rather than come back to annai by itself. */
export function needsCode() {
  return platform() === 'ios' && isStandalone();
}

/** @param {Uint8Array} bytes */
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Where to send the browser to sign in. The verifier and the state wait in storage for the way back.
 * @param {{ callback: string | null, storage?: KeyValue, now?: number }} c callback: annai's address, or null for a code to paste
 */
export async function signInUrl({ callback, storage = localStorage, now = Date.now() }) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  storage.setItem(SLOT, JSON.stringify({ verifier, state, at: now }));
  const params = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256' });
  if (callback) {
    params.set('callback_url', callback);
    params.set('state', state);
  }
  return `${AUTH_URL}?${params}`;
}

/** The code and state OpenRouter sent back, when this page load is its callback. @param {string} search */
export function callbackFrom(search) {
  const p = new URLSearchParams(search);
  const code = p.get('code');
  return code ? { code, state: p.get('state') } : null;
}

/**
 * Trades the code for a key. The verifier is used once.
 * @param {{ code: string, state: string | null, fetch?: Fetch, storage?: KeyValue, now?: number }} c state: null when the user pasted the code
 * @returns {Promise<string>} the key
 */
export async function exchange({ code, state, fetch: get = (url, init) => fetch(url, init), storage = localStorage, now = Date.now() }) {
  /** @type {any} */
  let saved = null;
  try {
    saved = JSON.parse(storage.getItem(SLOT) ?? 'null');
  } catch {
    saved = null;
  }
  if (!saved || now - saved.at > MAX_AGE) throw new Error('This sign-in has expired. Start it again from Settings → Models.');
  if (state !== null && state !== saved.state) throw new Error("This sign-in didn't start in this browser, so annai ignored it.");
  /** @type {Response} */
  let res;
  try {
    res = await get(KEYS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), code_verifier: saved.verifier, code_challenge_method: 'S256' }),
    });
  } catch {
    throw new Error("annai couldn't reach OpenRouter. Check the connection and try again.");
  }
  if (!res.ok) throw new Error(`OpenRouter didn't accept the sign-in (HTTP ${res.status}). Start it again from Settings → Models.`);
  const body = await res.json().catch(() => ({}));
  if (typeof body?.key !== 'string' || !body.key) throw new Error("OpenRouter didn't send a key. Start the sign-in again.");
  storage.removeItem(SLOT);
  return body.key;
}

/**
 * Sets annai up with an OpenRouter key: the OpenRouter endpoint from annai's template, its key,
 * and free models in the roles that are still empty, so trying annai costs nothing.
 * @param {any} ctx llm, ws and store @param {string} key @returns {Promise<string>} the endpoint's id
 */
export async function connectOpenRouter(ctx, key) {
  const catalog = await ctx.llm.templates();
  const tpl = catalog.endpoints.find((/** @type {any} */ t) => t.id === 'openrouter');
  if (!tpl) throw new Error("annai's OpenRouter template isn't available yet. Connect to the internet and try again.");
  await ctx.llm.ensureType(tpl.type);
  return addFromTemplate(ctx, tpl, { key, roles: 'free' });
}

/**
 * Finishes a sign-in when this page load is OpenRouter's callback: takes the code out of the
 * address, trades it for a key, sets up the endpoint, and says how it went.
 * @param {any} ctx llm, ws, store and notices
 * @param {{ fetch?: Fetch, storage?: KeyValue, location?: { search: string, pathname: string }, history?: { replaceState: History['replaceState'] } }} [env]
 * @returns {Promise<boolean>} whether this page load was a callback
 */
export async function finishSignIn(ctx, env = {}) {
  const loc = env.location ?? location;
  const cb = callbackFrom(loc.search);
  if (!cb) return false;
  (env.history ?? history).replaceState(null, '', `${loc.pathname}#/models`);
  try {
    const key = await exchange({ code: cb.code, state: cb.state, fetch: env.fetch, storage: env.storage });
    await connectOpenRouter(ctx, key);
    ctx.notices.toast('Signed in with OpenRouter. annai picked free models to start; you can change them under Roles.');
  } catch (e) {
    ctx.notices.card({ tone: 'warn', title: "Signing in with OpenRouter didn't finish", body: String(/** @type {any} */ (e)?.message ?? e) });
  }
  return true;
}
