import { createTrip, talks, DRAFT_TITLE } from './scopes.js';
import { storedTexts } from './agent/log.js';
import { NOT_TRANSCRIBED } from './voice/resolve.js';
import { PHOTO_ONLY } from './agent/loop.js';
import { timeIn } from './time.js';
import { isPhotoType } from './photos.js';
import { blobJSON } from './reach.js';
import { t } from './l10n.js';

/** @typedef {import('./workspace.js').Workspace} Workspace */

export { DRAFT_TITLE };
/** The most a first line's name keeps, in characters as people count them. */
const NAME_MAX = 40;

/**
 * The one standing draft: a trip scope flagged draft, made once and never removed (a removal would sweep every blob, and lose a file added without a line).
 * The check and the record are one transaction (createTrip), so two calls never make two. A draft whose making was cut off between its record and
 * its trip.json (a reload) gets the file now: without it, nothing could name it. @param {Workspace} ws @returns {Promise<string>}
 */
export async function ensureDraft(ws) {
  const id = await createTrip(ws, { title: DRAFT_TITLE }, { draft: true });
  if ((await ws.read(id, '/trip.json')) === undefined) {
    const rec = await ws.store.tx(['scopes'], 'readonly', (t) => t.getScope(id));
    await ws.write(id, '/trip.json', { id: rec?.tripId, title: DRAFT_TITLE, places: [], party: [] }, { author: 'user' });
  }
  return id;
}

/**
 * The dates a conversation had before Shiori's newest dating write of it, while the line that says so is to show: until the user writes or speaks again
 * after her write (then it goes for good; unlike the hand-over's Undo line, which stays in the conversation at its place), and while the dates are still the ones that write set (a later title doesn't change
 * them; the user's own date edit does). Her dating write is one whose version before had no start and whose own has one. Only the file writes
 * since the user's last line are read. Null: none, or not to show.
 * @param {any} store @param {string} scope @returns {Promise<{ start?: string, end?: string } | null>}
 */
export async function herDating(store, scope) {
  const [now, writes] = await store.tx(['files', 'events'], 'readonly', async (/** @type {any} */ x) => {
    const [typed] = await x.listEvents(scope, { types: ['msg.user'], reverse: true, limit: 1 });
    const spoken = (await x.listEvents(scope, { types: ['heard'], ...(typed ? { after: typed.seq } : {}) })).filter((/** @type {any} */ e) => talks(e));
    const last = Math.max(typed?.seq ?? 0, ...spoken.map((/** @type {any} */ e) => e.seq));
    return [
      await x.getFile(scope, '/trip.json'),
      (await x.listEvents(scope, { types: ['file.write'], reverse: true, after: last })).filter((/** @type {any} */ e) => e.data?.path === '/trip.json'),
    ];
  });
  const current = await blobJSON(store, scope, now?.hash, { quiet: true });
  if (!current?.start) return null; // most conversations: undated
  for (const e of writes) {
    if (e.actor !== 'shiori' || typeof e.data?.old !== 'string') continue;
    const [before, after] = await Promise.all([blobJSON(store, scope, e.data.old, { quiet: true }), blobJSON(store, scope, e.data.new, { quiet: true })]);
    if (before?.start || !after?.start) continue;
    return after.start === current.start && after.end === current.end ? { start: before?.start, end: before?.end } : null;
  }
  return null;
}

/**
 * Puts a conversation's dates back to what they were before Shiori's dating (herDating's), as the user's write: only the dates, so a name given since stays.
 * @param {Workspace} ws @param {string} scope @param {{ start?: string, end?: string }} before
 */
export async function undoDating(ws, scope, before) {
  await ws.update(scope, '/trip.json', (trip) => {
    const { start: _s, end: _e, ...rest } = trip;
    return { ...rest, ...(before.start === undefined ? {} : { start: before.start }), ...(before.end === undefined ? {} : { end: before.end }) };
  }, { author: 'user' });
}

const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const sentences = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;
/** @param {string} s */
const clip = (s) => (graphemes ? [...graphemes.segment(s)].map((g) => g.segment) : [...s]).slice(0, NAME_MAX).join('').trim();

