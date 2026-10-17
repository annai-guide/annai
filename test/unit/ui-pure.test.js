import { test } from 'node:test';
import { isArchiveName } from '../../src/ui/import-state.js';
import assert from 'node:assert/strict';
import { parseHash } from '../../src/ui/router.js';
import { relTime, bytes, dateRange, takenText, backupText, formatCost, outcomeText, bookingLines, placeStatus, newerText, withArticle, placeHref } from '../../src/ui/format.js';
import { explainStorageFull } from '../../src/ui/storage-full.js';
import { StorageFullError } from '../../src/core/errors.js';
import { nextBlinkMs } from '../../src/ui/avatar.js';
import { parseMarkdown, parseInline, MD_MAX } from '../../src/ui/markdown.js';
import { mapsUrl, tripPath } from '../../src/ui/cards.js';
import { follow } from '../../src/ui/screens/talk.js';
import { visibleRegion } from '../../src/ui/photo-viewer.js';
import { traceSummary } from '../../src/ui/screens/trace.js';
import { restoreFrom } from '../../src/ui/auto-backup.js';

test('parseHash: screens, parts and params', () => {
  assert.deepEqual(parseHash(''), { name: 'trips', parts: ['trips'], params: {} });
  assert.deepEqual(parseHash('#/trip/trip-1'), { name: 'trip', parts: ['trip', 'trip-1'], params: {} });
  assert.deepEqual(parseHash('#/trip/trip-1/file?path=%2Fnotes%2F%E6%A1%88%E5%86%85.md'), { name: 'file', parts: ['trip', 'trip-1', 'file'], params: { path: '/notes/案内.md' } });
  assert.deepEqual(parseHash('#/import?inbox=1'), { name: 'import', parts: ['import'], params: { inbox: '1' } });
});

test('parseHash: "#import=<url>" from spec §12.3, with the URL kept whole', () => {
  const url = 'https://example.com/a?b=1&c=2#x';
  assert.deepEqual(parseHash('#import=' + encodeURIComponent(url)), { name: 'import', parts: ['import'], params: { url } });
});

test('format helpers', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  assert.equal(relTime(now - 10_000, now), 'just now');
  assert.match(relTime(now - 2 * 3600_000, now), /2 hours ago/);
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1536), '1.5 KB');
  assert.equal(bytes(5 * 1024 * 1024), '5.0 MB');
  assert.match(dateRange('2026-11-25', '2026-11-29'), /Nov/);
  assert.match(dateRange('2026-11-25', '2026-11-29'), /25/);
  assert.match(dateRange('2026-11-25'), /Nov 25/);
});

test('parseHash: a mangled link opens Trips instead of failing', () => {
  const trips = { name: 'trips', parts: ['trips'], params: {} };
  assert.deepEqual(parseHash('#/trip/%E6'), trips);
  assert.deepEqual(parseHash('#/trip/trip-1/file?path=%E6%A1'), { name: 'file', parts: ['trip', 'trip-1', 'file'], params: { path: '�' } });
  assert.deepEqual(parseHash('#import=%ZZ'), trips);
});

test('takenText shows the time as the clock showed it where the photo was taken', () => {
  assert.equal(takenText('2026-11-26T19:04:12-08:00', 'en-GB'), '26 Nov 2026, 19:04');
  assert.equal(takenText('2026-11-27T08:15:00', 'en-GB'), '27 Nov 2026, 08:15');
  assert.equal(takenText('sometime', 'en-GB'), 'sometime');
});

test('a full device gets advice that frees space: removing a trip does, deleting inside one does not (spec §4.9)', () => {
  /** @type {any[]} */
  const cards = [];
  assert.equal(explainStorageFull({ notices: { card: (/** @type {any} */ c) => cards.push(c) }, go: () => {} }, new StorageFullError()), true);
  assert.equal(cards.length, 1);
  for (const advice of [cards[0].body, new StorageFullError().message]) {
    assert.match(advice, /remove a trip you no longer need/i);
    assert.match(advice, /free up space on this device/);
    assert.doesNotMatch(advice, /delet/i);
  }
  assert.deepEqual(cards[0].actions.map((/** @type {any} */ a) => a.label), ['Export a backup', 'Go to Trips']);
});

test('backupText: never, up to date, and changed since (spec §4.9)', () => {
  const now = Date.UTC(2026, 10, 25);
  assert.equal(backupText({ at: null, changed: true }, now), 'not backed up');
  assert.match(backupText({ at: now - 2 * 86400_000, changed: false }, now), /^backed up 2 days ago$/);
  assert.match(backupText({ at: now - 2 * 86400_000, changed: true }, now), /^backed up 2 days ago, changed since$/);
});

