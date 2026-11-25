/**
 * Who reads a photo or PDF a model can't take (the bookings design, goal 11; spec §7.2): a model of the other half's that can,
 * then Utility's, then the model's own role's; for a PDF then its pages as pictures, drawn by the PDF pages plugin (goal 12), each sent
 * as a photo's request copy is, under its byte cap;
 * and only when nothing can, a note naming the setting that fixes it. Everything here is words a model reads: English.
 */
import { chatCandidates, firstWordsMs, AllFailedError, COOLDOWN_MS } from '../llm/fallback.js';
import { KOE_CLASSIC, modelOf } from '../llm/config.js';
import { fromBase64, toBase64 } from '../bytes.js';
import { MAX_PAGES, PAGE_EDGE } from '../pdf-pages.js';
import { withoutSecrets } from './net.js';

/**
 * The least a reader waits for its first words, in seconds: what a role waits for a model's first words by default (§9.6), so a role's
 * shorter wait (Koe's 8 s) doesn't cut a reading. A reader is a model call, timed as any is (call.js, §4.8).
 */
export const DESCRIBE_S = 30;
/**
 * The PDF pages' drawing's time limit, in seconds: no call times it, and a plugin that never answers would hold the turn until a tap. A
 * limit that only catches a hang, kept from when it was the whole reading's: the official plugin drew ten pages at 1600 px in under a
 * second in the e2e browsers on a desktop CPU (2026-11-23: 0.45 s for a text PDF, 0.61 s for a 3.2 MB scan, in Chromium; 0.93 and 0.69 s
 * in WebKit; PDF.js's load included): 90 s gives a slower phone about a hundred times as long. Only Kokoro and one Shiori wait for it; Koe never does.
 */
