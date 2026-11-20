import { VERSION } from '../../app/version.js';
import { resolvePath, rootOf, RESULT_MAX, READ_ON } from '../../core/agent/tools.js';
import { cut as cutAt } from '../../core/web-search.js';
import { isTextType } from '../../core/paths.js';
import { kindOf } from '../../core/scopes.js';
import { ValidationError, NotFoundError } from '../../core/workspace.js';
import { sizeLine, healRegion } from '../../core/request-photos.js';
import { readPass } from '../../core/pkpass.js';
import { isBookingPath, shioriBooking, unalias, checkNote } from '../../core/bookings.js';
import { t } from '../../core/l10n.js';
import { NAMES_FILE } from '../../core/names.js';

export const manifest = {
  id: 'files',
  name: t`File tools`,
  version: VERSION,
  api: 1,
  description: t`Shiori's tools for the trip's files and your own: list, read, write, edit, patch, search and delete.`,
};

// Below, Shiori's words: English (localization design, section 7).

/** A long text's piece: the result's limit, less the room its line that says how to read on needs, so the result's own cut never takes that line. */
const TEXT_MAX = RESULT_MAX - READ_ON;
/* en */
const OTHER_TRIPS = "These are only this conversation's files: what isn't here may be in another of their trips (list_trips).";
/* en */
const PATH = { type: 'string', description: 'A path starting with /trip/ (the open trip) or /me/ (your profile, memory and notes).' };