test('formatCost: free, small, ordinary and unknown costs', () => {
  assert.equal(formatCost(0), 'free');
  assert.equal(formatCost(0.000125), '$0.0001');
  assert.equal(formatCost(0.0042), '$0.0042');
  assert.equal(formatCost(1.234), '$1.23');
  assert.equal(formatCost(undefined), 'cost unknown');
});

test('outcomeText: what happened to a model, in a few words', () => {
  assert.equal(outcomeText('credit'), 'out of credit');
  assert.equal(outcomeText('benched'), 'resting after an error');
  assert.equal(outcomeText('no-images'), "doesn't take photos");
  assert.equal(outcomeText('something-new'), 'something-new');
});

test('blinks come at random moments, 2.6 to 7.8 seconds apart', () => {
  assert.equal(nextBlinkMs(0), 2600);
  assert.equal(nextBlinkMs(1), 7800);
  assert.equal(nextBlinkMs(0.5), 5200);
});

test('markdown: paragraphs, lists, headings, code; inline bold, italic, code and http(s) links only', () => {
  assert.deepEqual(parseMarkdown('Hi **there**\n\n- one\n- *two*\n\n1. a\n2. b\n\n## Head\n\n```\nx <b>\n```'), [
    { t: 'p', c: [{ t: 'text', v: 'Hi ' }, { t: 'b', c: [{ t: 'text', v: 'there' }] }] },
    { t: 'ul', items: [[{ t: 'text', v: 'one' }], [{ t: 'i', c: [{ t: 'text', v: 'two' }] }]] },
    { t: 'ol', items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]] },
    { t: 'h', c: [{ t: 'text', v: 'Head' }] },
    { t: 'pre', v: 'x <b>' },
  ]);
  assert.deepEqual(parseInline('See [the menu](https://nepenthe.com/menu) or `code`'), [
    { t: 'text', v: 'See ' }, { t: 'a', href: 'https://nepenthe.com/menu', c: [{ t: 'text', v: 'the menu' }] }, { t: 'text', v: ' or ' }, { t: 'code', c: 'code' },
  ]);
});

test('markdown: hostile output stays text', () => {
  assert.deepEqual(parseInline('<img src=x onerror=alert(1)>'), [{ t: 'text', v: '<img src=x onerror=alert(1)>' }]);
  assert.deepEqual(parseInline('[x](javascript:alert(1))'), [{ t: 'text', v: '[x](javascript:alert(1))' }]);
  assert.deepEqual(parseInline('go to https://a.test/x.'), [{ t: 'text', v: 'go to ' }, { t: 'a', href: 'https://a.test/x', c: [{ t: 'text', v: 'https://a.test/x' }] }, { t: 'text', v: '.' }]);
  const long = parseMarkdown('x'.repeat(MD_MAX + 5));
  assert.equal(/** @type {any} */ (long[0]).c[0].v.length, MD_MAX + 1);
});

test('cards: a maps link per platform, and the paths Shiori uses', () => {
  assert.equal(mapsUrl({ name: 'Nepenthe', lat: 36.2203, lng: -121.7612 }, 'ios'), 'https://maps.apple.com/?q=Nepenthe&ll=36.2203,-121.7612');
  assert.equal(mapsUrl({ name: 'Nepenthe', address: 'Highway 1, Big Sur' }, 'android'), 'https://www.google.com/maps/search/?api=1&query=Highway%201%2C%20Big%20Sur');
  assert.deepEqual(tripPath('/trip/bookings/hotel.json'), { root: 'trip', path: '/bookings/hotel.json' });
  assert.deepEqual(tripPath('/me/memory.md'), { root: 'me', path: '/memory.md' });
  assert.equal(tripPath('https://x'), null);
});

