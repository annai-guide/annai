import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../../scripts/realtime/scenarios.mjs';
import { CLIPS } from '../../scripts/realtime/clips.mjs';
import { LANGUAGES } from '../../src/core/languages.js';

test('every scenario plays clips that exist, and a scenario that sets the languages names languages annai has', () => {
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    for (const step of sc.steps) if ('say' in step) assert.ok(CLIPS[step.say], `${name}: no clip "${step.say}"`);
    for (const id of sc.languages?.spoken ?? []) assert.ok(LANGUAGES.some((l) => l.id === id), `${name}: no language "${id}"`);
    // The browser's language is the list's first (English, or a scenario's own phone's: ja-JP for the Japanese runs), and the harness adds the rest.
    if (sc.languages) assert.equal(sc.languages.spoken[0], (sc.locale ?? 'en').split('-')[0], `${name}: the browser's language is the list's first, and the harness adds the rest`);
  }
});

test('the languages scenarios (phase 2): short English replies with English set, and a Japanese and a Chinese sentence with English, Chinese and Japanese set, each answered before the next', () => {
  const replies = SCENARIOS['short-replies'];
  assert.deepEqual(replies.languages, { spoken: ['en'], answer: 'follow' });
  const said = (/** @type {any} */ sc) => sc.steps.filter((/** @type {any} */ s) => 'say' in s).map((/** @type {any} */ s) => s.say);
  assert.deepEqual(said(replies), ['lunch', 'yes', 'sure', 'what', 'alright', 'no']);
  const multi = SCENARIOS.multilingual;
  assert.deepEqual(multi.languages, { spoken: ['en', 'zh', 'ja'], answer: 'follow' });
  assert.deepEqual(said(multi), ['ja', 'zh', 'lunch']);
  for (const sc of [replies, multi]) {
    sc.steps.forEach((s, i) => { if ('say' in s) assert.ok('answered' in sc.steps[i + 1], 'each clip is followed by her answer being heard out'); });
  }
});

// A scenario for a real Kokoro, run with no Anthropic key and the stand-in Kokoro, would report PASS or FAIL for a stand-in: refused before the browser starts
// (the final review of langs-next, second opinion 6; runChecks calls realKokoroGiven before it starts anything).
test('a real-Kokoro scenario with no Anthropic key and the stand-in Kokoro is refused, naming what to give; a key, or --kokoro gemini, allows it', async () => {
  const { realKokoroGiven } = await import('../../scripts/realtime/run.mjs');
  assert.throws(() => realKokoroGiven(['real-stop-ja'], {}), /real-stop-ja asks for a real Kokoro.*--anthropic-key.*--kokoro gemini/);
  assert.throws(() => realKokoroGiven(['real-stop', 'relay-filler-ja', 'real-typed-live-ja'], { kokoro: 'stand-in' }), /real-stop, real-typed-live-ja ask for a real Kokoro/);
  realKokoroGiven(['real-stop-ja'], { anthropic: {} });
  realKokoroGiven(['real-stop-ja'], { kokoro: 'gemini' });
  realKokoroGiven(['relay-filler-ja', 'questions-a'], {}); // no real Kokoro asked: nothing to refuse
  for (const [name, sc] of Object.entries(SCENARIOS)) if (sc.real) assert.throws(() => realKokoroGiven([name], {}), /--anthropic-key/, name);
});

// The same refusal at its call site: runChecks calls realKokoroGiven before the folder, the servers and the browser (the third second opinion of fix round 1:
// a unit test of the function alone passes with the call taken out). The output folder is one that cannot be made, so a run that got past the refusal would stop
// at making it, with another error and still before the server and the browser: the test needs the refusal's own words, and starts nothing.
test('runChecks refuses a real-Kokoro scenario with no Anthropic key before it makes anything', async () => {
  const { runChecks } = await import('../../scripts/realtime/run.mjs');
  const { Keys } = await import('../../scripts/realtime/keys.mjs');
  const keys = new Keys([{ line: null, key: 'not-a-key' }]);
  const out = new URL('file:///proc/annai-realtime-check-never-made/');
  await assert.rejects(runChecks({ keys, only: ['real-stop-ja'], out, log: () => {} }), /real-stop-ja asks for a real Kokoro.*--anthropic-key.*--kokoro gemini/);
});

// Under --ui the harness looks buttons up by the screens' words (drive.mjs `w`), and a word with no entry silently stays English: every button a scenario taps or the
// harness presses has one in each catalog the screens come in (the final review of langs-next, second opinion 4: the card's buttons were looked up in English).
test('the buttons a scenario taps and the harness presses have words in each screens language, so --ui finds them', async () => {
  const { readFile } = await import('node:fs/promises');
  const { key } = await import('../../src/core/l10n.js');
  const taps = [...new Set(Object.values(SCENARIOS).flatMap((sc) => sc.steps.flatMap((st) => ('tap' in st ? [st.tap] : []))))];
  assert.ok(taps.includes('Allow') && taps.includes('Not now'), taps.join(', '));
  // The voice switch (drive.mjs voiceSwitch, which ends every live run): the Voice group's name (context "voice mode"), its Off button, and the chip's "Voice off".
  /** @type {[string, string][]} */
  const pressed = [...taps, 'Shiori', 'Type', 'Send', 'Listening live', 'Off', 'Voice off'].map((en) => [en, '']);
  pressed.push(['Voice', 'voice mode']);
  for (const tag of ['ja', 'zh-Hans', 'zh-Hant']) {
    const words = JSON.parse(await readFile(new URL(`../../l10n/${tag}.json`, import.meta.url), 'utf8'));
    for (const [en, context] of pressed) assert.ok(words[key(en, context)], `${tag}: no words for "${en}"${context ? ` (${context})` : ''}`);
    for (const en of ['Allow', 'Not now', 'Off', 'Voice off']) assert.notEqual(words[key(en, '')], en, `${tag}: "${en}" is still English`);
    assert.notEqual(words[key('Voice', 'voice mode')], 'Voice', tag);
  }
});
