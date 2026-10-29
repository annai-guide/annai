/**
 * Who reads a photo or PDF a model can't take (the bookings design, goal 11; spec §7.2): a model of the other half's that can,
 * then Utility's, then the model's own role's; for a PDF then its pages as pictures, drawn by the PDF pages plugin (goal 12);
 * and only when nothing can, a note naming the setting that fixes it. Everything here is words a model reads: English.
 */
import { chatCandidates, firstWordsMs, whyOf, whyWords } from '../llm/fallback.js';
import { KOE_CLASSIC, modelOf } from '../llm/config.js';
import { fromBase64, toBase64 } from '../bytes.js';
import { MAX_PAGES, PAGE_EDGE } from '../pdf-pages.js';
import { STOPPED } from './transcript.js';

/**
 * How long a photo's description may take, in seconds (review A5): the same as a role waits for a model's first words (§9.6),
 * as a turn shouldn't wait on a side job longer than on its own model; a description is a few sentences.
 */
export const DESCRIBE_S = 30;
/**
 * And a PDF's reading (the fix pass), its pages drawn included: its words, up to 3,000 tokens, take a slow model (a local one, at
 * some 35 tokens a second) near 90 seconds, where a photo's few sentences fit in 30. Only Kokoro and one Shiori wait for it; Koe never does.
 */
export const DESCRIBE_PDF_S = 90;
/** What a PDF told only up to the output limit ends with. */
const GOES_ON = /* en */ ' …(it stops here: the PDF goes on)';
/** What a model that sees photos is asked, for one that can't (emulator pass, 5b). */
const DESCRIBE = /* en */ 'Describe this photo for someone who can\'t see it, in a few plain sentences: what is in it, any writing in it word for word, and anything a traveller would want to know. Reply with the description only.';
/** And for one that can't read PDFs (the second emulator pass): the PDF's own words, as annai has no PDF library (spec §7.2). */
const DESCRIBE_PDF = /* en */ "Give the content of this PDF for someone who can't open it: its text word for word as far as it goes (dates, times, names, addresses, prices and numbers exactly), tables as plain lines, and what any picture in it shows. Reply with the content only.";
/** And a PDF's pages as pictures, for a model that sees photos, read for one that sees none. */
const DESCRIBE_PAGES = /* en */ "These are pictures of a PDF's pages, in order. Give its content for someone who can't open it: its text word for word as far as it goes (dates, times, names, addresses, prices and numbers exactly), tables as plain lines, and what any picture in it shows. Reply with the content only.";

/** @typedef {{ kind: 'image' | 'pdf', mediaType: string, data: string, name?: string, path?: string }} FileToRead  data: base64 */
/**
 * @typedef {{ how: 'told' | 'pages' | 'none' | 'failed' | 'late' | 'stopped', text: string, images: { mediaType: string, data: string, page?: number }[] }} Reading
 *   text: the line the model reads; images: page pictures, only when how is 'pages' (for a model that sees photos)
 */

/**
 * The roles that read for a half, in order: those with a chat model on, a role whose list is an earlier one's left out (an empty
 * Utility is Main's). Kokoro, and one Shiori: Koe's, Utility's, Main's; Koe: Utility's, Main's, her own (she answers at once, so the
 * side job's cheaper role goes first; the coordinator's call, 2026-10-28).
 * @param {import('../llm/config.js').ModelConfig} cfg @param {'one' | 'kokoro' | 'koe'} half @returns {string[]}
 */
