import { t } from './l10n.js';
import { size } from './intl.js';

/**
 * What was wrong with reaching a server or with its answer, as data (an error carries it as said): where is the server as the user knows
 * it; info, the browser's own words for a request it couldn't make. The log and a model read the error's English message; a screen shows
 * its shown words, made here, and a hold or a pack's failure keeps said (backup.js, pack/download.js): the one vocabulary for servers.
 * quiet: nothing came from the server for QUIET_MS, and annai stopped waiting (quietly).
 * @typedef {{ code: 'status', where: string, status: number } | { code: 'unreadable' | 'cut' | 'quiet', where: string } | { code: 'too-much', where: string, mb: number }
 *   | { code: 'unreachable', where: string, info?: string }} AnswerSaid
 */

/** The codes answerWords knows. */
export const ANSWER_CODES = new Set(['status', 'unreadable', 'cut', 'too-much', 'unreachable', 'quiet']);

/** An answer's problem in the screens' words, from its data. @param {AnswerSaid} s */
export function answerWords(s) {
  const { where } = s;
  if (s.code === 'unreachable') return s.info ? t`annai couldn't reach ${where} (${s.info}). Is the device offline?` : t`annai couldn't reach ${where}. Is the device offline?`;
  if (s.code === 'status') return t`${where} answered ${s.status}.`;
  if (s.code === 'unreadable') return t`${where} sent an answer annai can't read.`;
  if (s.code === 'too-much') return t`${where} sent more than annai reads (${size(s.mb * 1_048_576)}).`;
  if (s.code === 'quiet') return t`${where} stopped answering. Check the connection and try again.`;
  return t`${where}'s answer was cut off.`;
}

/** An error by the shown rule: message in annai's English, said its data, shown its words. @param {string} en @param {AnswerSaid} said */
const fault = (en, said) => Object.assign(new Error(en), { said, shown: answerWords(said) });

/**
 * How long a server may go with nothing coming for any request annai makes to it through quietly, answers and parts of bodies alike:
 * past it, every request to it still waiting ends. A fetch has no limit of its own: on a connection that goes dead (open, sending
 * nothing) an official install and the line behind it (dl-limit-next, 2026-11-17), and an install from an address, its Update and the
 * update checks that ask it (addr-limit-next, 2026-11-18), waited until annai was restarted.
 * The server's silence, not one request's: on one connection an answer waits behind bytes already sent for other requests. On a real
 * link (a paced TCP forwarder between Chromium and annai.guide, 2026-11-17), PDF pages (29 files, 2.5 MB on the wire, six at a time)
 * had small files wait 25 to 33 s for their answer at 400 kbps with 2 s round trips, and 102 to 134 s at 100 kbps, while the connection
 * was busy the whole time; a limit on one request's own silence ended that install at 400 kbps, the site's let it finish at both (55 s and
 * 209 s), the longest silence of the site in either 4.4 s. The browser's throttling (Chromium's DevTools) can't show such a wait: it
 * delays each request inside the browser after its bytes came, so nothing queues on the connection.
 * The number: the largest install a provider brings (gemini-api, 8 files) on the same real link at 50 kbps with 3 s round trips took 7.2 s whole,
 * and no request waited more than 3.4 s for anything. The forwarder took the browser's TCP handshake itself and no name was looked up,
 * so a real cold connection's first answer comes about two round trips later than the 4.4 s above (some 8 to 10 s at 2 to 3 s round
 * trips, estimated, not measured); 20 s is 1.9 to 2.4 times that, with room on top for a radio stall of some seconds (a tunnel, a
 * handover); parts of a download 20 s or more apart, with nothing else from the server between them, end it, as a dead connection's
 * silence does. An address's server is held to the same number: it is sized from the link (its round trips, a cold connection's
 * handshakes, a stall), which is the same whatever server a file comes from, and it leaves the update check's 45 s (limitMs,
 * src/ui/updates.js) room: its parts run side by side, and the longest, annai's catalog and then its translations, is two silences (40 s).
 * Not a limit on the whole request: at 100 kbps a small file's answer came 134 s after it was asked for, and a limit that long would
 * hold a dead connection as long.
 */
export const QUIET_MS = 20_000;

/**
 * Each server's requests waiting now, by origin: what starts each one's silence over. Something coming for any request to a server starts
 * all of its requests' over (the server's silence), and nothing from another server does: annai's own site's traffic never keeps a dead
 * address's request open. A request that starts has only its own start to count from.
 * @type {Map<string, Set<() => void>>}
 */
const waiting = new Map();

