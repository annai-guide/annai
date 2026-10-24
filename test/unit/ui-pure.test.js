import { test } from 'node:test';
import { isArchiveName, takePendingImport, leaveSignal, toldIfLeft } from '../../src/ui/import-state.js';
import assert from 'node:assert/strict';
import { parseHash } from '../../src/ui/router.js';
import { relTime, size, dateRange, backupText, formatCost, outcomeText, bookingLines, placeStatus, newerText, withArticle, placeHref, limitFromField, limitField, limitText, localDay } from '../../src/ui/format.js';
import { explainStorageFull } from '../../src/ui/storage-full.js';
import { StorageFullError } from '../../src/core/errors.js';
import { nextBlinkMs } from '../../src/ui/avatar.js';
import { parseMarkdown, parseInline, MD_MAX } from '../../src/ui/markdown.js';
import { mapsUrl, tripPath } from '../../src/ui/cards.js';
import { follow, announcement, announced } from '../../src/ui/screens/talk.js';
import { visibleRegion } from '../../src/ui/photo-viewer.js';
import { traceSummary, newestFirst } from '../../src/ui/screens/trace.js';
import { micProblem } from '../../src/ui/mic-help.js';
import { priceLine, freeTierLabel } from '../../src/ui/screens/provider.js';
import { metaLine } from '../../src/ui/talk-panel.js';
import { mediaKeys } from '../../src/ui/media-keys.js';
import { restoreFrom } from '../../src/ui/auto-backup.js';
import { packWords, downloadedWhen } from '../../src/ui/offline-pack.js';
import { liveText, knownFix } from '../../src/ui/live-chip.js';

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
  assert.equal(relTime(now - 10_000, now), 'now');
  assert.match(relTime(now - 2 * 3600_000, now), /2 hours ago/);
  assert.equal(size(512), '512 byte');
  assert.equal(size(1536), '1.5 kB');
  assert.equal(size(5 * 1024 * 1024), '5.0 MB');
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
  assert.equal(formatCost(0.000125), '$0.00013');
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

test("the trace's lines for her live voice (the pops fix): the sound's rate and latencies as a session is ready, and each reply's numbers", () => {
  const e = (/** @type {string} */ type, /** @type {any} */ data) => ({ type, data, ts: 0, seq: 1, actor: 'x', scope: 's' });
  assert.equal(traceSummary(e('live.session', { state: 'ready', model: 'Gemini Live', ms: 900, sampleRate: 48_000, baseLatency: 0.0058, outputLatency: 0.032 })),
    'live session ready · Gemini Live · 900 ms · sound at 48 kHz, 6 ms processing latency, 32 ms output latency');
  assert.equal(traceSummary(e('live.session', { state: 'resumed', model: 'Gemini Live', ms: 900, sampleRate: 44_100 })), 'live session resumed · Gemini Live · 900 ms · sound at 44.1 kHz');
  assert.equal(traceSummary(e('live.session', { state: 'ready', model: 'Gemini Live', ms: 900, sampleRate: 44_100, baseLatency: null, outputLatency: null })), 'live session ready · Gemini Live · 900 ms · sound at 44.1 kHz');
  assert.equal(traceSummary(e('live.reply', { wake: 'w', ms: 3450, holes: 2, holeMs: 310, waitMs: 40, player: 'worklet', cut: true })),
    'her voice: 3.5 sec played · cut · started after 40 ms · 2 holes, 310 ms · on worklet');
  assert.equal(traceSummary(e('live.reply', { wake: 'w', ms: 2000, holes: 0, holeMs: 0, waitMs: 0, player: 'buffers', cut: false })), 'her voice: 2.0 sec played · started after 0 ms · 0 holes · on buffers');
  assert.equal(traceSummary(e('live.reply', { wake: 'w', ms: 0, holes: 0, holeMs: 0, waitMs: 0, player: 'worklet', cut: true, stalled: true })),
    'her voice: cut before it played · stalled · 0 holes · on worklet');
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
  assert.equal(traceSummary(e('compaction', { from: 1, to: 80, mode: 'fresh' })), 'started fresh after event 80');
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
  });
  assert.deepEqual(lines.map(([k]) => k), ['Kind', 'Starts', 'Ends', 'Place', 'Confirmation', 'Cost', 'seat', 'bags']);
  assert.match(lines[1][1], /^Wed, Nov 25, 8:00\sAM \(PT\)$/);
  assert.match(lines[2][1], /^Wed, Nov 25, 4:30\sPM \(ET\)$/);
  assert.equal(lines[3][1], 'SFO, San Francisco, CA');
  assert.equal(lines[5][1], '$412.50');
  assert.deepEqual(lines.slice(6), [['seat', '21C'], ['bags', '1']]);
  // Only what is required; a zone annai doesn't know leaves the time out rather than breaking.
  assert.deepEqual(bookingLines({ id: 'x', kind: 'other', status: 'unverified', source: '/files/x' }), [['Kind', 'Other']]);
  assert.deepEqual(bookingLines({ kind: 'car', start: { at: '2026-11-25T08:00:00-08:00', tz: 'Nowhere' }, fields: 'not an object' }), [['Kind', 'Car']]);
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
  assert.equal(placeStatus(t(), { phase: 'downloading', done: 120, total: 650 }, now), 'Getting files: 120 of 650');
  assert.equal(placeStatus(t(), { phase: 'downloading', done: 0, total: 1 }, now), 'Getting the backup…', 'one file is no count');
  assert.equal(placeStatus(t(), { phase: 'downloading', done: 0, total: 0 }, now), 'Getting the backup…');
  assert.deepEqual(['iPhone', 'iPad', 'Android phone', 'computer'].map(withArticle), ['an iPhone', 'an iPad', 'an Android phone', 'a computer']);
  assert.equal(placeHref('bt-1 2'), '#/backups/place?id=bt-1%202');
  const held = t({ last: { ...last, at: now - 86_400_000 }, hold: { kind: 'newer', remote: { id: 'x', at: now - 3_600_000, label: 'Android phone' } } });
  assert.equal(newerText(held, { where: 'me/annai-backup', noun: 'phone', tree: true }, now),
    "An Android phone backed up to me/annai-backup 1 hour ago, after this phone's last backup. Automatic backups there are paused, so neither device overwrites the other. Import it as a copy to bring its trips here, or back up this phone over it (the other backup stays in its history).");
  assert.equal(newerText(t({ hold: { kind: 'newer', remote: { id: 'x', at: now } } }), { where: 'x', noun: 'computer', tree: false }, now),
    'Another device backed up to x now. Automatic backups there are paused, so neither device overwrites the other. Import it as a copy to bring its trips here, or back up this computer over it.');
  assert.equal(newerText(t(), { where: 'x', noun: 'phone', tree: true }, now), '');
  assert.deepEqual(parseHash('#/backups/place?id=bt-1'), { name: 'backups', parts: ['backups', 'place'], params: { id: 'bt-1' } });
});

