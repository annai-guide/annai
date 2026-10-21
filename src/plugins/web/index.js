import { VERSION } from '../../app/version.js';
import { htmlToText } from '../../core/html-text.js';
import { toBase64 } from '../../core/bytes.js';
import { anySignal } from '../../core/signals.js';

export const manifest = {
  id: 'web',
  name: 'Web tools',
  version: VERSION,
  api: 1,
  description: 'fetch reads any web page, through Jina Reader when a site doesn\'t let web apps read it; web_search searches with Jina Search.',
};

const READER = 'https://r.jina.ai/';
const SEARCH = 'https://s.jina.ai/';
const TEXT_MAX = 30_000;
const FILE_MAX = 10 * 2 ** 20;
/** Each step's time limit, as the places tools' requests: a site that never answers is left for the next way to read it. */
export const STEP_MS = { ms: 25_000 };

/** fn with a signal the user's stop and STEP_MS both end; past the limit, an error marked late. @template T @param {any} call @param {(signal: AbortSignal) => Promise<T>} fn */
async function step(call, fn) {
  const late = AbortSignal.timeout(STEP_MS.ms);
  try {
    return await fn(anySignal([call.signal, late]));
  } catch (e) {
    throw late.aborted && !call.signal.aborted ? Object.assign(new Error('late'), { late: true }) : e;
  }
}

