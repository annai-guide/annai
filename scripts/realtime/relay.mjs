// What a realtime check makes of one answer, and the right half's (the one-answer scenarios): pure functions from one scenario's record and its general
// analysis to checks. Koe passes on what it can't answer, as it was said, and asks nothing back; an acknowledgement gets no reply; a note cut as she says it is
// said again from its start, once; a typed line gets no more lines of hers than it needs. Tested without a browser (test/unit/realtime-relay.test.js).
import { wordRecall } from './analyse.mjs';

/**
 * How much of a line Kokoro must be given for it to have been passed on as said: 0.8 of its words, so one word in five may be lost to how each side wrote
 * it down ("let's" and "lets", a number as a word); a reading in Koe's own words ("they want all three") keeps half or less.
 */
export const AS_SAID = 0.8;
/** The bars (docs/testing/realtime-check.md): passed on with no question back in at least 9 of 10 lines; no sound back in 20 acknowledgements. */
export const BARS = { passed: { of: 10, least: 9 }, acks: { of: 20, most: 0 } };
/** annai's ask for a note sound cut off (CUE_CUT in src/core/koe/live.js), by its first words. */
const CUT_ASK = 'Sound cut you off';
/** The stand-in Kokoro's note ("…about twenty minutes ahead on Highway 1"): a word from its start and one from its end, so a note taken up from its middle shows. */
const NOTE_START = /\btwenty\b|\b20\b/i;
const NOTE_END = /\bhighway\b/i;

/** Up to n characters of a text on one line. @param {unknown} x @param {number} [n] */
const short = (x, n = 100) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The last line Koe gave Kokoro ("[Koe asks] …" or "[Koe notes] …") in a request the stand-in Kokoro logged, without its quotes, or ''.
 * @param {string} text
 */
export function passedText(text) {
  const all = [...String(text ?? '').matchAll(/\[Koe (?:asks|notes)\][ \t]*(.*)$/gm)];
  return short(all.at(-1)?.[1] ?? '', 400).replace(/^"|"$/g, '');
}

/**
 * @param {import('./analyse.mjs').Rec & { typed?: { at: number, text: string, lines?: number }[] }} rec @param {ReturnType<typeof import('./analyse.mjs').analyse>} a
 * @param {import('./scenarios.mjs').Scenario} sc @param {Record<string, { words: string }>} clips the clips' words
 * @returns {{ checks: import('./analyse.mjs').Check[], text: string[], tally: { passed?: [number, number], acks?: [number, number] } }}
 *   tally: passed, [lines passed on with no question back, lines counted]; acks, [acknowledgements that got sound back, acknowledgements counted]
 */
