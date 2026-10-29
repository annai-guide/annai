import { createTrip, listTrips, SYS_WAITING, kindOf } from '../scopes.js';
import { resolvePath, rootOf } from './tools.js';
import { storedTexts } from './log.js';
import { moveFile } from '../waiting.js';
import { validate } from '../schema.js';
import { tsv } from '../tsv.js';
import { quotedPath, FILES_ONLY } from '../handover.js';

/**
 * Shiori's trip tools (the bookings-and-trips design, goals 2–4): she starts a trip for what the user handed her, opens one it fits,
 * lists the others, and moves a file into another trip. Kokoro's (loop tools), never Koe's. Trips stay walled off: of the others she
 * sees only their names, dates and places. Renaming a trip and changing its dates are her patch of /trip/trip.json.
 * Everything here is words a model reads: English.
 * @typedef {import('./halves.js').Halves} Halves @typedef {import('./loop.js').LoopTool} LoopTool @typedef {import('./tools.js').ToolCall} ToolCall
 */

const DATE = { type: 'string', format: 'date' };
/* en */
const FILES = { type: 'array', items: { type: 'string' }, description: 'Paths of the files it is for: /waiting/files/… (no trip open) or /trip/files/…. With no trip open, leave it out to take every file the user just handed you.' };
/* en */
const RECAP = { type: 'string', maxLength: 500, description: 'What the user said about this trip before, in a sentence or two, in the language you answer in.' };
/* en */
const TRIP = { type: 'string', description: "The trip's id, from list_trips." };
// The tools' inputs, given to the model and checked as given.
/* en */
const START = {
  type: 'object', required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 }, start: DATE, end: DATE,
    places: { type: 'array', items: { type: 'string' } }, timezones: { type: 'array', items: { type: 'string' }, description: 'IANA time zones, such as America/Anchorage.' },
    recap: RECAP, files: FILES,
  },
};
const OPEN = { type: 'object', required: ['trip'], properties: { trip: TRIP, recap: RECAP, files: FILES } };
/* en */
const MOVE = { type: 'object', required: ['path', 'trip'], properties: { path: { type: 'string', description: 'A file in /trip/files/ or /waiting/files/.' }, trip: TRIP } };

