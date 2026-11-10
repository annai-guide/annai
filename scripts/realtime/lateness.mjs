// How late the words of a live line really arrive (stage 5's settle, SETTLE_S in src/core/agent/loop.js): from the records of any runs, for every line
// Koe heard, the time of annai's `heard` entry, of each `heard.text` revision after it and of the last, the socket's own transcription chunks, and the end
// of the clip that was played into it; and the counts, medians and percentiles of the gaps, by language. Pure: no browser, no network.
import { readdir, readFile } from 'node:fs/promises';
import { analyse } from './analyse.mjs';
import { heardLines } from './card.mjs';
import { spokenYes } from '../../src/core/agent/spoken-yes.js';
import { tidy } from './card.mjs';

/** The p-th percentile, nearest rank (the smallest value with at least p percent at or below it). @param {number[]} xs @param {number} p */
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

/** @param {number[]} xs */
export const stats = (xs) => ({ n: xs.length, median: percentile(xs, 50), p90: percentile(xs, 90), p95: percentile(xs, 95), max: xs.length ? Math.max(...xs) : null });

/**
 * One row for each line Koe heard that a clip made, in the records given.
 * @param {{ rec: import('./analyse.mjs').Rec, file: string }[]} recs @param {Record<string, { kind: string, words: string, lang?: string }>} clips
 */
export function lineRows(recs, clips) {
  /** @type {any[]} */
  const rows = [];
  for (const { rec, file } of recs) {
    const base = analyse(rec, clips);
    for (const l of heardLines(rec, base)) {
      if (!l.clip) continue;
      const lastRev = l.revisions.at(-1)?.at ?? l.at;
      const S1 = l.chunks[0]?.at ?? null;
      const Sm = l.chunks.at(-1)?.at ?? null;
      // The words so far at each chunk: any that read as a yes while the whole line does not.
      let said = '';
      const prefixes = l.chunks.map((c) => tidy((said += c.text)));
      rows.push({
        file, scenario: rec.scenario, clip: l.clip.name, lang: clips[l.clip.name]?.lang ?? 'en', words: clips[l.clip.name]?.words ?? '', dismissed: l.dismissed,
        text0: l.text0, final: l.final, revisions: l.revisions.length, chunks: l.chunks.length,
        entryAfterClip: l.at - l.clip.end, entryToLastRevision: lastRev - l.at, clipToLastRevision: lastRev - l.clip.end, maxGapMs: l.maxGapMs,
        /** how long after the words were at the socket annai wrote them down: the card sees a line only then */
        entryAfterLastChunk: Sm === null ? null : l.at - Sm,
        firstChunkAfterClip: S1 === null ? null : S1 - l.clip.end, lastChunkAfterClip: Sm === null ? null : Sm - l.clip.end, chunkSpread: S1 === null || Sm === null ? null : Sm - S1,
        // An entry written before the transcription was whole: the words annai had at its entry are less than the whole line.
        entryBeforeWhole: l.text0 !== l.final,
        firstYesNotWhole: l.yes0 && !l.yesFinal,
        socketPrefixYesNotWhole: prefixes.some((p) => spokenYes(p)) && !spokenYes(l.final),
      });
    }
  }
  return rows;
}

/** The records (the rec of each scenario's .json) in some run folders. @param {string[]} dirs */
export async function loadRecs(dirs) {
  /** @type {{ rec: import('./analyse.mjs').Rec, file: string }[]} */
  const out = [];
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => []);
    for (const f of names.filter((x) => x.endsWith('.json') && x !== 'report.json').sort()) {
      const j = JSON.parse(await readFile(`${dir.replace(/\/$/, '')}/${f}`, 'utf8'));
      if (j.rec?.frames) out.push({ rec: j.rec, file: `${dir.replace(/\/$/, '').split('/').slice(-1)[0]}/${f}` });
    }
  }
  return out;
}

/** @param {number | null} ms */
const s = (ms) => (ms === null || ms === undefined ? '-' : (ms / 1000).toFixed(2));
/** @param {ReturnType<typeof stats>} st */
const cells = (st) => `${st.n} | ${s(st.median)} | ${s(st.p90)} | ${s(st.p95)} | ${s(st.max)}`;

/**
 * The numbers, as text (markdown tables): by language, each gap in seconds, and how often the first words alone were a yes when the whole line was not.
 * @param {any[]} rows @param {number} [settleS] the settle in use, to say how many lines it would have judged whole
 */
export function latenessReport(rows, settleS = 3) {
  const langs = ['en', 'ja', 'zh', 'ko'].filter((l) => rows.some((r) => r.lang === l));
  const groups = [['all', rows], ...langs.map((l) => [l, rows.filter((r) => r.lang === l)])];
  /** @type {string[]} */
  const out = [];
  /** @param {string} title @param {(r: any) => number | null} f */
  const table = (title, f) => {
    out.push(`\n${title}\n\n| language | n | median s | p90 s | p95 s | max s |\n|---|---|---|---|---|---|`);
    for (const [name, rs] of groups) out.push(`| ${name} | ${cells(stats(/** @type {any[]} */ (rs).map(f).filter((x) => x !== null)))} |`);
  };
  table("annai's `heard` entry to the last `heard.text` revision (0 when there was none)", (r) => r.entryToLastRevision);
  table("the clip's end to the last `heard.text` revision (or to the entry when there was none)", (r) => r.clipToLastRevision);
  table("the clip's end to annai's `heard` entry (written when Koe's turn is complete)", (r) => r.entryAfterClip);
  table("the longest wait between annai's entry and its revisions, one to the next (what the settle must outlast: each revision starts it again)", (r) => r.maxGapMs);
  table("the last transcription chunk at the socket to annai's `heard` entry (the card sees a line only when it is written)", (r) => r.entryAfterLastChunk);
  table('the clip\'s end to the last transcription chunk at the socket', (r) => r.lastChunkAfterClip);
  table('the first to the last transcription chunk at the socket', (r) => r.chunkSpread);
  const whole = rows.filter((r) => r.maxGapMs <= settleS * 1000).length;
  out.push(`\nLines with more than one write (a revision after the entry): ${rows.filter((r) => r.revisions > 0).length} of ${rows.length}; entry written before the transcription was whole: ${rows.filter((r) => r.entryBeforeWhole).length}.`);
  out.push(`With a settle of ${settleS} s, ${whole} of ${rows.length} lines (${rows.length ? Math.round((100 * whole) / rows.length) : 0}%) were whole when judged (no wait from entry or revision to the next over it).`);
  const late = rows.filter((r) => r.firstYesNotWhole || r.socketPrefixYesNotWhole);
  out.push(`The first words alone read as a yes when the whole line did not: at annai's entry ${rows.filter((r) => r.firstYesNotWhole).length}, at some socket chunk ${rows.filter((r) => r.socketPrefixYesNotWhole).length}, of ${rows.length} lines${late.length ? `: ${late.map((r) => `${r.clip} (${r.file})`).join(', ')}` : ''}.`);
  return out.join('\n');
}
