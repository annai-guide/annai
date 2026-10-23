import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, NotFoundError } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, ME } from '../../src/core/scopes.js';
import { record } from '../../src/core/agent/log.js';
import { text } from '../../src/core/bytes.js';

/**
 * One trip can't read another's content by naming its hash (backlog-hash): each path that takes a hash from
 * outside the trip, for another trip's hash (refused, as not stored) and the trip's own (read).
 */
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

test("a log entry can't point at another trip's content by its hash: refused as not stored, and logged", async () => {
  const { store, a, b, aPhoto, bPhoto, mePhoto } = await twoTrips();
  await assert.rejects(record(store, b, { type: 'tool.result', actor: 'plugin:x', data: {}, blobs: [{ hash: aPhoto, type: 'image/jpeg' }] }), /is not stored/);
  // Nor as a file version (data.old or data.new names content too).
  await assert.rejects(record(store, b, { type: 'note', actor: 'plugin:x', data: { old: aPhoto } }), /is not stored/);
  await assert.rejects(record(store, b, { type: 'note', actor: 'plugin:x', data: { new: aPhoto } }), /is not stored/);
  assert.equal((await store.tx(['events'], 'readonly', (t) => t.listEvents(b, { types: ['tool.result', 'note'] }))).length, 0);
  assert.equal((await refusals(store, b)).length, 1);
  // Its own content, the user's own photo (in view from every trip), and bytes given with the entry are fine.
  const own = await record(store, b, { type: 'tool.result', actor: 'system', data: {}, blobs: [{ hash: bPhoto, type: 'image/jpeg' }, { hash: mePhoto, type: 'image/jpeg' }] });
  assert.deepEqual(own.refs, [bPhoto, mePhoto]);
  const withBytes = await record(store, b, { type: 'tool.result', actor: 'system', data: {}, blobs: [{ bytes: new TextEncoder().encode('photo of a temple'), type: 'image/jpeg' }] });
  assert.deepEqual(withBytes.refs, [aPhoto], 'the same bytes, given: the trip has them now');
  assert.ok(await record(store, a, { type: 'note', actor: 'system', data: { old: aPhoto } }));
});

test("restoring a version restores the trip's own, never another trip's content named by its hash", async () => {
  const { store, ws, b, aPhoto } = await twoTrips();
  await assert.rejects(ws.restore(b, '/notes/n.md', aPhoto, { author: 'user' }), NotFoundError);
  assert.equal(await ws.read(b, '/notes/n.md'), undefined);
  assert.equal((await refusals(store, b)).length, 1);
  const first = (await ws.write(b, '/notes/n.md', 'first', { author: 'user' })).hash;
  await ws.write(b, '/notes/n.md', 'second', { author: 'user' });
  await ws.restore(b, '/notes/n.md', first, { author: 'user' });
  assert.equal(await ws.readText(b, '/notes/n.md'), 'first');
  assert.equal(text(/** @type {any} */ (await ws.read(b, '/notes/n.md')).bytes), 'first');
});

// The agent's paths: a tool's result, a request copy, the task helper, the conversation as read back, a kept clip.
const { agentKit } = await import('./agent-kit.js');
const { resolveEvent } = await import('../../src/core/agent/transcript.js');
const { logEvent } = await import('../../src/core/events.js');
const { toBase64 } = await import('../../src/core/bytes.js');
const say = (/** @type {string} */ t) => ({ toolCalls: [{ name: 'speak', input: { text: t } }, { name: 'sleep', input: {} }] });
const imagesIn = (/** @type {any} */ request) => request.messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'image' && p.data);

/** The kit's trip (Big Sur) and another (Kyoto) with a photo of its own, and a tool that returns whatever hash it is given. */
async function kitWithOther(/** @type {any[]} */ scripts, /** @type {any} */ opts = {}) {
  const k = await agentKit(scripts, opts);
  const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
  const theirs = (await k.ws.write(kyoto, '/files/temple.jpg', new TextEncoder().encode('600x400 the temple'), { author: 'user', type: 'image/jpeg', meta: { width: 600, height: 400 } })).hash;
  const ours = (await k.ws.write(k.trip, '/files/coast.jpg', new TextEncoder().encode('600x400 the coast'), { author: 'user', type: 'image/jpeg', meta: { width: 600, height: 400 } })).hash;
  /** @type {{ hash: string }} */
  const ask = { hash: theirs };
  k.registry.add('test', 'tool', { name: 'claim', description: 'A photo by its hash.', input: { type: 'object' }, run: async () => ({ content: 'A photo.', images: [{ mediaType: 'image/jpeg', hash: ask.hash }] }) });
  return { ...k, kyoto, theirs, ours, ask };
}

