import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { ensureBaseScopes, createTrip, listTrips, kindOf, scopeTitle, SYS_WAITING } from '../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { resolvePath } from '../../src/core/agent/tools.js';
import { readNames } from '../../src/core/names.js';
import { waitingFiles, moveFile, dropWaiting } from '../../src/core/waiting.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8 } from '../../src/core/bytes.js';

async function kit() {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (/** @type {string} */ k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Anchorage' });
  const other = await createTrip(ws, { title: 'Kyoto' });
  /** Hands a file over with no trip open: it waits. @param {string} name @param {string} body @param {string} [type] */
  const hand = (name, body, type = 'application/pdf') => ws.write(SYS_WAITING, `/files/${name}`, utf8(body), { author: 'user', type });
  return { store, ws, trip, other, hand };
}

const fileEvents = (/** @type {any} */ store, /** @type {string} */ scope) =>
  store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['file.write', 'file.delete'] }));

test('the waiting space is made with the base scopes, outside every trip and outside /me/', async () => {
  const { store } = await kit();
  assert.ok(await store.tx(['scopes'], 'readonly', (t) => t.getScope(SYS_WAITING)));
  assert.equal(SYS_WAITING, 'sys:waiting');
  assert.equal(kindOf(SYS_WAITING), 'sys');
  assert.equal(scopeTitle({ id: SYS_WAITING, title: 'x' }), 'Waiting with Shiori');
  assert.equal((await listTrips(store)).active.some((s) => s.id === SYS_WAITING), false);
});

test('Shiori sees /waiting/ only while no trip is open', () => {
  assert.deepEqual(resolvePath('/waiting/files/a.pdf', null), { scope: SYS_WAITING, path: '/files/a.pdf' });
  assert.deepEqual(resolvePath('/waiting/', null), { scope: SYS_WAITING, path: '/' });
  assert.throws(() => resolvePath('/waiting/files/a.pdf', 'trip-1'), /with a trip open/);
  assert.throws(() => resolvePath('/elsewhere/a.pdf', null), /\/waiting\//);
});

test('waitingFiles: the files under /files/, not her names', async () => {
  const { ws, hand } = await kit();
  await hand('flight.pdf', 'flight');
  await ws.write(SYS_WAITING, '/names.json', { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, { author: 'shiori' });
  assert.deepEqual((await waitingFiles(ws)).map((f) => f.path), ['/files/flight.pdf']);
});

test("moveFile from waiting: in the trip's Files with its short name; gone from waiting with its history", async () => {
  const { store, ws, trip, hand } = await kit();
  await hand('flight.pdf', 'flight');
  await ws.write(SYS_WAITING, '/names.json', { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, { author: 'shiori' });
  const to = await moveFile(ws, { scope: SYS_WAITING, path: '/files/flight.pdf' }, trip, { handover: 'h-1' });
  assert.equal(to, '/files/flight.pdf');
  const got = await ws.read(trip, to);
  assert.equal(got?.entry.author, 'user');
  assert.equal(got?.entry.type, 'application/pdf');
  assert.deepEqual(await readNames(ws, trip), { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' });
  assert.deepEqual(await readNames(ws, SYS_WAITING), {});
  assert.deepEqual(await waitingFiles(ws), []);
  const left = await fileEvents(store, SYS_WAITING);
  assert.equal(left.filter((e) => e.data.path === '/files/flight.pdf').length, 0);
  const wrote = (await fileEvents(store, trip)).filter((e) => e.data.path === '/files/flight.pdf').at(-1);
  assert.equal(wrote.data.handover, 'h-1');
});

test('moveFile never replaces a file of the same name, and keeps a name that is not words', async () => {
  const { ws, trip, hand } = await kit();
  await ws.write(trip, '/files/IMG_3021.PNG', utf8('the first'), { author: 'user', type: 'image/png' });
  await hand('IMG_3021.PNG', 'the second', 'image/png');
  await ws.write(SYS_WAITING, '/names.json', { '/files/IMG_3021.PNG': 'Hotel Aurora Test' }, { author: 'shiori' });
  assert.equal(await moveFile(ws, { scope: SYS_WAITING, path: '/files/IMG_3021.PNG' }, trip), '/files/IMG_3021 (2).PNG');
  assert.equal(await ws.readText(trip, '/files/IMG_3021.PNG'), 'the first');
  assert.equal(await ws.readText(trip, '/files/IMG_3021 (2).PNG'), 'the second');
  // Its short name moved with it, to its new path.
  assert.deepEqual(await readNames(ws, trip), { '/files/IMG_3021 (2).PNG': 'Hotel Aurora Test' });
  const odd = 'Your flight is booked- TESTQ1 to Testville on 11:20:2026.pdf';
  await hand(odd, 'odd');
  assert.equal(await moveFile(ws, { scope: SYS_WAITING, path: `/files/${odd}` }, trip), `/files/${odd}`);
});

test('moveFile from a trip: deleted there, its history kept', async () => {
  const { store, ws, trip, other } = await kit();
  await ws.write(trip, '/files/temple.pdf', utf8('temple tickets'), { author: 'user', type: 'application/pdf' });
  await ws.write(trip, '/names.json', { '/files/temple.pdf': 'Temple tickets' }, { author: 'shiori' });
  assert.equal(await moveFile(ws, { scope: trip, path: '/files/temple.pdf' }, other, { handover: 'h-2' }), '/files/temple.pdf');
  assert.equal(await ws.read(trip, '/files/temple.pdf'), undefined);
  const history = await ws.history(trip, '/files/temple.pdf');
  assert.deepEqual(history.map((h) => [h.type, h.actor]), [['file.write', 'user'], ['file.delete', 'shiori']]);
  assert.equal((await fileEvents(store, trip)).at(-1).data.handover, 'h-2');
  assert.deepEqual(await readNames(ws, other), { '/files/temple.pdf': 'Temple tickets' });
  assert.deepEqual(await readNames(ws, trip), {});
});

test('dropWaiting: removes the file, its history and its name, and frees what nothing else names', async () => {
  const { store, ws, trip, hand } = await kit();
  await hand('screenshot.png', 'a view', 'image/png');
  await hand('screenshot.png', 'a view, again', 'image/png');
  await ws.write(SYS_WAITING, '/names.json', { '/files/screenshot.png': 'A view' }, { author: 'shiori' });
  // The same bytes kept in a trip too: they stay.
  await hand('shared.pdf', 'shared');
  await ws.write(trip, '/files/shared.pdf', utf8('shared'), { author: 'user', type: 'application/pdf' });
  const hashes = [await sha256Hex(utf8('a view')), await sha256Hex(utf8('a view, again'))];
  assert.equal(await dropWaiting(ws, '/files/screenshot.png'), 'a view'.length + 'a view, again'.length);
  for (const h of hashes) assert.equal(await store.tx(['blobs'], 'readonly', (t) => t.hasBlob(h)), false);
  assert.equal((await fileEvents(store, SYS_WAITING)).some((e) => e.data.path === '/files/screenshot.png'), false);
  assert.deepEqual(await readNames(ws, SYS_WAITING), {});
  assert.equal(await dropWaiting(ws, '/files/shared.pdf'), 0);
  assert.ok(await ws.read(trip, '/files/shared.pdf'));
});
