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
  // Neither trip asked for the other's copy: no refusal in either (review, 5a; probe Q2).
  assert.deepEqual([(await refusals(k.store, k.kyoto)).length, (await refusals(k.store, k.trip)).length], [0, 0]);
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

test("a forged archive's log naming a trip's photo it doesn't carry: the name is moved out of what names content, so the imported trip never reads it", async () => {
  const v = await twoTrips(); // the device it is imported on: bPhoto is Big Sur's
  const file = await forged((_m, _e, log) => log((lines) => [...lines, { seq: lines.at(-1).seq + 1, ts: 9, type: 'tool.result', actor: 'system', data: { id: 'c', name: 'read', ok: true, images: [{ hash: v.bPhoto, mediaType: 'image/jpeg' }], old: v.bPhoto }, refs: [v.bPhoto] }]));
  const [mine] = (await importArchive(v.store, await peekArchive(file))).trips;
  const events = await v.store.tx(['events'], 'readonly', (t) => t.listEvents(mine));
  const planted = /** @type {any} */ (events.find((e) => e.data?.id === 'c'));
  assert.deepEqual(planted.refs, ['']);
  assert.equal(planted.data.old, null);
  assert.deepEqual(planted.data.was, { old: v.bPhoto });
  assert.equal(await blobBytes(v.store, mine, v.bPhoto), null);
  // Said quietly, on the import's own line: no error in the Trace (review, 12).
  assert.equal(events.find((e) => e.type === 'content.refused'), undefined);
  assert.equal(events.find((e) => e.type === 'import')?.data.uncarried, 1);
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

test("an archive's own content imports as it was; content its maker no longer had is kept as what it was, naming nothing", async () => {
  const v = await twoTrips();
  const gone = 'e'.repeat(64); // a refused request copy, removed on the device that made the archive
  const file = await forged((_m, _e, log) => log((lines) => [...lines, { seq: lines.at(-1).seq + 1, ts: 9, type: 'photo.replace', actor: 'system', data: { old: gone, new: gone, mediaType: 'image/webp' } }]));
  const [mine] = (await importArchive(v.store, await peekArchive(file))).trips;
  const events = await v.store.tx(['events'], 'readonly', (t) => t.listEvents(mine));
  assert.deepEqual(events.find((e) => e.type === 'photo.replace')?.data, { old: null, new: null, was: { old: gone, new: gone }, mediaType: 'image/webp' });
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

// The review's fix pass (b036a4c): what a writer stores is always the hash of its bytes; names are 64-hex fingerprints.
test("record() keeps bytes under their own hash: a hash claimed beside other bytes is refused, so it neither plants a name nor poisons content (review P2a, P2b)", async () => {
  const v = await twoTrips();
  await assert.rejects(record(v.store, v.b, { type: 'x', actor: 'plugin:p', data: {}, blobs: [{ hash: v.aPhoto, bytes: utf8('junk'), type: 'image/jpeg' }] }), /has another fingerprint/);
  assert.equal(await blobBytes(v.store, v.b, v.aPhoto), null);
  // Content nobody holds yet, claimed for other bytes: nothing is stored under its hash.
  const real = utf8('the real ticket');
  const H = await sha256Hex(real);
  await assert.rejects(record(v.store, v.b, { type: 'x', actor: 'plugin:p', data: {}, blobs: [{ hash: H, bytes: utf8('poison'), type: 'application/pdf' }] }), /has another fingerprint/);
  assert.equal(await held(v.store, H), false);
  await v.ws.write(v.a, '/files/ticket.pdf', real, { author: 'user', type: 'application/pdf' });
  assert.equal(await v.ws.readText(v.a, '/files/ticket.pdf'), 'the real ticket');
  // Bytes with their own hash, and bytes alone, are kept as before.
  const ok = await record(v.store, v.b, { type: 'x', actor: 'plugin:p', data: {}, blobs: [{ hash: H, bytes: real, type: 'application/pdf' }, { bytes: utf8('a note'), type: 'text/plain' }] });
  assert.deepEqual(ok.refs, [H, await sha256Hex(utf8('a note'))]);
});

test("a plugin's log entry may say what changed in words: only 64-hex fingerprints in data.old and data.new name content (review P3)", async () => {
  const v = await twoTrips();
  const e = await record(v.store, v.b, { type: 'place.change', actor: 'plugin:p', data: { old: 'Tokyo', new: 'Kyoto' } });
  assert.deepEqual(e.data, { old: 'Tokyo', new: 'Kyoto' });
  const { blobsOf } = await import('../../src/core/events.js');
  assert.deepEqual(blobsOf({ data: { old: 'Tokyo', new: v.aPhoto.toUpperCase() }, refs: ['', 'h1', v.aPhoto] }), [v.aPhoto]);
  // A Backup of the trip doesn't look for content called "Tokyo".
  const { manifest } = await exportArchive(v.store, { kind: 'trip', scopes: [v.b], include: PRESETS.backup, app: '0.1.0' });
  assert.ok(manifest.files.length > 0);
});

test('logEvent writes no names: an entry that names stored content goes through record(), held to the rule (Step, 8)', async () => {
  const v = await twoTrips();
  await assert.rejects(logEvent(v.store, v.b, { type: 'x', refs: [v.aPhoto] }), /record\(\)/);
  await assert.rejects(logEvent(v.store, v.b, { type: 'x', data: { new: v.aPhoto } }), /record\(\)/);
  assert.equal((await v.store.tx(['events'], 'readonly', (t) => t.listEvents(v.b, { types: ['x'] }))).length, 0);
  assert.ok(await logEvent(v.store, v.b, { type: 'x', data: { old: 'Tokyo', new: 'Kyoto' } }));
});

test("an entry that says it stored texts but names none reads as none (Step, 9)", async () => {
  const v = await twoTrips();
  const e = await v.store.tx(['events'], 'readwrite', (t) => t.appendEvent(v.b, { ts: 1, type: 'msg.user', actor: 'user', data: { stored: ['text', 'more'] }, refs: [''] }));
  const { storedTexts } = await import('../../src/core/agent/log.js');
  assert.deepEqual(await storedTexts(v.store, e), {});
});

// The import, again (review items 2, 3, 5b, 7, 12 and 14).
const { Transcript } = await import('../../src/core/agent/transcript.js');
const { latestCopy, replacements } = await import('../../src/ui/screens/talk.js');
const { traceSummary } = await import('../../src/ui/screens/trace.js');
/** A device with nothing on it yet. */
const freshDevice = async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  return { store, ws };
};

test("an import names nothing it doesn't carry, held here or not: content the device gets later stays out of its reach, and goes with its owner (review, 2; probe Q1)", async () => {
  const secret = utf8('photo of the victim, later');
  const H = await sha256Hex(secret);
  const file = await forged((_m, _e, log) => log((lines) => [...lines, { seq: lines.at(-1).seq + 1, ts: 9, type: 'tool.result', actor: 'system', data: { images: [{ hash: H, mediaType: 'image/jpeg' }] }, refs: [H] }]));
  const v = await twoTrips();
  const [planted] = (await importArchive(v.store, await peekArchive(file))).trips;
  const own = await createTrip(v.ws, { title: 'Mine' });
  await v.ws.write(own, '/files/me.jpg', secret, { author: 'user', type: 'image/jpeg' });
  assert.equal(await blobBytes(v.store, planted, H), null);
  const { manifest } = await exportArchive(v.store, { kind: 'trip', scopes: [planted], include: PRESETS.backup, app: '0.1.0' });
  assert.ok(!manifest.blobs.some((b) => b.hash === H));
  await removeTrip(v.store, own);
  assert.equal(await held(v.store, H), false, 'removing its owner frees it');
});

test("a refused photo copy its maker removed still maps to its replacement after an import, for the model and on the conversation's screen (review, 2)", async () => {
  const x = await twoTrips();
  const [c1, c2] = [utf8('copy one'), utf8('copy two')];
  const [h1, h2] = [await sha256Hex(c1), await sha256Hex(c2)];
  // As the loop logs it: the message sent copy one; a model refused it, copy two replaced it, and copy one went.
  await record(x.store, x.a, { type: 'msg.user', actor: 'user', data: { text: 'look', images: [{ hash: h1, mediaType: 'image/webp' }] }, blobs: [{ bytes: c1, type: 'image/webp' }] });
  await record(x.store, x.a, { type: 'photo.replace', actor: 'system', data: { old: h1, new: h2, mediaType: 'image/webp' }, blobs: [{ bytes: c2, type: 'image/webp' }] });
  await x.store.tx(['blobs'], 'readwrite', (t) => t.deleteBlob(h1));
  const { blob } = await exportArchive(x.store, { kind: 'trip', scopes: [x.a], include: PRESETS.backup, app: '0.1.0' });
  const d = await freshDevice();
  const [mine] = (await importArchive(d.store, await peekArchive(new Uint8Array(await blob.arrayBuffer())))).trips;
  const t = await Transcript.load(d.store, mine);
  const sent = t.messages.flatMap((m) => m.parts).filter((/** @type {any} */ p) => p.type === 'image');
  assert.deepEqual(sent.map((/** @type {any} */ p) => p.data), [toBase64(c2)]);
  const events = await d.store.tx(['events'], 'readonly', (tx) => tx.listEvents(mine, { types: ['photo.replace'] }));
  assert.equal(latestCopy(h1, replacements(events)), h2);
});

test("reading an entry's own data is quiet: what it names only in its data reads as missing and logs nothing, load after load (review, 5b; probe P5)", async () => {
  const v = await twoTrips();
  const file = await forged((_m, _e, log) => log((lines) => [...lines, { seq: lines.at(-1).seq + 1, ts: 9, type: 'msg.user', actor: 'user', data: { text: 'x', images: [{ hash: v.bPhoto, mediaType: 'image/jpeg' }] }, refs: [v.bPhoto] }]));
  const [mine] = (await importArchive(v.store, await peekArchive(file))).trips;
  const [e] = await v.store.tx(['events'], 'readonly', (t) => t.listEvents(mine, { types: ['msg.user'] }));
  for (let load = 0; load < 3; load++) {
    /** @type {any} a page load: a store annai hasn't logged anything for yet */
    const page = { tx: (/** @type {any[]} */ ...a) => /** @type {any} */ (v.store.tx)(...a), close: () => {} };
    assert.equal(/** @type {any} */ ((await resolveEvent(page, e)).images[0]).missing, true);
  }
  assert.equal((await refusals(v.store, mine)).length, 0);
});

test("a Share with its history, imported again on the same device: its older photo versions are left out quietly, and their history rows have no version to restore (review, 14; probe P7)", async () => {
  const v = await twoTrips();
  await v.ws.write(v.a, '/files/temple.jpg', utf8('photo of a temple, edited'), { author: 'user', type: 'image/jpeg' });
  const { blob, manifest } = await exportArchive(v.store, { kind: 'trip', scopes: [v.a], include: PRESETS.backup, app: '0.1.0', share: { places: true } });
  assert.ok(!manifest.blobs.some((b) => b.hash === v.aPhoto), 'a Share leaves older photos out');
  const [t] = (await importArchive(v.store, await peekArchive(new Uint8Array(await blob.arrayBuffer())))).trips;
  assert.equal((await refusals(v.store, t)).length, 0);
  assert.deepEqual((await v.ws.history(t, '/files/temple.jpg')).map((h) => h.new === null), [true, false]);
  const [imported] = await v.store.tx(['events'], 'readonly', (tx) => tx.listEvents(t, { types: ['import'] }));
  assert.equal(imported.data.uncarried, 1);
  assert.equal(traceSummary(imported), "from a trip's file, annai 0.1.0 · 1 piece of content it didn't hold left out");
});

test("restoring everything with 'me' kept: the trips' names of the user's own photos stay, carried by the file's 'me' (review, 3; probes P4, P4b)", async () => {
  const v = await twoTrips();
  await record(v.store, v.a, { type: 'msg.user', actor: 'user', data: { text: 'my passport', images: [{ hash: v.mePhoto, mediaType: 'image/jpeg', path: '/me/files/passport.jpg' }] }, blobs: [{ hash: v.mePhoto, type: 'image/jpeg' }] });
  const { blob } = await exportArchive(v.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // The same device (P4), and a second phone that holds the same /me/ photo (P4b); "me" is kept, the default.
  for (const d of [v, await twoTrips()]) {
    const { trips } = await importArchive(d.store, await peekArchive(bytes));
    const sent = (await d.store.tx(['events'], 'readonly', async (t) => (await Promise.all(trips.map((id) => t.listEvents(id, { types: ['msg.user'] })))).flat()));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].refs, [v.mePhoto]);
    // The /me/ photo changes: the restored trip keeps the photo it sent, as the original does.
    await d.ws.write(ME, '/files/passport.jpg', utf8('passport, renewed'), { author: 'user', type: 'image/jpeg' });
    assert.ok(await blobBytes(d.store, sent[0].scope, v.mePhoto));
  }
});

test('"Replace mine" reads none of the content the copy it replaces already has (review, 7)', async () => {
  const v = await twoTrips();
  for (let i = 0; i < 3; i++) await v.ws.write(v.a, `/files/p${i}.jpg`, utf8(`photo ${i}`), { author: 'user', type: 'image/jpeg' });
  const { blob } = await exportArchive(v.store, { kind: 'trip', scopes: [v.a], include: PRESETS.backup, app: '0.1.0' });
  const opened = await peekArchive(new Uint8Array(await blob.arrayBuffer()));
  /** @type {string[]} */
  const read = [];
  const was = opened.zip.read.bind(opened.zip);
  opened.zip.read = async (/** @type {string} */ name) => { read.push(name); return was(name); };
  const { trips, archived } = await importArchive(v.store, opened, { trips: { [opened.manifest.scopes[0].record.id]: 'replace' } });
  assert.deepEqual(archived, [v.a]);
  assert.deepEqual(read.filter((n) => !n.endsWith('events.jsonl')), []);
  assert.equal(await v.ws.readText(trips[0], '/files/p2.jpg'), 'photo 2');
});

test("a held hash whose entry is another size is refused before the entry is read (review, 7)", async () => {
  const v = await twoTrips();
  const file = await forged((manifest) => {
    manifest.files.find((/** @type {any} */ x) => x.path === '/notes/plan.md').hash = v.bPhoto; // "their plan": not the photo's size
  });
  const opened = await peekArchive(file);
  /** @type {string[]} */
  const read = [];
  const was = opened.zip.read.bind(opened.zip);
  opened.zip.read = async (/** @type {string} */ name) => { read.push(name); return was(name); };
  await assert.rejects(importArchive(v.store, opened), (e) => e instanceof ArchiveError && /damaged/.test(e.message));
  assert.ok(!read.some((n) => n.endsWith('/notes/plan.md')), read.join());
});

// False changes and false refusals (review items 4, 5a and 10).
const { backupState, recordBackup } = await import('../../src/core/scopes.js');
const { changedSince } = await import('../../src/core/backup-auto.js');

test("a refused read's note is no change to the trip: no 'hasn't been backed up' question, and no backup due for it (review, 4; probe P6)", async () => {
  const v = await twoTrips();
  const seqs = await v.store.tx(['scopes', 'events'], 'readonly', async (t) => Object.fromEntries(await Promise.all((await t.listScopes()).map(async (s) => [s.id, await t.lastSeq(s.id)]))));
  await recordBackup(v.store, new Map([[v.b, seqs[v.b]]]), 1);
  assert.equal(await blobBytes(v.store, v.b, v.aPhoto, { via: 'show' }), null);
  assert.equal((await refusals(v.store, v.b)).length, 1);
  assert.equal((await backupState(v.store, v.b)).changed, false);
  assert.deepEqual(await changedSince(v.store, seqs), { changed: false, lastChangeAt: null });
  // A real change after it still counts.
  await v.ws.write(v.b, '/notes/n.md', 'new', { author: 'user' });
  assert.equal((await backupState(v.store, v.b)).changed, true);
  assert.equal((await changedSince(v.store, seqs)).changed, true);
});

test("restoring a trip file's version takes only the trip's own history: the user's own photo isn't copied into a trip that way (Step, 10)", async () => {
  const v = await twoTrips();
  await assert.rejects(v.ws.restore(v.b, '/files/passport.jpg', v.mePhoto, { author: 'user' }), NotFoundError);
  assert.equal(await v.ws.read(v.b, '/files/passport.jpg'), undefined);
  // From the user's own conversation, their own history restores as before.
  const first = (await v.ws.read(ME, '/files/passport.jpg'))?.entry.hash;
  await v.ws.write(ME, '/files/passport.jpg', utf8('passport, renewed'), { author: 'user', type: 'image/jpeg' });
  await v.ws.restore(ME, '/files/passport.jpg', /** @type {string} */ (first), { author: 'user' });
  assert.equal(await v.ws.readText(ME, '/files/passport.jpg'), 'photo of a passport');
});

test("the user's own photo a trip's conversation sent stays while /me/'s history or the trip names it (Step, 10)", async () => {
  const v = await twoTrips();
  await record(v.store, v.b, { type: 'msg.user', actor: 'user', data: { text: 'my passport', images: [{ hash: v.mePhoto, mediaType: 'image/jpeg' }] }, blobs: [{ hash: v.mePhoto, type: 'image/jpeg' }] });
  // Deleting the /me/ file keeps its history (spec §4.2), so its content stays named there.
  await v.ws.delete(ME, '/files/passport.jpg', { author: 'user' });
  assert.ok(await blobBytes(v.store, v.b, v.mePhoto), 'the trip still has the photo it sent');
  await removeTrip(v.store, v.b);
  assert.equal(await held(v.store, v.mePhoto), true, "/me/'s history still names it: only Erase everything removes that");
});

// Fix pass 3 (verification of 1655385).
const { shioriUndos } = await import('../../src/core/plan.js');
const sizeOf = (/** @type {any} */ store, /** @type {string} */ h) => store.tx(['blobs'], 'readonly', async (/** @type {any} */ t) => (await t.getBlob(h))?.size);
/** Notes each archive entry an import reads. @param {any} opened */
const spyReads = (opened) => {
  /** @type {string[]} */
  const read = [];
  const was = opened.zip.read.bind(opened.zip);
  opened.zip.read = async (/** @type {string} */ name) => { read.push(name); return was(name); };
  return read;
};

test('"Replace mine" from a forged file can\'t make an old version of the copy it replaces a current file without carrying it (verification, 1; V2)', async () => {
  const v = await twoTrips();
  await v.ws.write(v.a, '/files/temple.jpg', utf8('photo of a temple, edited'), { author: 'user', type: 'image/jpeg' });
  const tripId = /** @type {any} */ (await v.store.tx(['scopes'], 'readonly', (t) => t.getScope(v.a))).tripId;
  const size = /** @type {number} */ (await sizeOf(v.store, v.aPhoto));
  // Built from what a Share with History tells: the trip's id, and an older photo's hash and size, not its bytes.
  const file = await forged((m, entries) => {
    m.scopes[0].record.tripId = tripId;
    m.files = m.files.filter((/** @type {any} */ f) => f.path !== '/files/temple.jpg'); // the maker hasn't the photo itself
    entries.set(`${m.scopes[0].dir}/files/stolen.jpg`, new Uint8Array(size).fill(0x43));
    m.files.push({ name: `${m.scopes[0].dir}/files/stolen.jpg`, scope: m.scopes[0].record.id, path: '/files/stolen.jpg', hash: v.aPhoto, size, type: 'image/jpeg', author: 'user', created: 1, modified: 1 });
  });
  const opened = await peekArchive(file);
  await assert.rejects(importArchive(v.store, opened, { trips: { [opened.manifest.scopes[0].record.id]: 'replace' } }), (e) => e instanceof ArchiveError && /damaged/.test(e.message));
  assert.deepEqual((await listTrips(v.store)).active.map((t) => t.title).sort(), ['Big Sur', 'Kyoto']);
});

test('replacing "me" from a forged file can\'t bring a deleted /me/ file back without carrying it (verification, 1)', async () => {
  const v = await twoTrips();
  await v.ws.delete(ME, '/files/passport.jpg', { author: 'user' }); // its history still names it
  const size = /** @type {number} */ (await sizeOf(v.store, v.mePhoto));
  const x = await twoTrips();
  const { blob } = await exportArchive(x.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const entries = await readZip(new Uint8Array(await blob.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(entries.get(MANIFEST_NAME)));
  const f = manifest.files.find((/** @type {any} */ y) => y.scope === 'me' && y.path === '/files/passport.jpg');
  entries.set(f.name, new Uint8Array(size).fill(0x45)); // other bytes under the deleted file's hash and size
  f.hash = v.mePhoto;
  f.size = size;
  for (const e of manifest.extras) e.hash = await sha256Hex(/** @type {Uint8Array} */ (entries.get(e.name)));
  const z = new ZipWriter();
  for (const [name, bytes] of entries) await z.add(name, name === MANIFEST_NAME ? utf8(JSON.stringify(manifest)) : bytes);
  const opened = await peekArchive(new Uint8Array(await z.finish().arrayBuffer()));
  const skip = Object.fromEntries(manifest.scopes.filter((/** @type {any} */ s) => s.record.kind === 'trip').map((/** @type {any} */ s) => [s.record.id, 'skip']));
  await assert.rejects(importArchive(v.store, opened, { me: 'replace', trips: skip }), (e) => e instanceof ArchiveError && /damaged/.test(e.message));
  assert.equal(await v.ws.read(ME, '/files/passport.jpg'), undefined);
});

test('"Replace mine" with a copy changed while it imports: what the copy no longer vouches for is refused, not taken unread (verification, 5)', async () => {
  const v = await twoTrips();
  const { blob } = await exportArchive(v.store, { kind: 'trip', scopes: [v.a], include: PRESETS.backup, app: '0.1.0' });
  const opened = await peekArchive(new Uint8Array(await blob.arrayBuffer()));
  const read = spyReads(opened);
  let done = false;
  /** @type {any} the store, with Kyoto removed just before the import's last step */
  const racing = {
    close: () => v.store.close(),
    tx(/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) {
      if (done || mode !== 'readwrite' || !stores.includes('secrets')) return v.store.tx(stores, mode, fn);
      done = true;
      // The photo is deleted from the copy meanwhile: still stored, still in its history, no longer its current file.
      return v.ws.delete(v.a, '/files/temple.jpg', { author: 'user' }).then(() => v.store.tx(stores, mode, fn));
    },
  };
  await assert.rejects(importArchive(racing, opened, { trips: { [opened.manifest.scopes[0].record.id]: 'replace' } }), (e) => e instanceof ArchiveError && /changed on this device while it was importing/.test(e.message));
  assert.ok(!read.some((n) => n.endsWith('/files/temple.jpg')), 'it was vouched for when the import began');
  assert.deepEqual((await listTrips(v.store)).active.map((t) => t.title).sort(), ['Big Sur', 'Kyoto']);
});

for (const kind of ['string', 'ArrayBuffer']) {
  test(`content a plugin gives as ${kind} is kept as its bytes: no empty record under its hash, and a Backup restores (verification, 2; V10, V10b)`, async () => {
    const v = await twoTrips();
    const real = 'the real ticket';
    const bytes = kind === 'string' ? real : utf8(real).buffer.slice(0);
    const e = await record(v.store, v.b, { type: 'x', actor: 'plugin:p', data: {}, blobs: [{ bytes: /** @type {any} */ (bytes), type: 'application/pdf' }] });
    const rec = /** @type {any} */ (await v.store.tx(['blobs'], 'readonly', (t) => t.getBlob(e.refs[0])));
    assert.deepEqual([rec.size, new TextDecoder().decode(rec.data)], [15, real]);
    await v.ws.write(v.a, '/files/ticket.pdf', utf8(real), { author: 'user', type: 'application/pdf' });
    assert.equal(await v.ws.readText(v.a, '/files/ticket.pdf'), real);
    const { blob } = await exportArchive(v.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
    const d = await freshDevice();
    await importArchive(d.store, await peekArchive(new Uint8Array(await blob.arrayBuffer())), { me: 'replace' });
  });
}

test('content given as anything but bytes is refused in plain words (verification, 2; V10)', async () => {
  const v = await twoTrips();
  await assert.rejects(record(v.store, v.b, { type: 'x', actor: 'plugin:p', data: {}, blobs: [{ bytes: /** @type {any} */ ([1, 2, 3]), type: 'application/pdf' }] }), /isn't bytes/);
});

test('a stored record with no bytes (left by an older annai) is written again by the next write of those bytes, and a Backup leaves it out (verification, 2)', async () => {
  const v = await twoTrips();
  const real = utf8('the real ticket');
  const H = await sha256Hex(real);
  for (const size of [undefined, real.byteLength]) {
    await v.store.tx(['blobs', 'events'], 'readwrite', async (t) => {
      await t.putBlob(/** @type {any} */ ({ hash: H, type: 'application/pdf', size, data: undefined }));
      await t.appendEvent(v.b, { ts: 1, type: 'x', actor: 'plugin:p', data: {}, refs: [H] });
    });
    const { manifest } = await exportArchive(v.store, { kind: 'trip', scopes: [v.b], include: PRESETS.backup, app: '0.1.0' });
    assert.ok(!manifest.blobs.some((b) => b.hash === H), 'a record without its bytes travels in no Backup');
    await v.ws.write(v.a, `/files/ticket-${size}.pdf`, real, { author: 'user', type: 'application/pdf' });
    assert.equal(await v.ws.readText(v.a, `/files/ticket-${size}.pdf`), 'the real ticket');
  }
});

test("Undo isn't offered for a plan item whose version from before Shiori an import left out: it isn't one she added (verification, 3; V5b)", async () => {
  const x = await twoTrips();
  const first = (await x.ws.write(x.a, '/plan/dinner.json', JSON.stringify({ title: 'Dinner' }), { author: 'user' })).hash;
  await x.ws.write(x.a, '/plan/dinner.json', JSON.stringify({ title: 'Dinner at 8' }), { author: 'shiori' });
  const file = await rewriteArchive(await exportArchive(x.store, { kind: 'trip', scopes: [x.a], include: PRESETS.backup, app: '0.1.0' }), (m) => {
    m.blobs = m.blobs.filter((/** @type {any} */ b) => b.hash !== first); // its maker no longer had the user's version
  });
  const d = await freshDevice();
  const [t] = (await importArchive(d.store, await peekArchive(file))).trips;
  assert.equal((await shioriUndos(d.ws, t, [{ path: '/plan/dinner.json', author: 'shiori' }])).get('/plan/dinner.json'), undefined);
  // Without an import, her first write of a new item is still undone by removing it.
  await d.ws.write(t, '/plan/lunch.json', JSON.stringify({ title: 'Lunch' }), { author: 'shiori' });
  assert.deepEqual((await shioriUndos(d.ws, t, [{ path: '/plan/lunch.json', author: 'shiori' }])).get('/plan/lunch.json'), { remove: true });
});

test('a Backup with Photos unticked carries no photo in its history either (verification, 6; V9)', async () => {
  const v = await twoTrips();
  await v.ws.write(v.a, '/files/temple.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { author: 'user', type: 'image/jpeg' });
  await v.ws.write(v.a, '/notes/n.md', 'first', { author: 'user' });
  await v.ws.write(v.a, '/notes/n.md', 'second', { author: 'user' });
  const { manifest } = await exportArchive(v.store, { kind: 'trip', scopes: [v.a], include: { history: true, memory: true, photos: false }, app: '0.1.0' });
  const types = manifest.blobs.map((b) => b.type);
  assert.ok(!types.some((t) => t.startsWith('image/')), types.join());
  assert.ok(manifest.blobs.some((b) => b.hash === v.aPhoto) === false);
  assert.ok(manifest.blobs.length >= 1, 'older versions of other files still go');
});

test("the import's Trace line counts what it left out as content, not versions (verification, 7)", () => {
  assert.equal(traceSummary({ type: 'import', data: { kind: 'trip', app: '0.1.0', uncarried: 2 } }), "from a trip's file, annai 0.1.0 · 2 pieces of content it didn't hold left out");
  assert.equal(traceSummary({ type: 'import', data: { kind: 'everything', app: '0.1.0', uncarried: 1 } }), "from a backup, annai 0.1.0 · 1 piece of content it didn't hold left out");
});

/** An exported archive, its manifest changed by edit(). @param {{ blob: Blob }} exported @param {(m: any) => void} edit */
async function rewriteArchive({ blob }, edit) {
  const entries = await readZip(new Uint8Array(await blob.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(entries.get(MANIFEST_NAME)));
  edit(manifest);
  const z = new ZipWriter();
  for (const [name, bytes] of entries) await z.add(name, name === MANIFEST_NAME ? utf8(JSON.stringify(manifest)) : bytes);
  return new Uint8Array(await z.finish().arrayBuffer());
}

test("an imported file's size is its content's, never what the manifest says, whether its entry is read or not (Haiku's note)", async () => {
  const v = await twoTrips();
  const exported = await exportArchive(v.store, { kind: 'trip', scopes: [v.a], include: PRESETS.backup, app: '0.1.0' });
  const real = /** @type {number} */ (await sizeOf(v.store, v.aPhoto));
  const lying = await rewriteArchive(exported, (m) => {
    m.files.find((/** @type {any} */ f) => f.path === '/files/temple.jpg').size = 1;
  });
  // Read (a device without it), and not read ("Replace mine" over the copy that has it).
  const d = await freshDevice();
  const [fresh] = (await importArchive(d.store, await peekArchive(lying))).trips;
  assert.equal(/** @type {any} */ (await d.ws.read(fresh, '/files/temple.jpg')).entry.size, real);
  const opened = await peekArchive(lying);
  const [replaced] = (await importArchive(v.store, opened, { trips: { [opened.manifest.scopes[0].record.id]: 'replace' } })).trips;
  assert.equal(/** @type {any} */ (await v.ws.read(replaced, '/files/temple.jpg')).entry.size, real);
});