export function readerRoles(cfg, half) {
  const order = half === 'koe' ? ['utility', 'main', KOE_CLASSIC] : [KOE_CLASSIC, 'utility', 'main'];
  /** @type {Set<string>} */
  const seen = new Set();
  return order.filter((role) => {
    const list = chatCandidates(cfg, role);
    const key = list.join('\n');
    if (!cfg.roles?.[role]?.models?.length || !list.length || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The note when nothing here can read it, naming the setting (the bookings design: "Only when nothing can read it does she say
 * which setting fixes it"). @param {'image' | 'pdf'} kind @param {{ plugin?: boolean, photos?: boolean }} [o]
 *   plugin: name the PDF pages plugin as the other fix (it isn't running, and a model here sees photos); photos: name a model that sees
 *   photos as the other fix (the plugin runs, and nothing here sees photos)
 */
export function noReader(kind, { plugin = false, photos = false } = {}) {
  /* en */
  if (kind === 'image') return "No model here can see photos, so what it shows can't be told. Tell the user what fixes it: a model that sees photos (Takes photos on its page in Settings → Models).";
  /* en */
  const base = "No model here can read PDFs, so what it says can't be told. Tell the user what fixes it: a model that reads PDFs (Takes PDFs on its page in Settings → Models)";
  // Settings → Plugins, not its Add: the plugin may be installed but switched off, or crashed (the review of reading-files).
  /* en */
  if (plugin) return `${base}, or the PDF pages plugin (Settings → Plugins), which shows a PDF's pages to a model that sees photos.`;
  /* en */
  if (photos) return `${base}, or a model that sees photos (Takes photos on its page in Settings → Models), which the PDF pages plugin shows a PDF's pages to.`;
  return `${base}.`;
}

/**
 * Reads a file for a model that can't take it. Every reader call is a side job: reasoning off, in the trace as a describe, waiting for
 * its first words the longer of its role's wait and DESCRIBE_S (for a PDF, at most two thirds of its reading). The whole reading, pages included, stops at
 * DESCRIBE_S or DESCRIBE_PDF_S, or at signal (the turn's stop). "Can read" means can and did: a reader that fails passes it on.
 * @param {FileToRead} file @param {{ input?: string[] }} model the model the reading is for
 * @param {{ llm: { call: Function, config: () => Promise<any> }, half: 'one' | 'kokoro' | 'koe', pages: import('../pdf-pages.js').PdfPages | null,
 *   signal: AbortSignal, wakeId: string, scope: string, secondMs: number, explain?: (e: unknown, role: string) => string }} o
 *   explain: why a reader failed, in English for the model (the loop's, which knows whether the device is online)
 * @returns {Promise<Reading>}
 */
export async function readFile(file, model, o) {
  const cfg = await o.llm.config();
  const pdf = file.kind === 'pdf';
  const roles = readerRoles(cfg, o.half);
  const takes = (/** @type {string} */ role, /** @type {string} */ kind) => chatCandidates(cfg, role).some((id) => cfg.models[id] && modelOf(cfg.models[id]).input.includes(kind));
  const explain = o.explain ?? ((e, role) => whyWords(whyOf(e, { role }), true));
  const limit = pdf ? DESCRIBE_PDF_S : DESCRIBE_S;
  // The turn's stop, and the time limit, end it (without AbortSignal.any, which older browsers lack).
  const stop = new AbortController();
  const end = () => stop.abort();
  const late = setTimeout(end, limit * o.secondMs);
  o.signal.addEventListener('abort', end, { once: true });
  if (o.signal.aborted) end();
  const stopped = new Promise((_, no) => stop.signal.addEventListener('abort', () => no(new Error('stopped')), { once: true }));
  stopped.catch(() => {});
  /** @type {(how: Reading['how'], text: string, images?: Reading['images']) => Reading} */
  const reading = (how, text, images = []) => ({ how, text, images });
  /**
   * How long a reader waits for its first words: the longer of its role's own wait and DESCRIBE_S, so a role's short wait (Koe's 8 s)
   * doesn't cut a reading; for a PDF, never more than two thirds of its reading, so a reader that never starts answering always leaves
   * the pages their turn (the re-review of reading-files). @param {string} role
   */
  const wait = (role) => {
    const ms = Math.max(firstWordsMs(cfg, role), DESCRIBE_S * o.secondMs);
    return pdf ? Math.min(ms, Math.floor((limit * o.secondMs * 2) / 3)) : ms;
  };
  /** What failed last, in words. */
  let failed = '';
  /**
   * The first reader role's model that takes kind and answers, else null. @param {string} kind @param {any[]} parts
   * @param {string} system @param {string} ask @param {number} maxOutput
   */
  const ask = async (kind, parts, system, ask, maxOutput) => {
    for (const role of roles.filter((r) => takes(r, kind))) {
      if (stop.signal.aborted) break;
      try {
        const r = await o.llm.call({
          role, level: 'off', signal: stop.signal, scope: o.scope, record: { tag: 'describe', wake: o.wakeId }, firstOutputMs: wait(role),
          request: { system, maxOutput, messages: [{ role: 'user', parts: [...parts, { type: 'text', text: ask }] }] },
        });
        if (r.reply.text.trim()) return r;
      } catch (e) {
        /* en */
        failed ||= `It couldn't be described: ${explain(e, role)}`;
      }
    }
    return null;
  };
  try {
    if (!pdf) {
      const r = await ask('image', [{ type: 'image', mediaType: file.mediaType, data: file.data }], DESCRIBE, /* en */ 'Describe this photo.', 600);
      /* en */
      if (r) return reading('told', `What it shows (described by ${r.answeredBy}, as you can't see photos): ${r.reply.text.trim()}`);
      if (!stop.signal.aborted && !roles.some((role) => takes(role, 'image'))) return reading('none', noReader('image'));
    } else {
      const doc = { type: 'document', mediaType: file.mediaType, data: file.data, ...(file.name ? { name: file.name } : {}) };
      const r = await ask('pdf', [doc], DESCRIBE_PDF, /* en */ 'Give this PDF\'s content.', 3000);
      /* en */
      if (r) return reading('told', `What it says (told by ${r.answeredBy}, as you can't read PDFs): ${r.reply.text.trim()}${r.reply.stop === 'length' ? GOES_ON : ''}`);
      const sees = Boolean(model.input?.includes('image'));
      const seer = roles.some((role) => takes(role, 'image'));
      const reader = roles.some((role) => takes(role, 'pdf'));
      // Pages are drawn only for someone to see them: the model, or a reader role's model that sees photos.
      if (o.pages && (sees || seer) && !stop.signal.aborted) {
        /** @type {import('../pdf-pages.js').Drawn} */
        let drawn;
        try {
          // Up to MAX_PAGES, whatever this model's photo limit: the reading is kept for every model, and each request sends only its
          // model's limit, from page 1 (round 6).
          drawn = await Promise.race([o.pages.pages(fromBase64(file.data), { max: MAX_PAGES, edge: PAGE_EDGE, signal: stop.signal }), stopped]);
        } catch (e) {
          if (stop.signal.aborted) throw e;
          /* en */
          // What the readers said when they failed (out of credit, say) comes first; "no model here reads PDFs" only when none does.
          /* en */
          const why = `The PDF pages plugin couldn't draw its pages: ${/** @type {any} */ (e)?.message ?? e}`;
          return reading('failed', [failed, why, reader ? '' : noReader('pdf')].filter(Boolean).join('\n'));
        }
        // A page with nothing drawn on it isn't sent (the review of reading-files: a booking's empty last page went as a picture every turn).
        const blank = Array.isArray(drawn.blank) ? drawn.blank : [];
        // Each picture knows its page, so a photo limit drops the last pages first and says which (the re-check of reading-files).
        const numbers = Array.from({ length: drawn.pages.length + blank.length }, (_, i) => i + 1).filter((n) => !blank.includes(n));
        const images = drawn.pages.map((p, i) => ({ mediaType: p.type, data: toBase64(p.bytes), page: numbers[i] }));
        const last = images.length + blank.length;
        /* en */
        const rest = drawn.count > last ? "; the rest weren't sent" : '';
        /* en */
        const span = last === 1 ? `page 1 of ${drawn.count}` : `pages 1–${last} of ${drawn.count}`;
        /* en */
        if (!images.length && blank.length) return reading('told', `Its pages as pictures, as you can't read PDFs: ${span}, which ${last === 1 ? 'is blank' : 'are all blank'}, so nothing was sent${rest}.`);
        /* en */
        const blanks = !blank.length ? '' : blank.length === 1 ? `; page ${blank[0]} is blank and wasn't sent` : `; pages ${blank.slice(0, -1).join(', ')} and ${blank.at(-1)} are blank and weren't sent`;
        const which = `${span}${blanks}${rest}.`;
        /* en */
        if (images.length && sees) return reading('pages', `Its pages as pictures, as you can't read PDFs: ${which}`, images);
        if (images.length) {
          const told = await ask('image', images.map((i) => ({ type: 'image', ...i })), DESCRIBE_PAGES, /* en */ 'Give the content of these pages.', 3000);
          /* en */
          if (told) return reading('told', `What it says (told by ${told.answeredBy} from pictures of its pages, as you can't read PDFs): ${told.reply.text.trim()}${told.reply.stop === 'length' ? GOES_ON : ''}`);
        }
      } else if (!stop.signal.aborted && !reader) return reading('none', noReader('pdf', o.pages ? { photos: true } : { plugin: sees || seer }));
    }
  } catch {
    // stopped: said below
  } finally {
    clearTimeout(late);
    o.signal.removeEventListener('abort', end);
  }
  /* en */
  if (o.signal.aborted) return reading('stopped', `It wasn't described: ${STOPPED}`);
  /* en */
  if (stop.signal.aborted) return reading('late', `It couldn't be described in time (${limit} seconds).`);
  /* en */
  return reading('failed', failed || "It couldn't be described.");
}