export function analyseRelay(rec, a, sc, clips) {
  const frames = [...rec.frames].sort((x, y) => x.at - y.at);
  /** @type {import('./analyse.mjs').Check[]} */
  const checks = [];
  /** @type {string[]} */
  const text = [];
  /** @type {{ passed?: [number, number], acks?: [number, number] }} */
  const tally = {};
  const played = [...a.clips].sort((x, y) => x.at - y.at);
  /** When the next clip began after this one, or the record's end. @param {import('./analyse.mjs').ClipResult} c */
  const until = (c) => played.find((x) => x.at > c.at)?.at ?? rec.endedAt;
  const inWindow = (/** @type {number} */ from, /** @type {number} */ to) => frames.filter((f) => f.at > from && f.at < to);
  const said = (/** @type {import('./analyse.mjs').Frame[]} */ fs) => fs.filter((f) => f.dir === 'in' && f.kind === 'said').map((f) => f.text ?? '').join('').replace(/\s+/g, ' ').trim();

  if (sc.passOn) {
    // Each line: from its turn's end to the next clip. Passed on: her tell_kokoro in that time; asked back: a question mark in what she said before Kokoro's
    // note went in, or her own buttons (ask). As said: what Kokoro was given, against what Gemini heard and what the clip says (the better of the two).
    const rows = played.filter((c) => c.expect === 'answer').map((c) => {
      if (!c.turns) return { c, counted: false, passed: false, line: `   ${c.name}: no turn was made of it (not counted)` };
      const from = c.end + (c.endLagMs ?? 0);
      const fs = inWindow(from, until(c));
      const tell = fs.find((f) => f.dir === 'in' && f.kind === 'toolCall' && f.name === 'tell_kokoro');
      const note = fs.find((f) => f.dir === 'out' && f.kind === 'text' && (f.text ?? '').startsWith('<from_kokoro'));
      const before = fs.filter((f) => f.at < (note?.at ?? Infinity));
      const words = said(before);
      const asked = /\?/.test(words) || before.some((f) => f.dir === 'in' && f.kind === 'toolCall' && f.name === 'ask');
      const given = tell ? passedText((rec.kokoro ?? []).find((k) => k.kind === 'request' && k.at >= tell.at && /\[Koe (asks|notes)\]/.test(k.text ?? ''))?.text ?? '') : '';
      const recall = given ? Math.max(wordRecall(c.heard, given), wordRecall(clips[c.name]?.words ?? '', given)) : null;
      const passed = Boolean(tell) && !asked;
      const why = !tell ? 'NOT passed on (no tell_kokoro)' : asked ? 'ASKED BACK' : 'passed on';
      return {
        c, counted: true, passed, recall, given,
        line: `   ${c.name}: ${why}; she said "${short(words)}"${given ? `; Kokoro got "${short(given)}" (${Math.round((recall ?? 0) * 100)}% of the words)` : tell ? '; what Kokoro got was not logged' : ''}`,
      };
    });
    const counted = rows.filter((r) => r.counted);
    const passed = counted.filter((r) => r.passed);
    tally.passed = [passed.length, counted.length];
    text.push(...rows.map((r) => r.line));
    checks.push({ name: 'passed on', ok: passed.length === counted.length && counted.length > 0, detail: `${passed.length} of ${counted.length} lines passed on with no question back${counted.length < rows.length ? ` (${rows.length - counted.length} made no turn, not counted)` : ''}` });
    const loose = counted.filter((r) => r.recall !== null && r.recall !== undefined && r.recall < AS_SAID);
    checks.push({ name: 'passed on as said', soft: true, ok: loose.length === 0, detail: loose.length ? loose.map((r) => `${r.c.name}: "${short(r.given, 80)}"`).join('; ') : `every line Kokoro was given kept ${AS_SAID * 100}% of its words or more` });
  }

  if (sc.acks?.length) {
    // An acknowledgement, said after her answer: any run of her sound from its turn's end to the next clip is a reply. One no turn was made of isn't counted.
    const acks = played.filter((c) => c.expect === 'ack');
    const counted = acks.filter((c) => c.turns);
    const sounded = counted.filter((c) => c.firstSoundMs !== null);
    tally.acks = [sounded.length, counted.length];
    for (const c of sounded) text.push(`   ${c.name} at ${((c.at - rec.startedAt) / 1000).toFixed(1)} s got sound back: "${short(c.said)}"`);
    checks.push({ name: 'acknowledgements left quiet', ok: sounded.length === 0 && counted.length > 0, detail: `${sounded.length} of ${counted.length} acknowledgements got sound back${counted.length < acks.length ? ` (${acks.length - counted.length} made no turn, not counted)` : ''}` });
  }

  if (sc.noteCut) {
    // The noise: her cut after it began, annai's ask for the note again (once), and her words after the ask holding the note's start and its end.
    const bump = played.find((c) => c.expect === 'noise');
    const cut = bump ? a.cuts.find((k) => k.at >= bump.at) : undefined;
    const asks = bump ? frames.filter((f) => f.dir === 'out' && f.kind === 'text' && f.at >= bump.at && (f.text ?? '').includes(CUT_ASK)) : [];
    const again = asks.length ? said(frames.filter((f) => f.at > asks[0].at)) : '';
    const shown = bump ? rec.trace.filter((t) => t.type === 'reminder' && t.data?.unsaid && t.at >= bump.at) : [];
    const whole = NOTE_START.test(again) && NOTE_END.test(again);
    const ok = Boolean(cut) && asks.length === 1 && whole && shown.length === 0;
    const detail = !bump ? 'no noise was played' : !cut ? 'the noise did not cut her: nothing to say again' : !asks.length ? 'she was cut, and annai never asked for the note again'
      : `asked again ${asks.length === 1 ? 'once' : `${asks.length} times`}; after it she said "${short(again, 120)}"${whole ? ' (from its start)' : ' (NOT the note from its start)'}${shown.length ? '; annai also showed it' : ''}`;
    checks.push({ name: 'cut note said again', ok, detail });
  }

  const typed = (rec.typed ?? []).filter((t) => t.lines);
  if (typed.length) {
    // Each typed line's answer: her lines (Koe's, live) and what annai showed for her, from the Send to the next typed line.
    const all = [...(rec.typed ?? [])].sort((x, y) => x.at - y.at);
    const rows = typed.map((t) => {
      const next = all.find((x) => x.at > t.at)?.at ?? rec.endedAt;
      const lines = rec.trace.filter((e) => (e.type === 'out.speak' || (e.type === 'reminder' && e.data?.answer)) && e.at > t.at && e.at < next);
      return { t, lines, ok: lines.length >= 1 && lines.length <= /** @type {number} */ (t.lines) };
    });
    for (const r of rows) text.push(`   typed "${short(r.t.text, 60)}": ${r.lines.length} line${r.lines.length === 1 ? '' : 's'} (at most ${r.t.lines}): ${r.lines.map((e) => `"${short(e.text, 80)}"`).join(' / ') || 'none'}`);
    checks.push({ name: 'one answer to each typed line', ok: rows.every((r) => r.ok), detail: rows.map((r) => `"${short(r.t.text, 40)}" ${r.lines.length} of at most ${r.t.lines}`).join('; ') });
  }
  return { checks, text, tally };
}

