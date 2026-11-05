import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceLevel, LEVEL } from '../../src/core/voice/level.js';

test('voiceDb: a running maximum that falls about 3 dB a minute, forgotten on reset', () => {
  let now = 0;
  const v = new VoiceLevel(() => now);
  assert.equal(v.db, null);
  v.heard(-10);
  v.heard(-20);
  assert.equal(v.db, -10, 'a lyric does not lower it');
  now = 60_000;
  assert.equal(v.db, -13);
  v.heard(-5);
  assert.equal(v.db, -5, 'the user louder: at once');
  v.reset();
  assert.equal(v.db, null);
});

test('the minimum: only with a voice learned and a floor above the line', () => {
  const v = new VoiceLevel(() => 0);
  assert.equal(v.minimum(-50), null, 'no voice yet');
  v.heard(-5);
  assert.equal(v.minimum(LEVEL.NOISY_FLOOR_DB - 1), null, 'a quiet car');
  assert.equal(v.minimum(LEVEL.NOISY_FLOOR_DB), null, 'on the line');
  assert.equal(v.minimum(-60), -5 - LEVEL.BELOW_VOICE_DB);
});

test("the user's own level: within 6 dB of voiceDb; with none, any peak is; no peak never is", () => {
  const v = new VoiceLevel(() => 0);
  assert.equal(v.own(-40), true);
  assert.equal(v.own(null), false);
  v.heard(-5);
  assert.equal(v.own(-11), true);
  assert.equal(v.own(-11.5), false);
});
