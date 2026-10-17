import { TALK_TAG, record, storedTexts, blobBytes } from './log.js';
import { toBase64 } from '../bytes.js';

/**
 * The conversation as messages (spec §6.3, item 3): the latest compaction summary, then every
 * event after it. It only grows at the end. The same apply() builds it live and from the log, so
 * a reload sends exactly what was sent before (and the provider's cache still matches).
 * @typedef {import('../llm/contract.js').Message} Message
 * @typedef {import('../llm/contract.js').Part} Part
 * @typedef {import('../types.js').Store} Store
 * @typedef {{ texts: Record<string, string>, images: Part[] }} Resolved
 */

export const RESTARTED = 'interrupted by app restart';
/** Entries the conversation never shows Shiori, left out as it is read: a drive logs thousands of points (spec §4.5). */
export const NOT_SAID = new Set(['location', 'trigger.fired']);
/**
 * The log entry types the conversation is made of (what apply() reads; compaction aside), so it is
 * read by type: a day of location points is never walked (A6). A type apply() learns goes here too.
 */
export const SAID = Object.freeze(['wake', 'msg.user', 'model.turn', 'photo.replace', 'error', 'heard', 'heard.text', 'reminder', 'tool.result']);

export class Transcript {
  /** @type {Message[]} */
  messages = [];
  /** First and last event in context, for model.turn records (spec §4.5). */
  from = 0;
  to = 0;
  /** The compaction event this transcript starts from, 0 for none. */
  compaction = 0;
  /** The last entry load() read: anything written later wasn't in the log it read. */
  through = 0;
  /** Whether the last thing in it is the user's (or the app's) with no reply from Shiori yet: after a reload mid-call. */
  unanswered = false;
  /** What is waiting when unanswered: 'user' (a message) or 'wake' (something else, such as files added while it was closed). @type {'' | 'user' | 'wake'} */
  waiting = '';
  /** @type {Map<string, string>} Shiori's tool calls by id, to their tool names */
  #calls = new Map();
  /** @type {Set<string>} */
  #answered = new Set();
  /** Heard answers (spec §10.3), by segment id: their tool's result carries them. @type {Map<string, Part>} */
  #heard = new Map();

