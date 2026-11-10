// A table of stage 5's card runs: one row a scenario, over every run of it in some folders (each run folder holds one scenario's .json). Pure: from the records, with
// the analysis done anew (so a change to card.mjs needs no new run).
import { analyseOne } from './run.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { loadRecs, percentile } from './lateness.mjs';

/** @param {number | null | undefined} ms */
const s = (ms) => (ms === null || ms === undefined ? '-' : (ms / 1000).toFixed(1));
/** median [min to max] in seconds, or "-". @param {(number | null | undefined)[]} xs */
const span = (xs) => {
  const v = /** @type {number[]} */ (xs.filter((x) => x !== null && x !== undefined));
  return v.length ? `${s(percentile(v, 50))} [${s(Math.min(...v))} to ${s(Math.max(...v))}] (n=${v.length})` : '-';
};

/**
 * @param {{ rec: import('./analyse.mjs').Rec, file: string }[]} recs @param {Record<string, any>} clips
 * @returns {{ rows: any[], text: string }}
 */
export function cardTable(recs, clips) {
  /** @type {Map<string, { rec: any, a: any, file: string }[]>} */
  const by = new Map();
  for (const { rec, file } of recs) {
    const sc = SCENARIOS[rec.scenario];
    if (!sc?.card) continue;
    const a = analyseOne(rec, clips, sc);
    by.set(rec.scenario, [...(by.get(rec.scenario) ?? []), { rec, a, file }]);
  }
  const names = Object.keys(SCENARIOS).filter((n) => by.has(n));
  const rows = names.map((name) => {
    const runs = /** @type {{ rec: any, a: any, file: string }[]} */ (by.get(name));
    const kinds = runs.map((r) => r.a.card?.kind ?? 'none');
    const tally = ['granted-voice', 'granted-tap', 'declined-voice', 'unanswered', 'not-now', 'stopped', 'none'].map((k) => [k, kinds.filter((x) => x === k).length]).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
    // Right: every check of the card's own (not the general ones: errors and echo) held.
    const own = (/** @type {any} */ r) => r.a.checks.filter((/** @type {any} */ c) => !['no errors', 'no echo cut'].includes(c.name));
    const right = runs.filter((r) => own(r).every((/** @type {any} */ c) => c.ok)).length;
    const failed = [...new Set(runs.flatMap((r) => own(r).filter((/** @type {any} */ c) => !c.ok).map((/** @type {any} */ c) => c.name)))];
    const errors = runs.filter((r) => r.a.checks.some((/** @type {any} */ c) => c.name === 'no errors' && !c.ok)).length;
    // What the speech model wrote for the last clip (Gemini's heard line, or the speech-to-text's words).
    const wrote = runs.map((r) => (r.rec.mode === 'classic' ? r.a.card.asr.findLast((/** @type {any} */ x) => x.clip && x.clip.end === r.a.card.lastEnd)?.text : r.a.card.lines.at(-1)?.final)).filter((x) => x !== undefined);
    return {
      name, runs: runs.length, right, failed, errors, tally,
      grantAfterClip: runs.map((r) => r.a.card.ms.grant), writeDown: runs.map((r) => (r.rec.mode === 'classic' ? r.a.card.ms.writeDown : r.a.card.ms.heardEntry)),
      resultAfterClip: runs.map((r) => r.a.card.ms.result), wrote: [...new Set(wrote)],
      dirs: runs.map((r) => r.file),
    };
  });
  const out = ['| scenario | right | outcomes | clip end to grant s | clip end to written down s | what the model wrote | not right: which check | errors |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) out.push(`| ${r.name} | ${r.right} of ${r.runs} | ${r.tally} | ${span(r.grantAfterClip)} | ${span(r.writeDown)} | ${r.wrote.map((x) => JSON.stringify(x)).join(' ')} | ${r.failed.join(', ') || '-'} | ${r.errors} |`);
  return { rows, text: out.join('\n') };
}

export { loadRecs };