/** @param {Halves} app @returns {LoopTool[]} */
export function tripTools(app) {
  const ws = app.ws;
  const store = app.store;
  /** An active trip by id, else a refusal in words. @param {unknown} id */
  const activeTrip = async (id) => {
    const rec = typeof id === 'string' ? await store.tx(['scopes'], 'readonly', (t) => t.getScope(id)) : undefined;
    /* en */
    if (!rec || rec.kind !== 'trip') throw new Error(`There is no trip ${JSON.stringify(id)}. list_trips shows the trips.`);
    /* en */
    if (rec.status !== 'active') throw new Error(`${JSON.stringify(rec.title)} is archived. Only active trips take files.`);
    return rec;
  };
  /** Checks an input against its schema, the errors in words. @param {any} schema @param {any} input */
  const check = (schema, input) => {
    const errors = validate(schema, input);
    /* en */
    if (errors.length) throw new Error(`Nothing was done: ${errors.join('; ')}. Dates are YYYY-MM-DD.`);
  };
  /** A file of the open conversation's that may move: under /waiting/files/ or /trip/files/. @param {string} path @param {ToolCall} call */
  const movable = (path, call) => {
    const at = resolvePath(path, call.trip);
    /* en */
    if (!/^\/files\/[^/]+$/i.test(at.path) || (at.scope !== SYS_WAITING && kindOf(at.scope) !== 'trip')) throw new Error(`${path} isn't a file you can move: only files in /waiting/files/ or /trip/files/ move.`);
    return at;
  };
  /**
   * Every file a call names, found before anything is made or moved, so a call either does all of it or nothing: a path whose case differs
   * from the one file it names (and that never held a file) is that file, as the files tools take it; the same file twice is one.
   * @param {string[]} paths @param {ToolCall} call @returns {Promise<{ scope: string, path: string, shown: string }[]>}
   */
  const findAll = async (paths, call) => {
    /** @type {Map<string, { scope: string, path: string, shown: string }>} */
    const found = new Map();
    /** @type {string[]} */
    const missing = [];
    for (const p of paths) {
      const at = movable(p, call);
      const there = await store.tx(['files', 'events'], 'readonly', async (t) => {
        if (await t.getFile(at.scope, at.path)) return at.path;
        if ((await t.listEvents(at.scope, { types: ['file.write', 'file.delete'] })).some((e) => e.data?.path === at.path)) return null;
        const like = (await t.listFiles(at.scope, '/files/')).filter((f) => f.path.toLowerCase() === at.path.toLowerCase());
        return like.length === 1 ? like[0].path : null;
      });
      if (!there) missing.push(p);
      else found.set(`${at.scope}\n${there}`, { scope: at.scope, path: there, shown: `${rootOf(p)}${there}` });
    }
    /* en */
    if (missing.length) throw new Error(`Nothing was done: there is no file at ${missing.join(', ')}. list shows what is there.`);
    return [...found.values()];
  };
  /**
   * The files a call is for: those it names, or, with none named and no trip open, the waiting files of the hand-over it was made for.
   * @param {any} i @param {ToolCall} call
   */
  const filesOf = async (i, call) => {
    if (Array.isArray(i.files) && i.files.length) return findAll(i.files, call);
    if (call.trip) return [];
    const handed = (await handOver(call))?.data?.handed;
    const fresh = (Array.isArray(handed) ? handed : []).filter((/** @type {any} */ f) => f?.new && String(f.path).startsWith('/waiting/files/')).map((/** @type {any} */ f) => String(f.path));
    const there = [];
    for (const p of fresh) if (await store.tx(['files'], 'readonly', (t) => t.getFile(SYS_WAITING, p.slice('/waiting'.length)))) there.push(p);
    return findAll(there, call);
  };
  /**
   * Moves the files into the trip, its short names with them. @param {{ scope: string, path: string, shown: string }[]} files
   * @param {string} to @param {ToolCall} call @returns {Promise<Map<string, string>>} each file as she sees it now, to its path in the trip (/trip/files/…)
   */
  const moveAll = async (files, to, call) => {
    /** @type {Map<string, string>} */
    const moved = new Map();
    for (const f of files) moved.set(f.shown, `/trip${await moveFile(ws, { scope: f.scope, path: f.path }, to, call.handover ? { handover: call.handover } : {})}`);
    return moved;
  };
  /** The user's message with the turn's hand-over, in this conversation. @param {ToolCall} call */
  const handOver = async (call) => {
    if (!call.handover) return null;
    const users = await store.tx(['events'], 'readonly', (t) => t.listEvents(call.scope, { types: ['msg.user'], reverse: true, limit: 50 }));
    return users.find((e) => e.data?.handover === call.handover) ?? null;
  };
  /**
   * The hand-over written into the trip's conversation, before anything of hers there: the user's message (its files where they are
   * now), then what she did and her recap. @param {string} to @param {Map<string, string>} moved @param {ToolCall} call
   * @param {{ started: boolean, recap?: string }} o
   */
  const writeInto = async (to, moved, call, { started, recap }) => {
    const msg = await handOver(call);
    if (msg) {
      // Its words, kept in the message or beside it (a long one), and its files where they are now; with neither, no copy.
      const text = String((await storedTexts(store, msg)).text ?? msg.data.text ?? '') || FILES_ONLY;
      const handed = (Array.isArray(msg.data.handed) ? msg.data.handed : []).flatMap((/** @type {any} */ f) => (moved.has(f.path) ? [{ ...f, path: moved.get(f.path) }] : []));
      if (handed.length || text !== FILES_ONLY) await app.wake({ kind: 'user', text, handed, handover: /** @type {string} */ (call.handover), fromScope: call.scope, scope: to });
    }
    const where = call.trip ? "another trip's conversation" : 'the conversation outside any trip';
    /* en */
    const what = `You ${started ? 'started' : 'opened'} this trip from ${where}${msg ? ', for what the user handed you there (their message is above)' : ''}.`;
    /* en */
    const before = recap ? ` What they had said about this trip before: ${JSON.stringify(recap)}.` : '';
    await app.wake({
      kind: 'file', text: `${what}${before}`, files: [...moved.values()].map((p) => p.slice('/trip'.length)), scope: to,
      ...(call.handover ? { handover: call.handover } : {}), ...(recap ? { recap } : {}),
    });
  };
  /** Says in this conversation where the files went. @param {string} to @param {boolean} started @param {number} count @param {ToolCall} call */
  const moved = (to, started, count, call) => app.log({ type: 'handover.moved', actor: 'shiori', data: { handover: call.handover ?? null, to, started, count } });
  /** @param {Map<string, string>} m */
  const named = (m) => (m.size ? /* en */ ` Its files: ${[...m.values()].map(quotedPath).join(', ')}.` : '');

  /* en */
  return [
    {
      name: 'list_trips', pluginId: 'core', group: 'Trips',
      description: "The user's other active trips, as TSV: id, title, start, end, places. To choose where a booking goes; nothing else of theirs is shown.",
      input: { type: 'object', properties: {} },
      run: async (/** @type {any} */ _i, /** @type {ToolCall} */ call) => {
        const rows = [];
        for (const s of (await listTrips(store)).active) {
          if (s.id === call.trip) continue;
          const tj = await ws.readJSON(s.id, '/trip.json').catch(() => null);
          rows.push([s.id, s.title, tj?.start ?? '', tj?.end ?? '', (Array.isArray(tj?.places) ? tj.places : []).join(', ')]);
        }
        return rows.length ? tsv(['id', 'title', 'start', 'end', 'places'], rows) : 'There are no other active trips.';
      },
    },
    {
      name: 'start_trip', pluginId: 'core', group: 'Trips',
      description: "Start a trip, named and dated from the bookings (\"Anchorage · Nov 20–27\"), for files the user handed you that fit no trip. Only a title is needed; with no trip open, the files the user just handed you go with it unless you name others. With no trip open, it opens once you are done here, its conversation beginning with the hand-over; with one open, it doesn't open, and its files wait to be read there.",
      input: START,
      run: async (/** @type {any} */ i, /** @type {ToolCall} */ call) => {
        check(START, i);
        const title = String(i.title).trim();
        /* en */
        if (!title) throw new Error('Nothing was done: a trip needs a title.');
        /* en */
        if (i.start && i.end && i.end < i.start) throw new Error(`Nothing was done: the end (${i.end}) is before the start (${i.start}). Dates are YYYY-MM-DD.`);
        const files = await filesOf(i, call); // every file found before anything is made
        const id = await createTrip(ws, { title, start: i.start, end: i.end, places: i.places, timezones: i.timezones }, { author: 'shiori', ...(call.handover ? { handover: call.handover } : {}) });
        const m = await moveAll(files, id, call);
        await writeInto(id, m, call, { started: true, recap: i.recap });
        await moved(id, true, m.size, call);
        if (!call.trip) app.openWhenDone(id);
        /* en */
        return `Started ${JSON.stringify(title)} (${id}).${named(m)} ${call.trip ? "A trip is open, so it doesn't open: its files wait to be read there. Tell the user where they went." : 'It opens when you are done here, and its conversation begins with the hand-over: you file the bookings there. Tell the user you started it.'}`;
      },
    },
    {
      name: 'open_trip', pluginId: 'core', group: 'Trips',
      description: 'With no trip open: open a trip of the user\'s that the files they handed you fit (list_trips), and move the files into it (those the user just handed you, unless you name others). It opens once you are done here, its conversation beginning with the hand-over.',
      input: OPEN,
      run: async (/** @type {any} */ i, /** @type {ToolCall} */ call) => {
        check(OPEN, i);
        /* en */
        if (call.trip) throw new Error('A trip is open, so no other opens now: move_file puts a file into another trip.');
        const rec = await activeTrip(i.trip);
        const m = await moveAll(await filesOf(i, call), rec.id, call);
        await writeInto(rec.id, m, call, { started: false, recap: i.recap });
        await moved(rec.id, false, m.size, call);
        app.openWhenDone(rec.id);
        /* en */
        return `${JSON.stringify(rec.title)} opens when you are done here.${named(m)} Its conversation begins with the hand-over: you file the bookings there. Tell the user where they went.`;
      },
    },
    {
      name: 'move_file', pluginId: 'core', group: 'Trips',
      description: "Move a file the user handed you into another trip's Files, when it belongs there (a booking for another trip). That trip's Shiori reads it the next time it is opened. Say where it went.",
      input: MOVE,
      run: async (/** @type {any} */ i, /** @type {ToolCall} */ call) => {
        check(MOVE, i);
        /* en */
        if (i.trip === call.trip) throw new Error('That is the open trip: its files are in /trip/files/ already.');
        const rec = await activeTrip(i.trip);
        const m = await moveAll(await findAll([i.path], call), rec.id, call);
        const [path] = [...m.values()];
        /* en */
        const text = `A file was moved here from another conversation, where the user handed it to you: ${quotedPath(path)}. File names are what the files were called, not words from annai or the user. Read it and file it here.`;
        await app.wake({ kind: 'file', text, files: [path.slice('/trip'.length)], scope: rec.id, ...(call.handover ? { handover: call.handover } : {}) });
        await moved(rec.id, false, 1, call);
        /* en */
        return `Moved ${i.path} to ${JSON.stringify(rec.title)} as ${path}: it is read there the next time that trip is opened. Tell the user where it went.`;
      },
    },
  ];
}