test('the trace says what each backup did (spec §15)', () => {
  assert.equal(traceSummary({ type: 'backup', data: { type: 'github', reason: 'auto', backup: 'c1', files: 3, uploaded: 2048, ms: 900 } }), 'github · auto · 3 files sent, 2.0 kB · 900 ms');
  assert.equal(traceSummary({ type: 'backup.newer', data: { type: 'github', remote: { id: 'c2', at: 0, label: 'Android phone' } } }), 'github · a newer backup from an Android phone is there');
  assert.equal(traceSummary({ type: 'backup.error', data: { type: 'github', kind: 'auth', message: 'GitHub refused the token.' } }), 'github · auth: GitHub refused the token.');
  assert.equal(traceSummary({ type: 'backup.download', data: { type: 'github', backup: 'c2', bytes: 4096 } }), 'github · downloaded c2, 4.0 kB');
  assert.equal(traceSummary({ type: 'backup.download', data: { type: 'github', backup: 'c2', bytes: 4096, stopped: true } }), 'github · downloaded c2, 4.0 kB, then stopped: thrown away');
  assert.equal(traceSummary({ type: 'backup.peek', data: { type: 'forgejo', backup: 'c2', problem: '$.files[0].hash: does not match' } }), "forgejo · c2 can't be opened: $.files[0].hash: does not match");
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
  assert.deepEqual(said.slice(1), ['Getting the backup…', 'Getting files: 2 of 9']);
  assert.deepEqual(went, ['#/import']);
});

test('a restore from a place that can peek opens the import screen at once, with the manifest and no download', async () => {
  /** @type {string[]} */
  const said = [];
  const manifest = { scopes: [] };
  let downloaded = 0;
  const backups = {
    typeOf: () => ({ stores: 'tree', peek() {} }),
    peek: async () => manifest,
    download: async () => { downloaded++; return new Blob(); },
    on: () => () => {}, progress: () => null, running: () => [],
  };
  /** @type {string[]} */
  const went = [];
  await restoreFrom(/** @type {any} */ ({ backups, store: null, notices: null, go: (/** @type {string} */ h) => went.push(h) }), /** @type {any} */ ({ id: 'bt-1', type: 'forgejo' }), { id: 'c1', at: 0 }, (s) => said.push(s));
  assert.deepEqual([said, went, downloaded], [['Opening the backup…'], ['#/import'], 0]);
  const pending = takePendingImport();
  assert.deepEqual([pending?.peeked, pending?.from, pending?.files], [manifest, { target: 'bt-1', remote: { id: 'c1', at: 0 } }, []]);
  // A backup that can't be peeked at says why in the words the place gave.
  const broken = { ...backups, peek: async () => { throw new Error("That backup isn't there."); } };
  said.length = 0;
  await restoreFrom(/** @type {any} */ ({ backups: broken, store: null, notices: null, go: () => went.push('wrong') }), /** @type {any} */ ({ id: 'bt-1', type: 'forgejo' }), { id: 'c1', at: 0 }, (s) => said.push(s));
  assert.deepEqual([said, went, takePendingImport()], [['Opening the backup…', "That backup isn't there."], ['#/import'], null]);
});

test('a restore falls back to the download when the place has nothing to peek with, and for a place of whole files', async () => {
  /** @type {string[]} */
  const said = [];
  /** @type {string[]} */
  const went = [];
  let downloaded = 0;
  let peeked = 0;
  const backups = {
    typeOf: () => ({ stores: 'tree', peek() {} }),
    peek: async () => { peeked++; return null; },
    download: async () => { downloaded++; return new Blob(['zip']); },
    on: () => () => {}, progress: () => null, running: () => [],
  };
  const ctx = (/** @type {any} */ b) => /** @type {any} */ ({ backups: b, store: null, notices: null, go: (/** @type {string} */ h) => went.push(h) });
  await restoreFrom(ctx(backups), /** @type {any} */ ({ id: 'bt-1', type: 'x' }), { id: 'c1', at: 0 }, (s) => said.push(s));
  assert.deepEqual([peeked, downloaded, went], [1, 1, ['#/import']], 'a null peek goes on to the download');
  assert.equal(takePendingImport()?.files.length, 1);
  went.length = 0;
  await restoreFrom(ctx({ ...backups, typeOf: () => ({ stores: 'file', peek() {} }) }), /** @type {any} */ ({ id: 'bt-1', type: 'x' }), { id: 'c1', at: 0 }, (s) => said.push(s));
  assert.deepEqual([peeked, downloaded, went], [1, 2, ['#/import']], 'a place of whole files is not peeked at');
  takePendingImport();
});

