import { addFromTemplate } from '../core/llm/templates.js';
import { readConfig } from '../core/llm/config.js';
import { platform, isStandalone } from './platform.js';

/**
 * Sign in with OpenRouter (spec §9.8): OAuth with PKCE, with no client registration on annai's
 * side. The browser goes to OpenRouter, which sends it back with a code; the code, with a secret
 * only this browser knows (the verifier), buys a key. An iPhone Home Screen app keeps its storage
 * apart from Safari, where OpenRouter would send it back, so there OpenRouter shows the code
 * and the user pastes it instead. Sign-in also adds OpenRouter's transcription and voice, behind
 * the free ones (the user, 2026-10-18).
 * @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} KeyValue
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 */
export const AUTH_URL = 'https://openrouter.ai/auth';
export const KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const SLOT = 'annai.openrouter';
const MAX_AGE = 15 * 60_000;
/** OpenRouter's transcription and voice, which sign-in adds too. */
export const VOICE_TEMPLATES = Object.freeze(['openrouter-transcription', 'openrouter-speech']);
const AGAIN = 'Tap Sign in with OpenRouter to start again.';
/** A sign-in that came back is being finished: the Models screen says so. */
let finishing = false;
export const signingIn = () => finishing;

/** Whether sign-in must show a code to paste, rather than come back to annai by itself. */
export function needsCode() {
  return platform() === 'ios' && isStandalone();
}

/** The sign-in waiting in storage, or null. @param {KeyValue} storage @returns {any} */
function waiting(storage) {
  try {
    return JSON.parse(storage.getItem(SLOT) ?? 'null');
  } catch {
    return null;
  }
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
  // key_label names the key in the user's OpenRouter keys, where it can be found and revoked.
  const params = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256', key_label: 'annai' });
  if (callback) {
    params.set('callback_url', callback);
    params.set('state', state);
  }
  const url = `${AUTH_URL}?${params}`;
  storage.setItem(SLOT, JSON.stringify({ verifier, state, at: now, mode: callback ? 'callback' : 'code', url }));
  return url;
}

/**
 * The sign-in for an iPhone Home Screen app, ready before the tap: Safari opens a page only from the
 * tap itself, not after an await, so the address must exist already. One still waiting for its code
 * is kept (same address, same verifier), so a redraw, or annai reopened after the trip to Safari,
 * still takes the code OpenRouter shows.
 * @param {{ storage?: KeyValue, now?: number }} [c]
 * @returns {Promise<{ url: string, pending: boolean }>} pending: one was already waiting
 */
export async function codeSignIn({ storage = localStorage, now = Date.now() } = {}) {
  const saved = waiting(storage);
  if (saved?.mode === 'code' && typeof saved.url === 'string' && now - saved.at <= MAX_AGE) return { url: saved.url, pending: true };
  return { url: await signInUrl({ callback: null, storage, now }), pending: false };
}

/**
 * The tap on that link: annai's 15 minutes count from here, not from when Models was drawn, so a page
 * left open longer still takes the code this tap brings back (fix pass). Synchronous, as the tap must open the page.
 * @param {string} url the link's address @param {{ storage?: KeyValue, now?: number }} [c]
 * @returns {boolean} false: no sign-in waits for this address any more, so the link needs a new one
 */
export function tapCode(url, { storage = localStorage, now = Date.now() } = {}) {
  const saved = waiting(storage);
  if (saved?.mode !== 'code' || saved.url !== url) return false;
  storage.setItem(SLOT, JSON.stringify({ ...saved, at: now }));
  return true;
}

/** The code and state OpenRouter sent back, when this page load is its callback. @param {string} search */
export function callbackFrom(search) {
  const p = new URLSearchParams(search);
  const code = p.get('code');
  return code ? { code, state: p.get('state') } : null;
}

/**
 * Trades the code for a key. The verifier is used once. A code that came back in the address
 * must carry the state this browser sent (otherwise anyone could hand annai a code for their own
 * account: login CSRF); a pasted code is taken only in a sign-in that asked for one.
 * @param {{ code: string, state: string | null, pasted?: boolean, fetch?: Fetch, storage?: KeyValue, now?: number }} c
 * @returns {Promise<string>} the key
 */
export async function exchange({ code, state, pasted = false, fetch: get = (url, init) => fetch(url, init), storage = localStorage, now = Date.now() }) {
  if (!code.trim()) throw new Error('Paste the code OpenRouter showed you, then tap Connect.');
  const saved = waiting(storage);
  if (!saved) throw new Error('annai has no sign-in waiting for this code: it was used already, or began in another browser.');
  if (now - saved.at > MAX_AGE) {
    storage.removeItem(SLOT); // so the next tap starts a new one
    throw new Error(`This sign-in has expired. ${AGAIN}`);
  }
  const ours = pasted ? saved.mode === 'code' : saved.mode === 'callback' && typeof state === 'string' && state === saved.state;
  if (!ours) throw new Error("This sign-in didn't start in this browser, so annai ignored it.");
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
  // 403: the code is wrong, used or older than 10 minutes. The same sign-in takes a new code.
  if (res.status === 403) throw new Error("OpenRouter didn't take the code: a code works once, for 10 minutes. Tap Sign in with OpenRouter to get a new one.");
  if (!res.ok) throw new Error(`OpenRouter didn't accept the sign-in (HTTP ${res.status}). ${AGAIN}`);
  const body = await res.json().catch(() => ({}));
  if (typeof body?.key !== 'string' || !body.key) throw new Error(`OpenRouter didn't send a key. ${AGAIN}`);
  storage.removeItem(SLOT);
  return body.key;
}

