# Milestone 3a: Voice Parts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** annai can speak and hear, before Shiori uses either. This plan builds the parts milestone 3's other two plans put together:
- **Speaking** (spec §10.1): text that streams in is cut into sentences; each goes to the first working entry of the speech-out list; the next sentence's audio is fetched while one plays; a voice that fails is benched and the same sentence replays on the next one; the point where the user cut her off is kept, by sentence and elapsed fraction, or by word with the browser voice.
- **Hearing** (§10.2): the microphone through an `AudioWorklet`, and the end-of-sentence detector that cuts what it hears into segments, tested on speech fixtures.
- **Speech providers** (§9.1, §10, §20 row 3): speech endpoint types in the core, and the official `speech-openai` plugin: OpenAI-compatible transcription and voices (OpenAI, Groq, local servers). Templates, costs, the trace.
- **Speech roles** (§9.6): speech-in and speech-out lists on the Models screen, with their stand-in entries ("Send audio to the model", "Phone dictation", "Browser voice").
- **Settings → Voice**, first part: the browser voice, "Test the voice", "Test the microphone".

**Milestone 3 is three plans:**
- **3a (this plan): voice parts.** Done when the parts above work and are tested.
- **3b: Shiori talks and listens.** `speak` streams aloud and then listens; listening sessions (recording and phone dictation); speech-in list resolution per model attempt; heard segments, their text versions and voice clips; turn-taking, interruptions and the quick-decision gate (§10.2–10.4).
- **3c: Voice modes and the car.** Auto / On / Off (§10.5), the voice chip, the voice layout of the dock, "Show what she's saying", the end-to-end test of a spoken back-and-forth with a fake microphone in both browsers, and the device checklist.

**Architecture:**
- **Pure core modules** in `src/core/voice/`, unit-tested in Node:
  - `sentences.js`: streaming sentence cutting with `Intl.Segmenter`.
  - `pcm.js`: WAV in and out, resampling, filters.
  - `detector.js`: the end-of-sentence detector.
  - `recorder.js`: the microphone through the detector, as segments.
  - `speaker.js`: the speech-out list, sentence by sentence, with prefetch, fallback and the cut-off point.
  - `voice.js`: the `Voice` service the UI (and in 3b, Shiori) uses.
  - `platform.js` (types) and `settings.js` (Settings → Voice with defaults).
- **Speech endpoint types** are endpoint types with `speech: 'in'` or `speech: 'out'` (§9.1: "Search and speech providers work the same way"). `src/core/llm/speech.js` sends their requests, traces them and prices them.
- **The device side** is the built-in plugin `src/plugins/voice-browser/` (§19 names it): one audio player, the browser voice, the microphone (`capture-worklet.js`), dictation, and the audio session type. The core reaches it through the registry (`voice-platform`), so tests give it fakes.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26), and Playwright 1.63.0 (Chromium as Pixel 7, WebKit as iPhone 15, WebKit in Docker).
- Dev-only: `ffmpeg` with libflite makes the speech fixtures, once (`scripts/make-voice-fixtures.mjs`); the fixtures are committed.

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`. Milestone 3 is §20 row 3. This plan covers §9.1 (speech providers), §9.6 (the speech roles), §10.1 (speaking), §10.2 (the record side of listening), §16.3 (the glow follows the audio level), §17 rule 3 (denied permissions), §18 (the detector on PCM fixtures; a fake microphone in the browser suites).

**Not in this plan (3b and 3c have them):**
- Shiori's use of any of it: `speak` and `wait` with voice on, listening sessions, resolution against the model receiving the speech, the gate, voice modes.
- "Keep voice clips", heard segments in the log, their text versions.

## Choices this plan makes (please check them)

1. **A speech provider is an endpoint type with one direction.** The `speech-openai` plugin brings two types: "OpenAI-compatible transcription" (`/audio/transcriptions`) and "OpenAI-compatible voice" (`/audio/speech`). They cover OpenAI, Groq and local servers (Speaches, whisper.cpp's server, Kokoro). Using OpenAI for both means two endpoints, each with the key.
   - *The alternative:* one endpoint per provider for chat, transcription and voice, with a kind on each model. One key, but every model screen and role list would need to know the kind. *Cost if wrong:* entering a key twice.
2. **No ElevenLabs (or other) plugin in milestone 3.** §20 adds more speech providers "as needed"; OpenAI-compatible covers the first trip. *Cost if wrong:* a plugin of about 100 lines, later.
3. **Speech lists sit with the other roles on the Models screen,** as in the mockup ("Models and voices"). The stand-ins ("Send audio to the model", "Phone dictation", "Browser voice") are list items: they can be moved, removed and added back. A template's transcription model goes after "Send audio to the model"; its voice goes ahead of "Browser voice".
4. **Speech costs:** transcription per minute of audio (Groq bills at least 10 seconds), voices per million characters. OpenAI prices `gpt-4o-mini-tts` by audio tokens; its template uses OpenAI's own estimate of $0.015 a minute, as $18 per million characters. Speech costs count in "today's spend" and the trip's cost, like model calls.
5. **Voice clips play through one HTML audio element, not through Web Audio.** The glow follows the clip's loudness, read from the decoded clip (Web Audio's decoder) at the playing position. Routing playback through Web Audio on iPhone risks the silent switch and Bluetooth routing. The browser voice gives no audio to measure, so its glow pulses with each word.
6. **The detector's numbers:** the speech band is 300–3400 Hz, in 20 ms frames. Speech starts when 3 of 4 frames are 10 dB over the noise floor, and goes on while frames stay 6 dB over it. The floor falls fast and rises over about 4 s. A sound that stays steady for a second (an engine, a fan, a window opened) becomes the new floor. Each segment keeps 300 ms before the speech and 200 ms after it. It needs at least 250 ms of speech, and is cut at 30 s. Segments are sent as 16 kHz, 16-bit mono WAV (32 KB a second).
7. **The fixtures are synthetic speech** (flite, through ffmpeg), not human recordings; car-like noise and pauses are added in the tests. Real voices are on the device checklist.
8. **Time limits:** a voice's clip must arrive within 10 s and a transcription within 15 s. Each speech role's "wait" field changes it. A failing voice isn't retried, since the user is waiting; the next voice takes the sentence.
9. **A sentence longer than 220 characters with no end in sight is spoken up to its last comma,** so speaking starts sooner.
10. **The size budget** goes from 740 KiB to 820 KiB in Task 1, for all of milestone 3.

## Global Constraints

- All of milestone 2b's Global Constraints hold (`docs/superpowers/plans/2026-10-16-m2b-shiori.md`). In particular:
  - Model output never goes into `innerHTML`, and no `style` attribute is set in markup (a CSS variable set through `el.style.setProperty`, as the avatar does, is allowed).
  - Every write is one transaction; everything stored is named by a file or a log entry's refs (§4.9).
  - Every file under `src/` and `assets/` is listed in `sw.js` `SHELL` (a unit test checks this). Run `npm run stamp` after any shipped file changes, and `npm run catalog` after `plugins-official/` changes.
  - The dev server and Playwright use port 8790; WebKit runs in Docker.
- **"Keys live only in `secrets`. They're never in context and are redacted from the trace" (§9.9).** Speech requests carry keys too.
- **"Every request the agent sends and everything it reads is traceable" (§2).** Every speech request is a `net.request` in the trace, with its cost.
- **"Audio leaves the phone only when speech was detected, and only to the configured speech-in entry" (§10.2).** Nothing in this plan sends audio anywhere except "Test the microphone" and a transcription model's own Test, both on the user's tap, to the entry they name.
- **"The detector only cuts audio; it never decides to stop listening" (§10.2).**
- **"Playback goes through one audio player, unlocked by the first tap of each session (an iOS rule)" (§10.1).**
- **CSP is `'self'`:** the AudioWorklet module is a same-origin file under `src/`.
- **Copy:** plain words; every error says what happened and what to do next; denied permissions get iPhone- or Android-specific steps (§17 rule 3).
- **Commit:** `npm run stamp && npm run check` must pass before every commit, chained with `&&`. Messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB
  ```
- **Work in the worktree** `.claude/worktrees/m3-voice`, branch `m3-voice`. Never touch the main checkout (it serves the phones on port 8792).

## Verified facts (checked 2026-10-16)

- **Browser access:** `api.openai.com`, `api.groq.com` and `api.elevenlabs.io` answer a CORS preflight from `https://annai.guide` for `POST` with `authorization` and `content-type`.
- **OpenAI `/v1/audio/transcriptions`:** multipart `file` and `model`; optional `prompt`, `response_format` (`json` gives `{ text }`), and `language` (or `languages` for `gpt-transcribe`; not both). Files up to 25 MB, in mp3, mp4, mpeg, mpga, m4a, wav or webm. Models: `gpt-transcribe` (recommended, about $0.0045 a minute), `gpt-4o-mini-transcribe` ($0.003), `gpt-4o-transcribe` ($0.006), `whisper-1` ($0.006).
- **OpenAI `/v1/audio/speech`:** JSON `model`, `input`, `voice`, optional `instructions` and `response_format` (mp3 by default; opus, aac, flac, wav, pcm). The reply is the audio itself. Models: `gpt-4o-mini-tts` ($0.60 per million text tokens in, $12 per million audio tokens out), `tts-1` ($15 per million characters), `tts-1-hd` ($30). Voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar (OpenAI recommends marin or cedar); `tts-1` takes only alloy, ash, coral, echo, fable, onyx, nova, sage and shimmer.
- **Groq `https://api.groq.com/openai/v1/audio/transcriptions`:** `whisper-large-v3-turbo` ($0.04 an hour), `whisper-large-v3` ($0.111 an hour). Each request is billed at least 10 seconds. Formats include wav; 25 MB on the free tier.
- **Gemini's and OpenRouter's chat endpoints take audio as `{ "type": "input_audio", "input_audio": { "data": base64, "format": "wav" } }`** (used in 3b). Neither has an `/audio/speech` endpoint.
- **`navigator.audioSession`** exists only in Safari. On iOS, `"transient"` uses the ambient category: the silent switch mutes it, and it mixes with other audio rather than ducking it (WebKit bug 264473, closed as behaving as designed). 3b and the device checklist deal with this.
- **Headless browsers (Playwright 1.63):** both Chromium and WebKit in Docker run an `AudioContext`, play a `MediaStreamAudioDestinationNode`'s stream into `createMediaStreamSource` and an `AudioWorkletNode`, decode WAV with `decodeAudioData`, and play WAV through an `<audio>` element to its end. WebKit has 4 speech-synthesis voices and no `SpeechRecognition`; Chromium has `webkitSpeechRecognition` and no voices.
- **ffmpeg 7.1 here has libflite** (voices `slt` and `kal`).

## Review Focus

1. **A voice that fails halfway through an answer.** The same sentence plays on the next voice; the sentences after it don't go back to the failed voice while it rests; nothing is said twice or skipped. Pinned in Task 5.
2. **The user cuts her off while a clip is still downloading, or between sentences.** `done` settles at once, with what she had actually said; nothing more plays; no fetch is left running. Pinned in Task 5.
3. **Steady noise that isn't speech:** an engine, road noise, a window opened partway through, a click. No segment, or one that is thrown away; speech over road noise is still found. Pinned in Task 2.
4. **A key in a speech request** (header or URL) never reaches the trace, including when the provider echoes it in an error. Pinned in Task 3.
5. **No voice works, or the page may not play sound yet** (iPhone before the first tap): the speaker says so instead of hanging, and blocked playback doesn't bench a voice that did nothing wrong. Pinned in Task 5.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/voice/sentences.js` | 1 | `Sentences`: streaming text → complete sentences |
| `scripts/size.mjs` | 1 | the budget, 820 KiB |
| `src/core/voice/pcm.js` | 2 | `encodeWav`, `decodeWav`, `wavSeconds`, `resample`, `biquad`, `SEND_RATE` |
| `src/core/voice/detector.js` | 2 | `Detector`: PCM → speech / segment / discard |
| `scripts/make-voice-fixtures.mjs`, `test/fixtures/voice/*.wav` | 2 | speech clips for the tests |
| `src/core/llm/contract.js`, `src/core/plugins.js` | 3 | speech endpoint types: their typedefs and registration |
| `src/core/llm/speech.js` | 3 | `speechCall`: one transcription or voice clip, traced and priced |
| `src/core/llm/call.js` | 3 | exports `cannotConnect`, `asProviderError` |
| `src/core/llm/cost.js`, `src/core/agent/budgets.js` | 3 | `speechCost`; speech costs count in spend |
| `src/core/llm/config.js` | 3 | speech roles, stand-ins, `speechKind` |
| `src/core/llm/service.js` | 3 | `llm.transcribe`, `llm.synthesize` |
| `plugins-official/speech-openai/` | 4 | the two OpenAI-compatible speech types |
| `catalog/templates.json`, `catalog/plugins.json`, `src/core/llm/templates.js` | 4 | speech templates; `withSpeech` puts a template's speech models in the lists |
| `src/core/voice/platform.js`, `src/core/voice/speaker.js` | 5 | the device interface; `Speaker`, `Utterance`, `speechOutEntries` |
| `src/core/voice/settings.js`, `src/core/voice/voice.js`, `src/core/voice/recorder.js` | 6 | `voiceSettings`; the `Voice` service; `record` |
| `src/plugins/voice-browser/index.js`, `capture-worklet.js` | 6 | the device side |
| `src/app/main.js` | 6 | the plugin, the `Voice`, unlocking audio on the first tap |
| `test/browser/suites/voice.js`, `test/e2e/browser-suites.spec.js` | 6 | the device side in real browsers |
| `src/ui/screens/models.js`, `endpoint.js`, `model.js`, `src/ui/speech-check.js` | 7 | speech lists; speech models and their Test |
| `src/ui/screens/voice.js`, `src/ui/mic-help.js`, `src/ui/router.js`, `src/ui/shell.js`, `src/ui/screens/settings.js` | 8 | Settings → Voice |
| `test/e2e/helpers.js`, `test/e2e/voice-parts.spec.js` | 7, 8 | a fake microphone; the screens in both browsers |

---
### Task 1: Sentences as they stream in

**Files:**
- Create: `src/core/voice/sentences.js`
- Modify: `scripts/size.mjs` (the budget), `sw.js` (`SHELL`)
- Test: `test/unit/voice-sentences.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LONG = 220`
  - `class Sentences { constructor(locale?: string); take(text: string, final?: boolean): string[] }`. `text` is all the text so far; `take` returns the sentences complete in it that it hasn't returned before, trimmed. With `final`, the rest is complete too.

- [ ] **Step 1: Write the failing test**

`test/unit/voice-sentences.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sentences, LONG } from '../../src/core/voice/sentences.js';

test('sentences come out as soon as they are complete, while the text streams in (spec §10.1)', () => {
  const s = new Sentences('en');
  const all = 'Bixby Bridge is two miles ahead. When it opened in 1932, it was tall! Want a stop?';
  assert.deepEqual(s.take('Bixby Bridge is two mi'), []);
  assert.deepEqual(s.take('Bixby Bridge is two miles ahead. When it op'), ['Bixby Bridge is two miles ahead.']);
  assert.deepEqual(s.take(all), ['When it opened in 1932, it was tall!']);
  assert.deepEqual(s.take(all), []);
  assert.deepEqual(s.take(all, true), ['Want a stop?']);
  assert.deepEqual(s.take(all, true), []);
});

test('numbers stay inside their sentence; other scripts work', () => {
  assert.deepEqual(new Sentences('en').take('It is 2.5 miles to the café. Then 12 more.', true), ['It is 2.5 miles to the café.', 'Then 12 more.']);
  assert.deepEqual(new Sentences('ja').take('橋はもうすぐです。写真を撮りますか？', true), ['橋はもうすぐです。', '写真を撮りますか？']);
});

test('a long run with no end in sight is spoken up to its last comma, so speaking starts sooner', () => {
  const long = `The road follows the cliffs past the lighthouse, ${'the cannery and the pier, '.repeat(8)}and on`;
  assert.ok(long.length > LONG);
  const s = new Sentences('en');
  const [first, ...more] = s.take(long);
  assert.deepEqual(more, []);
  assert.ok(first.endsWith(','));
  assert.ok(first.length <= LONG + 1);
  assert.deepEqual(s.take(`${long} to Carmel.`, true), [`${long.slice(first.length).trim()} to Carmel.`]);
});

test('blank text gives nothing; a locale the platform does not know falls back', () => {
  assert.deepEqual(new Sentences('en').take('   ', true), []);
  assert.deepEqual(new Sentences('not a locale!').take('Hi. There.', true), ['Hi.', 'There.']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/voice-sentences.test.js`
Expected: FAIL with `Cannot find module '…/src/core/voice/sentences.js'`

- [ ] **Step 3: Write minimal implementation**

`src/core/voice/sentences.js`:

```js
/**
 * Sentences as they stream in (spec §10.1). The text of speak arrives a piece at a time, read from
 * the tool call's half-finished arguments; Intl.Segmenter finds where sentences end. Every segment
 * but the last is complete, and the last one is complete once the text is. A last segment longer
 * than LONG with no end in sight is cut after its last comma, so speaking can start sooner.
 */
export const LONG = 220;

export class Sentences {
  /** @type {Intl.Segmenter} */
  #segmenter;
  /** How much of the text has been handed out. */
  #taken = 0;

  /** @param {string} [locale] */
  constructor(locale) {
    try {
      this.#segmenter = new Intl.Segmenter(locale || undefined, { granularity: 'sentence' });
    } catch {
      this.#segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    }
  }

  /**
   * The sentences complete in the text so far that weren't handed out yet.
   * @param {string} text all of the text so far @param {boolean} [final] the text is complete
   * @returns {string[]}
   */
  take(text, final = false) {
    const rest = String(text ?? '').slice(this.#taken);
    const parts = [...this.#segmenter.segment(rest)].map((s) => s.segment);
    /** @type {string[]} */
    const out = [];
    const complete = final ? parts.length : parts.length - 1;
    for (let i = 0; i < complete; i++) {
      this.#taken += parts[i].length;
      if (parts[i].trim()) out.push(parts[i].trim());
    }
    const last = final ? '' : parts.at(-1) ?? '';
    if (last.length > LONG) {
      const cut = Math.max(last.lastIndexOf(', ', LONG), last.lastIndexOf('; ', LONG));
      if (cut > 40) {
        this.#taken += cut + 1;
        out.push(last.slice(0, cut + 1).trim());
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/voice-sentences.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Raise the size budget and list the file in the shell**

In `scripts/size.mjs`, replace the budget line with:

```js
const BUDGET = 820 * 1024; // bytes, uncompressed; raised from 740 KiB for milestone 3 (voice)
```

In `sw.js`, add `'/src/core/voice/sentences.js',` to `SHELL` after `'/src/core/tsv.js',` (keep the list's existing order: it goes with the other `src/core/` files).

- [ ] **Step 6: Commit**

```bash
npm run stamp && npm run check && git add src/core/voice/sentences.js test/unit/voice-sentences.test.js scripts/size.mjs sw.js && git commit -m "Sentences as they stream in: what Shiori says is cut where sentences end (spec §10.1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 2: PCM, the speech fixtures, and the end-of-sentence detector

**Files:**
- Create: `src/core/voice/pcm.js`, `src/core/voice/detector.js`, `scripts/make-voice-fixtures.mjs`, `test/fixtures/voice/where-lunch.wav`, `test/fixtures/voice/gas-station.wav`, `test/fixtures/voice/where-eat.wav`, `test/fixtures/voice/first-one.wav`, `test/unit/voice-kit.js`
- Modify: `sw.js` (`SHELL`), `scripts/serve.mjs` (`.wav` type)
- Test: `test/unit/voice-pcm.test.js`, `test/unit/voice-detector.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pcm.js`: `SEND_RATE = 16000`; `encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array` (16-bit mono); `decodeWav(bytes: Uint8Array): { sampleRate: number, pcm: Float32Array }` (the first channel; only 16-bit PCM); `wavSeconds(bytes: Uint8Array): number`; `resample(pcm: Float32Array, from: number, to: number): Float32Array`; `biquad(kind: 'lowpass' | 'highpass', f0: number, fs: number, q?: number): (x: number) => number`.
  - `detector.js`: `FRAME_MS = 20`; `class Detector { constructor({ sampleRate, pauseMs = 700, startDb = 10, keepDb = 6, prerollMs = 300, tailMs = 200, minSpeechMs = 250, maxMs = 30000 }); readonly sampleRate: number; level: number /* 0..1 */; get speaking(): boolean; push(pcm: Float32Array): DetectorEvent[]; end(): DetectorEvent[] }` with `DetectorEvent = { type: 'speech' } | { type: 'segment', pcm: Float32Array, sampleRate: number, ms: number } | { type: 'discard' }`.
  - `test/unit/voice-kit.js` (tests only): `RATE = 16000`, `clip(name): Promise<Float32Array>`, `quiet(seconds, amp?)`, `brown(seconds, amp, seed?)`, `burst(seconds, amp)`, `cat(...parts)`, `mix(a, b)`, `detect(pcm, opts?): DetectorEvent[]`, `segments(events): number[]` (the ms of each segment).

- [ ] **Step 1: Make the speech fixtures**

`scripts/make-voice-fixtures.mjs`:

```js
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
```

Run: `mkdir -p test/fixtures/voice && node scripts/make-voice-fixtures.mjs && ls -la test/fixtures/voice`
Expected: four `.wav` files, each 40–70 KB.

- [ ] **Step 2: Write the failing tests**

`test/unit/voice-kit.js`:

```js
import { readFile } from 'node:fs/promises';
import { decodeWav } from '../../src/core/voice/pcm.js';
import { Detector } from '../../src/core/voice/detector.js';

/**
 * Sound for the voice tests: the speech fixtures (16 kHz), pauses with a faint hiss, and brown
 * noise like a car's, all from a seeded generator so every run hears the same thing.
 */
export const RATE = 16_000;

/** @param {string} name a clip in test/fixtures/voice/ */
export async function clip(name) {
  return decodeWav(new Uint8Array(await readFile(new URL(`../fixtures/voice/${name}.wav`, import.meta.url)))).pcm;
}

/** @param {number} seed */
function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
}

/** A pause: a faint hiss, as a real microphone never gives true silence. @param {number} seconds @param {number} [amp] */
export function quiet(seconds, amp = 0.0005) {
  const r = random(11);
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => r() * amp);
}

/** A short loud noise: a click, a door. @param {number} seconds @param {number} amp */
export function burst(seconds, amp) {
  const r = random(5);
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => r() * amp);
}

/** Brown noise, the rumble of a car. @param {number} seconds @param {number} amp @param {number} [seed] */
export function brown(seconds, amp, seed = 7) {
  const r = random(seed);
  let last = 0;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    last = (last + 0.02 * r()) / 1.02;
    return last * amp * 3.5;
  });
}

/** @param {...Float32Array} parts */
export function cat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** a with b added, sample by sample. @param {Float32Array} a @param {Float32Array} b */
export const mix = (a, b) => a.map((x, i) => x + (b[i] ?? 0));

/** Runs the detector over pcm in chunks, as a microphone would give it, then ends. @param {Float32Array} pcm @param {Record<string, number>} [opts] */
export function detect(pcm, opts = {}) {
  const d = new Detector({ sampleRate: RATE, ...opts });
  const events = [];
  for (let i = 0; i < pcm.length; i += 2048) events.push(...d.push(pcm.subarray(i, i + 2048)));
  return events;
}

/** The length of each segment, in ms. @param {import('../../src/core/voice/detector.js').DetectorEvent[]} events */
export const segments = (events) => events.flatMap((e) => (e.type === 'segment' ? [e.ms] : []));
```

