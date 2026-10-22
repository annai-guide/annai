#!/usr/bin/env node
// Drives the real Gemini Live through annai's own code, with real speech: see docs/testing/realtime-check.md.
//   node scripts/realtime-check.mjs clips [--only a,b] [--force] [--tts-model m]     make the speech clips (Gemini TTS; once)
//   node scripts/realtime-check.mjs run   [--only s1,s2] [--out dir] [--kokoro gemini|stand-in] ...   run the conversations
// A key: GEMINI_KEY, or --keys-file <path> --lines <1-11>. It is read inside the process, never printed or written.
import { parseArgs, keysFrom } from './realtime/args.mjs';

const { words, opts } = parseArgs(process.argv.slice(2), { flags: ['force', 'help'] });
const command = words[0];

if (command === 'clips') {
  const { makeClips, TTS_MODEL } = await import('./realtime/clips.mjs');
  const keys = await keysFrom(opts, process.env);
  const made = await makeClips({
    keys, force: opts.force === true, model: typeof opts['tts-model'] === 'string' ? opts['tts-model'] : TTS_MODEL,
    ...(typeof opts.only === 'string' ? { only: opts.only.split(',') } : {}),
  });
  console.log(made.length ? `made: ${made.join(', ')}${keys.line ? ` (last key on line ${keys.line})` : ''}` : 'every clip is there already; --force makes them again');
} else {
  console.error('Usage: node scripts/realtime-check.mjs clips|run [options]; see docs/testing/realtime-check.md');
  process.exit(command ? 2 : 0);
}
