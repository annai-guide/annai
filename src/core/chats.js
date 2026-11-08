import { createTrip, talks, DRAFT_TITLE } from './scopes.js';
import { storedTexts } from './agent/log.js';
import { NOT_TRANSCRIBED } from './voice/resolve.js';
import { PHOTO_ONLY } from './agent/loop.js';
import { timeIn } from './time.js';
import { isPhotoType } from './photos.js';
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

const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const sentences = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;
/** @param {string} s */
const clip = (s) => (graphemes ? [...graphemes.segment(s)].map((g) => g.segment) : [...s]).slice(0, NAME_MAX).join('').trim();

/** Where the sentence holding index i ends: as the browser breaks sentences (never inside 3.5, 7.30, U.S. or booking.com), else at . ! ? 。！？ or a new line. @param {string} s @param {number} i */
function sentenceEnd(s, i) {
  if (sentences) for (const x of sentences.segment(s)) if (x.index + x.segment.length > i) return x.index + x.segment.length;
  const end = s.slice(i).search(/[.!?。！？\n]/u);
  return end < 0 ? s.length : i + end + 1;
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
  if (file) return clip(file.split('/').pop() ?? file) || file;
  const time = timeIn(at, tz);
  if (photo) return t`Photo · ${time}`;
  if (voice) return t`Voice · ${time}`;
  return clip(s) || t`New conversation`;
}

/**
 * Keeps the draft ready and spends it on first use: the first user line (typed, or heard and not dismissed) or a file kept in it.
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
    const take = (/** @type {any} */ e) => { this.#queue = this.#queue.then(() => this.#took(e)).catch((err) => console.warn(/* en */ "a chat couldn't be named", err)); };
    this.agent.on('event', take);
    // A file kept in it, with or without a line or a model to wake (the camera, the Share target, Details): never hidden in a draft.
    this.ws.onChange((c) => { if (c.op === 'write' && c.path.startsWith('/files/')) take({ type: 'file', scope: c.scope, path: c.path, entry: c.entry, ts: this.ws.now() }); });
    await this.#make();
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

  /** @param {any} e a logged entry, with its scope; or a file kept ({ type: 'file', scope, path, entry, ts }) */
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
