import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash } from '../../src/ui/router.js';
import { relTime, bytes, dateRange, takenText, backupText } from '../../src/ui/format.js';
import { explainStorageFull } from '../../src/ui/storage-full.js';
import { StorageFullError } from '../../src/core/errors.js';

test('parseHash: screens, parts and params', () => {
  assert.deepEqual(parseHash(''), { name: 'trips', parts: ['trips'], params: {} });
  assert.deepEqual(parseHash('#/trip/trip-1'), { name: 'trip', parts: ['trip', 'trip-1'], params: {} });
  assert.deepEqual(parseHash('#/trip/trip-1/file?path=%2Fnotes%2F%E6%A1%88%E5%86%85.md'), { name: 'file', parts: ['trip', 'trip-1', 'file'], params: { path: '/notes/案内.md' } });
  assert.deepEqual(parseHash('#/import?inbox=1'), { name: 'import', parts: ['import'], params: { inbox: '1' } });
});

test('parseHash: "#import=<url>" from spec §12.3, with the URL kept whole', () => {
  const url = 'https://example.com/a?b=1&c=2#x';
  assert.deepEqual(parseHash('#import=' + encodeURIComponent(url)), { name: 'import', parts: ['import'], params: { url } });
});

test('format helpers', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  assert.equal(relTime(now - 10_000, now), 'just now');
  assert.match(relTime(now - 2 * 3600_000, now), /2 hours ago/);
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1536), '1.5 KB');
  assert.equal(bytes(5 * 1024 * 1024), '5.0 MB');
  assert.match(dateRange('2026-11-25', '2026-11-29'), /Nov/);
  assert.match(dateRange('2026-11-25', '2026-11-29'), /25/);
  assert.match(dateRange('2026-11-25'), /Nov 25/);
});

test('parseHash: a mangled link opens Trips instead of failing', () => {
  const trips = { name: 'trips', parts: ['trips'], params: {} };
  assert.deepEqual(parseHash('#/trip/%E6'), trips);
  assert.deepEqual(parseHash('#/trip/trip-1/file?path=%E6%A1'), { name: 'file', parts: ['trip', 'trip-1', 'file'], params: { path: '�' } });
  assert.deepEqual(parseHash('#import=%ZZ'), trips);
});

test('takenText shows the time as the clock showed it where the photo was taken', () => {
  assert.equal(takenText('2026-11-26T19:04:12-08:00', 'en-GB'), '26 Nov 2026, 19:04');
  assert.equal(takenText('2026-11-27T08:15:00', 'en-GB'), '27 Nov 2026, 08:15');
  assert.equal(takenText('sometime', 'en-GB'), 'sometime');
});

test('a full device gets advice that frees space: deleting inside annai keeps the old versions (spec §4.2)', () => {
  /** @type {any[]} */
  const cards = [];
  assert.equal(explainStorageFull({ notices: { card: (/** @type {any} */ c) => cards.push(c) }, go: () => {} }, new StorageFullError()), true);
  assert.equal(cards.length, 1);
  for (const advice of [cards[0].body, new StorageFullError().message]) {
    assert.match(advice, /free up space on this device/);
    assert.doesNotMatch(advice, /delete photos|old trips|make room/i);
  }
  assert.deepEqual(cards[0].actions.map((/** @type {any} */ a) => a.label), ['Export a backup']);
});

test('backupText: never, up to date, and changed since (spec §4.9)', () => {
  const now = Date.UTC(2026, 10, 25);
  assert.equal(backupText({ at: null, changed: true }, now), 'not backed up');
  assert.match(backupText({ at: now - 2 * 86400_000, changed: false }, now), /^backed up 2 days ago$/);
  assert.match(backupText({ at: now - 2 * 86400_000, changed: true }, now), /^backed up 2 days ago, changed since$/);
});
