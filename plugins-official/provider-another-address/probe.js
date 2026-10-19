/**
 * Another address looks for what a server offers, at no cost (spec §9.8; the provider plan's decision 18).
 * It asks for the model list, and sends an empty request to each path annai knows: no model and no input,
 * and for a chat path an output limit of one token, as a lax server may run an empty chat all the same
 * (KoboldCpp's messages default to none), so at most one token is made. How the server answers says what is there:
 * - "bad request" (400, 415, 422) or a key refused (401, 403): the path is there;
 * - "not found" (404), "method not allowed" (405) or "not implemented" (501): it isn't;
 * - a 2xx that isn't JSON is a web page (a web app's fallback), so the path isn't there;
 * - a request the browser couldn't make is "blocked" when the server is there all the same (it doesn't
 *   allow web apps: no CORS), and "unreachable" when it isn't, as the Test button tells them apart;
 * - 429, other 5xx, a redirect (never followed) and anything else are unknown.
 * A control request to a path that can't exist, sent the same way, guards the reading: a server that
 * answers it as it answers a real path (auth in front of everything, JSON for anything) says nothing by
 * that answer, though a list of models is a list whatever else it answers. An address with no path is
 * looked at with /v1 first, and as given only when /v1 finds nothing there (a server that lists its models
 * at both may talk only at /v1, as the user's Unsloth Studio does). Anthropic Messages is asked at the
 * address without its /v1 (its root), as that protocol adds /v1/messages itself, once. Every request goes
 * to the address's own origin, never past a redirect, at most four at a time; the key goes only in the
 * header each protocol sends it in.
 * @typedef {'chat-completions' | 'responses' | 'messages' | 'transcription' | 'voice'} AbilityId
 * @typedef {{ state: 'found' | 'absent' | 'blocked' | 'unreachable' | 'unknown', status?: number, why?: string, count?: number,
 *   speech?: { transcription: boolean, voice: boolean } }} Finding
 *   count: the model list's length; speech: whether it names a transcription model, or a voice
 * @typedef {{ base: string, root: string, list: Finding, abilities: Record<AbilityId, Finding> }} Probe
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {{ fetch: Fetch, reach: (url: string) => Promise<boolean>, problem: (url: string) => string | null }} Io
 *   fetch: annai's traced fetch; reach: whether a server answers at all (a no-cors request, which any server lets
 *   through); problem: annai's check of an address a key may go to (https, or http only for this device)
 * @typedef {{ status: number, json?: any, redirect?: boolean } | { failed: true, slow: boolean }} Answer
 */

/** What is looked for, in the order shown: each ability's path, from the address or (Anthropic Messages) its root. */
export const LOOKS = /** @type {const} */ ([
  { id: 'chat-completions', name: 'Chat Completions', path: '/chat/completions', root: false, body: { max_tokens: 1 } },
  { id: 'responses', name: 'OpenAI Responses', path: '/responses', root: false, body: { max_output_tokens: 1 } },
  { id: 'messages', name: 'Anthropic Messages', path: '/v1/messages', root: true, body: { max_tokens: 1 } },
  { id: 'transcription', name: 'Transcription', path: '/audio/transcriptions', root: false, body: {} },
  { id: 'voice', name: 'Voice', path: '/audio/speech', root: false, body: {} },
]);
const WAIT_MS = 15_000;
const AT_ONCE = 4;
const THERE = new Set([400, 401, 403, 415, 422]);
const NOT_THERE = new Set([404, 405]);
/** Model names that say what a listed model does (a list says little more): one that listens, one that speaks. */
const HEARS = /whisper|transcri|parakeet|canary|voxtral|sensevoice|moonshine|\basr\b|\bstt\b/i;
const SPEAKS = /\btts\b|kokoro|orpheus|piper|xtts|chatterbox|speech|voice/i;

/**
 * The address as annai will use it, or why it can't be: one annai sends keys to (problem), alone.
 * @param {string} address @param {Io['problem']} problem
 */
export function baseOf(address, problem) {
  const typed = String(address ?? '').trim();
  if (!typed) throw new Error("Give the server's address first, with https:// in front.");
  const wrong = problem(typed);
  // In words that don't show what was typed: a key pasted into the address field stays off the screen.
  if (wrong) throw new Error(wrong.split(typed).join('What you typed'));
  const u = new URL(typed);
  if (u.username || u.password || u.search || u.hash) throw new Error('Give the address alone, without a name and password, "?…" or "#…": a key goes in its own field.');
  return `${u.origin}${u.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '')}`;
}