test('the import screen listens for leaving until it is left or done, and a finished import is not touched by later moves', () => {
  /** @type {Set<() => void>} */
  const heard = new Set();
  const target = { addEventListener: (/** @type {string} */ _t, /** @type {() => void} */ fn) => { heard.add(fn); }, removeEventListener: (/** @type {string} */ _t, /** @type {() => void} */ fn) => { heard.delete(fn); } };
  const left = leaveSignal(/** @type {any} */ (target));
  assert.equal(heard.size, 1);
  for (const fn of [...heard]) fn(); // a move to another screen
  assert.equal(left.signal.aborted, true);
  assert.equal(heard.size, 0, 'let go once left');
  const finished = leaveSignal(/** @type {any} */ (target));
  finished.done();
  assert.equal(heard.size, 0, 'let go once the import is done');
  assert.equal(finished.signal.aborted, false);
});

test('an import that finishes after the user left says so in a toast, with what came in and from where', () => {
  /** @type {string[]} */
  const toasts = [];
  const ctx = { notices: { toast: (/** @type {string} */ s) => toasts.push(s) } };
  const here = new AbortController();
  toldIfLeft(ctx, here.signal, ['Big Sur'], 'Forgejo / Gitea');
  assert.deepEqual(toasts, [], 'the user is still here: the screen says it');
  here.abort();
  toldIfLeft(ctx, here.signal, ['Big Sur'], 'Forgejo / Gitea');
  toldIfLeft(ctx, here.signal, ['Big Sur', 'Kyoto'], null);
  toldIfLeft(ctx, here.signal, ['A', 'B', 'C'], 'Forgejo / Gitea');
  toldIfLeft(ctx, here.signal, [], 'Forgejo / Gitea');
  assert.deepEqual(toasts, ['Imported Big Sur from Forgejo / Gitea.', 'Imported Big Sur and Kyoto.', 'Imported 3 trips from Forgejo / Gitea.', 'Imported from Forgejo / Gitea.']);
});

test('a restore passes the screen\'s signal to the peek and to the download', async () => {
  const stop = new AbortController();
  /** @type {unknown[]} */
  const seen = [];
  const backups = {
    typeOf: () => ({ stores: 'tree', peek() {} }),
    peek: async (/** @type {string} */ _a, /** @type {string} */ _b, /** @type {any} */ o) => { seen.push(o.signal); return null; },
    download: async (/** @type {string} */ _a, /** @type {string} */ _b, /** @type {any} */ o) => { seen.push(o.signal); return new Blob(['zip']); },
    on: () => () => {}, progress: () => null, running: () => [],
  };
  await restoreFrom(/** @type {any} */ ({ backups, store: null, notices: null, go: () => {} }), /** @type {any} */ ({ id: 'bt-1', type: 'x' }), { id: 'c1', at: 0 }, () => {}, { signal: stop.signal });
  assert.deepEqual(seen, [stop.signal, stop.signal]);
  takePendingImport();
});

test('the limit for an unnamed connection, as typed and as shown', () => {
  assert.equal(limitFromField(''), null);
  assert.equal(limitFromField('  '), null);
  assert.equal(limitFromField('25'), 25 * 1024 * 1024);
  assert.equal(limitFromField('0'), 0);
  assert.equal(limitFromField('2.5'), Math.round(2.5 * 1024 * 1024));
  for (const bad of ['-1', 'lots', '1e9999']) assert.equal(limitFromField(bad), undefined, bad);
  assert.equal(limitField(undefined), '25');
  assert.equal(limitField(null), '');
  assert.equal(limitField(100 * 1024 * 1024), '100');
  assert.equal(limitText(undefined), '25 MB');
  assert.equal(limitText(null), 'no limit');
  assert.equal(limitText(0), '0 byte');
});

test('a microphone that fails says what happened and what to do, for this phone (spec §17 rule 3)', () => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  assert.match(micProblem(denied, 'ios').body, /Settings → Apps → Safari → Microphone/);
  assert.match(micProblem(denied, 'android').body, /App info → Permissions/);
  assert.match(micProblem(denied, 'desktop').body, /site settings/);
  assert.equal(micProblem(Object.assign(new Error('x'), { name: 'NotFoundError' })).title, 'No microphone found');
  assert.equal(micProblem(Object.assign(new Error('x'), { name: 'NotReadableError' })).title, 'The microphone is busy');
  assert.match(micProblem(new Error('Weird')).body, /^Weird\. Try again/);
});

test('model prices in a line: tokens, minutes of speech, or characters', () => {
  assert.equal(priceLine({ input: 2, output: 10 }), '$2 in, $10 out per million tokens');
  assert.equal(priceLine({ input: 0, output: 0 }), 'free');
  const doubling = { input: 1, output: 4, schedule: [{ from: '2027-01-01', input: 2, output: 8 }] };
  assert.equal(priceLine(doubling, Date.parse('2026-12-31T23:00:00Z')), '$1 in, $4 out per million tokens (from 2027-01-01: $2 in, $8 out)');
  assert.equal(priceLine(doubling, Date.parse('2027-01-01T00:00:00Z')), '$2 in, $8 out per million tokens', 'the price in force, not the base');
  assert.equal(priceLine({ perMinute: 0.006 }), '$0.006 a minute of speech');
  assert.equal(priceLine({ perMillionChars: 15 }), '$15 per million characters');
  assert.equal(priceLine(null), null);
});

