import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { ensureBaseScopes, createTrip, listTrips, removeTrip, kindOf, scopeTitle, ME, SYS_WAITING } from '../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { resolvePath } from '../../src/core/agent/tools.js';
import { readNames } from '../../src/core/names.js';
import { waitingFiles, moveFile, dropWaiting, moveWaitingToChat } from '../../src/core/waiting.js';
import { undoEverywhere } from '../../src/core/handover.js';
import { record } from '../../src/core/agent/log.js';
import { exportArchive, peekArchive, importArchive, PRESETS } from '../../src/core/archive.js';
import { agentKit } from './agent-kit.js';
import { useClock } from './clock.js';
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

test("a waiting file dropped for good takes its short name with it, history and all: no stored content keeps it", async () => {
  const { store, ws, hand } = await kit();
  await hand('a.pdf', 'a');
  await hand('b.pdf', 'b');
  await ws.patch(SYS_WAITING, '/names.json', { '/files/a.pdf': 'Name of the dropped file' }, { author: 'shiori', create: true });
  await ws.patch(SYS_WAITING, '/names.json', { '/files/b.pdf': 'Name of B' }, { author: 'shiori' });
  await dropWaiting(ws, '/files/a.pdf');
  const texts = await store.tx(['blobs'], 'readonly', async (t) => Promise.all((await t.listBlobs()).map(async (b) => new TextDecoder().decode((await t.getBlob(b.hash)).data))));
  assert.equal(texts.some((x) => x.includes('Name of the dropped file')), false);
  assert.deepEqual(await readNames(ws, SYS_WAITING), { '/files/b.pdf': 'Name of B' });
});

/**
 * The same store, as a page closed after its first `left` read-write transactions: every later one is lost (it rejects, writing nothing).
 * @param {any} store @param {number} left
 */
function closedAfter(store, left) {
  return { ...store, tx(/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) { return mode === 'readwrite' && left-- <= 0 ? Promise.reject(new Error('the page closed')) : store.tx(stores, mode, fn); } };
}

