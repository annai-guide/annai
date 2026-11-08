import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, listTrips, syncTripTitles, scopeTitle, ME } from '../../src/core/scopes.js';
import { ensureDraft, chatName, Chats, DRAFT_TITLE } from '../../src/core/chats.js';
import { record, INLINE_MAX } from '../../src/core/agent/log.js';
import { NOT_TRANSCRIBED } from '../../src/core/voice/resolve.js';
import { PHOTO_ONLY } from '../../src/core/agent/loop.js';
import { changedSince } from '../../src/core/backup-auto.js';
import { exportArchive, peekArchive, importArchive, PRESETS } from '../../src/core/archive.js';
import { updateAppSettings, readAppSettings } from '../../src/core/settings.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';

const LA = 'America/Los_Angeles';
const tz = LA;
const at = Date.parse('2026-11-27T09:30:00-08:00');
const noon = Date.parse('2026-11-27T12:00:00-08:00');

async function kit() {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (/** @type {string} */ k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  syncTripTitles(ws);
  /** @type {Set<(e: any) => void>} */
  const listeners = new Set();
  const agent = {
    /** @param {'event'} _k @param {(e: any) => void} fn */
    on: (_k, fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    /** As the loop logs and tells: the stored entry, with its scope. @param {string} scope @param {any} ev */
    async log(scope, ev) {
      const e = await record(store, scope, { now: noon, ...ev });
      for (const fn of listeners) fn(e);
      return e;
    },
  };
  const chats = new Chats({ ws, agent, tz: () => LA });
  const scope = (/** @type {string} */ id) => store.tx(['scopes'], 'readonly', (t) => t.getScope(id));
  /** Until the next draft is ready: spending is over. */
  const spent = async (/** @type {string} */ was) => { for (let i = 0; i < 200 && (chats.ready === was || !chats.ready); i++) await new Promise((r) => setTimeout(r, 2)); };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { store, ws, agent, chats, scope, spent, settle };
}

test('one draft, made once and hidden', async () => {
  const { store, ws } = await kit();
  const id = await ensureDraft(ws);
  assert.equal(await ensureDraft(ws), id);
  const [a, b] = await Promise.all([ensureDraft(ws), ensureDraft(ws)]);
  assert.equal(a, id);
  assert.equal(b, id);
  const l = await listTrips(store);
  assert.equal(l.draft, id);
  assert.ok(!l.active.some((s) => s.id === id));
  assert.ok(!l.archived.some((s) => s.id === id));
  assert.equal((await ws.readJSON(id, '/trip.json')).title, DRAFT_TITLE);
  assert.equal(scopeTitle({ id, title: DRAFT_TITLE }), 'New conversation');
});

test('names', () => {
  assert.equal(chatName({ text: 'Where should we eat? I am hungry.', at, tz }), 'Where should we eat?');
  assert.equal([...chatName({ text: 'a'.repeat(100), at, tz })].length, 40);
  assert.equal(chatName({ text: '今日はどこに行こうか。雨だね', at, tz }), '今日はどこに行こうか。');
  assert.ok([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(chatName({ text: '👨‍👩‍👧'.repeat(30), at, tz }))].length <= 40);
  assert.ok(chatName({ text: '👨‍👩‍👧'.repeat(30), at, tz }).length > 0);
  assert.equal(chatName({ text: '   ', file: 'menu.pdf', at, tz }), 'menu.pdf');
  assert.equal(chatName({ text: '', file: '/files/menu.pdf', at, tz }), 'menu.pdf');
  assert.equal(chatName({ text: '...', photo: true, at: noon, tz }), 'Photo · 12:00');
  assert.equal(chatName({ voice: true, at: noon, tz }), 'Voice · 12:00');
  assert.equal(chatName({ text: 'first line\nsecond', at, tz }), 'first line');
  assert.equal(chatName({ text: '...so, where now', at, tz }), '...so, where now');
  assert.equal(chatName({ text: '?!', at, tz }), '?!', 'punctuation alone and nothing else: kept, never blank');
  assert.ok(chatName({ text: '', at, tz }).length > 0);
  // A surrogate pair is never split: 40 code points of emoji with no joiners.
  const name = chatName({ text: '🍜'.repeat(50), at, tz });
  assert.equal(name, '🍜'.repeat(40));
});

test('the first typed line clears the flag, names it as system, and a new draft is ready', async () => {
  const { ws, agent, chats, scope, spent } = await kit();
  await chats.start();
  const draft = /** @type {string} */ (chats.ready);
  assert.ok((await scope(draft))?.draft);
  await agent.log(draft, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Where should we eat? I am hungry.']] });
  await spent(draft);
  assert.ok(!('draft' in /** @type {any} */ (await scope(draft))));
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, 'Where should we eat?');
  const [last] = (await ws.history(draft, '/trip.json')).slice(-1);
  assert.equal(last.actor, 'system');
  assert.equal((await scope(draft))?.title, 'Where should we eat?');
  assert.ok(chats.ready && chats.ready !== draft);
  assert.ok((await scope(chats.ready))?.draft);
  assert.equal(await chats.whenReady(), chats.ready);
});

test('a second copy of the first line (the other half joining it) spends nothing more', async () => {
  const { store, agent, chats, spent, settle } = await kit();
  await chats.start();
  const draft = /** @type {string} */ (chats.ready);
  const e = await agent.log(draft, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Hello there']] });
  await spent(draft);
  const next = chats.ready;
  agent.log(draft, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'and again']] });
  void e;
  await settle();
  assert.equal(chats.ready, next);
  assert.equal((await listTrips(store)).active.length, 1);
});

