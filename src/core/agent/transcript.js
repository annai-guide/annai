import { TALK_TAG, KOE_TAG, record, storedTexts, blobBytes } from './log.js';
import { toBase64 } from '../bytes.js';
import { blockFor, saidWithout, wrapNote } from './blocks.js';

/**
 * The conversation as messages (spec §6.3, item 3): the latest compaction summary, then every
 * event after it. It only grows at the end. The same apply() builds it live and from the log, so
 * a reload sends exactly what was sent before (and the provider's cache still matches).
 * @typedef {import('../llm/contract.js').Message} Message
 * @typedef {import('../llm/contract.js').Part} Part
 * @typedef {import('../types.js').Store} Store
 * @typedef {{ texts: Record<string, string>, images: Part[] }} Resolved
 * @typedef {'one' | 'kokoro' | 'koe'} HalfName
 *   one: Shiori as one half, as before; kokoro: the half that thinks, which reads the conversation as labelled blocks;
 *   koe: the half that talks, which reads a window of it with Kokoro's notes (the Koe and Kokoro design)
 */

export const RESTARTED = 'interrupted by app restart';
/** Entries the conversation never shows Shiori, left out as it is read: a drive logs thousands of points (spec §4.5). */
export const NOT_SAID = new Set(['location', 'trigger.fired']);
/**
 * The log entry types the conversation is made of (what apply() reads; compaction aside), so it is
 * read by type: a day of location points is never walked (A6). A type apply() learns goes here too.
 */
export const SAID = Object.freeze(['wake', 'msg.user', 'model.turn', 'photo.replace', 'error', 'heard', 'heard.text', 'reminder', 'tool.result', 'note', 'halves', 'out.speak', 'out.show', 'out.ask']);
/** Koe's window (plan decision 5): its last 12 exchanges, the start moving forward in jumps of 6, so its cached prefix holds between jumps. */
export const KOE_WINDOW = 12;
export const KOE_JUMP = 6;
/** Wake reasons that are lines of their own elsewhere: the user's words, what was heard, a note, a block. */
const OWN_LINES = ['user', 'heard', 'note', 'halves'];

export class Transcript {
  /** @type {Message[]} */
  messages = [];
  /** @type {HalfName} */
  half = 'one';
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
  /** The tool calls of the last assistant message: nothing but their results may follow it until they all have one. @type {string[]} */
  #last = [];
  /** Lines that came while the last calls were open, added once they all have results (plan decision 3). @type {Part[][]} */
  #held = [];

  /** @param {{ half?: HalfName }} [o] */
  constructor({ half = 'one' } = {}) {
    this.half = half;
  }