test('a move cut off at any point leaves the file in one place, with its short name: in the trip it went to, or where it was', async () => {
  for (const from of ['waiting', 'a trip']) {
    for (let left = 0; left < 8; left++) {
      const { store, ws, trip, other, hand } = await kit();
      const scope = from === 'waiting' ? SYS_WAITING : other;
      if (from === 'waiting') await hand('flight.pdf', 'flight');
      else await ws.write(other, '/files/flight.pdf', utf8('flight'), { author: 'user', type: 'application/pdf' });
      await ws.write(scope, '/names.json', { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, { author: 'shiori' });
      const cut = new Workspace(closedAfter(store, left), { schemaFor: ws.schemaFor });
      await moveFile(cut, { scope, path: '/files/flight.pdf' }, trip, { handover: 'h-1' }).catch(() => {});
      const here = Boolean(await ws.read(trip, '/files/flight.pdf'));
      const there = Boolean(await ws.read(scope, '/files/flight.pdf'));
      assert.equal(Number(here) + Number(there), 1, `from ${from}, the page closed after ${left} writes: in the trip ${here}, where it was ${there}`);
      assert.deepEqual(await readNames(ws, here ? trip : scope), { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, `from ${from}, ${left}`);
      assert.deepEqual(await readNames(ws, here ? scope : trip), {}, `from ${from}, ${left}`);
    }
  }
});

// Timeline stage 7: no screen shows the waiting space any more, so its files move into a conversation of their own, "Waiting with Shiori", at
// start, after an import and after an Undo (moveWaitingToChat). Each run makes its own chat (the user, 2026-11-14, "A new chat each run").

/** A wake as Shiori's writes one into a conversation that isn't open, into the store's log: what moveWaitingToChat waits for. @param {any} store @param {any[]} [woke] */
const wakeInto = (store, woke = []) => async (/** @type {any} */ w) => {
  woke.push(w);
  await record(store, w.scope, { type: 'wake', actor: 'system', data: { id: `w-${woke.length}`, reasons: [{ kind: w.kind, text: w.text }] } });
};
/** The chats annai made for the waiting files, oldest first, each with its files and its wakes. @param {any} store @param {Workspace} ws */
async function waitingChats(store, ws) {
  const chats = (await listTrips(store)).active.filter((s) => s.title === 'Waiting with Shiori').sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  return Promise.all(chats.map(async (s) => ({
    id: s.id, files: (await ws.list(s.id, '/files/')).map((f) => f.path), names: await readNames(ws, s.id),
    wakes: (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(s.id, { types: ['wake'] }))).length,
  })));
}

test('moveWaitingToChat with nothing waiting makes nothing', async () => {
  const { store, ws } = await kit();
  const woke = [];
  assert.equal(await moveWaitingToChat(ws, wakeInto(store, woke)), null);
  assert.deepEqual(await waitingChats(store, ws), []);
  assert.equal(woke.length, 0);
});

test('the waiting files move into a new chat, "Waiting with Shiori", named by annai, with their short names; its first open asks her once, with the wake\'s words', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'I filed your flight.' } }, { name: 'sleep', input: {} }] }]]);
  await k.ws.write(SYS_WAITING, '/files/flight.pdf', utf8('ANNAI AIR AN 123'), { author: 'user', type: 'application/pdf' });
  await k.ws.write(SYS_WAITING, '/files/hotel.png', utf8('Hotel Aurora Test'), { author: 'user', type: 'image/png' });
  await k.ws.write(SYS_WAITING, '/names.json', { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, { author: 'shiori' });
  const id = /** @type {string} */ (await moveWaitingToChat(k.ws, (w) => k.agent.wake(w)));
  assert.ok(id);
  assert.deepEqual(await waitingFiles(k.ws), []);
  const tj = await k.ws.read(id, '/trip.json');
  assert.equal(tj?.entry.author, 'system'); // her snapshot reads the name as a guess she may improve
  assert.equal(JSON.parse(new TextDecoder().decode(tj?.bytes)).title, 'Waiting with Shiori');
  assert.deepEqual((await k.ws.list(id, '/files/')).map((f) => f.path), ['/files/flight.pdf', '/files/hotel.png']);
  assert.equal((await k.ws.read(id, '/files/flight.pdf'))?.entry.author, 'user');
  assert.deepEqual(await readNames(k.ws, id), { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' });
  assert.equal(k.requests.length, 0, 'not open: no turn yet');
  await k.agent.open(id);
  await k.agent.idle();
  assert.equal(k.requests.length, 1);
  const asked = JSON.stringify(k.requests[0].messages);
  assert.match(asked, /While no trip was open, the user handed you files/);
  assert.match(asked, /move_file/);
  assert.doesNotMatch(asked, /flight\.pdf|hotel\.png/, 'the wake names no file');
});

test('a run cut off after the wake, then after the first file, then a whole run: every file is in a waiting chat once, whole, with its short name; each chat has its wake; nothing waits (Review Focus 1)', async () => {
  for (const [first, second] of [[0, 1], [1, 0], [1, 1], [0, 0]]) {
    const { store, ws, hand } = await kit();
    for (const n of ['flight.pdf', 'hotel.pdf', 'car.pdf']) await hand(n, `the ${n}`);
    await ws.write(SYS_WAITING, '/names.json', { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20', '/files/car.pdf': 'A car in Testville' }, { author: 'shiori' });
    // Each cut run: the chat is made and its wake written, then the store fails after `files` moves.
    for (const files of [first, second]) {
      let moves = files;
      const cut = new Workspace(store, { schemaFor: ws.schemaFor });
      const writeAcross = cut.writeAcross.bind(cut);
      /** @type {any} */ (cut).writeAcross = (/** @type {any} */ changes, /** @type {any} */ o) => (moves-- > 0 ? writeAcross(changes, o) : Promise.reject(new Error('the page closed')));
      await assert.rejects(moveWaitingToChat(cut, wakeInto(store)), /the page closed/);
    }
    assert.ok(await moveWaitingToChat(ws, wakeInto(store)));
    assert.deepEqual(await waitingFiles(ws), [], `${first}, ${second}`);
    const chats = await waitingChats(store, ws);
    assert.equal(chats.length, 3);
    for (const c of chats) assert.equal(c.wakes, 1, `${first}, ${second}: each chat has its wake`);
    const all = chats.flatMap((c) => c.files).sort();
    assert.deepEqual(all, ['/files/car.pdf', '/files/flight.pdf', '/files/hotel.pdf'], `${first}, ${second}: each file once`);
    for (const c of chats) {
      for (const f of c.files) assert.equal(await ws.readText(c.id, f), `the ${f.slice('/files/'.length)}`);
      assert.deepEqual(c.names, Object.fromEntries(Object.entries({ '/files/flight.pdf': 'ANNAI AIR flight · Nov 20', '/files/car.pdf': 'A car in Testville' }).filter(([p]) => c.files.includes(p))));
    }
  }
});

test("an old backup's waiting files go into a new chat once it is imported", async () => {
  const a = await kit();
  await a.hand('flight.pdf', 'a flight');
  await a.ws.write(SYS_WAITING, '/names.json', { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, { author: 'shiori' });
  const all = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const b = await kit();
  await importArchive(b.store, await peekArchive(new Uint8Array(await all.blob.arrayBuffer())));
  assert.deepEqual((await waitingFiles(b.ws)).map((f) => f.path), ['/files/flight.pdf']);
  const id = /** @type {string} */ (await moveWaitingToChat(b.ws, wakeInto(b.store)));
  assert.deepEqual(await waitingFiles(b.ws), []);
  assert.equal(await b.ws.readText(id, '/files/flight.pdf'), 'a flight');
});

test('Undo with files that have nowhere to go back to: a pre-update hand-over filed from the waiting space, and a started trip whose origin is gone; they land in a new chat, never nowhere and never in two places (Review Focus 5)', async () => {
  // A hand-over made with no trip open, before the update, that she filed into a trip she started.
  const { store, ws, hand } = await kit();
  await hand('flight.pdf', 'a flight');
  const started = await createTrip(ws, { title: 'Testville' }, { author: 'shiori', handover: 'h-1' });
  await record(store, ME, { type: 'msg.user', actor: 'user', data: { handed: [{ path: '/waiting/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }], handover: 'h-1' }, texts: [['text', '(files)']] });
  await record(store, started, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-1', from: ME }, texts: [['text', '(files)']] });
  await record(store, ME, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: started, started: true, count: 1 } });
  await moveFile(ws, { scope: SYS_WAITING, path: '/files/flight.pdf' }, started, { handover: 'h-1' });
  const out = await undoEverywhere(ws, started, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual([out.removed, out.waiting], [['Testville'], true]);
  // What talk.js does after such an Undo, before it goes home.
  const id = /** @type {string} */ (await moveWaitingToChat(ws, wakeInto(store)));
  assert.deepEqual(await waitingFiles(ws), []);
  assert.deepEqual((await ws.list(id, '/files/')).map((f) => f.path), ['/files/flight.pdf']);
  // A trip she started from another, which the user removed since: its file goes to wait, then into a chat of its own.
  const b = await kit();
  await b.ws.write(b.trip, '/files/hotel.pdf', utf8('a hotel'), { author: 'user', type: 'application/pdf', handover: 'h-2' });
  const kyoto = await createTrip(b.ws, { title: 'Kyoto' }, { author: 'shiori', handover: 'h-2' });
  await record(b.store, kyoto, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-2', from: b.trip }, texts: [['text', '(files)']] });
  await record(b.store, b.trip, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-2', to: kyoto, started: true, count: 1 } });
  await moveFile(b.ws, { scope: b.trip, path: '/files/hotel.pdf' }, kyoto, { handover: 'h-2' });
  await removeTrip(b.store, b.trip);
  const gone = await undoEverywhere(b.ws, kyoto, 'h-2', { remove: async (s) => removeTrip(b.store, s) });
  assert.equal(gone.waiting, true);
  const chat = /** @type {string} */ (await moveWaitingToChat(b.ws, wakeInto(b.store)));
  assert.deepEqual(await waitingFiles(b.ws), []);
  assert.equal(await b.ws.readText(chat, '/files/hotel.pdf'), 'a hotel');
  for (const s of (await listTrips(b.store)).active) if (s.id !== chat) assert.equal(await b.ws.read(s.id, '/files/hotel.pdf'), undefined, s.title);
});
