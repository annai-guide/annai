import { McpClient, toolOutput } from '../mcp/client.js';
import { answerJSON } from '../../core/answer.js';
import { nominatimTurn, nominatimLanguages } from '../../core/nominatim.js';
import { editionsOf, articleUrl, pageUrl, wikiSaid } from '../../core/wiki.js';
import { cut, CHAIN } from '../../core/web-search.js';
import { anySignal } from '../../core/signals.js';
import { t } from '../../core/l10n.js';

/**
 * annai's free search: Exa, Parallel and Firecrawl, which answer a web app's search with no key, each through its MCP address,
 * and a floor of Wikivoyage, Wikipedia and Nominatim that is always there. They are annai's own search providers, not MCP
 * servers the user added: Shiori sees only web_search. Only the words searched go to them, with a random id for the conversation to
 * Parallel (its free tier counts by it) and the address of a page to Exa when it reads one.
 */

/** The longest a free service has to answer before the next one is tried. */
const LIMIT_MS = 12_000;
/**
 * The whole floor's time, every part and try. The chain keeps CHAIN.reserve (10 s) for the floor (web/index.js reserveFor); the floor ends a
 * second inside it (its start and the chain's bookkeeping take milliseconds), so the chain's stop never drops its rows. At 2.5 s an answer
 * Wikipedia's three tries in series (7.5 s) finish inside it; the guide's four (10 s) are cut, the other rows come.
 */
export const FLOOR_MS = { ms: CHAIN.reserve - 1_000 };

/**
 * A failure in words, keeping the HTTP status and kind the chain judges it by; a stop stays a stop.
 * @param {string} name @param {any} e
 */
function failure(name, e) {
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return e;
  const s = e?.status;
  // A free service that now asks for a key has closed its free tier to annai: told so, and left alone for a while.
  /* en */
  if (e?.kind === 'auth') return Object.assign(new Error(`${name} now asks for a key`), { status: s, kind: 'auth', rest: true });
  /* en */
  const why = s ? `${name} answered ${s}${s === 429 ? ' (its free limit)' : ''}`
    : e?.kind === 'cors' || e?.kind === 'network' || e instanceof TypeError ? `${name} couldn't be reached`
      : e?.kind === 'answer' ? `${name} sent an answer annai can't read` : `${name}: ${e?.message ?? e}`;
  return Object.assign(new Error(why), { status: s, kind: e?.kind });
}

/** One client for each service's address for the page's life, so a session that a server wants is started once and then reused. @type {Map<string, McpClient>} */
const clients = new Map();
/** Lets go of them (for tests). */
export function forgetClients() {
  clients.clear();
}

/**
 * One call of an MCP search tool: a single request, no session unless the server wants one. Its result, or a failure in words.
 * @param {string} name @param {string} url @param {Record<string, string>} headers @param {string} tool @param {any} args @param {{ fetch: any, signal: AbortSignal }} c
 */
async function callTool(name, url, headers, tool, args, c) {
  try {
    let client = clients.get(url);
    if (!client) clients.set(url, client = new McpClient({ url, server: name, auth: async () => headers, stateless: true }));
    const result = await client.callTool(tool, args, { fetch: c.fetch, signal: c.signal });
    const out = toolOutput(result);
    if (out.isError) throw Object.assign(new Error(cut(out.content, 200)), { status: /rate.?limit|too many/i.test(out.content) ? 429 : undefined });
    return { text: out.content, result };
  } catch (e) {
    throw failure(name, e);
  }
}

/** @param {string} text */
const parseJSON = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const EXA = { name: 'Exa', url: 'https://mcp.exa.ai/mcp', headers: { 'x-exa-source': 'annai' } };