test("the trace's one-line summaries say what Shiori did, sent and read", () => {
  const e = (/** @type {string} */ type, /** @type {any} */ data) => ({ type, data, ts: 0, seq: 1, actor: 'x', scope: 's' });
  assert.equal(traceSummary(e('wake', { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }, { kind: 'file', text: 'A new file' }] }), { costs: new Map([['w-1', 0.0123]]) }), `the user wrote; A new file · ${formatCost(0.0123)}`);
  assert.equal(traceSummary(e('msg.user', { text: 'Where should we eat?' })), 'Where should we eat?');
  assert.equal(traceSummary(e('out.speak', { text: 'Nepenthe.' })), 'Nepenthe.');
  assert.equal(traceSummary(e('out.show', { card: { title: 'Dinner', text: 'At 6:30' } })), 'Dinner');
  assert.equal(traceSummary(e('out.ask', { question: 'Keep it?' })), 'Keep it?');
  assert.equal(traceSummary(e('tool.call', { name: 'fetch', input: { url: 'https://x.test/' } })), 'fetch {"url":"https://x.test/"}');
  assert.equal(traceSummary(e('tool.result', { name: 'fetch', ok: true, ms: 120, content: 'Source: https://x.test/ (read directly)' })), 'fetch · ok · 120 ms · Source: https://x.test/ (read directly)');
  assert.equal(traceSummary(e('net.request', { kind: 'web', tool: 'fetch', method: 'GET', url: 'https://x.test/', status: 200, ms: 90 })), 'fetch · GET https://x.test/ · 200 · 90 ms');
  assert.equal(traceSummary(e('compaction', { from: 1, to: 80, mode: 'warm' })), 'events 1–80 summarized (warm)');
  assert.equal(traceSummary(e('decide', { result: { stay: 0.2, go: 0.8 }, by: 'decide' })), 'go (80%) · by decide');
  assert.equal(traceSummary(e('error', { kind: 'budget', message: 'Steps used up.' })), 'budget: Steps used up.');
});

test('follow: it listens before it reads, so what happens meanwhile is shown once, after what was read, in order; it stops once the screen is gone', async () => {
  /** @type {Set<(e: any) => void>} */
  const fns = new Set();
  const agent = { on: (/** @type {string} */ _kind, /** @type {(e: any) => void} */ fn) => { fns.add(fn); return () => fns.delete(fn); } };
  const emit = (/** @type {any} */ e) => { for (const fn of [...fns]) fn(e); };
  const ev = (/** @type {number} */ seq, scope = 'trip-1') => ({ seq, scope, type: 'out.speak' });
  /** @type {number[]} */
  const shown = [];
  /** @type {'building' | 'shown' | 'gone'} */
  let state = 'building';
  await follow(agent, 'trip-1', {
    read: async () => {
      emit(ev(2)); // written before the read, emitted while it runs
      emit(ev(3)); // written after the read
      return [ev(1), ev(2)];
    },
    show: async (e) => {
      shown.push(e.seq);
      if (e.seq === 3) emit(ev(4)); // comes while the early ones are shown
    },
    state: () => state,
  });
  emit(ev(5)); // the screen isn't on the page yet: still shown
  emit(ev(6, 'trip-2')); // another conversation's
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(shown, [1, 2, 3, 4, 5]);
  state = 'gone';
  emit(ev(7));
  assert.equal(fns.size, 0);
  assert.deepEqual(shown, [1, 2, 3, 4, 5]);
});

test('the viewer knows which part of the photo is on screen', () => {
  // A 4000×3000 photo in a 400×300 stage: it fills the stage at scale 1.
  assert.deepEqual(visibleRegion({ stageW: 400, stageH: 300, natW: 4000, natH: 3000, scale: 1, x: 0, y: 0 }), [0, 0, 1, 1]);
  // Zoomed in 2× on the centre: the middle half.
  assert.deepEqual(visibleRegion({ stageW: 400, stageH: 300, natW: 4000, natH: 3000, scale: 2, x: 0, y: 0 }), [0.25, 0.25, 0.75, 0.75]);
  // Zoomed 2× and moved so the left edge shows.
  assert.deepEqual(visibleRegion({ stageW: 400, stageH: 300, natW: 4000, natH: 3000, scale: 2, x: 200, y: 0 }), [0, 0.25, 0.5, 0.75]);
});

test('traceSummary: a photo upload and a refused photo replaced', () => {
  const ev = (/** @type {string} */ type, /** @type {any} */ data) => ({ seq: 1, ts: 0, type, actor: 'system', data });
  assert.equal(traceSummary(ev('net.request', { kind: 'upload', endpoint: 'Anthropic', url: 'https://api.anthropic.com/v1/files', status: 200, ms: 120 })),
    'upload · Anthropic · https://api.anthropic.com/v1/files · 200 · 120 ms');
  assert.equal(traceSummary(ev('net.request', { kind: 'upload', endpoint: 'Anthropic', url: 'https://api.anthropic.com/v1/files', status: 0, ms: 5, error: 'Failed to fetch' })),
    'upload · Anthropic · https://api.anthropic.com/v1/files · Failed to fetch · 5 ms');
  assert.equal(traceSummary(ev('photo.replace', { old: 'aaaaaaaaaaaaaaaa', new: 'bbbbbbbbbbbbbbbb', mediaType: 'image/jpeg' })),
    'a refused photo sent again as a new copy (image/jpeg)');
});

