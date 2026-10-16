import { VERSION } from '../../app/version.js';
import { resolvePath } from '../../core/agent/tools.js';
import { isTextType } from '../../core/paths.js';
import { ValidationError } from '../../core/workspace.js';
import { sizeLine, healRegion } from '../../core/request-photos.js';
import { readPass } from '../../core/pkpass.js';
import { isBookingPath, shioriBooking } from '../../core/bookings.js';

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
  const { tsv, mergePatch } = annai.helpers;
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
  /**
   * What Shiori stores at a path: a booking follows her rule (spec §4.4), anything else is stored as given.
   * @param {string} scope @param {string} path @param {string | object} content
   * @returns {Promise<{ content: string | object, note: string }>}
   */
  const ruled = async (scope, path, content) => {
    if (!isBookingPath(scope, path)) return { content, note: '' };
    let next = content;
    if (typeof content === 'string') {
      try {
        next = JSON.parse(content);
      } catch {
        return { content, note: '' }; // not JSON: the format check refuses it
      }
    }
    const before = await ws.readJSON(scope, path).catch(() => undefined);
    const { value, note } = shioriBooking(before, next);
    return { content: value === next ? content : value, note };
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
      description: 'Read a file: text and JSON as text, a photo as an image you can see, a PDF as a document when your model reads PDFs, a Wallet pass (.pkpass) as what it says. Long text comes in pieces; read again with from. With a region, a photo is cropped to that part and sent with more detail.',
      input: {
        type: 'object', required: ['path'],
        properties: {
          path: PATH, from: { type: 'integer', minimum: 0, description: 'Character to start from, for long text.' },
          region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: 'For a closer look at part of a photo: [left, top, right, bottom] as fractions from 0 to 1 (pixels work too).' },
        },
      },
      /** @param {{ path: string, from?: number, region?: number[] }} i @param {any} call */
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
          if (i.region) {
            // A closer look (spec §7.2): a crop, always a copy kept in the conversation, never among the trip's files.
            if (!m.width || !m.height) return `${i.path}'s size isn't known, so it can't be cropped. read it whole instead.`;
            const healed = healRegion(i.region, m.width, m.height);
            const sent = call.photos ? await call.photos.copy(source, healed.crop) : null;
            if (!sent) return "Photos can't be cropped here.";
            const part = `part [${healed.used.join(', ')}] (${healed.crop.width}×${healed.crop.height} of ${m.width}×${m.height})`;
            const note = healed.notes.length ? ` (The region was healed: ${healed.notes.join('; ')}.)` : '';
            return {
              content: `The photo ${i.path}, ${part}, sent as ${sent.width}×${sent.height}.${note}`,
              images: [{ mediaType: sent.mediaType, hash: sent.hash, ...(sent.data ? { data: sent.data } : {}), path: i.path, region: healed.used }],
            };
          }
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
        if (entry.type === 'application/vnd.apple.pkpass') {
          // A Wallet pass (spec §8): what it says, read by annai's own unzip.
          return `The Wallet pass ${i.path}:\n${JSON.stringify(await readPass(new Blob([/** @type {BlobPart} */ (bytes)])), null, 1)}`;
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
        const r = await ruled(scope, path, i.content);
        const e = await ws.write(scope, path, r.content, { author: 'shiori' }).catch((/** @type {unknown} */ x) => { throw plain(x, i.path); });
        return `Wrote ${i.path} (${e.size} bytes).${r.note}`;
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
        const r = await ruled(scope, path, now.replace(i.old, () => i.new));
        await ws.write(scope, path, r.content, { author: 'shiori' }).catch((/** @type {unknown} */ x) => { throw plain(x, i.path); });
        return `Edited ${i.path}.${r.note}`;
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
        if (isBookingPath(scope, path)) {
          const before = await ws.readJSON(scope, path).catch(() => undefined);
          if (before === undefined) throw new Error(`No file at ${i.path}.`);
          const { value, note } = shioriBooking(before, mergePatch(before, i.changes, { append: true }));
          await ws.write(scope, path, value, { author: 'shiori' }).catch((/** @type {unknown} */ x) => { throw plain(x, i.path); });
          return `Patched ${i.path}.${note}`;
        }
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