export const DESCRIBE_PDF_S = 90;
/** What a PDF told only up to the output limit ends with. */
const GOES_ON = /* en */ ' …(it stops here: the PDF goes on)';
/** What a model that sees photos is asked, for one that can't. */
const DESCRIBE = /* en */ 'Describe this photo for someone who can\'t see it, in a few plain sentences: what is in it, any writing in it word for word, and anything a traveller would want to know. Reply with the description only.';
/** And for one that can't read PDFs: the PDF's own words, as annai has no PDF library (spec §7.2). */
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
 * side job's cheaper role goes first).
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
 * The note when nothing here can read it, naming the setting that fixes it. @param {'image' | 'pdf'} kind @param {{ plugin?: boolean, photos?: boolean }} [o]
 *   plugin: name the PDF pages plugin as the other fix (it isn't running, and a model here sees photos); photos: name a model that sees
 *   photos as the other fix (the plugin runs, and nothing here sees photos)
 */
export function noReader(kind, { plugin = false, photos = false } = {}) {
  /* en */
  if (kind === 'image') return "No model here can see photos, so what it shows can't be told. Tell the user what fixes it: a model that sees photos (Takes photos on its page in Settings → Models).";
  /* en */
  const base = "No model here can read PDFs, so what it says can't be told. Tell the user what fixes it: a model that reads PDFs (Takes PDFs on its page in Settings → Models)";
  // Settings → Plugins, not its Add: the plugin may be installed but switched off, or crashed.
  /* en */
  if (plugin) return `${base}, or the PDF pages plugin (Settings → Plugins), which shows a PDF's pages to a model that sees photos.`;
  /* en */
  if (photos) return `${base}, or a model that sees photos (Takes photos on its page in Settings → Models), which the PDF pages plugin shows a PDF's pages to.`;
  return `${base}.`;
}

/**
 * Reads a file for a model that can't take it. Every reader call is a side job: reasoning off, in the trace as a describe, waiting for
 * its first words the longer of its role's wait and DESCRIBE_S, and timed as any model call is (call.js: until the answer's headers, also
 * its request's time to go up, twice that when shared). The reading has no clock over its readers: one that sends headers and then no
 * first words fails and rests 3 minutes, as any model does (§9.6); one whose send got no headers in its time fails, and rests as long only
 * once a later reader read the file in its place (something else reads meanwhile), else the next reading asks it again (§4.8); either way
 * the next reader is asked. Only a PDF's pages' drawing, which no call times, stops at DESCRIBE_PDF_S; all of it stops at signal (the
 * turn's stop). "Can read" means can and did: a reader that fails passes it on. A photo goes to a reader as it came, its request copy,
 * and a PDF's pages as copy makes them: the loop makes both for the readers' own photo limits too, as their records state them, when a
 * model of the half sees no photos (loop.js #limits); a copy made before, for another list or setting, is as it was made. A reader that
 * refuses a photo is not asked again with a copy of its own: the next reader is asked, and `learn` saves the limit its refusal states on
 * its record, so the copies made from then on fit it while a model of the half sees none (a task helper's photos are made for the half's
 * limits alone).
 * @param {FileToRead} file @param {{ input?: string[] }} model the model the reading is for
 * @param {{ llm: { call: Function, config: () => Promise<any>, bench: import('../llm/fallback.js').Bench }, half: 'one' | 'kokoro' | 'koe', pages: import('../pdf-pages.js').PdfPages | null,
 *   signal: AbortSignal, wakeId: string, scope: string, secondMs: number, explain: (e: unknown, role: string) => string | Promise<string>, store: import('../types.js').Store,
 *   shared?: boolean, copy?: (page: import('../pdf-pages.js').PageImage) => Promise<import('../pdf-pages.js').PageImage>,
 *   learn?: (err: import('../llm/contract.js').ProviderError, modelId: string) => Promise<null> }} o
 *   explain: why a reader failed, in English for the model (the loop's, which knows whether the device is online, and blanks every key annai keeps);
 *   store: whose keys the PDF pages plugin's error is blanked of; shared: the half's turn shares the link with the other half's (loop.js), and
 *   so does each reader's send; copy: a page picture as a request sends it (the loop's: under the photos' request limits, the readers'
 *   among them, by their encoder, spec §7.2), else each goes as drawn; learn: a reader's call refused for a photo (the loop's: saves the limit the
 *   provider's words state on the reader's record, and answers null, no fix: the call is not retried)
 * @returns {Promise<Reading>}
 */
export async function readFile(file, model, o) {
  const cfg = await o.llm.config();
  const pdf = file.kind === 'pdf';
  const roles = readerRoles(cfg, o.half);
  const takes = (/** @type {string} */ role, /** @type {string} */ kind) => chatCandidates(cfg, role).some((id) => cfg.models[id] && modelOf(cfg.models[id]).input.includes(kind));
  // The turn's stop, and the pages' drawing's time limit, end it (without AbortSignal.any, which older browsers lack).
  const stop = new AbortController();
  const end = () => stop.abort();
  o.signal.addEventListener('abort', end, { once: true });
  if (o.signal.aborted) end();
  const stopped = new Promise((_, no) => stop.signal.addEventListener('abort', () => no(new Error('stopped')), { once: true }));
  stopped.catch(() => {});
  /** @type {(how: Reading['how'], text: string, images?: Reading['images']) => Reading} */
  const reading = (how, text, images = []) => ({ how, text, images });
  /** How long a reader waits for its first words: the longer of its role's own wait and DESCRIBE_S. @param {string} role */
  const wait = (role) => Math.max(firstWordsMs(cfg, role), DESCRIBE_S * o.secondMs);
  /** What failed last, in words. */
  let failed = '';
  /** The readers whose send was cut in this reading: they rest once a reader of another role read it in their place (callRole's rule, across roles). @type {string[]} */
  const cut = [];
  /**
   * The first reader role's model that takes kind and answers, else null; sent: the parts it was sent. @param {string} kind
   * @param {any[] | ((role: string) => any[])} parts what is sent, or what is sent to a role
   * @param {string} system @param {string} ask @param {number} maxOutput
   */
  const ask = async (kind, parts, system, ask, maxOutput) => {
    for (const role of roles.filter((r) => takes(r, kind))) {
      if (stop.signal.aborted) break;
      try {
        const sent = typeof parts === 'function' ? parts(role) : parts;
        const r = await o.llm.call({
          role, level: 'off', signal: stop.signal, scope: o.scope, record: { tag: 'describe', wake: o.wakeId }, firstOutputMs: wait(role), shared: Boolean(o.shared), repairImages: o.learn,
          request: { system, maxOutput, messages: [{ role: 'user', parts: [...sent, { type: 'text', text: ask }] }] },
        });
        if (r.reply.text.trim()) {
          for (const id of cut) if (id !== r.modelId) o.llm.bench.bench(id, COOLDOWN_MS);
          return { ...r, sent };
        }
      } catch (e) {
        if (e instanceof AllFailedError) cut.push(...e.attempts.filter((a) => a.said?.code === 'send').map((a) => a.model));
        /* en */
        failed ||= `It couldn't be described: ${await o.explain(e, role)}`;
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
        const late = setTimeout(end, DESCRIBE_PDF_S * o.secondMs);
        try {
          // Up to MAX_PAGES, whatever this model's photo limit: the reading is kept for every model, and each request sends only its
          // model's limit, from page 1.
          drawn = await Promise.race([o.pages.pages(fromBase64(file.data), { max: MAX_PAGES, edge: PAGE_EDGE, signal: stop.signal }), stopped]);
        } catch (e) {
          if (stop.signal.aborted) throw e;
          /* en */
          // What the readers said when they failed (out of credit, say) comes first; "no model here reads PDFs" only when none does.
          /* en */
          const why = `The PDF pages plugin couldn't draw its pages: ${await withoutSecrets(o.store, /** @type {any} */ (e)?.message ?? e)}`;
          return reading('failed', [failed, why, reader ? '' : noReader('pdf')].filter(Boolean).join('\n'));
        } finally {
          clearTimeout(late);
        }
        // Each picture as a request sends it (o.copy: under a photo's byte cap, 256 KiB by default, where the plugin's JPEG at 1600 px was
        // about 500 KB a page of small print), one after another: one canvas at a time on a phone. After the drawing's time limit, which
        // catches a plugin that hangs: this is annai's own encoder, untimed as a photo's copy is; the turn's stop still ends it.
        if (o.copy) {
          const copies = [];
          for (const p of drawn.pages) copies.push(await Promise.race([o.copy(p), stopped]));
          drawn = { ...drawn, pages: copies };
        }
        // A page with nothing drawn on it isn't sent (a booking's empty last page went as a picture every turn).
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
          // A reader is sent no more pages than its role's models all take, from page 1, and no stub for a PDF it can't see; its words say
          // which pages they cover, as they are kept for every model.
          const most = (/** @type {string} */ role) => Math.min(MAX_PAGES, ...chatCandidates(cfg, role).flatMap((id) => {
            const m = cfg.models[id] ? modelOf(cfg.models[id]) : null;
            return m?.input.includes('image') && m.images?.maxCount ? [m.images.maxCount] : [];
          }));
          const told = await ask('image', (role) => images.slice(0, most(role)).map((i) => ({ type: 'image', ...i })), DESCRIBE_PAGES, /* en */ 'Give the content of these pages.', 3000);
          const covered = told ? told.sent.map((/** @type {any} */ p) => p.page).filter((/** @type {any} */ n) => typeof n === 'number') : [];
          /* en */
          const read = !covered.length ? 'its pages' : covered.length === 1 ? `page ${covered[0]} of ${drawn.count}` : covered.every((n, i) => n === covered[0] + i) ? `pages ${covered[0]}–${covered.at(-1)} of ${drawn.count}` : `pages ${covered.slice(0, -1).join(', ')} and ${covered.at(-1)} of ${drawn.count}`;
          // A blank page among them is said to be blank, as the pages line says it, so it doesn't look unread.
          const blanks = !blank.length ? '' : blank.length === 1 ? `; page ${blank[0]} is blank` : `; pages ${blank.slice(0, -1).join(', ')} and ${blank.at(-1)} are blank`;
          /* en */
          const which = `${read}${blanks}`;
          /* en */
          if (told) return reading('told', `What it says (told by ${told.answeredBy} from pictures of ${which}, as you can't read PDFs): ${told.reply.text.trim()}${told.reply.stop === 'length' ? GOES_ON : ''}`);
        }
      } else if (!stop.signal.aborted && !reader) return reading('none', noReader('pdf', o.pages ? { photos: true } : { plugin: sees || seer }));
    }
  } catch {
    // stopped: said below
  } finally {
    o.signal.removeEventListener('abort', end);
  }
  /* en */
  if (o.signal.aborted) return reading('stopped', "It wasn't described: the turn was stopped first.");
  // Only the pages' drawing has a time limit of the reading's own.
  /* en */
  if (stop.signal.aborted) return reading('late', `It couldn't be described in time (${DESCRIBE_PDF_S} seconds).`);
  /* en */
  return reading('failed', failed || "It couldn't be described.");
}
