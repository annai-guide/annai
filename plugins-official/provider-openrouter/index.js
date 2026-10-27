/**
 * OpenRouter's provider plugin with code (spec §9.8; docs/plugins.md, "Model providers with code"): Sign in
 * with OpenRouter, and its free-model limit. Its models, speech lists and headers are data, in annai-plugin.json.
 *
 * The sign-in is OAuth with PKCE, with no client registration on annai's side. The browser goes to
 * OpenRouter, which sends it back to annai's address with a code; the code, with a secret only this browser
 * knows (the verifier), buys a key. An iPhone Home Screen app keeps its storage apart from Safari, where
 * OpenRouter would send it back, so there OpenRouter shows the code and the user pastes it. The sign-in
 * waits in localStorage under annai.openrouter: the tap on its link must open OpenRouter at once, with no
 * await before it. The key goes to annai, which keeps it for one provider; this plugin never stores it.
 * @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} KeyValue
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {any} L10n annai.l10n: its words on annai's screens, where every one of these goes (none is kept or read by a model)
 */
export const AUTH_URL = 'https://openrouter.ai/auth';
export const KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const SLOT = 'annai.openrouter';
const MAX_AGE = 15 * 60_000;
/** A sentence, then how to start again. @param {L10n} l10n @param {string} what */
const again = (l10n, what) => l10n.format.sentences(what, l10n.t`Tap Sign in with OpenRouter to start again.`);

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
 * @param {{ callback: string | null, provider?: string | null, storage?: KeyValue, now?: number }} c
 *   callback: annai's address, or null for a code to paste; provider: the provider a new key is for, or null for a new provider
 */
export async function signInUrl({ callback, provider = null, storage = localStorage, now = Date.now() }) {
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
  storage.setItem(SLOT, JSON.stringify({ verifier, state, at: now, mode: callback ? 'callback' : 'code', url, provider }));
  return url;
}

/**
 * The sign-in for an iPhone Home Screen app, ready before the tap: Safari opens a page only from the tap
 * itself, not after an await. One still waiting for its code, for the same provider, is kept (same address,
 * same verifier), so a redraw, or annai reopened after the trip to Safari, still takes the code.
 * @param {{ provider?: string | null, storage?: KeyValue, now?: number }} [c]
 * @returns {Promise<{ url: string, pending: boolean }>} pending: one was already waiting
 */
export async function codeSignIn({ provider = null, storage = localStorage, now = Date.now() } = {}) {
  const saved = waiting(storage);
  if (saved?.mode === 'code' && typeof saved.url === 'string' && (saved.provider ?? null) === provider && now - saved.at <= MAX_AGE) return { url: saved.url, pending: true };
  if (saved && !(now - saved.at <= MAX_AGE)) storage.removeItem(SLOT); // an expired one goes, even if no new one can be made
  return { url: await signInUrl({ callback: null, provider, storage, now }), pending: false };
}

/**
 * The tap on that link: annai's 15 minutes count from here (fix pass). Synchronous, as the tap must open the page.
 * @param {string} url the link's address @param {{ storage?: KeyValue, now?: number }} [c]
 * @returns {boolean} false: no sign-in waits for this address any more, so the link needs a new one
 */
export function tapCode(url, { storage = localStorage, now = Date.now() } = {}) {
  const saved = waiting(storage);
  if (saved?.mode !== 'code' || saved.url !== url) return false;
  storage.setItem(SLOT, JSON.stringify({ ...saved, at: now }));
  return true;
}

/**
 * Trades the code for a key. The verifier is used once. A code that came back in the address must carry
 * the state this browser sent (otherwise anyone could hand annai a code for their own account: login CSRF);
 * a pasted code is taken only in a sign-in that asked for one.
 * @param {{ code: string, state: string | null, pasted?: boolean, fetch?: Fetch, storage?: KeyValue, now?: number, l10n: L10n }} c
 * @returns {Promise<string>} the key
 */