`test/unit/voice-pcm.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, decodeWav, wavSeconds, resample, SEND_RATE } from '../../src/core/voice/pcm.js';
import { clip, RATE } from './voice-kit.js';

test('WAV round-trips as 16-bit mono, and says how long it is', () => {
  const pcm = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 5) * 0.5);
  const bytes = encodeWav(pcm, 16000);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
  assert.equal(bytes.length, 44 + 3200);
  const back = decodeWav(bytes);
  assert.equal(back.sampleRate, 16000);
  assert.ok(back.pcm.every((x, i) => Math.abs(x - pcm[i]) < 1e-4));
  assert.equal(wavSeconds(bytes), 0.1);
  assert.equal(encodeWav(Float32Array.of(2, -2), 8000).length, 48); // out-of-range samples are clipped, not wrapped
  assert.deepEqual([...decodeWav(encodeWav(Float32Array.of(2, -2), 8000)).pcm].map((x) => Math.round(x)), [1, -1]);
});

test('the speech fixtures are 16 kHz WAV files a second or two long', async () => {
  for (const name of ['where-lunch', 'gas-station', 'where-eat', 'first-one']) {
    const pcm = await clip(name);
    assert.ok(pcm.length > RATE * 0.8 && pcm.length < RATE * 3, `${name}: ${pcm.length / RATE} s`);
  }
});

test('resampling keeps the length in time and the tone', () => {
  const tone = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
  const down = resample(tone, 48000, SEND_RATE);
  assert.equal(down.length, 16000);
  const crossings = down.reduce((n, x, i) => n + (i && Math.sign(x) !== Math.sign(down[i - 1]) ? 1 : 0), 0);
  assert.ok(Math.abs(crossings - 880) < 10, `${crossings} zero crossings`);
  assert.equal(resample(tone, 48000, 48000), tone);
  assert.equal(resample(down, 16000, 48000).length, 48000);
});

test('a file that is not a 16-bit WAV is refused in plain words', () => {
  assert.throws(() => decodeWav(new TextEncoder().encode('not a wav file at all, really')), /not a WAV file/);
  const float = encodeWav(Float32Array.of(0.1), 8000);
  new DataView(float.buffer).setUint16(34, 32, true);
  assert.throws(() => decodeWav(float), /16-bit/);
});
```

`test/unit/voice-detector.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Detector } from '../../src/core/voice/detector.js';
import { clip, quiet, brown, burst, cat, mix, detect, segments, RATE } from './voice-kit.js';

const lunch = await clip('where-lunch');
const gas = await clip('gas-station');
const ms = (/** @type {Float32Array} */ pcm) => (pcm.length / RATE) * 1000;

test('one sentence becomes one segment: the speech, with a little before and after (spec §10.2)', () => {
  const events = detect(cat(quiet(0.6), lunch, quiet(1)));
  assert.deepEqual(events.map((e) => e.type), ['speech', 'segment']);
  const [len] = segments(events);
  assert.ok(len >= ms(lunch) && len <= ms(lunch) + 500, `${len} ms for ${ms(lunch)} ms of speech`);
});

test('a pause of about 700 ms ends a segment; a short one does not', () => {
  assert.equal(segments(detect(cat(quiet(0.5), lunch, quiet(1.2), gas, quiet(1)))).length, 2);
  assert.equal(segments(detect(cat(quiet(0.5), lunch, quiet(0.35), gas, quiet(1)))).length, 1);
});

test('the pause is tunable', () => {
  assert.equal(segments(detect(cat(quiet(0.5), lunch, quiet(1.2), gas, quiet(2)), { pauseMs: 1500 })).length, 1);
});

test('speech over road noise is still found; the noise alone is not speech', () => {
  const speech = cat(quiet(2, 0), lunch, quiet(1.2, 0), gas, quiet(1.5, 0));
  // About 6 dB of speech over the noise: a loud car.
  assert.equal(segments(detect(mix(speech, brown(speech.length / RATE, 0.5)))).length, 2);
  assert.deepEqual(detect(brown(6, 0.5)), []);
});

test('steady noise that starts suddenly (a window opened) is learned as the new floor, not taken for speech', () => {
  const events = detect(cat(brown(3, 0.03), brown(4, 0.4, 9)));
  assert.equal(segments(events).length, 0);
});

test('a click is too short to be speech', () => {
  const events = detect(cat(quiet(1), burst(0.12, 0.8), quiet(1.5)));
  assert.equal(segments(events).length, 0);
  assert.deepEqual(events.map((e) => e.type), ['speech', 'discard']);
});

test('48 kHz works the same', () => {
  const pcm = cat(quiet(0.6), lunch, quiet(1));
  const up = Float32Array.from({ length: pcm.length * 3 }, (_, i) => pcm[Math.floor(i / 3)]);
  const d = new Detector({ sampleRate: 48_000 });
  const events = [];
  for (let i = 0; i < up.length; i += 4096) events.push(...d.push(up.subarray(i, i + 4096)));
  assert.equal(segments(events).length, 1);
  assert.equal(/** @type {any} */ (events.find((e) => e.type === 'segment')).sampleRate, 48_000);
});

test('the level rises while someone speaks; end() keeps speech that was still going', () => {
  const d = new Detector({ sampleRate: RATE });
  d.push(quiet(0.5));
  assert.ok(d.level < 0.2);
  d.push(lunch.subarray(0, RATE));
  assert.equal(d.speaking, true);
  assert.ok(d.level > 0.2, `level ${d.level}`);
  assert.deepEqual(d.end().map((e) => e.type), ['segment']);
  assert.equal(d.speaking, false);
  assert.deepEqual(new Detector({ sampleRate: RATE }).end(), []);
});

test('speech that never pauses is cut into pieces no longer than maxMs; it never stops listening', () => {
  const run = cat(...Array.from({ length: 8 }, () => cat(lunch, quiet(0.2), gas, quiet(0.2))));
  const lens = segments(detect(cat(quiet(0.5), run, quiet(1)), { maxMs: 8000 }));
  assert.ok(lens.length >= 3, `${lens.length} segments`);
  assert.ok(lens.every((l) => l <= 8000), lens.join(', '));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/unit/voice-pcm.test.js test/unit/voice-detector.test.js`
Expected: FAIL with `Cannot find module '…/src/core/voice/pcm.js'`

- [ ] **Step 4: Write the implementation**

`src/core/voice/pcm.js`:

```js
/**
 * PCM audio (spec §10.2): WAV files in and out (16-bit, mono), resampling, and the small filters
 * the end-of-sentence detector uses. Segments go to speech-in entries as 16 kHz WAV.
 */
export const SEND_RATE = 16_000;

/** @param {Uint8Array} b @param {number} at @param {string} s */
const tag = (b, at, s) => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i); };
/** @param {Uint8Array} b @param {number} at */
const tagAt = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** A 16-bit mono WAV file. Samples outside -1..1 are clipped. @param {Float32Array} pcm @param {number} sampleRate @returns {Uint8Array} */
export function encodeWav(pcm, sampleRate) {
  const out = new Uint8Array(44 + pcm.length * 2);
  const dv = new DataView(out.buffer);
  tag(out, 0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length * 2, true);
  tag(out, 8, 'WAVE');
  tag(out, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  tag(out, 36, 'data');
  dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return out;
}

/** The format chunk and where the samples are. @param {Uint8Array} bytes */
function chunks(bytes) {
  if (bytes.length < 12 || tagAt(bytes, 0) !== 'RIFF' || tagAt(bytes, 8) !== 'WAVE') throw new Error('This is not a WAV file.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @type {{ format: number, channels: number, sampleRate: number, bits: number } | null} */
  let fmt = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = tagAt(bytes, at);
    const size = dv.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error('Only 16-bit PCM WAV files can be read.');
      return { dv, fmt, body, size: Math.min(size, bytes.length - body) };
    }
    at = body + size + (size % 2);
  }
  throw new Error('This WAV file has no sound in it.');
}

/** The first channel of a 16-bit PCM WAV file. @param {Uint8Array} bytes @returns {{ sampleRate: number, pcm: Float32Array }} */
export function decodeWav(bytes) {
  const { dv, fmt, body, size } = chunks(bytes);
  const n = Math.floor(size / 2 / fmt.channels);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(body + i * 2 * fmt.channels, true) / 0x8000;
  return { sampleRate: fmt.sampleRate, pcm };
}

/** How long a WAV file plays, in seconds. @param {Uint8Array} bytes */
export function wavSeconds(bytes) {
  const { fmt, size } = chunks(bytes);
  return size / 2 / fmt.channels / fmt.sampleRate;
}

/**
 * The same sound at another sample rate: filtered first when going down, so nothing folds back,
 * then read between samples. @param {Float32Array} pcm @param {number} from @param {number} to
 */
export function resample(pcm, from, to) {
  if (from === to) return pcm;
  let src = pcm;
  if (to < from) {
    const a = biquad('lowpass', to * 0.45, from);
    const b = biquad('lowpass', to * 0.45, from);
    src = pcm.map((x) => b(a(x)));
  }
  const n = Math.floor((src.length * to) / from);
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = (src[j] ?? 0) * (1 - f) + (src[j + 1] ?? src[j] ?? 0) * f;
  }
  return out;
}

/**
 * A two-pole filter (the RBJ cookbook's), as a function of one sample that keeps its state.
 * @param {'lowpass' | 'highpass'} kind @param {number} f0 corner frequency @param {number} fs sample rate @param {number} [q]
 * @returns {(x: number) => number}
 */
export function biquad(kind, f0, fs, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const [b0, b1, b2] = kind === 'lowpass' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  const c = [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}
```

`src/core/voice/detector.js`:

```js
import { biquad } from './pcm.js';

/**
 * The end-of-sentence detector (spec §10.2). It measures energy in the speech band against a
 * background-noise floor that keeps adapting; speech followed by a pause (700 ms by default,
 * tunable) becomes a segment. It only cuts audio: it never decides to stop listening.
 *
 * Frames are 20 ms. Speech starts when 3 of 4 frames are startDb over the floor, and goes on while
 * frames stay keepDb over it. The floor falls fast and rises slowly. When the sound stays steady for
 * a second (an engine, a fan, a window opened) it becomes the new floor: speech rises and falls with
 * every syllable, steady noise doesn't. A segment keeps a little before the speech and after it; one
 * with too little speech in it (a click, a door) is thrown away.
 * @typedef {{ type: 'speech' } | { type: 'segment', pcm: Float32Array, sampleRate: number, ms: number } | { type: 'discard' }} DetectorEvent
 */

export const FRAME_MS = 20;
const STEADY_FRAMES = 50; // one second
const STEADY_DB = 3;
const FLOOR_MIN_DB = -60;

/** @param {number[]} xs */
function spread(xs) {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return { mean, std: Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length) };
}

export class Detector {
  /** How loud the sound is over the floor, 0..1, for the glow (spec §16.3). */
  level = 0;
  /** @type {number | null} dB */
  #floor = null;
  #hp;
  #lp;
  #frame;
  #cur;
  #n = 0;
  #energy = 0;
  /** Frames heard while waiting for speech, for the bit before it. @type {Float32Array[]} */
  #before = [];
  /** @type {boolean[]} */
  #recent = [];
  /** @type {{ frames: Float32Array[], dbs: number[], speech: number, quiet: number } | null} */
  #seg = null;

  /**
   * @param {{ sampleRate: number, pauseMs?: number, startDb?: number, keepDb?: number, prerollMs?: number, tailMs?: number,
   *   minSpeechMs?: number, maxMs?: number }} o
   */
  constructor({ sampleRate, pauseMs = 700, startDb = 10, keepDb = 6, prerollMs = 300, tailMs = 200, minSpeechMs = 250, maxMs = 30_000 }) {
    this.sampleRate = sampleRate;
    this.startDb = startDb;
    this.keepDb = keepDb;
    const frames = (/** @type {number} */ msOf) => Math.max(1, Math.round(msOf / FRAME_MS));
    this.pauseFrames = frames(pauseMs);
    this.preroll = frames(prerollMs);
    this.tail = frames(tailMs);
    this.minSpeech = frames(minSpeechMs);
    this.maxFrames = frames(maxMs);
    this.#frame = Math.round((sampleRate * FRAME_MS) / 1000);
    this.#cur = new Float32Array(this.#frame);
    this.#hp = biquad('highpass', 300, sampleRate);
    this.#lp = biquad('lowpass', 3400, sampleRate);
  }

  /** Whether speech is going on now. */
  get speaking() {
    return this.#seg !== null;
  }

  /** @param {Float32Array} pcm @returns {DetectorEvent[]} */
  push(pcm) {
    /** @type {DetectorEvent[]} */
    const events = [];
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i];
      this.#cur[this.#n++] = x;
      const y = this.#lp(this.#hp(x));
      this.#energy += y * y;
      if (this.#n === this.#frame) {
        const raw = this.#cur;
        const db = 10 * Math.log10(this.#energy / this.#frame + 1e-12);
        this.#cur = new Float32Array(this.#frame);
        this.#n = 0;
        this.#energy = 0;
        this.#step(raw, db, events);
      }
    }
    return events;
  }

  /** The microphone is closing: speech still going on becomes a segment, if there is enough of it. @returns {DetectorEvent[]} */
  end() {
    /** @type {DetectorEvent[]} */
    const events = [];
    if (this.#seg) this.#finish(events);
    this.level = 0;
    return events;
  }

  /** @param {Float32Array} raw @param {number} db @param {DetectorEvent[]} events */
  #step(raw, db, events) {
    if (this.#floor === null) this.#floor = db;
    const over = db - this.#floor;
    this.level = Math.max(0, Math.min(1, over / 30));
    const s = this.#seg;
    if (!s) {
      this.#recent.push(over > this.startDb && db > FLOOR_MIN_DB);
      if (this.#recent.length > 4) this.#recent.shift();
      this.#before.push(raw);
      if (this.#before.length > this.preroll + 4) this.#before.shift();
      if (this.#recent.filter(Boolean).length >= 3) {
        this.#seg = { frames: this.#before, dbs: [], speech: 3, quiet: 0 };
        this.#before = [];
        this.#recent = [];
        events.push({ type: 'speech' });
      } else {
        this.#floor += (db - this.#floor) * (db < this.#floor ? 0.2 : 0.005);
      }
      return;
    }
    s.frames.push(raw);
    s.dbs.push(db);
    if (s.dbs.length >= STEADY_FRAMES) {
      const last = spread(s.dbs.slice(-STEADY_FRAMES));
      if (last.std < STEADY_DB) {
        // Steady sound: the new floor. With no rise and fall in the whole segment, it was never speech.
        this.#floor = last.mean - 1;
        if (spread(s.dbs).std < STEADY_DB + 1) {
          this.#seg = null;
          events.push({ type: 'discard' });
          return;
        }
      }
    }
    if (db - this.#floor > this.keepDb) {
      s.speech++;
      s.quiet = 0;
    } else {
      s.quiet++;
    }
    this.#floor += (db - this.#floor) * (db < this.#floor ? 0.2 : 0.002);
    if (s.quiet >= this.pauseFrames || s.frames.length >= this.maxFrames) this.#finish(events);
  }

  /** @param {DetectorEvent[]} events */
  #finish(events) {
    const s = /** @type {NonNullable<typeof this.#seg>} */ (this.#seg);
    this.#seg = null;
    if (s.speech < this.minSpeech) {
      events.push({ type: 'discard' });
      return;
    }
    const keep = s.frames.length - s.quiet + Math.min(s.quiet, this.tail);
    const pcm = new Float32Array(keep * this.#frame);
    for (let i = 0; i < keep; i++) pcm.set(s.frames[i], i * this.#frame);
    events.push({ type: 'segment', pcm, sampleRate: this.sampleRate, ms: Math.round((pcm.length / this.sampleRate) * 1000) });
  }
}
```

In `scripts/serve.mjs`, add `'.wav': 'audio/wav',` to `TYPES` (after `'.zip'`).

In `sw.js`, add `'/src/core/voice/detector.js',` and `'/src/core/voice/pcm.js',` to `SHELL` next to `'/src/core/voice/sentences.js',`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/voice-pcm.test.js test/unit/voice-detector.test.js`
Expected: PASS, 4 + 9 tests. If a detector test fails on a number (a segment length, the noise case), find which frames cross which threshold before changing anything; the numbers in Choices 6 are the plan's, and a change to them is a ruling.

- [ ] **Step 6: Commit**

```bash
npm run stamp && npm run check && git add src/core/voice/pcm.js src/core/voice/detector.js scripts/make-voice-fixtures.mjs scripts/serve.mjs test/fixtures/voice test/unit/voice-kit.js test/unit/voice-pcm.test.js test/unit/voice-detector.test.js sw.js && git commit -m "The end-of-sentence detector: speech against an adapting noise floor becomes segments, tested on speech fixtures (spec §10.2, §18)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 3: Speech endpoint types, speech calls, and the speech roles

**Files:**
- Create: `src/core/llm/speech.js`
- Modify: `src/core/llm/contract.js` (typedefs), `src/core/plugins.js` (`providers.register`), `src/core/llm/call.js` (export two helpers), `src/core/llm/fallback.js` (a speech type is never a chat model), `src/core/llm/trace.js` (`RequestInfo`), `src/core/llm/cost.js`, `src/core/agent/budgets.js`, `src/core/llm/config.js`, `src/core/llm/service.js`, `src/ui/format.js` (`not-chat`), `sw.js`
- Test: `test/unit/llm-speech.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `EndpointType` gains `speech?: 'in' | 'out'`, and for `'in'`: `transcribeRequest(c: SpeechSpec & { audio: { data: Uint8Array, mediaType: string } }): { url, headers, body }` and `readTranscript(res, c: SpeechSpec): Promise<{ text: string }>`; for `'out'`: `speechRequest(c: SpeechSpec & { text: string }): { url, headers, body }` and `readSpeech(res, c: SpeechSpec): Promise<{ data: Uint8Array, mediaType: string }>`. `SpeechSpec = { endpoint, model, key, tunables }`. `body` is sent as given (a string or a `FormData`).
  - `speechCall(c: { type, endpoint, model, key, audio?: { data, mediaType, seconds? }, text?: string, fetch?, signal?, timeoutMs?, trace?, registry?, now?, wake? }): Promise<{ text: string, cost, ms } | { clip: { data: Uint8Array, mediaType: string }, cost, ms }>`. Throws `ProviderError`. Writes one `net.request` with `kind: 'speech-in' | 'speech-out'`, `seconds` or `chars`, `cost`, `wake`.
  - `cost.js`: `Prices` gains `perMinute?`, `perMillionChars?`, `minSeconds?`; `speechCost(prices, { seconds?, chars? }): number | undefined`.
  - `budgets.js`: `costs()` and `spentToday()` also count `net.request` events whose `data.kind` starts with `speech-`.
  - `config.js`: `SPEECH_ROLES = ['speech-in', 'speech-out']`; `STAND_INS: Record<string, { role: string, name: string }>` with ids `send-audio`, `dictation`, `browser-voice`; `SPEECH_DEFAULTS = { 'speech-in': ['send-audio', 'dictation'], 'speech-out': ['browser-voice'] }`; `readConfig` gives both speech roles (defaults when never saved; stand-ins kept only in their own role); `speechKind(cfg, types, modelId): 'in' | 'out' | null`.
  - `llm.transcribe({ modelId, audio, scope?, signal?, wake? })` and `llm.synthesize({ modelId, text, scope?, signal?, wake? })`: `speechCall` through the model's endpoint, with the speech role's `firstOutputSeconds` (default 15 for in, 10 for out) as the time limit.
  - `call.js` exports `cannotConnect(e, signal)` and `asProviderError(e, signal, type, registry?)`.
  - `callRole` skips a model whose type is a speech type, with outcome `'not-chat'`.

- [ ] **Step 1: Write the failing test**

`test/unit/llm-speech.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { speechCall } from '../../src/core/llm/speech.js';
import { speechCost } from '../../src/core/llm/cost.js';
import { readConfig, saveEndpoint, saveRoles, newEndpoint, newModel, speechKind } from '../../src/core/llm/config.js';
import { costs, spentToday } from '../../src/core/agent/budgets.js';
import { createLlm } from '../../src/core/llm/service.js';
import { callRole, Bench } from '../../src/core/llm/fallback.js';

/** A speech type of each direction, as a plugin would register them. */
const hears = {
  type: 'test-in', name: 'Test transcription', speech: 'in', pluginId: 'test', tunables: {},
  transcribeRequest: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/hear`, headers: { authorization: `Bearer ${c.key}` }, body: JSON.stringify({ model: c.model.providerId, bytes: c.audio.data.length }) }),
  readTranscript: async (/** @type {Response} */ res) => ({ text: (await res.json()).text }),
};
const speaks = {
  type: 'test-out', name: 'Test voice', speech: 'out', pluginId: 'test', tunables: {},
  speechRequest: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/say?key=${c.key}`, headers: {}, body: JSON.stringify({ model: c.model.providerId, text: c.text }) }),
  readSpeech: async (/** @type {Response} */ res) => ({ data: new Uint8Array(await res.arrayBuffer()), mediaType: res.headers.get('content-type') ?? 'audio/mpeg' }),
};

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  return { registry, store, ws };
}
/** @param {string} type */
const endpoint = (type) => ({ id: 'ep-1', type, name: 'Speech', baseUrl: 'https://speech.test/v1', headers: {}, tunables: {}, extraBody: {} });
/** @param {any} prices @returns {any} */
const model = (prices) => ({ id: 'm-1', endpoint: 'ep-1', name: 'Ears', providerId: 'ears-1', input: ['text'], tools: true, contextWindow: null, maxOutput: null, prices, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {} });
/** @param {any} store */
const traced = async (store) => (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS, {}))).filter((/** @type {any} */ e) => e.type === 'net.request');
const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) < 1e-12;

test('a transcription: the words, traced as a speech request with its cost (spec §2, §9.9)', async () => {
  const { store } = await setup();
  /** @type {any[]} */
  const seen = [];
  const r = await speechCall({
    type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model({ perMinute: 0.006, minSeconds: 10 }), key: 'sk-hear-secret', wake: 'w-1',
    audio: { data: new Uint8Array(32000), mediaType: 'audio/wav', seconds: 1 }, trace: modelTrace(store, SYS),
    fetch: async (url, init) => { seen.push([url, init]); return Response.json({ text: '  Where should we eat? ' }); },
  });
  assert.equal(r.text, 'Where should we eat?');
  assert.equal(seen[0][0], 'https://speech.test/v1/hear');
  assert.equal(seen[0][1].method, 'POST');
  const [req] = await traced(store);
  assert.equal(req.data.kind, 'speech-in');
  assert.equal(req.data.outcome, 'ok');
  assert.equal(req.data.wake, 'w-1');
  assert.equal(req.data.seconds, 1);
  assert.ok(near(req.data.cost, 0.001), `${req.data.cost}: billed for at least 10 seconds`);
  assert.ok(!JSON.stringify(await traced(store)).includes('sk-hear-secret'));
});