/**
 * Asks for url (get(url, init), init with a signal of this request's own) and reads its answer with read, which is handed the answer
 * with a body that counts each part as it comes. Once nothing has come from the server for QUIET_MS (see there) the request ends by its
 * signal, and this throws that the server stopped answering (said.code quiet), whatever the request or the read threw then (an engine's
 * AbortError, a TypeError, a wrapper's own error): the same error is the signal's reason, which the trace writes for a request that never
 * got its answer (it writes a request at its answer: a stall after the headers shows the status the server gave; the words on the screen
 * are the record). Both awaits are raced against the end, as agent/tools.js and plugins.js race theirs, so it holds whatever get waits on
 * before it asks (tracedFetch reads the keys it blanks) and a body an engine leaves open. An answer that isn't ok, or has no body, is read
 * as it is (a Response can't be built with a body for 204, 205 or 304, and both engines hand one); an ok one is read with its status
 * dropped, which neither reader looks at. The server is the origin the address names, a relative one read as the page's (fetch reads it
 * so); with no page (a test's stand-in), one for all.
 * @template T
 * @param {(url: string, init: RequestInit) => Promise<Response>} get @param {string} url
 * @param {(res: Response) => Promise<T>} read @param {RequestInit} [init] @returns {Promise<T>}
 */
export async function quietly(get, url, read, init = {}) {
  /** @type {URL | null} */
  let at = null;
  try {
    at = new URL(url, globalThis.location?.href);
  } catch {
    // no page to read a relative address against
  }
  const key = at?.origin ?? '';
  const where = at?.host ?? url;
  const server = waiting.get(key) ?? new Set();
  waiting.set(key, server);
  const heard = () => {
    for (const startOver of server) startOver();
  };
  const stop = new AbortController();
  /** @type {() => void} */
  let unhook = () => {};
  /** Rejects with the end's reason; the first race below handles it. @type {Promise<never>} */
  const ended = new Promise((_, end) => {
    const onAbort = () => end(stop.signal.reason);
    stop.signal.addEventListener('abort', onAbort, { once: true });
    unhook = () => stop.signal.removeEventListener('abort', onAbort);
  });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const startOver = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop.abort(fault(/* en */ `${where} stopped answering: nothing came for ${QUIET_MS / 1000} seconds.`, { code: 'quiet', where })), QUIET_MS);
  };
  server.add(startOver);
  startOver();
  try {
    const res = await Promise.race([get(url, { ...init, signal: stop.signal }), ended]);
    heard();
    if (!res.ok || !res.body) return await Promise.race([read(res), ended]);
    // Each part of the body that comes starts the silence again.
    const body = res.body.pipeThrough(new TransformStream({ transform: (part, out) => { heard(); out.enqueue(part); } }));
    return await Promise.race([read(new Response(body, { headers: res.headers })), ended]);
  } catch (e) {
    throw stop.signal.aborted ? stop.signal.reason : e;
  } finally {
    unhook();
    server.delete(startOver);
    if (!server.size) waiting.delete(key);
    clearTimeout(timer);
  }
}

/** The most of a server's answer annai reads as JSON: 8 MiB. */
export const ANSWER_MAX = 8 * 1024 * 1024;

/**
 * A server's answer, as JSON, read no further than max (answerBytes). Whatever is wrong with it (an
 * error status, cut off, too large, not JSON) is the server's doing, so it is a plain Error that says
 * so: a TypeError or SyntaxError would count as a bug in the plugin that asked (spec §5.5), and three
 * of those turn the plugin off. A stopped request stays an AbortError.
 * @param {Response} res @param {string} where the server, as the user knows it ("en.wikipedia.org")
 * @param {number} [max] the most bytes read
 * @returns {Promise<any>}
 */
export async function answerJSON(res, where, max = ANSWER_MAX) {
  const bytes = await answerBytes(res, where, max);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw fault(/* en */ `${where} sent an answer annai can't read.`, { code: 'unreadable', where });
  }
}

/**
 * A server's answer, as bytes, read no further than max. Whatever is wrong with it (an error status,
 * cut off, too large) is a plain Error that says so; a stopped request stays an AbortError.
 * @param {Response} res @param {string} where the server, as the user knows it @param {number} [max] the most bytes read
 * @returns {Promise<Uint8Array>}
 */
export async function answerBytes(res, where, max = ANSWER_MAX) {
  if (!res.ok) throw Object.assign(fault(/* en */ `${where} answered ${res.status}.`, { code: 'status', where, status: res.status }), { status: res.status });
  const mb = Math.max(1, Math.round(max / 1_048_576));
  const tooMuch = () => fault(/* en */ `${where} sent more than annai reads (${mb} MB).`, { code: 'too-much', where, mb });
  if (Number(res.headers.get('content-length')) > max) {
    res.body?.cancel().catch(() => {});
    throw tooMuch();
  }
  /** @type {Uint8Array[]} */
  const chunks = [];
  let n = 0;
  let over = false;
  try {
    const reader = res.body?.getReader();
    for (;;) {
      const step = reader ? await reader.read() : { done: true, value: undefined };
      if (step.done || !step.value) break;
      n += step.value.byteLength;
      if (n > max) {
        over = true;
        await reader?.cancel().catch(() => {});
        break;
      }
      chunks.push(step.value);
    }
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
    throw fault(/* en */ `${where}'s answer was cut off.`, { code: 'cut', where });
  }
  if (over) throw tooMuch();
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
