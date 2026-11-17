import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bringIn } from '../../src/ui/bring-in.js';
import { addFiles } from '../../src/ui/add-files.js';
import { addLeft } from '../../src/ui/screens/import.js';
import { ensureBaseScopes, createTrip, kindOf } from '../../src/core/scopes.js';
import { Chats } from '../../src/core/chats.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace, StorageFullError } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';

const ICS = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:dinner@example.com', 'SUMMARY:Thanksgiving dinner', 'DTSTART;TZID=America/New_York:20261126T170000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:museum', 'SUMMARY:Museum day', 'DTSTART;VALUE=DATE:20261127', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

/** A shared file, as annai's inbox gives it (import.js, inboxFiles). @param {string} name @param {string} type @param {string} body */
const shared = (name, type, body) => ({ key: /** @type {any} */ (`/inbox/${name}`), file: new File([body], name, { type }) });

/**
 * A phone of annai's in memory, as the share screen's add sees it: a dated trip, a model set (so Shiori is woken), the wakes, annai's
 * share inbox (the Cache API, which Node hasn't), and a write of /files/ that fails, as storage full, the first `fails` times.
 * @param {{ fail?: string, fails?: number }} [o] fail: the path whose write fails
 */
async function phone(o = {}) {
  const store = createMemoryStore();
  const real = new Workspace(store, { schemaFor: makeSchemaFor({ list: (/** @type {string} */ k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(real);
  const trip = await createTrip(real, { title: 'Thanksgiving', start: '2026-11-25', end: '2026-11-29', timezones: ['America/New_York'] });
  let left = o.fails ?? 1;
  /** @type {string[]} */ const writes = [];
  const ws = Object.create(real);
  ws.write = (/** @type {string} */ scope, /** @type {string} */ path, /** @type {any} */ c, /** @type {any} */ opts) => {
    if (path === o.fail && left > 0) {
      left--;
      return Promise.reject(new StorageFullError());
    }
    writes.push(`${scope}:${path}`);
    return real.write(scope, path, c, opts);
  };
  /** @type {any[]} */ const wakes = [];
  /** @type {Set<(e: any) => void>} */ const listeners = new Set();
  const agent = { wake: async (/** @type {any} */ w) => { wakes.push(w); }, on: (/** @type {string} */ _k, /** @type {(e: any) => void} */ fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const ctx = { ws, store, agent, llm: { config: async () => ({ roles: { main: { models: ['m'] } } }) } };
  /** @type {Map<string, true>} */ const inbox = new Map();
  /** @type {any} */ (globalThis).caches = { open: async () => ({ delete: async (/** @type {string} */ k) => inbox.delete(k) }) };
  const files = (/** @type {string} */ scope) => real.list(scope, '/files/').then((l) => l.map((/** @type {any} */ f) => f.path));
  return { ctx, real, trip, writes, wakes, inbox, files };
}

test('bringIn: a file that can\'t be kept stops the rest; the calendar kept before it is read, and Shiori is told of what was kept', async () => {
  const { ctx, trip, wakes, files } = await phone({ fail: '/files/one.pdf' });
  const got = await bringIn(ctx, trip, [shared('thanksgiving.ics', 'text/calendar', ICS).file, shared('one.pdf', 'application/pdf', '%PDF one').file, shared('two.pdf', 'application/pdf', '%PDF two').file]);
  assert.ok(got.failed instanceof StorageFullError);
  assert.deepEqual(got.paths, ['/files/thanksgiving.ics']);
  assert.equal(got.planned.length, 2);
  assert.deepEqual(await files(trip), ['/files/thanksgiving.ics']);
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0].files, ['/files/thanksgiving.ics']);
  assert.match(wakes[0].text, /annai made 2 plan items from the calendar/);
});

test('addFiles: one that can\'t be kept comes back as failed, with nothing kept after it', async () => {
  const { ctx, trip } = await phone({ fail: '/files/one.pdf' });
  const got = await addFiles(ctx, trip, [shared('one.pdf', 'application/pdf', '%PDF one').file, shared('two.pdf', 'application/pdf', '%PDF two').file]);
  assert.deepEqual(got.paths, []);
  assert.ok(got.failed instanceof StorageFullError);
});

/** The share of the tests, in annai's inbox: a calendar, then two files. @param {Map<string, true>} inbox */
function share(inbox) {
  const items = [shared('thanksgiving.ics', 'text/calendar', ICS), shared('one.pdf', 'application/pdf', '%PDF one'), shared('two.pdf', 'application/pdf', '%PDF two')];
  for (const i of items) inbox.set(i.key, true);
  return items;
}

test('the share screen\'s add again, after one that stopped partway, adds only the rest: one copy of each, the plan written once, each file told once', async () => {
  const { ctx, trip, writes, wakes, inbox, files } = await phone({ fail: '/files/one.pdf' });
  const items = share(inbox);
  const first = await addLeft(ctx, trip, items);
  assert.ok(first.failed instanceof StorageFullError);
  assert.deepEqual(first.kept.map((i) => i.file.name), ['thanksgiving.ics']);
  // What is left, on the screen and in annai's inbox (what the failure card, Back to the share and a reload read).
  assert.deepEqual(items.map((i) => i.file.name), ['one.pdf', 'two.pdf']);
  assert.deepEqual([...inbox.keys()], ['/inbox/one.pdf', '/inbox/two.pdf']);
  const again = await addLeft(ctx, trip, items);
  assert.equal(again.failed, undefined);
  assert.deepEqual(items, []);
  assert.deepEqual([...inbox.keys()], []);
  assert.deepEqual(await files(trip), ['/files/one.pdf', '/files/thanksgiving.ics', '/files/two.pdf']);
  const plan = writes.filter((w) => w.includes(':/plan/'));
  assert.equal(plan.length, 2);
  assert.equal(new Set(plan).size, 2, 'each plan item written once');
  assert.deepEqual(wakes.map((w) => w.files), [['/files/thanksgiving.ics'], ['/files/one.pdf', '/files/two.pdf']]);
});

test('"New conversation" again, after one that stopped partway: the rest goes to the next conversation, and nothing is in both', async () => {
  const { ctx, real, wakes, inbox, files } = await phone({ fail: '/files/one.pdf' });
  const chats = new Chats({ ws: real, agent: /** @type {any} */ (ctx.agent), tz: () => 'America/New_York' });
  await chats.start();
  const items = share(inbox);
  const first = await chats.whenReady();
  assert.ok((await addLeft(ctx, first, items)).failed);
  await chats.idle(); // the kept file spent the draft, which is named after it, and the next is made
  const next = await chats.whenReady();
  assert.notEqual(next, first);
  assert.equal((await addLeft(ctx, next, items)).failed, undefined);
  assert.deepEqual(await files(first), ['/files/thanksgiving.ics']);
  assert.deepEqual(await files(next), ['/files/one.pdf', '/files/two.pdf']);
  assert.deepEqual(wakes.map((w) => [w.scope, w.files]), [[first, ['/files/thanksgiving.ics']], [next, ['/files/one.pdf', '/files/two.pdf']]]);
  assert.deepEqual([...inbox.keys()], []);
});

test('files dropped on annai (none in the inbox): the add again on their screen adds only the rest', async () => {
  const { ctx, trip, inbox, files } = await phone({ fail: '/files/one.pdf' });
  const items = share(inbox).map((i) => ({ ...i, key: null }));
  inbox.clear();
  assert.ok((await addLeft(ctx, trip, items)).failed);
  assert.deepEqual(items.map((i) => i.file.name), ['one.pdf', 'two.pdf']);
  await addLeft(ctx, trip, items);
  assert.deepEqual(await files(trip), ['/files/one.pdf', '/files/thanksgiving.ics', '/files/two.pdf']);
});