test('a voice clip: its bytes and type, priced per character; a key in the address is never traced', async () => {
  const { store } = await setup();
  const r = await speechCall({
    type: /** @type {any} */ (speaks), endpoint: endpoint('test-out'), model: model({ perMillionChars: 15 }), key: 'sk-say-secret', text: 'Hello there.',
    trace: modelTrace(store, SYS), fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }),
  });
  assert.deepEqual([.../** @type {any} */ (r).clip.data], [1, 2, 3]);
  assert.equal(/** @type {any} */ (r).clip.mediaType, 'audio/mpeg');
  const [req] = await traced(store);
  assert.equal(req.data.kind, 'speech-out');
  assert.equal(req.data.chars, 12);
  assert.ok(near(req.data.cost, (12 / 1e6) * 15));
  assert.ok(!JSON.stringify(await traced(store)).includes('sk-say-secret'));
});

test('speech errors come back as the usual kinds, with an echoed key blanked out', async () => {
  const { store } = await setup();
  /** @param {any} fetch @param {any} [more] */
  const call = (fetch, more = {}) => speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(null), key: 'sk-hear-secret', audio: { data: new Uint8Array(10), mediaType: 'audio/wav' }, trace: modelTrace(store, SYS), fetch, ...more });
  await assert.rejects(call(async () => Response.json({ error: { message: 'Incorrect API key provided: sk-hear-secret' } }, { status: 401 })), (e) => e instanceof ProviderError && e.kind === 'auth');
  await assert.rejects(call(async () => { throw new TypeError('Failed to fetch'); }), (e) => e instanceof ProviderError && e.kind === 'unreachable');
  const hang = (/** @type {any} */ _url, /** @type {any} */ init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(call(hang, { timeoutMs: 20 }), (e) => e instanceof ProviderError && e.kind === 'timeout');
  assert.deepEqual((await traced(store)).map((e) => e.data.outcome), ['auth', 'unreachable', 'timeout']);
  assert.ok(!JSON.stringify(await traced(store)).includes('sk-hear-secret'));
});

test('speech prices: per minute (with a minimum), per million characters, or unknown', () => {
  assert.ok(near(/** @type {number} */ (speechCost({ perMinute: 0.006 }, { seconds: 30 })), 0.003));
  assert.ok(near(/** @type {number} */ (speechCost({ perMinute: 0.6, minSeconds: 10 }, { seconds: 2 })), 0.1));
  assert.equal(speechCost({ perMillionChars: 15 }, { chars: 1_000_000 }), 15);
  assert.equal(speechCost(null, { chars: 10 }), undefined);
  assert.equal(speechCost({ input: 1 }, { seconds: 10 }), undefined);
});

test('speech lists: the stand-ins by default, each only in its own list, and only models that exist (spec §9.6, §10.3)', async () => {
  const { ws } = await setup();
  let cfg = await readConfig(ws);
  assert.deepEqual(cfg.roles['speech-in'].models, ['send-audio', 'dictation']);
  assert.deepEqual(cfg.roles['speech-out'].models, ['browser-voice']);
  const ep = newEndpoint('test-in', { user: { name: 'Ears', baseUrl: 'https://speech.test/v1' } });
  const m = newModel(ep.id, { user: { providerId: 'ears-1' } });
  await saveEndpoint(ws, ep, [m]);
  await saveRoles(ws, { ...cfg.roles, 'speech-in': { models: ['dictation', m.id, 'browser-voice', 'm-gone'], level: 'off' }, 'speech-out': { models: [], level: 'off' } });
  cfg = await readConfig(ws);
  assert.deepEqual(cfg.roles['speech-in'].models, ['dictation', m.id]);
  assert.deepEqual(cfg.roles['speech-out'].models, [], 'a list the user emptied stays empty');
  assert.equal(speechKind(cfg, new Map([['test-in', /** @type {any} */ (hears)]]), m.id), 'in');
  assert.equal(speechKind(cfg, new Map(), m.id), null);
});

test("speech costs count in a trip's cost and in today's spend (spec §6.6)", async () => {
  const { store } = await setup();
  const trace = modelTrace(store, SYS);
  await trace.request({ kind: 'speech-out', endpoint: 'V', model: 'v', providerModel: 'v', url: 'https://v.test/', status: 200, ms: 5, firstMs: null, outcome: 'ok', usage: null, cost: 0.25, wake: 'w-9' });
  await trace.request({ endpoint: 'M', model: 'm', providerModel: 'm', url: 'https://m.test/', status: 200, ms: 5, firstMs: null, outcome: 'ok', usage: null, cost: 9 });
  const c = await costs(store, SYS);
  assert.equal(c.total, 0.25, "a chat request's cost is already in its model.turn");
  assert.equal(c.byWake.get('w-9'), 0.25);
  assert.equal(await spentToday(store, Date.now(), 'UTC'), 0.25);
});

test('the service transcribes and speaks through speech models; a chat role never calls one', async () => {
  const { registry, store, ws } = await setup();
  registry.add('test', 'endpoint-type', hears);
  registry.add('test', 'endpoint-type', speaks);
  const inEp = newEndpoint('test-in', { user: { name: 'Ears', baseUrl: 'https://ears.test' } });
  const inM = newModel(inEp.id, { user: { providerId: 'ears-1' } });
  const outEp = newEndpoint('test-out', { user: { name: 'Voice', baseUrl: 'https://voice.test' } });
  const outM = newModel(outEp.id, { user: { providerId: 'voice-1' } });
  await saveEndpoint(ws, inEp, [inM]);
  await saveEndpoint(ws, outEp, [outM]);
  const fetch = async (/** @type {any} */ url) => (String(url).startsWith('https://ears.test') ? Response.json({ text: 'yes' }) : new Response(new Uint8Array([9]), { headers: { 'content-type': 'audio/wav' } }));
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws }), fetch });
  assert.equal(/** @type {any} */ (await llm.transcribe({ modelId: inM.id, audio: { data: new Uint8Array(4), mediaType: 'audio/wav', seconds: 1 } })).text, 'yes');
  assert.deepEqual([.../** @type {any} */ (await llm.synthesize({ modelId: outM.id, text: 'Hi.' })).clip.data], [9]);
  await assert.rejects(llm.synthesize({ modelId: inM.id, text: 'Hi.' }), /isn't a voice/);
  const cfg = await readConfig(ws);
  const request = { messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: 'hi' }] }] };
  await assert.rejects(callRole({ role: 'main', request, config: { ...cfg, roles: { ...cfg.roles, main: { models: [outM.id], level: 'off' } } }, types: llm.types(), keyFor: async () => null, bench: new Bench() }),
    (e) => /** @type {any} */ (e).attempts[0].outcome === 'not-chat');
});

test('a plugin registers a speech type only with what its direction needs', async () => {
  const { registry, ws } = await setup();
  const manifest = { id: 'speechy', name: 'Speechy', version: '1.0.0', api: 1 };
  const good = { manifest, activate: (/** @type {any} */ a) => a.providers.register({ type: 'ok-out', speech: 'out', speechRequest() {}, readSpeech() {} }) };
  await new PluginHost({ registry, workspace: ws, importModule: async () => good }).addBuiltin('good');
  assert.ok(registry.list('endpoint-type').some((t) => t.type === 'ok-out'));
  const bad = { manifest: { ...manifest, id: 'speechy-bad' }, activate: (/** @type {any} */ a) => a.providers.register({ type: 'bad-in', speech: 'in', speechRequest() {} }) };
  await assert.rejects(new PluginHost({ registry, workspace: ws, importModule: async () => bad }).addBuiltin('bad'), /a speech type needs transcribeRequest\(\) and readTranscript\(\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/llm-speech.test.js`
Expected: FAIL with `Cannot find module '…/src/core/llm/speech.js'`

- [ ] **Step 3: Write the implementation**

In `src/core/llm/contract.js`, extend the `EndpointType` typedef (after the `list` property line) with:

```js
 * @property {'in' | 'out'} [speech]  a speech type (spec §9.1, §10): 'in' transcribes speech, 'out' is a voice
 * @property {(c: SpeechSpec & { audio: { data: Uint8Array, mediaType: string } }) => { url: string, headers: Record<string, string>, body: any }} [transcribeRequest]
 * @property {(res: Response, c: SpeechSpec) => Promise<{ text: string }>} [readTranscript]
 * @property {(c: SpeechSpec & { text: string }) => { url: string, headers: Record<string, string>, body: any }} [speechRequest]
 * @property {(res: Response, c: SpeechSpec) => Promise<{ data: Uint8Array, mediaType: string }>} [readSpeech]
```

and add, before the `@typedef {object} EndpointType` line:

```js
 * @typedef {{ endpoint: import('./config.js').Endpoint, model: import('./config.js').Model, key: string | null, tunables: Record<string, any> }} SpeechSpec
 *   what a speech endpoint type is given for one call; a request's body is sent as given (a string or a FormData)
```

In `src/core/plugins.js`, replace the check inside `providers.register` that throws `needs build() and read(), or run()` with:

```js
          const chat = typeof type.run === 'function' || (typeof type.build === 'function' && typeof type.read === 'function');
          const hears = type.speech === 'in' && typeof type.transcribeRequest === 'function' && typeof type.readTranscript === 'function';
          const speaks = type.speech === 'out' && typeof type.speechRequest === 'function' && typeof type.readSpeech === 'function';
          if (!chat && !hears && !speaks) {
            throw new PluginError(id, `the endpoint type "${type.type}" needs build() and read(), or run(); a speech type needs transcribeRequest() and readTranscript(), or speechRequest() and readSpeech()`);
          }
```

In `src/core/llm/call.js`, put `export` before `function cannotConnect(` and before `function asProviderError(`.

In `src/core/llm/fallback.js`, in `callRole`, replace the `skip` line with:

```js
    const skip = !rec || !epRec || !model ? 'removed' : !type ? 'type-missing' : type.speech ? 'not-chat' : bench.until(id) > now() ? 'benched' : gap(model, request);
```

In `src/ui/format.js`, add `'not-chat': "isn't a chat model",` to `OUTCOMES`.

In `src/core/llm/trace.js`, change the `RequestInfo` typedef to:

```js
 * @typedef {{ kind?: string, endpoint: string, model: string, providerModel: string, url: string, status: number, ms: number, firstMs: number | null,
 *   outcome: string, error?: string, usage: any, cost?: number, wake?: string, seconds?: number, chars?: number }} RequestInfo
 *   kind: "model" unless given ("speech-in", "speech-out"); seconds or chars: how much speech was sent
```

In `src/core/llm/cost.js`, change the `Prices` typedef to:

```js
 * @typedef {PriceSet & { tiers?: (PriceSet & { above: number })[], perMinute?: number, perMillionChars?: number, minSeconds?: number }} Prices
 *   perMinute: USD per minute of audio transcribed (at least minSeconds a request); perMillionChars: USD per million characters a voice says
```

and add at the end:

```js
/**
 * The cost of one speech call in USD (spec §9.9): a transcription by the minute of audio, a voice
 * by the character. Undefined when the model has no such price.
 * @param {Prices | null | undefined} prices @param {{ seconds?: number, chars?: number }} amount
 */
export function speechCost(prices, { seconds, chars }) {
  if (!prices) return undefined;
  if (seconds !== undefined && typeof prices.perMinute === 'number') return (Math.max(seconds, prices.minSeconds ?? 0) * prices.perMinute) / 60;
  if (chars !== undefined && typeof prices.perMillionChars === 'number') return (chars * prices.perMillionChars) / 1e6;
  return undefined;
}
```

In `src/core/agent/budgets.js`, add after the `parse` helper:

```js
/** Whether an entry carries a call's cost: a role call's model.turn, or a speech request (their costs aren't in any model.turn). @param {any} e */
const priced = (e) => e.type === 'model.turn' || (e.type === 'net.request' && String(e.data?.kind ?? '').startsWith('speech-'));
```

In `spentToday`, change the inner loop to:

```js
      for (const e of await t.listEvents(s.id, { types: ['model.turn', 'net.request'], reverse: true, limit: 4000 })) {
        if (e.ts < since) break;
        if (priced(e)) sum += typeof e.data?.cost === 'number' ? e.data.cost : 0;
      }
```

In `costs`, change the first line and the loop to:

```js
  const turns = (await store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['model.turn', 'net.request'] }))).filter(priced);
```

(the loop over `turns` stays as it is). Update the module comment's last sentence to "per wake and per trip, from the model.turn records and speech requests."

In `src/core/llm/config.js`:

```js
/** The speech roles (spec §9.6, §10). Their lists hold stand-in entries besides models. */
export const SPEECH_ROLES = Object.freeze(['speech-in', 'speech-out']);
/** @type {Readonly<Record<string, { role: string, name: string }>>} */
export const STAND_INS = Object.freeze({
  'send-audio': { role: 'speech-in', name: 'Send audio to the model' },
  dictation: { role: 'speech-in', name: 'Phone dictation' },
  'browser-voice': { role: 'speech-out', name: 'Browser voice' },
});
/** "Send audio to the model", then phone dictation (§10.3); speech-out ends with the browser voice (§9.6). @type {Readonly<Record<string, readonly string[]>>} */
export const SPEECH_DEFAULTS = Object.freeze({ 'speech-in': Object.freeze(['send-audio', 'dictation']), 'speech-out': Object.freeze(['browser-voice']) });
```

(after `CHAT_ROLES`), and replace `rolesFrom` with:

```js
/**
 * Every chat and speech role with its level, keeping only models that exist and, in a speech
 * list, its own stand-ins. A speech list never saved holds the defaults; one the user emptied stays empty.
 * @param {any} saved @param {Record<string, ModelRecord>} models @returns {Roles}
 */
function rolesFrom(saved, models) {
  const s = saved && typeof saved === 'object' ? saved : {};
  /** @type {Roles} */
  const out = {};
  for (const role of new Set([...CHAT_ROLES, ...SPEECH_ROLES, ...Object.keys(s)])) {
    const r = s[role] ?? {};
    const speech = SPEECH_ROLES.includes(role);
    const kept = (/** @type {any} */ id) => typeof id === 'string' && (Boolean(models[id]) || (speech && STAND_INS[id]?.role === role));
    out[role] = {
      models: Array.isArray(r.models) ? r.models.filter(kept) : speech ? [...SPEECH_DEFAULTS[role]] : [],
      level: LEVELS.includes(r.level) ? r.level : /** @type {Record<string, string>} */ (ROLE_LEVELS)[role] ?? 'off',
      ...(Number.isInteger(r.firstOutputSeconds) && r.firstOutputSeconds >= 1 ? { firstOutputSeconds: r.firstOutputSeconds } : {}),
    };
  }
  return out;
}
```

and add at the end:

```js
/**
 * Whether a model transcribes ('in') or speaks ('out'), from its endpoint's type; null for a chat
 * model or one whose type isn't running. @param {ModelConfig} cfg @param {Map<string, { speech?: string }>} types @param {string} id
 * @returns {'in' | 'out' | null}
 */
export function speechKind(cfg, types, id) {
  const rec = cfg.models[id];
  const ep = rec ? cfg.endpoints[rec.endpoint] : undefined;
  const s = ep ? types.get(ep.type)?.speech : undefined;
  return s === 'in' || s === 'out' ? s : null;
}
```

`src/core/llm/speech.js`:

```js
import { errorFromResponse } from './contract.js';
import { cannotConnect, asProviderError } from './call.js';
import { speechCost } from './cost.js';

/**
 * Speech calls (spec §9.1, §10): one transcription, or one voice clip, from a speech endpoint type.
 * The type builds the HTTP request and reads the reply; annai sends it with a time limit, reads
 * errors into the same kinds as chat calls (§9.9), and traces it as a net.request with its cost
 * (§2: every request is traceable). Keys never reach the trace (§9.9).
 * @typedef {import('./contract.js').EndpointType} EndpointType
 * @typedef {{ data: Uint8Array, mediaType: string }} Clip
 * @param {{ type: EndpointType, endpoint: import('./config.js').Endpoint, model: import('./config.js').Model, key: string | null,
 *   audio?: { data: Uint8Array, mediaType: string, seconds?: number }, text?: string, fetch?: (url: string, init: RequestInit) => Promise<Response>,
 *   signal?: AbortSignal, timeoutMs?: number, trace?: ReturnType<typeof import('./trace.js').modelTrace>, registry?: import('../registry.js').Registry,
 *   now?: () => number, wake?: string }} c  audio: transcribe it, with an 'in' type; text: say it, with an 'out' type
 * @returns {Promise<{ text: string, cost: number | undefined, ms: number } | { clip: Clip, cost: number | undefined, ms: number }>}
 */
export async function speechCall(c) {
  const { type, endpoint, model, key, now = Date.now, timeoutMs = 15_000 } = c;
  const hearing = Boolean(c.audio);
  const text = c.text ?? '';
  if (key) c.trace?.secret(key);
  // Credentials can also sit in an endpoint's extra headers.
  for (const [name, value] of Object.entries(endpoint.headers ?? {})) {
    if (/auth|key|token|secret|cookie|session|password/i.test(name)) c.trace?.secret(String(value).replace(/^(Bearer|Basic)\s+/i, ''));
  }
  const spec = { endpoint, model, key, tunables: { ...endpoint.tunables, ...model.tunables } };
  const built = hearing
    ? /** @type {NonNullable<EndpointType['transcribeRequest']>} */ (type.transcribeRequest)({ ...spec, audio: /** @type {{ data: Uint8Array, mediaType: string }} */ (c.audio) })
    : /** @type {NonNullable<EndpointType['speechRequest']>} */ (type.speechRequest)({ ...spec, text });
  const cost = hearing ? speechCost(model.prices, { seconds: c.audio?.seconds }) : speechCost(model.prices, { chars: text.length });
  const started = now();
  let status = 0;
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(new DOMException('No answer in time.', 'TimeoutError')), timeoutMs);
  const signal = c.signal ? AbortSignal.any([c.signal, timer.signal]) : timer.signal;
  /** @param {string} outcome @param {string} [error] */
  const trace = (outcome, error) => c.trace?.request({
    kind: hearing ? 'speech-in' : 'speech-out', endpoint: endpoint.name, model: model.name, providerModel: model.providerId, url: built.url, status,
    ms: now() - started, firstMs: null, outcome, usage: null, ...(error ? { error } : {}), ...(outcome === 'ok' && cost !== undefined ? { cost } : {}),
    ...(c.wake ? { wake: c.wake } : {}), ...(hearing ? { seconds: c.audio?.seconds } : { chars: text.length }),
  });
  try {
    /** @type {Response} */
    let res;
    try {
      res = await (c.fetch ?? ((url, init) => fetch(url, init)))(built.url, { method: 'POST', headers: built.headers, body: built.body, signal });
    } catch (e) {
      throw cannotConnect(e, signal);
    }
    status = res.status;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = errorFromResponse(res.status, body, res.headers);
      const sharper = type.classify?.(res.status, body);
      if (sharper) err.kind = sharper;
      throw err;
    }
    const out = hearing
      ? { text: String((await /** @type {NonNullable<EndpointType['readTranscript']>} */ (type.readTranscript)(res, spec)).text ?? '').trim() }
      : { clip: await /** @type {NonNullable<EndpointType['readSpeech']>} */ (type.readSpeech)(res, spec) };
    await trace('ok');
    return { ...out, cost, ms: now() - started };
  } catch (e) {
    const err = asProviderError(e, signal, type, c.registry);
    await trace(err.kind, err.message);
    throw err;
  } finally {
    clearTimeout(t);
  }
}
```

In `src/core/llm/service.js`, add `import { speechCall } from './speech.js';`, and inside `createLlm`, after `resolve`:

```js
  /**
   * A speech model with what calling it needs, and its role's time limit (spec §9.6: configurable).
   * @param {string} modelId @param {'in' | 'out'} dir
   */
  const speechOf = async (modelId, dir) => {
    const { type, endpoint, model, key } = await resolve(modelId);
    if (type.speech !== dir) throw new ProviderError('bad-request', dir === 'in' ? `${model.name} isn't a transcription model.` : `${model.name} isn't a voice.`);
    const role = (await readConfig(ws)).roles[dir === 'in' ? 'speech-in' : 'speech-out'];
    return { type, endpoint, model, key, timeoutMs: (role?.firstOutputSeconds ?? (dir === 'in' ? 15 : 10)) * 1000 };
  };
```

and in `service`, after `decide`:

```js
    /**
     * Speech to text with one transcription model (spec §10.2), traced in scope.
     * @param {{ modelId: string, audio: { data: Uint8Array, mediaType: string, seconds?: number }, scope?: string, signal?: AbortSignal, wake?: string }} c
     */
    async transcribe({ modelId, audio, scope = SYS, signal, wake }) {
      return speechCall({ ...(await speechOf(modelId, 'in')), audio, fetch: get, signal, trace: modelTrace(store, scope), registry: plugins.registry, wake });
    },
    /**
     * A voice clip of one text from one voice (spec §10.1), traced in scope.
     * @param {{ modelId: string, text: string, scope?: string, signal?: AbortSignal, wake?: string }} c
     */
    async synthesize({ modelId, text, scope = SYS, signal, wake }) {
      return speechCall({ ...(await speechOf(modelId, 'out')), text, fetch: get, signal, trace: modelTrace(store, scope), registry: plugins.registry, wake });
    },
```

In `sw.js`, add `'/src/core/llm/speech.js',` to `SHELL` after `'/src/core/llm/service.js',`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/llm-speech.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test 2>&1 | tail -5`
Expected: all pass. (`llm-config.test.js` may assert the exact roles `readConfig` gives: if it lists only the chat roles, it is right to fail; add the two speech roles to its expected value and record that in the commit.)

- [ ] **Step 6: Commit**

```bash
npm run stamp && npm run check && git add src/core/llm src/core/plugins.js src/core/agent/budgets.js src/ui/format.js test/unit sw.js && git commit -m "Speech endpoint types: transcription and voice calls, traced and priced, and the speech-in and speech-out lists (spec §9.1, §9.6, §10)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 4: The `speech-openai` plugin and speech templates

**Files:**
- Create: `plugins-official/speech-openai/annai-plugin.json`, `plugins-official/speech-openai/index.js`
- Modify: `catalog/templates.json`, `catalog/plugins.json` (by `npm run catalog`), `src/core/llm/templates.js`
- Test: `test/unit/speech-openai.test.js`, `test/unit/llm-templates.test.js` (the catalog test learns speech prices)

**Interfaces:**
- Consumes: Task 3's speech endpoint type contract, `SPEECH_ROLES`, `SPEECH_DEFAULTS`.
- Produces:
  - Endpoint types `openai-transcription` (`speech: 'in'`, tunables `{ path: '/audio/transcriptions', language: '', prompt: '' }`) and `openai-speech` (`speech: 'out'`, tunables `{ path: '/audio/speech', voice: 'marin', format: 'mp3', instructions: '', speed: null }`), each with `classify`, `listRequest`, `readList`.
  - Templates `openai-transcription`, `groq-transcription`, `openai-speech`, `local-transcription`, `local-speech`, `custom-transcription`, `custom-speech`.
  - `templates.js`: `withSpeech(list: readonly string[], add: string[], role: string): string[]`; a template's speech suggestion joins the speech list instead of replacing it.

- [ ] **Step 1: Write the failing test**

`test/unit/speech-openai.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activate } from '../../plugins-official/speech-openai/index.js';
import { ProviderError, errorFromResponse, endpointTypes } from '../../src/core/llm/contract.js';
import { mergePatch } from '../../src/core/patch.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { ensureType } from '../../src/core/llm/official.js';
import { addFromTemplate, withSpeech } from '../../src/core/llm/templates.js';
import { readConfig, modelOf } from '../../src/core/llm/config.js';