test("steering-wheel and headset buttons tap Shiori while voice is on, and do nothing while it's off (spec §18)", () => {
  /** @type {Record<string, any>} */
  const handlers = {};
  const session = {
    setActionHandler(/** @type {string} */ action, /** @type {any} */ fn) {
      if (action === 'previoustrack') throw new Error('not supported here');
      handlers[action] = fn;
    },
  };
  /** @type {((m: any) => void)[]} */
  const listeners = [];
  const voice = { on: false, onChange: (/** @type {any} */ fn) => { listeners.push(fn); return () => {}; } };
  let taps = 0;
  mediaKeys({ session, agent: { tap: () => { taps++; return 'listening'; } }, voice });
  assert.equal(handlers.play, null);
  for (const fn of listeners) fn({ on: true });
  handlers.play();
  handlers.pause();
  handlers.nexttrack();
  assert.equal(taps, 3);
  for (const fn of listeners) fn({ on: false });
  assert.equal(handlers.pause, null);
  assert.doesNotThrow(() => mediaKeys({ session: undefined, agent: { tap: () => 'typing' }, voice }));
});

test("the trace's one-line summaries of live mode: points, firings, reminders and switches", () => {
  assert.equal(traceSummary({ type: 'location', data: { lat: 36.3715, lng: -121.9017, accuracy: 8, speed: 15 } }), '36.3715, -121.9017 ±8 m · 54 km/h');
  assert.equal(traceSummary({ type: 'location', data: { lat: 36.3715, lng: -121.9017, accuracy: 50, source: 'manual' } }), '36.3715, -121.9017 ±50 m · manual');
  assert.equal(traceSummary({ type: 'trigger.fired', data: { watch: 'plan:hearst:leave', text: 'Plan: time to leave soon for "Hearst Castle tour"', late: 17, offline: true } }),
    'plan:hearst:leave · Plan: time to leave soon for "Hearst Castle tour" · late by 17 min · no connection');
  assert.equal(traceSummary({ type: 'reminder', data: { text: 'Tea time.', aloud: true } }), 'said aloud · Tea time.');
  assert.equal(traceSummary({ type: 'state', data: { live: 'on' } }), 'GPS on');
  assert.equal(traceSummary({ type: 'state', data: { voice: 'on', why: 'moving' } }), 'voice on (moving)');
});

test('the Offline pack panel: the estimate before anything is downloaded, then what it holds and what an update brings (spec §11.5)', () => {
  const base = { stops: 2, cut: 0, manifest: null, why: null, estimate: 120 * 1024, running: null };
  const none = packWords(/** @type {any} */ (base), 'unknown');
  assert.equal(none.button, 'Download (about 120 kB)');
  assert.match(none.lines[0], /^For when there's no connection: places from OpenStreetMap, Wikipedia summaries and Wikivoyage guides, around the plan's 2 stops and along the way between them\./);
  assert.equal(none.lines[1], "Downloading sends the plan's places to OpenStreetMap and Wikipedia, and place names to Wikivoyage.");
  assert.deepEqual(packWords(/** @type {any} */ ({ ...base, stops: 0 }), 'wifi'), { lines: ['The pack follows the plan: once the plan has places, it can be downloaded here.'], button: null });
  assert.deepEqual(packWords(/** @type {any} */ ({ ...base, running: { done: 2, total: 6, label: 'Wikipedia near Nepenthe' } }), 'wifi'), { lines: ['Downloading 3 of 6: Wikipedia near Nepenthe…'], button: null });
  const manifest = { at: new Date().toISOString(), bytes: 1_300_000, places: 1200, summaries: 40, files: [{ kind: 'osm', items: 1300 }, { kind: 'wikipedia', items: 45 }, { kind: 'wikivoyage', items: 1 }], guides: [{ title: 'Big Sur' }], failed: [], full: false, stopped: false };
  const done = packWords(/** @type {any} */ ({ ...base, manifest }), 'wifi');
  assert.equal(done.button, null);
  assert.equal(done.lines[0], 'Downloaded now · 1.2 MB · 1,200 places, 40 Wikipedia summaries, 1 Wikivoyage guide.');
  assert.equal(done.lines[1], 'Guides: Big Sur.');
  assert.equal(done.lines.at(-1), 'On Wi-Fi, annai keeps it up to date by itself while this trip is open.');
  const changed = packWords(/** @type {any} */ ({ ...base, manifest, why: 'plan', estimate: 30 * 1024 }), 'unknown');
  assert.equal(changed.button, 'Update (about 30 kB)');
  assert.ok(changed.lines.includes('The plan changed since.'));
  assert.equal(changed.lines.at(-1), "This browser doesn't tell annai when it is on Wi-Fi, so update it here.");
  const failed = packWords(/** @type {any} */ ({ ...base, manifest: { ...manifest, failed: [{ label: 'OpenStreetMap around Nepenthe', why: 'overpass-api.de answered 504.' }] }, why: 'missing' }), 'wifi');
  assert.equal(failed.button, 'Try again (about 120 kB)');
  assert.ok(failed.lines.includes("One part didn't download: OpenStreetMap around Nepenthe (overpass-api.de answered 504)."));
  assert.equal(packWords(/** @type {any} */ ({ ...base, manifest: { ...manifest, stopped: true }, why: 'missing' }), 'wifi').button, 'Download the rest (about 120 kB)');
  assert.ok(packWords(/** @type {any} */ ({ ...base, manifest: { ...manifest, full: true } }), 'wifi').lines.includes('It stopped at its 20 MB limit, so it holds only the start of the plan.'));
  assert.match(packWords(/** @type {any} */ ({ ...base, manifest: { ...manifest, places: 1, summaries: 1, guides: [] } }), 'wifi').lines[0], / · 1 place, 1 Wikipedia summary, 0 Wikivoyage guides\.$/);
  assert.ok(packWords(/** @type {any} */ ({ ...base, manifest, cut: 3 }), 'wifi').lines.includes('This plan is longer than a pack holds, so some of the way between stops is left out.'));
  assert.equal(packWords(/** @type {any} */ ({ ...base, manifest, why: 'old' }), 'wifi').button, 'Update (about 120 kB)');
});