/**
 * The English rule: a full stop (ASCII only) straight after a word of one or two letters (Mt., St., Dr.) is an abbreviation's, not a sentence's end. The cost: a
 * sentence that really ends on a short word ("We land in LA.") runs on into the next, and is cut at NAME_MAX as a long name is. A new line still ends it.
 * The word is the letters after a space or a mark (U.S., p.m.), not the end of a longer word: 8pm., 3rd., Nobu's. and check-in. end a sentence. The spaces after it
 * may be no-break ones (Mt.&nbsp;Fuji, as pasted text often has); a new line is not one.
 * @param {string} s @param {number} end index just past a sentence's end mark
 */
const shortWordStop = (s, end) => /(?:^|[^\p{L}\p{N}'’-])\p{L}{1,2}\.[\p{Zs}\t]*$/u.test(s.slice(0, end));

/** Where the sentence holding index i ends: as the browser breaks sentences (never inside 3.5, 7.30, U.S. or booking.com), else at . ! ? 。！？ or a new line; but not after Mt. @param {string} s @param {number} i */
function sentenceEnd(s, i) {
  if (sentences) {
    for (const x of sentences.segment(s)) {
      const end = x.index + x.segment.length;
      if (end > i && !shortWordStop(s, end)) return end;
    }
    return s.length;
  }
  for (let at = i; ; ) {
    const stop = s.slice(at).search(/[.!?。！？\n]/u);
    if (stop < 0) return s.length;
    at += stop + 1;
    if (!shortWordStop(s, at)) return at;
  }
}

/**
 * A chat's first name: its first line's first sentence, up to 40 characters; with no words, the first file's name, or "Photo · 12:10" or "Voice · 12:10".
 * Punctuation alone is no words. Never blank. @param {{ text?: string, file?: string, photo?: boolean, voice?: boolean, at: number, tz: string }} o
 */
export function chatName({ text = '', file, photo, voice, at, tz }) {
  const s = String(text);
  const from = s.search(/[^\s\p{P}]/u);
  if (from >= 0) {
    const name = clip(s.slice(0, sentenceEnd(s, from)));
    if (name) return name;
  }
  if (file) return clip(/** @type {string} */ (file.split('/').pop())) || file; // a split always has a last part
  const time = timeIn(at, tz);
  if (photo) return t`Photo · ${time}`;
  if (voice) return t`Voice · ${time}`;
  return clip(s) || t`New conversation`;
}

/**
 * Keeps the draft ready and spends it on first use: the first user line (typed, or heard and not dismissed), a file kept in it, or anything else the
 * user does to it in Details.
 * Spending clears the flag first, so the row shows at once, then names it as system, then makes the next draft.
 */
export class Chats {
  /** @type {string | null} the draft + opens; null while the next is made */
  ready = null;
  /** @type {Map<string, { name: string, path: string }>} conversations a kept file spent, this page load: the name it gave, and the file as a line hands it */
  #byFile = new Map();
  /** @type {Promise<unknown>} events are taken one at a time, in order: a heard line before its words, a half's copy after the first */
  #queue = Promise.resolve();
  /** @type {Promise<string> | null} */
  #making = null;

  /** @param {{ ws: Workspace, agent: { on: (kind: 'event', fn: (e: any) => void) => () => void }, tz: () => string }} c */
  constructor({ ws, agent, tz }) {
    this.ws = ws;
    this.agent = agent;
    this.tz = tz;
  }

  async start() {
    this.agent.on('event', (e) => { this.#take(e); });
    // A file kept in it, with or without a line or a model to wake (the camera, the Share target, Details): never hidden in a draft. Nor is any other
    // write in it that isn't annai's own or Shiori's (a name or dates saved in Details, a file added by its path, a plugin's tab). The draft's own
    // first files are written before it is `ready`, so they are never taken for a use of it.
    this.ws.onChange((c) => {
      const by = c.entry?.author;
      if (c.op !== 'write' || !(c.path.startsWith('/files/') || (c.scope === this.ready && by !== 'system' && by !== 'shiori'))) return;
      this.#take({ type: 'file', scope: c.scope, path: c.path, entry: c.entry, ts: this.ws.now() });
    });
    await this.#make();
  }

  /** One at a time, in order. @param {any} e */
  #take(e) {
    return (this.#queue = this.#queue.then(() => this.#took(e)).catch((err) => console.warn(/* en */ "a chat couldn't be named", err)));
  }

  /**
   * The user archived or removed a conversation (Details): if it is the draft, it is used, under the name it has, and another is made. Without this
   * + would go on opening one that is archived, or gone. @param {string} scope
   */
  used(scope) {
    return this.#take({ type: 'used', scope });
  }

  /** The draft, once one is ready. A draft that can't be made rejects, and the next call tries again. @returns {Promise<string>} */
  whenReady() {
    return this.ready ? Promise.resolve(this.ready) : this.#make();
  }

  /** @returns {Promise<string>} */
  #make() {
    this.#making ??= ensureDraft(this.ws).then((id) => (this.ready = id)).finally(() => { this.#making = null; });
    return this.#making;
  }

  /** @param {any} e a logged entry, with its scope; a file written ({ type: 'file', scope, path, entry, ts }); or a conversation archived or removed ({ type: 'used', scope }) */
  async #took(e) {
    const tz = this.tz();
    if (e.type === 'heard.text') {
      // A heard line spent it before its words came, in this page load or an earlier one: it still has the draft's name.
      const rec = await this.ws.store.tx(['scopes'], 'readonly', (t) => t.getScope(e.scope));
      if (rec?.kind !== 'trip' || rec.draft || rec.title !== DRAFT_TITLE) return;
      const words = String(e.data?.text ?? '');
      return this.#name(e.scope, chatName({ text: words === NOT_TRANSCRIBED ? '' : words, voice: true, at: rec.created, tz }));
    }
    const byFile = this.#byFile.get(e.scope);
    if (byFile && talks(e)) {
      // The words typed with the file (the box keeps files first, then sends the line that hands them): they name it, as a first line does.
      this.#byFile.delete(e.scope);
      const hands = [...(e.data?.handed ?? []), ...(e.data?.images ?? [])].some((/** @type {any} */ f) => f?.path === byFile.path);
      const text = hands ? await this.#text(e) : '';
      if (/[^\s\p{P}]/u.test(text)) await this.#name(e.scope, chatName({ text, at: e.ts, tz }), byFile.name);
      return;
    }
    if (!this.ready || e.scope !== this.ready) return;
    if (talks(e)) {
      if (e.type === 'heard' && typeof e.data?.text !== 'string') return this.#spend(e.scope, null);
      const photo = Boolean(e.data?.images?.length);
      return this.#spend(e.scope, chatName({ text: await this.#text(e), photo, voice: e.type === 'heard', at: e.ts, tz }));
    }
    if (e.type === 'used' || (e.type === 'file' && !e.path.startsWith('/files/'))) return this.#spend(e.scope, null); // used, under the name it has
    if (e.type === 'file') {
      const name = chatName(isPhotoType(e.entry?.type) ? { photo: true, at: e.ts, tz } : { file: e.path, at: e.ts, tz });
      this.#byFile.set(e.scope, { name, path: `/trip${e.path}` });
      return this.#spend(e.scope, name);
    }
  }

  /** A line's words, kept in it or beside it (a long one); a photo's stand-in is none. @param {any} e */
  async #text(e) {
    const text = String({ ...e.data, ...(await storedTexts(this.ws.store, e)) }.text ?? '');
    return text === PHOTO_ONLY ? '' : text;
  }

  /** @param {string} scope @param {string | null} name null: its words are still to come */
  async #spend(scope, name) {
    this.ready = null;
    try {
      const now = this.ws.now();
      await this.ws.store.tx(['scopes'], 'readwrite', async (t) => {
        const rec = await t.getScope(scope);
        if (!rec?.draft) return;
        const { draft: _, ...used } = rec;
        await t.putScope({ ...used, created: now }); // its row sits where it was first used, not where the draft was made
      });
      if (name) await this.#name(scope, name);
    } finally {
      await this.#make();
    }
  }

  /**
   * Named as system, only while it still has the name it had (the draft's, or the one its file gave): a name the user or Shiori gave meanwhile stays.
   * @param {string} scope @param {string} title @param {string} [was]
   */
  async #name(scope, title, was = DRAFT_TITLE) {
    await this.ws.update(scope, '/trip.json', (trip) => (trip.title === was ? { ...trip, title } : trip), { author: 'system' });
  }
}