/** @type {import('../../core/web-search.js').SearchProvider[]} */
export const FREE_PROVIDERS = [
  {
    id: 'exa', name: 'Exa', kind: 'web', free: true, limitMs: LIMIT_MS,
    async search(query, c) {
      const { text } = await callTool(EXA.name, EXA.url, EXA.headers, 'web_search_exa', { query, objective: query, numResults: c.limit }, c);
      // Blocks of Title, URL, Published, Author and Highlights, between lines of ---.
      return text.split(/\n---\n/).map((b) => ({ title: /^Title: (.*)$/m.exec(b)?.[1], url: /^URL: (.*)$/m.exec(b)?.[1], snippet: b.split(/^Highlights:\n?/m)[1] ?? '' }));
    },
  },
  {
    id: 'parallel', name: 'Parallel', kind: 'web', free: true, limitMs: LIMIT_MS,
    async search(query, c) {
      // session_id is what Parallel's free tier counts by: the conversation's, made in memory by the chain.
      /* en */
      const { text, result } = await callTool('Parallel', 'https://search.parallel.ai/mcp', {}, 'web_search', { objective: query, search_queries: [query], ...(c.session ? { session_id: c.session } : {}) }, c);
      const found = result?.structuredContent?.results ?? parseJSON(text)?.results;
      return (Array.isArray(found) ? found : []).map((/** @type {any} */ r) => ({ title: r?.title, url: r?.url, snippet: Array.isArray(r?.excerpts) ? r.excerpts.join(' ') : r?.excerpts }));
    },
  },
  {
    id: 'firecrawl', name: 'Firecrawl', kind: 'web', free: true, limitMs: LIMIT_MS,
    async search(query, c) {
      /* en */
      const { text } = await callTool('Firecrawl', 'https://mcp.firecrawl.dev/v2/mcp', {}, 'firecrawl_search', { query, objective: query, limit: c.limit }, c);
      const data = parseJSON(text)?.data;
      return (Array.isArray(data?.web) ? data.web : Array.isArray(data) ? data : []).map((/** @type {any} */ r) => ({ title: r?.title, url: r?.url, snippet: r?.description ?? r?.markdown }));
    },
  },
];

/**
 * A page's text through Exa, a keyless reader (after the site itself and Jina Reader).
 * @param {string} href @param {number} chars the most characters to ask for @param {{ fetch: any, signal: AbortSignal }} c
 */
export async function exaRead(href, chars, c) {
  const { text } = await callTool(EXA.name, EXA.url, EXA.headers, 'web_fetch_exa', { urls: [href], maxCharacters: chars }, c);
  return text;
}

