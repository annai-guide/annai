// The run: scenarios one after another, each in a fresh browser context against the real Gemini Live, analysed as it ends,
// everything written under a folder (the record, the timeline, the report) after it has been checked for a key.
import { mkdir, writeFile } from 'node:fs/promises';
import { analyse, detail, summary, timeline } from './analyse.mjs';
import { analyseCard } from './card.mjs';
import { loadClips } from './clips.mjs';
import { clipFiles, launch, runScenario, serve } from './drive.mjs';
import { startKokoro } from './kokoro.mjs';
import { SCENARIOS } from './scenarios.mjs';

/** Whether a record shows the key was out of quota (Gemini says so in a close or an error), so the next key should try. @param {import('./analyse.mjs').Rec} rec */
const outOfQuota = (rec) => JSON.stringify([rec.errors, rec.notes, rec.trace.filter((t) => t.type === 'live.session' || t.type === 'error').map((t) => t.data)]).match(/quota|RESOURCE_EXHAUSTED|"kind":"rate"|rate:/i) !== null;

/**
 * One scenario's record analysed: the general analysis, and for a stage 5 card scenario its card checks in place of the answer checks (a spoken yes is not a
 * question to be answered). @param {import('./analyse.mjs').Rec} rec @param {Record<string, any>} clips @param {import('./scenarios.mjs').Scenario | undefined} sc
 */
export function analyseOne(rec, clips, sc) {
  const a = analyse(rec, clips, { expectCut: sc?.expectCut === true });
  if (sc?.measure) {
    // Lines said to be measured, not answered: only an error fails it.
    const checks = a.checks.filter((x) => x.name === 'no errors');
    return { ...a, checks, warnings: [], pass: checks.every((x) => x.ok) };
  }
  if (!sc?.card) return a;
  const c = analyseCard(rec, a, sc);
  // Her echo and errors stay as the general analysis found them (echo is what the echo scenarios look for: a warning there).
  const kept = a.checks.filter((x) => x.name === 'no errors' || x.name === 'no echo cut').map((x) => (x.name === 'no echo cut' ? { ...x, soft: true } : x));
  const checks = [...c.checks, ...kept];
  return { ...a, checks, warnings: checks.filter((x) => x.soft && !x.ok).map((x) => x.name), pass: checks.filter((x) => !x.soft).every((x) => x.ok), cardText: c.text, card: c.card };
}

/**
 * Reads a run's records again and writes its reports and timelines anew (the analysis changes; Gemini is not called).
 * @param {URL} dir @param {Record<string, { kind: string, words: string }>} clips
 */
export async function reanalyse(dir, clips) {
  const { readdir, readFile } = await import('node:fs/promises');
  /** @type {{ rec: import('./analyse.mjs').Rec, a: ReturnType<typeof analyseOne> }[]} */
  const done = [];
  const used = await readFile(new URL('report.json', dir), 'utf8').then(JSON.parse, () => ({ sessions: 0, lines: [] }));
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json') && x !== 'report.json').sort()) {
    const rec = JSON.parse(await readFile(new URL(f, dir), 'utf8')).rec;
    const sc = SCENARIOS[rec.scenario];
    const a = analyseOne(rec, clips, sc);
    await writeFile(new URL(f, dir), `${JSON.stringify({ rec, analysis: a }, null, 1)}\n`);
    await writeFile(new URL(`${rec.scenario}.timeline.txt`, dir), `${timeline(rec, a)}\n`);
    done.push({ rec, a });
  }
  done.sort((x, y) => Object.keys(SCENARIOS).indexOf(x.rec.scenario) - Object.keys(SCENARIOS).indexOf(y.rec.scenario));
  const report = `${summary(done, used)}\n\n${done.map(({ rec, a }) => detail(rec, a, SCENARIOS[rec.scenario]?.about)).join('\n\n')}\n`;
  await writeFile(new URL('report.txt', dir), report);
  await writeFile(new URL('report.json', dir), `${JSON.stringify({ ...used, results: done.map(({ rec, a }) => ({ scenario: rec.scenario, pass: a.pass, warnings: a.warnings, checks: a.checks, notes: a.notes })) }, null, 1)}\n`);
  return report;
}

