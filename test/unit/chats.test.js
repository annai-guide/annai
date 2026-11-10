import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, listTrips, setTripStatus, removeTrip, syncTripTitles, scopeTitle, ME } from '../../src/core/scopes.js';
import { ensureDraft, chatName, Chats, DRAFT_TITLE, herDating, undoDating } from '../../src/core/chats.js';
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
  // On the log's clock: a conversation's moments and its record's agree, as in the app.
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (/** @type {string} */ k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf), now: () => noon });
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
  for (const text of ['Is 3.5 km too far to walk?', 'Dinner at 7.30 tonight', 'U.S. visa questions', 'Check booking.com for a hotel']) assert.equal(chatName({ text, at, tz }), text, 'a dot inside a word ends no sentence');
  assert.equal(chatName({ text: '?!', at, tz }), '?!', 'punctuation alone and nothing else: kept, never blank');
  // The English rule: a full stop after a word of one or two letters (Mt., St., Dr.) ends no sentence; a word of three letters (Mrs.) still does.
  assert.equal(chatName({ text: 'Mt. Fuji on Tuesday. Then lunch', at, tz }), 'Mt. Fuji on Tuesday.');
  assert.equal(chatName({ text: 'Dr. Lee at St. Mark on Friday. Then lunch', at, tz }), 'Dr. Lee at St. Mark on Friday.');
  assert.equal(chatName({ text: 'Mrs. Smith is here. Then lunch', at, tz }), 'Mrs.');
  assert.equal(chatName({ text: 'Mt.\u00a0Fuji on Tuesday. Then lunch', at, tz }), 'Mt.\u00a0Fuji on Tuesday.', 'a no-break space after it, as pasted text often has');
  // A word of one or two letters, not the end of a longer one: a time, an ordinal, a possessive, a hyphenated word still end the sentence.
  for (const [text, name] of [['Dinner at 8pm. We walk after.', 'Dinner at 8pm.'], ['Meet at 10am. Then the museum', 'Meet at 10am.'], ['Check in on the 3rd. Then lunch', 'Check in on the 3rd.'],
    ["Dinner at Nobu's. Then drinks", "Dinner at Nobu's."], ['Dinner at Nobu’s. Then drinks', 'Dinner at Nobu’s.'], ['Late check-in. Then dinner', 'Late check-in.']]) assert.equal(chatName({ text, at, tz }), name);
  assert.equal(chatName({ text: 'It is 5 p.m. Then dinner at the hotel. Then', at, tz }), 'It is 5 p.m. Then dinner at the hotel.', 'a letter after a dot (p.m., U.S.) is a short word');
  // The cost the user accepted: a first sentence that ends on a short word runs on into the next, and is cut at 40 as long names are.
  assert.equal(chatName({ text: 'We land in LA. Then lunch. Then the beach', at, tz }), 'We land in LA. Then lunch.');
  assert.equal(chatName({ text: 'We land in LA. Then we drive to the coast, and then on', at, tz }), 'We land in LA. Then we drive to the coas');
  // Only the ASCII full stop: the other ends of sentences, and a new line, stay as they are.
  assert.equal(chatName({ text: 'Is it Mt? Then lunch', at, tz }), 'Is it Mt?');
  assert.equal(chatName({ text: '東京は雨。次は京都', at, tz }), '東京は雨。');
  assert.equal(chatName({ text: 'Ask Dr.\nThen lunch', at, tz }), 'Ask Dr.');
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