test('isArchiveName: annai archives and zips, not Wallet passes', () => {
  for (const n of ['Trip.annai.zip', 'trip.annai', 'backup.ZIP']) assert.equal(isArchiveName(n), true, n);
  for (const n of ['flight.pkpass', 'trip.ics', 'confirmation.pdf', 'annai']) assert.equal(isArchiveName(n), false, n);
});

test('parseHash: the plan and booking screens', () => {
  assert.equal(parseHash('#/plan').name, 'plan');
  assert.deepEqual(parseHash('#/trip/t-1/plan'), { name: 'plan', parts: ['trip', 't-1', 'plan'], params: {} });
  const b = parseHash('#/trip/t-1/booking?path=%2Fbookings%2Fhotel.json');
  assert.deepEqual([b.name, b.parts[1], b.params.path], ['booking', 't-1', '/bookings/hotel.json']);
  assert.equal(parseHash('#/trip/t-1/toString').name, 'trip');
});

test('bookingLines: what a booking says, with times in their own zone', () => {
  const lines = bookingLines({
    id: 'f', kind: 'flight', status: 'unverified', source: '/files/f.pkpass',
    start: { at: '2026-11-25T08:00:00-08:00', tz: 'America/Los_Angeles' }, end: { at: '2026-11-25T16:30:00-05:00', tz: 'America/New_York' },
    place: { name: 'SFO', address: 'San Francisco, CA' }, confirmation: 'ABC123', cost: { amount: 412.5, currency: 'USD' }, fields: { seat: '21C', bags: 1 },
  }, 'en-US');
  assert.deepEqual(lines.map(([k]) => k), ['Kind', 'Starts', 'Ends', 'Place', 'Confirmation', 'Cost', 'seat', 'bags']);
  assert.match(lines[1][1], /^Wed, Nov 25, 8:00\sAM \(America\/Los_Angeles\)$/);
  assert.match(lines[2][1], /^Wed, Nov 25, 4:30\sPM \(America\/New_York\)$/);
  assert.equal(lines[3][1], 'SFO, San Francisco, CA');
  assert.equal(lines[5][1], '$412.50');
  assert.deepEqual(lines.slice(6), [['seat', '21C'], ['bags', '1']]);
  // Only what is required; a zone annai doesn't know leaves the time out rather than breaking.
  assert.deepEqual(bookingLines({ id: 'x', kind: 'other', status: 'unverified', source: '/files/x' }, 'en-US'), [['Kind', 'Other']]);
  assert.deepEqual(bookingLines({ kind: 'car', start: { at: '2026-11-25T08:00:00-08:00', tz: 'Nowhere' }, fields: 'not an object' }, 'en-US'), [['Kind', 'Car']]);
});