/** @param {any} annai */
export function activate(annai) {
  const { tsv } = annai.helpers;
  const key = async () => {
    const k = await annai.secrets.get('jina');
    return typeof k === 'string' && k ? k : null;
  };
  /** @param {string} text @param {number} from @param {string} head */
  const piece = (text, from, head) => {
    const start = Math.max(0, from);
    const part = text.slice(start, start + TEXT_MAX);
    const rest = text.length - start - part.length;
    return `${head}\n\n${part}${rest > 0 ? `\n… ${rest} more characters; fetch again with from: ${start + part.length}` : ''}`;
  };
  /** A response as what the model reads. @param {Response} res @param {string} url @param {any} call @param {number} from @param {string} how */
  const readResponse = async (res, url, call, from, how) => {
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const name = new URL(url).pathname.split('/').pop() || 'document';
    if (type === 'application/pdf' || type.startsWith('image/')) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > FILE_MAX) return `Source: ${url} (${how})\n\nThis ${type} is over 10 MB, too big to read here.`;
      const input = call.model?.input ?? ['text'];
      if (type === 'application/pdf') {
        if (!input.includes('pdf')) return `Source: ${url} (${how})\n\nIt's a PDF, and this model can't read PDFs. Ask the user for a screenshot of the page you need.`;
        return { content: `Source: ${url} (${how}): a PDF.`, document: { mediaType: 'application/pdf', data: toBase64(bytes), name } };
      }
      if (!input.includes('image')) return `Source: ${url} (${how})\n\nIt's an image, and this model can't see images.`;
      return { content: `Source: ${url} (${how}): an image.`, images: [{ mediaType: type, data: toBase64(bytes) }] };
    }
    const raw = await res.text();
    if (type.includes('html')) {
      const { title, text } = htmlToText(raw, url);
      return piece(text, from, `Source: ${url} (${how})${title ? `\nTitle: ${title}` : ''}`);
    }
    if (type && !type.startsWith('text/') && !type.includes('json') && !type.includes('xml')) {
      return `Source: ${url} (${how})\n\nIt's a ${type} file, which fetch can't read. It reads web pages, text, PDFs and images.`;
    }
    return piece(raw, from, `Source: ${url} (${how})`);
  };

  const fetchTool = {
    name: 'fetch', group: 'Web',
    description: 'Read a web page (or text, a PDF, or an image) at an address. Long pages come in pieces; fetch again with from.',
    input: { type: 'object', properties: { url: { type: 'string' }, from: { type: 'integer', minimum: 0 } }, required: ['url'] },
    /** @param {{ url: string, from?: number }} i @param {any} call */
    async run(i, call) {
      let url;
      try {
        url = new URL(i.url);
      } catch {
        throw new Error(`"${i.url}" isn't a web address. Addresses start with https:// or http://.`);
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('fetch reads only http and https addresses.');
      const href = url.href;
      const from = i.from ?? 0;
      /** @type {string[]} */
      const why = [];
      // 1. Directly, which works when the site allows browsers (spec §7.2).
      if (url.protocol === 'https:') {
        try {
          const got = await step(call, async (signal) => {
            const res = await call.fetch(href, { signal, redirect: 'follow' });
            return res.ok ? { read: await readResponse(res, href, call, from, 'read directly') } : { status: res.status };
          });
          if ('read' in got) return got.read;
          if (got.status === 404 || got.status === 410) throw Object.assign(new Error(`The site answered ${got.status}: there's no page at ${href}.`), { final: true });
          why.push(`the site answered ${got.status}`);
        } catch (e) {
          if (/** @type {any} */ (e)?.final) throw e;
          if (call.signal.aborted) throw e;
          why.push(/** @type {any} */ (e)?.late ? "the site didn't answer in time" : "the site doesn't let web apps read it directly");
        }
      } else {
        why.push('an http address can only be read through a reader');
      }
      // 2. Through the reader service.
      const k = await key();
      try {
        const got = await step(call, async (signal) => {
          const res = await call.fetch(`${READER}${href}`, { signal, headers: { accept: 'text/plain', ...(k ? { authorization: `Bearer ${k}` } : {}) } });
          return { status: res.status, text: res.ok ? await res.text() : '' };
        });
        if (got.status >= 200 && got.status < 300) return piece(got.text, from, `Source: ${href} (read through Jina Reader)`);
        why.push(got.status === 401 || got.status === 403
          ? `Jina Reader asked for a key${k ? ' and refused the one set' : ''} (add a Jina key in Settings → Tools)`
          : `Jina Reader answered ${got.status}`);
      } catch (e) {
        if (call.signal.aborted) throw e;
        why.push(/** @type {any} */ (e)?.late ? "Jina Reader didn't answer in time" : "Jina Reader couldn't be reached");
      }
      // 3. The model provider's own fetch tool, if one is on (spec §9.5).
      try {
        const r = await call.llm.call({
          role: 'main', scope: call.scope, signal: call.signal, record: { tag: 'fetch' },
          request: {
            messages: [{ role: 'user', parts: [{ type: 'text', text: `Fetch ${href} with your web fetch tool and reply with the page's text as it is, without comment.` }] }],
            providerTools: { kinds: ['fetch'], off: call.providerOff ?? [] }, needsProviderTool: 'fetch', maxOutput: 8000,
          },
        });
        if (r.reply.text?.trim()) return piece(r.reply.text, from, `Source: ${href} (read with ${r.answeredBy}'s fetch tool)`);
      } catch {
        why.push('no model with a fetch tool could read it');
      }
      throw new Error(`Couldn't read ${href}: ${why.join('; ')}.`);
    },
  };

  const jina = {
    id: 'jina', name: 'Jina Search', needsKey: true,
    /** @param {string} query @param {{ key: string | null, fetch: any, signal: AbortSignal }} c */
    async search(query, { key: k, fetch: get, signal }) {
      const res = await get(`${SEARCH}?q=${encodeURIComponent(query)}`, { signal, headers: { accept: 'application/json', authorization: `Bearer ${k}`, 'x-respond-with': 'no-content' } });
      if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'Jina Search refused the key' : `Jina Search answered ${res.status}`);
      const body = await res.json();
      return (body?.data ?? []).map((/** @type {any} */ d) => ({ title: String(d.title ?? ''), url: String(d.url ?? ''), snippet: String(d.description ?? d.content ?? '').slice(0, 300) }));
    },
  };

  const searchTool = {
    name: 'web_search', group: 'Web',
    description: 'Search the web. Answers as TSV: title, url, snippet. fetch a result to read it.',
    input: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'] },
    /** @param {{ query: string }} i @param {any} call */
    async run(i, call) {
      /** @type {string[]} */
      const why = [];
      const listed = annai.searchProvidersAsync ? await annai.searchProvidersAsync() : [];
      for (const p of listed.length ? listed : [jina]) {
        // The key is for this plugin's own Jina alone, never another provider by that name.
        const k = p === jina ? await key() : null;
        if (p.needsKey && !k) {
          why.push(`${p.name} needs a key (Settings → Tools)`);
          continue;
        }
        try {
          const rows = await step(call, (signal) => p.search(i.query, { key: k, fetch: call.fetch, signal }));
          return rows.length ? tsv(['title', 'url', 'snippet'], rows.map((/** @type {any} */ r) => [r.title, r.url, r.snippet])) : `Nothing found for "${i.query}".`;
        } catch (e) {
          if (call.signal.aborted) throw e;
          why.push(/** @type {any} */ (e)?.late ? `${p.name} didn't answer in time` : String(/** @type {any} */ (e)?.message ?? e));
        }
      }
      throw new Error(`Web search didn't work: ${why.join('; ')}. Or turn on your model's own search in Settings → Tools.`);
    },
  };

  const off = [annai.register('search', jina), annai.tools.register(fetchTool), annai.tools.register(searchTool)];
  return () => off.forEach((fn) => fn());
}