/**
 * The bars over every run of each scenario in a report: its lines passed on with no question back, or its acknowledgements with sound back, against its bar.
 * @param {{ rec: { scenario: string }, a: { pass: boolean, relay?: { passed?: [number, number], acks?: [number, number] } } }[]} runs @returns {string[]}
 */
export function relayTally(runs) {
  const out = [];
  for (const name of [...new Set(runs.map((r) => r.rec.scenario))]) {
    const mine = runs.filter((r) => r.rec.scenario === name);
    const sum = (/** @type {'passed' | 'acks'} */ k) => mine.reduce((n, r) => (r.a.relay?.[k] ? [n[0] + r.a.relay[k][0], n[1] + r.a.relay[k][1]] : n), [0, 0]);
    const times = `${mine.length} run${mine.length === 1 ? '' : 's'}`;
    const [p, pn] = sum('passed');
    if (pn) {
      const ok = pn >= BARS.passed.of && p / pn >= BARS.passed.least / BARS.passed.of;
      out.push(`${name}: passed on, no question back, ${p} of ${pn} lines in ${times} (the bar: at least ${BARS.passed.least} of ${BARS.passed.of}${pn < BARS.passed.of ? '; too few lines: --times' : ''}) ${ok ? 'MET' : 'NOT MET'}`);
    }
    const [s, sn] = sum('acks');
    if (sn) {
      const ok = sn >= BARS.acks.of && s <= BARS.acks.most;
      out.push(`${name}: acknowledgements with sound back, ${s} of ${sn} in ${times} (the bar: none in ${BARS.acks.of}${sn < BARS.acks.of ? '; too few: --times' : ''}) ${ok ? 'MET' : 'NOT MET'}`);
    }
  }
  return out;
}