  /** Whether an event was written by this half, or by the other: Kokoro's own are those not marked Koe's (older ones too). @param {any} d */
  #mine(d) {
    return this.half === 'koe' ? d.half === 'koe' : d.half !== 'koe';
  }

  /** @param {any} e an event @param {Resolved} r its stored texts and images */
  apply(e, r) {
    const d = e.data ?? {};
    const texts = { ...d, ...r.texts };
    const koe = this.half === 'koe';
    if (e.type === 'compaction') {
      this.messages = [];
      this.#calls.clear();
      this.#answered.clear();
      this.#last = [];
      this.#held = [];
      this.compaction = e.seq;
      this.from = e.seq;
      // Koe starts again after it with its window: Kokoro, which keeps the whole conversation, has the summary.
      if (!koe) this.#add('user', [{ type: 'text', text: `[Earlier conversation, summarized (events ${d.from}–${d.to}); recall brings back the exact words]\n${texts.summary ?? ''}` }]);
    } else if (e.type === 'wake') {
      if (!this.#mine(d)) return;
      const others = (d.reasons ?? []).filter((/** @type {any} */ w) => !OWN_LINES.includes(w.kind) && w.text);
      if (others.length) {
        this.#line(others.map((/** @type {any} */ w) => ({ type: 'text', text: `[annai] ${w.text}` })));
        this.unanswered = true;
        this.waiting = 'wake';
      }
    } else if (e.type === 'msg.user' && this.half === 'kokoro' && d.split) {
      // The user typed to Koe (or answered it): Kokoro reads it as a block.
      this.#line([{ type: 'text', text: /** @type {string} */ (blockFor(e, texts)) }, ...r.images]);
      this.unanswered = true;
      this.waiting = 'user';
    } else if (e.type === 'msg.user') {
      // A message that answered an ask or a wait is already in that tool's result (Koe's, or Shiori's as one half).
      if (texts.text && !(d.answer && (this.half === 'one' || this.#calls.has(d.answer)))) {
        this.#line([{ type: 'text', text: d.meanwhile ? `[meanwhile, the user wrote] ${texts.text}` : texts.text }, ...r.images]);
        // Koe owes an answer only to what was typed to it.
        if (!koe || d.split) {
          this.unanswered = true;
          this.waiting = 'user';
        }
      }
    } else if (e.type === 'model.turn' && d.tag === (koe ? KOE_TAG : TALK_TAG) && texts.parts) {
      /** @type {Part[]} */
      const parts = JSON.parse(texts.parts);
      for (const p of parts) if (p.type === 'tool_call') this.#calls.set(p.id, p.name);
      if (parts.length) this.#add('assistant', parts);
      this.#last = parts.flatMap((p) => (p.type === 'tool_call' ? [p.id] : []));
      this.unanswered = false;
    } else if (e.type === 'note') {
      // A note from the other half: Kokoro's block, or Koe's marked text.
      if (d.from === (koe ? 'koe' : 'kokoro') || this.half === 'one') return;
      this.#line([{ type: 'text', text: koe ? wrapNote(texts.text ?? '') : /** @type {string} */ (blockFor(e, texts)) }]);
      this.unanswered = true;
      this.waiting = 'wake';
    } else if (e.type === 'halves') {
      // annai's instruction blocks, for Kokoro: Koe is down, up again (plan decision 4).
      if (this.half !== 'kokoro') return;
      this.#line([{ type: 'text', text: /** @type {string} */ (blockFor(e, texts)) }]);
    } else if (e.type === 'out.speak' || e.type === 'out.show' || e.type === 'out.ask') {
      // What the other half said to the user; a half's own lines are in its tool calls.
      const line = this.half === 'kokoro' ? (d.half === 'koe' ? blockFor(e, texts) : null) : koe ? saidWithout(e, texts) : null;
      if (!line) return;
      this.#line([{ type: 'text', text: line }]);
      // Kokoro answered the user directly (Koe was down): Koe owes nothing for it.
      if (koe) this.unanswered = false;
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
      if (this.#mine(d)) this.unanswered = false;
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
      this.#line([{ type: 'text', text: label }, speech]);
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
      this.#line([{ type: 'text', text: `[annai] Shown${d.aloud ? ' and said aloud' : ''} by annai itself, since you couldn't be reached: "${texts.text}"` }]);
    } else if (e.type === 'tool.result' && this.#mine(d) && this.#calls.has(d.id) && !this.#answered.has(d.id)) {
      this.#answered.add(d.id);
      const heard = (Array.isArray(d.heard) ? d.heard : []).map((/** @type {string} */ id) => this.#heard.get(id) ?? /** @type {Part} */ ({ type: 'speech', id }));
      this.#add('user', [{ type: 'tool_result', id: d.id, content: texts.content ?? '', ...(d.ok === false ? { isError: true } : {}) }, ...r.images, ...heard]);
      // The last calls all answered: what came meanwhile follows their results.
      if (!this.#waitsForResults()) for (const parts of this.#held.splice(0)) this.#add('user', parts);
    } else {
      return;
    }
    if (koe) this.#window();
    if (!this.from) this.from = e.seq;
    this.to = e.seq;
  }

  /** Whether a call of the last assistant message has no result yet. */
  #waitsForResults() {
    return this.#last.some((id) => !this.#answered.has(id));
  }

  /**
   * A line of the conversation that isn't a tool's result: added now, or, while the last calls are
   * open, after their results, since providers refuse anything between a call and its result
   * (plan decision 3). It depends only on the order of events, so the log gives the same messages.
   * @param {Part[]} parts
   */
  #line(parts) {
    if (this.#waitsForResults()) this.#held.push(parts);
    else this.#add('user', parts);
  }

  /**
   * Koe's window (plan decision 5): from the start of its last 12 exchanges, moved forward 6 at a
   * time. An exchange starts with a user message that holds a line, not only tool results; the
   * results in front of the first line kept go with the calls cut away, so none is left without its call.
   */
  #window() {
    const starts = this.messages.flatMap((m, i) => (m.role === 'user' && m.parts.some((p) => p.type === 'text') ? [i] : []));
    if (starts.length < KOE_WINDOW + KOE_JUMP) return;
    const kept = this.messages.slice(starts[KOE_JUMP]);
    const parts = kept[0].parts;
    kept[0] = { role: 'user', parts: parts.slice(parts.findIndex((p) => p.type === 'text')) };
    this.messages = kept;
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
   * it covers (spec §6.5), up to before (exclusive) when given; read by one half's rules.
   * @param {Store} store @param {string} scope @param {{ before?: number, half?: HalfName }} [o]
   */
  static async load(store, scope, o = {}) {
    const [latest] = await store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['compaction'], reverse: true, limit: 1, ...(o.before ? { before: o.before } : {}) }));
    const events = await store.tx(['events'], 'readonly', (t) => t.listEvents(scope, {
      types: [...SAID], ...(latest ? { after: latest.data.to } : {}), ...(o.before ? { before: o.before } : {}),
    }));
    const t = new Transcript({ half: o.half ?? 'one' });
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
 * @param {Record<string, string>} [mark] the half whose calls they are ({ half: 'koe' }), as its results are marked
 * @returns {Promise<number>} how many were answered
 */
export async function repair(store, scope, t, mark = {}) {
  const open = t.open();
  for (const c of open) {
    const ev = await record(store, scope, { type: 'tool.result', actor: 'system', data: { id: c.id, name: c.name, ok: false, ms: 0, ...mark, content: RESTARTED } });
    t.apply(ev, { texts: {}, images: [] });
  }
  return open.length;
}