/**
 * Looks at an address, at no cost. @param {string} address @param {string | null} key @param {Io} io @returns {Promise<Probe>}
 */
export async function probe(address, key, io) {
  const base = baseOf(address, io.problem);
  const k = key?.trim() || null;
  if (k && !/^[\x21-\x7e]+$/.test(k)) throw new Error("The key has a character no key has, such as a space or a line break: paste it again.");
  /** @type {Look} one control path for the whole look, and each answer kept, so a request asked twice is sent once */
  const c = { key: k, io, nowhere: `annai-probe-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')}`, asked: new Map(), send: limit(AT_ONCE) };
  if (new URL(base).pathname !== '/') return look(base, c);
  // An address with no path: /v1 first (a server may list its models at both, and talk only at /v1), then as given if that finds nothing.
  const v1 = await look(`${base}/v1`, c);
  return found(v1) ? v1 : look(base, c);
}

/**
 * @typedef {{ key: string | null, io: Io, nowhere: string, asked: Map<string, Promise<Answer>>, send: <T>(work: () => Promise<T>) => Promise<T> }} Look
 */

/** Whether anything at the address itself was found (Messages is at its root either way). @param {Probe} r */
const found = (r) => [r.list, ...LOOKS.filter((l) => !l.root).map((l) => r.abilities[l.id])].some((f) => f.state === 'found');

/** Work run at most n at a time, each started when its turn comes. @param {number} n */
function limit(n) {
  let out = 0;
  /** @type {(() => void)[]} */
  const waiting = [];
  const next = () => {
    if (out >= n || !waiting.length) return;
    out += 1;
    /** @type {() => void} */ (waiting.shift())();
  };
  return (/** @type {() => Promise<any>} */ work) => new Promise((resolve, reject) => {
    waiting.push(() => work().then(resolve, reject).finally(() => {
      out -= 1;
      next();
    }));
    next();
  });
}

/** @param {Record<string, string>} headers @param {object} [body] @returns {RequestInit} */
const post = (headers, body = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** One look at one address. @param {string} base @param {Look} c @returns {Promise<Probe>} */
async function look(base, c) {
  const { key, io, nowhere } = c;
  const origin = new URL(base).origin;
  const root = base.replace(/\/v1$/i, '');
  /** @type {Record<string, string>} */
  const bearer = key ? { authorization: `Bearer ${key}` } : {};
  // As Anthropic Messages sends it, browser access and all, so a server answers as it would answer the real calls.
  /** @type {Record<string, string>} */
  const anthropic = { 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', ...(key ? { 'x-api-key': key } : {}) };
  /** @type {[string, string, RequestInit][]} what is asked: a name, the address, how */
  const asks = [
    ['list', `${base}/models`, { headers: bearer }],
    ['control', `${base}/${nowhere}`, post(bearer)],
    ['control-messages', `${root}/v1/${nowhere}`, post(anthropic)],
    ...LOOKS.map((l) => /** @type {[string, string, RequestInit]} */ ([l.id, `${l.root ? root : base}${l.path}`, post(l.root ? anthropic : bearer, l.body)])),
  ];
  /** @type {Record<string, Answer>} */
  const got = Object.fromEntries(await Promise.all(asks.map(async ([name, url, init]) => {
    const once = `${init.method ?? 'GET'} ${url} ${name.endsWith('messages') ? 'anthropic' : ''}`;
    if (!c.asked.has(once)) c.asked.set(once, c.send(() => ask(url, init, origin, io.fetch)));
    return [name, await c.asked.get(once)];
  })));
  /** @type {Promise<boolean> | undefined} the server checked for once, if a request couldn't be made */
  let there;
  /** @param {string} name @param {Answer | undefined} control @returns {Promise<Finding>} */
  const finding = async (name, control) => {
    const a = got[name];
    if (!('failed' in a)) return read(a, control, key, name === 'list');
    if (a.slow) return { state: 'unreachable', why: `It didn't answer within ${WAIT_MS / 1000} seconds.` };
    there ??= io.reach(`${base}/models`).catch(() => false);
    return (await there) ? { state: 'blocked', why: "It doesn't allow web apps like annai to call it (no CORS)." } : { state: 'unreachable', why: "annai couldn't reach it." };
  };
  const list = await finding('list', got.control);
  /** @type {Record<string, Finding>} */
  const abilities = {};
  for (const l of LOOKS) abilities[l.id] = await finding(l.id, got[l.root ? 'control-messages' : 'control']);
  return { base, root, list, abilities: /** @type {Record<AbilityId, Finding>} */ (abilities) };
}

/**
 * One request, at the address's origin only, never past a redirect, given up on after a while.
 * @param {string} url @param {RequestInit} init @param {string} origin @param {Fetch} get @returns {Promise<Answer>}
 */
async function ask(url, init, origin, get) {
  if (new URL(url).origin !== origin) throw new Error(`annai looks only at ${origin}.`); // can't happen: every address is made from it
  const signal = AbortSignal.timeout(WAIT_MS);
  try {
    const res = await get(url, { ...init, redirect: 'manual', cache: 'no-store', signal });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return { status: res.status, redirect: true };
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status };
    }
    /** @type {any} */
    let json;
    try {
      const j = JSON.parse(await res.text());
      if (j && typeof j === 'object') json = j;
    } catch {
      // not JSON: a web page
    }
    return { status: res.status, json };
  } catch {
    return { failed: true, slow: signal.aborted };
  }
}

