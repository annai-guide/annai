import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { addFiles } from '../../src/ui/add-files.js';
import { outsideName } from '../../src/core/paths.js';
import { handOverText } from '../../src/core/handover.js';
import { newFilesText } from '../../src/core/imports.js';
import { escapeTags } from '../../src/core/agent/blocks.js';
import { wellFormed } from '../../src/core/web-search.js';
import { cell } from '../../src/core/tsv.js';

// A file's name as annai keeps it from outside (paths.js outsideName, spec §4.3): whole characters, none that keeps Shiori from reading
// it again by the path she is told. The names are made up.

/** A phone with a trip and Shiori's file tools, as the share screen, the type box and the camera button add to it. */
async function phone() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await host.addBuiltin(new URL('../../src/plugins/files/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Kyoto' });
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  /** Shiori's own tool call. @param {string} name @param {any} input @param {string} [half] */
  const run = (name, input, half) => tools[name].run(input, { scope: trip, trip, half, signal: new AbortController().signal, model: { input: ['text', 'image'] }, wake: 'w', author: 'shiori' });
  /** Files added, as addFiles keeps them. @param {(Blob & { name?: string })[]} files */
  const add = async (files) => {
    const got = await addFiles({ ws }, trip, files);
    assert.equal(got.failed, undefined);
    return got;
  };
  return { ws, trip, run, add };
}

/** A picked or shared file. @param {BlobPart} body @param {string} name @param {string} [type] */
const file = (body, name, type = '') => new File([body], name, { type });
/** A photo with no date taken, so it is named by the name it came with. */
const jpeg = async () => new Uint8Array(await readFile(new URL('../fixtures/photos/plain.jpg', import.meta.url)));
/** The smallest GIF: a 1×1 picture, as a camera button's picker may hand one over. */
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));

/** The paths a text names in quotes, as Shiori reads them (JSON strings). @param {string} text */
const quoted = (text) => [...text.matchAll(/"((?:[^"\\]|\\.)*)" \(/g)].map((m) => JSON.parse(`"${m[1]}"`));
/** Whether a text holds no half of a character. @param {string} s */
const whole = (s) => wellFormed(s) === s;

test('outsideName: the characters a path reads back without are each run one "-", cut by whole characters before the extension', () => {
  assert.equal(outsideName('Day 1\u2028"Kyoto" <plan>.txt', 'file'), 'Day 1-Kyoto- -plan-.txt');
  assert.equal(outsideName('a/b\\c\u0000d\u2029e.pdf', 'file'), 'a-b-c-d-e.pdf');
  assert.equal(outsideName('Cafe\u0301 menu.pdf', 'file'), 'Caf\u00e9 menu.pdf'); // NFC, as normPath keeps paths
  // 80 before the extension: an emoji across the 80th is left out whole, one inside it kept whole.
  assert.equal(outsideName(`${'a'.repeat(79)}🗻 view.pdf`, 'file'), `${'a'.repeat(79)}.pdf`);
  assert.equal(outsideName(`${'a'.repeat(78)}🗻 view.pdf`, 'file'), `${'a'.repeat(78)}🗻.pdf`);
  assert.equal(outsideName(`${'e'.repeat(120)}.pkpass`, 'file'), `${'e'.repeat(80)}.pkpass`);
  // A joined emoji may lose its later parts: each part is a character of its own, so the name is still whole text.
  const family = outsideName(`${'f'.repeat(77)}👨\u200d👩\u200d👧.pdf`, 'file');
  assert.equal(family, `${'f'.repeat(77)}👨\u200d.pdf`);
  assert.ok(whole(family));
  // Not an extension: words after a dot, or a run past 10 letters, are cut with the rest.
  assert.equal(outsideName(`Mr. ${'g'.repeat(90)}`, 'file'), `Mr. ${'g'.repeat(76)}`);
  assert.equal(outsideName(`x.${'h'.repeat(90)}`, 'file').length, 80);
  for (const empty of ['', '  ', '.', '..', '\u2028']) assert.equal(outsideName(empty, 'file'), empty === '\u2028' ? '-' : 'file');
});

test('a shared photo whose name has an emoji across the 80th character keeps whole characters, and reads back by the path Shiori is told', async () => {
  const { run, add } = await phone();
  const bytes = await jpeg();
  const { paths, types } = await add([file(bytes, `${'a'.repeat(79)}🗻 Fuji.jpg`, 'image/jpeg'), file(bytes, `${'b'.repeat(78)}🗻 Fuji.jpg`, 'image/jpeg')]);
  assert.match(paths[0], new RegExp(`^/files/a{79}\\.(jpg|webp)$`));
  assert.match(paths[1], new RegExp(`^/files/b{78}🗻\\.(jpg|webp)$`));
  const told = newFilesText(paths.map((p) => ({ path: p, type: types[p] })), []);
  const read = await Promise.all(quoted(told).map((p) => run('read', { path: p })));
  assert.deepEqual(read.map((r) => r.images[0].path), paths.map((p) => `/trip${p}`));
});