/** @param {any} annai */
export function activate(annai) {
  const ws = annai.files;
  const { tsv } = annai.helpers;
  /** @param {string} path @param {any} call */
  const where = (path, call) => resolvePath(path, call.trip);
  /** The turn's hand-over, for what she writes and deletes in it, so Undo can take it back. @param {any} call */
  const turnOf = (call) => (call.handover ? { handover: String(call.handover) } : {});
  /** Checked on the path as resolved, so no way of writing it gets around the rule (spec §14.1). @param {string} scope @param {string} path */
  const writable = (scope, path) => {
    /* en */
    if (scope === 'me' && (path === '/personalities' || path.startsWith('/personalities/'))) throw new Error('Personalities change only through tune_personality.');
    /* en */
    if (scope === 'me' && (path === '/instructions' || path.startsWith('/instructions/'))) throw new Error('Your instructions are the user\'s to change, in Settings → Shiori.');
  };
  /**
   * Plan items and bookings sit directly in their folders, where the format check and the booking rule cover them (spec §4.4).
   * @param {string} scope @param {string} path
   */
  const recordPlace = (scope, path) => {
    if (kindOf(scope) === 'trip' && /^\/(plan|bookings)\/.+\/[^/]+\.json$/i.test(path)) {
      /* en */
      throw new Error('Plan items and bookings go directly in /trip/plan/ and /trip/bookings/, one file each: no subfolders.');
    }
  };
  /** @param {unknown} e @param {string} path */
  const plain = (e, path) => {
    // Said plainly, so she never tells the user it was done.
    /* en */
    if (e instanceof ValidationError) return new Error(`${path} doesn't match its format, so it wasn't written: ${e.errors.join('; ')}`);
    /* en */
    if (e instanceof NotFoundError) return new Error(`No file at ${path}, so nothing was changed.`);
    return e;
  };
  /**
   * Shiori's rule for bookings (spec §4.4), as a guard the workspace runs inside the file's lock, on what is stored and on the value as
   * it will be read, so no wording of the text and no timing gets around it. The booking schema in force is the one the format check
   * uses. Not a booking: none.
   * @param {string} scope @param {string} path @param {any} [changes] a patch's changes, as renamed
   * @returns {((before: any, next: any) => any) | undefined}
   */
  const guardOf = (scope, path, changes) => {
    if (!isBookingPath(scope, path)) return undefined;
    const schema = ws.schemaFor(scope, path);
    return (before, next) => shioriBooking(before, next, { schema, changes });
  };
  /**
   * What renames this write's own keys written under other names, before it is merged (the drive-test follow-ups, section 3), with the
   * trip's time zones and the stored booking's kind; what it leaves out that Shiori should hear of goes into notes, which the result
   * says. Not a booking: nothing is renamed.
   * @param {string} scope @param {string} path
   * @returns {Promise<(v: any, o: { append?: boolean, notes: string[] }) => any>}
   */
  const ownOf = async (scope, path) => {
    if (!isBookingPath(scope, path)) return (v) => v;
    const zones = (await ws.readJSON(scope, '/trip.json').catch(() => null))?.timezones;
    const kind = (await ws.readJSON(scope, path).catch(() => undefined))?.kind;
    const o = { zones: Array.isArray(zones) ? zones.filter((z) => typeof z === 'string') : [], schema: ws.schemaFor(scope, path), kind };
    return (v, { append = false, notes }) => unalias(v, { ...o, append, notes });
  };
  /** @param {string} scope @param {string} prefix @param {string} shown the root as Shiori sees it */
  const listed = async (scope, prefix, shown) => (await ws.list(scope, prefix)).map((/** @type {any} */ f) => ({ ...f, shown: `${shown}${f.path}` }));
  /** @param {string} path @param {any} call */
  const filesUnder = async (path, call) => {
    /** @type {any[]} */
    let all;
    if (path === '/' || path === '') {
      all = [...(call.trip ? await listed(call.trip, '/', '/trip') : []), ...(await listed('me', '/', '/me'))];
    } else {
      const { scope, path: inner } = where(path, call);
      all = await listed(scope, inner.endsWith('/') ? inner : `${inner}/`, rootOf(path));
    }
    // The offline pack is for the places tools (spec §11.5): it stays out unless asked for.
    return /^\/?trip\/offline(\/|$)/.test(path) ? all : all.filter((f) => !f.shown.startsWith('/trip/offline/'));
  };
  /**
   * The one existing path a path names but for its case (a model wrote /trip/Files/… for /trip/files/…), as Shiori
   * writes paths; null when there is none, or more than one. @param {string} raw @param {any} call @returns {Promise<string | null>}
   */
  const sameButCase = async (raw, call) => {
    const { scope, path } = where(raw, call);
    // A path that ever held a file is that file's, deleted or not: "no file" is the true answer, never another file.
    if ((await ws.history(scope, path)).length) return null;
    const root = rootOf(raw);
    const found = (await ws.list(scope, '/')).filter((/** @type {any} */ f) => f.path.toLowerCase() === path.toLowerCase());
    return found.length === 1 ? `${root}${found[0].path}` : null;
  };
  /**
   * A tool that, for a path naming no file, uses the one file it names but for its case, and says so first in its result.
   * @param {string} done how the result says it, "read" @param {(i: any, call: any) => Promise<any>} run
   */
  const caseTolerant = (done, run) => async (/** @type {any} */ i, /** @type {any} */ call) => {
    try {
      return await run(i, call);
    } catch (e) {
      const missing = e instanceof NotFoundError || /^No file at /.test(String(/** @type {any} */ (e)?.message));
      const path = missing ? await sameButCase(i.path, call).catch(() => null) : null;
      if (!path || path === i.path) throw e;
      const out = await run({ ...i, path }, call);
      /* en */
      const note = `(${done} ${path}: the path's case differed)`;
      return typeof out === 'string' ? `${note}\n${out}` : { ...out, content: `${note}\n${out.content}` };
    }
  };
  /* en */
  const tools = [
    {
      name: 'list', group: 'Files',
      description: "List files under a folder, as TSV: path, type, size in bytes, modified, author. The trip's offline pack (/trip/offline/) is left out unless asked for.",
      input: { type: 'object', properties: { path: { ...PATH, default: '/' } } },
      /** @param {{ path?: string }} i @param {any} call */
      run: async (i, call) => {
        const rows = tsv(['path', 'type', 'size', 'modified', 'author'], (await filesUnder(i.path ?? '/', call)).map((f) => [f.shown, f.type, f.size, new Date(f.modified).toISOString(), f.author]));
        // The conversation's root, read where she decides "it isn't there" (real models: Sonnet listed and read this trip's files, never
        // list_trips, and said another trip's hotel wasn't there). Koe has no list_trips: its instructions say it.
        return call.trip && call.half !== 'koe' && /^(\/|\/trip\/?)?$/.test(i.path ?? '/') ? `${rows}\n${OTHER_TRIPS}` : rows;
      },
    },
    {
      name: 'read', group: 'Files',
      description: 'Read a file: text and JSON as text, a photo as an image you can see, a PDF as a document (in words or as pictures of its pages, if your model reads no PDFs), a Wallet pass (.pkpass) as what it says. Long text comes in pieces; read again with from. With a region, a photo is cropped to that part and sent with more detail.',
      input: {
        type: 'object', required: ['path'],
        properties: {
          path: PATH, from: { type: 'integer', minimum: 0, description: 'Character to start from, for long text.' },
          region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: 'For a closer look at part of a photo: [left, top, right, bottom] as fractions from 0 to 1 (pixels work too).' },
        },
      },
      /** @param {{ path: string, from?: number, region?: number[] }} i @param {any} call */
      run: caseTolerant('read', async (i, call) => {
        const { scope, path } = where(i.path, call);
        const got = await ws.read(scope, path);
        if (!got) throw new Error(`No file at ${i.path}. list shows what is there.`);
        const { entry, bytes } = got;
        if (entry.type.startsWith('image/')) {
          // For a model that can't see photos, the loop has one that can describe it.
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
          return { content: `The PDF ${i.path}.`, document: { mediaType: 'application/pdf', hash: entry.hash, name: path.split('/').pop(), path: i.path } };
        }
        if (entry.type === 'application/vnd.apple.pkpass') {
          // A Wallet pass (spec §8): what it says, read by annai's own unzip.
          return `The Wallet pass ${i.path}:\n${JSON.stringify(await readPass(new Blob([/** @type {BlobPart} */ (bytes)])), null, 1)}`;
        }
        if (!isTextType(entry.type)) return `${i.path} is a ${entry.type} file, which can't be read as text.`;
        const all = new TextDecoder().decode(bytes);
        const from = Math.max(0, i.from ?? 0);
        // A booking's file ends with the screens' check, apart from its JSON (checkNote); the piece leaves it room.
        const note = checkNote(scope, path, all);
        const after = note ? `\n${note}` : '';
        const piece = cutAt(all.slice(from), TEXT_MAX - after.length); // never ends inside an emoji: its pair goes whole into the next piece
        const rest = all.length - from - piece.length;
        return `${rest > 0 ? `${piece}\n… ${rest} more characters; read again with from: ${from + piece.length}` : piece}${after}`;
      }),
    },
    {
      name: 'write', group: 'Files',
      description: 'Write a whole file: text, or an object stored as JSON. Records such as plan items and bookings must match their format.',
      input: { type: 'object', properties: { path: PATH, content: { type: ['string', 'object'] } }, required: ['path', 'content'] },
      /** @param {{ path: string, content: string | object }} i @param {any} call */
      run: async (i, call) => {
        const { scope, path } = where(i.path, call);
        writable(scope, path);
        recordPlace(scope, path);
        const guard = guardOf(scope, path);
        // JSON text (as Gemini writes it) is renamed as the value it is; text that isn't JSON is the format check's.
        let value = i.content;
        try {
          value = typeof value === 'string' && guard ? JSON.parse(value) : value;
        } catch {}
        /** @type {string[]} */
        const notes = [];
        const renamed = (await ownOf(scope, path))(value, { notes });
        const e = await ws.write(scope, path, renamed === value ? i.content : renamed, { author: 'shiori', guard, ...turnOf(call) }).catch((/** @type {unknown} */ x) => { throw plain(x, i.path); });
        return [`Wrote ${i.path} (${e.size} bytes).`, ...notes].join(' ');
      },
    },
    {
      name: 'edit', group: 'Files',
      description: 'Replace text in a text file. old must appear exactly once.',
      input: { type: 'object', properties: { path: PATH, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] },
      /** @param {{ path: string, old: string, new: string }} i @param {any} call */
      run: caseTolerant('edited', async (i, call) => {
        const text = ['number', 'boolean'].includes(typeof i.new) ? String(i.new) : i.new;
        if (typeof text !== 'string') throw new Error(`new is the text to put in old's place, so ${i.path} wasn't changed.`);
        const { scope, path } = where(i.path, call);
        writable(scope, path);
        recordPlace(scope, path);
        const now = await ws.readText(scope, path);
        if (now === undefined) throw new Error(`No file at ${i.path}, so nothing was changed.`);
        const count = (/** @type {string} */ s) => (s ? now.split(s).length - 1 : 0);
        let [old, next] = [i.old, text];
        // Text copied from a view that shows "<" as <lt> (her to-do list in the now block, search's TSV rows) is read in that layout, the new text
        // too, when as given it matches nothing and so read it matches once.
        const lt = (/** @type {string} */ s) => s.replaceAll('<lt>', '<');
        if (!count(old) && old?.includes('<lt>') && count(lt(old)) === 1) [old, next] = [lt(old), lt(next)];
        const n = count(old);
        if (n === 0) throw new Error(`That text isn't in ${i.path}, so it wasn't changed. read it to see what is.`);
        if (n > 1) throw new Error(`That text appears ${n} times in ${i.path}, so it wasn't changed. Give more of it, so it appears once.`);
        await ws.write(scope, path, now.replace(old, () => next), { author: 'shiori', guard: guardOf(scope, path), ...turnOf(call) }).catch((/** @type {unknown} */ x) => { throw plain(x, i.path); });
        return `Edited ${i.path}.`;
      }),
    },
    {
      name: 'patch', group: 'Files',
      description: 'Change a JSON file with a JSON Merge Patch: given keys replace, null removes, and a key ending in "+" appends to a list.',
      input: { type: 'object', properties: { path: PATH, changes: { type: 'object' } }, required: ['path', 'changes'] },
      /** @param {{ path: string, changes: object }} i @param {any} call */
      run: caseTolerant('patched', async (i, call) => {
        const { scope, path } = where(i.path, call);
        writable(scope, path);
        // A merge patch that isn't an object would replace the whole file with it.
        if (typeof i.changes !== 'object' || i.changes === null || Array.isArray(i.changes)) throw new Error(`changes must be an object, the keys to change, so ${i.path} wasn't changed.`);
        recordPlace(scope, path);
        // Her short names for files start with her first one (names.js): no write of an empty file first.
        /** @type {string[]} */
        const notes = [];
        const changes = (await ownOf(scope, path))(i.changes, { append: true, notes });
        await ws.patch(scope, path, changes, { author: 'shiori', append: true, create: path === NAMES_FILE, guard: guardOf(scope, path, changes), ...turnOf(call) }).catch((/** @type {unknown} */ x) => { throw plain(x, i.path); });
        return [`Patched ${i.path}.`, ...notes].join(' ');
      }),
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
      // Not case-tolerant: for a delete, "no file" is the true answer.
      run: (async (i, call) => {
        const { scope, path } = where(i.path, call);
        writable(scope, path);
        // She may delete a booking the user confirmed, but she hears that they had, so she can say so if it was a mistake.
        const confirmed = isBookingPath(scope, path) && (await ws.readJSON(scope, path).catch(() => undefined))?.status === 'confirmed';
        await ws.delete(scope, path, { author: 'shiori', ...turnOf(call) });
        return `Deleted ${i.path}.${confirmed ? ' The user had confirmed this booking. If deleting it was a mistake, tell them: its history keeps it, so they can restore it.' : ''}`;
      }),
    },
  ];
  const off = tools.map((t) => annai.tools.register(t));
  return () => off.forEach((fn) => fn());
}
