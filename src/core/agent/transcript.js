import { TALK_TAG, KOE_TAG, record, storedTexts } from './log.js';
import { blobBytes } from '../reach.js';
import { toBase64 } from '../bytes.js';
import { blockFor, saidWithout, wrapNote, escapeTags, quote, theirs } from './blocks.js';
import { strayNote } from '../languages.js';

/**
 * The conversation as messages (spec §6.3, item 3): the latest compaction summary, then every
 * event after it. It only grows at the end. The same apply() builds it live and from the log, so
 * a reload sends exactly what was sent before (and the provider's cache still matches).
 * @typedef {import('../llm/contract.js').Message} Message
 * @typedef {import('../llm/contract.js').Part} Part
 * @typedef {import('../types.js').Store} Store
 * @typedef {{ texts: Record<string, string>, images: Part[] }} Resolved
 * @typedef {'one' | 'kokoro' | 'koe'} HalfName  whose rules (the Koe and Kokoro design): Kokoro reads labelled blocks, Koe a window with Kokoro's notes
 */

/* en */ export const RESTARTED = 'interrupted by app restart';
/** A tool's result when the user stopped her turn (spec §6.7). */
/* en */ export const STOPPED = 'Stopped by the user.';
/** Entries the conversation never shows Shiori, left out as it is read: a drive logs thousands of points (spec §4.5). */
export const NOT_SAID = new Set(['location', 'trigger.fired']);
/**
 * The log entry types the conversation is made of (what apply() reads; compaction aside), so it is
 * read by type: a day of location points is never walked (A6). A type apply() learns goes here too.
 */
export const SAID = Object.freeze(['wake', 'msg.user', 'model.turn', 'photo.replace', 'error', 'heard', 'heard.text', 'reminder', 'tool.result', 'note', 'halves', 'out.speak', 'out.show', 'out.ask']);
/** Koe's window (plan decision 5): its last 12 exchanges, its start moving in jumps of 6. */
export const KOE_WINDOW = 12;
export const KOE_JUMP = 6;
/** Wake reasons that are lines of their own elsewhere. */
const OWN_LINES = ['user', 'heard', 'note', 'halves'];

export class Transcript {
  /** @type {Message[]} */
  messages = [];
  /** @type {HalfName} */
  half = 'one';
  /** Koe's session nonce. */
  nonce = '';
  /** First and last event in context, for model.turn records (spec §4.5). */
  from = 0;
  to = 0;
  /** The compaction event this transcript starts from, 0 for none. */
  compaction = 0;
  /** The last entry load() read: anything written later wasn't in the log it read. */
  through = 0;
  /** Whether the last thing in it is the user's (or the app's) with no reply from Shiori yet, or results she hasn't seen: after a reload mid-turn. */
  unanswered = false;
  /**
   * What is waiting when unanswered: 'user' (a message), 'wake' (something else, such as files added while it was closed), or 'turn' (her
   * tool calls' results, her turn cut off before her next reply: emulator pass m2b #21). @type {'' | 'user' | 'wake' | 'turn'}
   */
  waiting = '';
  /** The user's newest message holds a photo: a model that takes none can't answer it (emulator pass). */
  newestPhoto = false;
  /** @type {Map<string, string>} Shiori's tool calls by id, to their tool names */
  #calls = new Map();
  /** @type {Set<string>} */
  #answered = new Set();
  /** Heard answers (spec §10.3), by segment id: their tool's result carries them. @type {Map<string, Part>} */
  #heard = new Map();
  /** Those not meant for Shiori: two halves read them labelled in the result too. @type {Set<string>} */
  #aside = new Set();
  /** @type {string[]} the last reply's calls: only their results follow until all have one */
  #last = [];
  /** The last reply ended the turn: it called sleep, or a result says the turn is over (stopped, or back to sleep). */
  #ends = false;
  /** @type {{ seq: number, parts: Part[] }[]} lines held until those results (plan decision 3) */
  #held = [];
  /** @type {{ seq: number, parts: Part[] }[]} lines since the last reply */
  #since = [];
  #at = 0;
  /** @type {WeakSet<Part>} Koe's notes as annai wrapped them: the only words that may be tags */
  #wrapped = new WeakSet();

  /** @param {{ half?: HalfName, nonce?: string }} [o] */
  constructor({ half = 'one', nonce = '' } = {}) {
    this.half = half;
    this.nonce = nonce;
  }

