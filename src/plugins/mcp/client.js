import { answerJSON, ANSWER_MAX } from '../../core/answer.js';
import { sse } from '../../core/llm/sse.js';
import { isBase64 } from '../../core/bytes.js';
import { t } from '../../core/l10n.js';
import { num } from '../../core/intl.js';

/**
 * annai's MCP client (spec §5.1): MCP's Streamable HTTP transport, as a web app speaks it. Each
 * request is one JSON-RPC message POSTed to the server's address; the answer comes as JSON or as an
 * SSE stream. What annai reads is guarded: whatever a server sends, a failure is an McpError in
 * words, never a SyntaxError or TypeError (which would count against the plugin): its message for Shiori, in English, and shown
 * for the screen (localization design, section 7).
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 */

/** The protocol versions annai speaks (milestone 8c, choice 2), and the one it asks for. */
export const SUPPORTED = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
export const ASKED = '2025-06-18';
/** Pages of tools annai asks for, and the most tools it keeps reading. */
const MAX_PAGES = 100;
const MAX_LISTED = 500;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_MAX = 5 * 1024 * 1024;

export class McpError extends Error {
  /** @type {number | undefined} */ status;
  /**
   * @param {'auth' | 'cors' | 'session' | 'server' | 'answer' | 'network'} kind @param {string} message Shiori's words, English
   * @param {string} shown the same in the screens' words @param {number} [status] the HTTP status a server answered with
   */
  constructor(kind, message, shown, status) {
    super(message);
    this.name = /* en */ 'McpError';
    this.kind = kind;
    this.shown = shown;
    if (status !== undefined) this.status = status;
  }
}

/** A stop by the user or a time limit stays what it is. @param {unknown} e */
const isStop = (e) => /** @type {any} */ (e)?.name === 'AbortError' || /** @type {any} */ (e)?.name === 'TimeoutError';
/**
 * The stop behind a failure, or null: the request's own reason once it was stopped, however the fetch
 * or the read said so (a body read cut by the time limit, a traced fetch's words), else e when it is one.
 * @param {unknown} e @param {AbortSignal} [signal]
 */
const stopOf = (e, signal) => (signal?.aborted ? signal.reason : isStop(e) ? e : null);

export class McpClient {
  /** @type {string | null} */ #session = null;
  /** @type {string | null} the protocol version agreed on: set once connected */ #version = null;
  #id = 0;
  /** @type {{ done: Promise<void>, stop: AbortController, waiting: number } | null} the session being started, and how many calls wait for it */
  #connecting = null;
  /** Set once the session is ended for good (close, ending): no other starts, and every call says the server was removed (minors 3). */
  #closed = false;
  #stateless;

  /**
   * @param {{ url: string | (() => Promise<string>), server: string, auth: () => Promise<Record<string, string>>, stateless?: boolean }} o
   *   url: the server's address, or where to read it (it may hold a key, so annai keeps it in secrets);
   *   stateless: calls go with no session started first, one request each (annai's own search providers)
   */
  constructor({ url, server, auth, stateless = false }) {
    this.url = url;
    this.server = server;
    this.auth = auth;
    this.#stateless = stateless;
  }

  /** Starts a session: initialize, then notifications/initialized. @param {{ fetch: Fetch, signal?: AbortSignal }} o */
  async connect(o) {
    this.#session = null;
    this.#version = null;
    // Read first: a removal that overtakes this start takes the server's secret, and the session it got is still to be ended.
    const [address, auth] = [await this.#address(), await this.auth()];
    const result = await this.#request('initialize', { protocolVersion: ASKED, capabilities: {}, clientInfo: { name: 'annai', version: '1' } }, o, true);
    if (this.#closed) {
      // Closed while it started: the session it got is ended too, where and as it was started.
      const session = this.#session;
      this.#session = null;
      if (session) await ender(address, auth, session)(o);
      throw this.#removed();
    }
    const v = String(result?.protocolVersion ?? '');
    if (!SUPPORTED.includes(v)) {
      throw new McpError('server', /* en */ `The MCP server ${this.server} speaks MCP ${v || 'an unknown version'}; annai speaks 2025-03-26 to 2025-11-25.`,
        v ? t`The MCP server ${this.server} speaks MCP ${v}; annai speaks 2025-03-26 to 2025-11-25.` : t`The MCP server ${this.server} speaks an unknown version of MCP; annai speaks 2025-03-26 to 2025-11-25.`);
    }
    this.#version = v;
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, null, o);
  }

