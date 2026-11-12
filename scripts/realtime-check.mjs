#!/usr/bin/env node
// Drives the real Gemini Live through annai's own code, with real speech: see docs/testing/realtime-check.md.
//   node scripts/realtime-check.mjs clips [--only a,b] [--force] [--tts-model m]     make the speech clips (Gemini TTS; once)
//   node scripts/realtime-check.mjs run   [--only s1,s2] [--times n] [--out dir] [--kokoro gemini|stand-in] ...   run the conversations
//   node scripts/realtime-check.mjs report <folder>                                   the analysis of a run's records again (no network)
//   node scripts/realtime-check.mjs writing <run folder>...                            how a speech model wrote each clip, with a question mark or not (no network)
//   node scripts/realtime-check.mjs cards <run folder>...                              stage 5's card runs as a table, a row a scenario (no network)
//   node scripts/realtime-check.mjs lateness <folder>... [--settle s] [--rows f.json]  how late the words of a live line arrive, from finished runs (no network)
// A key: GEMINI_KEY, or --keys-file <path> --lines <1-11>. It is read inside the process, never printed or written.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs, keysFrom } from './realtime/args.mjs';

/** A folder given on the command line, as an address with its slash. @param {string} path */
const folder = (path) => pathToFileURL(`${resolve(path)}/`);

const { words, opts } = parseArgs(process.argv.slice(2), { flags: ['force', 'help', 'list'] });
const command = words[0];

if (command === 'clips') {
  const { makeClips, TTS_MODEL } = await import('./realtime/clips.mjs');
  const keys = await keysFrom(opts, process.env);
  const made = await makeClips({
    keys, force: opts.force === true, model: typeof opts['tts-model'] === 'string' ? opts['tts-model'] : TTS_MODEL,
    ...(typeof opts.only === 'string' ? { only: opts.only.split(',') } : {}),
  });
  console.log(made.length ? `made: ${made.join(', ')}${keys.line ? ` (last key on line ${keys.line})` : ''}` : 'every clip is there already; --force makes them again');
} else if (command === 'report') {
  // The records of a run read again, its analysis done anew: node scripts/realtime-check.mjs report <folder>
  const { reanalyse } = await import('./realtime/run.mjs');
  const { loadClips } = await import('./realtime/clips.mjs');
  if (!words[1]) throw new Error('Which folder? node scripts/realtime-check.mjs report <folder>');
  console.log(await reanalyse(folder(words[1]), await loadClips()));
} else if (command === 'lateness') {
  // How late the words of a live line arrive, from the records of finished runs: node scripts/realtime-check.mjs lateness <folder>... [--settle 3] [--rows file.json]
  const { loadRecs, lineRows, latenessReport } = await import('./realtime/lateness.mjs');
  const { loadClips } = await import('./realtime/clips.mjs');
  if (words.length < 2) throw new Error('Which folders? node scripts/realtime-check.mjs lateness <folder>...');
  const rows = lineRows(await loadRecs(words.slice(1)), await loadClips());
  if (typeof opts.rows === 'string') await (await import('node:fs/promises')).writeFile(opts.rows, `${JSON.stringify(rows, null, 1)}\n`);
  console.log(latenessReport(rows, typeof opts.settle === 'string' ? Number(opts.settle) : 3));
} else if (command === 'cards') {
  // Stage 5's card runs as a table, one row a scenario over every run in the folders: node scripts/realtime-check.mjs cards <run folder>...
  const { cardTable, loadRecs } = await import('./realtime/cards.mjs');
  const { loadClips } = await import('./realtime/clips.mjs');
  if (words.length < 2) throw new Error('Which folders? node scripts/realtime-check.mjs cards <run folder>...');
  console.log(cardTable(await loadRecs(words.slice(1)), await loadClips()).text);
} else if (command === 'writing') {
  // How a speech model wrote each clip (how often with a question mark), from the records of finished runs: node scripts/realtime-check.mjs writing <run folder>...
  const { writtenAs, writingTable } = await import('./realtime/writing.mjs');
  const { loadRecs } = await import('./realtime/lateness.mjs');
  const { loadClips } = await import('./realtime/clips.mjs');
  if (words.length < 2) throw new Error('Which folders? node scripts/realtime-check.mjs writing <run folder>...');
  console.log(writingTable(writtenAs(await loadRecs(words.slice(1)), await loadClips())));
} else if (command === 'run') {
  const { runChecks } = await import('./realtime/run.mjs');
  const { SCENARIOS } = await import('./realtime/scenarios.mjs');
  if (opts.list) {
    for (const [name, sc] of Object.entries(SCENARIOS)) console.log(`${name.padEnd(12)} ${sc.extra ? '(extra: only by name) ' : ''}${sc.about}`);
    process.exit(0);
  }
  const keys = await keysFrom(opts, process.env);
  // The one Anthropic key (stage 5's real Kokoro): a file's first line, read here and typed into annai's key field by the scenarios that ask for it.
  const { Keys } = await import('./realtime/keys.mjs');
  const anthropic = typeof opts['anthropic-key'] === 'string' ? Keys.fromPath(opts['anthropic-key'], '1') : undefined;
  const out = new URL(`../.superpowers/evidence/realtime-harness/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}/`, import.meta.url);
  try {
    const r = await runChecks({
      keys, out: typeof opts.out === 'string' ? folder(opts.out) : out,
      ...(typeof opts.only === 'string' ? { only: opts.only.split(',') } : {}),
      ...(typeof opts.port === 'string' ? { port: Number(opts.port) } : {}),
      ...(typeof opts['room-db'] === 'string' ? { roomDb: opts['room-db'] === 'off' ? null : Number(opts['room-db']) } : {}),
      ...(opts.kokoro === 'gemini' || opts.kokoro === 'stand-in' ? { kokoro: opts.kokoro } : {}),
      ...(typeof opts.app === 'string' ? { app: resolve(opts.app) } : {}),
      ...(typeof opts['answer-timeout'] === 'string' ? { answerTimeoutMs: Number(opts['answer-timeout']) * 1000 } : {}),
      ...(typeof opts['max-sessions'] === 'string' ? { maxSessions: Number(opts['max-sessions']) } : {}),
      ...(typeof opts.ui === 'string' ? { ui: opts.ui } : {}),
      ...(typeof opts.asr === 'string' ? { asr: opts.asr } : {}),
      ...(typeof opts.times === 'string' ? { times: Math.max(1, Number(opts.times) || 1) } : {}),
      ...(anthropic ? { anthropic } : {}),
    });
    process.exit(r.pass ? 0 : 1);
  } catch (e) {
    console.error((anthropic ? anthropic.scrub(keys.scrub(String(/** @type {any} */ (e)?.stack ?? e))) : keys.scrub(String(/** @type {any} */ (e)?.stack ?? e))));
    process.exit(2);
  }
} else {
  console.error('Usage: node scripts/realtime-check.mjs clips|run|report|cards|writing|lateness [options]; see docs/testing/realtime-check.md');
  process.exit(command ? 2 : 0);
}
