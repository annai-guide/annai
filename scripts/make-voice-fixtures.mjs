#!/usr/bin/env node
// Makes the speech clips the voice tests use (spec §18: the end-of-sentence detector runs on PCM
// fixtures; the end-to-end tests feed a fake microphone). The speech is synthesized by flite through
// ffmpeg (dev-only), trimmed of silence, as 16 kHz 16-bit mono WAV. Run once; the clips are
// committed. Pauses and noise are added by the tests themselves.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../test/fixtures/voice/', import.meta.url));
/** name → [text, flite voice] */
const CLIPS = {
  'where-lunch': ['Where should we stop for lunch?', 'slt'],
  'gas-station': ['Is there a gas station nearby?', 'kal'],
  'where-eat': ['Where should we eat?', 'slt'],
  'first-one': ['Yes, the first one.', 'slt'],
  thanks: ['Thanks.', 'slt'],
};
// Silence off both ends: reversed, so the same filter trims the end.
const TRIM = 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse';
const dir = mkdtempSync(join(tmpdir(), 'annai-voice-'));
try {
  for (const [name, [text, voice]] of Object.entries(CLIPS)) {
    const textFile = join(dir, `${name}.txt`);
    writeFileSync(textFile, text);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `flite=textfile=${textFile}:voice=${voice}`,
      '-af', TRIM, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', join(out, `${name}.wav`)]);
    console.log(`test/fixtures/voice/${name}.wav: "${text}"`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
