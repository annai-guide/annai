#!/usr/bin/env node
// Claude's thinking sent back within a turn, checked against the real providers: see docs/testing/reasoning-check.md.
//   node scripts/reasoning-check.mjs run [--anthropic-key <path>] [--openrouter-key <path>] [--out <dir>]   at least one key; costs a few cents
//   node scripts/reasoning-check.mjs run --stand-ins [--out <dir>]                                          the same run against the stand-ins
//   node scripts/reasoning-check.mjs report <folder>                                                        a run's summary checked again (no network)
// A key is read from the file named, only inside this run, and goes only into its requests' header; nothing printed or written holds it.
// Exit: 0 every check passed, 1 one failed, 2 the run itself failed.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from './realtime/args.mjs';

const { words, opts } = parseArgs(process.argv.slice(2), { flags: ['stand-ins', 'help'] });
const command = words[0];
/** A folder given on the command line, as an address with its slash. @param {string} path */
const folder = (path) => pathToFileURL(`${resolve(path)}/`);

if (command === 'report') {
  const { reread } = await import('./reasoning/run.mjs');
  if (!words[1]) throw new Error('Which folder? node scripts/reasoning-check.mjs report <folder>');
  const r = await reread(folder(words[1]));
  console.log(r.text);
  process.exit(r.pass ? 0 : 1);
} else if (command === 'run') {
  const { runCheck } = await import('./reasoning/run.mjs');
  const { Keys } = await import('./realtime/keys.mjs');
  const out = typeof opts.out === 'string' ? folder(opts.out) : new URL(`../.superpowers/evidence/reasoning-check/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}/`, import.meta.url);
  /** @type {InstanceType<typeof Keys>[]} */
  const keys = [];
  try {
    /** @type {Parameters<typeof runCheck>[0]['providers']} */
    const providers = [];
    if (opts['stand-ins']) {
      const { standIns } = await import('./reasoning/stand-ins.mjs');
      const s = standIns();
      const k = new Keys([{ line: null, key: 'sk-stand-in-not-a-key' }]);
      keys.push(k);
      providers.push({ provider: 'anthropic', key: () => k.key, fetch: s.fetch }, { provider: 'openrouter', key: () => k.key, fetch: s.fetch });
    } else {
      for (const [provider, flag] of /** @type {const} */ ([['anthropic', 'anthropic-key'], ['openrouter', 'openrouter-key']])) {
        if (typeof opts[flag] !== 'string') continue;
        const k = Keys.fromPath(opts[flag], '1');
        keys.push(k);
        providers.push({ provider, key: () => k.key, fetch: (url, init) => fetch(url, init) });
      }
      if (!providers.length) throw new Error('Give --anthropic-key <path>, --openrouter-key <path>, or both (or --stand-ins).');
    }
    const r = await runCheck({ providers, out, keys });
    console.log(`written to ${out.pathname}`);
    process.exit(r.pass ? 0 : 1);
  } catch (e) {
    let said = String(/** @type {any} */ (e)?.stack ?? e);
    for (const k of keys) said = k.scrub(said);
    console.error(said);
    process.exit(2);
  }
} else {
  console.error('Usage: node scripts/reasoning-check.mjs run [--anthropic-key <path>] [--openrouter-key <path>] | run --stand-ins | report <folder>; see docs/testing/reasoning-check.md');
  process.exit(command ? 2 : 0);
}