/** @type {Record<string, any>} */
const types = {};
activate({ providers: { register: (/** @type {any} */ t) => { types[t.type] = t; return () => {}; } }, helpers: { ProviderError, errorFromResponse, mergePatch } });
const hear = types['openai-transcription'];
const say = types['openai-speech'];
/** @param {any} type @param {any} [over] */
const spec = (type, over = {}) => ({
  endpoint: { id: 'ep', type: type.type, name: 'OpenAI', baseUrl: 'https://api.openai.com/v1/', headers: { 'OpenAI-Organization': 'org-1' }, tunables: { ...type.tunables }, extraBody: {} },
  model: { id: 'm', name: 'Ears', providerId: 'gpt-transcribe', tunables: {}, extraBody: {} },
  key: 'sk-test', tunables: { ...type.tunables }, ...over,
});

test('transcription: the audio as a multipart upload, json back (spec §10.2)', async () => {
  const s = spec(hear, { tunables: { ...hear.tunables, language: 'en' } });
  const r = hear.transcribeRequest({ ...s, audio: { data: new Uint8Array([82, 73, 70, 70]), mediaType: 'audio/wav' } });
  assert.equal(r.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.deepEqual(r.headers, { authorization: 'Bearer sk-test', 'OpenAI-Organization': 'org-1' });
  assert.ok(r.body instanceof FormData);
  assert.equal(r.body.get('model'), 'gpt-transcribe');
  assert.equal(r.body.get('response_format'), 'json');
  assert.equal(r.body.get('language'), 'en');
  assert.equal(r.body.get('prompt'), null);
  const file = /** @type {File} */ (r.body.get('file'));
  assert.equal(file.name, 'speech.wav');
  assert.equal(file.type, 'audio/wav');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [82, 73, 70, 70]);
  assert.deepEqual(await hear.readTranscript(Response.json({ text: 'Where should we eat?' }), s), { text: 'Where should we eat?' });
  assert.deepEqual(await hear.readTranscript(Response.json({ nothing: 1 }), s), { text: '' });
});

test('voice: the text as JSON, the audio back as it came (spec §10.1)', async () => {
  const s = spec(say, { model: { id: 'm', name: 'Marin', providerId: 'gpt-4o-mini-tts', tunables: {}, extraBody: { speed: 1.1 } }, tunables: { ...say.tunables, instructions: 'Warm and calm.' } });
  const r = say.speechRequest({ ...s, text: 'Bixby Bridge is two miles ahead.' });
  assert.equal(r.url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(r.body), { model: 'gpt-4o-mini-tts', input: 'Bixby Bridge is two miles ahead.', voice: 'marin', response_format: 'mp3', instructions: 'Warm and calm.', speed: 1.1 });
  const clip = await say.readSpeech(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } }), s);
  assert.deepEqual([...clip.data], [1, 2]);
  assert.equal(clip.mediaType, 'audio/mpeg');
  const wav = await say.readSpeech(new Response(new Uint8Array([3]), { headers: { 'content-type': 'application/octet-stream' } }), { ...s, tunables: { ...s.tunables, format: 'wav' } });
  assert.equal(wav.mediaType, 'audio/wav');
  await assert.rejects(say.readSpeech(new Response(new Uint8Array([])), s), (e) => e instanceof ProviderError && e.kind === 'server');
});

test('errors by their codes; model lists from /models', () => {
  assert.equal(hear.classify(401, JSON.stringify({ error: { code: 'invalid_api_key' } })), 'auth');
  assert.equal(say.classify(429, JSON.stringify({ error: { code: 'insufficient_quota' } })), 'credit');
  assert.equal(say.classify(500, 'oops'), null);
  const s = spec(hear);
  assert.deepEqual(hear.listRequest({ endpoint: s.endpoint, key: 'sk-test' }), { url: 'https://api.openai.com/v1/models', headers: { authorization: 'Bearer sk-test', 'OpenAI-Organization': 'org-1' } });
  assert.deepEqual(hear.readList({ data: [{ id: 'whisper-1' }, { id: 7 }, { id: 'gpt-transcribe' }] }), [{ providerId: 'whisper-1' }, { providerId: 'gpt-transcribe' }]);
});