test('heard: a dismissed line does nothing; one with no text names it when heard.text comes; one never transcribed is Voice · hh:mm', async () => {
  const { ws, agent, chats, scope, spent, settle } = await kit();
  await chats.start();
  const draft = /** @type {string} */ (chats.ready);
  await agent.log(draft, { type: 'heard', actor: 'user', data: { id: 'h1', text: 'just us talking', dismissed: true } });
  await settle();
  assert.equal(chats.ready, draft);
  assert.ok((await scope(draft))?.draft);
  await agent.log(draft, { type: 'heard', actor: 'user', data: { id: 'h2' } });
  await spent(draft);
  assert.ok(!(await scope(draft))?.draft, 'used at once');
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, DRAFT_TITLE, 'its words are still to come');
  await agent.log(draft, { type: 'heard.text', actor: 'system', data: { of: 'h2', text: 'Is the museum open today? Lets see' } });
  await settle();
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, 'Is the museum open today?');

  const second = /** @type {string} */ (chats.ready);
  await agent.log(second, { type: 'heard', actor: 'user', data: { id: 'h3' } });
  await spent(second);
  await agent.log(second, { type: 'heard.text', actor: 'system', data: { of: 'h3', text: NOT_TRANSCRIBED } });
  await settle();
  assert.equal((await ws.readJSON(second, '/trip.json')).title, 'Voice · 12:00');

  const third = /** @type {string} */ (chats.ready);
  await agent.log(third, { type: 'heard', actor: 'user', data: { id: 'h4', text: 'Dictated words' } });
  await spent(third);
  assert.equal((await ws.readJSON(third, '/trip.json')).title, 'Dictated words');
});

test('a file wake is first use, named from the file', async () => {
  const { ws, agent, chats, scope, spent } = await kit();
  await chats.start();
  const draft = /** @type {string} */ (chats.ready);
  await agent.log(draft, { type: 'wake', actor: 'system', data: { id: 'w1', reasons: [{ kind: 'file', text: 'New files', files: ['/files/tickets.pdf'] }] } });
  await spent(draft);
  assert.ok(!(await scope(draft))?.draft);
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, 'tickets.pdf');
});

test('a photo with no words is Photo · hh:mm', async () => {
  const { ws, agent, chats, spent } = await kit();
  await chats.start();
  const draft = /** @type {string} */ (chats.ready);
  await agent.log(draft, { type: 'msg.user', actor: 'user', data: { images: [{ hash: 'x', path: '/trip/photos/a.jpg' }] }, texts: [['text', PHOTO_ONLY]] });
  await spent(draft);
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, 'Photo · 12:00');
});