test("a tool's result naming another trip's photo by its hash is that tool's error; the trip's own photo goes", async () => {
  const k = await kitWithOther([[{ toolCalls: [{ name: 'claim', input: {} }] }, say('Nothing there.'), { toolCalls: [{ name: 'claim', input: {} }] }, say('Your coast.')]]);
  k.agent.send('Show me.');
  await k.agent.idle();
  const [claimed] = (await k.events(['tool.result'])).filter((e) => e.data.name === 'claim');
  assert.equal(claimed.data.ok, false);
  assert.match(claimed.data.content, /claim gave back an image annai can't read/);
  assert.equal(claimed.refs?.includes(k.theirs) ?? false, false);
  assert.deepEqual(k.requests.flatMap(imagesIn), [], 'no photo of Kyoto reached the model');
  assert.equal((await refusals(k.store, k.trip)).length, 1);
  k.ask.hash = k.ours;
  k.agent.send('And the coast?');
  await k.agent.idle();
  const [, own] = (await k.events(['tool.result'])).filter((e) => e.data.name === 'claim');
  assert.equal(own.data.ok, true);
  assert.equal(imagesIn(k.requests.at(-1)).length, 1);
});

test("a tool's request copy of another trip's photo, by its hash, is refused", async () => {
  const k = await kitWithOther([[{ toolCalls: [{ name: 'copy', input: {} }] }, say('No.')]], { models: [{ images: { maxEdge: 300 } }] });
  /** @type {any[]} */
  const copied = [];
  k.registry.add('test', 'tool', { name: 'copy', description: 'A copy of a photo by its hash.', input: { type: 'object' }, run: async (/** @type {any} */ _i, /** @type {any} */ call) => {
    for (const hash of [k.theirs, k.ours]) {
      try {
        const c = await call.photos.copy({ hash, type: 'image/jpeg', width: 600, height: 400, size: 18 });
        copied.push(c.made ? 'a copy' : 'as it is');
      } catch (e) {
        copied.push(String(/** @type {any} */ (e).message));
      }
    }
    return 'tried';
  } });
  k.agent.send('Copy it.');
  await k.agent.idle();
  assert.deepEqual(copied, ['That photo is no longer stored.', 'a copy']);
  assert.equal((await refusals(k.store, k.trip)).length, 1);
});

test('a photo in both trips is sent from each: its request copy is made for each, never read by its hash from the other', async () => {
  const read = { toolCalls: [{ name: 'read', input: { path: '/trip/files/same.jpg' } }] };
  const k = await kitWithOther([[read, say('Here.'), read, say('Here too.')]], { models: [{ images: { maxEdge: 300 } }] });
  const same = new TextEncoder().encode('600x400 the same view');
  for (const t of [k.kyoto, k.trip]) await k.ws.write(t, '/files/same.jpg', same, { author: 'user', type: 'image/jpeg', meta: { width: 600, height: 400 } });
  await k.agent.open(k.kyoto);
  k.agent.send('Show the view.');
  await k.agent.idle();
  await k.agent.open(k.trip);
  k.agent.send('Show the view here.');
  await k.agent.idle();
  const reads = (await k.store.tx(['events'], 'readonly', (t) => Promise.all([k.kyoto, k.trip].map((s) => t.listEvents(s, { types: ['tool.result'] })))))
    .map((list) => list.filter((e) => e.data.name === 'read').map((e) => ({ ok: e.data.ok, images: e.data.images?.length ?? 0 })));
  assert.deepEqual(reads, [[{ ok: true, images: 1 }], [{ ok: true, images: 1 }]]);
  assert.equal(imagesIn(k.requests.at(-1)).length, 1);
  assert.equal((await k.events(['error'])).length, 0);
});

test("the task helper's tools get no other trip's photo by its hash", async () => {
  const k = await kitWithOther([[{ toolCalls: [{ name: 'task', input: { prompt: 'Look at the photo.', tools: ['claim'] } }] }, say('Done.')]], {
    utility: [{ toolCalls: [{ name: 'claim', input: {} }] }, { text: 'Nothing to see.' }],
  });
  k.agent.send('Have a helper look.');
  await k.agent.idle();
  const helper = k.sent['model-u'];
  assert.equal(helper.length, 2);
  assert.deepEqual(imagesIn(helper[1]), []);
  assert.match(JSON.stringify(helper[1].messages), /couldn't be read: its file is no longer stored/);
});

test("the conversation read back shows no other trip's photo or PDF named only in an entry's data", async () => {
  const k = await kitWithOther([[say('Hi.')]], { open: false });
  // Entries written past record(), naming Kyoto's photo only in their data, not as a name (refs, data.old, data.new):
  // a name can only be written through record(), restore() or an import, each held to the same rule.
  await logEvent(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: 'Look', images: [{ hash: k.theirs, mediaType: 'image/jpeg' }, { hash: k.ours, mediaType: 'image/jpeg' }] } });
  await logEvent(k.store, k.trip, { type: 'tool.call', actor: 'shiori', data: { id: 'c1', name: 'read', input: {} } });
  await logEvent(k.store, k.trip, { type: 'tool.result', actor: 'system', data: { id: 'c1', name: 'read', ok: true, content: 'A PDF.', document: { hash: k.theirs, mediaType: 'application/pdf' } } });
  const logged = await k.store.tx(['events'], 'readonly', (t) => t.listEvents(k.trip, { types: ['msg.user', 'tool.result'] }));
  const parts = (await Promise.all(logged.map((e) => resolveEvent(k.store, e)))).flatMap((r) => r.images);
  const kyoto = toBase64(new TextEncoder().encode('600x400 the temple'));
  assert.equal(parts.length, 3, JSON.stringify(parts.map((/** @type {any} */ p) => p.type)));
  assert.ok(parts.every((/** @type {any} */ p) => p.data !== kyoto), 'nothing of Kyoto');
  assert.ok(parts.some((/** @type {any} */ p) => p.data === toBase64(new TextEncoder().encode('600x400 the coast'))), "the trip's own photo");
});