test('a file kept in it is first use, named from the file, with no line or model to wake; a photo is Photo · hh:mm', async () => {
  const { ws, chats, scope, spent } = await kit();
  await chats.start();
  const draft = /** @type {string} */ (chats.ready);
  await ws.write(draft, '/names.json', {}, { author: 'shiori' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(chats.ready, draft, 'not a file of its own');
  await ws.write(draft, '/files/tickets.pdf', '%PDF', { author: 'user', type: 'application/pdf' });
  await spent(draft);
  assert.ok(!(await scope(draft))?.draft);
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, 'tickets.pdf');
  const next = /** @type {string} */ (chats.ready);
  await ws.write(next, '/files/2026-11-27-1200.jpg', new Uint8Array([0xff, 0xd8, 0xff]), { author: 'user', type: 'image/jpeg' });
  await spent(next);
  assert.match((await ws.readJSON(next, '/trip.json')).title, /^Photo · \d\d:\d\d$/);
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
  const long = `Plan the day. ${'X'.repeat(INLINE_MAX + 10)}`; // a capital after the stop: a new sentence (a lower-case word goes on with this one)
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

/** A conversation started by voice: heard with no words, so the draft is spent unnamed; she dates it in her turn; the words come after the turn (heard.text). */
async function voiceFirst(/** @type {Record<string, unknown>} */ patch) {
  const k = await kit();
  await k.chats.start();
  const draft = /** @type {string} */ (k.chats.ready);
  await k.agent.log(draft, { type: 'heard', actor: 'user', data: { id: 'h1' } });
  await k.spent(draft);
  await k.ws.patch(draft, '/trip.json', patch, { author: 'shiori' });
  await k.agent.log(draft, { type: 'heard.text', actor: 'system', data: { of: 'h1', text: 'Plan our weekend in Testville. The 20th to the 22nd.' } });
  await k.settle();
  return { ...k, draft };
}

test("her dating of a voice-first chat: the dates line follows the dates, not trip.json's newest author, and Undo keeps the name given after (dates only)", async () => {
  const { ws, store, draft } = await voiceFirst({ start: '2027-03-20', end: '2027-03-22' });
  const now = await store.tx(['files'], 'readonly', (t) => t.getFile(draft, '/trip.json'));
  assert.equal(now?.author, 'system', 'the naming write came after hers');
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, 'Plan our weekend in Testville.');
  const before = await herDating(store, draft);
  assert.ok(before, 'still hers to undo');
  await undoDating(ws, draft, before);
  const trip = await ws.readJSON(draft, '/trip.json');
  assert.equal(trip.title, 'Plan our weekend in Testville.', 'the name stays');
  assert.equal(trip.start, undefined);
  assert.equal(trip.end, undefined);
  assert.equal((await store.tx(['files'], 'readonly', (t) => t.getFile(draft, '/trip.json')))?.author, 'user');
  assert.equal(await herDating(store, draft), null, 'undone');
});

test("her dating of a voice-first chat that also named it: Undo puts the dates back and keeps her title, not the draft's", async () => {
  const { ws, store, draft } = await voiceFirst({ title: 'Testville', start: '2027-03-20', end: '2027-03-22' });
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, 'Testville', 'the words came after, and named nothing');
  const before = await herDating(store, draft);
  assert.ok(before);
  await undoDating(ws, draft, before);
  const trip = await ws.readJSON(draft, '/trip.json');
  assert.equal(trip.title, 'Testville');
  assert.equal(trip.start, undefined);
  assert.equal(await herDating(store, draft), null);
});

test('the dates line stays at its place, as the hand-over Undo line does: the user writing or speaking again after her dating leaves it there', async () => {
  const { ws, store, agent, draft } = await voiceFirst({ start: '2027-03-20', end: '2027-03-22' });
  const [dating] = (await store.tx(['events'], 'readonly', (t) => t.listEvents(draft, { types: ['file.write'] }))).filter((/** @type {any} */ e) => e.actor === 'shiori');
  assert.equal((await herDating(store, draft))?.seq, dating.seq, 'right after her turn, at the write that dated it');
  // Her own later lines, a dismissed line (chatter, no one spoke to her) and her files after it change nothing.
  await agent.log(draft, { type: 'heard', actor: 'user', data: { id: 'h9', text: 'just us talking', dismissed: true } });
  await ws.write(draft, '/files/tickets.pdf', '%PDF', { author: 'shiori', type: 'application/pdf' });
  assert.ok(await herDating(store, draft), 'still there');
  await agent.log(draft, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'And dinner?']] });
  assert.equal((await herDating(store, draft))?.seq, dating.seq, 'the user wrote again: it stays, at its place');
  const next = await voiceFirst({ start: '2027-05-01' });
  await next.agent.log(next.draft, { type: 'heard', actor: 'user', data: { id: 'h10', text: 'Thanks' } });
  assert.ok(await herDating(next.store, next.draft), 'the user spoke again');
});