/**
 * What signing in needs before OpenRouter is asked for a key: annai's templates and the plugins for
 * their endpoint types. None needs the key, so a failure here costs nothing: no key is made that
 * annai would then lose (fix pass). @param {any} ctx llm @returns {Promise<{ endpoints: any[] }>} the catalog
 */
export async function readyForSignIn(ctx) {
  const catalog = await ctx.llm.templates();
  const tpls = ['openrouter', ...VOICE_TEMPLATES].map((id) => catalog.endpoints.find((/** @type {any} */ t) => t.id === id)).filter(Boolean);
  if (tpls[0]?.id !== 'openrouter') throw new Error("annai's OpenRouter template isn't available yet. Connect to the internet and try again.");
  try {
    for (const type of new Set(tpls.map((t) => t.type))) await ctx.llm.ensureType(type);
  } catch (e) {
    throw new Error(`${String(/** @type {any} */ (e)?.message ?? e)} Nothing was sent to OpenRouter yet: try again.`);
  }
  return catalog;
}

/**
 * Signs in: gets ready, trades the code for a key (get), sets annai up with it, and says on a card
 * what it set up. @param {any} ctx @param {() => Promise<string>} get
 */
export async function signIn(ctx, get) {
  const catalog = await readyForSignIn(ctx);
  signedIn(ctx, await connectOpenRouter(ctx, await get(), catalog));
}

/**
 * Sets annai up with an OpenRouter key: the OpenRouter endpoint from annai's template, its key,
 * and free models in the roles that are still empty, so trying annai costs nothing; then its voice.
 * @param {any} ctx llm, ws and store @param {string} key @param {{ endpoints: any[] }} catalog from readyForSignIn
 * @returns {Promise<{ id: string, voice: string[] | null }>} the endpoint's id; the voice templates added, null if that failed
 */
export async function connectOpenRouter(ctx, key, catalog) {
  const tpl = catalog.endpoints.find((/** @type {any} */ t) => t.id === 'openrouter');
  const id = await addFromTemplate(ctx, tpl, { key, roles: 'free' });
  // Chat is enough to start: the voice can be added later from the endpoint's page.
  const voice = await addOpenRouterVoice(ctx, key, catalog).catch(() => null);
  return { id, voice };
}

/** The voice templates annai has that no endpoint was made from yet. @param {import('../core/llm/config.js').ModelConfig} cfg @param {{ endpoints: any[] }} catalog */
export function voiceMissing(cfg, catalog) {
  const have = new Set(Object.values(cfg.endpoints).map((e) => e.template?.id));
  return VOICE_TEMPLATES.filter((id) => !have.has(id) && catalog.endpoints.some((t) => t.id === id));
}

/**
 * Adds OpenRouter's transcription and voice, each endpoint with its own copy of the key, their models
 * at the end of the speech lists, so nothing that costs money comes first.
 * @param {any} ctx llm, ws and store @param {string} key @param {{ endpoints: any[] }} [catalog]
 * @returns {Promise<string[]>} the templates added
 */
export async function addOpenRouterVoice(ctx, key, catalog) {
  if (!key) throw new Error("This endpoint has no key yet. Save OpenRouter's key on it first.");
  const cat = catalog ?? await ctx.llm.templates();
  /** @type {string[]} */
  const added = [];
  for (const id of voiceMissing(await readConfig(ctx.ws), cat)) {
    const tpl = cat.endpoints.find((t) => t.id === id);
    await ctx.llm.ensureType(tpl.type);
    await addFromTemplate(ctx, tpl, { key, roles: 'recommended', behind: true });
    added.push(id);
  }
  return added;
}

/** Where OpenRouter's speech models go, and how to use them. */
export const BEHIND = "behind the phone's own dictation and the browser voice. Its free voice comes first: each sentence it says uses one of the free requests a day the chat models use too. The others cost a little, from credits you buy at OpenRouter. To use them first, move them up under Roles";

/** Says on a card what sign-in set up. @param {any} ctx @param {{ voice: string[] | null }} done */
export function signedIn(ctx, { voice }) {
  const start = 'Shiori thinks with free models to start, so trying annai costs nothing.';
  const body = voice === null ? `${start} annai couldn't add OpenRouter's voice just now: the OpenRouter endpoint's page can.`
    : voice.length ? `${start} annai also added OpenRouter's transcription and voices, ${BEHIND}.` : `${start} You can change them under Roles.`;
  ctx.notices.card({ tone: 'ok', title: 'Signed in with OpenRouter', body });
}

/**
 * Finishes a sign-in when this page load is OpenRouter's callback: takes the code out of the
 * address, shows Models (which says it is finishing), trades the code for a key, sets up the
 * endpoints, and says how it went.
 * @param {any} ctx llm, ws, store, notices and render
 * @param {{ fetch?: Fetch, storage?: KeyValue, location?: { search: string, pathname: string }, history?: { replaceState: History['replaceState'] } }} [env]
 * @returns {Promise<boolean>} whether this page load was a callback
 */
export async function finishSignIn(ctx, env = {}) {
  const loc = env.location ?? location;
  const cb = callbackFrom(loc.search);
  if (!cb) return false;
  (env.history ?? history).replaceState(null, '', `${loc.pathname}#/models`);
  finishing = true;
  try {
    ctx.render?.();
    await signIn(ctx, () => exchange({ code: cb.code, state: cb.state, fetch: env.fetch, storage: env.storage }));
  } catch (e) {
    ctx.notices.card({ tone: 'warn', title: "Signing in with OpenRouter didn't finish", body: String(/** @type {any} */ (e)?.message ?? e) });
  } finally {
    finishing = false;
  }
  return true;
}