test('a shared file whose name has an emoji across the 100th character is kept whole and shorter, so the hand-over names it uncut and it reads back', async () => {
  const { run, add } = await phone();
  const { paths } = await add([file('Seat 12A', `${'c'.repeat(99)}🗻 seat.txt`, 'text/plain')]);
  assert.deepEqual(paths, [`/files/${'c'.repeat(80)}.txt`]);
  const [path] = quoted(handOverText([{ path: `/trip${paths[0]}`, type: 'text/plain', name: 'x', new: true }]));
  assert.equal(path, `/trip${paths[0]}`);
  assert.equal(await run('read', { path }), 'Seat 12A');
});

test('a name with a line separator, ", < and > is kept with each replaced, and reads back by the path told to Kokoro and to Koe', async () => {
  const { run, add } = await phone();
  const { paths, types } = await add([file('Temples at 9', 'Day 1\u2028"Kyoto" <plan>.txt', 'text/plain'), file(await jpeg(), 'Gion "night" <2>\u2029.jpg', 'image/jpeg')]);
  assert.equal(paths[0], '/files/Day 1-Kyoto- -plan-.txt');
  assert.match(paths[1], /^\/files\/Gion -night- -2-\.(jpg|webp)$/);
  const handed = paths.map((p) => ({ path: `/trip${p}`, type: types[p], name: 'x', new: true }));
  const kokoro = quoted(handOverText(handed));
  const koe = quoted(escapeTags(handOverText(handed, { koe: true }))); // Koe reads other brackets in place of < and >
  assert.deepEqual(kokoro, handed.map((h) => h.path));
  assert.deepEqual(koe, kokoro);
  assert.equal(await run('read', { path: kokoro[0] }), 'Temples at 9');
  assert.equal((await run('read', { path: kokoro[1] }, 'koe')).images[0].path, kokoro[1]);
});

test("the camera button's picture that isn't a photo type (a GIF) is named by the same rule, and reads back", async () => {
  const { ws, trip, run, add } = await phone();
  const { paths } = await add([file(GIF, `${'d'.repeat(79)}🗻 "fun" <3>.gif`)]);
  assert.deepEqual(paths, [`/files/${'d'.repeat(79)}.gif`]);
  assert.equal((await ws.read(trip, paths[0])).entry.type, 'image/gif');
  const [path] = quoted(newFilesText([{ path: paths[0], type: 'image/gif' }], []));
  assert.equal((await run('read', { path })).images[0].path, path);
  // Another of the same name is a name of its own, still uncut where Shiori is told it.
  const again = await add([file(GIF, `${'d'.repeat(79)}🗻 "fun" <3>.gif`)]);
  assert.deepEqual(again.paths, [`/files/${'d'.repeat(79)} (2).gif`]);
});

test('an older file keeps its name: one with such characters still lists and reads as before', async () => {
  const { ws, trip, run } = await phone();
  const old = '/files/Old "plan" <v2>\u2028b.txt';
  await ws.write(trip, old, 'kept', { author: 'user', type: 'text/plain' });
  await ws.write(trip, '/files/Tea "menu" <v1>.txt', 'matcha', { author: 'user', type: 'text/plain' });
  const listed = await run('list', { path: '/trip/files/' });
  assert.ok(listed.includes(cell('/trip/files/Tea "menu" <v1>.txt'))); // the list's TSV writes < as <lt>, as before
  assert.ok(listed.includes(cell(`/trip${old}`)));
  assert.equal(await run('read', { path: '/trip/files/Tea "menu" <v1>.txt' }), 'matcha');
  // Its line separator kept it from a read by its path before, and still does: listed, it is read from the list's folder by hand.
  await assert.rejects(run('read', { path: `/trip${old}` }), /Paths start with \/trip\/ or \/me\//);
  assert.equal(await ws.readText(trip, old), 'kept');
});

test("an older file's name over 100 characters is cut where Shiori is told it between whole characters", () => {
  const name = `${'e'.repeat(99)}🗻 boarding pass.pdf`;
  // JSON writes half a character as an escape (\ud83d), which a model can't read as part of the name; the cut leaves none.
  for (const text of [handOverText([{ path: `/trip/files/${name}`, type: 'application/pdf', name, new: false }]), newFilesText([{ path: `/files/${name}`, type: 'application/pdf' }], [])]) {
    assert.ok(text.includes(`${'e'.repeat(99)}…"`), text);
  }
});
