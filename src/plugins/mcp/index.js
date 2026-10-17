import { VERSION } from '../../app/version.js';
import { McpClient, McpError, mcpToolName, toolOutput } from './client.js';
import { addressParts, fullAddress, refuseUserinfo } from '../../core/address.js';
import { SYS_SETTINGS } from '../../core/scopes.js';
import { forget } from '../../core/forget.js';
import { withoutSecrets } from '../../core/agent/net.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';

/**
 * The built-in MCP client plugin (spec §5.1): each MCP server the user adds gives Shiori its tools,
 * as mcp_<server>_<tool> (milestone 8c, choice 1), under Settings → Tools with switches, every
 * request in the trace. A server is its file /mcp/<server>.json in sys:settings (name, its address as
 * shown, with any part that may be a key blanked; kind of auth; its tools) and its secret
 * plugin:mcp:<server> (the address's keys, and a token or headers); removing it forgets both.
 */
export const manifest = {
  id: 'mcp',
  name: 'MCP servers',
  version: VERSION,
  api: 1,
  description: 'Tools from MCP servers you add in Settings → Tools.',
};

const DIR = '/mcp/';
const NAME = /^[a-z0-9][a-z0-9-]{0,19}$/;
/** The most tools a server gives Shiori (choice 5). */
export const MAX_TOOLS = 100;
const LIST_MS = 30_000;
const CALL_MS = 120_000;
/** How long Remove waits for a server to end its session (fix pass 8c-3). */
const END_MS = 5_000;
const HEADER = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):\s*(.*\S)\s*$/;
/** Headers annai sends itself: one of the user's would break its answers, SSE ones first (minors 6). */
const OWN = ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id'];

/** 1st, 2nd, 3rd, 4th, 11th, 21st. @param {number} n */
const nth = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/**
 * Refuses a value a web request can't carry in a header (minors 7), in words that say what is wrong:
 * fetch refuses any character past U+00FF, and NUL, CR and LF, and annai would only say it couldn't reach the server.
 * @param {string} value @param {string} what "The token"
 */
function sendable(value, what) {
  const at = value.search(/[^\x01-\x09\x0b\x0c\x0e-\xff]/);
  if (at < 0) return;
  const code = /** @type {number} */ (value.codePointAt(at)).toString(16).toUpperCase().padStart(4, '0');
  throw new Error(`${what} has a character a web request can't carry: U+${code}, its ${nth([...value.slice(0, at)].length + 1)}. Copy it again without it.`);
}

/**
 * @typedef {{ name: string, shown: string, auth: 'none' | 'token' | 'headers', tools: any[], more: number, added: number, refreshed: number }} Server
 *   shown: the address with every part that may be a key blanked (the coordinator's third finding); the keys are in its secret
 * @typedef {{ token?: string, headers?: Record<string, string> }} Auth
 * @typedef {Auth & { keys?: string[] }} ServerSecret  a server's secret: its address's keys, and its auth
 * @typedef {{ removed: boolean }} Life  set when a server is removed, so work that was waiting for it stops (the coordinator's fourth finding)
 */

/** An address annai may call (choice 3): https, or http on this device. @param {string} url */
function checkAddress(url) {
  /** @type {URL} */
  let u;
  try {
    u = new URL(String(url ?? '').trim());
  } catch {
    u = /** @type {any} */ (null);
  }
  const local = u && u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!u || (u.protocol !== 'https:' && !local)) throw new Error('The address must start with https:// (or http://localhost or http://127.0.0.1 on this device).');
  refuseUserinfo(u, ', and put the key in the Token or Headers field');
  return u.href;
}

/** "Name: value" lines as headers. @param {string} text @returns {Record<string, string>} */
function readHeaders(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = HEADER.exec(line.trim());
    if (!m) throw new Error('Each header is one line: Name: value.');
    if (OWN.includes(m[1].toLowerCase())) throw new Error(`annai sends ${m[1]} itself, so it can't be one of these headers. Leave that line out.`);
    sendable(m[2], `The header ${m[1]}`);
    out[m[1]] = m[2];
  }
  return out;
}