test("a pack whose manifest doesn't say when it was downloaded says only that it was, never \"now\"", () => {
  const base = { stops: 2, cut: 0, why: null, estimate: 120 * 1024, running: null };
  const manifest = { at: '', bytes: 1_300_000, places: 1200, summaries: 40, files: [], guides: [], failed: [], full: false, stopped: false };
  assert.equal(packWords(/** @type {any} */ ({ ...base, manifest }), 'wifi').lines[0], 'Downloaded · 1.2 MB · 1,200 places, 40 Wikipedia summaries, 0 Wikivoyage guides.');
  assert.equal(downloadedWhen(''), '');
  assert.equal(downloadedWhen('not a time'), '');
  assert.equal(downloadedWhen(new Date().toISOString()), ' now');
});

test('the trace says what each offline pack download did', () => {
  assert.equal(traceSummary(/** @type {any} */ ({ type: 'pack.download', data: { files: 7, bytes: 120_000, guides: 2, failed: 1, stopped: false, full: false, auto: true } })),
    '7 files · 117 kB · 2 guides · 1 failed · by itself on Wi-Fi');
});

test('Trace lines for notifications', () => {
  assert.equal(traceSummary({ type: 'push.sync', data: { relay: 'push.annai.guide', sent: 2, calledOff: 1, waiting: 5 } }), 'push.annai.guide · 2 sent, 1 called off · 5 waiting');
  assert.equal(traceSummary({ type: 'push.sync', data: { relay: 'push.annai.guide', sent: 0, calledOff: 0, waiting: 5, error: "annai couldn't reach the relay." } }), "push.annai.guide · 0 sent, 0 called off · 5 waiting · annai couldn't reach the relay.");
  assert.equal(traceSummary({ type: 'push.shown', data: { watch: 'w-1', at: 1 } }), 'notification shown · w-1');
  assert.equal(traceSummary({ type: 'push.opened', data: { watch: 'plan:tea:coming-up', at: 1 } }), 'notification opened · plan:tea:coming-up');
});

test('parseHash: the recap and replay screens of a trip, with a day', () => {
  assert.deepEqual(parseHash('#/trip/t1/recap'), { name: 'recap', parts: ['trip', 't1', 'recap'], params: {} });
  assert.deepEqual(parseHash('#/trip/t1/replay?day=2026-11-27'), { name: 'replay', parts: ['trip', 't1', 'replay'], params: { day: '2026-11-27' } });
  assert.equal(parseHash('#/simulate').name, 'simulate');
});

test("the live chip during a simulation, and where the user is by live mode's own clock", () => {
  const fix = { lat: 36, lng: -121, at: Date.parse('2026-11-27T12:00:00-08:00'), source: 'sim' };
  const live = { on: true, gps: 'ok', activity: 'moving-fast', fix, simulating: true, clock: { now: () => fix.at + 5000 } };
  assert.equal(liveText(live), 'Simulation · moving fast');
  assert.equal(knownFix(live), fix); // fresh by the simulation's clock, weeks from today
  assert.equal(liveText({ ...live, simulating: false, activity: 'still' }), 'GPS on · stopped');
  assert.equal(knownFix({ ...live, clock: { now: () => fix.at + 3_600_000 } }), null);
});

test('Settings → Notifications offers what each state needs; when the phone took them away, Turn on notifications again (fix pass N3, spec §17 rule 3)', async () => {
  const { buttonsFor } = await import('../../src/ui/screens/notifications.js');
  const fine = { on: true, supported: 'yes', permission: 'granted', problem: null };
  assert.deepEqual(buttonsFor(fine), ['off', 'test']);
  assert.deepEqual(buttonsFor({ ...fine, on: false }), ['on']);
  assert.deepEqual(buttonsFor({ ...fine, problem: { needsYou: true } }), ['on', 'off'], 'the phone dropped the subscription');
  assert.deepEqual(buttonsFor({ ...fine, permission: 'denied' }), ['on', 'off'], 'notifications turned off in the phone\'s settings');
  assert.deepEqual(buttonsFor({ ...fine, problem: { needsYou: false } }), ['off', 'test'], 'a passing problem needs nothing');
  assert.deepEqual(buttonsFor({ ...fine, supported: 'install' }), []);
});