test("a kept voice clip is read back only in its own trip's conversation", async () => {
  const k = await kitWithOther([[say('Noted.')]], { voice: { speechIn: ['send-audio'], keepClips: true } });
  const clip = (await record(k.store, k.kyoto, { type: 'heard', actor: 'user', data: { id: 'h-kyoto', clip: 'x' }, blobs: [{ bytes: new TextEncoder().encode('RIFF-kyoto'), type: 'audio/wav' }] })).refs[0];
  const asked = { messages: [{ role: 'user', parts: [{ type: 'speech', id: 'h-gone', clip }] }] };
  const model = { id: 'm-0', name: 'E0', input: ['text', 'audio'] };
  const here = await k.voice.resolver(k.trip)(model, structuredClone(asked));
  assert.equal(here.messages[0].parts[0].type, 'text', 'not heard here');
  const there = await k.voice.resolver(k.kyoto)(model, structuredClone(asked));
  assert.equal(there.messages[0].parts[0].type, 'audio');
});

// Imported archives: an archive names only content it carries, or content the scope it replaces already named.
const { exportArchive, peekArchive, importArchive, ArchiveError, PRESETS, MANIFEST_NAME } = await import('../../src/core/archive.js');
const { ZipWriter, readZip } = await import('../../src/core/zip.js');
const { sha256Hex } = await import('../../src/core/hash.js');
const { utf8 } = await import('../../src/core/bytes.js');
const { blobBytes } = await import('../../src/core/reach.js');
const { listTrips } = await import('../../src/core/scopes.js');

/**
 * Someone else's trip as an archive, changed by edit() (its manifest, its entries) with the manifest's hashes of what
 * changed made right again: a forgery that passes every check of an archive's own integrity.
 * @param {(manifest: any, entries: Map<string, Uint8Array>, log: (change: (lines: any[]) => any[]) => void) => void | Promise<void>} edit
 */
