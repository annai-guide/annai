// What a realtime check makes of one answer, and the right half's (the one-answer scenarios): pure functions from one scenario's record and its general
// analysis to checks. Koe passes on what it can't answer, as it was said, and asks nothing back; an acknowledgement gets no reply; a note cut as she says it is
// shown, never asked for again, and heard whole once at most, and after a "stop" not at all; a typed line gets no more lines of hers than it needs; a reminder
// is said once. Tested without a browser (test/unit/realtime-relay.test.js).
import { wordRecall } from './analyse.mjs';

/**
 * How much of a line Kokoro must be given for it to have been passed on as said: 0.8 of its words, so one word in five may be lost to how each side wrote
 * it down ("let's" and "lets", a number as a word); a reading in Koe's own words ("they want all three") keeps half or less.
 */
export const AS_SAID = 0.8;
/** The bars (docs/testing/realtime-check.md): passed on with no question back in at least 9 of 10 lines; no sound back in 20 acknowledgements. */
export const BARS = { passed: { of: 10, least: 9 }, acks: { of: 20, most: 0 } };
/** annai's asks for a note once more, by their first words: the plain one (NOTE_UNSAID in src/core/agent/loop.js), and the one for a note sound cut, gone since 2026-11-11. */
const ASK = /^\[annai\] "(Kokoro's note hasn't reached the user|Sound cut you off)/;
/**
 * A line of hers is the note heard whole when it holds more than this share of the note's own words (the note as Kokoro sent it, markup aside). She says
 * a note in her own words, so a whole saying keeps well under all of them. In the 22 real cut runs of 2026-11-11 (Gemini Live; the stand-in's 14-word note
 * and Opus's), the lines judged whole by hand kept 40% to 77% of the note's words (one, said in Spanish, none: no word count reads that), and those judged
 * partial ("It's about twenty.", "ahead on Highway 1.") 27% at most; a third lies between.
 */
const WHOLE = 1 / 3;
/** After a "stop", a line of hers this long at most: "Okay." (NO_FILLER's one word when a word is needed) or "Got it."; no note's claim fits in two words. */
const SHORT_WORDS = 2;
/** annai's line for a user turn the session gave nothing back to (live.js, #silent): the model's choice, never retried. */
const LET_GO = /taken as let go/;