/**
 * @param {{ keys: import('./keys.mjs').Keys, only?: string[], out: URL, port?: number, roomDb?: number | null, settleMs?: number, answerTimeoutMs?: number,
 *   maxSessions?: number, kokoro?: 'stand-in' | 'gemini', app?: string, ui?: string, asr?: string, anthropic?: import('./keys.mjs').Keys, log?: (s: string) => void }} o
 *   ui: the screens' language to run under (localization L6), chosen in Settings → Shiori once annai is set up; asr: the origin of a speech-to-text server the
 *   stand-in passes transcription requests to (classic voice, stage 5); anthropic: the Anthropic key (a file's one line, read inside the process, used only by the
 *   scenarios that ask for a real Kokoro, typed into annai's own key field, and checked out of everything written)
 */
export async function runChecks({ keys, only, out, port = 18061, roomDb = -60, settleMs = 3000, answerTimeoutMs = 40_000, maxSessions = 10, kokoro = 'stand-in', app, ui, asr, anthropic, log = console.log }) {
  const names = (only ?? Object.keys(SCENARIOS).filter((n) => !SCENARIOS[n].extra)).filter((n) => {
    if (!SCENARIOS[n]) throw new Error(`There is no scenario "${n}". They are: ${Object.keys(SCENARIOS).join(', ')}.`);
    return true;
  });
  const clips = await loadClips();
  const files = await clipFiles(clips);
  await mkdir(out, { recursive: true });
  /** Everything written is checked first. @param {string} name @param {string} text */
  const write = async (name, text) => {
    keys.assertClean(text, name);
    anthropic?.assertClean(text, name);
    await writeFile(new URL(name, out), text);
  };
  const server = await serve(port, app);
  const standIn = kokoro === 'stand-in' ? await startKokoro({ askClip: Buffer.from(files['ask-q'] ?? '', 'base64'), ...(asr ? { asr } : {}) }) : null;
  const browser = await launch();
  let sessions = 0;
  /** @type {number[]} */
  const lines = [];
  /** @type {{ rec: import('./analyse.mjs').Rec, a: ReturnType<typeof analyseOne> }[]} */
  const done = [];
  try {
    for (const name of names) {
      const sc = SCENARIOS[name];
      for (let attempt = 0; attempt < 2; attempt++) {
        if (sessions >= maxSessions) {
          log(`stopping before ${name}: ${sessions} realtime sessions used, the cap is ${maxSessions}`);
          break;
        }
        log(`\n[${name}] ${sc.about}${keys.line ? ` (key line ${keys.line})` : ''}`);
        const env = { origin: server.origin, ...(standIn ? { standIn: standIn.origin, kokoro: standIn } : {}), key: keys.key, clips: files, roomDb, settleMs, answerTimeoutMs, log, scrub: (/** @type {string} */ s) => (anthropic ? anthropic.scrub(keys.scrub(s)) : keys.scrub(s)), ...(ui ? { ui } : {}), ...(sc.real && anthropic ? { real: { anthropic: anthropic.key, cap: 30 } } : {}) };
        standIn?.repeatNote(sc.repeatNote === true);
        const rec = await runScenario(browser, name, sc, env);
        rec.keyLine = keys.line;
        sessions += rec.frames.filter((f) => f.kind === 'setup').length; // sockets opened with a setup message: what a key's quota counts
        if (keys.line && !lines.includes(keys.line)) lines.push(keys.line);
        if (attempt === 0 && outOfQuota(rec) && keys.advance()) {
          log(`    the key is out of quota; the same conversation again on line ${keys.line}`);
          continue;
        }
        const a = analyseOne(rec, clips, sc);
        await write(`${name}.json`, `${JSON.stringify({ rec, analysis: a }, null, 1)}\n`);
        await write(`${name}.timeline.txt`, `${timeline(rec, a)}\n`);
        done.push({ rec, a });
        log(detail(rec, a, sc.about));
        break;
      }
    }
  } finally {
    await browser.close();
    server.stop();
    await standIn?.stop();
  }
  const report = `${summary(done, { sessions, lines })}\n\n${done.map(({ rec, a }) => detail(rec, a, SCENARIOS[rec.scenario].about)).join('\n\n')}\n`;
  await write('report.txt', report);
  await write('report.json', `${JSON.stringify({ sessions, lines, results: done.map(({ rec, a }) => ({ scenario: rec.scenario, pass: a.pass, warnings: a.warnings, checks: a.checks, notes: a.notes })) }, null, 1)}\n`);
  log(`\n${summary(done, { sessions, lines })}`);
  return { pass: done.length > 0 && done.every(({ a }) => a.pass), sessions };
}