async function forged(edit) {
  const x = await twoTrips();
  await x.ws.write(x.a, '/notes/plan.md', 'their plan', { author: 'user' });
  const { blob } = await exportArchive(x.store, { kind: 'trip', scopes: [x.a], include: PRESETS.backup, app: '0.1.0' });
  const entries = await readZip(new Uint8Array(await blob.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(entries.get(MANIFEST_NAME)));
  const logName = manifest.scopes[0].events;
  const log = (/** @type {(lines: any[]) => any[]} */ change) => {
    const lines = new TextDecoder().decode(entries.get(logName)).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    entries.set(logName, utf8(`${change(lines).map((l) => JSON.stringify(l)).join('\n')}\n`));
  };
  await edit(manifest, entries, log);
  for (const e of manifest.extras) e.hash = await sha256Hex(/** @type {Uint8Array} */ (entries.get(e.name)));
  const z = new ZipWriter();
  for (const [name, bytes] of entries) await z.add(name, name === MANIFEST_NAME ? utf8(JSON.stringify(manifest)) : bytes);
  return new Uint8Array(await z.finish().arrayBuffer());
}

test("a forged archive's log naming a trip's photo it doesn't carry: the name is dropped, so the imported trip never reads it", async () => {
  const v = await twoTrips(); // the device it is imported on: bPhoto is Big Sur's
  const file = await forged((_m, _e, log) => log((lines) => [...lines, { seq: lines.at(-1).seq + 1, ts: 9, type: 'tool.result', actor: 'system', data: { id: 'c', name: 'read', ok: true, images: [{ hash: v.bPhoto, mediaType: 'image/jpeg' }], old: v.bPhoto }, refs: [v.bPhoto] }]));
  const [mine] = (await importArchive(v.store, await peekArchive(file))).trips;
  const events = await v.store.tx(['events'], 'readonly', (t) => t.listEvents(mine));
  const planted = /** @type {any} */ (events.find((e) => e.data?.id === 'c'));
  assert.deepEqual(planted.refs, ['']);
  assert.equal(planted.data.old, null);
  assert.equal(await blobBytes(v.store, mine, v.bPhoto), null);
  assert.deepEqual(events.find((e) => e.type === 'content.refused')?.data, { content: `${v.bPhoto.slice(0, 12)}…`, via: 'import' });
  // A Backup of the imported trip doesn't carry Big Sur's photo either.
  const { manifest } = await exportArchive(v.store, { kind: 'trip', scopes: [mine], include: PRESETS.backup, app: '0.1.0' });
  assert.ok(![...manifest.files, ...manifest.blobs].some((x) => x.hash === v.bPhoto));
  // Big Sur still has it.
  assert.ok(await blobBytes(v.store, v.b, v.bPhoto));
});

test("a forged archive whose file claims a trip's photo by its hash, with other bytes, is refused, and nothing is imported", async () => {
  const v = await twoTrips();
  const file = await forged((manifest) => {
    const f = manifest.files.find((/** @type {any} */ x) => x.path === '/notes/plan.md');
    f.hash = v.bPhoto; // its entry still holds "their plan"
  });
  await assert.rejects(importArchive(v.store, await peekArchive(file)), (e) => e instanceof ArchiveError && /damaged/.test(e.message));
  assert.deepEqual((await listTrips(v.store)).active.map((t) => t.title).sort(), ['Big Sur', 'Kyoto']);
});

test("an archive's own content, and content its maker no longer had, import as they were", async () => {
  const v = await twoTrips();
  const gone = 'e'.repeat(64); // a refused request copy, removed on the device that made the archive
  const file = await forged((_m, _e, log) => log((lines) => [...lines, { seq: lines.at(-1).seq + 1, ts: 9, type: 'photo.replace', actor: 'system', data: { old: gone, new: gone, mediaType: 'image/webp' } }]));
  const [mine] = (await importArchive(v.store, await peekArchive(file))).trips;
  const events = await v.store.tx(['events'], 'readonly', (t) => t.listEvents(mine));
  assert.equal(events.find((e) => e.type === 'photo.replace')?.data.old, gone);
  assert.equal(events.find((e) => e.type === 'content.refused'), undefined);
  assert.equal(await v.ws.readText(mine, '/notes/plan.md'), 'their plan');
  const photo = /** @type {any} */ (await v.ws.read(mine, '/files/temple.jpg'));
  assert.ok(await blobBytes(v.store, mine, photo.entry.hash));
});

test("replacing the user's own files keeps names of content they already held, not another trip's", async () => {
  const v = await twoTrips();
  const x = await twoTrips();
  const { blob } = await exportArchive(x.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const entries = await readZip(new Uint8Array(await blob.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(entries.get(MANIFEST_NAME)));
  const me = manifest.scopes.find((/** @type {any} */ s) => s.record.id === 'me');
  const lines = new TextDecoder().decode(entries.get(me.events)).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  lines.push({ seq: lines.at(-1).seq + 1, ts: 9, type: 'note', actor: 'system', data: {}, refs: [v.mePhoto, v.aPhoto] });
  entries.set(me.events, utf8(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`));
  for (const e of manifest.extras) e.hash = await sha256Hex(/** @type {Uint8Array} */ (entries.get(e.name)));
  // Only "me" is taken: the archive's trips are skipped, so the photos it carries for them are no help.
  manifest.files = manifest.files.filter((/** @type {any} */ f) => f.scope === 'me' && f.path !== '/files/passport.jpg');
  manifest.blobs = [];
  const z = new ZipWriter();
  for (const [name, bytes] of entries) await z.add(name, name === MANIFEST_NAME ? utf8(JSON.stringify(manifest)) : bytes);
  const opened = await peekArchive(new Uint8Array(await z.finish().arrayBuffer()));
  await importArchive(v.store, opened, { me: 'replace', trips: Object.fromEntries(manifest.scopes.filter((/** @type {any} */ s) => s.record.kind === 'trip').map((/** @type {any} */ s) => [s.record.id, 'skip'])) });
  const [note] = await v.store.tx(['events'], 'readonly', (t) => t.listEvents(ME, { types: ['note'] }));
  assert.deepEqual(note.refs, [v.mePhoto, '']);
  assert.equal(await blobBytes(v.store, ME, v.aPhoto), null);
  assert.ok(await blobBytes(v.store, ME, v.mePhoto));
});

// Removing means removing: content two trips share stays while either names it, and goes with the last;
// a name planted elsewhere (an import, a plugin's log entry) never keeps a removed trip's content stored.
const { removeTrip, SYS } = await import('../../src/core/scopes.js');
const held = (/** @type {any} */ store, /** @type {string} */ hash) => store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.hasBlob(hash));

test('a photo two trips share stays while either has it, and goes with the last', async () => {
  const v = await twoTrips();
  const same = (await v.ws.write(v.a, '/files/coast.jpg', new TextEncoder().encode('photo of the coast'), { author: 'user', type: 'image/jpeg' })).hash;
  assert.equal(same, v.bPhoto, 'stored once for both');
  await removeTrip(v.store, v.b);
  assert.equal(await held(v.store, same), true);
  assert.ok(await blobBytes(v.store, v.a, same));
  await removeTrip(v.store, v.a);
  assert.equal(await held(v.store, same), false);
  assert.equal(await held(v.store, v.aPhoto), false);
  assert.equal(await held(v.store, v.mePhoto), true, "the user's own photo stays");
});

test("a name planted in another scope, by a plugin's log entry or a forged import, doesn't keep a removed trip's photo", async () => {
  const v = await twoTrips();
  // A plugin's log entry in the system log, pointing at Big Sur's photo by its hash: refused.
  await assert.rejects(record(v.store, SYS, { type: 'cache', actor: 'plugin:x', data: {}, blobs: [{ hash: v.bPhoto, type: 'image/jpeg' }] }), /is not stored/);
  // An archive naming it: the name is dropped.
  const file = await forged((_m, _e, log) => log((lines) => [...lines, { seq: lines.at(-1).seq + 1, ts: 9, type: 'tool.result', actor: 'system', data: {}, refs: [v.bPhoto] }]));
  const [mine] = (await importArchive(v.store, await peekArchive(file))).trips;
  await removeTrip(v.store, v.b);
  assert.equal(await held(v.store, v.bPhoto), false, 'Big Sur removed: its photo goes');
  assert.equal(await blobBytes(v.store, mine, v.bPhoto), null);
});


test("an import stores only content the scopes it takes name: a skipped trip's older versions aren't left behind, named by nothing", async () => {
  const x = await twoTrips();
  await x.ws.write(x.a, '/notes/plan.md', 'their first plan', { author: 'user' });
  await x.ws.write(x.a, '/notes/plan.md', 'their second plan', { author: 'user' });
  const old = await sha256Hex(utf8('their first plan'));
  const { blob } = await exportArchive(x.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const v = await twoTrips();
  const opened = await peekArchive(new Uint8Array(await blob.arrayBuffer()));
  assert.ok(opened.manifest.blobs.some((b) => b.hash === old), 'the archive carries the older version');
  // Every trip in it skipped: nothing of theirs comes in.
  await importArchive(v.store, opened, { trips: Object.fromEntries(opened.manifest.scopes.filter((s) => s.record.kind === 'trip').map((s) => [s.record.id, 'skip'])) });
  assert.equal(await held(v.store, old), false);
});
