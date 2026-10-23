import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, removeTrip, ME } from '../../src/core/scopes.js';
import { logEvent } from '../../src/core/events.js';
import { readBlob, blobBytes, reachable } from '../../src/core/reach.js';
import { sha256Hex } from '../../src/core/hash.js';
import { text } from '../../src/core/bytes.js';

/** Two trips on one device, each with a photo of its own, and a photo of the user's own. */
async function twoTrips() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const a = await createTrip(ws, { title: 'Kyoto' });
  const b = await createTrip(ws, { title: 'Big Sur' });
  const photo = (/** @type {string} */ s) => new TextEncoder().encode(`photo of ${s}`);
  const aPhoto = (await ws.write(a, '/files/temple.jpg', photo('a temple'), { author: 'user', type: 'image/jpeg' })).hash;
  const bPhoto = (await ws.write(b, '/files/coast.jpg', photo('the coast'), { author: 'user', type: 'image/jpeg' })).hash;
  const mePhoto = (await ws.write(ME, '/files/passport.jpg', photo('a passport'), { author: 'user', type: 'image/jpeg' })).hash;
  return { store, ws, a, b, aPhoto, bPhoto, mePhoto };
}

const refusals = async (/** @type {any} */ store, /** @type {string} */ scope) =>
  (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['content.refused'] })));

test("a read by hash gets the trip's own content, and another trip's reads as not stored, logged once with no bytes", async () => {
  const { store, a, b, aPhoto, bPhoto } = await twoTrips();
  assert.equal(text(/** @type {Uint8Array} */ (await blobBytes(store, a, aPhoto))), 'photo of a temple');
  assert.equal(await blobBytes(store, a, bPhoto), null);
  assert.equal(await readBlob(store, b, aPhoto, { via: 'show' }), undefined);
  await blobBytes(store, b, aPhoto); // asked again: not logged again
  const [r, ...more] = await refusals(store, b);
  assert.equal(more.length, 0);
  assert.deepEqual(r.data, { content: `${aPhoto.slice(0, 12)}…`, via: 'show' });
  assert.equal(r.refs, undefined, 'the entry names nothing, so it keeps nothing stored');
  assert.ok(!JSON.stringify(r).includes(aPhoto), 'not the whole hash');
  // A asked for B's photo too: A's own refusal, in A's log.
  assert.deepEqual((await refusals(store, a)).map((e) => e.data.content), [`${bPhoto.slice(0, 12)}…`]);
});

test('content nothing holds reads as not stored, and is no refusal', async () => {
  const { store, b } = await twoTrips();
  assert.equal(await blobBytes(store, b, 'f'.repeat(64)), null);
  assert.equal(await blobBytes(store, b, ''), null);
  assert.equal(await blobBytes(store, b, undefined), null);
  assert.equal((await refusals(store, b)).length, 0);
});

test("from a trip the user's own files are in view (spec §4.3); from the user's own conversation, no trip's are", async () => {
  const { store, a, aPhoto, mePhoto } = await twoTrips();
  assert.ok(await blobBytes(store, a, mePhoto));
  assert.equal(await blobBytes(store, ME, aPhoto), null);
  assert.ok(await blobBytes(store, ME, mePhoto));
});

test("a log entry's refs and file versions make content reachable; a hash only in its data doesn't", async () => {
  const { store, ws, a, b, aPhoto } = await twoTrips();
  // A's photo is named in B's log only inside data: B still doesn't reach it.
  await logEvent(store, b, { type: 'tool.result', data: { images: [{ hash: aPhoto, mediaType: 'image/jpeg' }] } });
  assert.equal(await blobBytes(store, b, aPhoto), null);
  // An older version of A's note, named only by its history, is still A's.
  const first = (await ws.write(a, '/notes/n.md', 'first', { author: 'user' })).hash;
  await ws.write(a, '/notes/n.md', 'second', { author: 'user' });
  assert.equal(text(/** @type {Uint8Array} */ (await blobBytes(store, a, first))), 'first');
  assert.equal(await store.tx(['files', 'events'], 'readonly', (t) => reachable(t, b, first)), false);
});

test("a read through the log entry that names the content looks nothing else up, and only for that entry's own scope", async () => {
  const { store, a, b, aPhoto } = await twoTrips();
  const [own] = await store.tx(['events'], 'readonly', (t) => t.listEvents(a, { types: ['file.write'], reverse: true, limit: 1 }));
  assert.ok(await blobBytes(store, a, aPhoto, { named: own }));
  // The same entry offered for another scope is no shortcut there.
  assert.equal(await blobBytes(store, b, aPhoto, { named: own }), null);
  // An entry that names other content gives no shortcut either.
  assert.equal(await blobBytes(store, b, aPhoto, { named: { scope: b, refs: ['other'] } }), null);
});

test('a refusal for a trip removed meanwhile leaves nothing behind (removing means removing)', async () => {
  const { store, a, b, aPhoto } = await twoTrips();
  await removeTrip(store, b);
  assert.equal(await blobBytes(store, b, aPhoto), null);
  const left = await store.tx(['files', 'events'], 'readonly', (t) => t.scopesWithData());
  assert.ok(left.includes(a) && !left.includes(b), left.join(', '));
});

test('identical bytes are stored once for every trip, and each trip that has them reaches them', async () => {
  const { store, ws, a, b } = await twoTrips();
  const same = new TextEncoder().encode('the same ticket');
  const h1 = (await ws.write(a, '/files/ticket.pdf', same, { author: 'user', type: 'application/pdf' })).hash;
  const h2 = (await ws.write(b, '/files/ticket.pdf', same, { author: 'user', type: 'application/pdf' })).hash;
  assert.equal(h1, h2);
  assert.equal(h1, await sha256Hex(same));
  assert.equal((await store.tx(['blobs'], 'readonly', (t) => t.listBlobs())).filter((x) => x.hash === h1).length, 1);
  assert.ok(await blobBytes(store, a, h1));
  assert.ok(await blobBytes(store, b, h1));
});
