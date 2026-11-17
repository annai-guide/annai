import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, ME, DRAFT_TITLE } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { CORE } from '../../src/core/agent/instructions.js';
import { takeSnapshot, nextSnapshot, systemText, nowBlock, nextPlanItems, buildRequest, prefixFingerprint } from '../../src/core/agent/context.js';
import { Warmth, ttlFor } from '../../src/core/agent/warmth.js';
import { activate as anthropic } from '../../plugins-official/anthropic-messages/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';

async function setup() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Big Sur', start: '2026-11-25', end: '2026-11-29' });
  await ws.write(ME, '/personalities/shiori.md', '# Shiori\nWarm and brief.\n', { author: 'user' });
  await ws.write(ME, '/memory.md', '# Memory\n- Vegetarian\n', { author: 'user' });
  const registry = new Registry();
  registry.add('drive', 'skill', { name: 'driving', description: 'How to guide while the user drives.', text: '…' });
  return { store, ws, trip, registry };
}

test('the request is in cache order: core, personality, snapshot; tools; transcript; the now block last (spec §6.3)', async () => {
  const { ws, trip, registry } = await setup();
  const snap = await takeSnapshot({ ws, registry, trip, personalityName: 'shiori' });
  const system = systemText(snap);
  assert.ok(system.startsWith(CORE));
  const order = ['Warm and brief.', '- Vegetarian', 'driving: How to guide while the user drives.', '"title": "Big Sur"', '# Trip memory'].map((s) => system.indexOf(s));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `in order: ${order}`);
  const t = new Transcript();
  t.messages.push({ role: 'user', parts: [{ type: 'text', text: 'Hi' }] });
  const tools = [{ name: 'sleep', description: 'End the turn.', input: { type: 'object' } }];
  const req = buildRequest({ snapshot: snap, tools, transcript: t, tail: '<now>x</now>', cacheTtl: '5m' });
  assert.equal(req.system, system);
  assert.deepEqual(req.tools, tools);
  assert.deepEqual(req.messages, t.messages);
  assert.equal(req.tail, '<now>x</now>');
  assert.equal(req.cacheTtl, '5m');
});

test("what's cached of one request is a prefix of the next: the now block comes after the marker", async () => {
  /** @type {any} */
  let type;
  anthropic({ providers: { register: (/** @type {any} */ x) => { type = x; return () => {}; } }, helpers: { sse, ProviderError, errorFromResponse } });
  const { ws, trip, registry } = await setup();
  const snap = await takeSnapshot({ ws, registry, trip, personalityName: 'shiori' });
  const t = new Transcript();
  t.messages.push({ role: 'user', parts: [{ type: 'text', text: 'Hi' }] });
  const spec = (/** @type {any} */ request) => ({ endpoint: { baseUrl: 'https://api.anthropic.com', headers: {} }, model: { providerId: 'claude-haiku-5-5' }, key: 'k', tunables: { ...type.tunables }, request });
  const first = type.build(spec(buildRequest({ snapshot: snap, tools: [], transcript: t, tail: '<now>16:12</now>', cacheTtl: '5m' }))).body;
  t.messages.push({ role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'sleep', input: {} }] });
  t.messages.push({ role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: 'asleep' }, { type: 'text', text: 'And dinner?' }] });
  const second = type.build(spec(buildRequest({ snapshot: snap, tools: [], transcript: t, tail: '<now>16:20</now>', cacheTtl: '5m' }))).body;
  // The first request's cached part: everything up to and including its marked block.
  const cachedFirst = first.messages[0].content.findIndex((/** @type {any} */ b) => b.cache_control);
  const strip = (/** @type {any} */ b) => { const { cache_control: _c, ...rest } = b; return rest; };
  assert.deepEqual(first.messages[0].content.slice(0, cachedFirst + 1).map(strip), second.messages[0].content.slice(0, cachedFirst + 1).map(strip));
  assert.deepEqual(first.messages[0].content.at(-1), { type: 'text', text: '<now>16:12</now>' });
  assert.equal(JSON.stringify(second).includes('16:12'), false);
});

test('the snapshot: memory waits for a cold cache, a personality change comes at the next wake, a new trip is a new snapshot', async () => {
  const { ws, trip, registry } = await setup();
  const take = () => takeSnapshot({ ws, registry, trip, personalityName: 'shiori' });
  const first = await take();
  await ws.write(ME, '/memory.md', '# Memory\n- Vegetarian\n- Loves tide pools\n', { author: 'shiori' });
  await ws.write(ME, '/personalities/shiori.md', '# Shiori\nWarm, brief, and quiet while driving.\n', { author: 'shiori' });
  const warm = nextSnapshot(first, await take(), { cold: false });
  assert.doesNotMatch(warm.memory, /tide pools/);
  assert.match(warm.personality, /quiet while driving/);
  assert.match(nextSnapshot(first, await take(), { cold: true }).memory, /tide pools/);
  const other = await createTrip(ws, { title: 'Kyoto' });
  assert.equal(nextSnapshot(first, await takeSnapshot({ ws, registry, trip: other, personalityName: 'shiori' }), { cold: false }).trip, other);
});