test('the install screen says what a package brings and where it came from', async () => {
  const { whatItBrings, sourceLine, keysNote } = await import('../../src/ui/screens/plugin-install.js');
  assert.deepEqual(whatItBrings({ code: true, skills: [{ name: 'trail-safety', description: 'Before a hike.' }], personalities: [{ name: 'ranger' }],
    provider: { abilities: { chat: { kind: 'chat' }, ears: { kind: 'transcription' }, voice: { kind: 'voice' } } } }),
  ['Code that runs in annai', 'Skill "trail-safety": Before a hike.', 'Personality "ranger"', 'A model provider: chat, transcription, and voice']);
  assert.deepEqual(whatItBrings({ code: false, skills: [], personalities: [], origins: ['https://api.b.test'] }), ['Its provider now sends keys you give it to https://api.b.test']);
  // Security review: a fresh install of a provider says where keys go, with each origin's scheme.
  assert.equal(keysNote({ provider: { baseUrl: 'https://api.openai.test/v1', abilities: { voice: { kind: 'voice', baseUrl: 'http://localhost:8880/v1' } } } }),
    'Keys you give this provider are sent to http://localhost:8880 and https://api.openai.test.');
  assert.equal(keysNote({ provider: { baseUrl: '', abilities: {} } }), 'Keys you give this provider are sent only to the address you give it.');
  assert.equal(keysNote({ provider: null }), null);
  assert.deepEqual(whatItBrings({ code: false, skills: [], personalities: [] }), ['Nothing annai uses yet']);
  assert.equal(sourceLine({ source: 'url', url: 'https://trails.example/kits/SKILL.md?token=abc' }), 'From trails.example/kits/SKILL.md?token=«key»');
  assert.equal(sourceLine({ source: 'file', file: 'tides.zip' }), 'From a file: tides.zip');
  assert.equal(sourceLine({ source: 'file' }), 'From a file');
  assert.equal(sourceLine({ source: 'official' }), 'From annai');
  assert.equal(sourceLine({ source: 'builtin' }), 'From annai');
});

test("M6: a package over an installed one of its id says so: an update from where it came, else that it replaces one from elsewhere, which hands it that one's settings and keys", async () => {
  const { overLine } = await import('../../src/ui/screens/plugin-install.js');
  const at = (/** @type {string} */ url) => ({ source: 'url', url });
  assert.equal(overLine({ version: '1.0.0', from: at('https://trails.example/kit/annai-plugin.json') }, at('https://trails.example/kit/annai-plugin.json')), 'Version 1.0.0 is installed now. Installing replaces it.');
  assert.equal(overLine({ version: '1.0.0', from: { source: 'file', file: 'kit.zip' } }, { source: 'file', file: 'kit (1).zip' }), 'Version 1.0.0 is installed now. Installing replaces it.');
  // A key in the address is no difference: annai keeps it blanked.
  assert.equal(overLine({ version: '1.0.0', from: at('https://trails.example/s/«key»/annai-plugin.json') }, at('https://trails.example/s/zap1a2b3c4d5e6f7g8h9/annai-plugin.json')), 'Version 1.0.0 is installed now. Installing replaces it.');
  for (const from of [at('https://other.example/kit/annai-plugin.json'), { source: 'file', file: 'kit.zip' }]) {
    assert.equal(overLine({ version: '1.0.0', from: at('https://trails.example/kit/annai-plugin.json') }, from),
      "Version 1.0.0 is installed now, from trails.example/kit/annai-plugin.json, not where this one comes from. Kept, its settings, keys and your choices for its names go to this one; fresh, they are removed.");
  }
});

test("M6 fix: an owner that isn't annai's own (a built-in or an official plugin) is always shown with its id, so no manifest name passes for annai's", async () => {
  const { ownerName } = await import('../../src/ui/screens/plugin-install.js');
  const rows = [{ id: 'places', name: 'Places tools', builtin: true }, { id: 'chat-completions', name: 'Chat Completions', source: 'official' }, { id: 'honest', name: 'Tides', source: 'url' },
    ...['аnnai', 'an\u200bnai', 'ａｎｎａｉ', 'Annai '].map((name, i) => ({ id: `imp${i}`, name, source: 'file' }))];
  assert.deepEqual(rows.map((r) => ownerName(rows, r.id)), ['Places tools', 'Chat Completions', 'Tides (honest)', 'аnnai (imp0)', 'an\u200bnai (imp1)', 'ａｎｎａｉ (imp2)', 'Annai  (imp3)']);
  assert.deepEqual([ownerName(rows, 'annai'), ownerName(rows, 'gone')], ['annai', 'gone']);
});

test('the card when a plugin is switched off says which, why and where to turn it back on', async () => {
  const { disabledCard } = await import('../../src/ui/plugin-cards.js');
  assert.deepEqual(disabledCard({ name: 'Tides', reason: 'failed 3 times in a row', message: 'boom' }), {
    tone: 'warn', title: 'The plugin "Tides" was turned off',
    body: 'It failed 3 times in a row. The last error: boom You can turn it back on in Settings → Plugins.',
  });
});

test("routes for plugins' screens, settings pages and trip tabs", () => {
  assert.deepEqual(parseHash('#/ext/tides/today'), { name: 'ext', parts: ['ext', 'tides', 'today'], params: {} });
  assert.deepEqual(parseHash('#/plugin-page/tides/station'), { name: 'plugin-page', parts: ['plugin-page', 'tides', 'station'], params: {} });
  assert.equal(parseHash('#/trip/trip-1/ext/tides/table').name, 'trip-ext');
  assert.equal(parseHash('#/plugins/tides').name, 'plugins');
});