/**
 * What one answer says, read against the control's (the same kind of request to a path that can't exist).
 * @param {{ status: number, json?: any, redirect?: boolean }} a @param {Answer | undefined} c @param {string | null} key @param {boolean} list
 * @returns {Finding}
 */
function read(a, c, key, list) {
  const s = a.status;
  if (a.redirect) return { state: 'unknown', ...(s ? { status: s } : {}), why: "It answered with a redirect, which annai doesn't follow." };
  const control = c && !('failed' in c) && !c.redirect ? c : null;
  // The answer an address that can't exist got too says nothing.
  const same = control?.status === s && (control.json === undefined) === (a.json === undefined);
  const anyAddress = "at any address, even one that can't exist, so annai can't tell from it.";
  if (s >= 200 && s < 300) {
    if (a.json === undefined) return { state: 'absent', status: s, why: 'A web page answered, not an API.' };
    // A list of models is a list, whatever the server answers elsewhere.
    const items = list && (Array.isArray(a.json.data) ? a.json.data : Array.isArray(a.json.models) ? a.json.models : null);
    if (items) {
      const names = items.map((/** @type {any} */ m) => String(m?.id ?? m?.name ?? m?.model ?? ''));
      return { state: 'found', status: s, count: items.length, speech: { transcription: names.some((x) => HEARS.test(x)), voice: names.some((x) => SPEAKS.test(x)) } };
    }
    if (same) return { state: 'unknown', status: s, why: `It answers this way ${anyAddress}` };
    return list ? { state: 'unknown', status: s, why: 'It answered, but not with a list of models.' } : { state: 'found', status: s };
  }
  if (NOT_THERE.has(s)) return { state: 'absent', status: s };
  if (s === 501) return { state: 'absent', status: s, why: "The server says it doesn't do this." };
  if (THERE.has(s)) {
    const auth = s === 401 || s === 403;
    if (same && auth) return { state: 'unknown', status: s, why: key ? `It refuses the key ${anyAddress} Check the key, then look again.` : 'It asks for a key before it says what it has: give the key, then look again.' };
    if (same) return { state: 'unknown', status: s, why: `It answers HTTP ${s} ${anyAddress}` };
    if (auth && !control) return { state: 'unknown', status: s, why: key ? "It refused the key, and annai couldn't check how it answers an address that can't exist. Check the key, then look again." : "It asks for a key, and annai couldn't check whether it asks at every address: give the key, then look again." };
    return { state: 'found', status: s, ...(auth ? { why: key ? "It didn't take the key: check it." : 'It asks for a key.' } : {}) };
  }
  if (s === 429) return { state: 'unknown', status: s, why: 'It is busy (too many requests): look again in a minute.' };
  if (s >= 500) return { state: 'unknown', status: s, why: `It had a problem of its own (HTTP ${s}): look again later.` };
  return { state: 'unknown', status: s, why: `It answered HTTP ${s}, which says neither yes nor no.` };
}