  /** @param {any} e an event @param {Resolved} r its stored texts and images */
  apply(e, r) {
    const d = e.data ?? {};
    const texts = { ...d, ...r.texts };
    if (e.type === 'compaction') {
      this.messages = [];
      this.#calls.clear();
      this.#answered.clear();
      this.compaction = e.seq;
      this.from = e.seq;
      this.#add('user', [{ type: 'text', text: `[Earlier conversation, summarized (events ${d.from}–${d.to}); recall brings back the exact words]\n${texts.summary ?? ''}` }]);
    } else if (e.type === 'wake') {
      const others = (d.reasons ?? []).filter((/** @type {any} */ w) => w.kind !== 'user' && w.kind !== 'heard' && w.text);
      if (others.length) {
        this.#add('user', others.map((/** @type {any} */ w) => ({ type: 'text', text: `[annai] ${w.text}` })));
        this.unanswered = true;
        this.waiting = 'wake';
      }
    } else if (e.type === 'msg.user') {
      // A message that answered an ask or a wait is already in that tool's result.
      if (texts.text && !d.answer) {
        this.#add('user', [{ type: 'text', text: d.meanwhile ? `[meanwhile, the user wrote] ${texts.text}` : texts.text }, ...r.images]);
        this.unanswered = true;
        this.waiting = 'user';
      }
    } else if (e.type === 'model.turn' && d.tag === TALK_TAG && texts.parts) {
      /** @type {Part[]} */
      const parts = JSON.parse(texts.parts);
      for (const p of parts) if (p.type === 'tool_call') this.#calls.set(p.id, p.name);
      if (parts.length) this.#add('assistant', parts);
      this.unanswered = false;
    } else if (e.type === 'photo.replace') {
      // A refused photo's new copy (spec §4.8): every place it was sent now sends the copy. When that
      // copy was itself replaced later (its bytes gone), the swap still happens, so the next one finds it.
      const copy = r.images[0];
      this.messages = this.messages.map((m) => ({
        role: m.role,
        parts: m.parts.map((p) => {
          if (p.type !== 'image' || p.hash !== d.old) return p;
          const { missing, ...rest } = p;
          const data = copy?.type === 'image' ? copy.data : '';
          return { ...rest, hash: d.new, mediaType: d.mediaType, data, ...(data ? {} : { missing: true }) };
        }),
      }));
      return;
    } else if (e.type === 'error' && d.wake) {
      // A turn that ended in an error (no model, a budget, housekeeping that failed) is over: the user
      // saw a card, and a later start doesn't wake her again for it (spec §6.7). It isn't in the context.
      this.unanswered = false;
      return;
    } else if (e.type === 'heard') {
      // What the microphone heard (spec §10.3); its words come with it (dictation) or later (heard.text).
      /** @type {Part} */
      const speech = { type: 'speech', id: d.id, ...(typeof d.text === 'string' ? { text: d.text } : {}), ...(d.clip ? { clip: d.clip } : {}) };
      if (d.answer) {
        this.#heard.set(d.id, speech); // an answer: part of its tool's result
        return;
      }
      const label = d.dismissed ? '[heard, not meant for you]' : d.meanwhile ? '[heard while you were thinking]' : '[heard]';
      this.#add('user', [{ type: 'text', text: label }, speech]);
      if (!d.dismissed) {
        this.unanswered = true;
        this.waiting = 'user';
      }
    } else if (e.type === 'heard.text') {
      // A segment's words, written down later: every place it is sent now sends them (spec §10.3).
      const text = String(d.text ?? '');
      const had = this.#heard.get(d.of);
      if (had?.type === 'speech') this.#heard.set(d.of, { ...had, text });
      this.messages = this.messages.map((m) => ({ role: m.role, parts: m.parts.map((p) => (p.type === 'speech' && p.id === d.of ? { ...p, text } : p)) }));
      return;
    } else if (e.type === 'reminder') {
      // A reminder annai showed (and said) by itself, the model out of reach (spec §11.3): she knows, so she doesn't repeat it.
      if (!texts.text) return;
      this.#add('user', [{ type: 'text', text: `[annai] Shown${d.aloud ? ' and said aloud' : ''} by annai itself, since you couldn't be reached: "${texts.text}"` }]);
    } else if (e.type === 'tool.result' && this.#calls.has(d.id) && !this.#answered.has(d.id)) {
      this.#answered.add(d.id);
      const heard = (Array.isArray(d.heard) ? d.heard : []).map((/** @type {string} */ id) => this.#heard.get(id) ?? /** @type {Part} */ ({ type: 'speech', id }));
      this.#add('user', [{ type: 'tool_result', id: d.id, content: texts.content ?? '', ...(d.ok === false ? { isError: true } : {}) }, ...r.images, ...heard]);
    } else {
      return;
    }
    if (!this.from) this.from = e.seq;
    this.to = e.seq;
  }

  /** The heard segments here whose words aren't written down yet (spec §10.3). @returns {string[]} */
  unwritten() {
    /** @type {string[]} */
    const out = [];
    for (const m of this.messages) for (const p of m.parts) if (p.type === 'speech' && p.text === undefined && !out.includes(p.id)) out.push(p.id);
    return out;
  }

  /** Shiori's tool calls that have no result yet. @returns {{ id: string, name: string }[]} */
  open() {
    return [...this.#calls].filter(([id]) => !this.#answered.has(id)).map(([id, name]) => ({ id, name }));
  }

  /** @param {'user' | 'assistant'} role @param {Part[]} parts */
  #add(role, parts) {
    const last = this.messages.at(-1);
    if (last?.role === role) this.messages[this.messages.length - 1] = { role, parts: [...last.parts, ...parts] };
    else this.messages.push({ role, parts });
  }

  /**
   * The conversation of a scope: the latest compaction's summary, then the events after the part
   * it covers (spec §6.5), up to before (exclusive) when given.
   * @param {Store} store @param {string} scope @param {{ before?: number }} [o]
   */
  static async load(store, scope, o = {}) {
    const [latest] = await store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['compaction'], reverse: true, limit: 1, ...(o.before ? { before: o.before } : {}) }));
    const events = await store.tx(['events'], 'readonly', (t) => t.listEvents(scope, {
      types: [...SAID], ...(latest ? { after: latest.data.to } : {}), ...(o.before ? { before: o.before } : {}),
    }));
    const t = new Transcript();
    if (latest) t.apply(latest, await resolveEvent(store, latest));
    for (const e of events) if (e.type !== 'compaction' && !NOT_SAID.has(e.type)) t.apply(e, await resolveEvent(store, e));
    t.through = Math.max(latest?.seq ?? 0, events.at(-1)?.seq ?? 0);
    return t;
  }
}

/** An event's stored texts, and the photos a tool result shows. @param {Store} store @param {any} e @returns {Promise<Resolved>} */
export async function resolveEvent(store, e) {
  const texts = await storedTexts(store, e);
  /** @type {Part[]} */
  const images = [];
  for (const im of e.type === 'tool.result' || e.type === 'msg.user' ? e.data?.images ?? [] : []) {
    const bytes = await blobBytes(store, im.hash);
    // Bytes that are gone (a refused copy, deleted) stay in the transcript as missing, so a replacement can find them.
    images.push({ type: 'image', mediaType: im.mediaType, data: bytes ? toBase64(bytes) : '', hash: im.hash, ...(im.path ? { path: im.path } : {}), ...(im.region ? { region: im.region } : {}), ...(bytes ? {} : { missing: true }) });
  }
  if (e.type === 'photo.replace') {
    const bytes = await blobBytes(store, e.data?.new);
    images.push({ type: 'image', mediaType: e.data?.mediaType, data: bytes ? toBase64(bytes) : '', hash: e.data?.new, ...(bytes ? {} : { missing: true }) });
  }
  const doc = e.type === 'tool.result' ? e.data?.document : null;
  if (doc) {
    const bytes = await blobBytes(store, doc.hash);
    images.push({ type: 'document', mediaType: doc.mediaType, data: bytes ? toBase64(bytes) : '', ...(doc.name ? { name: doc.name } : {}), ...(bytes ? {} : { missing: true }) });
  }
  return { texts, images };
}

/**
 * After a crash or reload mid-turn, every tool call without a result gets one (spec §6.7), so the
 * transcript stays valid for every provider. @param {Store} store @param {string} scope @param {Transcript} t
 * @returns {Promise<number>} how many were answered
 */
export async function repair(store, scope, t) {
  const open = t.open();
  for (const c of open) {
    const ev = await record(store, scope, { type: 'tool.result', actor: 'system', data: { id: c.id, name: c.name, ok: false, ms: 0, content: RESTARTED } });
    t.apply(ev, { texts: {}, images: [] });
  }
  return open.length;
}