const STOP = new Set(['the', 'and', 'for', 'are', 'was', 'does', 'what', 'when', 'where', 'which', 'who', 'how', 'can', 'you', 'with', 'from', 'that', 'this', 'about', 'have', 'has', 'into', 'any', 'today']);
/** The words of a question worth searching an encyclopedia for. @param {string} query */
const keywords = (query) => (query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((w) => !STOP.has(w));

/**
 * The floor: a Wikivoyage guide's lines that answer the query, Nominatim's official websites for the place, and Wikipedia's matching
 * articles, in the reading order. Encyclopedic, not web search; always reachable, and credited.
 * @param {() => Promise<import('../../core/languages.js').Language[]>} orderOf
 * @returns {import('../../core/web-search.js').SearchProvider}
 */
export const knowledgeFloor = (orderOf) => ({
  id: 'wiki', name: /* en */ 'Wikivoyage, Wikipedia and Nominatim', shown: t`Wikivoyage, Wikipedia and Nominatim`, kind: 'knowledge', always: true, limitMs: LIMIT_MS,
  /** @param {string} query @param {{ fetch: any, signal: AbortSignal, limit: number }} c */
  async search(query, { fetch: get, signal, limit }) {
    // One time for the whole floor, from the start of its search (the settings read counts): what has answered by then is its answer.
    const late = AbortSignal.timeout(FLOOR_MS.ms);
    const stop = anySignal([signal, late]);
    const order = await orderOf();
    const found = keywords(query);
    const want = found.length ? found : [query.trim().toLowerCase()];
    const enc = encodeURIComponent;
    /** @param {string} url @param {() => Promise<void>} [first] a wait first */
    const json = async (url, first) => {
      const host = new URL(url).hostname;
      try {
        await first?.();
        const res = await get(url, { signal: stop, referrerPolicy: 'origin' });
        if (!res.ok) throw Object.assign(new Error(`${host} answered ${res.status}`), { status: res.status });
        const data = await answerJSON(res, host);
        const said = wikiSaid(data);
        if (said) throw new Error(`${host} said: ${said}`);
        return data;
      } catch (e) {
        throw late.aborted ? Object.assign(new Error(`${host} didn't answer in time`), { late: true }) : e;
      }
    };
    const api = (/** @type {string} */ host, /** @type {string} */ qs) => `https://${host}/w/api.php?${qs}&format=json&origin=*`;
    // Questions rarely match whole; fewer words are tried when all of them find nothing, a host's tries one after another and the hosts at once.
    const tries = [...new Set([want.join(' '), want.slice(0, 3).join(' '), want.slice(0, 2).join(' ')])].filter(Boolean);
    /** A host's hits for the first of the tries that finds any; it fails when the host does. @param {string} host @returns {Promise<any[]>} */
    const hits = async (host) => {
      for (const q of tries) {
        /* en */
        const found = (await json(api(host, `action=query&list=search&srlimit=${limit}&srsearch=${enc(q)}`)))?.query?.search;
        if (Array.isArray(found) && found.length) return found;
      }
      return [];
    };
    const guide = async () => {
      const [top] = await hits('en.wikivoyage.org');
      if (!top) return [];
      const page = /** @type {any} */ (Object.values((await json(api('en.wikivoyage.org', `action=query&prop=extracts&explaintext=1&redirects=1&titles=${enc(top.title)}`)))?.query?.pages ?? {})[0]);
      const lines = String(page?.extract ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 20);
      const score = (/** @type {string} */ l) => want.filter((w) => l.toLowerCase().includes(w)).length;
      const picked = lines.filter((l) => score(l) > 0).sort((a, b) => score(b) - score(a)).slice(0, 3);
      return [{ title: /* en */ `${top.title} (Wikivoyage)`, url: pageUrl('en.wikivoyage.org', top.title), snippet: (picked.length ? picked : lines.slice(0, 2)).join(' ') }];
    };
    const places = async () => {
      // one request a second to Nominatim for the whole app, but only while the floor has time
      const found = await json(`https://nominatim.openstreetmap.org/search?q=${enc(want.join(' '))}&format=jsonv2&extratags=1&limit=3&accept-language=${enc(nominatimLanguages(order))}`, () => nominatimTurn(stop));
      /* en */
      return (Array.isArray(found) ? found : []).filter((f) => f?.extratags?.website)
        .map((f) => ({ title: f.name || f.display_name, url: f.extratags.website, snippet: [f.display_name, f.extratags.opening_hours ? `Hours: ${f.extratags.opening_hours}` : ''].filter(Boolean).join('. ') }));
    };
    // Every part asks at once, each edition too. The rows are what answered: the guide's, Nominatim's websites, the first edition's articles
    // that found any. With no rows, the first failure is the failure, in words; with none, nothing found.
    const editions = editionsOf(order);
    const parts = await Promise.allSettled([guide(), places(), ...editions.map((e) => hits(`${e}.wikipedia.org`))]);
    const [guideRows, placeRows, ...editionHits] = parts;
    const k = editionHits.findIndex((g) => g.status === 'fulfilled' && g.value.length > 0);
    const rows = [
      ...(guideRows.status === 'fulfilled' ? guideRows.value : []),
      ...(placeRows.status === 'fulfilled' ? placeRows.value : []),
      ...(k < 0 ? [] : /** @type {PromiseFulfilledResult<any[]>} */ (editionHits[k]).value.map((h) => ({ title: /* en */ `${h.title} (Wikipedia)`, url: articleUrl(editions[k], h.title), snippet: h.snippet }))),
    ];
    const bad = /** @type {PromiseRejectedResult | undefined} */ (parts.find((x) => x.status === 'rejected'));
    if (!rows.length && bad) throw bad.reason;
    return rows;
  },
});
