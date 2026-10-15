import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash } from '../../src/ui/router.js';
import { relTime, bytes, dateRange } from '../../src/ui/format.js';

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
