import { test } from 'node:test';
import { ZipWriter } from '../../src/core/zip.js';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, ME } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { utf8 } from '../../src/core/bytes.js';

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await host.addBuiltin(new URL('../../src/plugins/files/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  /** @param {string} name @param {any} input @param {any} [model] */
  const run = (name, input, model = { input: ['text', 'image'] }) => tools[name].run(input, { scope: trip, trip, signal: new AbortController().signal, model, wake: 'w', author: 'shiori' });
  return { ws, trip, run, tools };
}

test('write, read, edit, patch and delete, as Shiori, in the open trip and in /me', async () => {
  const { ws, trip, run } = await setup();
  assert.match(await run('write', { path: '/trip/notes/dinner.md', content: '# Dinner\nNepenthe at 6:30\n' }), /Wrote \/trip\/notes\/dinner\.md/);
  assert.equal((await ws.read(trip, '/notes/dinner.md')).entry.author, 'shiori');
  assert.equal(await run('read', { path: '/trip/notes/dinner.md' }), '# Dinner\nNepenthe at 6:30\n');
  await run('edit', { path: '/trip/notes/dinner.md', old: '6:30', new: '7:00' });
  assert.match(await ws.readText(trip, '/notes/dinner.md'), /7:00/);
  await run('write', { path: '/trip/plan/dinner.json', content: { id: 'dinner', title: 'Dinner', fixed: true, tags: ['food'] } });
  await run('patch', { path: '/trip/plan/dinner.json', changes: { notes: 'Window table', 'tags+': ['view'] } });
  assert.deepEqual((await ws.readJSON(trip, '/plan/dinner.json')).tags, ['food', 'view']);
  await run('write', { path: '/me/memory.md', content: '# Memory\n- Likes ocean views\n' });
  assert.match(await ws.readText(ME, '/memory.md'), /ocean views/);
  await run('delete', { path: '/trip/notes/dinner.md' });
  assert.equal(await ws.read(trip, '/notes/dinner.md'), undefined);
});

test('errors are plain and say what to do', async () => {
  const { run } = await setup();
  await run('write', { path: '/trip/notes/a.md', content: 'one two one' });
  await assert.rejects(run('edit', { path: '/trip/notes/a.md', old: 'one', new: '1' }), /appears 2 times/);
  await assert.rejects(run('edit', { path: '/trip/notes/a.md', old: 'three', new: '3' }), /isn't in \/trip\/notes\/a\.md/);
  await assert.rejects(run('read', { path: '/trip/notes/none.md' }), /No file at \/trip\/notes\/none\.md/);
  await assert.rejects(run('write', { path: '/me/personalities/shiori.md', content: 'x' }), /tune_personality/);
  await assert.rejects(run('write', { path: '/trip/plan/bad.json', content: { title: 3 } }), /doesn't match its format/);
});

test("a failed write, edit or patch says plainly that the file wasn't changed (emulator pass: she said she had moved plan items whose edits had failed)", async () => {
  const { ws, trip, run } = await setup();
  await run('write', { path: '/trip/plan/drive.json', content: { id: 'drive', title: 'Drive south', fixed: false } });
  const before = await ws.readText(trip, '/plan/drive.json');
  await assert.rejects(run('edit', { path: '/trip/plan/drive.json', old: '"title": "Drive north"', new: '"title": "Drive later"' }), /^Error: That text isn't in \/trip\/plan\/drive\.json, so it wasn't changed\./);
  await assert.rejects(run('edit', { path: '/trip/plan/drive.json', old: '"', new: "'" }), /appears \d+ times in \/trip\/plan\/drive\.json, so it wasn't changed\./);
  await assert.rejects(run('edit', { path: '/trip/plan/none.json', old: 'a', new: 'b' }), /No file at \/trip\/plan\/none\.json, so nothing was changed\./);
  await assert.rejects(run('patch', { path: '/trip/plan/none.json', changes: { title: 'x' } }), /No file at \/trip\/plan\/none\.json, so nothing was changed\./);
  await assert.rejects(run('write', { path: '/trip/plan/drive.json', content: { title: 3 } }), /doesn't match its format, so it wasn't written:/);
  assert.equal(await ws.readText(trip, '/plan/drive.json'), before);
});

test("patch takes only an object: anything else (JSON text that isn't one, from a model that gives objects as text) changes nothing, where a merge patch would replace the whole file with it", async () => {
  const { ws, run } = await setup();
  await run('write', { path: '/me/notes.json', content: { a: 1 } });
  for (const changes of ['{"a": 2', 'text', ['a'], 3, null]) {
    await assert.rejects(run('patch', { path: '/me/notes.json', changes }), /^Error: changes must be an object, the keys to change, so \/me\/notes\.json wasn't changed\./);
  }
  assert.deepEqual(await ws.readJSON(ME, '/notes.json'), { a: 1 });
});

test('list and search answer in TSV with the paths Shiori uses', async () => {
  const { run } = await setup();
  await run('write', { path: '/trip/notes/a.md', content: 'Bixby Bridge at sunset\nthen dinner' });
  await run('write', { path: '/trip/notes/b.md', content: 'Nothing here' });
  const listing = await run('list', { path: '/trip/notes/' });
  assert.match(listing, /^path\ttype\tsize\tmodified\tauthor\n\/trip\/notes\/a\.md\ttext\/markdown/);
  const found = await run('search', { query: 'bixby' });
  assert.equal(found, 'path\tline\ttext\n/trip/notes/a.md\t1\tBixby Bridge at sunset');
});

test('read: long text in pieces; a photo as an image when the model takes images; a PDF as a document only when it takes PDFs', async () => {
  const { ws, trip, run } = await setup();
  await run('write', { path: '/trip/notes/long.md', content: 'x'.repeat(50_000) });
  const first = await run('read', { path: '/trip/notes/long.md' });
  assert.match(first, /read again with from: 40000/);
  assert.equal((await run('read', { path: '/trip/notes/long.md', from: 40_000 })).length, 10_000);
  const photo = await ws.write(trip, '/files/a.webp', utf8('webp-bytes'), { author: 'user', type: 'image/webp', meta: { width: 2048, height: 1536, taken: '2026-11-26T16:12:00-08:00' } });
  const seen = await run('read', { path: '/trip/files/a.webp' });
  assert.deepEqual(seen.images, [{ mediaType: 'image/webp', hash: photo.hash, path: '/trip/files/a.webp' }]);
  assert.match(seen.content, /2048×1536, taken 2026-11-26T16:12:00-08:00/);
  // A model that can't see photos gets the photo too: the loop has a model that can describe it (5b).
  assert.deepEqual((await run('read', { path: '/trip/files/a.webp' }, { input: ['text'] })).images, seen.images);
  await ws.write(trip, '/files/menu.pdf', utf8('%PDF-1.4'), { author: 'user', type: 'application/pdf' });
  assert.equal((await run('read', { path: '/trip/files/menu.pdf' })).document.name, 'menu.pdf'); // the loop words it for a model that reads no PDFs
  const doc = await run('read', { path: '/trip/files/menu.pdf' }, { input: ['text', 'pdf'] });
  assert.equal(doc.document.mediaType, 'application/pdf');
});

test('personalities are refused however the path is written (the check is on the path as resolved)', async () => {
  const { run } = await setup();
  for (const path of ['/me//personalities/shiori.md', '/me/personalities//shiori.md', '/me//personalities']) {
    await assert.rejects(run('write', { path, content: 'x' }), /tune_personality/, path);
  }
  await assert.rejects(run('patch', { path: '/me//personalities/x.json', changes: { a: 1 } }), /tune_personality/);
  await assert.rejects(run('delete', { path: '/me//personalities/shiori.md' }), /tune_personality/);
});

test('read: a Wallet pass as what it says, and an email as its text', async () => {
  const { ws, trip, run } = await setup();
  const z = new ZipWriter();
  await z.add('pass.json', utf8(JSON.stringify({ organizationName: 'Example Air', boardingPass: { transitType: 'PKTransitTypeAir', primaryFields: [{ key: 'origin', label: 'SFO', value: 'San Francisco' }] } })));
  await ws.write(trip, '/files/flight.pkpass', new Uint8Array(await z.finish().arrayBuffer()), { author: 'user' });
  const read = await run('read', { path: '/trip/files/flight.pkpass' });
  assert.match(read, /^The Wallet pass \/trip\/files\/flight\.pkpass:\n/);
  assert.equal(JSON.parse(read.slice(read.indexOf('\n') + 1)).organization, 'Example Air');
  await ws.write(trip, '/files/broken.pkpass', utf8('not a zip'), { author: 'user' });
  await assert.rejects(run('read', { path: '/trip/files/broken.pkpass' }), /couldn't open this Wallet pass/);
  await ws.write(trip, '/files/hotel.eml', utf8('Subject: Your stay\r\n\r\nConfirmation 7788'), { author: 'user' });
  assert.match(await run('read', { path: '/trip/files/hotel.eml' }), /Confirmation 7788/);
});

test('bookings: Shiori writes them unverified, never confirms one, and her change to a confirmed one goes back to the user', async () => {
  const { ws, trip, run } = await setup();
  const booking = { id: 'hotel', kind: 'lodging', status: 'unverified', source: '/files/hotel.pdf', title: 'Hotel Hoboken' };
  await assert.rejects(run('write', { path: '/trip/bookings/hotel.json', content: { ...booking, status: 'confirmed' } }), /Only the user confirms a booking/);
  assert.equal(await ws.read(trip, '/bookings/hotel.json'), undefined);
  await run('write', { path: '/trip/bookings/hotel.json', content: booking });
  await assert.rejects(run('patch', { path: '/trip/bookings/hotel.json', changes: { status: 'confirmed' } }), /Only the user confirms/);
  await assert.rejects(run('edit', { path: '/trip/bookings/hotel.json', old: '"unverified"', new: '"confirmed"' }), /Only the user confirms/);
  await assert.rejects(run('write', { path: '/trip/bookings/hotel.json', content: JSON.stringify({ ...booking, status: 'confirmed' }) }), /Only the user confirms/);
  assert.equal((await ws.readJSON(trip, '/bookings/hotel.json')).status, 'unverified');
  // The user confirms it.
  await ws.patch(trip, '/bookings/hotel.json', { status: 'confirmed' }, { author: 'user' });
  // Written back unchanged, it stays confirmed; changed, it is unverified again, and she is told.
  assert.match(await run('write', { path: '/trip/bookings/hotel.json', content: { ...booking, status: 'confirmed' } }), /^Wrote \/trip\/bookings\/hotel\.json \(\d+ bytes\)\.$/);
  assert.equal((await ws.readJSON(trip, '/bookings/hotel.json')).status, 'confirmed');
  assert.match(await run('patch', { path: '/trip/bookings/hotel.json', changes: { confirmation: 'HX-7788' } }), /unverified again/);
  assert.deepEqual(await ws.readJSON(trip, '/bookings/hotel.json'), { ...booking, confirmation: 'HX-7788' });
  await assert.rejects(run('patch', { path: '/trip/bookings/none.json', changes: { title: 'x' } }), /No file at \/trip\/bookings\/none\.json/);
  // Other records are not bookings.
  await run('write', { path: '/trip/notes/confirmed.json', content: { status: 'confirmed' } });
});

test('bookings: deleting one the user confirmed goes ahead, and Shiori is told they had confirmed it', async () => {
  const { ws, trip, run } = await setup();
  const booking = { id: 'hotel', kind: 'lodging', status: 'confirmed', source: '/files/hotel.pdf' };
  await ws.write(trip, '/bookings/hotel.json', booking, { author: 'user' });
  const said = await run('delete', { path: '/trip/bookings/hotel.json' });
  assert.match(said, /^Deleted \/trip\/bookings\/hotel\.json\. The user had confirmed this booking\./);
  assert.match(said, /history/);
  assert.equal(await ws.read(trip, '/bookings/hotel.json'), undefined);
  // An unconfirmed booking, and a file that only looks like one, are just deleted.
  await ws.write(trip, '/bookings/car.json', { ...booking, id: 'car', kind: 'car', status: 'unverified' }, { author: 'user' });
  assert.equal(await run('delete', { path: '/trip/bookings/car.json' }), 'Deleted /trip/bookings/car.json.');
  await ws.write(trip, '/notes/confirmed.json', { status: 'confirmed' }, { author: 'user' });
  assert.equal(await run('delete', { path: '/trip/notes/confirmed.json' }), 'Deleted /trip/notes/confirmed.json.');
  await ws.write(trip, '/bookings/broken.json', 'not json', { author: 'user', type: 'text/plain' });
  assert.equal(await run('delete', { path: '/trip/bookings/broken.json' }), 'Deleted /trip/bookings/broken.json.');
});

test("bookings: Shiori can't confirm one through text the rule would read differently, or by racing the user", async () => {
  const { ws, trip, run } = await setup();
  const booking = { id: 'hotel', kind: 'lodging', status: 'unverified', source: '/files/hotel.pdf' };
  // A byte-order mark before the JSON: the store reads it as JSON, so the rule must too.
  await assert.rejects(run('write', { path: '/trip/bookings/hotel.json', content: `﻿${JSON.stringify({ ...booking, status: 'confirmed' })}` }), /Only the user confirms a booking/);
  assert.equal(await ws.read(trip, '/bookings/hotel.json'), undefined);
  // The user takes a confirmation back while Shiori writes the confirmed booking unchanged: the user's word stands.
  await ws.write(trip, '/bookings/hotel.json', { ...booking, status: 'confirmed' }, { author: 'user' });
  const shiori = run('write', { path: '/trip/bookings/hotel.json', content: { ...booking, status: 'confirmed' } });
  const user = ws.patch(trip, '/bookings/hotel.json', { status: 'unverified' }, { author: 'user' });
  await Promise.allSettled([shiori, user]);
  assert.equal((await ws.readJSON(trip, '/bookings/hotel.json')).status, 'unverified');
});

test('plan items and bookings go directly in their folders: Shiori writing one in a subfolder is refused', async () => {
  const { ws, trip, run } = await setup();
  await assert.rejects(run('write', { path: '/trip/bookings/2026/hotel.json', content: { id: 'hotel', kind: 'lodging', status: 'confirmed', source: '/files/x.pdf' } }), /directly in \/trip\/plan\/ and \/trip\/bookings\//);
  await assert.rejects(run('write', { path: '/trip/plan/day1/dinner.json', content: { id: 'd', title: 'Dinner', fixed: true } }), /no subfolders/);
  assert.deepEqual(await ws.list(trip, '/bookings/'), []);
  // Other files may sit in subfolders.
  await run('write', { path: '/trip/bookings/scans/note.md', content: 'scanned' });
});

test('list and search leave the offline pack out unless asked for it (choice 8)', async () => {
  const { ws, trip, run } = await setup();
  await ws.write(trip, '/notes/lunch.md', 'Nepenthe at noon\n', { author: 'user' });
  await ws.write(trip, '/offline/pack.json', '{"format":1}', { author: 'system' });
  await ws.write(trip, '/offline/osm/o1.json', '{"rows":[["n1","Nepenthe","restaurant"]]}', { author: 'system' });
  const all = await run('list', { path: '/' });
  assert.doesNotMatch(all, /\/trip\/offline\//);
  assert.match(all, /\/trip\/notes\/lunch\.md/);
  assert.doesNotMatch(await run('list', { path: '/trip' }), /offline/);
  assert.deepEqual((await run('search', { query: 'nepenthe' })).split('\n').slice(1).map((r) => r.split('\t')[0]), ['/trip/notes/lunch.md']);
  assert.match(await run('list', { path: '/trip/offline/' }), /\/trip\/offline\/osm\/o1\.json/);
  assert.match(await run('search', { query: 'nepenthe', path: '/trip/offline' }), /\/trip\/offline\/osm\/o1\.json/);
});
