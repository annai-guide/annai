import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setWords } from '../../src/core/l10n.js';

// Core's words for the user with Japanese screens (localization L5f, lane 2), with the drafts that ship: backups, archives, push,
// after the trip, packages. The screens' words are made from data when they are shown; what a log, a backup, an export, a stored
// record or a model reads stays English, whatever the screens' language.

setWords('ja', JSON.parse(await readFile(new URL('../../l10n/ja.json', import.meta.url), 'utf8')));
after(() => setWords('en', null));
// Imported once the words are set, as boot.js sets them before main.js loads: words made at a module's top level are Japanese too.
const { relayClient, relayWords, RelayError } = await import('../../src/core/push/relay-client.js');
const { pushWords, problemWords } = await import('../../src/core/push/mirror.js');
const { holdWords, backupWords } = await import('../../src/core/backup.js');
const { ArchiveError, checkManifest, peekArchive } = await import('../../src/core/archive.js');
const { RECAP_SYSTEM, RECAP_SENDS, TELL_RECAP, recapError } = await import('../../src/core/after/recap.js');
const { entryLine, PLAY_SPEEDS } = await import('../../src/core/after/replay.js');
const { newFilesText } = await import('../../src/core/imports.js');
const { parseIcs, planItems } = await import('../../src/core/ics.js');
const { sunChips } = await import('../../src/core/sun.js');
const { device, memoryPlace, placeOn } = await import('./backup-kit.js');
const { SYS } = await import('../../src/core/scopes.js');

/** Japanese letters: kana or kanji. */
const JA = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

test("a relay's failure: the screens' words from its code, the log's English with what the relay said, never matched in words", async () => {
  const fetch = async () => new Response(JSON.stringify({ error: 'rate', message: 'Too many requests from this address. annai tries again in a minute.' }), { status: 429 });
  const e = await relayClient({ base: 'https://push.example.com', fetch }).cancel('x', 'token-0123456789012345678901').then(() => null, (x) => x);
  assert.ok(e instanceof RelayError);
  assert.equal(e.message, 'push.example.com の中継は混み合っています。');
  assert.equal(e.en, 'The relay at push.example.com answered 429 rate: Too many requests from this address. annai tries again in a minute.');
  assert.deepEqual(e.said, { code: 'rate', host: 'push.example.com', status: 429 });
  // A problem kept: English for the log, and the screen's words made again from what it was.
  assert.equal(problemWords({ message: e.en, at: 1, needsYou: false, said: e.said, again: true }), 'push.example.com の中継は混み合っています。annai が自動でもう一度試します。');
  assert.equal(relayWords({ code: 'relay', why: 'old', host: 'old.example.com', count: 3 }),
    '古い中継 old.example.com にある3件のリマインダーをまだ取り消せていません。時刻が過ぎるまで annai は試し続けます。その間も新しい中継は使えます。');
  // One kept before its words were data is shown as it was written, in English (the screen marks it lang="en").
  assert.equal(problemWords({ message: 'The relay at x is busy. annai tries again by itself.', at: 1, needsYou: false }), 'The relay at x is busy. annai tries again by itself.');
});

test("the service worker's words for a reminder, written while notifications are on, hold its places for the minutes and the item", () => {
  const w = pushWords();
  assert.equal(w.lang, 'ja');
  assert.equal(w.soon, 'あと{0}分：{1}。');
  assert.equal(w.now, '今：{1}。');
  assert.equal(w.ago, '{0}分前に始まりました：{1}。');
  assert.match(w.fallback, JA);
});

test("a backup that fails offline: its card and status in Japanese, made from what the hold keeps; the hold and the log keep English", async () => {
  let online = true;
  const place = memoryPlace();
  const d = await device(place, 'iPhone', undefined, () => online);
  const id = await placeOn(d);
  await d.backups.check(id);
  online = false;
  place.failNext(new TypeError('Failed to fetch'));
  const e = await d.backups.backUp(id).then(() => null, (x) => x);
  assert.equal(e?.message, 'この端末はオフラインのため、annai はこのバックアップ先に接続できませんでした。');
  const hold = /** @type {any} */ ((await d.backups.get(id))?.hold);
  assert.equal(hold.message, 'This phone is offline.');
  assert.equal(holdWords(hold), 'この端末はオフラインのため、annai はこのバックアップ先に接続できませんでした。オンラインに戻ると、annai はもう一度試します。');
  const logged = await d.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['backup.error'] }));
  assert.equal(logged.at(-1)?.data.message, 'This phone is offline.');
  assert.doesNotMatch(JSON.stringify(logged), JA);
  assert.equal(backupWords({ code: 'plugin-off', name: 'GitHub' }), 'GitHub のプラグインが動いていません。設定 → バックアップでこのバックアップ先を開いて、オンにしてください。');
});

test("an archive's errors in Japanese on the screens, with English where a backup's log keeps them, and a newer file told by data", async () => {
  const check = /** @type {(m: unknown) => void} */ (checkManifest);
  const newer = /** @type {any} */ (() => { try { check({ format: 99 }); } catch (x) { return x; } return null; })();
  assert.ok(newer instanceof ArchiveError && newer.newer);
  assert.match(newer.message, JA);
  assert.equal(newer.en, 'This file was made by a newer version of annai.');
  const damaged = await peekArchive(new Uint8Array([1, 2, 3])).then(() => null, (x) => x);
  assert.ok(damaged instanceof ArchiveError);
  // The zip's own detail is a developer's, in English, inside the Japanese sentence.
  assert.equal(damaged.message, 'このファイルは annai のファイルではないか、壊れています（this is not a zip archive）。');
});

test("the recap: what the model is told stays English; what the screen says it sends, and why it failed, are Japanese", () => {
  assert.doesNotMatch(RECAP_SYSTEM, JA);
  assert.doesNotMatch(TELL_RECAP, JA);
  assert.ok(RECAP_SENDS.every((line) => JA.test(line)));
  assert.equal(recapError(new Error('No model is set up to write the recap. Add one in Settings → Models.')), 'No model is set up to write the recap. Add one in Settings → Models.');
});

test("the replay's lines and speeds, and the sun's chips, are Japanese; the plan a calendar makes and what Shiori is told of new files stay English", () => {
  const tz = 'America/Los_Angeles';
  const at = Date.parse('2026-11-27T09:00:00-08:00');
  assert.equal(entryLine(/** @type {any} */ ({ kind: 'stay', at, to: at, lat: 1, lng: 1, name: 'Bixby', stamp: { id: 's' } }), tz).text, 'Bixby · 到着 · スタンプ');
  assert.equal(entryLine({ kind: 'said', at, text: 'Hi', spoken: true }, tz).text, 'あなた（音声）：Hi');
  assert.equal(PLAY_SPEEDS[2][1], '1秒で1時間');
  assert.ok(sunChips(Date.parse('2026-11-27T03:00:00-08:00'), 36.27, -121.8, tz).every((c) => JA.test(c)));
  assert.doesNotMatch(newFilesText([{ path: '/files/a.pdf', type: 'application/pdf' }], ['/plan/x.json']), JA);
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=Nowhere/Else:20261127T090000\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const [item] = planItems(parseIcs(ics, { defaultTz: tz }));
  assert.equal(item.item.title, 'Untitled event');
  assert.doesNotMatch(String(item.item.notes), JA);
  assert.match(String(item.item.notes), /This repeats in the calendar/);
});