test('what plugins add to the UI has a signature that changes only when they do', async () => {
  const { uiSignature } = await import('../../src/ui/slots.js');
  const { Registry } = await import('../../src/core/registry.js');
  const r = new Registry();
  const empty = uiSignature(r);
  r.add('tides', 'tool', { name: 'x' });
  assert.equal(uiSignature(r), empty);
  const off = r.add('tides', 'ui:status-chip', { id: 'tide', render: () => {} });
  const one = uiSignature(r);
  assert.notEqual(one, empty);
  off();
  assert.equal(uiSignature(r), empty);
});

test('Now hands over to the screen a plugin offers for an activity, else to Driving when moving fast (choice 5)', async () => {
  const { handover } = await import('../../src/ui/screens/now.js');
  const hike = { pluginId: 'trail-ui', item: { id: 'hike', homeFor: 'walking' } };
  const car = { pluginId: 'road', item: { id: 'road', homeFor: 'moving-fast' } };
  assert.equal(handover('walking', 'still', [hike]), '#/ext/trail-ui/hike');
  assert.equal(handover('walking', 'walking', [hike]), null);
  assert.equal(handover('moving-fast', 'walking', [hike]), '#/drive');
  assert.equal(handover('moving-fast', 'still', [hike, car]), '#/ext/road/road');
  assert.equal(handover('still', 'walking', [hike]), null);
});

test("a typed card's label names its kind; an unknown one is plain SHIORI", async () => {
  const { cardWho } = await import('../../src/ui/cards.js');
  const { Registry } = await import('../../src/core/registry.js');
  const registry = new Registry();
  registry.add('tides', 'ui:card-type', { type: 'tides', name: 'Tides', description: 'x', render: () => {} });
  assert.equal(cardWho({ registry }, { type: 'tides' }), 'SHIORI · TIDES');
  assert.equal(cardWho({ registry }, { type: 'ferries' }), 'SHIORI');
  assert.equal(cardWho({ registry }, { title: 'Hi' }), 'SHIORI');
});

test("Reset's note names what it cleared by the form's labels; with nothing saved it says so", async () => {
  const { resetNote } = await import('../../src/ui/screens/plugin.js');
  const schema = { type: 'object', properties: { trailhead: { type: 'string', title: 'Trailhead' }, token: { type: 'string', title: 'Token', writeOnly: true } } };
  assert.equal(resetNote({ file: true, keys: ['seen', 'trailhead'], secrets: ['token'] }, schema), 'Cleared its settings (seen, Trailhead) and its secrets (Token).');
  assert.equal(resetNote({ file: false, keys: [], secrets: ['jina'] }, null), 'Cleared its secrets (jina).');
  assert.equal(resetNote({ file: true, keys: [], secrets: [] }, schema), 'Cleared its settings.');
  assert.equal(resetNote({ file: false, keys: [], secrets: [] }, schema), 'Nothing was saved, so nothing changed.');
});

test("Reset M5: the trace's line for plugin.reset counts what went and says the space it gave back", () => {
  assert.equal(traceSummary({ type: 'plugin.reset', data: { plugin: 'park', name: 'Park', settings: ['station'], otherSettings: 1, secrets: ['token'], otherSecrets: 0, bytes: 2048 } }), `Park · 2 settings, 1 secret · ${size(2048)}`);
  assert.equal(traceSummary({ type: 'plugin.reset', data: { plugin: 'web', name: 'Web tools', settings: [], otherSettings: 0, secrets: [], otherSecrets: 1, bytes: 0 } }), 'Web tools · 0 settings, 1 secret · 0 byte');
});

test("Reset M4: a Reset that fails on a full disk shows the storage-full card, as Remove does; any other failure says it wasn't reset", async () => {
  const { resetSettings } = await import('../../src/ui/screens/plugin.js');
  /** @type {any[]} */
  const cards = [];
  let renders = 0;
  const ctx = (/** @type {unknown} */ e) => ({ plugins: { reset: async () => { throw e; } }, notices: { card: (/** @type {any} */ c) => cards.push(c) }, go: () => {}, render: () => { renders++; } });
  await resetSettings(ctx(new StorageFullError()), { id: 'park', name: 'Park', settings: null });
  await resetSettings(ctx(new Error('The disk broke.')), { id: 'park', name: 'Park', settings: null });
  assert.deepEqual(cards.map((c) => [c.title, c.body]).slice(1), [["Park's settings weren't reset", 'The disk broke. Try again.']]);
  assert.equal(cards[0].title, "annai's storage is full");
  assert.equal(renders, 2);
});

test("the free-tier switch names who doesn't charge: the description's name for it, else the plugin's whole name", () => {
  assert.equal(freeTierLabel('Google', 'Google Gemini'), "This key is on the free tier (Google doesn't charge)");
  assert.equal(freeTierLabel(true, 'Hugging Face'), "This key is on the free tier (Hugging Face doesn't charge)");
});

test("Try this model's line counts every token a reply used: audio and images too", () => {
  const usage = { input: 100, cacheRead: 20, cacheWrite: 0, cacheWrite1h: 0, output: 10, reasoning: 4, audioIn: 50, image: 30, cacheReadAudio: 5, cacheReadImage: 0, audioOut: 0 };
  assert.equal(metaLine({ usage, cost: 0 }), '215 tokens · free');
});

test("localDay: a day in this device's own zone, not UTC's, for a backup's file name (the emulator pass: 17:10 on Oct 19 in California was named Oct 20)", () => {
  const was = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(localDay(Date.parse('2026-10-20T00:10:00Z')), '2026-10-19');
    assert.equal(localDay(Date.parse('2026-03-05T20:00:00Z')), '2026-03-05');
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});