  /** Whether this half wrote it (Kokoro: whatever isn't Koe's). @param {any} d */
  #mine(d) {
    return this.half === 'koe' ? d.half === 'koe' : d.half !== 'koe';
  }

  /** @param {any} e an event @param {Resolved} r its stored texts and images */
  apply(e, r) {
    const d = e.data ?? {};
    const texts = { ...d, ...r.texts };
    const koe = this.half === 'koe';
    this.#at = e.seq;
    if (e.type === 'msg.user') this.newestPhoto = r.images.length > 0;
    if (e.type === 'compaction') {
      this.messages = [];
      this.#calls.clear();
      this.#answered.clear();
      this.#last = [];
      this.#held = [];
      this.#since = [];
      this.compaction = e.seq;
      this.from = e.seq;
      // Koe starts again with its window; Kokoro has the summary.
      if (!koe && d.mode === 'fresh') /* en */ this.#add('user', [{ type: 'text', text: `[Started fresh: at the user's request, the conversation before this point (events ${d.from}–${d.to}) is not in your context. It is all still in the log, and recall brings back the exact words]` }]);
      else if (!koe) /* en */ this.#add('user', [{ type: 'text', text: `[Earlier conversation, summarized (events ${d.from}–${d.to}); recall brings back the exact words]\n${texts.summary ?? ''}` }]);
    } else if (e.type === 'wake') {
      if (!this.#mine(d)) return;
      const others = (d.reasons ?? []).filter((/** @type {any} */ w) => !OWN_LINES.includes(w.kind) && w.text);
      if (others.length) {
        // Two halves read it quoted, so it can't pass for a label; one half as before.
        this.#line(others.map((/** @type {any} */ w) => ({ type: 'text', text: /* en */ `[annai] ${this.half === 'one' ? w.text : quote(w.text)}` })));
        this.unanswered = true;
        this.waiting = 'wake';
      }
    } else if (e.type === 'msg.user' && this.half === 'kokoro' && d.split) {
      this.#line([{ type: 'text', text: /** @type {string} */ (blockFor(e, texts)) }, ...r.images]);
      this.unanswered = true;
      this.waiting = 'user';
    } else if (e.type === 'msg.user') {
      // A message that answered an ask or a wait is already in that tool's result.
      if (texts.text && !(d.answer && (this.half === 'one' || this.#calls.has(d.answer)))) {
        const typed = koe ? theirs(texts.text) : texts.text;
        /* en */ this.#line([{ type: 'text', text: d.meanwhile ? `[meanwhile, the user wrote] ${typed}` : typed }, ...r.images]);
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
      // What the other half wrote while this reply was being made follows it, live and from the log alike.
      const to = this.half !== 'one' && typeof d.context?.to === 'number' ? d.context.to : Infinity;
      const late = this.#since.filter((x) => x.seq > to);
      if (late.length) this.#unadd(late.flatMap((x) => x.parts));
      this.#since = [];
      if (parts.length) this.#add('assistant', parts);
      this.#last = parts.flatMap((p) => (p.type === 'tool_call' ? [p.id] : []));
      this.#ends = parts.some((p) => p.type === 'tool_call' && p.name === 'sleep');
      this.#held.push(...late);
      this.#flushHeld();
      this.unanswered = false;
    } else if (e.type === 'note') {
      if (d.from === (koe ? 'koe' : 'kokoro') || this.half === 'one') return;
      /** @type {Part} */
      const part = { type: 'text', text: koe ? wrapNote(texts.text ?? '', this.nonce) : /** @type {string} */ (blockFor(e, texts)) };
      if (koe) this.#wrapped.add(part);
      this.#line([part]);
      this.unanswered = true;
      this.waiting = 'wake';
    } else if (e.type === 'halves') {
      if (this.half !== 'kokoro') return;
      this.#line([{ type: 'text', text: /** @type {string} */ (blockFor(e, texts)) }]);
    } else if (e.type === 'out.speak' || e.type === 'out.show' || e.type === 'out.ask') {
      const line = this.half === 'kokoro' ? (d.half === 'koe' ? blockFor(e, texts) : null) : koe ? saidWithout(e, texts) : null;
      if (!line) return;
      this.#line([{ type: 'text', text: line }]);
      if (koe) this.unanswered = false;
    } else if (e.type === 'photo.replace') {
      // A refused photo's new copy (spec §4.8): every place it was sent now sends the copy. When that
      // copy was itself replaced later (its bytes gone), the swap still happens, so the next one finds it.
      // A copy an import didn't carry is kept as data.was (spec §12.3).
      const copy = r.images[0];
      const [old, next] = [d.old ?? d.was?.old, d.new ?? d.was?.new];
      this.messages = this.messages.map((m) => ({
        role: m.role,
        parts: m.parts.map((p) => {
          if (p.type !== 'image' || p.hash !== old) return p;
          const { missing, ...rest } = p;
          const data = copy?.type === 'image' ? copy.data : '';
          return { ...rest, hash: next, mediaType: d.mediaType, data, ...(data ? {} : { missing: true }) };
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
      const speech = { type: 'speech', id: d.id, ...(typeof d.text === 'string' ? { text: d.strayLanguage ? `${d.text}${strayNote(d.strayLanguage)}` : d.text } : {}), ...(d.clip ? { clip: d.clip } : {}) };
      // Heard by this half: an answer is part of its call's result. Heard by the other: a line (Kokoro hears all).
      const own = this.half === 'one' || this.#mine(d);
      if (d.answer && own) {
        this.#heard.set(d.id, speech);
        if (d.dismissed && this.half !== 'one') this.#aside.add(d.id);
        return;
      }
      /* en */ const label = d.dismissed ? '[heard, not meant for you]' : d.meanwhile && own ? '[heard while you were thinking]' : '[heard]';
      this.#line([{ type: 'text', text: label }, speech]);
      // Koe answers what it heard: Kokoro owes nothing for it.
      if (!d.dismissed && (own || this.half === 'koe')) {
        this.unanswered = true;
        this.waiting = 'user';
      }
    } else if (e.type === 'heard.text') {
      // A segment's words, written down later: every place it is sent now sends them (spec §10.3).
      const words = koe ? theirs(String(d.text ?? '')) : String(d.text ?? '');
      const text = d.strayLanguage ? `${words}${strayNote(d.strayLanguage)}` : words;
      const had = this.#heard.get(d.of);
      if (had?.type === 'speech') this.#heard.set(d.of, { ...had, text });
      /** @type {Map<Part, Part>} */
      const swapped = new Map();
      /** @param {Part} p */
      const worded = (p) => {
        if (p.type !== 'speech' || p.id !== d.of) return p;
        if (!swapped.has(p)) swapped.set(p, { ...p, text });
        return /** @type {Part} */ (swapped.get(p));
      };
      this.messages = this.messages.map((m) => ({ role: m.role, parts: m.parts.map(worded) }));
      // Lines held, or taken since the last reply, are the same parts: a reply made without them can still move them (item 16).
      this.#since = this.#since.map((x) => ({ seq: x.seq, parts: x.parts.map(worded) }));
      this.#held = this.#held.map((x) => ({ seq: x.seq, parts: x.parts.map(worded) }));
      return;
    } else if (e.type === 'reminder') {
      // A reminder annai showed (and said) by itself, the model out of reach or her turn silent (spec §11.3): she knows, so she doesn't repeat it.
      if (!texts.text) return;
      const said = this.half === 'one' ? `"${texts.text}"` : quote(texts.text);
      /* en */ this.#line([{ type: 'text', text: `[annai] Shown${d.aloud ? ' and said aloud' : ''} by annai itself, since ${d.unsaid ? 'your turn ended without telling the user' : "you couldn't be reached"}: ${said}` }]);
    } else if (e.type === 'tool.result' && this.#mine(d) && this.#calls.has(d.id) && !this.#answered.has(d.id)) {
      this.#answered.add(d.id);
      const heard = (Array.isArray(d.heard) ? d.heard : []).flatMap((/** @type {string} */ id) => {
        const p = this.#heard.get(id) ?? /** @type {Part} */ ({ type: 'speech', id });
        /* en */ return this.#aside.has(id) ? [{ type: /** @type {const} */ ('text'), text: '[heard, not meant for you]' }, p] : [p];
      });
      this.#add('user', [{ type: 'tool_result', id: d.id, content: texts.content ?? '', ...(d.ok === false ? { isError: true } : {}) }, ...r.images, ...heard]);
      this.#flushHeld();
      // Every result of a reply that didn't end her turn, and no reply after: her turn was cut off, and she owes the rest.
      if (d.end || texts.content === STOPPED) this.#ends = true;
      if (this.#last.includes(d.id) && !this.#waitsForResults() && !this.#ends) {
        this.unanswered = true;
        this.waiting = 'turn';
      }
    } else {
      return;
    }
    if (koe) this.#window();
    if (!this.from) this.from = e.seq;
    this.to = e.seq;
  }

  #waitsForResults() {
    return this.#last.some((id) => !this.#answered.has(id));
  }

  /** A line that isn't a result: held while calls are open, as providers refuse anything between (plan decision 3). @param {Part[]} parts */
  #line(parts) {
    if (this.#waitsForResults()) this.#held.push({ seq: this.#at, parts });
    else this.#since.push({ seq: this.#at, parts: this.#add('user', parts) });
  }

  #flushHeld() {
    if (this.#waitsForResults()) return;
    for (const x of this.#held.splice(0)) this.#since.push({ seq: x.seq, parts: this.#add('user', x.parts) });
  }

  /** @param {Part[]} parts lines taken back out of the last message */
  #unadd(parts) {
    const last = this.messages.at(-1);
    if (last?.role !== 'user') return;
    const gone = new Set(parts);
    const left = last.parts.filter((p) => !gone.has(p));
    if (left.length) this.messages[this.messages.length - 1] = { role: 'user', parts: left };
    else this.messages.pop();
  }

  /** An exchange starts with a user message that holds a line; results before the first line kept go with their calls. */
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

  /** Koe's user lines have their angle brackets escaped, whatever their source (security reviews). @param {Part} p @returns {Part} */
  #unmarked(p) {
    if (this.#wrapped.has(p)) return p;
    if (p.type === 'text') return { ...p, text: escapeTags(p.text) };
    // And a result's or heard words' line can't start like one of annai's labels.
    if (p.type === 'tool_result') return { ...p, content: theirs(p.content) };
    if (p.type === 'speech' && typeof p.text === 'string') return { ...p, text: theirs(p.text) };
    return p;
  }

  /** @param {'user' | 'assistant'} role @param {Part[]} given @returns {Part[]} the parts as added */
  #add(role, given) {
    const parts = this.half === 'koe' && role === 'user' ? given.map((p) => this.#unmarked(p)) : given;
    const last = this.messages.at(-1);
    if (last?.role === role) this.messages[this.messages.length - 1] = { role, parts: [...last.parts, ...parts] };
    else this.messages.push({ role, parts });
    return parts;
  }

  /**
   * The conversation of a scope: the latest compaction's summary, then the events after the part
   * it covers (spec §6.5), up to before (exclusive) when given; by one half's rules.
   * @param {Store} store @param {string} scope @param {{ before?: number, half?: HalfName, nonce?: string }} [o]
   */
  static async load(store, scope, o = {}) {
    const [latest] = await store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['compaction'], reverse: true, limit: 1, ...(o.before ? { before: o.before } : {}) }));
    const events = await store.tx(['events'], 'readonly', (t) => t.listEvents(scope, {
      types: [...SAID], ...(latest ? { after: latest.data.to } : {}), ...(o.before ? { before: o.before } : {}),
    }));
    const t = new Transcript({ half: o.half ?? 'one', nonce: o.nonce ?? '' });
    if (latest) t.apply(latest, await resolveEvent(store, latest));
    for (const e of events) if (e.type !== 'compaction' && !NOT_SAID.has(e.type)) t.apply(e, await resolveEvent(store, e));
    t.through = Math.max(latest?.seq ?? 0, events.at(-1)?.seq ?? 0);
    return t;
  }
}

/**
 * An event's stored texts, and the photos a tool result shows: read for the entry's own scope, so a hash in its data
 * that the scope doesn't reach (another trip's) is missing (reach.js). @param {Store} store @param {any} e a log entry as stored @returns {Promise<Resolved>}
 */
export async function resolveEvent(store, e) {
  const texts = await storedTexts(store, e);
  const read = (/** @type {unknown} */ hash) => blobBytes(store, e.scope, hash, { named: e, via: e.type });
  /** @type {Part[]} */
  const images = [];
  for (const im of e.type === 'tool.result' || e.type === 'msg.user' ? e.data?.images ?? [] : []) {
    const bytes = await read(im.hash);
    // Bytes that are gone (a refused copy, deleted) stay in the transcript as missing, so a replacement can find them.
    images.push({ type: 'image', mediaType: im.mediaType, data: bytes ? toBase64(bytes) : '', hash: im.hash, ...(im.path ? { path: im.path } : {}), ...(im.region ? { region: im.region } : {}), ...(bytes ? {} : { missing: true }) });
  }
  if (e.type === 'photo.replace') {
    const bytes = await read(e.data?.new);
    images.push({ type: 'image', mediaType: e.data?.mediaType, data: bytes ? toBase64(bytes) : '', hash: e.data?.new, ...(bytes ? {} : { missing: true }) });
  }
  const doc = e.type === 'tool.result' ? e.data?.document : null;
  if (doc) {
    const bytes = await read(doc.hash);
    images.push({ type: 'document', mediaType: doc.mediaType, data: bytes ? toBase64(bytes) : '', hash: doc.hash, ...(doc.name ? { name: doc.name } : {}), ...(bytes ? {} : { missing: true }) });
  }
  return { texts, images };
}

/**
 * After a crash or reload mid-turn, every tool call without a result gets one (spec §6.7), so the
 * transcript stays valid for every provider. @param {Store} store @param {string} scope @param {Transcript} t
 * @param {Record<string, string>} [mark] its results' half mark
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
