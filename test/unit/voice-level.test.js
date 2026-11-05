import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceLevel, LEVEL } from '../../src/core/voice/level.js';

test('voiceDb: the second-loudest of the last 5 answered turns, none until two; forgotten on reset', () => {
  const v = new VoiceLevel();
  assert.equal(v.db, null);
  v.heard(-10);
  assert.equal(v.db, null, 'one turn may be a lyric she answered');
  v.heard(-20);
  assert.equal(v.db, -20);
  v.heard(-5);
  assert.equal(v.db, -10);
  v.reset();
  assert.equal(v.db, null);
});

test('voiceDb: one loud answered lyric never leaves the normal voice under the minimum', () => {
  const v = new VoiceLevel();
  for (const peak of [-23.3, -24, -22.8, -7.8]) v.heard(peak);
  assert.equal(v.db, -22.8);
  assert.ok(/** @type {number} */ (v.minimum(-60)) < -23.3, 'the normal voice opens a turn');
});

test('voiceDb: only the last 5 count, so a voice that fell is followed', () => {
  const v = new VoiceLevel();
  for (const peak of [-5, -5, -5, -20, -20, -20, -20, -20]) v.heard(peak);
  assert.equal(v.db, -20);
});

test('the minimum: only with a voice learned and a floor above the line', () => {
  const v = new VoiceLevel();
  assert.equal(v.minimum(-50), null, 'no voice yet');
  v.heard(-5);
  v.heard(-5);
  assert.equal(v.minimum(LEVEL.NOISY_FLOOR_DB - 1), null, 'a quiet car');
  assert.equal(v.minimum(LEVEL.NOISY_FLOOR_DB), null, 'on the line');
  assert.equal(v.minimum(-60), -5 - LEVEL.BELOW_VOICE_DB);
});

test("the user's own level: within 6 dB of voiceDb; no peak never is", () => {
  const v = new VoiceLevel();
  v.heard(-5);
  v.heard(-5);
  assert.equal(v.own(-11, -50), true);
  assert.equal(v.own(-11.5, -50), false);
  assert.equal(v.own(null, -80), false);
  assert.equal(v.own(-11.5, -80), false, 'a voice learned decides, whatever the floor');
});

test("the user's own level with nothing learned: yes over a quiet floor, as no lyrics play; no over a loud floor, or one not known", () => {
  const v = new VoiceLevel();
  assert.equal(v.own(-40, LEVEL.NOISY_FLOOR_DB), true);
  assert.equal(v.own(-40, -80), true);
  assert.equal(v.own(-40, -60), false);
  assert.equal(v.own(-40, null), false);
  assert.equal(v.own(null, -80), false);
});
