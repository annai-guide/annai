import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { addFiles } from '../../src/ui/add-files.js';
import { outsideName } from '../../src/core/paths.js';
import { handOverText, quotedPath } from '../../src/core/handover.js';
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
  assert.equal(outsideName('a\u0085b\u009fc\u007fd.pdf', 'file'), 'a-b-c-d.pdf'); // C1 controls too: NEL (U+0085) is a line break to some readers
  assert.equal(outsideName('Document\u202efdp.exe', 'file'), 'Document-fdp.exe'); // an override would show it as "Documentexe.pdf"
  assert.equal(outsideName('a\u2066b\u2069c\u202ad.pdf', 'file'), 'a-b-c-d.pdf');
  assert.equal(outsideName('Cafe\u0301 menu.pdf', 'file'), 'Caf\u00e9 menu.pdf'); // NFC, as normPath keeps paths
  // 80 before the extension: an emoji across the 80th is left out whole, one inside it kept whole.
  assert.equal(outsideName(`${'a'.repeat(79)}🗻 view.pdf`, 'file'), `${'a'.repeat(79)}.pdf`);
  assert.equal(outsideName(`${'a'.repeat(78)}🗻 view.pdf`, 'file'), `${'a'.repeat(78)}🗻.pdf`);
  assert.equal(outsideName(`${'e'.repeat(120)}.pkpass`, 'file'), `${'e'.repeat(80)}.pkpass`);
  // A character as a person sees it is kept or left out whole: a joined emoji never leaves a lone joiner (U+200D) before the extension.
  const family = '👨\u200d👩\u200d👧';
  assert.equal(outsideName(`${'f'.repeat(72)}${family}.pdf`, 'file'), `${'f'.repeat(72)}${family}.pdf`);
  for (const at of [73, 75, 77, 79]) assert.equal(outsideName(`${'f'.repeat(at)}${family}.pdf`, 'file'), `${'f'.repeat(at)}.pdf`);
  assert.equal(outsideName(`${'g'.repeat(78)}🇯🇵.pdf`, 'file'), `${'g'.repeat(78)}.pdf`); // a flag is two letters of one character
  assert.equal(outsideName(`${'h'.repeat(79)}q\u0301.pdf`, 'file'), `${'h'.repeat(79)}.pdf`); // a letter with an accent that has no single character
  // A character longer than the 80 itself is cut between code points, so the name is never empty; one after others is left out whole.
  const long = `e${'\u0301'.repeat(100)}`;
  assert.equal(outsideName(`${long}.pdf`, 'file'), `\u00e9${'\u0301'.repeat(79)}.pdf`);
  assert.equal(outsideName(`ab${long}.pdf`, 'file'), 'ab.pdf');
  // The stem is trimmed after the cut: no "… to .pdf".
  assert.equal(outsideName(`${'a'.repeat(79)} ${'b'.repeat(10)}.pdf`, 'file'), `${'a'.repeat(79)}.pdf`);
  // Not an extension: words after a dot, or a run past 10 letters, are cut with the rest.
  assert.equal(outsideName(`Mr. ${'g'.repeat(90)}`, 'file'), `Mr. ${'g'.repeat(76)}`);
  assert.equal(outsideName(`x.${'h'.repeat(90)}`, 'file').length, 80);
  for (const empty of ['', '  ', '.', '..', `.${' '.repeat(90)}x`]) assert.equal(outsideName(empty, 'file'), 'file');
  assert.equal(outsideName('\u2028', 'file'), '-');
});

test('outsideName where the browser has no grapheme segmenter: cut between code points, never half of one', () => {
  const url = new URL('../../src/core/paths.js', import.meta.url).href;
  const code = `delete Intl.Segmenter; const { outsideName } = await import(${JSON.stringify(url)}); console.log(JSON.stringify([outsideName('${'a'.repeat(79)}🗻 view.pdf', 'file'), outsideName('${'f'.repeat(77)}👨\u200d👩.pdf', 'file')]))`;
  const got = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
  assert.deepEqual(got, [`${'a'.repeat(79)}.pdf`, `${'f'.repeat(77)}👨\u200d.pdf`]);
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

test('a shared file whose name is over 80 characters (an emoji past the 80th) is stored cut at 80, so the hand-over names it whole and it reads back', async () => {
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

test('a shared name with a "\\", a "/", only spaces or over 505 characters is kept as one plain name, and reads back by its path', async () => {
  const { run, add } = await phone();
  // On main a "\" or a name over about 505 characters stopped the add (a PathError), and a "/" made a folder the Files list doesn't show.
  const names = ['tickets\\kyoto.txt', 'a/b/c.txt', '   ', `${'x'.repeat(600)}.txt`];
  const { paths, types } = await add(names.map((n, i) => file(`body ${i}`, n, 'text/plain')));
  assert.deepEqual(paths, ['/files/tickets-kyoto.txt', '/files/a-b-c.txt', '/files/file', `/files/${'x'.repeat(80)}.txt`]);
  const told = quoted(newFilesText(paths.map((p) => ({ path: p, type: types[p] })), []));
  assert.deepEqual(told, paths.map((p) => `/trip${p}`));
  assert.deepEqual(await Promise.all(told.map((p) => run('read', { path: p }))), names.map((_, i) => `body ${i}`));
});

test('a photo whose name is nothing but its ending is kept as photo.<ending>, and reads back', async () => {
  const { run, add } = await phone();
  const { paths, types } = await add([file(await jpeg(), '.jpg', 'image/jpeg')]);
  assert.match(paths[0], /^\/files\/photo\.(jpg|webp)$/);
  const [path] = quoted(newFilesText([{ path: paths[0], type: types[paths[0]] }], []));
  assert.equal((await run('read', { path })).images[0].path, `/trip${paths[0]}`);
});

test("an older file's name with a line separator is quoted with it escaped, in both texts that name a path", () => {
  const name = 'Old\u2028plan\u2029b.txt';
  const texts = [
    handOverText([{ path: `/trip/files/${name}`, type: 'text/plain', name, new: true }]),
    handOverText([{ path: `/trip/files/${name}`, type: 'text/plain', name, new: false }]),
    newFilesText([{ path: `/files/${name}`, type: 'text/plain' }], []),
  ];
  for (const text of texts) {
    assert.ok(!/[\u2028\u2029]/.test(text), text); // a raw one reads as a line break, where a line "[annai] …" could start
    assert.ok(text.includes('"/trip/files/Old\\u2028plan\\u2029b.txt"'), text);
  }
  assert.equal(quotedPath('/trip/files/a\u2028b.txt'), '"/trip/files/a\\u2028b.txt"'); // the moved-file words use it too
});
