import { answerJSON, ANSWER_MAX } from '../../core/answer.js';
import { sse } from '../../core/llm/sse.js';
import { isBase64 } from '../../core/bytes.js';

/**
 * annai's MCP client (spec §5.1): MCP's Streamable HTTP transport, as a web app speaks it. Each
 * request is one JSON-RPC message POSTed to the server's address; the answer comes as JSON or as an
 * SSE stream. What annai reads is guarded: whatever a server sends, a failure is an McpError in
 * words for the user, never a SyntaxError or TypeError (which would count against the plugin).
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
  /** @param {'auth' | 'cors' | 'session' | 'server' | 'answer' | 'network'} kind @param {string} message */
  constructor(kind, message) {
    super(message);
    this.name = 'McpError';
    this.kind = kind;
  }
}

/** A stop by the user or a time limit stays what it is. @param {unknown} e */
const isStop = (e) => /** @type {any} */ (e)?.name === 'AbortError' || /** @type {any} */ (e)?.name === 'TimeoutError';

export class McpClient {
  /** @type {string | null} */ #session = null;
  /** @type {string | null} the protocol version agreed on: set once connected */ #version = null;
  #id = 0;
  /** @type {Promise<void> | null} */ #connecting = null;

  /**
   * @param {{ url: string | (() => Promise<string>), server: string, auth: () => Promise<Record<string, string>> }} o
   *   url: the server's address, or where to read it (it may hold a key, so annai keeps it in secrets)
   */
  constructor({ url, server, auth }) {
    this.url = url;
    this.server = server;
    this.auth = auth;
  }

  /** Starts a session: initialize, then notifications/initialized. @param {{ fetch: Fetch, signal?: AbortSignal }} o */
  async connect(o) {
    this.#session = null;
    this.#version = null;
    const result = await this.#request('initialize', { protocolVersion: ASKED, capabilities: {}, clientInfo: { name: 'annai', version: '1' } }, o, true);
    const v = String(result?.protocolVersion ?? '');
    if (!SUPPORTED.includes(v)) throw new McpError('server', `The MCP server ${this.server} speaks MCP ${v || 'an unknown version'}; annai speaks 2025-03-26 to 2025-11-25.`);
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
    return this.#inSession(o, () => this.#request('tools/call', { name, arguments: args ?? {} }, o));
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
    const session = this.#session;
    this.#session = null;
    this.#version = null;
    if (!session) return null;
    const address = await this.#address();
    const headers = { ...(await this.auth()), 'Mcp-Session-Id': session };
    return async ({ fetch, signal }) => {
      try {
        await fetch(address, { method: 'DELETE', headers, ...(signal ? { signal } : {}) });
      } catch {
        // gone already, or too slow: nothing more to do
      }
    };
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
      if (!(e instanceof McpError) || e.kind !== 'session') throw e;
      this.#version = null;
      this.#session = null;
      await this.#ready(o);
      return work();
    }
  }

  /** The server's full address. */
  async #address() {
    return typeof this.url === 'function' ? this.url() : this.url;
  }

  /** @param {{ fetch: Fetch, signal?: AbortSignal }} o */
  async #ready(o) {
    if (this.#version) return;
    if (!this.#connecting) this.#connecting = this.connect(o).finally(() => { this.#connecting = null; });
    await this.#connecting;
  }

  /** One request, its result; a JSON-RPC error is the server's words. @param {string} method @param {any} params @param {{ fetch: Fetch, signal?: AbortSignal }} o @param {boolean} [init] */
  async #request(method, params, o, init = false) {
    const id = ++this.#id;
    const m = await this.#post({ jsonrpc: '2.0', id, method, params }, id, o, init);
    if (m?.error) throw new McpError('server', `The MCP server ${this.server} said: ${String(m.error.message ?? m.error.code ?? 'an error')}`);
    return m?.result;
  }

  /**
   * POSTs one message and reads the answer to it (null for a notification).
   * @param {any} body @param {number | null} id @param {{ fetch: Fetch, signal?: AbortSignal }} o @param {boolean} [init]
   */
  async #post(body, id, { fetch, signal }, init = false) {
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(await this.auth()) };
    if (this.#version) headers['MCP-Protocol-Version'] = this.#version;
    if (this.#session) headers['Mcp-Session-Id'] = this.#session;
    /** @type {Response} */
    let res;
    try {
      res = await fetch(await this.#address(), { method: 'POST', headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    } catch (e) {
      if (isStop(e)) throw e;
      throw new McpError('cors', `annai couldn't reach the MCP server ${this.server}. Check its address, that it is running, and that it lets web apps call it (CORS).`);
    }
    if (res.status === 401 || res.status === 403) {
      res.body?.cancel().catch(() => {});
      throw new McpError('auth', `The MCP server ${this.server} refused annai's key. Check its token or headers in Settings → Tools → MCP servers.`);
    }
    if (res.status === 404 && this.#session && !init) {
      res.body?.cancel().catch(() => {});
      throw new McpError('session', `The MCP server ${this.server} ended annai's session.`);
    }
    if (res.status === 400 && !this.#session && this.#version && !init) {
      // Asked for a session the browser kept from annai: the server didn't expose its header (CORS).
      const said = await res.text().then((t) => t.slice(0, 2000), () => '');
      if (/session/i.test(said)) throw new McpError('cors', `The MCP server ${this.server} started a session annai can't see. It must list Mcp-Session-Id in Access-Control-Expose-Headers.`);
      throw new McpError('server', `The MCP server ${this.server} answered 400.`);
    }
    if (init) this.#session = res.headers.get('mcp-session-id') || null;
    if (id === null) {
      res.body?.cancel().catch(() => {});
      if (!res.ok) throw new McpError('server', `The MCP server ${this.server} answered ${res.status}.`);
      return null;
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new McpError('server', `The MCP server ${this.server} answered ${res.status}.`);
    }
    const unreadable = () => new McpError('answer', `The MCP server ${this.server} sent an answer annai can't read.`);
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      if (!res.body) throw unreadable();
      // Read no further than ANSWER_MAX, as a JSON answer is (fix pass 8c-4).
      const tooMuch = () => new McpError('answer', `The MCP server ${this.server} sent more than annai reads (${ANSWER_MAX / 1_048_576} MB).`);
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
        if (isStop(e)) throw e;
        if (over) throw tooMuch();
      }
      throw unreadable();
    }
    /** @type {any} */
    let m;
    try {
      m = await answerJSON(res, this.server);
    } catch (e) {
      if (isStop(e)) throw e;
      throw unreadable();
    }
    if (Array.isArray(m)) m = m.find((x) => x && x.id === id);
    if (!m || typeof m !== 'object' || m.id !== id) throw unreadable();
    return m;
  }
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
 * other parts described, structured content as JSON when there is no text, and isError kept.
 * @param {any} result @returns {{ content: string, images?: { mediaType: string, data: string }[], isError?: boolean }}
 */
export function toolOutput(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  /** @type {string[]} */
  const texts = [];
  /** @type {{ mediaType: string, data: string }[]} */
  const images = [];
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
  if (!content) content = 'The tool answered nothing.';
  return { content, ...(images.length ? { images } : {}), ...(result?.isError ? { isError: true } : {}) };
}