test("her own lines, a reminder and a state entry aren't first use", async () => {
  const { agent, chats, scope, settle } = await kit();
  await chats.start();
  const draft = /** @type {string} */ (chats.ready);
  await agent.log(draft, { type: 'out.speak', actor: 'shiori', data: { text: 'Hello!' } });
  await agent.log(draft, { type: 'reminder', actor: 'system', data: { text: 'Leave soon' } });
  await agent.log(draft, { type: 'state', actor: 'system', data: { live: true } });
  await agent.log(draft, { type: 'wake', actor: 'system', data: { id: 'w', reasons: [{ kind: 'reminder', text: 'x' }] } });
  await settle();
  assert.equal(chats.ready, draft);
  assert.ok((await scope(draft))?.draft);
});

test('a line in another conversation spends nothing', async () => {
  const { ws, agent, chats, settle } = await kit();
  await chats.start();
  const draft = chats.ready;
  const trip = await createTrip(ws, { title: 'Testville' });
  await agent.log(trip, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Hi']] });
  await agent.log(ME, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Hi']] });
  await settle();
  assert.equal(chats.ready, draft);
  assert.equal((await ws.readJSON(trip, '/trip.json')).title, 'Testville');
});

test('a name the user gave meanwhile stays', async () => {
  const { ws, agent, chats, spent, settle } = await kit();
  await chats.start();
  const draft = /** @type {string} */ (chats.ready);
  await agent.log(draft, { type: 'heard', actor: 'user', data: { id: 'h' } });
  await spent(draft);
  await ws.patch(draft, '/trip.json', { title: 'Lunch plans' }, { author: 'user' });
  await agent.log(draft, { type: 'heard.text', actor: 'system', data: { of: 'h', text: 'Something else entirely' } });
  await settle();
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, 'Lunch plans');
});

test('a long first line, kept as a blob, is read back for the name', async () => {
  const { ws, agent, chats, spent } = await kit();
  await chats.start();
  const draft = /** @type {string} */ (chats.ready);
  const long = `Plan the day. ${'x'.repeat(INLINE_MAX + 10)}`;
  const e = await agent.log(draft, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', long]] });
  assert.deepEqual(e.data.stored, ['text']);
  await spent(draft);
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, 'Plan the day.');
});

test('no draft ready yet: whenReady waits for one', async () => {
  const { chats } = await kit();
  const waited = chats.whenReady();
  chats.start();
  const id = await waited;
  assert.equal(id, chats.ready);
});

test('exports and changedSince leave a draft out; a backup restored with activeTrip on it opens nothing', async () => {
  const a = await kit();
  const trip = await createTrip(a.ws, { title: 'Testville', start: '2027-01-01' });
  const draft = await ensureDraft(a.ws);
  await a.ws.write(draft, '/files/note.md', 'kept', { author: 'user' });
  await updateAppSettings(a.ws, { activeTrip: draft });
  const { manifest, blob, seqs } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  assert.ok(!manifest.scopes.some((s) => s.record.id === draft));
  assert.ok(manifest.scopes.some((s) => s.record.id === trip));
  assert.ok(!seqs.has(draft));
  await assert.rejects(exportArchive(a.store, { kind: 'trip', scopes: [draft], include: PRESETS.backup, app: '0.1.0' }), /nothing to export/);
  // A change in the draft is no change a backup holds.
  const before = await changedSince(a.store, Object.fromEntries(seqs));
  assert.equal(before.changed, false);
  await a.ws.write(draft, '/files/more.md', 'more', { author: 'user' });
  assert.equal((await changedSince(a.store, Object.fromEntries(seqs))).changed, false);

  const b = await kit();
  await importArchive(b.store, await peekArchive(new Uint8Array(await blob.arrayBuffer())), { me: 'replace', settings: 'replace' });
  const active = (await readAppSettings(b.ws)).activeTrip;
  assert.equal(active, draft);
  // main.js opens activeTrip only when its scope is there.
  assert.equal(await b.scope(/** @type {string} */ (active)), undefined);
  assert.equal((await listTrips(b.store)).draft, null);
});
