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
 * The check and the record are one transaction (createTrip), so two calls never make two. @param {Workspace} ws @returns {Promise<string>}
 */
export const ensureDraft = (ws) => createTrip(ws, { title: DRAFT_TITLE }, { draft: true });

const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
/** @param {string} s */
const clip = (s) => (graphemes ? [...graphemes.segment(s)].map((g) => g.segment) : [...s]).slice(0, NAME_MAX).join('').trim();

/**
 * A chat's first name: its first line's first sentence, up to 40 characters; with no words, the first file's name, or "Photo · 12:10" or "Voice · 12:10".
 * Punctuation alone is no words. Never blank. @param {{ text?: string, file?: string, photo?: boolean, voice?: boolean, at: number, tz: string }} o
 */
export function chatName({ text = '', file, photo, voice, at, tz }) {
  const s = String(text);
  const from = s.search(/[^\s\p{P}]/u);
  if (from >= 0) {
    const end = s.slice(from).search(/[.!?。！？\n]/u);
    const name = clip(end < 0 ? s : s.slice(0, from + end + (s[from + end] === '\n' ? 0 : 1)));
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
  /** @type {Set<(id: string) => void>} */
  #waiting = new Set();
  /** @type {Map<string, { scope: string, at: number }>} heard lines that spent a draft before their words came, by id */
  #unnamed = new Map();
  /** @type {Promise<unknown>} events are taken one at a time, in order: a heard line before its words, a half's copy after the first */
  #queue = Promise.resolve();
  /** @type {Promise<void> | null} */
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

  /** The draft, once one is ready; a draft that couldn't be made is tried again here. @returns {Promise<string>} */
  whenReady() {
    if (this.ready) return Promise.resolve(this.ready);
    if (!this.#making) this.#make().catch(() => {});
    return new Promise((r) => this.#waiting.add(r));
  }

  #make() {
    this.#making ??= ensureDraft(this.ws).then((id) => {
      this.ready = id;
      for (const r of this.#waiting) r(id);
      this.#waiting.clear();
    }).finally(() => { this.#making = null; });
    return this.#making;
  }

  /** @param {any} e a logged entry, with its scope; or a file kept ({ type: 'file', scope, path, entry, ts }) */
  async #took(e) {
    const tz = this.tz();
    if (e.type === 'heard.text') {
      const was = this.#unnamed.get(e.data?.of);
      if (!was || was.scope !== e.scope) return;
      this.#unnamed.delete(e.data.of);
      const words = String(e.data?.text ?? '');
      return this.#name(e.scope, chatName({ text: words === NOT_TRANSCRIBED ? '' : words, voice: true, at: was.at, tz }));
    }
    if (!this.ready || e.scope !== this.ready) return;
    if (talks(e)) {
      if (e.type === 'heard' && typeof e.data?.text !== 'string') {
        this.#unnamed.set(e.data?.id, { scope: e.scope, at: e.ts });
        return this.#spend(e.scope, null);
      }
      const text = String({ ...e.data, ...(await storedTexts(this.ws.store, e)) }.text ?? '');
      const photo = Boolean(e.data?.images?.length);
      return this.#spend(e.scope, chatName({ text: text === PHOTO_ONLY ? '' : text, photo, voice: e.type === 'heard', at: e.ts, tz }));
    }
    if (e.type === 'file') return this.#spend(e.scope, chatName(isPhotoType(e.entry?.type) ? { photo: true, at: e.ts, tz } : { file: e.path, at: e.ts, tz }));
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

  /** Named as system, only while it still has the draft's name: a name the user or Shiori gave meanwhile stays. @param {string} scope @param {string} title */
  async #name(scope, title) {
    await this.ws.update(scope, '/trip.json', (trip) => (trip.title === DRAFT_TITLE ? { ...trip, title } : trip), { author: 'system' });
  }
}
