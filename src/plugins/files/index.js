import { VERSION } from '../../app/version.js';
import { resolvePath } from '../../core/agent/tools.js';
import { isTextType } from '../../core/paths.js';
import { ValidationError } from '../../core/workspace.js';
import { sizeLine } from '../../core/request-photos.js';

export const manifest = {
  id: 'files',
  name: 'File tools',
  version: VERSION,
  api: 1,
  description: "Shiori's tools for the trip's files and your own: list, read, write, edit, patch, search and delete.",
};

const TEXT_MAX = 40_000;
const PATH = { type: 'string', description: 'A path starting with /trip/ (the open trip) or /me/ (your profile, memory and notes).' };

/** @param {any} annai */
export function activate(annai) {
  const ws = annai.files;
  const { tsv } = annai.helpers;
  /** @param {string} path @param {any} call */
  const where = (path, call) => resolvePath(path, call.trip);
  /** Checked on the path as resolved, so no way of writing it gets around the rule (spec §14.1). @param {string} scope @param {string} path */
  const writable = (scope, path) => {
    if (scope === 'me' && (path === '/personalities' || path.startsWith('/personalities/'))) throw new Error('Personalities change only through tune_personality.');
  };
  /** @param {unknown} e @param {string} path */
  const plain = (e, path) => {
    if (e instanceof ValidationError) return new Error(`${path} doesn't match its format: ${e.errors.join('; ')}`);
    return e;
  };
  /** @param {string} scope @param {string} prefix @param {string} shown the root as Shiori sees it */
  const listed = async (scope, prefix, shown) => (await ws.list(scope, prefix)).map((/** @type {any} */ f) => ({ ...f, shown: `${shown}${f.path}` }));
  /** @param {string} path @param {any} call */
  const filesUnder = async (path, call) => {
    if (path === '/' || path === '') return [...(call.trip ? await listed(call.trip, '/', '/trip') : []), ...(await listed('me', '/', '/me'))];
    const { scope, path: inner } = where(path, call);
    return listed(scope, inner.endsWith('/') ? inner : `${inner}/`, path.startsWith('/trip') ? '/trip' : '/me');
  };
  const tools = [
    {
      name: 'list', group: 'Files',
      description: 'List files under a folder, as TSV: path, type, size in bytes, modified, author.',
      input: { type: 'object', properties: { path: { ...PATH, default: '/' } } },
      /** @param {{ path?: string }} i @param {any} call */
      run: async (i, call) => tsv(['path', 'type', 'size', 'modified', 'author'],
        (await filesUnder(i.path ?? '/', call)).map((f) => [f.shown, f.type, f.size, new Date(f.modified).toISOString(), f.author])),
    },
    {
      name: 'read', group: 'Files',
      description: 'Read a file: text and JSON as text, a photo as an image you can see, a PDF as a document when your model reads PDFs. Long text comes in pieces; read again with from.',
      input: { type: 'object', properties: { path: PATH, from: { type: 'integer', minimum: 0, description: 'Character to start from, for long text.' } }, required: ['path'] },
      /** @param {{ path: string, from?: number }} i @param {any} call */
      run: async (i, call) => {
        const { scope, path } = where(i.path, call);
        const got = await ws.read(scope, path);
        if (!got) throw new Error(`No file at ${i.path}. list shows what is there.`);
        const { entry, bytes } = got;
        const input = call.model?.input ?? ['text'];
        if (entry.type.startsWith('image/')) {
          if (!input.includes('image')) return `${i.path} is a photo, and this model can't see photos.`;
          const m = entry.meta ?? {};
          const source = { hash: entry.hash, type: entry.type, width: m.width ?? null, height: m.height ?? null, size: entry.size };
          // What Shiori is sent: a request copy within the limits, made once (spec §4.8).
          const sent = call.photos ? await call.photos.copy(source) : { hash: entry.hash, mediaType: entry.type, width: m.width ?? null, height: m.height ?? null, made: false };
          const taken = m.taken ? `, taken ${m.taken}` : '';
          return {
            content: `The photo ${i.path}, ${sizeLine(source, sent)}${taken}.`,
            images: [{ mediaType: sent.mediaType, hash: sent.hash, ...(sent.data ? { data: sent.data } : {}), path: i.path }],
          };
        }
        if (entry.type === 'application/pdf') {
          if (!input.includes('pdf')) return `${i.path} is a PDF, and this model can't read PDFs. Ask the user for a screenshot of the page you need.`;
          return { content: `The PDF ${i.path}.`, document: { mediaType: 'application/pdf', hash: entry.hash, name: path.split('/').pop(), path: i.path } };
        }
        if (!isTextType(entry.type)) return `${i.path} is a ${entry.type} file, which can't be read as text.`;
        const all = new TextDecoder().decode(bytes);
        const from = Math.max(0, i.from ?? 0);
        const piece = all.slice(from, from + TEXT_MAX);
        const rest = all.length - from - piece.length;
        return rest > 0 ? `${piece}\n… ${rest} more characters; read again with from: ${from + piece.length}` : piece;
      },
    },
    {
      name: 'write', group: 'Files',
      description: 'Write a whole file: text, or an object stored as JSON. Records such as plan items and bookings must match their format.',
      input: { type: 'object', properties: { path: PATH, content: { type: ['string', 'object'] } }, required: ['path', 'content'] },
      /** @param {{ path: string, content: string | object }} i @param {any} call */
      run: async (i, call) => {
        const { scope, path } = where(i.path, call);
        writable(scope, path);
        const e = await ws.write(scope, path, i.content, { author: 'shiori' }).catch((/** @type {unknown} */ x) => { throw plain(x, i.path); });
        return `Wrote ${i.path} (${e.size} bytes).`;
      },
    },
    {
      name: 'edit', group: 'Files',
      description: 'Replace text in a text file. old must appear exactly once.',
      input: { type: 'object', properties: { path: PATH, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] },
      /** @param {{ path: string, old: string, new: string }} i @param {any} call */
      run: async (i, call) => {
        const { scope, path } = where(i.path, call);
        writable(scope, path);
        const now = await ws.readText(scope, path);
        if (now === undefined) throw new Error(`No file at ${i.path}.`);
        const n = i.old ? now.split(i.old).length - 1 : 0;
        if (n === 0) throw new Error(`That text isn't in ${i.path}. read it to see what is.`);
        if (n > 1) throw new Error(`That text appears ${n} times in ${i.path}. Give more of it, so it appears once.`);
        await ws.write(scope, path, now.replace(i.old, () => i.new), { author: 'shiori' }).catch((/** @type {unknown} */ x) => { throw plain(x, i.path); });
        return `Edited ${i.path}.`;
      },
    },
    {
      name: 'patch', group: 'Files',
      description: 'Change a JSON file with a JSON Merge Patch: given keys replace, null removes, and a key ending in "+" appends to a list.',
      input: { type: 'object', properties: { path: PATH, changes: { type: 'object' } }, required: ['path', 'changes'] },
      /** @param {{ path: string, changes: object }} i @param {any} call */
      run: async (i, call) => {
        const { scope, path } = where(i.path, call);
        writable(scope, path);
        await ws.patch(scope, path, i.changes, { author: 'shiori', append: true }).catch((/** @type {unknown} */ x) => { throw plain(x, i.path); });
        return `Patched ${i.path}.`;
      },
    },
    {
      name: 'search', group: 'Files',
      description: 'Find text in the text files under a folder (all of /trip and /me by default), as TSV: path, line, text. Not case-sensitive.',
      input: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, path: PATH }, required: ['query'] },
      /** @param {{ query: string, path?: string }} i @param {any} call */
      run: async (i, call) => {
        const q = i.query.toLowerCase();
        /** @type {any[][]} */
        const hits = [];
        for (const f of await filesUnder(i.path ?? '/', call)) {
          if (!isTextType(f.type) || hits.length >= 50) continue;
          const text = (await ws.readText(f.scope, f.path)) ?? '';
          text.split('\n').forEach((line, n) => {
            if (hits.length < 50 && line.toLowerCase().includes(q)) hits.push([f.shown, n + 1, line.trim().slice(0, 200)]);
          });
        }
        return hits.length ? tsv(['path', 'line', 'text'], hits) : `Nothing matches "${i.query}".`;
      },
    },
    {
      name: 'delete', group: 'Files',
      description: 'Delete a file. Its history is kept, so the user can restore it.',
      input: { type: 'object', properties: { path: PATH }, required: ['path'] },
      /** @param {{ path: string }} i @param {any} call */
      run: async (i, call) => {
        const { scope, path } = where(i.path, call);
        writable(scope, path);
        await ws.delete(scope, path, { author: 'shiori' });
        return `Deleted ${i.path}.`;
      },
    },
  ];
  const off = tools.map((t) => annai.tools.register(t));
  return () => off.forEach((fn) => fn());
}