/** The headers a server's auth sends. @param {Auth | null | undefined} auth */
const headersOf = (auth) => (auth?.token ? { Authorization: `Bearer ${auth.token}` } : { ...(auth?.headers ?? {}) });

/** Where a schema's keys are names (of properties, definitions), not keywords. */
const NAMED = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
/** A schema without $schema, $id and $comment at any depth, which some providers refuse (fix pass 8c-5). @param {any} v @param {boolean} [names] */
const plain = (v, names = false) => {
  if (Array.isArray(v)) return v.map((x) => plain(x));
  if (!v || typeof v !== 'object') return v;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (!names && (k === '$schema' || k === '$id' || k === '$comment')) continue;
    out[k] = plain(x, !names && NAMED.has(k));
  }
  return out;
};
/** A tool's input schema as the providers take it: an object schema. @param {any} s */
const inputOf = (s) => {
  if (!s || typeof s !== 'object' || Array.isArray(s) || (s.type !== 'object' && s.type !== undefined)) return { type: 'object' };
  try {
    return { ...plain(s), type: 'object' };
  } catch {
    return { type: 'object' }; // nested too deep to walk
  }
};
/** The longest description a tool gives Shiori (fix pass 8c-5). */
const DESCRIPTION_MAX = 1024;
/** A tool's description: what its server says, cut to fit, and where it is from. @param {string} said @param {string} server */
const describe = (said, server) => {
  const from = ` (from the MCP server ${server})`;
  const room = DESCRIPTION_MAX - from.length;
  return `${said.length > room ? `${said.slice(0, room - 1).trimEnd()}…` : said}${from}`;
};