/** Up to n characters of a text on one line. @param {unknown} x @param {number} [n] */
const short = (x, n = 100) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** A trace entry's words: a short text is kept in its data, a longer one in a blob the record holds beside it. @param {{ text?: string, data?: any }} t */
const spoken = (t) => String(t.data?.text ?? t.text ?? '');

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

  if (sc.acted) {
    // A request that begins with "stop" is no order to Koe to stop, and Koe has the reminder tools by design: she acts on it when she passes it on (tell_kokoro), or
    // does it with a tool of her own and says so. Silence is the failure (the stop clause swallowed it); words with no act ("Okay.") are the stop's answer, so a failure too.
    const rows = played.filter((c) => c.expect === 'answer').map((c) => {
      if (!c.turns) return { c, counted: false, acted: false, line: `   ${c.name}: no turn was made of it (not counted)` };
      const fs = inWindow(c.end + (c.endLagMs ?? 0), until(c));
      const calls = fs.filter((f) => f.dir === 'in' && f.kind === 'toolCall').map((f) => f.name ?? '');
      const words = said(fs);
      const own = calls.filter((n) => !['tell_kokoro', 'already_told', 'sleep'].includes(n));
      const passed = calls.includes('tell_kokoro');
      const acted = passed || (own.length > 0 && words !== '');
      const how = passed ? 'passed on to Kokoro' : own.length && words ? `her own ${own.join(', ')} and an answer` : own.length ? `her own ${own.join(', ')} and no word` : words ? 'only words, no act' : 'silence';
      return { c, counted: true, acted, line: `   ${c.name}: ${acted ? 'acted on' : 'NOT acted on'} (${how}); she said "${short(words)}"` };
    });
    const counted = rows.filter((r) => r.counted);
    text.push(...rows.map((r) => r.line));
    checks.push({ name: 'acted on it', ok: counted.length > 0 && counted.every((r) => r.acted), detail: `${counted.filter((r) => r.acted).length} of ${counted.length} requests acted on${counted.length < rows.length ? ` (${rows.length - counted.length} made no turn, not counted)` : ''}` });
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
    // What cut it: the first clip played after Kokoro's note went in (a noise, or a spoken "stop"). Then her cut, and from the sound on: the note heard whole (a
    // line of hers holding WHOLE of the note's own words) at most once, shown once (annai's card for the words she didn't say, which it shows when it
    // hears the sound: before the provider's own `interrupted` frame, so counted from the clip's start, never from that frame), and no ask of annai's for it.
    // After a "stop": nothing of the note, a short word at most, nothing passed on, and no retry, fresh session or drop.
    const note = frames.find((f) => f.dir === 'out' && f.kind === 'text' && (f.text ?? '').startsWith('<from_kokoro'));
    const by = note ? played.find((c) => c.at > note.at) : undefined;
    const cut = by ? a.cuts.find((k) => k.at >= by.at) : undefined;
    const body = (note?.text ?? '').replace(/<\/?from_kokoro[^>]*>/g, '');
    const after = cut ? rec.trace.filter((t) => t.type === 'out.speak' && t.at > cut.at && !t.data?.cut) : [];
    const whole = after.filter((t) => wordRecall(body, spoken(t)) > WHOLE);
    const shown = by && cut ? rec.trace.filter((t) => t.type === 'reminder' && t.data?.unsaid && t.data?.answer && t.at >= by.at) : [];
    const asks = by && cut ? frames.filter((f) => f.dir === 'out' && f.kind === 'text' && f.at >= by.at && ASK.test(f.text ?? '')) : [];
    const lines = after.map((t) => `"${short(spoken(t), 80)}"`).join(' / ') || 'nothing';
    const why = !by ? 'nothing was played into the note' : !cut ? `the ${by.name} did not cut her: nothing to show` : '';
    const tail = `asked again ${asks.length === 1 ? 'once' : `${asks.length} times`}; shown ${shown.length === 1 ? 'once' : `${shown.length} times`}`;
    if (sc.noteCut === 'stop') {
      // Told to stop over the note: from the end of the stop, her lines (what was heard of her, annai's record) a short word at most ("Okay."), nothing passed
      // on, and no try of annai's again.
      const from = by ? by.end + (by.endLagMs ?? 0) : Infinity;
      const words = rec.trace.filter((t) => t.type === 'out.speak' && t.at > from).map((t) => spoken(t).replace(/✂$/, '')).join(' ').split(/\s+/).filter(Boolean);
      const passed = frames.some((f) => f.at > from && f.dir === 'in' && f.kind === 'toolCall' && f.name === 'tell_kokoro');
      const fresh = frames.filter((f) => f.at > from && f.dir === 'out' && f.kind === 'setup').length;
      const errs = rec.trace.filter((t) => t.at > from && t.type === 'error' && (t.data?.kind === 'live-dropped' || (t.data?.kind === 'live-silent' && !LET_GO.test(t.data?.message ?? ''))));
      const letGo = rec.trace.some((t) => t.at > from && t.type === 'error' && t.data?.kind === 'live-silent' && LET_GO.test(t.data?.message ?? ''));
      const quiet = words.length <= SHORT_WORDS;
      const ok = !why && quiet && !passed && !fresh && !errs.length && shown.length === 1 && asks.length === 0;
      checks.push({
        name: 'stopped when told', ok,
        detail: why || `${quiet ? `after the "stop": ${words.length ? `"${words.join(' ')}"` : 'nothing'}` : `she said "${short(words.join(' '))}" after the "stop"`}${passed ? '; she passed it on to Kokoro' : ''}${fresh ? `; ${fresh} fresh session${fresh === 1 ? '' : 's'}` : ''}${errs.map((t) => `; ${t.data.kind}: ${short(t.data.message, 80)}`).join('')}${letGo ? '; the turn was let go' : ''}; ${tail}`,
      });
    } else {
      const ok = !why && whole.length <= 1 && shown.length === 1 && asks.length === 0;
      checks.push({
        name: 'cut note heard once at most',
        ok,
        detail: why || `the note heard whole ${whole.length === 1 ? 'once' : `${whole.length} times`} after the cut; ${tail}; her lines after it: ${lines}`,
      });
    }
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
    for (const r of rows) text.push(`   typed "${short(r.t.text, 60)}": ${r.lines.length} line${r.lines.length === 1 ? '' : 's'} (at most ${r.t.lines}): ${r.lines.map((e) => `"${short(spoken(e), 80)}"`).join(' / ') || 'none'}`);
    checks.push({ name: 'one answer to each typed line', ok: rows.every((r) => r.ok), detail: rows.map((r) => `"${short(r.t.text, 40)}" ${r.lines.length} of at most ${r.t.lines}`).join('; ') });
  }
  if (sc.once) {
    // A reminder: her lines, and what annai's own voice said, holding its words; one, not two (both halves) and not none.
    const want = sc.once.toLowerCase();
    const said = rec.trace.filter((t) => (t.type === 'out.speak' || (t.type === 'reminder' && t.data?.aloud)) && spoken(t).toLowerCase().includes(want));
    text.push(`   "${sc.once}": ${said.map((t) => `${t.type === 'reminder' ? "annai's voice" : 'she'} "${short(spoken(t), 80)}"`).join(' / ') || 'never said'}`);
    checks.push({ name: 'reminder said once', ok: said.length === 1, detail: `said ${said.length === 1 ? 'once' : `${said.length} times`}` });
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
