import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pasteBecomesFile, pastedName, handedOf, shownPath, handOver } from '../../src/ui/composer.js';
import { SYS_WAITING, ensureBaseScopes, createTrip, kindOf } from '../../src/core/scopes.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, StorageFullError } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';

test('pasteBecomesFile: only a long paste (over 280 characters, or 4 lines or more) is handed over; anything shorter is typed', () => {
  assert.equal(pasteBecomesFile('Seat 14D'), false);
  assert.equal(pasteBecomesFile('Your flight is confirmed\nAN 123 SEA → ANC'), false);
  assert.equal(pasteBecomesFile('Your flight is confirmed\nAN 123\nSEA → ANC'), false);
  assert.equal(pasteBecomesFile('Your flight is confirmed\nAN 123\nSEA 11:20\nANC 14:05'), true);
  assert.equal(pasteBecomesFile('x'.repeat(281)), true);
  assert.equal(pasteBecomesFile('x'.repeat(280)), false);
  assert.equal(pasteBecomesFile('Seat 14D\n\n\n\n'), false); // blank lines at its end are no lines
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

/** A phone of annai's in memory, as handOver sees it: a trip open, what she is sent, the cards. @param {{ full?: string }} [o] full: a path whose write fails as storage full */
async function phone(o = {}) {
  const store = createMemoryStore();
  const real = new Workspace(store, { schemaFor: makeSchemaFor({ list: (/** @type {string} */ k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(real);
  const trip = await createTrip(real, { title: 'Testville' });
  const other = await createTrip(real, { title: 'Kyoto' });
  const ws = Object.create(real);
  ws.write = (/** @type {string} */ scope, /** @type {string} */ path, /** @type {any} */ c, /** @type {any} */ opts) => (path === o.full ? Promise.reject(new StorageFullError()) : real.write(scope, path, c, opts));
  /** @type {any[]} */ const sent = [];
  /** @type {any[]} */ const cards = [];
  const ctx = { ws, store, agent: { target: trip, send: (/** @type {string} */ text, /** @type {any} */ x) => sent.push({ text, ...x }) }, notices: { card: (/** @type {any} */ c) => cards.push(c), toast: () => {} }, go: () => {} };
  return { ctx, trip, other, sent, cards, ws: real };
}
const file = (/** @type {string} */ name, /** @type {string} */ body) => ({ file: Object.assign(new Blob([body], { type: 'text/plain' }), { name }) });

test('handOver keeps the files one at a time, saying how far it is, then hands them all over at once', async () => {
  globalThis.location ??= /** @type {any} */ ({ hash: '#/talk' });
  const { ctx, sent } = await phone();
  /** @type {number[][]} */ const said = [];
  await handOver(ctx, 'Our bookings', [file('a.txt', 'a'), file('b.txt', 'b'), file('c.txt', 'c')], { progress: (done, total) => said.push([done, total]) });
  assert.deepEqual(said, [[0, 3], [1, 3], [2, 3], [3, 3]]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].handed.map((/** @type {any} */ f) => f.path), ['/trip/files/a.txt', '/trip/files/b.txt', '/trip/files/c.txt']);
});

test('a file that runs out of room part-way: what was kept is handed over, and a card says what was not', async () => {
  globalThis.location ??= /** @type {any} */ ({ hash: '#/talk' });
  const { ctx, sent, cards, trip, ws } = await phone({ full: '/files/b.txt' });
  await handOver(ctx, '', [file('a.txt', 'a'), file('b.txt', 'b'), file('c.txt', 'c')]);
  assert.deepEqual(sent[0].handed.map((/** @type {any} */ f) => f.path), ['/trip/files/a.txt']);
  assert.deepEqual((await ws.list(trip, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/a.txt']);
  assert.equal(cards.length, 1);
  assert.match(cards[0].title, /2 files weren't kept/);
});

test("a file asked about from another conversation isn't handed over in this one: its chip names the other trip's file", async () => {
  globalThis.location ??= /** @type {any} */ ({ hash: '#/talk' });
  const { ctx, sent, other, ws } = await phone();
  await ws.write(other, '/files/temple.pdf', 'temple', { author: 'user', type: 'application/pdf' });
  await handOver(ctx, 'And this?', [{ scope: other, path: '/files/temple.pdf' }]);
  assert.deepEqual(sent, [{ text: 'And this?' }]);
});

test('a calendar file kept in a trip says how many of its events went on the plan', async () => {
  globalThis.location ??= /** @type {any} */ ({ hash: '#/talk' });
  const { ctx, sent } = await phone();
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a@test.invalid\r\nDTSTART:20261120T180000Z\r\nDTEND:20261120T190000Z\r\nSUMMARY:Dinner\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  await handOver(ctx, '', [{ file: Object.assign(new Blob([ics], { type: 'text/calendar' }), { name: 'dinner.ics' }) }, file('a.txt', 'a')]);
  assert.deepEqual(sent[0].handed.map((/** @type {any} */ f) => [f.name, f.planned ?? 0]), [['dinner.ics', 1], ['a.txt', 0]]);
});

test('another conversation opened while the files were kept: the message goes to the one they were kept for, written into it', async () => {
  globalThis.location ??= /** @type {any} */ ({ hash: '#/talk' });
  const { ctx, sent, other } = await phone();
  /** @type {any[]} */ const woken = [];
  const agent = /** @type {any} */ (ctx.agent);
  agent.wake = (/** @type {any} */ w) => { woken.push(w); return Promise.resolve(); };
  const trip = agent.target;
  await handOver(ctx, '', [file('a.txt', 'a'), file('b.txt', 'b')], { progress: (done) => { if (done === 1) agent.target = other; } });
  assert.deepEqual(sent, []);
  assert.equal(woken.length, 1);
  assert.deepEqual([woken[0].kind, woken[0].scope, woken[0].text, woken[0].handed.map((/** @type {any} */ f) => f.path)], ['user', trip, '(files)', ['/trip/files/a.txt', '/trip/files/b.txt']]);
  assert.match(woken[0].handover, /^h-/);
});

test("a booking's chip is named by its title; its HandedFile is a reference", async () => {
  globalThis.location ??= /** @type {any} */ ({ hash: '#/talk' });
  assert.deepEqual(handedOf({ scope: 'trip-x', path: '/bookings/flight.json' }, { type: 'application/json', name: 'ANNAI AIR AN 123' }), { path: '/trip/bookings/flight.json', type: 'application/json', name: 'ANNAI AIR AN 123', new: false });
  const { ctx, sent, trip, ws } = await phone();
  await ws.write(trip, '/bookings/flight.json', { id: 'flight', kind: 'flight', status: 'unverified', source: '/files/flight.pdf', title: 'ANNAI AIR AN 123', unsure: [] }, { author: 'user' });
  await handOver(ctx, 'Read it again', [{ scope: trip, path: '/bookings/flight.json', name: 'ANNAI AIR AN 123' }]);
  assert.deepEqual(sent[0].handed, [{ path: '/trip/bookings/flight.json', type: 'application/json', name: 'ANNAI AIR AN 123', new: false }]);
  assert.equal(sent[0].text, 'Read it again');
});
