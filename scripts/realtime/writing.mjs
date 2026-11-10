// How a speech model wrote what it was played (stage 5: the rule rests on a rising "Yes?" being written with a question mark): for each clip, in the records of some runs,
// how often it was played, how often a line was written for it, how often with a question mark, and the texts. Koe talking: what Gemini Live's transcripts say for each of the user's turns; classic voice: what the speech-to-text server answered (the stand-in logs it). Pure: from the records.
import { analyse } from './analyse.mjs';
import { asrLines, tidy, turnTexts } from './card.mjs';

/** Whether a text ends in a question mark of any script (Gemini and the speech-to-text write ？ in Japanese and Chinese), as annai's own rule reads it. @param {string} text */
export const asksQuestion = (text) => /[?？][\p{P}\s]*$/u.test(String(text).normalize('NFKC'));

/**
 * @param {{ rec: import('./analyse.mjs').Rec, file: string }[]} recs @param {Record<string, any>} clips
 * @returns {{ mode: 'live' | 'classic', clip: string, words: string, played: number, written: number, withMark: number, texts: Record<string, number> }[]}
 */
export function writtenAs(recs, clips) {
  /** @type {Map<string, { mode: 'live' | 'classic', clip: string, words: string, played: number, written: number, withMark: number, texts: Record<string, number> }>} */
  const by = new Map();
  const row = (/** @type {'live' | 'classic'} */ mode, /** @type {string} */ clip) => {
    const key = `${mode}/${clip}`;
    if (!by.has(key)) by.set(key, { mode, clip, words: clips[clip]?.words ?? '', played: 0, written: 0, withMark: 0, texts: {} });
    return /** @type {NonNullable<ReturnType<typeof by.get>>} */ (by.get(key));
  };
  for (const { rec } of recs) {
    const mode = rec.mode === 'classic' ? 'classic' : 'live';
    for (const p of rec.plays) if (p.name !== 'silence') row(mode, p.name).played++;
    /** @type {{ clip: string, text: string }[]} */
    const written = mode === 'classic'
      ? asrLines(rec).filter((a) => a.clip && a.text.trim()).map((a) => ({ clip: /** @type {{ name: string }} */ (a.clip).name, text: a.text }))
      : turnTexts(rec, analyse(rec, clips)).filter((t) => t.clip && t.text).map((t) => ({ clip: /** @type {string} */ (t.clip), text: t.text }));
    for (const w of written) {
      const r = row(mode, w.clip);
      r.written++;
      if (asksQuestion(w.text)) r.withMark++;
      const t = tidy(w.text);
      r.texts[t] = (r.texts[t] ?? 0) + 1;
    }
  }
  return [...by.values()].sort((a, b) => a.mode.localeCompare(b.mode) || a.clip.localeCompare(b.clip));
}

/** @param {ReturnType<typeof writtenAs>} rows */
export function writingTable(rows) {
  const out = ['| mode | clip | words | played | written | with a question mark | what was written (times) |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) out.push(`| ${r.mode} | ${r.clip} | ${r.words} | ${r.played} | ${r.written} | ${r.withMark} | ${Object.entries(r.texts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${JSON.stringify(t)} ${n}`).join(', ')} |`);
  return out.join('\n');
}