test("a late Undo takes back only what its line set: once she or the user changed the dates since, it has nothing left, and a tap drawn before such a change changes nothing", async () => {
  const { ws, store, agent, draft } = await voiceFirst({ start: '2027-03-20', end: '2027-03-22' });
  await agent.log(draft, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'We fly back on the 23rd']] });
  const late = await herDating(store, draft);
  assert.ok(late);
  // She moves the end, as asked: the line has nothing of its own to take back.
  await ws.patch(draft, '/trip.json', { end: '2027-03-23' }, { author: 'shiori' });
  assert.equal(await herDating(store, draft), null, 'her later change');
  // A tap on the line as it was drawn before that: no dates go, and it says so.
  assert.equal(await undoDating(ws, draft, /** @type {any} */ (late)), false);
  assert.deepEqual([(await ws.readJSON(draft, '/trip.json')).start, (await ws.readJSON(draft, '/trip.json')).end], ['2027-03-20', '2027-03-23']);
  // The user's own change in Details, then the dates set back by hand to hers: the dates are the user's, not the line's.
  const other = await voiceFirst({ start: '2027-03-20', end: '2027-03-22' });
  const drawn = await herDating(other.store, other.draft);
  await other.ws.patch(other.draft, '/trip.json', { start: '2027-03-19' }, { author: 'user' });
  await undoDating(other.ws, other.draft, /** @type {any} */ (drawn));
  assert.equal((await other.ws.readJSON(other.draft, '/trip.json')).start, '2027-03-19', 'never over the user\'s later change');
  await other.ws.patch(other.draft, '/trip.json', { start: '2027-03-20' }, { author: 'user' });
  assert.equal(await herDating(other.store, other.draft), null, "set back by the user: theirs");
  // Undone, then dated again by her: the line is the newer dating's.
  const again = await voiceFirst({ start: '2027-03-20', end: '2027-03-22' });
  assert.equal(await undoDating(again.ws, again.draft, /** @type {any} */ (await herDating(again.store, again.draft))), true);
  assert.equal((await again.ws.readJSON(again.draft, '/trip.json')).start, undefined);
  await again.ws.patch(again.draft, '/trip.json', { start: '2027-04-02', end: '2027-04-04' }, { author: 'shiori' });
  const writes = (await again.store.tx(['events'], 'readonly', (t) => t.listEvents(again.draft, { types: ['file.write'] }))).filter((/** @type {any} */ e) => e.actor === 'shiori');
  assert.equal((await herDating(again.store, again.draft))?.seq, writes.at(-1).seq);
});

test('the dates line goes when the dates are no longer hers: changed by the user after, or never hers', async () => {
  const { ws, store, draft } = await voiceFirst({ start: '2027-03-20', end: '2027-03-22' });
  assert.ok(await herDating(store, draft));
  await ws.patch(draft, '/trip.json', { end: '2027-03-23' }, { author: 'user' });
  assert.equal(await herDating(store, draft), null, 'the user moved the end');
  const own = await createTrip(ws, { title: 'Big Sur', start: '2027-04-01', end: '2027-04-03' });
  assert.equal(await herDating(store, own), null, 'a trip dated when it was made');
  const chat = await createTrip(ws, { title: 'Ramen' });
  assert.equal(await herDating(store, chat), null, 'a chat');
});