test("Trace order: newest first by when an entry was written, so a simulated trip's future-dated events don't top it; older entries fall back to their event time", () => {
  const day = 86_400_000;
  const e = (/** @type {string} */ scope, /** @type {number} */ seq, /** @type {number} */ ts, /** @type {number | undefined} */ at) => ({ scope, seq, ts, at, type: 'x', actor: 'system' });
  const written = Date.parse('2026-10-20T12:00:00Z');
  // A simulation, run on the 20th, whose clock ran ahead by a week; then a real entry, written later.
  const sim = e('trip', 1, written + 7 * day, written);
  const real = e('me', 1, written + 3600_000, written + 3600_000);
  assert.deepEqual(newestFirst([sim, real], 10), [real, sim]);
  // Entries from before the field existed are ordered by their event time among themselves, and by it against the rest.
  const old1 = e('trip', 5, written - 2 * day, undefined);
  const old2 = e('trip', 6, written - day, undefined);
  assert.deepEqual(newestFirst([old1, sim, old2, real], 10), [real, sim, old2, old1]);
  // Ties go to the later entry, and the list is cut to the limit.
  const a = e('trip', 7, 5, 100);
  const b = e('trip', 8, 5, 100);
  assert.deepEqual(newestFirst([a, b], 1), [b]);
});

test('the announcer\'s line is in three parts, so only her words can carry a language: annai\'s label and the choices\' lead-in are not hers', () => {
  assert.deepEqual(announced('out.speak', '', '清水寺は朝6時に開きます。'), ['Shiori: ', '清水寺は朝6時に開きます。', '']);
  assert.deepEqual(announced('out.ask', '', 'Where?', ['Ramen', 'Sushi']), ['Shiori asks: ', 'Where?', ' Choices: Ramen, Sushi.']);
  assert.deepEqual(announced('out.show', 'Trail', 'Pfeiffer Falls'), ['Shiori (Trail): ', 'Pfeiffer Falls', '']);
  assert.deepEqual(announced('out.show', '', '', [], {}), ['Shiori: ', 'a card', '']);
  assert.deepEqual(announced('msg.user', '', 'Hello'), ['', '', '']);
  assert.deepEqual(announced('error', '', 'Her turn ended'), ['', 'Her turn ended', '']);
});

test('the announcer reads her lines as "Shiori: …": a spoken line, a card (a plugin\'s kind named as the plugin names it), a question or a card with its choices ("SHIORINepenthe" was the label run into the words)', () => {
  assert.equal(announcement('out.speak', '', "I'm checking."), "Shiori: I'm checking.");
  assert.equal(announcement('out.show', '', 'Nepenthe Open till 10 tonight.'), 'Shiori: Nepenthe Open till 10 tonight.');
  assert.equal(announcement('out.show', 'Trail', 'Trail: Pfeiffer Falls'), 'Shiori (Trail): Trail: Pfeiffer Falls');
  // A kind's name as the plugin wrote it: no case changed, " · " and all.
  assert.equal(announcement('out.show', 'SBB · Rail', 'Zurich to Bern'), 'Shiori (SBB · Rail): Zurich to Bern');
  assert.equal(announcement('out.show', 'iOS notes', 'Two notes'), 'Shiori (iOS notes): Two notes');
  assert.equal(announcement('out.ask', '', 'Where should we eat?', ['Ramen', 'Sushi']), 'Shiori asks: Where should we eat? Choices: Ramen, Sushi.');
  assert.equal(announcement('out.show', '', 'Dinner at 7.', ['Book it', 'Not now']), 'Shiori: Dinner at 7. Choices: Book it, Not now.');
  assert.equal(announcement('out.ask', '', 'Is that right?', []), 'Shiori asks: Is that right?');
  // A card with nothing to read says what it is.
  assert.equal(announcement('out.show', '', '', [], { image: '/trip/files/menu.jpg' }), 'Shiori: a photo');
  assert.equal(announcement('out.show', '', '', [], {}), 'Shiori: a card');
  // Anything else is as written; what you typed and the halves' notes are not announced.
  assert.equal(announcement('reminder', '', 'Reminder: Leave at 5.'), 'Reminder: Leave at 5.');
  assert.equal(announcement('msg.user', '', 'Hello'), '');
  assert.equal(announcement('note', '', 'Koe to Kokoro: …'), '');
});

test("the price line says a change that is coming: from its date, the price then", () => {
  const doubling = { input: 0.75, output: 3.75, schedule: [{ from: '2027-01-01', input: 1.5, output: 7.5 }] };
  assert.equal(priceLine(doubling, Date.parse('2026-10-23T00:00:00Z')), '$0.75 in, $3.75 out per million tokens (from 2027-01-01: $1.5 in, $7.5 out)');
  assert.equal(priceLine(doubling, Date.parse('2027-01-01T00:00:00Z')), '$1.5 in, $7.5 out per million tokens', 'no hint once it is in force');
  // A change that leaves what the line says as it is has no hint, and a schedule that is no list none either.
  assert.equal(priceLine({ input: 1, output: 4, schedule: [{ from: '2027-01-01', cacheRead: 0.1 }] }, Date.parse('2026-10-23T00:00:00Z')), '$1 in, $4 out per million tokens');
  assert.equal(priceLine(/** @type {any} */ ({ input: 1, output: 4, schedule: 'later' }), Date.parse('2026-10-23T00:00:00Z')), '$1 in, $4 out per million tokens');
  const voice = { perMillionChars: 15, schedule: [{ from: '2027-01-01', perMillionChars: 30 }] };
  assert.equal(priceLine(voice, Date.parse('2026-10-23T00:00:00Z')), '$15 per million characters (from 2027-01-01: $30)');
});