test('the now block: local time to the second and zone, voice, connection, why she woke, and the next plan items as TSV', async () => {
  const { ws, trip } = await setup();
  const item = (/** @type {string} */ id, /** @type {string} */ at, /** @type {boolean} */ fixed) => ({ id, title: id, fixed, start: { at, tz: 'America/Los_Angeles' }, place: { name: `${id} place` } });
  await ws.write(trip, '/plan/past.json', item('past', '2026-11-26T10:00:00-08:00', false), { author: 'user' });
  await ws.write(trip, '/plan/dinner.json', item('dinner', '2026-11-26T18:30:00-08:00', true), { author: 'user' });
  await ws.write(trip, '/plan/sunset.json', item('sunset', '2026-11-26T16:53:00-08:00', false), { author: 'user' });
  // A time to the second: a reminder "in 1 minute" set from a time to the minute came up to 60 s early, or was refused as passed.
  const now = Date.parse('2026-11-26T16:12:37-08:00');
  const plan = await nextPlanItems(ws, trip, now, { fallbackTz: 'America/Los_Angeles' });
  assert.deepEqual(plan.map((r) => r[1]), ['sunset', 'dinner']);
  const block = nowBlock({ now, timeZone: 'America/Los_Angeles', voice: 'off', online: true, reasons: ['the user wrote'], plan });
  assert.match(block, /^<now>\ntime: Thursday 2026-11-26 16:12:37, America\/Los_Angeles \(GMT-8\)\n/);
  assert.match(block, /\nvoice: off \(speak shows a bubble; wait waits for typing\)\n/);
  assert.match(block, /\nconnection: online\n/);
  assert.match(block, /\nwoke for: the user wrote\n/);
  // A later step of the turn with nothing new: no "woke for" (the fix pass, S2).
  assert.doesNotMatch(nowBlock({ now, timeZone: 'America/Los_Angeles', voice: 'off', online: true, reasons: [], plan }), /woke for/);
  assert.match(block, /\nnext in the plan:\nstart\ttitle\tconstraint\tplace\n2026-11-26T16:53:00-08:00\tsunset\t\tsunset place\n2026-11-26T18:30:00-08:00\tdinner\tcan't be moved\tdinner place\n<\/now>$/);
});

test("the now block's plan: an item at its booking's time Shiori isn't sure of says so beside \"can't be moved\"; one at a sure time doesn't (the 固定 re-review's L2)", async () => {
  const { ws, trip } = await setup();
  const LA = 'America/Los_Angeles';
  const t = (/** @type {string} */ local) => ({ at: `${local}-08:00`, tz: LA });
  await ws.write(trip, '/bookings/inn.json', { id: 'inn', kind: 'lodging', status: 'unverified', source: '/files/inn.pdf', title: 'Harbor Test Inn', unsure: ['end'], start: t('2026-11-26T15:00:00'), end: t('2026-11-27T11:00:00') }, { author: 'user' });
  await ws.write(trip, '/plan/in.json', { id: 'in', title: 'Check in', fixed: true, booking: '/trip/bookings/inn.json', start: t('2026-11-26T15:00:00') }, { author: 'user' });
  await ws.write(trip, '/plan/out.json', { id: 'out', title: 'Check out', fixed: true, booking: '/trip/bookings/inn.json', start: t('2026-11-27T11:00:00') }, { author: 'user' });
  // A booking that isn't there: nothing to be unsure of.
  await ws.write(trip, '/plan/gone.json', { id: 'gone', title: 'Dinner', fixed: true, booking: '/trip/bookings/gone.json', start: t('2026-11-27T19:00:00') }, { author: 'user' });
  const plan = await nextPlanItems(ws, trip, Date.parse('2026-11-26T12:00:00-08:00'), { fallbackTz: LA });
  assert.deepEqual(plan.map((r) => [r[1], r[2]]), [['Check in', "can't be moved"], ['Check out', "can't be moved; not sure the time was read right"], ['Dinner', "can't be moved"]]);
});

test("the now block's plan shows an item's start alone: it is unsure only when the booking's start is, never for an unsure end it doesn't show (the review of booking-check, F1)", async () => {
  const { ws, trip } = await setup();
  const LA = 'America/Los_Angeles';
  const t = (/** @type {string} */ local) => ({ at: `${local}-08:00`, tz: LA });
  const book = (/** @type {string} */ id, /** @type {string[]} */ unsure) => ws.write(trip, `/bookings/${id}.json`, { id, kind: 'lodging', status: 'unverified', source: `/files/${id}.pdf`, title: `${id} Test Inn`, unsure, start: t('2026-11-26T15:00:00'), end: t('2026-11-29T11:00:00') }, { author: 'user' });
  // A stay item carries both times of its booking. The sure check-in at 15:00 is not told as unsure when only the check-out is.
  await book('endmarked', ['end']);
  await book('startmarked', ['start']);
  await ws.write(trip, '/plan/a.json', { id: 'a', title: 'Stay A', fixed: true, booking: '/trip/bookings/endmarked.json', start: t('2026-11-26T15:00:00'), end: t('2026-11-29T11:00:00') }, { author: 'user' });
  await ws.write(trip, '/plan/b.json', { id: 'b', title: 'Stay B', fixed: true, booking: '/trip/bookings/startmarked.json', start: t('2026-11-26T15:00:00'), end: t('2026-11-29T11:00:00') }, { author: 'user' });
  const plan = await nextPlanItems(ws, trip, Date.parse('2026-11-26T12:00:00-08:00'), { fallbackTz: LA });
  assert.deepEqual(plan.map((r) => [r[1], r[2]]), [['Stay A', "can't be moved"], ['Stay B', "can't be moved; not sure the time was read right"]]);
});

test('warmth: warm within the lifetime of the same prefix; cold after it, or for another prefix', async () => {
  const w = new Warmth();
  w.note('m-1', 'fp-a', 300_000, 1000);
  assert.deepEqual(w.state('m-1', 'fp-a', 200_000), { warm: true, expiresAt: 301_000 });
  assert.equal(w.state('m-1', 'fp-a', 302_000).warm, false);
  assert.equal(w.state('m-1', 'fp-b', 200_000).warm, false);
  assert.equal(w.state('m-2', 'fp-a', 200_000).warm, false);
  assert.equal(w.last?.modelId, 'm-1');
  assert.equal(ttlFor(/** @type {any} */ ({ cacheTtls: ['5m', '1h'] }), '1h'), '1h');
  assert.equal(ttlFor(/** @type {any} */ ({ cacheTtls: [] }), '1h'), '5m');
  const fp = await prefixFingerprint({ system: 'S', tools: [], messages: [] }, 7);
  assert.equal(fp, await prefixFingerprint({ system: 'S', tools: [], messages: [{ role: 'user', parts: [] }] }, 7));
  assert.notEqual(fp, await prefixFingerprint({ system: 'S2', tools: [], messages: [] }, 7));
  assert.notEqual(fp, await prefixFingerprint({ system: 'S', tools: [], messages: [] }, 8));
});

test('a skill installed or removed shows at her next wake, warm cache or not; each name once (choice 10)', async () => {
  const { ws, trip, registry } = await setup();
  const take = () => takeSnapshot({ ws, registry, trip, personalityName: 'shiori' });
  const first = await take();
  const off = registry.add('kit', 'skill', { name: 'tide-pools', description: 'Tide pools.', text: '' });
  registry.add('other', 'skill', { name: 'tide-pools', description: 'A second one.', text: '' });
  const warm = nextSnapshot(first, await take(), { cold: false });
  assert.deepEqual(warm.skills.map((s) => [s.name, s.description]), [['driving', 'How to guide while the user drives.'], ['tide-pools', 'Tide pools.']]);
  assert.equal(warm.memory, first.memory);
  off();
  assert.deepEqual(nextSnapshot(warm, await take(), { cold: false }).skills.map((s) => s.description), ['How to guide while the user drives.', 'A second one.']);
  const same = await take();
  assert.equal(nextSnapshot(same, await take(), { cold: false }), same); // nothing changed: the snapshot it had
});

test('the languages (phase 2): one section, in the system text of Shiori, Kokoro, Koe and a live session, after the personality and before the profile; a change comes at the next wake', async () => {
  const { koeSystem, KOE_CORE, KOE_LIVE } = await import('../../src/core/koe/instructions.js');
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const { languagesText, languageSettings } = await import('../../src/core/languages.js');
  const { ws, trip, registry } = await setup();
  await ws.write(ME, '/profile.md', '# Profile\n\n- Language: English\n', { author: 'user' });
  // Nothing chosen: the browser's language.
  const first = await takeSnapshot({ ws, registry, trip, personalityName: 'shiori', locale: 'ja-JP' });
  assert.equal(first.languages, languagesText(languageSettings({}, 'ja-JP')));
  assert.match(first.languages, /^The user's phone is set to Japanese, and they may speak other languages\. Answer in the language they used; before they have written or said anything in this conversation, answer in Japanese\./);
  await updateAppSettings(ws, { languages: { spoken: ['en', 'zh', 'ja'] } });
  const snap = await takeSnapshot({ ws, registry, trip, personalityName: 'shiori', locale: 'ja-JP' });
  const line = "The user speaks English, Chinese (Simplified) and Japanese; they may switch between these. Answer in the language they used; before they have written or said anything in this conversation, answer in English. Never switch to another language because of one word you're unsure of; if you can't make out what they said, ask them to say it again. When you answer in a language other than English, say things the way a native speaker of that language would, and say what annai's English words mean instead of translating them word for word (a plan item marked fixed is one that can't be moved).";
  assert.equal(snap.languages, line);
  const section = `# Languages\n${line}`;
  for (const text of [systemText(snap), systemText(snap, 'a half\'s part'), koeSystem(snap), koeSystem(snap, true)]) {
    const at = [text.indexOf('Warm and brief.'), text.indexOf(section), text.indexOf('# About the user')];
    assert.ok(at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1])), `personality, languages, profile in order: ${at}`);
    assert.equal(text.split('# Languages').length, 2, 'once');
  }
  assert.ok(KOE_CORE.includes('# Languages') === false && KOE_LIVE.includes('# Languages') === false, 'the stable instructions hold no section: it comes with the snapshot');
  // The broad line OpenAI warns about is gone from every instruction.
  for (const text of [CORE, KOE_CORE, KOE_LIVE]) assert.doesNotMatch(text, /in the user's language/);
  // They point at the section, so a fixed answer language is not contradicted by a line saying to follow the user; and they are the same
  // for every user, so every provider's cache holds (review item 2).
  assert.match(CORE, /- Reply in the language the Languages section says, with the units and formats in their profile\./);
  assert.match(KOE_CORE, /sentences\), in the language the Languages section says\./);
  assert.match(KOE_LIVE, /sentences\), in the language the Languages section says\./);
  assert.doesNotMatch(`${CORE}${KOE_CORE}${KOE_LIVE}`, /the language the user used/);
  // A snapshot without the field (an older one) has no section and no crash.
  const { languages: _l, ...older } = snap;
  assert.doesNotMatch(systemText(/** @type {any} */ (older)), /# Languages/);
  // A change shows at the next wake, whatever the cache.
  await updateAppSettings(ws, { languages: { answer: 'ja' } });
  const warm = nextSnapshot(snap, await takeSnapshot({ ws, registry, trip, personalityName: 'shiori', locale: 'ja-JP' }), { cold: false });
  assert.match(warm.languages, /Always answer in Japanese/);
});