const root = new URL('../../', import.meta.url);
test('choosing a speech endpoint type installs the official plugin, checked against the catalog (spec §5.3)', async () => {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const fetch = async (/** @type {any} */ url) => {
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  const host = new PluginHost({ registry, workspace: ws, importModule });
  await ensureType(host, 'openai-speech', { fetch });
  assert.equal((await host.installed())['speech-openai']?.source, 'official');
  assert.deepEqual([...endpointTypes(registry).keys()].sort(), ['openai-speech', 'openai-transcription']);
});

test('a template speech model joins its list: transcription after "Send audio to the model", a voice ahead of the browser voice (spec §10.3)', async () => {
  assert.deepEqual(withSpeech(['send-audio', 'dictation'], ['m-1'], 'speech-in'), ['send-audio', 'm-1', 'dictation']);
  assert.deepEqual(withSpeech(['dictation'], ['m-1'], 'speech-in'), ['m-1', 'dictation']);
  assert.deepEqual(withSpeech(['m-0', 'browser-voice'], ['m-1', 'm-0'], 'speech-out'), ['m-0', 'm-1', 'browser-voice']);
  assert.deepEqual(withSpeech([], ['m-1'], 'speech-out'), ['m-1']);
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const catalog = JSON.parse(await readFile(new URL('catalog/templates.json', root), 'utf8'));
  const tpl = (/** @type {string} */ id) => catalog.endpoints.find((/** @type {any} */ t) => t.id === id);
  await addFromTemplate({ ws, store }, tpl('groq-transcription'));
  await addFromTemplate({ ws, store }, tpl('openai-speech'));
  const cfg = await readConfig(ws);
  const name = (/** @type {string} */ id) => (cfg.models[id] ? modelOf(cfg.models[id]).name : id);
  assert.deepEqual(cfg.roles['speech-in'].models.map(name), ['send-audio', 'Groq: Whisper large v3 turbo', 'dictation']);
  assert.deepEqual(cfg.roles['speech-out'].models.map(name), ['OpenAI: GPT-4o mini TTS (Marin)', 'browser-voice']);
  assert.deepEqual(cfg.roles.main.models, [], 'a speech template suggests nothing for chat roles');
});
```

In `test/unit/llm-templates.test.js`, in the catalog test, replace the `prices` assertion line with:

```js
    for (const m of t.models ?? []) {
      const chat = typeof m.prices?.input === 'number' && typeof m.prices?.output === 'number';
      const speech = typeof m.prices?.perMinute === 'number' || typeof m.prices?.perMillionChars === 'number';
      assert.ok(chat || speech, `${t.id}/${m.providerId}: prices`);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/speech-openai.test.js`
Expected: FAIL with `Cannot find module '…/plugins-official/speech-openai/index.js'`

- [ ] **Step 3: Write the implementation**

`plugins-official/speech-openai/annai-plugin.json`:

```json
{
  "id": "speech-openai",
  "name": "OpenAI-compatible speech",
  "version": "0.1.0",
  "api": 1,
  "entry": "index.js",
  "description": "Transcription and voices through the OpenAI audio API: OpenAI, Groq and local servers such as Speaches, whisper.cpp and Kokoro.",
  "provides": { "endpoint-type": ["openai-transcription", "openai-speech"] }
}
```

`plugins-official/speech-openai/index.js`:

```js
/**
 * OpenAI-compatible speech (spec §9.1, §10): transcription through /audio/transcriptions and
 * voices through /audio/speech. OpenAI, Groq and local servers (Speaches, whisper.cpp's server,
 * Kokoro) speak this API; their differences are tunables.
 */
const MEDIA = /** @type {Record<string, string>} */ ({ mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/L16' });
const EXT = /** @type {Record<string, string>} */ ({ 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' });
const CODES = /** @type {Record<string, string>} */ ({ invalid_api_key: 'auth', insufficient_quota: 'credit', model_not_found: 'not-found' });

/** @param {string} base @param {string} path */
const join = (base, path) => String(base).replace(/\/+$/, '') + path;
/** @param {any} endpoint @param {string | null} key @returns {Record<string, string>} */
const auth = (endpoint, key) => ({ ...(key ? { authorization: `Bearer ${key}` } : {}), ...(endpoint.headers ?? {}) });

/** A sharper kind for an error, from OpenAI's error code. @param {number} _status @param {string} body */
function classify(_status, body) {
  try {
    return CODES[JSON.parse(body)?.error?.code] ?? null;
  } catch {
    return null;
  }
}

/** @param {{ endpoint: any, key: string | null }} c */
const listRequest = ({ endpoint, key }) => ({ url: join(endpoint.baseUrl, '/models'), headers: auth(endpoint, key) });
/** @param {any} json */
const readList = (json) => (Array.isArray(json?.data) ? json.data : []).filter((/** @type {any} */ m) => typeof m?.id === 'string').map((/** @type {any} */ m) => ({ providerId: m.id }));

/** @param {any} annai */
export function activate(annai) {
  const { ProviderError, mergePatch } = annai.helpers;
  const offs = [
    annai.providers.register({
      type: 'openai-transcription',
      name: 'OpenAI-compatible transcription',
      speech: 'in',
      tunables: { path: '/audio/transcriptions', language: '', prompt: '' },
      /** @param {any} c */
      transcribeRequest: ({ endpoint, model, key, tunables: t, audio }) => {
        const form = new FormData();
        form.append('file', new Blob([audio.data], { type: audio.mediaType }), `speech.${EXT[audio.mediaType] ?? 'wav'}`);
        form.append('model', model.providerId);
        form.append('response_format', 'json');
        if (t.language) form.append('language', String(t.language));
        if (t.prompt) form.append('prompt', String(t.prompt));
        return { url: join(endpoint.baseUrl, t.path), headers: auth(endpoint, key), body: form };
      },
      /** @param {Response} res */
      readTranscript: async (res) => {
        const json = await res.json();
        return { text: typeof json?.text === 'string' ? json.text : '' };
      },
      classify,
      listRequest,
      readList,
    }),
    annai.providers.register({
      type: 'openai-speech',
      name: 'OpenAI-compatible voice',
      speech: 'out',
      tunables: { path: '/audio/speech', voice: 'marin', format: 'mp3', instructions: '', speed: null },
      /** @param {any} c */
      speechRequest: ({ endpoint, model, key, tunables: t, text }) => {
        /** @type {Record<string, any>} */
        let body = { model: model.providerId, input: text, voice: t.voice, response_format: t.format };
        if (t.instructions) body.instructions = t.instructions;
        if (t.speed) body.speed = t.speed;
        body = mergePatch(mergePatch(body, endpoint.extraBody ?? {}), model.extraBody ?? {});
        return { url: join(endpoint.baseUrl, t.path), headers: { 'content-type': 'application/json', ...auth(endpoint, key) }, body: JSON.stringify(body) };
      },
      /** @param {Response} res @param {any} c */
      readSpeech: async (res, { tunables: t }) => {
        const data = new Uint8Array(await res.arrayBuffer());
        if (!data.length) throw new ProviderError('server', 'The voice sent back no audio.');
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
        return { data, mediaType: type.startsWith('audio/') ? type : MEDIA[t.format] ?? 'audio/mpeg' };
      },
      classify,
      listRequest,
      readList,
    }),
  ];
  return () => { for (const off of offs) off(); };
}
```

In `src/core/llm/templates.js`, import `SPEECH_ROLES, SPEECH_DEFAULTS` from `./config.js`, add:

```js
/**
 * A speech list with models added (spec §10.3): a transcription model goes after "Send audio to
 * the model" (or first), a voice ahead of the browser voice (or last). Models already in it stay where they are.
 * @param {readonly string[]} list @param {string[]} add @param {string} role @returns {string[]}
 */
export function withSpeech(list, add, role) {
  const fresh = add.filter((id, i) => !list.includes(id) && add.indexOf(id) === i);
  const at = role === 'speech-in' ? list.indexOf('send-audio') + 1 : list.includes('browser-voice') ? list.indexOf('browser-voice') : list.length;
  return [...list.slice(0, at), ...fresh, ...list.slice(at)];
}
```

and replace `suggested` with:

```js
/**
 * Roles with a template's suggestion filled in. With onlyEmpty, chat roles the user has set are
 * kept. A speech list keeps its stand-ins and the user's order: the suggested models join it.
 * @param {Roles} roles @param {Map<string, string>} byProvider provider model id → model id
 * @param {Record<string, string[]> | undefined} suggestion @param {boolean} onlyEmpty
 */
function suggested(roles, byProvider, suggestion, onlyEmpty) {
  const next = structuredClone(roles);
  for (const [role, providers] of Object.entries(suggestion ?? {})) {
    const models = providers.map((p) => byProvider.get(p)).filter((x) => typeof x === 'string');
    if (!models.length) continue;
    if (SPEECH_ROLES.includes(role)) {
      next[role] = { level: 'off', ...next[role], models: withSpeech(next[role]?.models ?? SPEECH_DEFAULTS[role] ?? [], models, role) };
      continue;
    }
    if (onlyEmpty && next[role]?.models.length) continue;
    next[role] = { models, level: next[role]?.level ?? 'off' };
  }
  return next;
}
```

In `catalog/templates.json`, add these entries before the `"scripted"` entry:

```json
    { "id": "openai-transcription", "version": 1, "type": "openai-transcription", "name": "OpenAI: transcription", "baseUrl": "https://api.openai.com/v1",
      "keyUrl": "https://platform.openai.com/api-keys", "note": "Turns what you say into text, for models that don't take audio.",
      "models": [
        { "providerId": "gpt-transcribe", "name": "OpenAI: GPT Transcribe", "prices": { "perMinute": 0.0045 } },
        { "providerId": "gpt-4o-mini-transcribe", "name": "OpenAI: GPT-4o mini Transcribe", "prices": { "perMinute": 0.003 } },
        { "providerId": "whisper-1", "name": "OpenAI: Whisper", "prices": { "perMinute": 0.006 } }
      ],
      "roles": { "recommended": { "speech-in": ["gpt-transcribe"] } } },
    { "id": "groq-transcription", "version": 1, "type": "openai-transcription", "name": "Groq: transcription", "baseUrl": "https://api.groq.com/openai/v1",
      "keyUrl": "https://console.groq.com/keys", "note": "Fast Whisper. Groq bills each request as at least 10 seconds.",
      "models": [
        { "providerId": "whisper-large-v3-turbo", "name": "Groq: Whisper large v3 turbo", "prices": { "perMinute": 0.000667, "minSeconds": 10 } },
        { "providerId": "whisper-large-v3", "name": "Groq: Whisper large v3", "prices": { "perMinute": 0.00185, "minSeconds": 10 } }
      ],
      "roles": { "recommended": { "speech-in": ["whisper-large-v3-turbo"] } } },
    { "id": "openai-speech", "version": 1, "type": "openai-speech", "name": "OpenAI: voice", "baseUrl": "https://api.openai.com/v1",
      "keyUrl": "https://platform.openai.com/api-keys", "note": "Shiori's voice. GPT-4o mini TTS is priced by audio; its price here is OpenAI's estimate of $0.015 a minute.",
      "models": [
        { "providerId": "gpt-4o-mini-tts", "name": "OpenAI: GPT-4o mini TTS (Marin)", "tunables": { "voice": "marin" }, "prices": { "perMillionChars": 18 } },
        { "providerId": "tts-1", "name": "OpenAI: TTS-1 (Nova)", "tunables": { "voice": "nova" }, "prices": { "perMillionChars": 15 } },
        { "providerId": "tts-1-hd", "name": "OpenAI: TTS-1 HD (Nova)", "tunables": { "voice": "nova" }, "prices": { "perMillionChars": 30 } }
      ],
      "roles": { "recommended": { "speech-out": ["gpt-4o-mini-tts"] } } },
    { "id": "local-transcription", "version": 1, "type": "openai-transcription", "name": "Local server: transcription (Speaches, whisper.cpp)", "baseUrl": "http://localhost:8000/v1",
      "note": "On a phone, the server needs an HTTPS address, such as a tunnel: localhost only reaches the device annai runs on." },
    { "id": "local-speech", "version": 1, "type": "openai-speech", "name": "Local server: voice (Kokoro, Speaches)", "baseUrl": "http://localhost:8880/v1",
      "note": "On a phone, the server needs an HTTPS address, such as a tunnel: localhost only reaches the device annai runs on." },
    { "id": "custom-transcription", "version": 1, "type": "openai-transcription", "name": "Other: OpenAI-compatible transcription", "baseUrl": "" },
    { "id": "custom-speech", "version": 1, "type": "openai-speech", "name": "Other: OpenAI-compatible voice", "baseUrl": "" },
```

Then run `npm run catalog`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/speech-openai.test.js test/unit/llm-templates.test.js`
Expected: PASS (5 new tests; the template tests all pass).

- [ ] **Step 5: Commit**

```bash
npm run catalog && npm run stamp && npm run check && git add plugins-official/speech-openai catalog src/core/llm/templates.js test/unit/speech-openai.test.js test/unit/llm-templates.test.js sw.js && git commit -m "The speech-openai plugin: OpenAI-compatible transcription and voices, with templates for OpenAI, Groq and local servers (spec §9.1, §10)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 5: The speaker

**Files:**
- Create: `src/core/voice/platform.js`, `src/core/voice/speaker.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/voice-speaker.test.js`, `test/unit/voice-fakes.js`

**Interfaces:**
- Consumes: `Sentences` (Task 1); `modelOf`, `SPEECH_DEFAULTS` (Task 3).
- Produces:
  - `platform.js`: typedefs `Clip`, `Mic`, `Player`, `Synth`, `SystemVoice`, `Dictation`, `SessionType`, `VoicePlatform`; `voicePlatform(registry): VoicePlatform | null` (the first `'voice-platform'` a running plugin registered).
    - `Player.play(clip, { signal, onLevel? }): Promise<{ ended: boolean, fraction: number }>`: a stop (the signal) resolves with `ended: false`; it rejects with a `NotAllowedError` when the page may not play sound yet.
    - `Synth.say(text, { signal, voice?, rate?, lang?, onLevel? }): Promise<{ ended: boolean, charIndex: number }>`.
    - `Mic.open({ onFrames(pcm, sampleRate), onError(e) }): Promise<{ close() }>`.
    - `Dictation.open({ lang?, onSegment(text), onSpeech?, onError(e) }): { close() }`.
    - `VoicePlatform = { player, synth, mic, dictation, session(type: 'transient' | 'play-and-record' | 'playback'): void }`.
  - `speaker.js`:
    - `VoiceEntry = { id, name, kind: 'browser' | 'api' }`.
    - `speechOutEntries(cfg, { types, until, now, browser }): VoiceEntry[]`.
    - `Spoken = { sentences: string[], said: number, cut: { index, at } | null, heard: string, failed: null | 'no-voice' | 'blocked', voices: string[] }` (`voices`: the names of the voices that spoke, in order, each once).
    - `class Speaker { constructor(deps: SpeakerDeps); begin(): Utterance; stop(): boolean; get speaking(): boolean }`. Utterances play one after another.
    - `class Utterance { feed(textSoFar); end(text); stop(); get stopped(): boolean; done: Promise<Spoken> }`. `done` never rejects.
    - `SpeakerDeps = { entries(): Promise<VoiceEntry[]>, synthesize(entry, text, signal): Promise<Clip>, platform(): VoicePlatform | null, bench(id, error): void, browserOptions?(): Promise<{ voice?, rate?, lang? }>, onLevel?(x): void, locale?: string }`.
    - `wordStart(text, fraction): number`.
  - `test/unit/voice-fakes.js` (tests only): `fakePlatform({ playMs?, blocked? })` with `.log: string[]`, `.sessions: string[]`, `.mic.feed(pcm, rate)` for a fake microphone; `fakeVoices(ids, { failing?, fetchMs? })` giving `{ entries, synthesize, bench, benched, log }`.

- [ ] **Step 1: Write the failing test**

`test/unit/voice-fakes.js`:

```js
/**
 * A fake device and fake voices for the voice tests (the core never touches the DOM, spec §3).
 * Clips are their text as bytes; playing one takes playMs, and a stop is heard halfway through.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {{ playMs?: number, blocked?: boolean }} [o] */
export function fakePlatform({ playMs = 20, blocked = false } = {}) {
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const sessions = [];
  /** @type {((pcm: Float32Array, rate: number) => void) | null} */
  let frames = null;
  let opens = 0;
  const platform = {
    log,
    sessions,
    get opens() { return opens; },
    session(/** @type {string} */ t) { sessions.push(t); },
    player: {
      async unlock() { log.push('unlock'); },
      /** @param {{ data: Uint8Array }} clip @param {{ signal: AbortSignal, onLevel?: (x: number) => void }} o */
      play(clip, { signal, onLevel }) {
        const name = dec.decode(clip.data);
        log.push(`play ${name}`);
        if (blocked) return Promise.reject(Object.assign(new Error('The page may not play sound yet.'), { name: 'NotAllowedError' }));
        onLevel?.(0.5);
        return new Promise((resolve) => {
          const t = setTimeout(() => resolve({ ended: true, fraction: 1 }), playMs);
          signal.addEventListener('abort', () => { clearTimeout(t); log.push(`stop ${name}`); resolve({ ended: false, fraction: 0.5 }); }, { once: true });
        });
      },
    },
    synth: {
      available: () => true,
      voices: () => [{ id: 'v-en', name: 'Samantha', lang: 'en-US' }],
      /** @param {string} text @param {{ signal: AbortSignal }} o */
      say(text, { signal }) {
        log.push(`browser ${text}`);
        return new Promise((resolve) => {
          const t = setTimeout(() => resolve({ ended: true, charIndex: text.length }), playMs);
          signal.addEventListener('abort', () => { clearTimeout(t); resolve({ ended: false, charIndex: text.indexOf(' ') + 1 }); }, { once: true });
        });
      },
    },
    mic: {
      /** @param {{ onFrames: (pcm: Float32Array, rate: number) => void, onError: (e: Error) => void }} o */
      async open({ onFrames }) {
        opens++;
        log.push('mic open');
        frames = onFrames;
        return { close() { log.push('mic close'); frames = null; } };
      },
      /** What the microphone hears now, in chunks. @param {Float32Array} pcm @param {number} rate */
      feed(pcm, rate) {
        for (let i = 0; i < pcm.length && frames; i += 2048) frames(pcm.subarray(i, i + 2048), rate);
      },
    },
    dictation: { available: () => false, open() { return { close() {} }; } },
  };
  return platform;
}

/**
 * API voices by id. A voice in failing fails every clip (or, given a word, only clips with that word).
 * @param {string[]} ids @param {{ failing?: Record<string, string | true>, fetchMs?: number, browser?: boolean }} [o]
 */
export function fakeVoices(ids, { failing = {}, fetchMs = 2, browser = false } = {}) {
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const benched = [];
  const all = [...ids.map((id) => ({ id, name: id, kind: /** @type {const} */ ('api') })), ...(browser ? [{ id: 'browser-voice', name: 'Browser voice', kind: /** @type {const} */ ('browser') }] : [])];
  return {
    log,
    benched,
    entries: async () => all.filter((e) => !benched.includes(e.id)),
    /** @param {string} id */
    bench: (id) => { benched.push(id); },
    /** @param {{ id: string }} entry @param {string} text @param {AbortSignal} signal */
    synthesize(entry, text, signal) {
      log.push(`fetch ${entry.id} ${text}`);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          const f = failing[entry.id];
          if (f === true || (typeof f === 'string' && text.includes(f))) reject(Object.assign(new Error(`${entry.id} failed`), { kind: 'server' }));
          else resolve({ data: enc.encode(`${entry.id}:${text}`), mediaType: 'audio/mpeg' });
        }, fetchMs);
        signal.addEventListener('abort', () => { clearTimeout(t); log.push(`aborted ${entry.id} ${text}`); reject(new DOMException('Stopped.', 'AbortError')); }, { once: true });
      });
    },
  };
}
```

`test/unit/voice-speaker.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Speaker, speechOutEntries, wordStart } from '../../src/core/voice/speaker.js';
import { fakePlatform, fakeVoices } from './voice-fakes.js';

/** @param {ReturnType<typeof fakeVoices>} v @param {ReturnType<typeof fakePlatform>} p */
const speaker = (v, p) => new Speaker({ entries: v.entries, synthesize: v.synthesize, bench: v.bench, platform: () => /** @type {any} */ (p), locale: 'en' });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const plays = (/** @type {string[]} */ log) => log.filter((l) => l.startsWith('play ') || l.startsWith('browser ')).map((l) => l.replace(/^\S+ /, ''));

test('sentences play as they stream in, and the next is fetched while one plays (spec §10.1)', async () => {
  const p = fakePlatform();
  const v = fakeVoices(['v1']);
  const u = speaker(v, p).begin();
  u.feed('Bixby Bridge is two miles ahead. When it op');
  await tick(5);
  assert.deepEqual(v.log, ['fetch v1 Bixby Bridge is two miles ahead.'], 'the first sentence goes before the rest has arrived');
  u.feed('Bixby Bridge is two miles ahead. When it opened in 1932, it was tall! Want a stop');
  u.end('Bixby Bridge is two miles ahead. When it opened in 1932, it was tall! Want a stop?');
  const done = await u.done;
  assert.deepEqual(plays(p.log), ['v1:Bixby Bridge is two miles ahead.', 'v1:When it opened in 1932, it was tall!', 'v1:Want a stop?']);
  assert.equal(done.said, 3);
  assert.equal(done.cut, null);
  assert.equal(done.failed, null);
  assert.equal(done.heard, 'Bixby Bridge is two miles ahead. When it opened in 1932, it was tall! Want a stop?');
  assert.deepEqual(p.sessions, ['transient']);
});

test('the next clip is fetched while one plays: no gap waiting for it', async () => {
  const p = fakePlatform({ playMs: 30 });
  const v = fakeVoices(['v1'], { fetchMs: 5 });
  const u = speaker(v, p).begin();
  u.end('One. Two. Three.');
  await tick(20); // the first clip is playing
  assert.deepEqual(v.log, ['fetch v1 One.', 'fetch v1 Two.']);
  await u.done;
});

test('a voice that fails partway is benched; the same sentence plays on the next voice, and so does the rest (spec §10.1)', async () => {
  const p = fakePlatform();
  const v = fakeVoices(['v1', 'v2'], { failing: { v1: 'Second' } });
  const u = speaker(v, p).begin();
  u.end('First thing. Second thing. Third thing.');
  const done = await u.done;
  assert.deepEqual(plays(p.log), ['v1:First thing.', 'v2:Second thing.', 'v2:Third thing.']);
  assert.deepEqual(v.benched, ['v1']);
  assert.equal(done.said, 3);
  assert.deepEqual(done.voices, ['v1', 'v2']);
});

test('the browser voice speaks when it comes first, or when every API voice failed; a cut is kept by word', async () => {
  const p = fakePlatform({ playMs: 40 });
  const v = fakeVoices(['v1'], { failing: { v1: true }, browser: true });
  const s = speaker(v, p);
  const u = s.begin();
  u.end('Bixby Bridge is two miles ahead. Want a stop?');
  await tick(20);
  assert.equal(s.speaking, true);
  assert.equal(s.stop(), true);
  const done = await u.done;
  assert.deepEqual(plays(p.log), ['Bixby Bridge is two miles ahead.']);
  assert.deepEqual(done.cut, { index: 0, at: 6 });
  assert.equal(done.heard, 'Bixby…');
  assert.equal(done.said, 0);
  assert.equal(s.speaking, false);
});

test('cut off while a clip is still downloading: done settles at once, nothing plays, the download stops', async () => {
  const p = fakePlatform();
  const v = fakeVoices(['v1'], { fetchMs: 200 });
  const u = speaker(v, p).begin();
  u.end('One more thing. And another.');
  await tick(10);
  const t0 = Date.now();
  u.stop();
  const done = await u.done;
  assert.ok(Date.now() - t0 < 50);
  assert.deepEqual(plays(p.log), []);
  assert.ok(v.log.includes('aborted v1 One more thing.'));
  assert.deepEqual(done.cut, { index: 0, at: 0 });
  assert.equal(done.heard, '');
});

test('cut off between sentences, while the rest is still being written: what was said is kept', async () => {
  const p = fakePlatform();
  const v = fakeVoices(['v1']);
  const u = speaker(v, p).begin();
  u.feed('One. Two is on its w');
  await tick(60);
  u.stop();
  const done = await u.done;
  assert.deepEqual(plays(p.log), ['v1:One.']);
  assert.equal(done.said, 1);
  assert.deepEqual(done.cut, { index: 1, at: 0 });
  assert.equal(done.heard, 'One.');
});

test('a cut in a clip is kept by the fraction played, back to a word', async () => {
  const p = fakePlatform({ playMs: 100 });
  const v = fakeVoices(['v1']);
  const u = speaker(v, p).begin();
  u.end('Bixby Bridge is two miles ahead.');
  await tick(30);
  u.stop();
  const done = await u.done;
  assert.deepEqual(done.cut, { index: 0, at: wordStart('Bixby Bridge is two miles ahead.', 0.5) });
  assert.equal(done.heard, 'Bixby Bridge is…');
  assert.equal(wordStart('Bixby Bridge is two miles ahead.', 0.5), 15);
  assert.equal(wordStart('Bixby', 0.5), 0);
  assert.equal(wordStart('Bixby', 1), 5);
});

test('utterances play one after another; a stop cuts them all', async () => {
  const p = fakePlatform();
  const v = fakeVoices(['v1']);
  const s = speaker(v, p);
  const a = s.begin();
  const b = s.begin();
  b.end('Second.');
  a.end('First.');
  await Promise.all([a.done, b.done]);
  assert.deepEqual(plays(p.log), ['v1:First.', 'v1:Second.']);
  const c = s.begin();
  const d = s.begin();
  c.end('A one. A two.');
  d.end('Never said.');
  await tick(10);
  s.stop();
  const [dc, dd] = await Promise.all([c.done, d.done]);
  assert.ok(dc.cut);
  assert.equal(dd.said, 0);
  assert.ok(!plays(p.log).includes('v1:Never said.'));
});

test('no voice works, or the page may not play sound yet: done says so, and a blocked page benches no voice', async () => {
  const blank = speaker(fakeVoices([]), fakePlatform()).begin();
  blank.end('   ');
  assert.equal((await blank.done).failed, null, 'nothing to say is no failure');
  const u = speaker(fakeVoices([]), fakePlatform()).begin();
  u.end('Hello.');
  assert.equal((await u.done).failed, 'no-voice');
  const v = fakeVoices(['v1']);
  const w = speaker(v, fakePlatform({ blocked: true })).begin();
  w.end('Hello.');
  const blocked = await w.done;
  assert.equal(blocked.failed, 'blocked');
  assert.deepEqual(v.benched, []);
  const x = new Speaker({ ...fakeVoices(['v1']), platform: () => null }).begin();
  x.end('Hello.');
  assert.equal((await x.done).failed, 'no-voice');
});

test('the speech-out entries that can speak now, in their order (spec §9.6)', () => {
  /** @type {any} */
  const cfg = {
    endpoints: { 'ep-o': { id: 'ep-o', type: 'say' }, 'ep-i': { id: 'ep-i', type: 'hear' } },
    models: { 'm-o': { id: 'm-o', endpoint: 'ep-o', template: null, user: { providerId: 'tts', name: 'Marin' } }, 'm-i': { id: 'm-i', endpoint: 'ep-i', template: null, user: { providerId: 'asr' } } },
    roles: { 'speech-out': { models: ['m-o', 'browser-voice', 'm-i', 'm-gone'], level: 'off' } },
  };
  const types = new Map([['say', { speech: 'out' }], ['hear', { speech: 'in' }]]);
  const ids = (/** @type {any} */ c) => speechOutEntries(cfg, { types, until: () => 0, now: 1, browser: true, ...c }).map((e) => `${e.kind}:${e.name}`);
  assert.deepEqual(ids({}), ['api:Marin', 'browser:Browser voice']);
  assert.deepEqual(ids({ until: (/** @type {string} */ id) => (id === 'm-o' ? 5 : 0) }), ['browser:Browser voice']);
  assert.deepEqual(ids({ browser: false }), ['api:Marin']);
  assert.deepEqual(speechOutEntries({ ...cfg, roles: {} }, { types, until: () => 0, now: 1, browser: true }).map((e) => e.id), ['browser-voice']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/voice-speaker.test.js`
Expected: FAIL with `Cannot find module '…/src/core/voice/speaker.js'`

- [ ] **Step 3: Write the implementation**

`src/core/voice/platform.js`:

```js
/**
 * What annai needs from the device for voice (spec §10), given by the built-in voice-browser
 * plugin (src/plugins/voice-browser/) and by fakes in tests: the core never touches the DOM (§3).
 * @typedef {{ data: Uint8Array, mediaType: string }} Clip
 * @typedef {{ open(o: { onFrames: (pcm: Float32Array, sampleRate: number) => void, onError: (e: Error) => void }): Promise<{ close(): void }> }} Mic
 *   the microphone: open only while listening (§10.2)
 * @typedef {{ unlock(): Promise<void>, play(clip: Clip, o: { signal: AbortSignal, onLevel?: (x: number) => void }): Promise<{ ended: boolean, fraction: number }> }} Player
 *   the one audio player (§10.1); play() resolves with ended false when stopped, and rejects with a NotAllowedError while the page may not play sound
 * @typedef {{ id: string, name: string, lang: string }} SystemVoice
 * @typedef {{ available(): boolean, voices(): SystemVoice[],
 *   say(text: string, o: { signal: AbortSignal, voice?: string, rate?: number, lang?: string, onLevel?: (x: number) => void }): Promise<{ ended: boolean, charIndex: number }> }} Synth
 *   the browser voice; charIndex: where the word being spoken starts
 * @typedef {{ available(): boolean, open(o: { lang?: string, onSegment: (text: string) => void, onSpeech?: () => void, onError: (e: Error & { code?: string }) => void }): { close(): void } }} Dictation
 *   phone dictation (§10.2)
 * @typedef {'transient' | 'play-and-record' | 'playback'} SessionType  the audio session type (§10.1)
 * @typedef {{ player: Player, synth: Synth, mic: Mic, dictation: Dictation, session(type: SessionType): void }} VoicePlatform
 */

/** The voice platform a running plugin gives (built-ins are plugins, spec §5.4), or null. @param {import('../registry.js').Registry} registry @returns {VoicePlatform | null} */
export function voicePlatform(registry) {
  return registry.list('voice-platform')[0] ?? null;
}
```

`src/core/voice/speaker.js`:

```js
import { Sentences } from './sentences.js';
import { modelOf, SPEECH_DEFAULTS } from '../llm/config.js';

/**
 * Speaking (spec §10.1). What Shiori says arrives as text, a piece at a time; each complete
 * sentence goes to the first working entry of the speech-out list, an API voice or the browser's.
 * An API voice's next sentence is fetched while one plays, so there are no gaps. When a voice fails
 * partway through, it is benched and the same sentence plays on the next one. When the user cuts
 * her off, playing stops at once and what she had said is kept: by sentence and the fraction of it
 * played, or by word with the browser voice.
 * @typedef {import('./platform.js').VoicePlatform} VoicePlatform
 * @typedef {import('./platform.js').Clip} Clip
 * @typedef {{ id: string, name: string, kind: 'browser' | 'api' }} VoiceEntry
 * @typedef {{ sentences: string[], said: number, cut: { index: number, at: number } | null, heard: string, failed: null | 'no-voice' | 'blocked', voices: string[] }} Spoken
 *   said: sentences spoken whole; cut: where she was stopped (a sentence, and characters into it); heard: what the user heard; voices: who spoke, in order;
 *   failed: no voice could speak ('no-voice'), or the page may not play sound yet ('blocked', an iPhone before the first tap)
 * @typedef {{ entries: () => Promise<VoiceEntry[]>, synthesize: (entry: VoiceEntry, text: string, signal: AbortSignal) => Promise<Clip>,
 *   platform: () => VoicePlatform | null, bench: (id: string, error: unknown) => void,
 *   browserOptions?: () => Promise<{ voice?: string, rate?: number, lang?: string }>, onLevel?: (x: number) => void, locale?: string }} SpeakerDeps
 * @typedef {{ ended: boolean, at: number, failed?: 'no-voice' | 'blocked' }} Said
 */

/**
 * The speech-out entries that can speak now, in the user's order (spec §9.6, §10.1): the browser
 * voice where the browser has one, and voices whose type runs and that aren't resting.
 * @param {import('../llm/config.js').ModelConfig} cfg
 * @param {{ types: Map<string, { speech?: string }>, until: (id: string) => number, now: number, browser: boolean }} c
 * @returns {VoiceEntry[]}
 */
export function speechOutEntries(cfg, { types, until, now, browser }) {
  /** @type {VoiceEntry[]} */
  const out = [];
  for (const id of cfg.roles?.['speech-out']?.models ?? SPEECH_DEFAULTS['speech-out']) {
    if (until(id) > now) continue;
    if (id === 'browser-voice') {
      if (browser) out.push({ id, name: 'Browser voice', kind: 'browser' });
      continue;
    }
    const rec = cfg.models[id];
    const ep = rec ? cfg.endpoints[rec.endpoint] : undefined;
    if (rec && ep && types.get(ep.type)?.speech === 'out') out.push({ id, name: modelOf(rec).name, kind: 'api' });
  }
  return out;
}

/** Where the word at the playing position starts: the fraction played, back to a space. @param {string} text @param {number} fraction */
export function wordStart(text, fraction) {
  const n = Math.floor(text.length * Math.max(0, Math.min(1, fraction)));
  if (n >= text.length) return text.length;
  const i = text.lastIndexOf(' ', n);
  return i < 0 ? 0 : i;
}

/** What the user heard: the sentences said whole, then the start of the one she was cut off in. @param {string[]} texts @param {number} said @param {Spoken['cut']} cut */
function heardText(texts, said, cut) {
  const part = cut && cut.at > 0 ? `${texts[cut.index].slice(0, cut.at).trimEnd()}…` : '';
  return [texts.slice(0, said).join(' '), part].filter(Boolean).join(' ');
}

export class Speaker {
  /** @type {Set<Utterance>} */
  #live = new Set();
  /** @type {Promise<unknown>} */
  #last = Promise.resolve();

  /** @param {SpeakerDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /** Something to say. It plays after what is already being said. */
  begin() {
    const u = new Utterance(this.deps, this.#last);
    this.#live.add(u);
    this.#last = u.done;
    u.done.then(() => this.#live.delete(u));
    return u;
  }

  /** Whether something is being said, or waits to be. */
  get speaking() {
    return this.#live.size > 0;
  }

  /** The user cut her off (spec §10.4): everything stops. @returns {boolean} whether she was speaking */
  stop() {
    const was = this.#live.size > 0;
    for (const u of this.#live) u.stop();
    return was;
  }
}

export class Utterance {
  /** @type {SpeakerDeps} */
  #deps;
  /** @type {Sentences} */
  #sentences;
  /** @type {string[]} */
  #texts = [];
  #ended = false;
  #stopped = false;
  #abort = new AbortController();
  /** @type {(() => void)[]} */
  #waiting = [];
  /** @type {Map<number, { entry: string, clip: Promise<Clip> }>} */
  #prefetched = new Map();
  /** @type {{ index: number, entry: VoiceEntry } | null} */
  #playing = null;
  /** The voices that spoke, in order. @type {string[]} */
  #voices = [];
  /** @type {Promise<Spoken>} */
  done;

  /** @param {SpeakerDeps} deps @param {Promise<unknown>} after what is said first */
  constructor(deps, after) {
    this.#deps = deps;
    this.#sentences = new Sentences(deps.locale);
    this.done = after.then(() => this.#run(), () => this.#run());
  }

  /** The text so far, as it streams in. @param {string} text */
  feed(text) {
    if (!this.#ended) this.#add(this.#sentences.take(text));
  }

  /** All of the text: the rest is said. @param {string} text */
  end(text) {
    if (this.#ended) return;
    this.#add(this.#sentences.take(text, true));
    this.#ended = true;
    this.#wake();
  }

  /** Stops now (spec §10.4); done settles with what was said. */
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#abort.abort();
    this.#wake();
  }

  get stopped() {
    return this.#stopped;
  }

  /** @param {string[]} list */
  #add(list) {
    if (!list.length) return;
    this.#texts.push(...list);
    if (this.#playing) this.#prefetch(this.#playing.index + 1, this.#playing.entry);
    this.#wake();
  }

  #wake() {
    for (const w of this.#waiting.splice(0)) w();
  }

  /** Sentence i once it is known; null when there is none: the text ended, or she was stopped. @param {number} i @returns {Promise<string | null>} */
  async #sentence(i) {
    for (;;) {
      if (this.#stopped) return null;
      if (i < this.#texts.length) return this.#texts[i];
      if (this.#ended) return null;
      await new Promise((r) => { this.#waiting.push(() => r(undefined)); });
    }
  }

  /** @returns {Promise<Spoken>} */
  async #run() {
    /** @type {Spoken['cut']} */
    let cut = null;
    /** @type {Spoken['failed']} */
    let failed = null;
    let i = 0;
    try {
      for (;; i++) {
        const text = await this.#sentence(i);
        if (text === null) break;
        // Speaking: other audio ducks rather than stops (spec §10.1).
        if (i === 0) this.#deps.platform()?.session('transient');
        const r = await this.#say(i, text);
        if (r.failed) {
          failed = r.failed;
          break;
        }
        if (!r.ended) {
          cut = { index: i, at: r.at };
          break;
        }
      }
      if (this.#stopped && !cut && !failed && (i < this.#texts.length || !this.#ended)) cut = { index: i, at: 0 };
    } finally {
      this.#abort.abort(); // nothing fetched ahead is left running
      this.#deps.onLevel?.(0);
    }
    const said = cut ? cut.index : failed ? i : this.#texts.length;
    return { sentences: [...this.#texts], said, cut, heard: heardText(this.#texts, said, cut), failed, voices: this.#voices };
  }

  /**
   * Sentence i on the first voice that can say it. A voice that fails is benched and the next one
   * says the same sentence (spec §10.1); a page that may not play sound yet is nobody's fault.
   * @param {number} i @param {string} text @returns {Promise<Said>}
   */
  async #say(i, text) {
    /** @type {Set<string>} */
    const tried = new Set();
    for (;;) {
      if (this.#stopped) return { ended: false, at: 0 };
      const platform = this.#deps.platform();
      const entry = platform ? (await this.#deps.entries()).find((e) => !tried.has(e.id)) : undefined;
      if (!platform || !entry) return { ended: false, at: 0, failed: 'no-voice' };
      tried.add(entry.id);
      try {
        if (entry.kind === 'browser') {
          const o = (await this.#deps.browserOptions?.()) ?? {};
          this.#spoke(entry);
          const r = await platform.synth.say(text, { ...o, signal: this.#abort.signal, onLevel: this.#deps.onLevel });
          return { ended: r.ended, at: r.ended ? text.length : r.charIndex };
        }
        const clip = await this.#clip(i, entry, text);
        if (this.#stopped) return { ended: false, at: 0 };
        this.#spoke(entry);
        this.#playing = { index: i, entry };
        this.#prefetch(i + 1, entry);
        const r = await platform.player.play(clip, { signal: this.#abort.signal, onLevel: this.#deps.onLevel });
        return { ended: r.ended, at: r.ended ? text.length : wordStart(text, r.fraction) };
      } catch (e) {
        if (this.#stopped) return { ended: false, at: 0 };
        if (/** @type {any} */ (e)?.name === 'NotAllowedError') return { ended: false, at: 0, failed: 'blocked' };
        this.#deps.bench(entry.id, e);
      } finally {
        this.#playing = null;
      }
    }
  }

  /** @param {VoiceEntry} entry */
  #spoke(entry) {
    if (this.#voices.at(-1) !== entry.name) this.#voices.push(entry.name);
  }

  /** Sentence i's clip: fetched ahead by the same voice, or now. @param {number} i @param {VoiceEntry} entry @param {string} text */
  #clip(i, entry, text) {
    const ahead = this.#prefetched.get(i);
    this.#prefetched.delete(i);
    return ahead && ahead.entry === entry.id ? ahead.clip : this.#deps.synthesize(entry, text, this.#abort.signal);
  }

  /** Fetches sentence i's clip while the one before it plays (spec §10.1: no gaps). @param {number} i @param {VoiceEntry} entry */
  #prefetch(i, entry) {
    if (entry.kind !== 'api' || i >= this.#texts.length || this.#prefetched.has(i) || this.#stopped) return;
    const clip = this.#deps.synthesize(entry, this.#texts[i], this.#abort.signal);
    clip.catch(() => {}); // a failure counts when the clip is wanted
    this.#prefetched.set(i, { entry: entry.id, clip });
  }
}
```

In `sw.js`, add `'/src/core/voice/platform.js',` and `'/src/core/voice/speaker.js',` to `SHELL` with the other `src/core/voice/` files.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/voice-speaker.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/voice/platform.js src/core/voice/speaker.js test/unit/voice-fakes.js test/unit/voice-speaker.test.js sw.js && git commit -m "The speaker: sentence by sentence on the first working voice, fetched ahead, with fallback and the cut-off point (spec §10.1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 6: The device side, the recorder, and the `Voice` service

**Files:**
- Create: `src/core/voice/settings.js`, `src/core/voice/recorder.js`, `src/core/voice/voice.js`, `src/plugins/voice-browser/index.js`, `src/plugins/voice-browser/capture-worklet.js`, `test/browser/suites/voice.js`
- Modify: `src/app/main.js`, `src/ui/shell.js` (`ctx.voice`), `test/e2e/browser-suites.spec.js`, `sw.js`
- Test: `test/unit/voice-recorder.test.js`, `test/unit/voice-service.test.js`, the browser suite `voice`

**Interfaces:**
- Consumes: `Detector` (Task 2), `encodeWav`, `resample`, `SEND_RATE`, `decodeWav`, `wavSeconds` (Task 2); `Speaker`, `speechOutEntries`, `voicePlatform`, the platform typedefs (Task 5); `speechKind`, `llm.synthesize`, `llm.transcribe` (Task 3); `COOLDOWN_MS` (`fallback.js`).
- Produces:
  - `settings.js`: `VOICE_DEFAULTS`, `voiceSettings(app): { pauseMs: number, browserVoice: string, rate: number }` (pause 300–3000 ms, default 700; rate 0.5–2, default 1).
  - `recorder.js`: `Segment = { id: string, audio: { data: Uint8Array, mediaType: 'audio/wav', seconds: number }, ms: number, at: number }`; `record({ mic, pauseMs?, now?, onSpeech?, onLevel?, onSegment, onDiscard?, onError? }): Promise<{ close(): void }>`.
  - `voice.js`: `restFor(error): number`; `class Voice { constructor({ llm, ws, registry, now?, locale? }); scope: string; speaker: Speaker; get platform(): VoicePlatform | null; onLevel(fn: (level, who: 'her' | 'you') => void): () => void; outEntries(): Promise<VoiceEntry[]>; transcribers(): Promise<string[]>; say(text): Promise<Spoken>; sample(modelId, text): Promise<{ ended, fraction }>; listenOnce({ seconds?, onSpeech?, signal? }?): Promise<Segment | null>; transcribe(segment, modelId): Promise<string> }`.
  - `src/plugins/voice-browser/index.js`: `manifest`, `activate(annai)` registers `'voice-platform'`; `browserPlatform(): VoicePlatform`.
  - `ctx.voice` on every screen.

- [ ] **Step 1: Write the failing tests**

`test/unit/voice-recorder.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record } from '../../src/core/voice/recorder.js';
import { decodeWav, wavSeconds, resample } from '../../src/core/voice/pcm.js';
import { clip, quiet, cat } from './voice-kit.js';
import { fakePlatform } from './voice-fakes.js';

const lunch = await clip('where-lunch');

test('the microphone opens for the window; what it hears is cut into 16 kHz WAV segments (spec §10.2)', async () => {
  const p = fakePlatform();
  /** @type {any[]} */
  const got = [];
  let speech = 0;
  /** @type {number[]} */
  const levels = [];
  const s = await record({ mic: p.mic, onSpeech: () => speech++, onLevel: (x) => levels.push(x), onSegment: (seg) => got.push(seg) });
  p.mic.feed(resample(cat(quiet(0.5), lunch, quiet(1)), 16_000, 48_000), 48_000);
  assert.equal(got.length, 1);
  assert.equal(speech, 1);
  assert.match(got[0].id, /^s-/);
  assert.equal(got[0].audio.mediaType, 'audio/wav');
  assert.equal(decodeWav(got[0].audio.data).sampleRate, 16_000);
  assert.ok(Math.abs(got[0].audio.seconds - wavSeconds(got[0].audio.data)) < 0.05);
  assert.ok(levels.some((x) => x > 0.2));
  s.close();
  assert.deepEqual(p.log, ['mic open', 'mic close']);
  assert.equal(levels.at(-1), 0);
});

test('closing keeps speech that was still going; nothing comes after', async () => {
  const p = fakePlatform();
  /** @type {any[]} */
  const got = [];
  const s = await record({ mic: p.mic, onSegment: (seg) => got.push(seg) });
  p.mic.feed(cat(quiet(0.5), lunch.subarray(0, 16_000)), 16_000);
  assert.equal(got.length, 0);
  s.close();
  assert.equal(got.length, 1);
  p.mic.feed(cat(lunch, quiet(1)), 16_000);
  s.close();
  assert.equal(got.length, 1);
});
```

`test/unit/voice-service.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Voice, restFor } from '../../src/core/voice/voice.js';
import { voiceSettings } from '../../src/core/voice/settings.js';
import { Registry } from '../../src/core/registry.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { Bench, COOLDOWN_MS } from '../../src/core/llm/fallback.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { fakePlatform } from './voice-fakes.js';
import { clip, quiet, cat } from './voice-kit.js';

const enc = new TextEncoder();

/** A Voice over a fake llm: one API voice (v1), one transcription model (t1), and the stand-ins. @param {{ failing?: boolean, retryAfter?: number }} [o] */
async function voiceKit({ failing = false, retryAfter } = {}) {
  const registry = new Registry();
  const ws = new Workspace(createMemoryStore(), { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const platform = fakePlatform();
  registry.add('voice-browser', 'voice-platform', platform);
  const bench = new Bench();
  /** @type {string[]} */
  const calls = [];
  const llm = {
    bench,
    types: () => new Map([['say', { speech: 'out' }], ['hear', { speech: 'in' }]]),
    config: async () => ({
      endpoints: { eo: { id: 'eo', type: 'say' }, ei: { id: 'ei', type: 'hear' } },
      models: { v1: { id: 'v1', endpoint: 'eo', template: null, user: { providerId: 'tts' } }, t1: { id: 't1', endpoint: 'ei', template: null, user: { providerId: 'asr' } } },
      roles: { 'speech-out': { models: ['v1', 'browser-voice'], level: 'off' }, 'speech-in': { models: ['send-audio', 't1', 'dictation'], level: 'off' } },
    }),
    /** @param {{ modelId: string, text: string }} c */
    async synthesize({ modelId, text }) {
      calls.push(`say ${modelId} ${text}`);
      if (failing) throw new ProviderError('rate', 'Slow down.', { retryAfter });
      return { clip: { data: enc.encode(`${modelId}:${text}`), mediaType: 'audio/mpeg' } };
    },
    /** @param {{ modelId: string, audio: any }} c */
    async transcribe({ modelId, audio }) {
      calls.push(`hear ${modelId} ${audio.mediaType}`);
      return { text: 'where should we stop for lunch' };
    },
  };
  const voice = new Voice({ llm, ws, registry, locale: 'en' });
  return { voice, platform, llm, calls, ws, bench };
}

test('say(): through the speech-out list, the browser voice taking over from a voice that is resting', async () => {
  const k = await voiceKit();
  const spoken = await k.voice.say('Hello. This is how I sound.');
  assert.equal(spoken.said, 2);
  assert.deepEqual(k.platform.log.filter((l) => l.startsWith('play')), ['play v1:Hello.', 'play v1:This is how I sound.']);
  const f = await voiceKit({ failing: true, retryAfter: 42_000 });
  await f.voice.say('Hello.');
  assert.deepEqual(f.platform.log.filter((l) => l.startsWith('browser')), ['browser Hello.']);
  assert.ok(f.bench.until('v1') > Date.now() + 40_000, 'it rests as long as the provider asked');
});

test('a resting voice rests as long as the provider asked, else the usual cooldown (spec §9.6)', () => {
  assert.equal(restFor(new ProviderError('rate', 'x', { retryAfter: 5000 })), 5000);
  assert.equal(restFor(new Error('x')), COOLDOWN_MS);
});

test('listenOnce(): the mic opens, one segment comes back, the mic closes and the session goes back to playback', async () => {
  const k = await voiceKit();
  /** @type {string[]} */
  const who = [];
  const off = k.voice.onLevel((x, w) => { if (x > 0) who.push(w); });
  const heard = k.voice.listenOnce({ seconds: 5 });
  await new Promise((r) => setTimeout(r, 5));
  k.platform.mic.feed(cat(quiet(0.5), await clip('where-lunch'), quiet(1)), 16_000);
  const seg = await heard;
  off();
  assert.ok(seg && seg.ms > 1000);
  assert.deepEqual(k.platform.log, ['mic open', 'mic close']);
  assert.deepEqual(k.platform.sessions, ['play-and-record', 'playback']);
  assert.ok(who.includes('you'));
  assert.equal(await k.voice.transcribe(/** @type {any} */ (seg), 't1'), 'where should we stop for lunch');
  assert.deepEqual(k.calls, ['hear t1 audio/wav']);
  assert.deepEqual(await k.voice.transcribers(), ['t1']);
});

test('listenOnce(): nothing heard in time gives null, and the mic closes', async () => {
  const k = await voiceKit();
  assert.equal(await k.voice.listenOnce({ seconds: 0.02 }), null);
  assert.deepEqual(k.platform.log, ['mic open', 'mic close']);
});

test('Settings → Voice: defaults, and values outside their range fall back', async () => {
  assert.deepEqual(voiceSettings({}), { pauseMs: 700, browserVoice: '', rate: 1 });
  assert.deepEqual(voiceSettings({ voice: { pauseMs: 50, browserVoice: 'Samantha', rate: 1.2 } }), { pauseMs: 700, browserVoice: 'Samantha', rate: 1.2 });
  const k = await voiceKit();
  await updateAppSettings(k.ws, { voice: { browserVoice: 'v-en', rate: 0.9 } });
  await k.voice.say('Hi.');
  assert.ok(k.platform.log.includes('play v1:Hi.'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/voice-recorder.test.js test/unit/voice-service.test.js`
Expected: FAIL with `Cannot find module '…/src/core/voice/recorder.js'`

- [ ] **Step 3: Write the core modules**

`src/core/voice/settings.js`:

```js
/**
 * Settings → Voice (spec §10), with their defaults, from the app settings' "voice" entry.
 * @typedef {{ pauseMs: number, browserVoice: string, rate: number }} VoiceSettings
 *   pauseMs: the pause that ends a sentence (§10.2); browserVoice: the system voice's id ('' for the browser's choice); rate: its speed
 */
export const VOICE_DEFAULTS = Object.freeze({ pauseMs: 700, browserVoice: '', rate: 1 });

/** @param {Record<string, any>} app the app settings @returns {VoiceSettings} */
export function voiceSettings(app) {
  const v = app?.voice ?? {};
  const within = (/** @type {unknown} */ x, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ d) => (typeof x === 'number' && x >= lo && x <= hi ? x : d);
  return {
    pauseMs: within(v.pauseMs, 300, 3000, VOICE_DEFAULTS.pauseMs),
    browserVoice: typeof v.browserVoice === 'string' ? v.browserVoice : VOICE_DEFAULTS.browserVoice,
    rate: within(v.rate, 0.5, 2, VOICE_DEFAULTS.rate),
  };
}
```

`src/core/voice/recorder.js`:

```js
import { Detector } from './detector.js';
import { encodeWav, resample, SEND_RATE } from './pcm.js';
import { newId } from '../scopes.js';

/**
 * The recording side of a listening session (spec §10.2): the microphone is open only while this
 * runs, and the end-of-sentence detector cuts what it hears into segments, each a 16 kHz WAV.
 * @typedef {{ id: string, audio: { data: Uint8Array, mediaType: 'audio/wav', seconds: number }, ms: number, at: number }} Segment
 * @param {{ mic: import('./platform.js').Mic, pauseMs?: number, now?: () => number, onSpeech?: () => void, onLevel?: (x: number) => void,
 *   onSegment: (s: Segment) => void, onDiscard?: () => void, onError?: (e: Error) => void }} c
 * @returns {Promise<{ close(): void }>} close: the mic closes; speech still going on becomes a segment first
 */
export async function record({ mic, pauseMs = 700, now = Date.now, onSpeech, onLevel, onSegment, onDiscard, onError }) {
  /** @type {Detector | null} */
  let detector = null;
  let closed = false;
  /** @param {import('./detector.js').DetectorEvent[]} events */
  const handle = (events) => {
    for (const e of events) {
      if (e.type === 'speech') onSpeech?.();
      else if (e.type === 'discard') onDiscard?.();
      else onSegment({ id: newId('s'), audio: { data: encodeWav(resample(e.pcm, e.sampleRate, SEND_RATE), SEND_RATE), mediaType: 'audio/wav', seconds: e.ms / 1000 }, ms: e.ms, at: now() });
    }
  };
  const open = await mic.open({
    onFrames: (pcm, rate) => {
      if (closed) return;
      if (detector?.sampleRate !== rate) detector = new Detector({ sampleRate: rate, pauseMs });
      handle(detector.push(pcm));
      onLevel?.(detector.level);
    },
    onError: (e) => { if (!closed) onError?.(e); },
  });
  return {
    close() {
      if (closed) return;
      closed = true;
      open.close();
      if (detector) handle(detector.end());
      onLevel?.(0);
    },
  };
}
```

`src/core/voice/voice.js`:

```js
import { readAppSettings } from '../settings.js';
import { SYS } from '../scopes.js';
import { ProviderError } from '../llm/contract.js';
import { COOLDOWN_MS } from '../llm/fallback.js';
import { speechKind } from '../llm/config.js';
import { Speaker, speechOutEntries } from './speaker.js';
import { voicePlatform } from './platform.js';
import { voiceSettings } from './settings.js';
import { record } from './recorder.js';

/**
 * Voice (spec §10): annai's speaking and hearing, for the screens, and in milestone 3b for
 * Shiori. Speech goes through the speech-out list; hearing through the microphone and the
 * end-of-sentence detector. The device side is the voice-browser plugin's.
 * @typedef {import('./speaker.js').Spoken} Spoken
 * @typedef {import('./recorder.js').Segment} Segment
 * @typedef {(level: number, who: 'her' | 'you') => void} LevelListener
 */

/** How long a failed voice rests: what the provider asked for, else the usual cooldown (spec §9.6). @param {unknown} e */
export function restFor(e) {
  return e instanceof ProviderError && e.retryAfter !== undefined ? e.retryAfter : COOLDOWN_MS;
}

export class Voice {
  /** The conversation speech requests are traced in. */
  scope = SYS;
  /** @type {Set<LevelListener>} */
  #levels = new Set();

  /** @param {{ llm: any, ws: import('../workspace.js').Workspace, registry: import('../registry.js').Registry, now?: () => number, locale?: string }} c */
  constructor({ llm, ws, registry, now = Date.now, locale }) {
    this.llm = llm;
    this.ws = ws;
    this.registry = registry;
    this.now = now;
    this.locale = locale;
    this.speaker = new Speaker({
      locale,
      entries: () => this.outEntries(),
      synthesize: async (entry, text, signal) => (await this.llm.synthesize({ modelId: entry.id, text, signal, scope: this.scope })).clip,
      platform: () => this.platform,
      bench: (id, error) => this.llm.bench.bench(id, restFor(error), this.now()),
      browserOptions: async () => {
        const s = voiceSettings(await readAppSettings(this.ws));
        return { voice: s.browserVoice || undefined, rate: s.rate, lang: this.locale };
      },
      onLevel: (x) => this.#level(x, 'her'),
    });
  }

  get platform() {
    return voicePlatform(this.registry);
  }

  /** The glow follows the sound (spec §16.3): her voice, or yours. @param {LevelListener} fn @returns {() => void} */
  onLevel(fn) {
    this.#levels.add(fn);
    return () => this.#levels.delete(fn);
  }

  /** @param {number} x @param {'her' | 'you'} who */
  #level(x, who) {
    for (const fn of this.#levels) {
      try {
        fn(x, who);
      } catch (e) {
        console.warn('a level listener failed', e);
      }
    }
  }

  /** The speech-out entries that can speak now. */
  async outEntries() {
    const cfg = await this.llm.config();
    return speechOutEntries(cfg, { types: this.llm.types(), until: (id) => this.llm.bench.until(id), now: this.now(), browser: Boolean(this.platform?.synth.available()) });
  }

  /** The speech-in list's transcription models, in order. @returns {Promise<string[]>} */
  async transcribers() {
    const cfg = await this.llm.config();
    return (cfg.roles['speech-in']?.models ?? []).filter((/** @type {string} */ id) => speechKind(cfg, this.llm.types(), id) === 'in');
  }

  /** Says a text, start to end, through the speech-out list (Settings → Voice). @param {string} text @returns {Promise<Spoken>} */
  say(text) {
    const u = this.speaker.begin();
    u.end(text);
    return u.done;
  }

  /** One voice's clip of a text, played: that voice's Test. @param {string} modelId @param {string} text */
  async sample(modelId, text) {
    const platform = this.platform;
    if (!platform) throw new Error("This browser can't play sound here.");
    platform.session('transient');
    const { clip } = await this.llm.synthesize({ modelId, text, scope: this.scope });
    return platform.player.play(clip, { signal: new AbortController().signal, onLevel: (x) => this.#level(x, 'her') });
  }

  /**
   * Listens until one segment is heard, or for seconds; null when nothing was (Settings → Voice,
   * and a transcription model's Test). The mic is open only meanwhile (spec §10.2).
   * @param {{ seconds?: number, onSpeech?: () => void, signal?: AbortSignal }} [o] @returns {Promise<Segment | null>}
   */
  async listenOnce({ seconds = 15, onSpeech, signal } = {}) {
    const platform = this.platform;
    if (!platform) throw new Error("This browser can't use the microphone here.");
    const { pauseMs } = voiceSettings(await readAppSettings(this.ws));
    return new Promise((resolve, reject) => {
      /** @type {{ close(): void } | null} */
      let session = null;
      let done = false;
      /** @param {Segment | null} seg @param {unknown} [err] */
      const finish = (seg, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        session?.close();
        platform.session('playback'); // afterwards: full-quality Bluetooth audio again (spec §10.1)
        if (err) reject(err);
        else resolve(seg);
      };
      const timer = setTimeout(() => finish(null), seconds * 1000);
      signal?.addEventListener('abort', () => finish(null), { once: true });
      platform.session('play-and-record');
      record({ mic: platform.mic, pauseMs, now: this.now, onSpeech, onLevel: (x) => this.#level(x, 'you'), onSegment: (s) => finish(s), onError: (e) => finish(null, e) })
        .then((s) => {
          session = s;
          if (done) s.close();
        }, (e) => finish(null, e));
    });
  }

  /** What a transcription model hears in a segment. @param {Segment} segment @param {string} modelId */
  async transcribe(segment, modelId) {
    return (await this.llm.transcribe({ modelId, audio: segment.audio, scope: this.scope })).text;
  }
}
```

In `sw.js`, add `'/src/core/voice/recorder.js',`, `'/src/core/voice/settings.js',`, `'/src/core/voice/voice.js',` with the other `src/core/voice/` files.

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `node --test test/unit/voice-recorder.test.js test/unit/voice-service.test.js`
Expected: PASS, 2 + 5 tests.

- [ ] **Step 5: Write the browser suite (it fails: the plugin doesn't exist yet)**

`test/browser/suites/voice.js`:

```js
import { browserPlatform } from '../../../src/plugins/voice-browser/index.js';
import { encodeWav } from '../../../src/core/voice/pcm.js';
import { record } from '../../../src/core/voice/recorder.js';

/** A tone, as a WAV clip. @param {number} seconds @param {number} [hz] */
const tone = (seconds, hz = 440) => encodeWav(Float32Array.from({ length: Math.round(seconds * 16000) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / 16000)), 16000);

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('the player plays a clip to its end, and its loudness reaches the glow', async () => {
    /** @type {number[]} */
    const levels = [];
    const r = await browserPlatform().player.play({ data: tone(0.4), mediaType: 'audio/wav' }, { signal: new AbortController().signal, onLevel: (x) => levels.push(x) });
    assert.equal(r.ended, true);
    assert.ok(levels.some((x) => x > 0.5), `levels: ${levels.slice(0, 8).join(', ')}`);
    assert.equal(levels.at(-1), 0);
  });

  test('a stop ends playing at once, and says how much was heard', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 400);
    const r = await browserPlatform().player.play({ data: tone(2), mediaType: 'audio/wav' }, { signal: stop.signal });
    assert.equal(r.ended, false);
    assert.ok(r.fraction > 0.05 && r.fraction < 0.6, `fraction ${r.fraction}`);
  });

  test('the microphone, through the AudioWorklet and the detector, gives a segment', async () => {
    // A fake microphone: half a second of nothing, then 1.2 s of a tone that rises and falls like syllables.
    const ctx = new AudioContext();
    await ctx.resume();
    const out = ctx.createMediaStreamDestination();
    const carrier = ctx.createOscillator();
    carrier.frequency.value = 500;
    const syllables = ctx.createOscillator();
    syllables.frequency.value = 5;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    const am = ctx.createGain();
    am.gain.value = 0.5;
    const envelope = ctx.createGain();
    const t = ctx.currentTime;
    envelope.gain.setValueAtTime(0, t);
    envelope.gain.setValueAtTime(0.6, t + 0.5);
    envelope.gain.setValueAtTime(0, t + 1.7);
    syllables.connect(depth).connect(am.gain);
    carrier.connect(am).connect(envelope).connect(out);
    carrier.start();
    syllables.start();
    const real = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => out.stream;
    try {
      const seg = await new Promise((resolve, reject) => {
        record({ mic: browserPlatform().mic, onSegment: resolve, onError: reject })
          .then((s) => setTimeout(() => { s.close(); reject(new Error('no segment within 6 s')); }, 6000), reject);
      });
      assert.equal(new TextDecoder().decode(/** @type {any} */ (seg).audio.data.subarray(0, 4)), 'RIFF');
      assert.ok(/** @type {any} */ (seg).ms > 700 && /** @type {any} */ (seg).ms < 2600, `${/** @type {any} */ (seg).ms} ms`);
    } finally {
      navigator.mediaDevices.getUserMedia = real;
      await ctx.close();
    }
  });

  test('the browser voice and dictation say whether this browser has them; the audio session never throws', async () => {
    const p = browserPlatform();
    assert.equal(p.synth.available(), typeof speechSynthesis !== 'undefined');
    assert.equal(p.dictation.available(), Boolean(/** @type {any} */ (window).SpeechRecognition || /** @type {any} */ (window).webkitSpeechRecognition));
    p.session('transient');
    p.session('play-and-record');
    p.session('playback');
    assert.ok(Array.isArray(p.synth.voices()));
  });
}
```

In `test/e2e/browser-suites.spec.js`, change the list to `['store-idb', 'platform', 'photo-codec', 'voice']`.

Run: `npx playwright test test/e2e/browser-suites.spec.js --project=chromium -g voice`
Expected: FAIL (the suite can't load `src/plugins/voice-browser/index.js`).

- [ ] **Step 6: Write the device side**

`src/plugins/voice-browser/capture-worklet.js`:

```js
/**
 * The microphone's samples, from the audio thread to the page in batches of 2048 (about 40 ms at
 * 48 kHz): an AudioWorklet captures PCM (spec §10.2). Loaded by the voice-browser plugin with
 * addModule, from annai's own origin (the security policy allows only 'self').
 */
const scope = /** @type {any} */ (globalThis);

class Capture extends scope.AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.n = 0;
  }

  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.batch[this.n++] = channel[i];
        if (this.n === this.batch.length) {
          this.port.postMessage(this.batch, [this.batch.buffer]);
          this.batch = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

scope.registerProcessor('annai-capture', Capture);
```

`src/plugins/voice-browser/index.js`:

```js
import { encodeWav } from '../../core/voice/pcm.js';

/**
 * The device side of voice (spec §10), a built-in plugin (§19): one audio player for every voice
 * clip, unlocked by the first tap of each session (an iPhone rule, §10.1); the browser's own
 * voice; the microphone, through an AudioWorklet (§10.2); the phone's dictation; and the audio
 * session type where the browser has one (Safari). The core reaches it as 'voice-platform'.
 * @typedef {import('../../core/voice/platform.js').VoicePlatform} VoicePlatform
 */
export const manifest = { id: 'voice-browser', name: 'Voice on this device', version: '0.1.0', api: 1, description: "The phone's speaker, microphone, voice and dictation." };

/** @param {any} annai */
export function activate(annai) {
  return annai.register('voice-platform', browserPlatform());
}

/** @returns {VoicePlatform} */
export function browserPlatform() {
  /** @type {AudioContext | null} */
  let ctx = null;
  const context = () => (ctx ??= new AudioContext());
  /** @type {HTMLAudioElement | null} */
  let element = null;
  const player = () => (element ??= new Audio());
  /** @type {Promise<void> | null} */
  let worklet = null;

  /**
   * The clip's loudness every 50 ms, 0..1, for the glow (spec §16.3), read with Web Audio's
   * decoder: playback itself stays on the audio element. @param {{ data: Uint8Array }} clip
   */
  async function envelope(clip) {
    const buf = await context().decodeAudioData(clip.data.slice().buffer);
    const ch = buf.getChannelData(0);
    const step = Math.max(1, Math.round(buf.sampleRate * 0.05));
    /** @type {number[]} */
    const rms = [];
    for (let i = 0; i < ch.length; i += step) {
      let s = 0;
      const end = Math.min(ch.length, i + step);
      for (let j = i; j < end; j++) s += ch[j] * ch[j];
      rms.push(Math.sqrt(s / (end - i)));
    }
    const peak = Math.max(1e-6, ...rms);
    return rms.map((x) => Math.min(1, x / peak));
  }

  return {
    player: {
      async unlock() {
        // The first tap of each session: the player, the microphone's context and the browser voice may start.
        try {
          const a = player();
          a.src = URL.createObjectURL(new Blob([encodeWav(new Float32Array(800), 16000)], { type: 'audio/wav' }));
          await a.play();
        } catch {
          // a later tap tries again
        }
        await context().resume().catch(() => {});
        try {
          const quiet = new SpeechSynthesisUtterance(' ');
          quiet.volume = 0;
          speechSynthesis.speak(quiet);
        } catch {
          // no browser voice here
        }
      },
      async play(clip, { signal, onLevel = () => {} }) {
        if (signal.aborted) return { ended: false, fraction: 0 };
        const a = player();
        const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (clip.data)], { type: clip.mediaType }));
        /** @type {number[] | null} */
        let levels = null;
        envelope(clip).then((l) => { levels = l; }, () => {});
        /** @type {ReturnType<typeof setInterval> | undefined} */
        let ticker;
        try {
          a.src = url;
          await a.play(); // a NotAllowedError: the page may not play sound yet
          if (signal.aborted) {
            a.pause();
            return { ended: false, fraction: 0 };
          }
          ticker = setInterval(() => { if (levels) onLevel(levels[Math.floor(a.currentTime / 0.05)] ?? 0); }, 50);
          return await new Promise((resolve, reject) => {
            a.onended = () => resolve({ ended: true, fraction: 1 });
            a.onerror = () => reject(new Error("The voice's audio couldn't be played."));
            signal.addEventListener('abort', () => {
              const fraction = a.duration > 0 ? a.currentTime / a.duration : 0;
              a.pause();
              resolve({ ended: false, fraction });
            }, { once: true });
          });
        } finally {
          clearInterval(ticker);
          a.onended = null;
          a.onerror = null;
          onLevel(0);
          URL.revokeObjectURL(url);
        }
      },
    },
    synth: {
      available: () => typeof speechSynthesis !== 'undefined',
      voices: () => (typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices().map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang }))),
      say(text, { signal, voice, rate = 1, lang, onLevel = () => {} }) {
        return new Promise((resolve, reject) => {
          const u = new SpeechSynthesisUtterance(text);
          const chosen = voice ? speechSynthesis.getVoices().find((v) => v.voiceURI === voice) : undefined;
          if (chosen) u.voice = chosen;
          else if (lang) u.lang = lang;
          u.rate = rate;
          let charIndex = 0;
          let level = 0;
          let settled = false;
          // The browser voice gives no audio to measure: the glow pulses with each word (spec §16.3).
          const pulse = setInterval(() => { level = Math.max(0.3, level * 0.7); onLevel(level); }, 60);
          // Some voices never say they finished: a generous limit ends the wait.
          const limit = setTimeout(() => finish({ ended: true, charIndex: text.length }), 4000 + text.length * 150);
          /** @param {{ ended: boolean, charIndex: number } | null} r @param {Error} [err] */
          const finish = (r, err) => {
            if (settled) return;
            settled = true;
            clearInterval(pulse);
            clearTimeout(limit);
            onLevel(0);
            if (err || !r) reject(err);
            else resolve(r);
          };
          u.onboundary = (e) => {
            if (!e.name || e.name === 'word') {
              charIndex = e.charIndex;
              level = 0.8;
            }
          };
          u.onend = () => finish(signal.aborted ? { ended: false, charIndex } : { ended: true, charIndex: text.length });
          u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? finish({ ended: false, charIndex }) : finish(null, new Error(`The browser voice couldn't speak (${e.error}).`)));
          signal.addEventListener('abort', () => {
            speechSynthesis.cancel();
            finish({ ended: false, charIndex });
          }, { once: true });
          speechSynthesis.speak(u);
        });
      },
    },
    mic: {
      async open({ onFrames, onError }) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        try {
          const c = context();
          if (c.state !== 'running') await c.resume().catch(() => {});
          worklet ??= c.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url).href);
          try {
            await worklet;
          } catch (e) {
            worklet = null;
            throw e;
          }
          const source = c.createMediaStreamSource(stream);
          const node = new AudioWorkletNode(c, 'annai-capture');
          const silent = c.createGain();
          silent.gain.value = 0;
          node.port.onmessage = (e) => onFrames(e.data, c.sampleRate);
          source.connect(node);
          node.connect(silent).connect(c.destination); // some browsers run a node only when it leads somewhere
          for (const t of stream.getAudioTracks()) t.onended = () => onError(new Error('The microphone stopped.'));
          return {
            close() {
              node.port.onmessage = null;
              for (const t of stream.getTracks()) {
                t.onended = null;
                t.stop();
              }
              source.disconnect();
              node.disconnect();
              silent.disconnect();
            },
          };
        } catch (e) {
          for (const t of stream.getTracks()) t.stop();
          throw e;
        }
      },
    },
    dictation: {
      available: () => Boolean(/** @type {any} */ (globalThis).SpeechRecognition || /** @type {any} */ (globalThis).webkitSpeechRecognition),
      open({ lang, onSegment, onSpeech, onError }) {
        const Recognition = /** @type {any} */ (globalThis).SpeechRecognition ?? /** @type {any} */ (globalThis).webkitSpeechRecognition;
        const r = new Recognition();
        r.continuous = true;
        r.interimResults = true;
        r.lang = lang || navigator.language;
        let closed = false;
        r.onspeechstart = () => onSpeech?.();
        r.onresult = (/** @type {any} */ e) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            const text = res.isFinal ? String(res[0]?.transcript ?? '').trim() : '';
            if (text) onSegment(text);
          }
        };
        r.onerror = (/** @type {any} */ e) => {
          if (e.error === 'no-speech' || e.error === 'aborted') return;
          closed = true;
          onError(Object.assign(new Error(`Phone dictation stopped (${e.error}).`), { code: String(e.error) }));
        };
        // Dictation ends by itself after a silence; while listening goes on, it starts again.
        r.onend = () => {
          if (closed) return;
          try {
            r.start();
          } catch {
            // started too soon: the next end tries again
          }
        };
        r.start();
        return {
          close() {
            closed = true;
            try {
              r.abort();
            } catch {
              // already stopped
            }
          },
        };
      },
    },
    session(type) {
      // Where the browser has one (Safari): transient while speaking, play-and-record while listening, playback after (spec §10.1).
      try {
        const s = /** @type {any} */ (navigator).audioSession;
        if (s && s.type !== type) s.type = type;
      } catch {
        // not here
      }
    },
  };
}
```

In `sw.js`, add `'/src/plugins/voice-browser/capture-worklet.js',` and `'/src/plugins/voice-browser/index.js',` to `SHELL` after `'/src/plugins/places/index.js',` (and before `'/src/plugins/web/index.js',`).

- [ ] **Step 7: Start it with the app, and unlock audio on the first tap**

In `src/app/main.js`:
- import `Voice` from `'../core/voice/voice.js'`;
- after `await plugins.addBuiltin(new URL('../plugins/go/index.js', import.meta.url).href);`, add:

```js
  await plugins.addBuiltin(new URL('../plugins/voice-browser/index.js', import.meta.url).href);
```

- after the `llm` is created, add:

```js
  // Speaking and hearing (spec §10): the speech lists, through this device's player and microphone.
  const voice = new Voice({ llm, ws, registry, locale: navigator.language });
  // The first tap of each session unlocks the audio player (an iPhone rule, spec §10.1).
  const unlock = () => { voice.platform?.player.unlock(); };
  addEventListener('pointerdown', unlock, { once: true, capture: true });
  addEventListener('keydown', unlock, { once: true, capture: true });
```

- pass `voice` to `startShell` (add it to the object next to `agent`).

In `src/ui/shell.js`, add `voice?: any` to `startShell`'s `core` parameter type (it reaches screens as `ctx.voice` through `...core`).

- [ ] **Step 8: Run the browser suite and the unit tests**

Run: `npx playwright test test/e2e/browser-suites.spec.js --project=chromium -g voice`
Expected: PASS.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/browser-suites.spec.js --project=webkit -g voice`
Expected: PASS.
Run: `npm test 2>&1 | tail -3`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
npm run stamp && npm run check && git add src/core/voice src/plugins/voice-browser src/app/main.js src/ui/shell.js test/unit/voice-recorder.test.js test/unit/voice-service.test.js test/browser/suites/voice.js test/e2e/browser-suites.spec.js sw.js && git commit -m "The device side of voice: one audio player unlocked by the first tap, the browser voice, the microphone through an AudioWorklet, dictation; and the Voice service (spec §10.1, §10.2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 7: Speech lists and speech models on the Models screen

**Files:**
- Create: `src/ui/speech-check.js`, `src/ui/mic-help.js`, `test/e2e/voice-parts.spec.js`
- Modify: `src/ui/screens/models.js`, `src/ui/screens/endpoint.js`, `src/ui/screens/model.js`, `test/e2e/helpers.js`, `sw.js`
- Test: `test/e2e/voice-parts.spec.js` (two tests), `test/unit/ui-pure.test.js` (`micProblem`, `priceLine`)

**Interfaces:**
- Consumes: `STAND_INS`, `SPEECH_ROLES`, `speechKind` (Task 3); `ctx.voice.sample`, `ctx.voice.listenOnce`, `ctx.voice.transcribe`, `ctx.voice.onLevel` (Task 6).
- Produces:
  - `speech-check.js`: `SAMPLE` (the sample sentence), `speechProblem(e): string`, `speechTestPanel(ctx, model, kind: 'in' | 'out', verified, title?): HTMLElement`. A test's outcome is kept on the model as `verified.speech` (true or false) and `verified.at`.
  - `mic-help.js`: `micProblem(e, where?: 'ios' | 'android' | 'desktop'): { title, body }`.
  - `endpoint.js` exports `priceLine(prices): string | null` (speech prices too).
  - The roles section has blocks "Speech in: how Shiori hears you" and "Speech out: Shiori's voice"; their controls are labelled `Add a model to speech-in` / `Add to speech-in` (and `speech-out`), and stand-ins read as `Send audio to the model`, `Phone dictation`, `Browser voice`.
  - `test/e2e/helpers.js`: `fakeMicrophone(page, wavPaths)` (each opening of the microphone plays the next clip, the last repeating; `window.__micOpens` counts them); `startModelServer` keeps a body that isn't JSON as a `Buffer`, and a route's `body` may be a `Buffer`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/ui-pure.test.js` (with the other imports at the top: `import { micProblem } from '../../src/ui/mic-help.js';` and `import { priceLine } from '../../src/ui/screens/endpoint.js';`):

```js
test('a microphone that fails says what happened and what to do, for this phone (spec §17 rule 3)', () => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  assert.match(micProblem(denied, 'ios').body, /Settings → Apps → Safari → Microphone/);
  assert.match(micProblem(denied, 'android').body, /App info → Permissions/);
  assert.match(micProblem(denied, 'desktop').body, /site settings/);
  assert.equal(micProblem(Object.assign(new Error('x'), { name: 'NotFoundError' })).title, 'No microphone found');
  assert.equal(micProblem(Object.assign(new Error('x'), { name: 'NotReadableError' })).title, 'The microphone is busy');
  assert.match(micProblem(new Error('Weird')).body, /^Weird\. Try again/);
});

test('model prices in a line: tokens, minutes of speech, or characters', () => {
  assert.equal(priceLine({ input: 2, output: 10 }), '$2 in, $10 out per million tokens');
  assert.equal(priceLine({ input: 0, output: 0 }), 'free');
  assert.equal(priceLine({ perMinute: 0.006 }), '$0.006 a minute of speech');
  assert.equal(priceLine({ perMillionChars: 15 }), '$15 per million characters');
  assert.equal(priceLine(null), null);
});
```

(`ui-pure.test.js` runs in Node, where `src/ui/screens/endpoint.js` imports only DOM-free modules at load time; if it doesn't load there, move `priceLine` into `src/ui/format.js` instead, export it from there, and import it in `endpoint.js`: that is the ruling to make.)

In `test/e2e/helpers.js`, add `import { readFile } from 'node:fs/promises';` at the top, and add:

```js
/**
 * A fake microphone fed from WAV files (spec §18). Each time annai opens the microphone it hears
 * the next clip (the last one repeats), 0.4 s after opening, then silence. getUserMedia gives a
 * stream played by Web Audio, which works the same in Chromium and WebKit. window.__micOpens
 * counts the openings.
 * @param {import('@playwright/test').Page} page @param {string[]} clips paths of WAV files
 */
export async function fakeMicrophone(page, clips) {
  const data = await Promise.all(clips.map(async (p) => (await readFile(p)).toString('base64')));
  await page.addInitScript((wavs) => {
    const w = /** @type {any} */ (window);
    w.__micOpens = 0;
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = async () => {
      const b64 = wavs[Math.min(w.__micOpens, wavs.length - 1)];
      w.__micOpens++;
      const ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const source = ctx.createBufferSource();
      source.buffer = await ctx.decodeAudioData(bytes.buffer);
      const out = ctx.createMediaStreamDestination();
      source.connect(out);
      source.start(ctx.currentTime + 0.4);
      for (const t of out.stream.getTracks()) {
        const stop = t.stop.bind(t);
        t.stop = () => { stop(); ctx.close().catch(() => {}); };
      }
      return out.stream;
    };
  }, data);
}
```

In `startModelServer`, change the route type to allow `body: string | Buffer` (both places in the `@param`), and replace the `if (req.method === 'POST') { try { … } catch { … } }` block with:

```js
      if (req.method === 'POST') {
        const raw = Buffer.concat(chunks);
        /** @type {any} */
        let body = raw;
        try {
          body = JSON.parse(raw.toString('utf8') || 'null');
        } catch {
          // not JSON (a multipart upload): kept as bytes
        }
        received.set(path, [...(received.get(path) ?? []), body]);
      }
```

and update its comment: "bodies(path) gives what was posted: parsed JSON, or the bytes."

`test/e2e/voice-parts.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, fakeMicrophone } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

const clipPath = (/** @type {string} */ name) => fileURLToPath(new URL(`../fixtures/voice/${name}.wav`, import.meta.url));
/** The stand-in voice's clip: a 0.3 s tone. */
const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };
/** @param {import('@playwright/test').Page} page @param {string} heading */
const roleItems = (page, heading) => page.locator('.role', { has: page.getByRole('heading', { name: heading }) }).locator('.role-item > span');

test("a voice in the speech-out list: added, put first, and its Test plays a sample (spec §9.6, §10.1)", async ({ page }) => {
  const speech = await startModelServer({ '/v1/audio/speech': wav });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addEndpoint(page, 'Other: OpenAI-compatible voice', { name: 'Stand-in voice', url: `${speech.origin}/v1`, key: 'sk-voice-test', model: 'tts-test' });
    await expect(roleItems(page, "Speech out: Shiori's voice")).toHaveText(['1. Browser voice (works offline)']);
    await expect(roleItems(page, 'Speech in: how Shiori hears you')).toHaveText(['1. Send audio to the model (when the model takes audio)', "2. Phone dictation (the phone's own, where it has one)"]);
    await expect(page.getByLabel('Add a model to main').locator('option', { hasText: 'tts-test' })).toHaveCount(0);
    await page.getByLabel('Add a model to speech-out').selectOption({ label: 'tts-test' });
    await page.getByRole('button', { name: 'Add to speech-out' }).click();
    await page.getByRole('button', { name: 'Move tts-test up' }).click();
    await expect(roleItems(page, "Speech out: Shiori's voice")).toHaveText(['1. tts-test', '2. Browser voice (works offline)']);
    await page.getByRole('link', { name: /Stand-in voice/ }).click();
    await page.getByRole('link', { name: /^tts-test/ }).click();
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect(page.getByText('It works: that was this voice.')).toBeVisible();
    const [body] = speech.bodies('/v1/audio/speech');
    expect(body).toMatchObject({ model: 'tts-test', voice: 'marin', response_format: 'mp3' });
    expect(body.input).toContain('This is how I sound');
    expect(JSON.stringify(await page.content())).not.toContain('sk-voice-test');
  } finally {
    await speech.stop();
  }
});

test("a transcription model's Test: you say something and it writes it down (spec §10.2)", async ({ page }) => {
  const asr = await startModelServer({ '/v1/audio/transcriptions': { status: 200, type: 'application/json', body: JSON.stringify({ text: 'Where should we stop for lunch?' }) } });
  try {
    await fakeMicrophone(page, [clipPath('where-lunch')]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addEndpoint(page, 'Other: OpenAI-compatible transcription', { name: 'Stand-in ears', url: `${asr.origin}/v1`, key: 'sk-asr-test', model: 'asr-test' });
    await page.getByRole('link', { name: /Stand-in ears/ }).click();
    await page.getByRole('link', { name: /^asr-test/ }).click();
    await page.getByRole('button', { name: 'Say something' }).click();
    await expect(page.getByText('It heard: "Where should we stop for lunch?"')).toBeVisible({ timeout: 20_000 });
    const [body] = asr.bodies('/v1/audio/transcriptions');
    const raw = Buffer.from(body).toString('latin1');
    expect(raw).toContain('name="model"');
    expect(raw).toContain('asr-test');
    expect(raw).toContain('RIFF');
    expect(await page.evaluate(() => /** @type {any} */ (window).__micOpens)).toBe(1);
  } finally {
    await asr.stop();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/ui-pure.test.js`
Expected: FAIL with `Cannot find module '…/src/ui/mic-help.js'`
Run: `npx playwright test test/e2e/voice-parts.spec.js --project=chromium`
Expected: FAIL: no "Speech out: Shiori's voice" heading.

- [ ] **Step 3: Write the implementation**

`src/ui/mic-help.js`:

```js
import { platform } from './platform.js';

/**
 * What went wrong with the microphone, in plain words, with steps for this phone (spec §17 rule 3).
 * @param {unknown} e @param {'ios' | 'android' | 'desktop'} [where] @returns {{ title: string, body: string }}
 */
export function micProblem(e, where = platform()) {
  const name = /** @type {any} */ (e)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    const steps = where === 'ios'
      ? 'On iPhone: open Settings → Apps → Safari → Microphone, choose Ask or Allow, then come back and try again.'
      : where === 'android'
        ? 'On Android: tap the icon left of the address (in the installed app: hold the annai icon, then App info → Permissions), allow the microphone, then try again.'
        : "Allow the microphone for this site in your browser's site settings, then try again.";
    return { title: "annai can't use the microphone", body: `It wasn't allowed. ${steps}` };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { title: 'No microphone found', body: 'This device has no microphone annai can use. Connect one, or type to Shiori instead.' };
  if (name === 'NotReadableError' || name === 'AbortError') return { title: 'The microphone is busy', body: 'Another app is using it, such as a call or a voice recorder. Close it, then try again.' };
  return { title: "The microphone didn't start", body: `${String(/** @type {any} */ (e)?.message ?? e).replace(/\.$/, '')}. Try again; if it keeps happening, restart annai.` };
}
```

`src/ui/speech-check.js`:

```js
import { h } from './dom.js';
import { relTime } from './format.js';
import { ProviderError, explain } from '../core/llm/contract.js';
import { saveModel } from '../core/llm/config.js';
import { micProblem } from './mic-help.js';

/** What a voice says when it is tested. */
export const SAMPLE = 'Hello! This is how I sound when I talk to you.';

/** A speech call that failed, in plain words with what to do next. @param {unknown} e */
export function speechProblem(e) {
  if (e instanceof ProviderError) return explain(e);
  const p = micProblem(e);
  return /** @type {any} */ (e)?.name && /** @type {any} */ (e).name !== 'Error' ? `${p.title}. ${p.body}` : String(/** @type {any} */ (e)?.message ?? e);
}

/**
 * A speech model's Test (spec §9.8): a voice plays a sample; a transcription model hears you say
 * something and writes it down. Whether it worked is kept on the model.
 * @param {any} ctx @param {import('../core/llm/config.js').Model} model @param {'in' | 'out'} kind
 * @param {Record<string, any> | undefined} verified @param {string} [title]
 */
export function speechTestPanel(ctx, model, kind, verified, title = 'Test') {
  const status = h('p', { class: 'sub', role: 'status', text: verified?.at ? `Last tested ${relTime(verified.at)}: ${verified.speech ? 'it worked' : "it didn't work"}.` : 'Not tested yet.' });
  const meter = h('meter', { min: '0', max: '1', value: '0', 'aria-label': 'How loud the microphone hears you', hidden: kind === 'out' });
  const mark = async (/** @type {boolean} */ ok) => {
    const rec = (await ctx.llm.config()).models[model.id];
    if (rec) await saveModel(ctx.ws, { ...rec, verified: { ...(rec.verified ?? {}), speech: ok, at: Date.now() } });
  };
  const run = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      run.disabled = true;
      try {
        if (kind === 'out') {
          status.textContent = 'Playing a sample…';
          const r = await ctx.voice.sample(model.id, SAMPLE);
          status.textContent = r.ended ? 'It works: that was this voice.' : 'The sample stopped early.';
          await mark(true);
          return;
        }
        status.textContent = 'Say something, such as "Where should we stop for lunch?"';
        const off = ctx.voice.onLevel((/** @type {number} */ x, /** @type {string} */ who) => { if (who === 'you') meter.value = x; });
        try {
          const seg = await ctx.voice.listenOnce({ seconds: 12, onSpeech: () => { status.textContent = 'Hearing you…'; } });
          if (!seg) {
            status.textContent = 'Nothing was heard in 12 seconds. Check that the microphone is on, then try again.';
            return;
          }
          status.textContent = 'Writing it down…';
          const text = await ctx.voice.transcribe(seg, model.id);
          status.textContent = text ? `It heard: "${text}"` : 'It heard speech but wrote nothing down. Try again, a little closer to the phone.';
          await mark(Boolean(text));
        } finally {
          off();
          meter.value = 0;
        }
      } catch (e) {
        status.textContent = speechProblem(e);
        if (e instanceof ProviderError) await mark(false);
      } finally {
        run.disabled = false;
      }
    },
  }, kind === 'out' ? 'Play a sample' : 'Say something');
  return h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), h('div', { class: 'acts' }, run), meter, status);
}
```

In `src/ui/screens/endpoint.js`:
- `export` `priceLine`, and replace its body with:

```js
export function priceLine(prices) {
  if (!prices) return null;
  if (typeof prices.perMinute === 'number') return `$${prices.perMinute} a minute of speech`;
  if (typeof prices.perMillionChars === 'number') return `$${prices.perMillionChars} per million characters`;
  if (!prices.input && !prices.output) return 'free';
  return `$${prices.input ?? '?'} in, $${prices.output ?? '?'} out per million tokens`;
}
```

- import `speechTestPanel` from `'../speech-check.js'`, and replace the line `models[0] ? testPanel(ctx, models[0].id, cfg.models[models[0].id].verified, \`Test ${models[0].name}\`) : null,` with:

```js
    models[0] && type?.speech ? speechTestPanel(ctx, models[0], type.speech, cfg.models[models[0].id].verified, `Test ${models[0].name}`) : null,
    models[0] && !type?.speech ? testPanel(ctx, models[0].id, cfg.models[models[0].id].verified, `Test ${models[0].name}`) : null,
```

In `src/ui/screens/model.js`, import `speechTestPanel` from `'../speech-check.js'`; in `renderModel`, after `const ep = endpointOf(…)` and `const back = …`, add:

```js
  const speech = ctx.llm.types().get(epRec.type)?.speech;
  if (speech === 'in' || speech === 'out') return renderSpeechModel(ctx, rec, speech, ep, back);
```

and add:

```js
/**
 * A transcription model or a voice (spec §9.2, §10): its name, id, voice, prices and Test.
 * @param {any} ctx @param {import('../../core/llm/config.js').ModelRecord} rec @param {'in' | 'out'} kind
 * @param {import('../../core/llm/config.js').Endpoint} ep @param {string} back
 */
function renderSpeechModel(ctx, rec, kind, ep, back) {
  const m = modelOf(rec);
  const base = modelBase(rec);
  const status = h('p', { class: 'sub', role: 'status' });
  const name = h('input', { id: 'model-name', autocomplete: 'off', value: m.name });
  const providerId = h('input', { id: 'model-provider-id', autocomplete: 'off', autocapitalize: 'off', value: m.providerId });
  const { voice: voiceId, ...otherTunables } = m.tunables;
  const voice = kind === 'out' ? h('input', { id: 'model-voice', autocomplete: 'off', autocapitalize: 'off', value: String(voiceId ?? ''), placeholder: String(ep.tunables.voice ?? '') }) : null;
  const prices = jsonField(kind === 'in' ? 'Prices, USD (JSON: perMinute, minSeconds)' : 'Prices, USD (JSON: perMillionChars)', 'model-prices', m.prices ?? {});
  const tunables = jsonField('Tunables (JSON)', 'model-tunables', otherTunables);
  const extra = jsonField('Extra request fields (JSON)', 'model-extra', m.extraBody);
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      try {
        const pid = providerId.value.trim();
        const p = prices.read();
        const t = tunables.read();
        if (voice?.value.trim()) t.voice = voice.value.trim();
        const edited = { name: name.value.trim() === pid ? base.name : name.value.trim(), providerId: pid, prices: Object.keys(p).length ? p : null, tunables: t, extraBody: extra.read() };
        await saveModel(ctx.ws, { ...rec, user: diffLayer(edited, base) });
        ctx.llm.bench.clear(rec.id);
        ctx.notices.toast('Saved');
        ctx.render();
      } catch (err) {
        status.textContent = messageOf(err);
      }
    },
  }, 'Save');
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: back }, `← ${ep.name}`)),
    h('h1', { class: 'title', text: m.name }),
    h('p', { class: 'sub', text: kind === 'in' ? 'A transcription model: it turns what you say into text.' : 'A voice: Shiori speaks with it.' }),
    h('section', { class: 'panel', 'aria-label': 'Model' },
      field('Name', name), field('Provider model id', providerId), voice ? field('Voice', voice) : null,
      prices.el, tunables.el, extra.el, h('div', { class: 'acts' }, save), status),
    speechTestPanel(ctx, m, kind, rec.verified),
    h('div', { class: 'acts' }, twoStep('Remove model', 'Tap again to remove it', async () => {
      await removeModel(ctx.ws, rec.id);
      ctx.go(back);
    })));
}
```

In `src/ui/screens/models.js`:
- import `STAND_INS`, `SPEECH_ROLES`, `speechKind` from the config module;
- add to `ROLE_NAMES`: `'speech-in': 'Speech in: how Shiori hears you', 'speech-out': "Speech out: Shiori's voice"`;
- add:

```js
/** What each stand-in entry is (spec §10.1, §10.3). @type {Record<string, string>} */
const STAND_IN_NOTES = { 'send-audio': 'when the model takes audio', dictation: "the phone's own, where it has one", 'browser-voice': 'works offline' };
```

- replace `rolesSection` with:

```js
/** @param {any} ctx @param {import('../../core/llm/config.js').ModelConfig} cfg */
function rolesSection(ctx, cfg) {
  const types = ctx.llm.types();
  const models = Object.values(cfg.models).map(modelOf);
  const kind = (/** @type {string} */ id) => speechKind(cfg, types, id);
  const nameOf = (/** @type {string} */ id) => STAND_INS[id]?.name ?? models.find((m) => m.id === id)?.name ?? id;
  const save = async (/** @type {import('../../core/llm/config.js').Roles} */ roles) => {
    await saveRoles(ctx.ws, roles);
    ctx.render();
  };
  /** A speech list can take its own stand-ins and the models of its direction. @param {string} role */
  const speechChoices = (role) => [
    ...Object.entries(STAND_INS).filter(([, s]) => s.role === role).map(([id, s]) => ({ id, name: s.name })),
    ...models.filter((m) => kind(m.id) === (role === 'speech-in' ? 'in' : 'out')),
  ];
  return h('section', { class: 'panel', 'aria-label': 'Roles' },
    h('h2', { class: 'section', text: 'Roles' }),
    h('p', { class: 'sub', text: 'Each role tries its models from the top. When one fails, the next one answers. An empty role uses the main list.' }),
    ...CHAT_ROLES.map((role) => roleBlock(role, cfg.roles, models.filter((m) => !kind(m.id)), nameOf, save)),
    h('p', { class: 'sub', text: 'The speech lists are tried from the top too: the first entry that works for the model hearing you, and the first voice that answers.' }),
    ...SPEECH_ROLES.map((role) => roleBlock(role, cfg.roles, speechChoices(role), nameOf, save, { speech: true })));
}
```

- replace `roleBlock`'s signature and body with:

```js
/**
 * @param {string} role @param {import('../../core/llm/config.js').Roles} roles @param {{ id: string, name: string }[]} choices what can be added
 * @param {(id: string) => string} nameOf @param {(roles: any) => Promise<void>} save @param {{ speech?: boolean }} [o]
 */
function roleBlock(role, roles, choices, nameOf, save, { speech = false } = {}) {
  const r = roles[role];
  /** @param {number} i @param {number} by */
  const moved = (i, by) => {
    const list = r.models.slice();
    [list[i], list[i + by]] = [list[i + by], list[i]];
    return { ...roles, [role]: { ...r, models: list } };
  };
  const items = r.models.map((id, i) => h('li', { class: 'role-item' },
    h('span', { text: `${i + 1}. ${nameOf(id)}${STAND_IN_NOTES[id] ? ` (${STAND_IN_NOTES[id]})` : ''}` }),
    h('button', { class: 'btn ghost', type: 'button', 'aria-label': `Move ${nameOf(id)} up`, disabled: i === 0, onclick: () => save(moved(i, -1)) }, '↑'),
    h('button', { class: 'btn ghost', type: 'button', 'aria-label': `Move ${nameOf(id)} down`, disabled: i === r.models.length - 1, onclick: () => save(moved(i, 1)) }, '↓'),
    h('button', { class: 'btn ghost', type: 'button', 'aria-label': `Remove ${nameOf(id)} from ${role}`, onclick: () => save({ ...roles, [role]: { ...r, models: r.models.filter((_, j) => j !== i) } }) }, '✕')));
  const others = choices.filter((m) => !r.models.includes(m.id));
  const pick = h('select', { id: `role-${role}-add` }, ...others.map((m) => h('option', { value: m.id, text: m.name })));
  const level = speech ? null : h('select', { id: `role-${role}-level`, onchange: () => save({ ...roles, [role]: { ...r, level: level.value } }) }, ...LEVELS.map((l) => h('option', { value: l, text: l })));
  if (level) level.value = r.level;
  const wait = h('input', {
    id: `role-${role}-wait`, inputmode: 'numeric', placeholder: speech ? (role === 'speech-in' ? '15' : '10') : '30', value: r.firstOutputSeconds ?? '',
    onchange: () => {
      const n = Math.round(Number(wait.value));
      const { firstOutputSeconds: _, ...rest } = r;
      save({ ...roles, [role]: wait.value.trim() && n >= 1 && n <= 600 ? { ...rest, firstOutputSeconds: n } : rest });
    },
  });
  const empty = role === 'main' ? 'No models yet. Add one.'
    : role === 'speech-in' ? "Nothing here, so annai can't hear you. Add an entry."
      : role === 'speech-out' ? "Nothing here, so Shiori can't speak aloud. Add a voice."
        : 'Uses the main list.';
  const waitLabel = role === 'speech-in' ? 'Wait for the words (seconds)' : role === 'speech-out' ? 'Wait for the voice (seconds)' : 'Wait for the first words (seconds)';
  return h('div', { class: 'role' },
    h('h3', { class: 'role-name', text: ROLE_NAMES[role] ?? role }),
    items.length ? h('ol', { class: 'role-list' }, ...items) : h('p', { class: 'sub', text: empty }),
    h('div', { class: 'row' },
      others.length ? field(`Add a model to ${role}`, pick) : null,
      others.length ? h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => save({ ...roles, [role]: { ...r, models: [...r.models, pick.value] } }) }, `Add to ${role}`)) : null,
      level ? field(`Reasoning for ${role}`, level) : null,
      field(waitLabel, wait)));
}
```

In `sw.js`, add `'/src/ui/mic-help.js',` and `'/src/ui/speech-check.js',` to `SHELL` in the `src/ui/` part.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/ui-pure.test.js`
Expected: PASS.
Run: `npx playwright test test/e2e/voice-parts.spec.js test/e2e/models.spec.js --project=chromium`
Expected: PASS (the models tests still pass with the new role blocks).

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/ui test/unit/ui-pure.test.js test/e2e/helpers.js test/e2e/voice-parts.spec.js sw.js && git commit -m "Speech lists and speech models on the Models screen, with a Test that plays a voice or writes down what you say (spec §9.6, §9.8, §10)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 8: Settings → Voice

**Files:**
- Create: `src/ui/screens/voice.js`
- Modify: `src/ui/shell.js` (the route), `src/ui/router.js` (its comment), `src/ui/screens/settings.js` (a Voice section), `sw.js`, `docs/testing/device-checklist-m3.md` (created here, finished in 3c)
- Test: `test/e2e/voice-parts.spec.js` (a third test)

**Interfaces:**
- Consumes: `ctx.voice` (Task 6), `SAMPLE`, `speechProblem` (Task 7), `micProblem` (Task 7), `voiceSettings` (Task 6).
- Produces: the route `#/voice` (`renderVoice(ctx)`), with buttons "Test the voice" and "Test the microphone", fields "Voice", "Speed (0.5 to 2)", "Pause that ends a sentence (ms)". "Test the voice" reports `Spoken by <names>.`; "Test the microphone" reports `Heard <s> seconds of speech.` and `<model> heard: "<text>"`.

- [ ] **Step 1: Write the failing test**

Add to `test/e2e/voice-parts.spec.js`:

```js
test('Settings → Voice: a voice that fails gives its sentence to the next one; the microphone test writes down what it heard', async ({ page }) => {
  const server = await startModelServer({
    '/bad/audio/speech': { status: 500, type: 'application/json', body: JSON.stringify({ error: { message: 'Voice server down' } }) },
    '/good/audio/speech': wav,
    '/ears/audio/transcriptions': { status: 200, type: 'application/json', body: JSON.stringify({ text: 'Is there a gas station nearby?' }) },
  });
  try {
    await fakeMicrophone(page, [clipPath('gas-station')]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addEndpoint(page, 'Other: OpenAI-compatible voice', { name: 'Voice A', url: `${server.origin}/bad`, key: 'sk-a-test', model: 'voice-a' });
    await addEndpoint(page, 'Other: OpenAI-compatible voice', { name: 'Voice B', url: `${server.origin}/good`, key: 'sk-b-test', model: 'voice-b' });
    await addEndpoint(page, 'Other: OpenAI-compatible transcription', { name: 'Ears', url: `${server.origin}/ears`, key: 'sk-e-test', model: 'ears' });
    for (const m of ['voice-a', 'voice-b']) {
      await page.getByLabel('Add a model to speech-out').selectOption({ label: m });
      await page.getByRole('button', { name: 'Add to speech-out' }).click();
    }
    await page.getByLabel('Add a model to speech-in').selectOption({ label: 'ears' });
    await page.getByRole('button', { name: 'Add to speech-in' }).click();
    await page.getByRole('button', { name: 'Move Browser voice down' }).click();
    await page.getByRole('button', { name: 'Move Browser voice down' }).click();
    await expect(roleItems(page, "Speech out: Shiori's voice")).toHaveText(['1. voice-a', '2. voice-b', '3. Browser voice (works offline)']);
    await page.goto('/#/settings');
    await page.getByRole('link', { name: 'Voice', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Voice', exact: true })).toBeVisible();
    await expect(page.getByText('Voices, tried in order: voice-a, voice-b, Browser voice.')).toBeVisible();
    await page.getByRole('button', { name: 'Test the voice' }).click();
    await expect(page.getByText('Spoken by voice-b.')).toBeVisible({ timeout: 20_000 });
    expect(server.bodies('/bad/audio/speech')).toHaveLength(1);
    expect(server.bodies('/good/audio/speech')).toHaveLength(2);
    await page.getByLabel('Pause that ends a sentence (ms)').fill('900');
    await page.getByRole('button', { name: 'Save the pause' }).click();
    await page.getByRole('button', { name: 'Test the microphone' }).click();
    await expect(page.getByText(/ears heard: "Is there a gas station nearby\?"/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Heard \d\.\d seconds of speech\./)).toBeVisible();
    await page.goto('/#/trace');
    await page.getByLabel('Kind').selectOption('Web');
    await expect(page.locator('.trace li').filter({ hasText: 'voice-a' }).first()).toBeVisible();
  } finally {
    await server.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test test/e2e/voice-parts.spec.js --project=chromium -g "Settings → Voice"`
Expected: FAIL: no link named "Voice" on the Settings screen.

- [ ] **Step 3: Write the implementation**

`src/ui/screens/voice.js`:

```js
import { h, field } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { voiceSettings } from '../../core/voice/settings.js';
import { modelOf } from '../../core/llm/config.js';
import { SAMPLE, speechProblem } from '../speech-check.js';

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/**
 * Settings → Voice (spec §10, §16.2): Shiori's voices and the browser voice, and listening, each
 * with a test. The speech lists themselves are on the Models screen.
 * @param {any} ctx
 */
export async function renderVoice(ctx) {
  await ctx.llm.ready;
  const voice = ctx.voice;
  const s = voiceSettings(await readAppSettings(ctx.ws));
  const entries = await voice.outEntries();
  const synth = voice.platform?.synth;

  const sayStatus = h('p', { class: 'sub', role: 'status' });
  const sayButton = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      sayButton.disabled = true;
      sayStatus.textContent = 'Speaking…';
      try {
        const r = await voice.say(SAMPLE);
        sayStatus.textContent = r.failed === 'blocked' ? "This browser didn't let annai play sound yet. Tap anywhere on the page, then try again."
          : r.failed ? 'No voice could speak. The Trace shows what each voice answered; check them in Settings → Models.'
            : `Spoken by ${r.voices.join(', then ')}.`;
      } catch (e) {
        sayStatus.textContent = speechProblem(e);
      } finally {
        sayButton.disabled = false;
      }
    },
  }, 'Test the voice');

  const pick = h('select', { id: 'voice-browser' });
  const fill = () => {
    const chosen = pick.value || s.browserVoice;
    pick.replaceChildren(h('option', { value: '', text: "The browser's choice" }), ...(synth?.voices() ?? []).map((/** @type {any} */ v) => h('option', { value: v.id, text: `${v.name} (${v.lang})` })));
    pick.value = chosen;
  };
  fill();
  // The browser loads its voices a moment after the page opens.
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', fill, { once: true });
  const rate = h('input', { id: 'voice-rate', type: 'number', min: '0.5', max: '2', step: '0.1', value: String(s.rate) });
  const browserStatus = h('p', { class: 'sub', role: 'status' });
  const saveBrowser = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const r = Number(rate.value);
      if (!(r >= 0.5 && r <= 2)) {
        browserStatus.textContent = 'The speed goes from 0.5 (slow) to 2 (fast); 1 is normal.';
        return;
      }
      browserStatus.textContent = '';
      await updateAppSettings(ctx.ws, { voice: { browserVoice: pick.value, rate: r } });
      ctx.notices.toast('Saved');
    },
  }, 'Save the browser voice');

  const pause = h('input', { id: 'voice-pause', type: 'number', min: '300', max: '3000', step: '50', value: String(s.pauseMs) });
  const meter = h('meter', { min: '0', max: '1', value: '0', 'aria-label': 'How loud the microphone hears you' });
  const micStatus = h('p', { class: 'sub', role: 'status' });
  const savePause = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const ms = Math.round(Number(pause.value));
      if (!(ms >= 300 && ms <= 3000)) {
        micStatus.textContent = 'The pause goes from 300 to 3000 milliseconds; 700 is the usual.';
        return;
      }
      await updateAppSettings(ctx.ws, { voice: { pauseMs: ms } });
      ctx.notices.toast('Saved');
    },
  }, 'Save the pause');
  const micButton = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      micButton.disabled = true;
      micStatus.textContent = 'Say something…';
      const off = voice.onLevel((/** @type {number} */ x, /** @type {string} */ who) => { if (who === 'you') meter.value = x; });
      try {
        const seg = await voice.listenOnce({ seconds: 15, onSpeech: () => { micStatus.textContent = 'Hearing you…'; } });
        if (!seg) {
          micStatus.textContent = 'Nothing was heard in 15 seconds. Check that the microphone is on and that no other app is using it, then try again.';
          return;
        }
        const lines = [`Heard ${(seg.ms / 1000).toFixed(1)} seconds of speech.`];
        const [first] = await voice.transcribers();
        if (first) {
          micStatus.textContent = `${lines[0]} Writing it down…`;
          const text = await voice.transcribe(seg, first);
          const rec = (await ctx.llm.config()).models[first];
          const name = rec ? modelOf(rec).name : first;
          lines.push(text ? `${name} heard: "${text}"` : `${name} heard speech but wrote nothing down.`);
        } else {
          lines.push('Add a transcription model in Settings → Models to see the words.');
        }
        micStatus.textContent = lines.join(' ');
      } catch (e) {
        micStatus.textContent = speechProblem(e);
      } finally {
        off();
        meter.value = 0;
        micButton.disabled = false;
      }
    },
  }, 'Test the microphone');

  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Voice' }),
    h('p', { class: 'sub', text: 'How Shiori speaks and hears you. Which voices and which transcription models she uses, and in what order, is in Settings → Models.' }),
    section("Shiori's voice",
      h('p', { class: 'sub', text: `Voices, tried in order: ${entries.map((/** @type {any} */ e) => e.name).join(', ') || 'none'}.` }),
      h('div', { class: 'acts' }, sayButton), sayStatus),
    section('Browser voice',
      h('p', { class: 'sub', text: synth?.available() ? "This phone's own voice. It works offline." : 'This browser has no voice of its own.' }),
      h('div', { class: 'row' }, field('Voice', pick), field('Speed (0.5 to 2)', rate)),
      h('div', { class: 'acts' }, saveBrowser), browserStatus),
    section('Listening',
      h('p', { class: 'sub', text: 'annai hears that you finished a sentence when you pause. A longer pause lets you think mid-sentence; a shorter one answers sooner.' }),
      field('Pause that ends a sentence (ms)', pause), h('div', { class: 'acts' }, savePause),
      meter, h('div', { class: 'acts' }, micButton), micStatus));
}
```

In `src/ui/shell.js`, import `renderVoice` from `'./screens/voice.js'` and add `voice: renderVoice` to `SCREENS`.

In `src/ui/router.js`, add `"#/voice"` to the list of routes in the comment.

In `src/ui/screens/settings.js`, after the Models section, add:

```js
    section('Voice', h('p', { class: 'sub', text: 'How Shiori speaks and hears you, with a test for each.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/voice' }, 'Voice'))),
```

In `sw.js`, add `'/src/ui/screens/voice.js',` to `SHELL` after `'/src/ui/screens/trips.js',`.

Create `docs/testing/device-checklist-m3.md` with its first part (3c finishes it):

```markdown
# Device checklist: milestone 3 (voice)

On a real iPhone (Safari, and the installed app) and a real Android phone (Chrome, and the installed app). Each line: what to do, and what should happen. Note anything else that happens.

## Speaking and hearing (milestone 3a)

- [ ] **The first tap unlocks sound.** Open annai fresh. Without tapping anything, nothing plays. Tap anywhere once, then Settings → Voice → Test the voice: you hear it.
- [ ] **The browser voice.** Settings → Voice: the Voice list shows this phone's voices. Pick one, set the speed to 1.2, Save, Test the voice (with Browser voice first in Settings → Models → Speech out): it speaks with that voice, a little faster.
- [ ] **An API voice.** Add "OpenAI: voice" with your key. Test the voice: it speaks in Marin. Turn the phone's silent switch on (iPhone) and test again: note whether you still hear it.
- [ ] **Fallback.** Put a voice with a wrong key first in Speech out. Test the voice: the next voice speaks the whole sample; the Trace shows the failed request without the key.
- [ ] **The microphone.** Settings → Voice → Test the microphone, and say "Where should we stop for lunch?". The meter moves while you speak; it reports a few seconds of speech, and with a transcription model, the words.
- [ ] **A denied microphone.** Deny the microphone when asked (or turn it off in the phone's settings), then test again: the message says what happened and the steps for this phone.
- [ ] **Road noise.** In a moving car with the windows up, test the microphone without speaking for 15 seconds: "Nothing was heard". Then speak: it hears you.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx playwright test test/e2e/voice-parts.spec.js --project=chromium`
Expected: PASS, 3 tests.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/voice-parts.spec.js test/e2e/browser-suites.spec.js --project=webkit`
Expected: PASS.

- [ ] **Step 5: Run everything**

Run: `npm run stamp && npm run check 2>&1 | tail -5`
Expected: pass.
Run: `npx playwright test --project=chromium 2>&1 | tail -5`
Expected: all pass.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test --project=webkit 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
npm run stamp && npm run check && git add src/ui sw.js test/e2e/voice-parts.spec.js docs/testing/device-checklist-m3.md && git commit -m "Settings → Voice: the browser voice, the pause that ends a sentence, and tests of the voice and the microphone (spec §10, §16.2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