/** @param {any} annai */
export async function activate(annai) {
  const ws = annai.files;
  const store = ws.store;
  /** @type {Map<string, { config: Server, client: McpClient, names: string[], offs: (() => void)[], life: Life }>} */
  const servers = new Map();
  /** @type {Set<string>} names being added now: a second add of one waits for nothing and is refused */
  const adding = new Set();
  /** Words for the user with every secret annai keeps blanked, and the ones being added too. @param {unknown} e @param {string[]} [own] */
  const words = async (e, own = []) => {
    let t = String(/** @type {any} */ (e)?.message ?? e);
    for (const s of own) if (s && s.length >= 4) t = t.split(s).join('«key»');
    return withoutSecrets(store, t);
  };
  const fileOf = (/** @type {string} */ name) => `${DIR}${name}.json`;
  /** A server's client: its full address and its auth read from its secret, each time. @param {{ name: string, shown: string }} config */
  const clientFor = (config) => new McpClient({
    url: async () => fullAddress(config.shown, (await annai.secrets.get(config.name))?.keys ?? []),
    server: config.name,
    auth: async () => headersOf(await annai.secrets.get(config.name)),
  });
  /** @param {string} name */
  const gone = (name) => new Error(`The MCP server ${name} was removed.`);

  /** Registers a server's tools, the first 100 (choice 5), replacing what it had. @param {Server} config @param {McpClient} [client] @param {Life} [life] */
  const register = (config, client, life) => {
    const had = servers.get(config.name);
    had?.offs.forEach((off) => off());
    const c = client ?? had?.client ?? clientFor(config);
    /** @type {Set<string>} */
    const taken = new Set();
    /** @type {string[]} */
    const names = [];
    /** @type {(() => void)[]} */
    const offs = [];
    for (const t of config.tools.slice(0, MAX_TOOLS)) {
      const name = mcpToolName(config.name, t.name, taken);
      taken.add(name);
      names.push(name);
      const said = String(t.description ?? t.title ?? '').trim() || `The tool ${t.name}.`;
      offs.push(annai.tools.register({
        name, group: `MCP: ${config.name}`,
        description: describe(said, config.name),
        input: inputOf(t.inputSchema),
        run: (/** @type {any} */ input, /** @type {any} */ call) => runTool(config.name, String(t.name), input, call),
      }));
    }
    servers.set(config.name, { config, client: c, names, offs, life: life ?? had?.life ?? { removed: false } });
  };

  /**
   * One call of a server's tool (choice 8, 9): the call's own traced fetch, so its requests are in the
   * trip's trace; what comes back has every secret blanked; a failure is Shiori's answer, in words.
   * @param {string} server @param {string} tool @param {any} input @param {any} call
   */
  const runTool = async (server, tool, input, call) => {
    const s = servers.get(server);
    if (!s) throw new Error(`The MCP server ${server} was removed.`);
    const stop = call?.signal ?? new AbortController().signal;
    /** @type {any} */
    let result;
    try {
      result = await s.client.callTool(tool, input ?? {}, { fetch: call?.fetch ?? annai.net.fetch, signal: AbortSignal.any([stop, AbortSignal.timeout(CALL_MS)]) });
    } catch (e) {
      if (stop.aborted) throw e;
      const name = /** @type {any} */ (e)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`The MCP server ${server} didn't answer within ${CALL_MS / 60_000} minutes. Try again later.`);
      if (e instanceof McpError && e.kind === 'server' && /unknown tool/i.test(e.message)) refresh(server).catch(() => {});
      throw new Error(await words(e));
    }
    const out = toolOutput(result);
    const content = await withoutSecrets(store, out.content);
    if (out.isError) throw new Error(content);
    return out.images ? { content, images: out.images } : content;
  };

  /** Asks a server for its tools, within the time limit, in words when it fails. @param {McpClient} client @param {string[]} [own] */
  const listTools = async (client, own = []) => {
    try {
      return await client.listTools({ fetch: annai.net.fetch, signal: AbortSignal.timeout(LIST_MS) });
    } catch (e) {
      const name = /** @type {any} */ (e)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`The MCP server didn't answer within ${LIST_MS / 1000} seconds. Check that it is running, then try again.`);
      throw new Error(await words(e, own));
    }
  };

  /** @param {Server} config */
  const save = (config) => ws.write(SYS_SETTINGS, fileOf(config.name), config, { author: 'plugin:mcp' });

  /**
   * Asks a server for its tools again. A server removed meanwhile stays removed: nothing is saved or
   * registered for it, and a file saved as it went is forgotten again (the coordinator's fourth finding).
   * @param {string} name
   */
  const refresh = async (name) => {
    const s = servers.get(name);
    if (!s) throw new Error(`There is no MCP server called ${name}.`);
    const { life } = s;
    /** @type {any[]} */
    let tools;
    try {
      tools = await listTools(s.client);
    } catch (e) {
      if (life.removed) throw gone(name);
      throw e;
    }
    if (life.removed) throw gone(name);
    const config = { ...s.config, tools: tools.slice(0, MAX_TOOLS), more: Math.max(0, tools.length - MAX_TOOLS), refreshed: Date.now() };
    await save(config);
    if (life.removed) {
      await forgetFile(name);
      throw gone(name);
    }
    register(config, s.client, life);
    return { tools: Math.min(tools.length, MAX_TOOLS) };
  };

  /** A server's file and its history, for good. @param {string} name */
  const forgetFile = (name) => {
    const path = fileOf(name);
    return forget(store, SYS_SETTINGS, { files: (p) => p === path, history: (p) => p === path });
  };

  const service = Object.freeze({
    /** The servers, as the screen shows them: the address as the trace keeps it, never a key. */
    list: async () => [...servers.values()].map(({ config, names }) => ({
      name: config.name, url: config.shown, auth: config.auth, refreshed: config.refreshed, more: config.more ?? 0,
      tools: config.tools.slice(0, MAX_TOOLS).map((t, i) => ({ name: names[i], mcp: String(t.name) })),
    })),
    /**
     * Adds a server, after it answered (choice 4): nothing is kept when it doesn't.
     * @param {{ name: string, url: string, token?: string, headers?: string }} o
     */
    add: async ({ name, url, token, headers }) => {
      const n = String(name ?? '').trim();
      if (!NAME.test(n)) throw new Error("A server's name is 1 to 20 lowercase letters, digits and dashes, like trail.");
      if (servers.has(n) || adding.has(n)) throw new Error(`There is a server called ${n} already.`);
      const address = checkAddress(url);
      /** @type {Auth | null} */
      let auth = null;
      if (token && String(token).trim()) {
        sendable(String(token).trim(), 'The token');
        auth = { token: String(token).trim() };
      } else if (headers && String(headers).trim()) auth = { headers: readHeaders(String(headers)) };
      // A key in the address goes to secrets with the auth, before any request, so the trace blanks it too.
      const { shown, keys } = addressParts(address);
      /** @type {ServerSecret} */
      const record = { ...(keys.length ? { keys } : {}), ...(auth ?? {}) };
      const keeps = Object.keys(record).length > 0;
      const own = [...keys, ...(auth?.token ? [auth.token] : Object.values(auth?.headers ?? {}))];
      adding.add(n);
      try {
        if (keeps) await annai.secrets.set(n, record);
        const forgetSecret = () => (keeps ? annai.secrets.set(n, null).catch(() => {}) : Promise.resolve());
        // The client that checks the server is the one its tools use: one session, not one left behind (minors 2).
        const client = clientFor({ name: n, shown });
        /** @type {any[]} */
        let tools;
        try {
          tools = await listTools(client, own);
        } catch (e) {
          const end = await client.ending().catch(() => null);
          await end?.({ fetch: annai.net.fetch, signal: AbortSignal.timeout(END_MS) });
          await forgetSecret();
          throw e;
        }
        const now = Date.now();
        /** @type {Server} */
        const config = { name: n, shown, auth: auth?.token ? 'token' : auth?.headers ? 'headers' : 'none', tools: tools.slice(0, MAX_TOOLS), more: Math.max(0, tools.length - MAX_TOOLS), added: now, refreshed: now };
        try {
          await save(config);
        } catch (e) {
          await forgetSecret();
          throw e;
        }
        register(config, client, { removed: false });
        return { tools: config.tools.length };
      } finally {
        adding.delete(n);
      }
    },
    refresh,
    /**
     * Removes a server and everything it stored (choice 10). Everything here goes first; then its session
     * is ended on the server, best-effort and for 5 seconds at most, and its secret goes last, so the
     * trace still blanks the address's keys in that request. A remove that failed partway can be done
     * again, and a secret left by one is forgotten at the next start (fix pass 8c-3).
     * @param {string} name
     */
    remove: async (name) => {
      const s = servers.get(name);
      if (!s) {
        // What a remove that failed partway left.
        if (NAME.test(name) && !adding.has(name)) {
          await forgetFile(name);
          await annai.secrets.set(name, null);
        }
        return;
      }
      s.life.removed = true; // first: a refresh waiting on the server now stops (the coordinator's fourth finding)
      s.offs.forEach((off) => off());
      const end = await s.client.ending().catch(() => null);
      await forgetFile(name);
      const switches = (await readAppSettings(ws)).tools ?? {};
      const off = s.names.filter((t) => Object.hasOwn(switches, t));
      if (off.length) await updateAppSettings(ws, { tools: Object.fromEntries(off.map((t) => [t, null])) });
      servers.delete(name);
      await annai.events.append('sys', 'mcp.remove', { server: name });
      await end?.({ fetch: annai.net.fetch, signal: AbortSignal.timeout(END_MS) });
      await annai.secrets.set(name, null);
    },
  });

  const stored = await ws.list(SYS_SETTINGS, DIR);
  for (const f of stored) {
    if (!f.path.endsWith('.json')) continue;
    const config = await ws.readJSON(SYS_SETTINGS, f.path).catch(() => null);
    if (config && typeof config.name === 'string' && NAME.test(config.name) && typeof config.shown === 'string' && Array.isArray(config.tools)) register(config);
  }
  // A secret whose server has no file: what a remove that failed at its end left (fix pass 8c-3).
  const files = new Set(stored.map((f) => f.path));
  const ids = await store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.listSecretIds()).catch(() => []);
  for (const id of ids) {
    const name = String(id).startsWith('plugin:mcp:') ? String(id).slice('plugin:mcp:'.length) : null;
    if (name && !files.has(fileOf(name))) await annai.secrets.set(name, null).catch(() => {});
  }
  const offService = annai.register('mcp-servers', service);
  return () => {
    offService();
    for (const s of servers.values()) s.offs.forEach((off) => off());
    servers.clear();
  };
}