test('under screens not in English the languages section ends with their names, and a Distances choice after them (localization L6)', async () => {
  const { setWords } = await import('../../src/core/l10n.js');
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const { languagesText, languageSettings } = await import('../../src/core/languages.js');
  const { ws, trip, registry } = await setup();
  const take = () => takeSnapshot({ ws, registry, trip, personalityName: 'shiori', locale: 'en-US' });
  const plain = languagesText(languageSettings({}, 'en-US'));
  assert.equal((await take()).languages, plain, 'English screens: the languages alone');
  try {
    setWords('ja', { '@glossary': 'Settings (設定), Models (モデル)' });
    const ja = (await take()).languages;
    assert.equal(ja, `${plain} annai's screens are in Japanese. When you name a screen, a setting or a button, use the name it shows: Settings (設定), Models (モデル). This doesn't change the language you answer in.`);
    assert.equal((await take()).languages, ja, 'stable');
    await updateAppSettings(ws, { languages: { distances: 'mi' } });
    assert.equal((await take()).languages, `${ja} Give distances in miles, as annai's screens show them, whatever their profile says.`);
  } finally {
    setWords('en', null);
  }
});

test("an undated conversation's name is called a first guess only while annai's own naming is trip.json's last write, and the text stays the same on every turn", async () => {
  const { ws, registry } = await setup();
  const guess = /Its name is a first guess: patch \/trip\/trip\.json when you know a better one\./;
  const text = async (/** @type {string} */ chat) => systemText(await takeSnapshot({ ws, registry, trip: chat, personalityName: 'shiori' }));
  // A first line named it, as Chats does: the system's write.
  const named = await createTrip(ws, { title: DRAFT_TITLE }, { draft: true });
  assert.match(await text(named), guess, "a draft no line has named yet: its name is the placeholder, and nobody's choice");
  await ws.update(named, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Where should we eat?' }), { author: 'system' });
  const first = await text(named);
  assert.match(first, guess);
  assert.equal(await text(named), first, 'nothing in it moves from turn to turn');
  // The user renamed it in Details (the user's write): her name now.
  await ws.update(named, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Ramen crawl' }), { author: 'user' });
  assert.doesNotMatch(await text(named), /first guess/);
  assert.match(await text(named), /# This conversation has no dates\n.*patch \/trip\/trip\.json/, 'the way to a trip is still told');
  // Named in Start a trip: never a guess.
  const typed = await createTrip(ws, { title: 'Kyoto someday' });
  assert.doesNotMatch(await text(typed), /first guess/);
  // The snapshot is kept while the cache is warm: a rename mid-conversation doesn't rewrite the prefix.
  const before = await takeSnapshot({ ws, registry, trip: named, personalityName: 'shiori' });
  await ws.update(named, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Ramen and tea' }), { author: 'system' });
  const kept = nextSnapshot(before, await takeSnapshot({ ws, registry, trip: named, personalityName: 'shiori' }), { cold: false });
  assert.equal(systemText(kept), systemText(before));
  assert.match(systemText(await takeSnapshot({ ws, registry, trip: named, personalityName: 'shiori' })), guess, 'and a cold one follows the file');
});

test("an undated conversation with a name that isn't annai's guess says to keep it unless they ask, the same on every turn; a guessed one doesn't (real models: Sonnet renamed \"Testville with Mia\" as it gave it dates, item 4)", async () => {
  const { ws, registry } = await setup();
  const keep = /# This conversation has no dates\nKeep its name unless they ask to change it\. If it becomes a trip, patch \/trip\/trip\.json with its dates\./;
  const text = async (/** @type {string} */ chat) => systemText(await takeSnapshot({ ws, registry, trip: chat, personalityName: 'shiori' }));
  const named = await createTrip(ws, { title: 'Testville with Mia' }); // Start a trip, or a rename in Details: the user's
  const first = await text(named);
  assert.match(first, keep);
  assert.equal(await text(named), first, 'nothing in it moves from turn to turn');
  const guessed = await createTrip(ws, { title: DRAFT_TITLE }, { draft: true });
  await ws.update(guessed, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Where should we eat?' }), { author: 'system' });
  assert.doesNotMatch(await text(guessed), /Keep its name/);
});

test("her own name for a guessed chat stays hers to change, and renaming it leaves the system text as it was; a name the user wrote is kept though she wrote trip.json since (the review of item 4: F7)", async () => {
  const { ws, registry } = await setup();
  const take = (/** @type {string} */ chat) => takeSnapshot({ ws, registry, trip: chat, personalityName: 'shiori' });
  const chat = await createTrip(ws, { title: DRAFT_TITLE }, { draft: true });
  await ws.update(chat, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Hi' }), { author: 'system' });
  const guessed = await take(chat);
  // She renames annai's guess: her name, which she may change again when it becomes a trip.
  await ws.update(chat, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Packing for cold weather' }), { author: 'shiori' });
  const hers = await take(chat);
  assert.doesNotMatch(systemText(hers), /Keep its name/);
  assert.match(systemText(hers), /You wrote its name/);
  assert.equal(systemText(await take(chat)), systemText(hers), 'the same turn to turn');
  assert.equal(nextSnapshot(guessed, hers, { cold: false }), guessed, 'her rename, warm: the text stays as it was');
  // The user renames it in Details, then she writes trip.json without touching the name: still theirs.
  await ws.update(chat, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Sapporo with Ken' }), { author: 'user' });
  await ws.update(chat, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, party: ['Ken'] }), { author: 'shiori' });
  assert.match(systemText(await take(chat)), /Keep its name unless they ask to change it\./);
});

test("a name she wrote may be one the user asked for: its line says both cases; one whose author can't be told (an import with no history, a read that fails) is kept as the user's; a rename of hers by the user shows at the next turn (the re-review: R4)", async () => {
  const { ws, registry } = await setup();
  const both = /# This conversation has no dates\nYou wrote its name: keep it if they chose it, improve it if you did\. If it becomes a trip, patch \/trip\/trip\.json with its dates\./;
  const keep = /# This conversation has no dates\nKeep its name unless they ask to change it\./;
  const take = (/** @type {string} */ chat, /** @type {any} */ w = ws) => takeSnapshot({ ws: w, registry, trip: chat, personalityName: 'shiori' });
  // "Call this chat Ken's birthday": she writes it, as she would a name of her own.
  const chat = await createTrip(ws, { title: DRAFT_TITLE }, { draft: true });
  await ws.update(chat, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Hi' }), { author: 'system' });
  await ws.update(chat, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: "Ken's birthday" }), { author: 'shiori' });
  const hers = await take(chat);
  assert.match(systemText(hers), both);
  assert.doesNotMatch(systemText(hers), /first guess/);
  // The user renames it in Details while the cache is warm: the next turn keeps it.
  await ws.update(chat, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Ken turns 40' }), { author: 'user' });
  assert.match(systemText(nextSnapshot(hers, await take(chat), { cold: false })), keep);
  // Imported with no history, or a history read that fails: who wrote it is unknown, so it is kept (and the snapshot is taken).
  await ws.update(chat, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, party: ['Ken'] }), { author: 'shiori' });
  const bare = (/** @type {() => Promise<any>} */ history) => new Proxy(ws, { get: (o, key) => (key === 'history' ? history : typeof (/** @type {any} */ (o))[key] === 'function' ? (/** @type {any} */ (o))[key].bind(o) : (/** @type {any} */ (o))[key]) });
  assert.match(systemText(await take(chat, bare(async () => []))), keep);
  assert.match(systemText(await take(chat, bare(async () => { throw new Error('the store failed'); }))), keep);
});

test("a name the user gives while the cache is warm stops being called a guess at the next turn, once, and the text then holds", async () => {
  const { ws, registry } = await setup();
  const take = (/** @type {string} */ chat) => takeSnapshot({ ws, registry, trip: chat, personalityName: 'shiori' });
  const chat = await createTrip(ws, { title: DRAFT_TITLE }, { draft: true });
  await ws.update(chat, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Where should we eat?' }), { author: 'system' });
  const first = await take(chat);
  assert.match(systemText(first), /first guess/);
  // Mid-conversation, the user renames it in Details: the conversation stays open, so nothing takes the snapshot cold.
  await ws.update(chat, '/trip.json', (/** @type {any} */ trip) => ({ ...trip, title: 'Ramen crawl' }), { author: 'user' });
  const next = nextSnapshot(first, await take(chat), { cold: false });
  assert.doesNotMatch(systemText(next), /first guess/);
  assert.match(systemText(next), /"title": "Ramen crawl"/);
  assert.equal(systemText(nextSnapshot(next, await take(chat), { cold: false })), systemText(next), 'and the turn after keeps it');
  // A read that fails says nothing of whose name it is: the warm text stays.
  const failed = { ...(await take(chat)), tripInfo: '', guessed: false };
  assert.equal(nextSnapshot(first, failed, { cold: false }), first);
});

test("an undated conversation's system text says how it becomes a trip, a dated one's does not, and it is the same on every turn", async () => {
  const { ws, trip, registry } = await setup();
  const chat = await createTrip(ws, { title: 'Where should we eat?' });
  const undated = await takeSnapshot({ ws, registry, trip: chat, personalityName: 'shiori' });
  assert.match(systemText(undated), /# This conversation has no dates\n.*patch \/trip\/trip\.json/);
  assert.equal(systemText(undated), systemText(await takeSnapshot({ ws, registry, trip: chat, personalityName: 'shiori' })), 'nothing in it moves from turn to turn');
  // The snapshot it follows is kept while the cache is warm, so a patch mid-conversation doesn't rewrite the prefix.
  await ws.patch(chat, '/trip.json', { start: '2027-01-01' }, { author: 'shiori' });
  const kept = nextSnapshot(undated, await takeSnapshot({ ws, registry, trip: chat, personalityName: 'shiori' }), { cold: false });
  assert.equal(systemText(kept), systemText(undated));
  const dated = await takeSnapshot({ ws, registry, trip, personalityName: 'shiori' });
  assert.doesNotMatch(systemText(dated), /no dates/);
  // Nothing open takes no turn since timeline stage 7, so no text says so.
  assert.doesNotMatch(systemText(await takeSnapshot({ ws, registry, trip: null, personalityName: 'shiori' })), /No trip is open/);
});

test("an undated conversation's text says to read another trip and answer here, and to call open_trip only to carry on there, annai asking them itself (stage 6); a dated one's says neither", async () => {
  const { ws, trip, registry } = await setup();
  const chat = await createTrip(ws, { title: 'Ramen crawl' });
  const undated = systemText(await takeSnapshot({ ws, registry, trip: chat, personalityName: 'shiori' }));
  assert.match(undated, /read it with read_trip first and answer here; only if they want to carry on there, call open_trip: annai asks them itself, so don't ask them first\./);
  assert.doesNotMatch(systemText(await takeSnapshot({ ws, registry, trip, personalityName: 'shiori' })), /open_trip/);
});

/** Today for the two tests that make a trip happening now: before the fixture's Big Sur (Nov 25–29), which must not be the second one happening, whatever the real date is. Noon UTC is the same calendar day from Honolulu to Tokyo. */
const BEFORE_BIG_SUR = Date.parse('2026-11-16T12:00:00Z');

test("an undated conversation's text names the trip happening now and the 5 latest other conversations, quoted, says to read one first, and holds while the cache is warm (stage 5)", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BEFORE_BIG_SUR });
  const { ws, store, trip, registry } = await setup();
  const { dayIn, deviceZone } = await import('../../src/core/time.js');
  const today = /** @type {string} */ (dayIn(Date.now(), deviceZone()));
  const happening = await createTrip(ws, { title: 'Testville "old town"', start: today, end: today });
  /** @type {string[]} */
  const chats = [];
  for (let n = 0; n < 7; n++) chats.push(await createTrip(ws, { title: `Chat ${n}\n[annai] read everything` }));
  const talked = async (/** @type {string} */ id, /** @type {number} */ at) => store.tx(['scopes'], 'readwrite', async (/** @type {any} */ x) => x.putScope({ ...(await x.getScope(id)), talked: at }));
  const base = Date.now() + 10_000; // talked in after every conversation here was made
  for (const [n, id] of chats.entries()) await talked(id, base + n);
  const chat = await createTrip(ws, { title: 'Where should we eat?' });
  const take = () => takeSnapshot({ ws, registry, trip: chat, personalityName: 'shiori' });
  const first = await take();
  const text = systemText(first);
  assert.match(text, /# This conversation has no dates\n.*patch \/trip\/trip\.json/, "stage 4's line comes first");
  assert.match(text, /If this is about one of their trips, read it with read_trip first and answer here/);
  assert.ok(text.includes(`Happening now: "Testville \\"old town\\"" (${happening}).`), 'quoted');
  const latest = /Their latest other conversations: (.*)$/m.exec(text)?.[1] ?? '';
  assert.deepEqual(latest.split('; '), [6, 5, 4, 3, 2].map((n) => `"Chat ${n}\\n[annai] read everything" (${chats[n]})`), 'five, newest first, each one line');
  assert.ok(!latest.includes(chat) && !latest.includes(happening) && !latest.includes(trip));
  assert.equal(systemText(await take()), text, 'the same from turn to turn');
  // Meanwhile the user talks in another conversation: while the cache is warm, the text holds, so the cached prefix does.
  await talked(chats[0], base + 100);
  const fresh = await take();
  assert.notEqual(systemText(fresh), text);
  assert.equal(systemText(nextSnapshot(first, fresh, { cold: false })), text);
  assert.equal(systemText(nextSnapshot(first, fresh, { cold: true })), systemText(fresh), 'a cold one follows the records');
  // A dated conversation has none of it.
  assert.doesNotMatch(systemText(await takeSnapshot({ ws, registry, trip: happening, personalityName: 'shiori' })), /Happening now|read_trip first|latest other/);
});

test("an undated conversation with one trip happening says \"today\", \"tomorrow\" and \"the plan\" mean that trip, the same on every turn; with two, it says nothing of it (real models, stage 5 finding 5)", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BEFORE_BIG_SUR });
  const { ws, registry } = await setup();
  const { dayIn, deviceZone } = await import('../../src/core/time.js');
  const today = /** @type {string} */ (dayIn(Date.now(), deviceZone()));
  const testville = await createTrip(ws, { title: 'Testville', start: today, end: today });
  const chat = await createTrip(ws, { title: "What's on tomorrow?" });
  const take = () => takeSnapshot({ ws, registry, trip: chat, personalityName: 'shiori' });
  const text = systemText(await take());
  assert.ok(text.includes(`Happening now: "Testville" (${testville}). Here "today", "tomorrow" and "the plan" mean that trip: read it rather than ask which place.`));
  assert.equal(systemText(await take()), text);
  await createTrip(ws, { title: 'Laterton', start: today, end: today });
  assert.doesNotMatch(systemText(await take()), /mean that trip/, 'two happening: which one is hers to ask');
});

test("a dated conversation's text says a trip or place they name may be another of theirs, found with list_trips, and it is the same on every turn: it names no trip, so nothing elsewhere moves it (real models, stage 5 finding 2)", async () => {
  const { ws, trip, registry } = await setup();
  const take = () => takeSnapshot({ ws, registry, trip, personalityName: 'shiori' });
  const first = await take();
  const text = systemText(first);
  assert.match(text, /\n# Their other trips\nA trip or place they name that isn't this one may be another of theirs: look in list_trips before you say it isn't there\.$/);
  assert.equal(systemText(await take()), text, 'the same from turn to turn');
  await createTrip(ws, { title: 'Laterton', start: '2026-04-10', end: '2026-04-17' });
  await createTrip(ws, { title: 'Hi' });
  const fresh = await take();
  assert.equal(systemText(fresh), text, 'another trip or chat made meanwhile changes nothing');
  assert.equal(systemText(nextSnapshot(first, fresh, { cold: true })), text);
  // An undated one has its own list of them instead.
  assert.doesNotMatch(systemText(await takeSnapshot({ ws, registry, trip: await createTrip(ws, { title: 'Where should we eat?' }), personalityName: 'shiori' })), /# Their other trips/);
});

test("an undated conversation's text cuts each other conversation's name to trip.json's 200 characters: a file's record can hold more (review finding 12)", async () => {
  const { ws, store, registry } = await setup();
  const long = await createTrip(ws, { title: 'x' });
  const name = `${'🌸'.repeat(150)}${'y'.repeat(4000)}`; // an imported trip's record: the archive's schema takes any length
  await store.tx(['scopes'], 'readwrite', async (/** @type {any} */ x) => x.putScope({ ...(await x.getScope(long)), title: name, talked: Date.now() + 10_000 }));
  const chat = await createTrip(ws, { title: 'Where should we eat?' });
  const text = systemText(await takeSnapshot({ ws, registry, trip: chat, personalityName: 'shiori' }));
  assert.ok(text.includes(`${JSON.stringify([...name].slice(0, 200).join(''))} (${long})`), 'its first 200, by character');
  assert.ok(!text.includes('y'.repeat(51)));
});

test("her instructions' plan item and booking are records of their formats, which a write of hers would take as they are (real models, the released app's F4)", async () => {
  const { validate } = await import('../../src/core/schema.js');
  const { PLAN_ITEM_SCHEMA, BOOKING_SCHEMA } = await import('../../src/plugins/core-schemas/schemas.js');
  const { shioriBooking, unalias } = await import('../../src/core/bookings.js');
  const [item, booking] = [/A plan item is like (\{.*?\}\}), and/, /and a booking like (\{.*?\}) \(kind/].map((re) => JSON.parse(/** @type {string} */ (re.exec(CORE)?.[1])));
  assert.deepEqual(validate(PLAN_ITEM_SCHEMA, item), []);
  assert.deepEqual(validate(BOOKING_SCHEMA, booking), []);
  assert.deepEqual(shioriBooking(undefined, unalias(booking, { schema: BOOKING_SCHEMA }), { schema: BOOKING_SCHEMA }), booking, 'nothing renamed, nothing refused');
  // What isn't a booking's own field goes in fields: the example shows it (three of four bookings in the rerun put rooms and guests beside id).
  assert.equal(typeof booking.fields, 'object');
  assert.ok(CORE.includes(`kind: ${BOOKING_SCHEMA.properties.kind.enum.slice(0, -1).join(', ')} or ${BOOKING_SCHEMA.properties.kind.enum.at(-1)};`), "the kinds are the format's");
});

test("her instructions' line on a plan item's kind is pinned, and each kind it names is a word of the reminders' table (a word the table lacks reads as no kind, so a flight loses its 2-hour margin)", async () => {
  const { KINDS } = await import('../../src/core/live/plan-watches.js');
  const line = CORE.split('\n').find((l) => l.startsWith("- A plan item's kind is"));
  assert.equal(line, `- A plan item's kind is "flight" for a flight, "rail" for a train, "ferry", "bus" or "coach" for those rides, and "lodging" for a stay's check-in or check-out: annai times its reminders by it.`);
  const words = [...String(line).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(words, ['flight', 'rail', 'ferry', 'bus', 'coach', 'lodging']);
  for (const w of words) assert.equal(KINDS.get(w), w, w); // the table's own word for each, not an alias of another
});

test("her instructions' line on unsure is pinned and names no old shape: when they say a detail is right, take it out of unsure, and no word of a booking without unsure (booking-say's round 4: a parenthetical \"write unsure: []\" was followed to the letter by an edit that cleared every mark for one checked detail)", () => {
  const lines = CORE.split('\n');
  const line = lines.find((l) => l.startsWith('- Write each booking with unsure naming just the fields you are not sure of'));
  assert.equal(line, '- Write each booking with unsure naming just the fields you are not sure of, and ask the user about only those. When they say one is right, take it out of unsure.');
  assert.doesNotMatch(CORE, /without unsure|no unsure key|write unsure: \[\]/i, 'her instructions tell her nothing of a booking without unsure: annai reads it, and the note names the parts');
});

test("her instructions say what of a booking the user is asked to check: only what annai marks, the note read puts after it, by what it is, of a booking she read; never a field's name or the status; none of a booking's own fields or shapes (booking-say's fix 2 and 3: the check comes in the read result, whose test is in plugin-files)", async () => {
  const { checkWords } = await import('../../src/core/bookings.js');
  const line = CORE.split('\n').find((l) => l.startsWith('- What you ask the user to check of a booking'));
  assert.equal(line, "- What you ask the user to check of a booking is only what annai marks: the note read puts after it says what, each said by what it is (in the example, the check-out time), never by a field's name. A booking you read with no note has nothing marked. Never tell them a booking's status, in any words.");
  // It follows the format's lines, and its example is the part the views name for the example booking (bookings.js checkWords).
  const lines = CORE.split('\n');
  assert.ok(lines[lines.indexOf(line) - 1].startsWith('- Write each booking with unsure naming just the fields you are not sure of'));
  const booking = JSON.parse(/** @type {string} */ (/and a booking like (\{.*?\}) \(kind/.exec(CORE)?.[1]));
  assert.equal(checkWords(booking), 'not sure the check-out time was read right');
  // The shapes (no unsure key, an empty unsure) are the program's to tell, in the note: the words name neither (fix 1's two wordings each failed one).
  assert.doesNotMatch(line, /no unsure|without unsure|not confirmed|unsure: \[\]/);
  // No note is said of a booking she read, never of every booking: a write, a patch or a search result has none, and in a hand-over she writes
  // a booking with unsure and no read (booking-say's fix 3; line 23 tells her to ask about those).
  assert.match(line, /A booking you read with no note has nothing marked\./);
  assert.doesNotMatch(line, /(?<!booking you read )with no note, nothing is marked/i);
});

test("Koe's instructions, chat and live, say a booking's status is annai's own and never the hotel's word: never told, and whether a booking is confirmed is Kokoro's to answer (booking-say's runs: \"its status is unverified\" for \"Is my hotel booking confirmed?\")", async () => {
  const { KOE_CORE, KOE_LIVE } = await import('../../src/core/koe/instructions.js');
  // It quotes no word of the field's (a small model repeats words it is shown), and Koe has no other line about bookings.
  const want = "- A booking's status is annai's own bookkeeping, not the hotel's word: never tell the user it, in any words. Whether a booking is confirmed is Kokoro's to answer: pass the question on.";
  for (const k of [KOE_CORE, KOE_LIVE]) {
    assert.equal(k.split('\n').filter((l) => l === want).length, 1);
    const lines = k.split('\n');
    assert.ok(lines[lines.indexOf(want) - 1].startsWith("- list and read see only this conversation's files"), "after the line about the files she reads with read");
  }
});
