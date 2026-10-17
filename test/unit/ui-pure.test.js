import { test } from 'node:test';
import { isArchiveName } from '../../src/ui/import-state.js';
import assert from 'node:assert/strict';
import { parseHash } from '../../src/ui/router.js';
import { relTime, bytes, dateRange, takenText, backupText, formatCost, outcomeText, bookingLines } from '../../src/ui/format.js';
import { explainStorageFull } from '../../src/ui/storage-full.js';
import { StorageFullError } from '../../src/core/errors.js';
import { nextBlinkMs } from '../../src/ui/avatar.js';
import { parseMarkdown, parseInline, MD_MAX } from '../../src/ui/markdown.js';
import { mapsUrl, tripPath } from '../../src/ui/cards.js';
import { follow } from '../../src/ui/screens/talk.js';
import { visibleRegion } from '../../src/ui/photo-viewer.js';
import { traceSummary } from '../../src/ui/screens/trace.js';
import { micProblem } from '../../src/ui/mic-help.js';
import { priceLine } from '../../src/ui/screens/endpoint.js';
import { mediaKeys } from '../../src/ui/media-keys.js';

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
  assert.equal(traceSummary({ type: 'state', data: { live: 'on' } }), 'live mode on');
  assert.equal(traceSummary({ type: 'state', data: { voice: 'on', why: 'moving' } }), 'voice on (moving)');
});