export async function exchange({ code, state, pasted = false, fetch: get = (url, init) => fetch(url, init), storage = localStorage, now = Date.now(), l10n }) {
  const { t } = l10n;
  if (!code.trim()) throw new Error(t`Paste the code OpenRouter showed you, then tap Connect.`);
  const saved = waiting(storage);
  if (!saved) throw new Error(t`annai has no sign-in waiting for this code: it was used already, or began in another browser.`);
  if (now - saved.at > MAX_AGE) {
    storage.removeItem(SLOT); // so the next tap starts a new one
    throw new Error(again(l10n, t`This sign-in has expired.`));
  }
  const ours = pasted ? saved.mode === 'code' : saved.mode === 'callback' && typeof state === 'string' && state === saved.state;
  if (!ours) throw new Error(t`This sign-in didn't start in this browser, so annai ignored it.`);
  /** @type {Response} */
  let res;
  try {
    res = await get(KEYS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), code_verifier: saved.verifier, code_challenge_method: 'S256' }),
      redirect: 'manual', // the code and verifier buy a key (fix pass)
    });
  } catch {
    throw new Error(t`annai couldn't reach OpenRouter. Check the connection and try again.`);
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new Error(again(l10n, t`OpenRouter answered with a redirect, which annai doesn't follow with your sign-in.`));
  // 403: the code is wrong, used or older than 10 minutes. The same sign-in takes a new code.
  if (res.status === 403) throw new Error(t`OpenRouter didn't take the code: a code works once, for 10 minutes. Tap Sign in with OpenRouter to get a new one.`);
  if (!res.ok) throw new Error(again(l10n, t`OpenRouter didn't accept the sign-in (HTTP ${res.status}).`));
  const body = await res.json().catch(() => ({}));
  if (typeof body?.key !== 'string' || !body.key) throw new Error(again(l10n, t`OpenRouter didn't send a key.`));
  storage.removeItem(SLOT);
  return body.key;
}

/**
 * OpenRouter's free models used up for the day (or the minute): its words ask for credits, but no account
 * ran out, so it is too many requests for now (seen as a 429 and as a 402). @param {number} _status @param {string} body
 */
export function freeLimit(_status, body) {
  try {
    return /free-models-per-(day|min)/.test(String(JSON.parse(body)?.error?.message)) ? 'rate' : null;
  } catch {
    return null;
  }
}

/** An error's words for the screen: annai's own carry them (shown). @param {unknown} e */
const words = (e) => String(/** @type {any} */ (e)?.shown ?? /** @type {any} */ (e)?.message ?? e);

/**
 * The setup annai.providers.setup takes. env: annai.l10n, annai.ui.card, and the browser's storage and fetch, stood in for in tests.
 * @param {{ l10n: L10n, card?: (c: { tone?: string, title: string, body?: string }) => void, storage?: KeyValue, fetch?: Fetch }} env
 */