test('a draft that cannot be made: whenReady rejects, and the next call tries again', async () => {
  const { chats, store } = await kit();
  const real = store.tx.bind(store);
  let failing = true;
  store.tx = /** @type {any} */ ((/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => (failing && mode === 'readwrite' ? Promise.reject(new Error('the disk is full')) : real(stores, mode, fn)));
  await assert.rejects(chats.whenReady(), /the disk is full/);
  assert.equal(chats.ready, null);
  await assert.rejects(chats.whenReady(), /the disk is full/, 'tried again, and failed again: not left waiting');
  failing = false;
  const id = await chats.whenReady();
  assert.equal(id, chats.ready);
  assert.equal(await chats.whenReady(), id);
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

test('words typed with a file name it, as the box sends them: the file is kept first, then the line comes; a file alone keeps its name', async () => {
  const { ws, agent, chats, spent, settle } = await kit();
  await chats.start();
  const draft = /** @type {string} */ (chats.ready);
  await ws.write(draft, '/files/UA1-booking.pdf', '%PDF', { author: 'user', type: 'application/pdf' });
  await agent.log(draft, { type: 'msg.user', actor: 'user', data: { handover: 'h1', handed: [{ path: '/trip/files/UA1-booking.pdf', type: 'application/pdf', name: 'UA1-booking.pdf', new: true }] }, texts: [['text', 'Our flights to Testville. Can you file them?']] });
  await spent(draft);
  await settle();
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, 'Our flights to Testville.');
  const next = /** @type {string} */ (chats.ready);
  await ws.write(next, '/files/menu.pdf', '%PDF', { author: 'user', type: 'application/pdf' });
  await spent(next);
  await agent.log(next, { type: 'msg.user', actor: 'user', data: { handover: 'h2', handed: [{ path: '/trip/files/menu.pdf', type: 'application/pdf', name: 'menu.pdf', new: true }] }, texts: [['text', '']] });
  await settle();
  assert.equal((await ws.readJSON(next, '/trip.json')).title, 'menu.pdf');
  // A file shared in on its own (no line with it), then a line later: the file's name stays.
  const shared = /** @type {string} */ (chats.ready);
  await ws.write(shared, '/files/ticket.pdf', '%PDF', { author: 'user', type: 'application/pdf' });
  await spent(shared);
  await agent.log(shared, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Is this for Saturday?']] });
  await settle();
  assert.equal((await ws.readJSON(shared, '/trip.json')).title, 'ticket.pdf');
});

test("a heard line's words that come after a reload still name it", async () => {
  const k = await kit();
  await k.chats.start();
  const draft = /** @type {string} */ (k.chats.ready);
  await k.agent.log(draft, { type: 'heard', actor: 'user', data: { id: 'h9' } });
  await k.spent(draft);
  /** @type {Set<(e: any) => void>} */
  const listeners = new Set();
  const again = new Chats({ ws: k.ws, agent: { on: (_k, fn) => { listeners.add(fn); return () => listeners.delete(fn); } }, tz: () => LA });
  await again.start();
  const e = await record(k.store, draft, { now: noon, type: 'heard.text', actor: 'system', data: { of: 'h9', text: 'Is the museum open today? Lets see' } });
  for (const fn of listeners) fn(e);
  // Until it is named, not a fixed 20 ms: under a full run on a loaded host the write came later (2026-11-09: failed once in a full run, passed 12 of 12 alone).
  for (let i = 0; i < 200 && (await k.ws.readJSON(draft, '/trip.json')).title === DRAFT_TITLE; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await k.ws.readJSON(draft, '/trip.json')).title, 'Is the museum open today?');
});

test('a name or dates saved in Details, or a file of its own written by hand, is first use: listed under the name it has, and + opens another', async () => {
  const { store, ws, chats, scope, spent, settle } = await kit();
  await chats.start();
  const draft = /** @type {string} */ (chats.ready);
  await settle();
  assert.equal(chats.ready, draft, 'its own first trip.json is no use of it');
  // Details' Save: the user's update of trip.json.
  await ws.update(draft, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Kyoto in April', start: '2027-04-02', end: '2027-04-09' }), { author: 'user' });
  await spent(draft);
  assert.ok(!('draft' in /** @type {any} */ (await scope(draft))));
  assert.equal((await ws.readJSON(draft, '/trip.json')).title, 'Kyoto in April', 'the name the user gave stays');
  assert.ok((await listTrips(store)).active.some((s) => s.id === draft && s.start === '2027-04-02'));
  const next = /** @type {string} */ (chats.ready);
  assert.ok(next !== draft && (await scope(next))?.draft);
  await settle();
  assert.equal(chats.ready, next, "the next draft's own trip.json spends nothing");
  // Details' "Add a file", by its path.
  await ws.write(next, '/notes.md', '# Notes', { author: 'user' });
  await spent(next);
  assert.ok(!(await scope(next))?.draft);
  assert.equal(scopeTitle(/** @type {any} */ (await scope(next))), 'New conversation');
});

test('archived or removed in Details, the draft is used: + never opens one archived or gone', async () => {
  const { store, chats, scope, spent } = await kit();
  await chats.start();
  const first = /** @type {string} */ (chats.ready);
  await setTripStatus(store, first, 'archived');
  await chats.used(first);
  await spent(first);
  assert.ok(chats.ready && chats.ready !== first);
  assert.deepEqual((await listTrips(store)).archived.map((s) => s.id), [first], 'archived, it is listed as archived');
  const second = /** @type {string} */ (chats.ready);
  assert.equal((await scope(second))?.status, 'active');
  await removeTrip(store, second);
  await chats.used(second);
  await spent(second);
  assert.ok(chats.ready && chats.ready !== second && (await scope(chats.ready))?.draft);
  // A conversation that isn't the draft: nothing is spent.
  const third = chats.ready;
  await chats.used(first);
  assert.equal(chats.ready, third);
});

test('a draft whose making was cut off before its trip.json (a reload) is made whole, and its first line names it', async () => {
  const { store, ws, agent, chats, spent, settle } = await kit();
  // createTrip's first transaction, with the page gone before its trip.json was written.
  await store.tx(['scopes', 'events'], 'readwrite', async (t) => {
    await t.putScope({ id: 'trip-cut', kind: 'trip', title: DRAFT_TITLE, status: 'active', created: noon, updated: noon, format: 1, tripId: 't-cut', talked: null, draft: true });
    await t.appendEvent('trip-cut', { ts: noon, type: 'scope.create', actor: 'user', data: { title: DRAFT_TITLE } });
  });
  await chats.start();
  assert.equal(chats.ready, 'trip-cut');
  assert.deepEqual(await ws.readJSON('trip-cut', '/trip.json'), { id: 't-cut', title: DRAFT_TITLE, places: [], party: [] });
  await agent.log('trip-cut', { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Where is good for ramen?']] });
  await spent('trip-cut');
  await settle();
  assert.equal((await ws.readJSON('trip-cut', '/trip.json')).title, 'Where is good for ramen?');
});

test("a file whose trip says it is a draft imports a conversation like any other: never hidden, and never what + opens", async () => {
  const a = await kit();
  const trip = await createTrip(a.ws, { title: 'Their trip' });
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const b = await kit();
  await b.chats.start();
  const mine = /** @type {string} */ (b.chats.ready);
  const opened = await peekArchive(new Uint8Array(await blob.arrayBuffer()));
  /** @type {any} */ (opened.manifest.scopes[0].record).draft = true; // no annai writes it: a hand-made file
  const { trips: [came] } = await importArchive(b.store, opened, {});
  assert.deepEqual((await listTrips(b.store)).active.map((s) => s.id), [came]);
  await b.agent.log(mine, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'my first line']] });
  await b.spent(mine);
  assert.notEqual(b.chats.ready, came);
});