test('a backup place in a few words, and the newer backup at it (spec §12.4)', () => {
  const now = Date.UTC(2026, 9, 16, 12);
  /** @param {Record<string, any>} [o] @returns {any} */
  const t = (o = {}) => ({ id: 'bt-1', type: 'github', name: 'GitHub', config: {}, auto: 'changes', mobileData: false, created: 0, checked: 1, last: null, hold: null, ...o });
  const last = { id: 'c', at: now - 2 * 3_600_000, seqs: {}, bytes: 0 };
  assert.equal(placeStatus(t({ checked: null }), null, now), 'Not set up yet: fill it in, then Save and test');
  assert.equal(placeStatus(t(), null, now), 'Not backed up yet');
  assert.equal(placeStatus(t({ last }), null, now), 'Last backup 2 hours ago');
  assert.equal(placeStatus(t({ last, auto: 'off' }), null, now), 'Last backup 2 hours ago. Automatic backups are off');
  assert.equal(placeStatus(t({ hold: { kind: 'newer', remote: { id: 'x', at: now, label: 'Android phone' } } }), null, now), 'Paused: there is a newer backup from an Android phone');
  assert.equal(placeStatus(t({ hold: { kind: 'newer', remote: { id: 'x', at: now } } }), null, now), 'Paused: there is a newer backup from another device');
  assert.equal(placeStatus(t({ hold: { kind: 'large', bytes: 150 * 1024 * 1024, at: now } }), null, now), 'Not backed up yet. Waiting for your OK to upload 150 MB');
  assert.equal(placeStatus(t({ last, hold: { kind: 'error', message: 'GitHub had a problem.', at: now, count: 1, retryAt: now, needsYou: false } }), null, now),
    'Last backup 2 hours ago. The last try failed: GitHub had a problem.');
  assert.equal(placeStatus(t(), { phase: 'uploading', done: 3, total: 12 }, now), 'Uploading 3 of 12…');
  assert.equal(placeStatus(t(), { phase: 'checking', done: 1, total: 40 }, now), 'Comparing files 1 of 40…');
  assert.equal(placeStatus(t(), { phase: 'building', done: 0, total: 0 }, now), 'Getting the backup ready…');
  assert.deepEqual(['iPhone', 'iPad', 'Android phone', 'computer'].map(withArticle), ['an iPhone', 'an iPad', 'an Android phone', 'a computer']);
  assert.equal(placeHref('bt-1 2'), '#/backups/place?id=bt-1%202');
  const held = t({ last: { ...last, at: now - 86_400_000 }, hold: { kind: 'newer', remote: { id: 'x', at: now - 3_600_000, label: 'Android phone' } } });
  assert.equal(newerText(held, { where: 'me/annai-backup', noun: 'phone', tree: true }, now),
    "An Android phone backed up to me/annai-backup 1 hour ago, after this phone's last backup. Automatic backups there are paused, so neither device overwrites the other. Import it as a copy to bring its trips here, or back up this phone over it (the other backup stays in its history).");
  assert.equal(newerText(t({ hold: { kind: 'newer', remote: { id: 'x', at: now } } }), { where: 'x', noun: 'computer', tree: false }, now),
    'Another device backed up to x just now. Automatic backups there are paused, so neither device overwrites the other. Import it as a copy to bring its trips here, or back up this computer over it.');
  assert.equal(newerText(t(), { where: 'x', noun: 'phone', tree: true }, now), '');
  assert.deepEqual(parseHash('#/backups/place?id=bt-1'), { name: 'backups', parts: ['backups', 'place'], params: { id: 'bt-1' } });
});

test('the trace says what each backup did (spec §15)', () => {
  assert.equal(traceSummary({ type: 'backup', data: { type: 'github', reason: 'auto', backup: 'c1', files: 3, uploaded: 2048, ms: 900 } }), 'github · auto · 3 files sent, 2.0 KB · 900 ms');
  assert.equal(traceSummary({ type: 'backup.newer', data: { type: 'github', remote: { id: 'c2', at: 0, label: 'Android phone' } } }), 'github · a newer backup from an Android phone is there');
  assert.equal(traceSummary({ type: 'backup.error', data: { type: 'github', kind: 'auth', message: 'GitHub refused the token.' } }), 'github · auth: GitHub refused the token.');
  assert.equal(traceSummary({ type: 'backup.download', data: { type: 'github', backup: 'c2', bytes: 4096 } }), 'github · downloaded c2, 4.0 KB');
  assert.equal(traceSummary({ type: 'backup.prune', data: { type: 's3', backup: 'annai-backup-1.annai.zip' } }), 's3 · deleted an older backup, annai-backup-1.annai.zip');
});

test('a restore behind a backup the user started says it waits; then it says it downloads', async () => {
  /** @type {string[]} */
  const said = [];
  /** @type {() => void} */
  let changed = () => {};
  /** @type {(b: Blob) => void} */
  let finish = () => {};
  let progress = /** @type {any} */ (null);
  const backups = {
    running: () => [{ id: 'bt-1', reason: 'user', phase: 'uploading' }],
    progress: () => progress,
    on: (/** @type {() => void} */ fn) => { changed = fn; return () => {}; },
    download: () => new Promise((resolve) => { finish = resolve; }),
  };
  /** @type {string[]} */
  const went = [];
  const done = restoreFrom(/** @type {any} */ ({ backups, store: null, notices: null, go: (/** @type {string} */ h) => went.push(h) }), /** @type {any} */ ({ id: 'bt-1' }), { id: 'c1', at: 0 }, (s) => said.push(s));
  assert.deepEqual(said, ["Waiting for the backup that's running to finish…"]);
  progress = { phase: 'downloading', done: 0, total: 0 };
  changed();
  progress = { phase: 'downloading', done: 2, total: 9 };
  changed();
  finish(new Blob(['zip']));
  await done;
  assert.deepEqual(said.slice(1), ['Downloading the backup…', 'Downloading 2 of 9 files…']);
  assert.deepEqual(went, ['#/import']);
});
