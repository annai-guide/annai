import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../../scripts/realtime/scenarios.mjs';
import { CLIPS } from '../../scripts/realtime/clips.mjs';
import { LANGUAGES } from '../../src/core/languages.js';

test('every scenario plays clips that exist, and a scenario that sets the languages names languages annai has', () => {
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    for (const step of sc.steps) if ('say' in step) assert.ok(CLIPS[step.say], `${name}: no clip "${step.say}"`);
    for (const id of sc.languages?.spoken ?? []) assert.ok(LANGUAGES.some((l) => l.id === id), `${name}: no language "${id}"`);
    if (sc.languages) assert.equal(sc.languages.spoken[0], 'en', `${name}: the browser's language (English) is the list's first, and the harness adds the rest`);
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
