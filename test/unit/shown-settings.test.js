import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownSettings } from '../../src/core/shown.js';

// "Show what she says" and "Show what the halves tell each other" are on unless switched off (the user, 2026-10-23).
test('what the screens show is on unless the app settings switch it off', () => {
  assert.deepEqual(shownSettings({}), { showWords: true, showHalves: true });
  assert.deepEqual(shownSettings(undefined), { showWords: true, showHalves: true });
  assert.deepEqual(shownSettings({ shiori: { showWords: false } }), { showWords: false, showHalves: true });
  assert.deepEqual(shownSettings({ shiori: { showHalves: false, personality: 'shiori' } }), { showWords: true, showHalves: false });
  assert.deepEqual(shownSettings({ shiori: { showWords: 0, showHalves: 'no' } }), { showWords: true, showHalves: true }, 'only false switches it off');
});