  /** Every tool the server has (up to 500), page by page. @param {{ fetch: Fetch, signal?: AbortSignal }} o @returns {Promise<any[]>} */
  async listTools(o) {
    return this.#inSession(o, async () => {
      /** @type {any[]} */
      const tools = [];
      /** @type {Set<string>} a tool listed twice is listed once, the first time (fix pass 8c-5) */
      const seen = new Set();
      /** @type {string | undefined} */
      let cursor;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await this.#request('tools/list', cursor ? { cursor } : {}, o);
        for (const t of Array.isArray(result?.tools) ? result.tools : []) {
          if (!t || typeof t.name !== 'string' || seen.has(t.name)) continue;
          seen.add(t.name);
          tools.push(t);
        }
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
        if (!cursor || tools.length >= MAX_LISTED) break;
      }
      return tools;
    });
  }

  /** Calls a tool; its result. @param {string} name @param {any} args @param {{ fetch: Fetch, signal?: AbortSignal }} o */
  async callTool(name, args, o) {
    const call = () => this.#request('tools/call', { name, arguments: args ?? {} }, o);
    if (this.#stateless) {
      try {
        return await call();
      } catch (e) {
        // A server that wants a session first refuses the bare call (400, 404, 405): start one, and keep to sessions from here.
        if (!(e instanceof McpError && e.kind === 'server' && (e.status === 400 || e.status === 404 || e.status === 405))) throw e;
        this.#stateless = false;
      }
    }
    return this.#inSession(o, call);
  }

  /** Ends the session, when the server can be reached (milestone 8c, choice 6). @param {{ fetch: Fetch, signal?: AbortSignal }} o */
  async close(o) {
    await (await this.ending())?.(o);
  }

  /**
   * Leaves the session, and gives what ends it on the server: the address and headers read now, so it
   * can be sent after its secret is gone (fix pass 8c-3), or null when there is no session.
   * @returns {Promise<((o: { fetch: Fetch, signal?: AbortSignal }) => Promise<void>) | null>}
   */
  async ending() {
    this.#closed = true;
    const session = this.#session;
    this.#session = null;
    this.#version = null;
    if (!session) return null;
    return ender(await this.#address(), await this.auth(), session);
  }

  /**
   * Runs work in a session, starting one first when there is none, and once again when the server
   * says the session ended.
   * @template T @param {{ fetch: Fetch, signal?: AbortSignal }} o @param {() => Promise<T>} work @returns {Promise<T>}
   */
  async #inSession(o, work) {
    await this.#ready(o);
    try {
      return await work();
    } catch (e) {
      // A request the removal overtook (its session gone, its server's answer cut) was for a server that is gone.
      if (this.#closed && !stopOf(e, o.signal)) throw this.#removed();
      if (!(e instanceof McpError) || e.kind !== 'session') throw e;
      this.#version = null;
      this.#session = null;
      await this.#ready(o);
      return work();
    }
  }

  /** A server's HTTP status, as a failure. @param {number} code @param {number} [status] kept on the error, for what judges it by */
  #answered(code, status) {
    return new McpError('server', /* en */ `The MCP server ${this.server} answered ${code}.`, t`The MCP server ${this.server} answered ${code}.`, status);
  }

  /** What a call to a closed client says. */
  #removed() {
    return new McpError('session', /* en */ `The MCP server ${this.server} was removed.`, t`The MCP server ${this.server} was removed.`);
  }

  /** The server's full address. */
  async #address() {
    return typeof this.url === 'function' ? this.url() : this.url;
  }

  /**
   * Waits for a session, starting one when none is being started. Calls that come meanwhile wait for
   * the same start, each until its own signal: the start stops only once every one of them stopped (minors 4).
   * @param {{ fetch: Fetch, signal?: AbortSignal }} o
   */
  async #ready(o) {
    if (this.#closed) throw this.#removed();
    if (this.#version || this.#stateless) return;
    let c = this.#connecting;
    if (!c) {
      const stop = new AbortController();
      const done = this.connect({ fetch: o.fetch, signal: stop.signal }).finally(() => { if (this.#connecting === c) this.#connecting = null; });
      c = this.#connecting = { done, stop, waiting: 0 };
    }
    const start = c;
    start.waiting++;
    const { signal } = o;
    if (!signal) return start.done;
    /** @type {() => void} */
    let leave = () => {};
    const left = new Promise((_, fail) => {
      leave = () => {
        if (--start.waiting === 0) start.stop.abort(signal.reason);
        fail(signal.reason);
      };
    });
    if (signal.aborted) leave();
    else signal.addEventListener('abort', leave, { once: true });
    try {
      await Promise.race([start.done, left]);
    } finally {
      signal.removeEventListener('abort', leave);
    }
  }

  /** One request, its result; a JSON-RPC error is the server's words. @param {string} method @param {any} params @param {{ fetch: Fetch, signal?: AbortSignal }} o @param {boolean} [init] */
  async #request(method, params, o, init = false) {
    const id = ++this.#id;
    const m = await this.#post({ jsonrpc: '2.0', id, method, params }, id, o, init);
    if (m?.error) {
      const said = m.error.message ?? m.error.code;
      throw new McpError('server', /* en */ `The MCP server ${this.server} said: ${String(said ?? 'an error')}`,
        said === undefined || said === null ? t`The MCP server ${this.server} answered with an error.` : t`The MCP server ${this.server} said: ${String(said)}`);
    }
    return m?.result;
  }

  /**
   * POSTs one message and reads the answer to it (null for a notification).
   * @param {any} body @param {number | null} id @param {{ fetch: Fetch, signal?: AbortSignal }} o @param {boolean} [init]
   */
  async #post(body, id, { fetch, signal }, init = false) {
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json', Accept: /* en */ 'application/json, text/event-stream', ...(await this.auth()) };
    if (this.#version) headers['MCP-Protocol-Version'] = this.#version;
    if (this.#session) headers['Mcp-Session-Id'] = this.#session;
    /** @type {Response} */
    let res;
    try {
      res = await fetch(await this.#address(), { method: 'POST', headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    } catch (e) {
      if (stopOf(e, signal)) throw stopOf(e, signal);
      // A browser says no more than that a request failed; offline, it is no use to suggest CORS (minors 8).
      if (globalThis.navigator?.onLine === false) {
        throw new McpError('network', /* en */ `annai couldn't reach the MCP server ${this.server}: this device is offline. Try again once it is online.`,
          t`annai couldn't reach the MCP server ${this.server}: this device is offline. Try again once it is online.`);
      }
      throw new McpError('cors', /* en */ `annai couldn't reach the MCP server ${this.server}. Check its address, that it is running, and that it lets web apps call it (CORS).`,
        t`annai couldn't reach the MCP server ${this.server}. Check its address, that it is running, and that it lets web apps call it (CORS).`);
    }
    if (res.status === 401 || res.status === 403) {
      // A server guarding against DNS rebinding refuses an Origin it doesn't know with 403, and says so (the SDK: "Invalid Origin header").
      if (res.status === 403 && /origin/i.test(await startOf(res, 2000))) {
        const here = globalThis.location?.origin;
        throw new McpError('cors', /* en */ `The MCP server ${this.server} doesn't take requests from annai${here ? ` at ${here}` : "'s address"}: it checks the Origin they come from. Add ${here ?? "annai's address"} to the origins it allows.`,
          here ? t`The MCP server ${this.server} doesn't take requests from annai at ${here}: it checks the Origin they come from. Add ${here} to the origins it allows.`
            : t`The MCP server ${this.server} doesn't take requests from annai's address: it checks the Origin they come from. Add annai's address to the origins it allows.`, 403);
      }
      res.body?.cancel().catch(() => {});
      throw new McpError('auth', /* en */ `The MCP server ${this.server} refused annai's key. Check its token or headers in Settings → Tools → MCP servers.`,
        t`The MCP server ${this.server} refused annai's key. Check its token or headers in Settings → Tools → MCP servers.`, res.status);
    }
    if (res.status === 404 && this.#session && !init) {
      res.body?.cancel().catch(() => {});
      throw new McpError('session', /* en */ `The MCP server ${this.server} ended annai's session.`, t`The MCP server ${this.server} ended annai's session.`);
    }
    if (res.status === 400 && !this.#session && this.#version && !init) {
      // Asked for a session the browser kept from annai: the server didn't expose its header (CORS).
      const said = await startOf(res, 2000);
      if (/session/i.test(said)) {
        throw new McpError('cors', /* en */ `The MCP server ${this.server} started a session annai can't see. It must list Mcp-Session-Id in Access-Control-Expose-Headers.`,
          t`The MCP server ${this.server} started a session annai can't see. It must list Mcp-Session-Id in Access-Control-Expose-Headers.`);
      }
      throw this.#answered(400);
    }
    if (init) this.#session = res.headers.get('mcp-session-id') || null;
    if (id === null) {
      res.body?.cancel().catch(() => {});
      if (!res.ok) throw this.#answered(res.status, res.status);
      return null;
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw this.#answered(res.status, res.status);
    }
    const unreadable = () => new McpError('answer', /* en */ `The MCP server ${this.server} sent an answer annai can't read.`, t`The MCP server ${this.server} sent an answer annai can't read.`);
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      if (!res.body) throw unreadable();
      // Read no further than ANSWER_MAX, as a JSON answer is (fix pass 8c-4).
      const tooMuch = () => new McpError('answer', /* en */ `The MCP server ${this.server} sent more than annai reads (${ANSWER_MAX / 1_048_576} MB).`,
        t`The MCP server ${this.server} sent more than annai reads (${num(ANSWER_MAX / 1_048_576)} MB).`);
      let read = 0;
      let over = false;
      const counted = res.body.pipeThrough(new TransformStream({
        transform(chunk, c) {
          read += chunk.byteLength;
          if (read <= ANSWER_MAX) return c.enqueue(chunk);
          over = true;
          c.error(tooMuch());
        },
      }));
      try {
        for await (const ev of sse(counted)) {
          /** @type {any} */
          let m;
          try {
            m = JSON.parse(ev.data);
          } catch {
            continue;
          }
          // What the server says on the way (progress, its own requests) is skipped (choice 2).
          if (m && typeof m === 'object' && m.id === id && ('result' in m || 'error' in m)) return m;
        }
      } catch (e) {
        if (stopOf(e, signal)) throw stopOf(e, signal);
        if (over) throw tooMuch();
      }
      throw unreadable();
    }
    /** @type {any} */
    let m;
    try {
      m = await answerJSON(res, this.server);
    } catch (e) {
      if (stopOf(e, signal)) throw stopOf(e, signal);
      throw unreadable();
    }
    if (Array.isArray(m)) m = m.find((x) => x && x.id === id);
    if (!m || typeof m !== 'object' || m.id !== id) throw unreadable();
    return m;
  }
}

/**
 * What ends a session on its server: a DELETE to that address with those headers.
 * @param {string} address @param {Record<string, string>} auth @param {string} session @returns {(o: { fetch: Fetch, signal?: AbortSignal }) => Promise<void>}
 */
function ender(address, auth, session) {
  return async ({ fetch, signal }) => {
    try {
      await fetch(address, { method: 'DELETE', headers: { ...auth, 'Mcp-Session-Id': session }, ...(signal ? { signal } : {}) });
    } catch {
      // gone already, or too slow: nothing more to do
    }
  };
}

/** The start of an answer's body, as text: no more than max bytes are read (minors 5). @param {Response} res @param {number} max */
async function startOf(res, max) {
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let n = 0;
  try {
    while (reader && n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value.subarray(0, max - n), { stream: true });
      n += value.byteLength;
    }
  } catch {
    // cut off: what came is enough
  }
  reader?.cancel().catch(() => {});
  return out;
}

/** FNV-1a of a text, as 6 base-36 characters. @param {string} s */
function tag(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 36 ** 6).toString(36).padStart(6, '0');
}

/**
 * A tool's name for Shiori (milestone 8c, choice 1): mcp_<server>_<tool>, in the characters every
 * provider accepts; one too long, or taken, is cut and ends in a short hash of the tool's own name.
 * @param {string} server @param {string} tool @param {Set<string>} taken
 */
export function mcpToolName(server, tool, taken) {
  const name = `mcp_${server}_${String(tool).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  if (name.length <= 64 && !taken.has(name)) return name;
  return `${name.slice(0, 57)}_${tag(String(tool))}`;
}

/**
 * What a tool answered, for Shiori (choice 8): text as text, photos as photos, a resource's text,
 * other parts described, structured content as JSON when there is no text, and isError kept. Shiori's words: English.
 * @param {any} result @returns {{ content: string, images?: { mediaType: string, data: string }[], isError?: boolean }}
 */
export function toolOutput(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  /** @type {string[]} */
  const texts = [];
  /** @type {{ mediaType: string, data: string }[]} */
  const images = [];
  /* en */
  for (const p of parts) {
    if (p?.type === 'text') texts.push(String(p.text ?? ''));
    else if (p?.type === 'image' && IMAGE_TYPES.includes(p.mimeType) && isBase64(p.data) && p.data.length * 0.75 <= IMAGE_MAX) {
      images.push({ mediaType: p.mimeType, data: p.data });
      texts.push(`An image (${p.mimeType}).`);
    } else if (p?.type === 'image') texts.push(`An image (${String(p.mimeType ?? 'of an unknown kind')}) that annai doesn't pass on.`);
    else if (p?.type === 'audio') texts.push(`A sound (${String(p.mimeType ?? 'audio')}), which annai doesn't pass on.`);
    else if (p?.type === 'resource_link') texts.push(`${String(p.name ?? p.uri ?? 'A resource')}: ${String(p.uri ?? '')}`);
    else if (p?.type === 'resource') {
      const r = p.resource ?? {};
      texts.push(typeof r.text === 'string' ? r.text : `A resource (${String(r.mimeType ?? 'data')}) at ${String(r.uri ?? 'an address')}.`);
    }
  }
  let content = texts.join('\n\n');
  if (!content && result?.structuredContent !== undefined) content = JSON.stringify(result.structuredContent);
  if (!content) content = /* en */ 'The tool answered nothing.';
  return { content, ...(images.length ? { images } : {}), ...(result?.isError ? { isError: true } : {}) };
}