export function openRouter(env) {
  const { l10n } = env;
  const { t } = l10n;
  const store = () => env.storage ?? localStorage;
  /** A sign-in coming back is being finished: its button waits. */
  let finishing = false;
  /**
   * Gets the key (get) for the provider the sign-in was for, or for a new one with free models in the chat roles
   * still empty, its speech behind the free entries; annai asks for it once all else is in place.
   * @param {any} ui @param {string | null} provider @param {() => Promise<string>} get
   */
  const connect = async (ui, provider, get) => {
    let asked = false;
    const key = () => {
      asked = true;
      return get();
    };
    try {
      if (provider) await ui.keep(provider, key);
      else await ui.add({ key, roles: 'free' });
    } catch (e) {
      throw asked ? e : new Error(l10n.format.sentences(words(e), t`Nothing was sent to OpenRouter yet: try again.`));
    }
    env.card?.({
      tone: 'ok', title: t`Signed in with OpenRouter`,
      body: provider ? t`annai keeps the new key for OpenRouter's chat, transcription and voices.`
        : t`Shiori thinks with free models to start, so trying annai costs nothing. annai also added OpenRouter's transcription and voices, behind the phone's own dictation and the browser voice. Its free voice comes first: each sentence it says uses one of the free requests a day the chat models use too. The others cost a little, from credits you buy at OpenRouter. To use them first, move them up under Roles.`,
    });
  };
  return {
    classify: freeLimit,
    /** annai's address came back with OpenRouter's code. @param {URLSearchParams} params @param {any} ui */
    async returned(params, ui) {
      const code = params.get('code');
      if (!code) throw new Error(again(l10n, t`OpenRouter sent no code back.`));
      const provider = waiting(store())?.provider ?? null;
      finishing = true;
      ui.render();
      try {
        await connect(ui, provider, () => exchange({ code, state: params.get('state'), fetch: env.fetch, storage: store(), l10n }));
      } finally {
        finishing = false;
      }
    },
    /** Sign in with OpenRouter: for a new provider (null), or a new key for one. @param {any} ui @param {{ id: string, key: boolean } | null} provider */
    panel(ui, provider) {
      const { h } = ui;
      const target = provider?.id ?? null;
      const label = provider?.key ? t`Sign in again` : t`Sign in with OpenRouter`;
      const status = h('p', { class: 'sub', role: 'status' });
      const codeSlot = h('div', {});
      /** @type {HTMLElement} */
      let btn;
      if (ui.returnsElsewhere) {
        // A real link, its address made before the tap (the user, 2026-10-18: after an await, nothing opened).
        const link = h('a', { class: provider ? 'btn' : 'btn pri', target: '_blank', rel: 'noopener noreferrer', 'aria-disabled': 'true' }, label);
        /** The address for the tap: the sign-in still waiting for its code, or a new one once that has expired. */
        const prepare = () => codeSignIn({ provider: target, storage: store() }).then(({ url, pending }) => {
          link.setAttribute('href', url);
          link.removeAttribute('aria-disabled');
          if (!pending) codeSlot.replaceChildren();
          else if (!codeSlot.firstChild) codeSlot.replaceChildren(paste());
        }, (e) => { status.textContent = words(e); });
        /** The paste box, for the code OpenRouter showed. */
        const paste = () => {
          const code = h('input', { id: 'openrouter-code', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
          const go = h('button', {
            class: 'btn pri', type: 'button',
            onclick: async () => {
              go.disabled = true;
              status.textContent = t`Connecting to OpenRouter…`;
              try {
                await connect(ui, waiting(store())?.provider ?? target, () => exchange({ code: code.value, state: null, pasted: true, fetch: env.fetch, storage: store(), l10n }));
                ui.render();
              } catch (e) {
                status.textContent = words(e);
                go.disabled = false;
                await prepare(); // an expired sign-in makes way for a new one
              }
            },
          }, t`Connect`);
          return h('div', {},
            h('p', { class: 'sub', text: t`OpenRouter opens in Safari. Sign in there; it then shows a code, which works for 10 minutes. Copy it, come back to annai, and paste it here.` }),
            h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', { class: 'field-label', text: t`Paste the code OpenRouter showed you` }), code), h('div', { class: 'acts' }, go)));
        };
        link.addEventListener('click', (/** @type {Event} */ e) => {
          const href = link.getAttribute('href');
          if (!href) return e.preventDefault();
          // annai's 15 minutes start now. No sign-in waits for this address (it was used, or dropped): a new one, for the next tap.
          if (!tapCode(href, { storage: store() })) {
            e.preventDefault();
            status.textContent = provider?.key ? t`annai has made a new sign-in: tap it again.` : t`annai has made a new sign-in: tap Sign in with OpenRouter again.`;
            return prepare();
          }
          if (!codeSlot.firstChild) codeSlot.replaceChildren(paste());
        });
        prepare();
        btn = link;
      } else {
        btn = h('button', {
          class: provider ? 'btn' : 'btn pri', type: 'button', disabled: finishing,
          onclick: async () => {
            try {
              const url = await signInUrl({ callback: `${location.origin}/`, provider: target, storage: store() });
              ui.expectReturn(); // once there is an address to go to: a failed one leaves no return expected
              location.assign(url);
            } catch (e) {
              status.textContent = words(e);
            }
          },
        }, label);
      }
      return h('div', {},
        h('p', provider ? { class: 'sub', text: provider.key ? t`Sign in again for a new key, in place of the one saved.` : t`Sign in with OpenRouter for a key, or give one below.` }
          : { text: t`Sign in with OpenRouter to get one key for many models. annai starts you on free models (50 requests a day), so trying it costs nothing. It also adds OpenRouter's transcription and voices, a free one among them; the phone's own dictation and voice stay first.` }),
        h('div', { class: 'acts' }, btn),
        codeSlot,
        status);
    },
  };
}

/** @param {any} annai */
export function activate(annai) {
  return annai.providers.setup(openRouter({ fetch: annai.net.fetch, card: annai.ui.card, l10n: annai.l10n }));
}
