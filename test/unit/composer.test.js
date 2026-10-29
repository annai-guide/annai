import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pasteBecomesFile, pastedName, handedOf, shownPath } from '../../src/ui/composer.js';
import { SYS_WAITING } from '../../src/core/scopes.js';

test('pasteBecomesFile: an email is handed over, a sentence is typed', () => {
  assert.equal(pasteBecomesFile('Seat 14D'), false);
  assert.equal(pasteBecomesFile('Your flight is confirmed\nAN 123 SEA → ANC'), true);
  assert.equal(pasteBecomesFile('x'.repeat(281)), true);
  assert.equal(pasteBecomesFile('x'.repeat(280)), false);
  // A line break only at the end is still a sentence.
  assert.equal(pasteBecomesFile('Seat 14D\n'), false);
});

test("pastedName: the time it was pasted, in the phone's zone", () => {
  assert.equal(pastedName(new Date(2026, 9, 28, 3, 10).getTime()), 'pasted-2026-10-28-0310.txt');
  assert.equal(pastedName(new Date(2027, 0, 5, 23, 59).getTime()), 'pasted-2027-01-05-2359.txt');
});

test('handedOf: a reference, by the path Shiori sees', () => {
  assert.deepEqual(handedOf({ scope: SYS_WAITING, path: '/files/a.pdf' }, { type: 'application/pdf', name: 'a.pdf' }), { path: '/waiting/files/a.pdf', type: 'application/pdf', name: 'a.pdf', new: false });
  assert.deepEqual(handedOf({ scope: 'trip-x', path: '/bookings/flight.json' }, { type: 'application/json', name: 'flight.json' }).path, '/trip/bookings/flight.json');
});

test('shownPath: the waiting space as /waiting/, a trip as /trip/', () => {
  assert.equal(shownPath(SYS_WAITING, '/files/a.pdf'), '/waiting/files/a.pdf');
  assert.equal(shownPath('trip-x', '/files/a.pdf'), '/trip/files/a.pdf');
});
