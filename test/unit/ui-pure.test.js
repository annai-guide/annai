import { test } from 'node:test';
import { isArchiveName, takePendingImport, leaveSignal, toldIfLeft } from '../../src/ui/import-state.js';
import assert from 'node:assert/strict';
import { parseHash, redirectOf } from '../../src/ui/router.js';
import { planRows } from '../../src/core/plan.js';
import { checkOf, checkWords } from '../../src/core/bookings.js';
import { relTime, size, dateRange, backupText, formatCost, outcomeText, bookingFacts, checkCount, placeStatus, holdNote, newerText, placeHref, limitFromField, limitField, limitText, localDay, fileLine, recordHref, talkHref } from '../../src/ui/format.js';
import { explainStorageFull, explainNotice } from '../../src/ui/storage-full.js';
import { tellNotOpen } from '../../src/ui/open-trip.js';
import { StorageFullError } from '../../src/core/errors.js';
import { nextBlinkMs } from '../../src/ui/avatar.js';
import { parseMarkdown, parseInline, MD_MAX } from '../../src/core/markdown.js';
import { mapsUrl, tripPath } from '../../src/ui/cards.js';
import { follow, announced, wokeText, wokeTitles, reminderParts, movedWords, wentWords, settled, undoneWords } from '../../src/ui/screens/talk.js';
import { visibleRegion } from '../../src/ui/photo-viewer.js';
import { traceSummary, newestFirst } from '../../src/ui/screens/trace.js';
import { micProblem } from '../../src/ui/mic-help.js';
import { priceLine, freeTierLabel, releasesAtAddress } from '../../src/ui/screens/provider.js';
import { metaLine } from '../../src/ui/talk-panel.js';
import { mediaKeys } from '../../src/ui/media-keys.js';
import { restoreFrom } from '../../src/ui/auto-backup.js';
import { packWords, downloadedWhen } from '../../src/ui/offline-pack.js';
import { liveText, knownFix } from '../../src/ui/live-chip.js';
import { roadText } from '../../src/ui/screens/drive.js';
import { cameFrom } from '../../src/ui/screens/file.js';
import { afterDelete, countParts } from '../../src/ui/file-delete.js';
import { addedWords } from '../../src/ui/bring-in.js';

/** @param {Parameters<typeof announced>} a */
const announcement = (...a) => announced(...a).join('');

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
  assert.equal(size(512), '512 bytes');
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

test('the conversation has an address', () => {
  assert.equal(parseHash('#/trip/trip-a/talk').name, 'talk');
  assert.deepEqual(parseHash('#/trip/trip-a/talk').parts, ['trip', 'trip-a', 'talk']);
  assert.equal(talkHref('trip-a'), '#/trip/trip-a/talk');
  assert.deepEqual(parseHash(talkHref('trip a/b')).parts, ['trip', 'trip a/b', 'talk']);
});

test("#/talk and #/plan go to the open conversation's address (the draft's too), and home with none open; #/talk/me is never redirected", () => {
  assert.equal(redirectOf(parseHash('#/talk'), 'trip-a'), '#/trip/trip-a/talk');
  assert.equal(redirectOf(parseHash('#/plan'), 'trip-a'), '#/trip/trip-a/plan');
  assert.equal(redirectOf(parseHash('#/talk'), null), '#/trips');
  assert.equal(redirectOf(parseHash('#/plan'), null), '#/trips');
  assert.equal(redirectOf(parseHash('#/talk/me'), 'trip-a'), null);
  assert.equal(redirectOf(parseHash('#/talk/me'), null), null);
  assert.equal(redirectOf(parseHash('#/trip/trip-b/talk'), 'trip-a'), null);
  assert.equal(redirectOf(parseHash('#/trip/trip-b/plan'), 'trip-a'), null);
  assert.equal(redirectOf(parseHash('#/trips'), 'trip-a'), null);
});

test("#/now (Now went in timeline stage 8) goes to today's Itinerary of the trip in play, else home; with no options, home", () => {
  assert.equal(redirectOf(parseHash('#/now'), 'trip-a', { play: 'trip-b' }), '#/trip/trip-b/plan'); // the trip in play, not the open one
  assert.equal(redirectOf(parseHash('#/now'), 'trip-a', { play: 'trip a/b' }), '#/trip/trip%20a%2Fb/plan');
  assert.equal(redirectOf(parseHash('#/now'), 'trip-a', { play: null }), '#/trips');
  assert.equal(redirectOf(parseHash('#/now'), 'trip-a'), '#/trips');
  assert.equal(redirectOf(parseHash('#/now?x=1'), null, { play: 'trip-b' }), '#/trip/trip-b/plan');
  // The trip in play changes nothing else.
  assert.equal(redirectOf(parseHash('#/talk'), 'trip-a', { play: 'trip-b' }), '#/trip/trip-a/talk');
  assert.equal(redirectOf(parseHash('#/plan'), 'trip-a', { play: 'trip-b' }), '#/trip/trip-a/plan');
  assert.equal(redirectOf(parseHash('#/trips'), 'trip-a', { play: 'trip-b' }), null);
});

test("the storage card leads with the device's own Settings, by the device: an iPhone's, an Android phone's, any other's; removing a trip makes room in annai only where a delete works on a full disk (not on an iPhone or iPad, in desktop mode too), and \"Go to Trips\" is offered where that is said; deleting inside one isn't offered (spec §4.9, §17)", () => {
  const MAKES_ROOM = ' Removing a trip you no longer need also makes room in annai (back it up first).';
  /** @type {[string, number, string, string][]} the device's user agent, its touch points, what the card says to free up space, and what it adds */
  const devices = [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1', 5, 'on this iPhone in Settings → General → iPhone Storage', ''],
    ['Mozilla/5.0 (Linux; Android 16; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36', 5, 'on this phone in Settings → Storage', MAKES_ROOM],
    ['Mozilla/5.0 (iPad; CPU OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1', 5, 'on this device', ''],
    // An iPad in desktop mode says it is a Mac, with a touch screen: a Mac has none.
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15', 5, 'on this device', ''],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15', 0, 'on this device', MAKES_ROOM],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 0, 'on this device', MAKES_ROOM],
  ];
  try {
    for (const [agent, touch, where, more] of devices) {
      Object.defineProperty(navigator, 'userAgent', { value: agent, configurable: true });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: touch, configurable: true });
      /** @type {any[]} */
      const cards = [];
      assert.equal(explainStorageFull({ notices: { card: (/** @type {any} */ c) => cards.push(c) && (() => {}) }, go: () => {} }, new StorageFullError()), true);
      assert.equal(cards.length, 1);
      assert.equal(cards[0].title, "There's no room left");
      assert.equal(cards[0].body, `Free up space ${where}, then try again.${more}`, agent);
      assert.doesNotMatch(cards[0].body, /delet/i);
      // Export stays, but isn't the first thing to do: on a full phone a backup file needs as much room again. Trips, where a removal is said.
      assert.deepEqual(cards[0].actions.map((/** @type {any} */ a) => [a.label, Boolean(a.primary)]), [['Export a backup', false], ...(more ? [['Go to Trips', false]] : [])], agent);
    }
  } finally {
    delete (/** @type {any} */ (navigator)).userAgent; // Node's own, from its prototype, again
    delete (/** @type {any} */ (navigator)).maxTouchPoints;
  }
  // What a model reads (a tool's result, in English) and what the backup, archive and update messages show say the same, for any device, with no claim that holds for some only.
  assert.equal(new StorageFullError().shown, "There's no room left. Free up space on this device, then try again.");
  assert.equal(new StorageFullError().message, new StorageFullError().shown);
  assert.equal(explainStorageFull({ notices: { card: () => assert.fail('no card') }, go: () => {} }, new DOMException('The transaction was aborted.', 'AbortError')), false);
});

test('the storage card says first what the caller did not do or what became of a typed line, suggests no removal after one was refused; a card replaces only one that says the same, and an error gets one card', () => {
  /** @type {{ card: any, off: boolean }[]} */
  const up = [];
  const ctx = { notices: { card: (/** @type {any} */ card) => { const c = { card, off: false }; up.push(c); return () => { c.off = true; }; } }, go: () => {} };
  const body = (/** @type {number} */ i) => up[i].card.body;
  const off = () => up.map((c) => c.off);
  explainStorageFull(ctx, new StorageFullError(), { said: 'Nothing was removed.', removal: false });
  assert.equal(body(0), 'Nothing was removed. Free up space on this device, then try again.', 'after a refused removal: none is suggested');
  assert.deepEqual(up[0].card.actions.map((/** @type {any} */ a) => a.label), ['Export a backup']);
  explainStorageFull(ctx, new StorageFullError(), { said: "Your message is back in the box." });
  assert.match(body(1), /^Your message is back in the box\. Free up space on this device, then try again\. Removing a trip .* \(back it up first\)\.$/);
  assert.deepEqual(off(), [false, false], 'a card that says something else stays beside it');
  // The same words again (another refusal of a line sent again on a full phone): one card, the new one.
  const typed = new StorageFullError();
  explainStorageFull(ctx, typed, { said: 'Your message is back in the box.' });
  assert.deepEqual(off(), [false, true, false]);
  // The same refusal comes by another way (the turn that stopped on it): its card is up; no second one, and the first stays.
  assert.equal(explainStorageFull(ctx, typed, { said: 'Shiori stopped' }), true);
  assert.equal(up.length, 3);
  assert.deepEqual(off(), [false, true, false]);
  // No said, as a caller with nothing to add: the steps alone, and again alone replaces it.
  explainStorageFull(ctx, new StorageFullError());
  explainStorageFull(ctx, new StorageFullError());
  assert.deepEqual(off(), [false, true, false, true, false]);
});

test("a card the agent made whose error is a full phone's shows the storage card in its place, with its title first, or its own words; any other error shows none (main.js)", () => {
  /** @type {any[]} */
  const cards = [];
  const ctx = { notices: { card: (/** @type {any} */ c) => { cards.push(c); return () => {}; } }, go: () => {} };
  assert.equal(explainNotice(ctx, { title: 'Shiori stopped', error: new StorageFullError() }), true);
  assert.match(cards[0].body, /^Shiori stopped\. Free up space/);
  assert.equal(explainNotice(ctx, { title: "A photo wasn't sent to Shiori", said: "A photo wasn't sent to Shiori. The message went without it.", error: new StorageFullError() }), true);
  assert.match(cards[1].body, /^A photo wasn't sent to Shiori\. The message went without it\. Free up space/);
  assert.equal(explainNotice(ctx, { title: 'Shiori stopped', error: new Error('The disk broke.') }), false);
  assert.equal(explainNotice(ctx, { title: 'Shiori stopped' }), false);
  assert.equal(cards.length, 2);
});

test("a conversation that didn't open shows the storage card for a full phone, with that said first; any other failure says why (spec §17)", () => {
  /** @type {any[]} */
  const cards = [];
  const ctx = { notices: { card: (/** @type {any} */ c) => { cards.push(c); return () => {}; } }, go: () => {} };
  tellNotOpen(ctx, new StorageFullError());
  assert.equal(cards[0].title, "There's no room left");
  assert.match(cards[0].body, /^That conversation didn't open\. Free up space/);
  tellNotOpen(ctx, new Error('The disk broke.'));
  assert.deepEqual([cards[1].title, cards[1].body], ["That conversation didn't open", 'The disk broke.']);
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
  // Where a running turn takes a hand-over up (loop.js join): a wake record of the turn with the hand-over and no reasons.
  assert.equal(traceSummary(e('wake', { id: 'w-1', half: 'kokoro', meanwhile: true, reasons: [], handover: 'h-1' })), 'Kokoro · takes up the files handed over');
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
  emit(ev(2)); // one the log had, told only now (a reminder written while its conversation was being opened: Loop's #joinLate): drawn once
  emit(ev(5)); // the screen isn't on the page yet: still shown
  emit(ev(6, 'trip-2')); // another conversation's
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(shown, [1, 2, 3, 4, 5]);
  state = 'gone';
  emit(ev(7));
  assert.equal(fns.size, 0);
  assert.deepEqual(shown, [1, 2, 3, 4, 5]);
});

test("follow: an event that comes while an earlier one is still being drawn (a long line's text read apart) is drawn after it, not above it", async () => {
  /** @type {Set<(e: any) => void>} */
  const fns = new Set();
  const agent = { on: (/** @type {string} */ _kind, /** @type {(e: any) => void} */ fn) => { fns.add(fn); return () => fns.delete(fn); } };
  const ev = (/** @type {number} */ seq) => ({ seq, scope: 'trip-1', type: 'out.speak' });
  /** @type {number[]} */
  const drawn = [];
  await follow(agent, 'trip-1', {
    read: async () => [],
    show: async (e) => {
      if (e.seq === 1) await new Promise((r) => setTimeout(r, 30)); // the first waits for a stored text, the others for nothing
      drawn.push(e.seq);
    },
    state: () => 'shown',
  });
  for (const fn of fns) { fn(ev(1)); fn(ev(2)); fn(ev(3)); }
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(drawn, [1, 2, 3]);
});

test('follow: a line that fails to draw (its stored text unread) is reported, as any error is, and left out; the lines after it are drawn, read or live', async (t) => {
  /** @type {Set<(e: any) => void>} */
  const fns = new Set();
  const agent = { on: (/** @type {string} */ _kind, /** @type {(e: any) => void} */ fn) => { fns.add(fn); return () => fns.delete(fn); } };
  const ev = (/** @type {number} */ seq) => ({ seq, scope: 'trip-1', type: 'out.speak' });
  /** @type {number[]} */
  const reported = [];
  /** @type {any} */ (globalThis).reportError = (/** @type {any} */ x) => reported.push(x.seq); // the browser's; Node has none
  t.after(() => { delete (/** @type {any} */ (globalThis)).reportError; });
  /** @type {number[]} */
  const drawn = [];
  await follow(agent, 'trip-1', {
    read: async () => [ev(1), ev(2), ev(3)],
    show: async (e) => {
      if (e.seq === 2 || e.seq === 5) throw Object.assign(new Error('the stored text could not be read'), { seq: e.seq });
      drawn.push(e.seq);
    },
    state: () => 'shown',
  });
  for (const fn of fns) { fn(ev(4)); fn(ev(5)); fn(ev(6)); }
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(drawn, [1, 3, 4, 6]);
  assert.deepEqual(reported, [2, 5]);
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

const flightBooking = {
  id: 'f', kind: 'flight', status: 'unverified', source: '/files/flight.pdf', title: 'ANNAI AIR AN 123', confirmation: 'TESTQ1', unsure: ['seat'],
  start: { at: '2026-11-20T11:20:00-08:00', tz: 'America/Los_Angeles' }, end: { at: '2026-11-20T14:05:00-09:00', tz: 'America/Anchorage' },
  fields: { seat: '14C', airline: 'ANNAI AIR', to: 'Anchorage (ANC)', from: 'Seattle (SEA)', flight: 'AN 123', travellers: ['Sam', 'Alex'] },
};

test("bookingFacts: a flight reads from → to, departs and arrives in each airport's zone, then seat; unsure fields marked", () => {
  const f = bookingFacts(flightBooking);
  assert.deepEqual(f.map((x) => x.key), ['route', 'start', 'end', 'flight', 'airline', 'seat', 'travellers', 'confirmation']);
  assert.deepEqual(f.map((x) => x.label), ['Route', 'Departs', 'Arrives', 'Flight', 'Airline', 'Seat', 'Travellers', 'Confirmation']);
  assert.equal(f[0].value, 'Seattle (SEA) → Anchorage (ANC)');
  assert.match(f[1].value, /^Fri, Nov 20, 11:20\sAM \(PT\)$/);
  assert.match(f[2].value, /^Fri, Nov 20, 2:05\sPM \(AKT\)$/);
  assert.equal(f.find((x) => x.key === 'seat')?.unsure, true);
  assert.deepEqual(f.filter((x) => x.unsure).map((x) => x.key), ['seat']);
  assert.equal(f.find((x) => x.key === 'travellers')?.value, 'Sam and Alex');
  // Unsure of where it goes: the route is marked.
  assert.equal(bookingFacts({ ...flightBooking, unsure: ['to'] })[0].unsure, true);
});

test("bookingFacts: a train's and a ride's booking departs and arrives, as a flight's does, each time in its own zone; a stay checks in and out, and anything else starts and ends (booking-next: a train's said Starts and Ends)", () => {
  const AKZ = 'America/Anchorage';
  const ride = (/** @type {string} */ kind) => ({ kind, status: 'unverified', unsure: ['end'], title: 'Night crossing', start: { at: '2026-11-20T19:00:00-08:00', tz: LA }, end: { at: '2026-11-21T07:00:00-09:00', tz: AKZ } });
  for (const kind of ['flight', 'rail', 'ferry', 'bus', 'coach']) {
    const f = bookingFacts(ride(kind));
    assert.deepEqual(f.map((x) => [x.label, x.unsure]), [['Departs', false], ['Arrives', true]], kind);
    assert.match(f[0].value, /^Fri, Nov 20, 7:00\sPM \(PT\)$/, `${kind}: the departure in its own zone`);
    assert.match(f[1].value, /^Sat, Nov 21, 7:00\sAM \(AKT\)$/, kind);
  }
  for (const [kind, labels] of /** @type {[string, string[]][]} */ ([['lodging', ['Check-in', 'Check-out']], ['car', ['Starts', 'Ends']], ['event', ['Starts', 'Ends']], ['other', ['Starts', 'Ends']]])) {
    assert.deepEqual(bookingFacts(ride(kind)).map((x) => x.label).slice(0, 2), labels, kind);
  }
});

test("bookingFacts: the keys a booking's extras are written under most have words, as a person writing the booking says them: a bag allowance's checked and carry_on, a meal, rooms, and the names annai files itself (arrival, total, price), at the top or inside a value; any other key is still drawn as written (booking-next: they were drawn in English, \"checked: 2 · carry_on: 1\")", () => {
  const f = bookingFacts({ kind: 'flight', unsure: ['checked'], fields: { bags: { checked: 2, carry_on: 1, personal_item: 1 }, checked: '23 kg', carry_on: '7 kg', meal: 'vegetarian', rooms: 1, arrival: 'Osaka', total: 'about 120 USD', price: 'USD 12 a bag' } });
  assert.deepEqual(f.map((x) => [x.key, x.label, x.value, x.unsure, x.lang]), [
    ['bags', 'Bags', 'Checked bags: 2 · Carry-on: 1 · personal_item: 1', false, undefined],
    ['checked', 'Checked bags', '23 kg', true, undefined], ['carry_on', 'Carry-on', '7 kg', false, undefined], ['meal', 'Meal', 'vegetarian', false, undefined],
    ['rooms', 'Rooms', '1', false, undefined], ['arrival', 'Arrival', 'Osaka', false, undefined], ['total', 'Total', 'about 120 USD', false, undefined],
    ['price', 'Price', 'USD 12 a bag', false, undefined],
  ]);
  assert.equal(checkWords({ kind: 'flight', status: 'unverified', unsure: ['checked'], fields: { checked: '23 kg' } }), 'not sure the checked bags were read right');
});

test('bookingFacts: a flight whose from and to are not words keeps them as fields, never loses them (the review of seeing-bookings, R3)', () => {
  const f = bookingFacts({ kind: 'flight', unsure: [], fields: { from: { code: 'SEA', city: 'Seattle' }, to: { code: 'ANC', city: 'Anchorage' }, seat: '14D' } });
  assert.deepEqual(f.map((x) => x.key), ['seat', 'from', 'to']);
  assert.match(f[1].value, /SEA.*Seattle/);
  // One in words goes in the route; the other stays a field.
  assert.deepEqual(bookingFacts({ kind: 'flight', unsure: [], fields: { from: 'Seattle (SEA)', to: { code: 'ANC' } } }).map((x) => [x.key, x.value]), [['route', 'Seattle (SEA)'], ['to', 'code: ANC']]);
});

test("bookingFacts: an old unverified booking (no unsure key) has a check on every detail it draws, as a new one has on its unsure ones; an old confirmed one, unsure: [] and a blank value have none (booking-say's round 4)", () => {
  const at = { at: '2026-11-20T11:20:00-08:00', tz: 'America/Los_Angeles' };
  const marked = (/** @type {any} */ b) => bookingFacts(b).filter((x) => x.unsure).map((x) => x.key);
  const old = { kind: 'flight', status: 'unverified', title: 'ANNAI AIR AN 123', start: at, end: at, confirmation: 'TESTQ1', fields: { from: 'Seattle (SEA)', to: 'Anchorage (ANC)', seat: '14C', gate: '  ', bags: null } };
  // Every line the details draw for it has a check: the Route (from and to), the times, the seat, the confirmation; the blank gate and the null bags
  // are no lines (a value that is not there is never drawn: "null" is not words).
  assert.deepEqual(bookingFacts(old).map((x) => x.key), ['route', 'start', 'end', 'seat', 'confirmation']);
  assert.deepEqual(marked(old), ['route', 'start', 'end', 'seat', 'confirmation']);
  assert.deepEqual(marked({ ...old, status: 'confirmed' }), [], 'an old confirmed one: none');
  assert.deepEqual(marked({ ...old, unsure: [] }), [], 'unsure: []: none');
  assert.deepEqual(marked({ ...old, unsure: ['end'] }), ['end'], 'a new one: just what it names');
  assert.deepEqual(marked({ ...old, status: 'pending' }), ['route', 'start', 'end', 'seat', 'confirmation'], 'any status but confirmed');
  // A stay: the place, the times and the confirmation are marked too (its name is the heading's, which checkCount adds).
  const stay = { kind: 'lodging', status: 'unverified', title: 'Hotel Aurora Test', start: at, end: at, place: { name: 'Hotel Aurora Test' }, confirmation: 'TQ1' };
  assert.deepEqual(marked(stay), ['place', 'start', 'end', 'confirmation']);
});

test("bookingFacts: a detail whose value is null or blank is no line, as checkOf marks no part there; a nights that is not there leaves the computed one (words-next)", () => {
  const at = (/** @type {string} */ iso) => ({ at: iso, tz: 'America/Los_Angeles' });
  const flight = { kind: 'flight', unsure: [], fields: { terminal: null, gate: '  ', bags: '', seat: '14C', wifi: null, from: '', to: null } };
  assert.deepEqual(bookingFacts(flight).map((x) => [x.key, x.value]), [['seat', '14C']]);
  assert.equal(JSON.stringify(bookingFacts(flight)).includes('null'), false);
  // Zero and false are values; a line is drawn for them.
  assert.deepEqual(bookingFacts({ kind: 'flight', unsure: [], fields: { bags: 0, wifi: false } }).map((x) => [x.key, x.value]), [['bags', '0'], ['wifi', 'false']]);
  const stay = { kind: 'lodging', unsure: [], start: at('2026-11-20T15:00:00-08:00'), end: at('2026-11-22T11:00:00-08:00'), fields: { nights: null, room: null } };
  assert.deepEqual(bookingFacts(stay).filter((x) => x.key === 'nights').map((x) => x.value), ['2'], 'a null nights is not hers: the computed count shows');
  assert.equal(bookingFacts(stay).some((x) => x.key === 'room'), false);
  // What the Plan's chip counts is what is drawn: nothing for a value that is not there.
  assert.equal(checkCount({ kind: 'flight', status: 'unverified', fields: { terminal: null, seat: '14C' } }), 1);
});

test('bookingFacts: text of only spaces and an empty list are not there, as null is not: no blank Route, Place or Confirmation line, no blank detail, no check on one (words-next)', () => {
  const labels = (/** @type {any} */ b) => bookingFacts(b).map((x) => [x.key, x.value]);
  // A route of blank parts has no line; one blank part leaves the other.
  assert.deepEqual(labels({ kind: 'flight', unsure: [], fields: { from: '  ', to: '  ' } }), []);
  assert.deepEqual(labels({ kind: 'flight', unsure: ['from', 'to'], fields: { from: '  ', to: 'Osaka' } }), [['route', 'Osaka']]);
  // A place with a blank name has no line, and a blank address is not added after a name.
  assert.deepEqual(labels({ kind: 'lodging', unsure: [], place: { name: '  ' } }), []);
  assert.deepEqual(labels({ kind: 'lodging', unsure: [], place: { name: 'Hotel Aurora Test', address: '  ' } }), [['place', 'Hotel Aurora Test']]);
  assert.deepEqual(labels({ kind: 'lodging', unsure: [], confirmation: '  ' }), []);
  // An empty list is no detail either (travellers: []), and no check lands on it.
  assert.deepEqual(labels({ kind: 'flight', unsure: ['travellers'], fields: { travellers: [], seat: '14C' } }), [['seat', '14C']]);
  assert.deepEqual(bookingFacts({ kind: 'flight', status: 'unverified', fields: { travellers: [], seat: '14C' } }).filter((x) => x.unsure).map((x) => x.key), ['seat']);
  assert.equal(checkCount({ kind: 'flight', status: 'unverified', fields: { travellers: [], seat: '14C' } }), 1);
  // A list with something in it still draws.
  assert.deepEqual(labels({ kind: 'flight', unsure: [], fields: { travellers: ['A', 'B'] } }), [['travellers', 'A and B']]);
});

test("bookingFacts: a list is there when one of its items is, and draws only those; a place with no name draws its address alone; what is checked is what is drawn (small-next)", () => {
  const drawn = (/** @type {any} */ b) => bookingFacts(b).map((x) => [x.key, x.value, x.unsure]);
  // An old unverified booking marks every part it has (checkOf): a list of blank or null items is no part, so it has no line and no check.
  for (const travellers of [[''], [null], ['  ', null]]) {
    const b = { kind: 'flight', status: 'unverified', fields: { travellers, seat: '14C' } };
    assert.deepEqual(drawn(b), [['seat', '14C', true]], JSON.stringify(travellers));
    assert.deepEqual(checkOf(b), { fields: ['seat'] }, JSON.stringify(travellers));
    assert.equal(checkCount(b), 1, JSON.stringify(travellers));
  }
  // A list with something in it draws only that: no "A and " after a blank item, no "null".
  assert.deepEqual(drawn({ kind: 'flight', status: 'unverified', fields: { travellers: ['A', ''] } }), [['travellers', 'A', true]]);
  assert.deepEqual(drawn({ kind: 'flight', status: 'unverified', fields: { travellers: ['A', null, ' ', 'B'] } }), [['travellers', 'A and B', true]]);
  // A place named only with spaces draws its address, and its check is on that line, as Shiori is told of it.
  const stay = (/** @type {any} */ place) => ({ kind: 'lodging', status: 'unverified', place });
  assert.deepEqual(drawn(stay({ name: '  ', address: '1 Test Street' })), [['place', '1 Test Street', true]]);
  assert.deepEqual(checkOf(stay({ name: '  ', address: '1 Test Street' })), { fields: ['place'] });
  assert.equal(checkCount(stay({ name: '  ', address: '1 Test Street' })), 1);
  // With no address either, it is no place: no line, and nothing to check.
  for (const place of [{ name: '  ' }, { name: '  ', address: ' ' }]) {
    assert.deepEqual(drawn(stay(place)), [], JSON.stringify(place));
    assert.deepEqual(checkOf(stay(place)), { fields: [] }, JSON.stringify(place));
  }
  // A name that is a copy of the address (annai names a place from its address) is said once.
  assert.deepEqual(drawn(stay({ name: '1 Test Street', address: '1 Test Street' })), [['place', '1 Test Street', true]]);
});

// How a flight's legs are stored (unalias: booking-aliases.test.js, "a flight's legs"): a list of objects in fields.flights, kept as written.
const TOKYO = 'Asia/Tokyo';
const LA = 'America/Los_Angeles';
/** A range's dash is held to the clock after it (U+2060), so a line can't break between them. */
const DASH = '–⁠';
const legs = [
  { flight: 'AN 1', origin: 'HND', destination: 'ITM', departure: '2026-11-20T07:30', arrival: '2026-11-20T09:10', tz: TOKYO },
  { flight: 'AN 2', origin: 'ITM', destination: 'NRT', departure: '2026-11-20T11:30', arrival: { at: '2026-11-20T13:05', tz: TOKYO } },
];
const twoLegs = {
  kind: 'flight', status: 'unverified', unsure: ['flights'], fields: { flights: legs },
  start: { at: '2026-11-20T07:30:00+09:00', tz: TOKYO }, end: { at: '2026-11-20T13:05:00+09:00', tz: TOKYO },
};
/** What a booking's fields.flights draws, line by line. @param {any[]} flights @param {any} [more] */
const legLines = (flights, more = {}) => bookingFacts({ kind: 'flight', unsure: [], fields: { flights }, ...more }).find((x) => x.key === 'flights')?.value.split('\n');

test("bookingFacts: each leg of a flight's fields.flights is one line of words, its times as they are written and in no zone, never JSON; one check for the field (small-next, round 3: the round-2 test drew each time in the booking's format with a zone note, which a leg's time never names)", () => {
  const f = bookingFacts(twoLegs);
  const flights = f.find((x) => x.key === 'flights');
  assert.equal(f.find((x) => x.key === 'start')?.value, 'Fri, Nov 20, 7:30 AM (Japan Time)', "the booking's own Departs keeps its zone");
  assert.equal(flights?.label, 'Flights');
  // A leg's times are the string's own day and 24-hour clock (the Plan's rows draw a range so, "22:00–05:30"); one day and a later clock is one range.
  assert.deepEqual(flights?.value.split('\n'), [`AN 1 · HND → ITM · Nov 20 07:30${DASH}09:10`, `AN 2 · ITM → NRT · Nov 20 11:30${DASH}13:05`]);
  assert.equal(flights?.value.includes('{'), false, 'no JSON');
  assert.equal('zone' in (flights ?? {}), false, 'no zone note to keep whole: a leg claims no zone');
  assert.deepEqual(f.filter((x) => x.unsure).map((x) => x.key), ['flights']);
  assert.equal(checkCount(twoLegs), 1);
  // A time with no zone anywhere is drawn the same: its own digits.
  assert.deepEqual(legLines([{ flight: 'AN 9', departure: '2026-11-20T08:00' }]), ['AN 9 · Nov 20 08:00']);
});

test("bookingFacts: a leg's times are the same lines on a phone in any zone, written with a space or a T; none is read as an instant (the re-review of small-next's round 2, F1: a leg written \"2026-11-20 08:00\" read in the phone's zone drew \"Thu, Nov 19, 3:00 PM (PT)\" on a phone in Tokyo)", () => {
  const was = process.env.TZ;
  try {
    for (const zone of ['Asia/Tokyo', 'Europe/London', LA]) {
      process.env.TZ = zone;
      for (const [leaves, arrives] of [['2026-11-20 08:00', '2026-11-20 09:30'], ['2026-11-20T08:00', '2026-11-20T09:30'], [' 2026-11-20 08:00 ', { at: '2026-11-20 09:30', tz: LA }]]) {
        assert.deepEqual(legLines([{ flight: 'UA 1', origin: 'SFO', destination: 'LAX', departure: leaves, arrival: arrives, tz: LA }]), [`UA 1 · SFO → LAX · Nov 20 08:00${DASH}09:30`], `${zone}: ${JSON.stringify(leaves)}`);
      }
    }
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});

test("bookingFacts: a connection in a third zone draws no zone note on any leg: its times are the airports' own clocks, never the booking's zone (the re-review's F1 b: Denver's times were drawn \"(PT)\" and \"(ET)\")", () => {
  // SFO (PT) to BOS (ET) by way of Denver (MT): the booking's start is in PT and its end in ET; the legs carry no zone.
  const booking = { start: { at: '2026-11-20T08:00:00-08:00', tz: LA }, end: { at: '2026-11-20T18:20:00-05:00', tz: 'America/New_York' } };
  const lines = legLines([
    { flight: 'UA 1', origin: 'SFO', destination: 'DEN', departure: '2026-11-20T08:00', arrival: '2026-11-20T11:30' },
    { flight: 'UA 2', origin: 'DEN', destination: 'BOS', departure: '2026-11-20T12:30', arrival: '2026-11-20T18:20' },
  ], booking);
  assert.deepEqual(lines, [`UA 1 · SFO → DEN · Nov 20 08:00${DASH}11:30`, `UA 2 · DEN → BOS · Nov 20 12:30${DASH}18:20`]);
  assert.doesNotMatch(String(lines), /[(（]|PT|ET|MT/);
  // The shape booking-aliases.test.js stores (a leg's tz, an arrival's own { at, tz } in another zone): the same, no note.
  assert.deepEqual(legLines([
    { flight: 'UA 2', origin: 'SFO', destination: 'ORD', departure: '2026-11-20T10:00', arrival: '2026-11-20T16:00', tz: LA },
    { flight: 'AN 8', origin: 'ORD', destination: 'NRT', departure: '2026-11-20T18:00', arrival: { at: '2026-11-21T21:00', tz: TOKYO }, tz: 'America/Chicago' },
  ]), [`UA 2 · SFO → ORD · Nov 20 10:00${DASH}16:00`, 'AN 8 · ORD → NRT · Nov 20 18:00 – Nov 21 21:00']);
});

test("bookingFacts: a leg's range is compact only for one written day and a later clock; anything else is each time in full (a westbound flight's 09:30 is the same morning's, not the next)", () => {
  assert.deepEqual(legLines([
    { flight: 'JL 1', departure: '2026-11-21T17:00', arrival: '2026-11-21T09:30' }, // westbound across the date line: lands earlier on the clock, the same written day
    { flight: 'JL 2', departure: '2026-11-21T13:00', arrival: '2026-11-22T17:05' }, // arrives another day
    { flight: 'JL 3', departure: '2026-11-21T08:00', arrival: '2026-11-21T08:00' }, // the same clock
    { flight: 'JL 4', departure: '2026-11-21T08:00:00-08:00', arrival: '2026-11-21T11:30:00-05:00' }, // an offset: its own digits
    { flight: 'JL 5', departure: { at: '2026-11-21T16:00', tz: TOKYO }, arrival: { at: '2026-11-22T20:05', tz: LA } }, // { at, tz }: the digits of at
    { flight: 'JL 6', departure: '2026-11-21T08:00:30', arrival: '2026-11-21T08:45:59' }, // seconds are not drawn
  ]), [
    'JL 1 · Nov 21 17:00 – Nov 21 09:30',
    'JL 2 · Nov 21 13:00 – Nov 22 17:05',
    'JL 3 · Nov 21 08:00 – Nov 21 08:00',
    `JL 4 · Nov 21 08:00${DASH}11:30`,
    'JL 5 · Nov 21 16:00 – Nov 22 20:05',
    `JL 6 · Nov 21 08:00${DASH}08:45`,
  ]);
  // One side only: that side.
  assert.deepEqual(legLines([{ flight: 'AN 1', departure: '2026-11-21T08:00' }, { flight: 'AN 2', arrival: '2026-11-21T09:00' }]), ['AN 1 · Nov 21 08:00', 'AN 2 · Nov 21 09:00']);
});

test("bookingFacts: a leg time in UTC (a Z) is drawn as the text, since its clock is not the airport's; words and text that is no date are drawn as written too (small-next, round 3)", () => {
  assert.deepEqual(legLines([
    { flight: 'AN 1', departure: '2026-11-20T16:00:00Z', arrival: '2026-11-20T18:00' }, // one side UTC: that side as written, the other drawn
    { flight: 'AN 2', departure: '2026-11-20T16:00:00Z', arrival: { at: '2026-11-20T19:00:00Z', tz: TOKYO } }, // both UTC
    { flight: 'AN 3', departure: 'morning', arrival: '2026-11-20T09:10' },
    { flight: 'AN 4', departure: 'Nov 20 2026 07:30', arrival: '2026-11-31T08:00' }, // no such day (Date.parse would read it as Dec 1)
    { flight: 'AN 5', departure: '2026-11-20T25:00', arrival: '2026-11-20T08:61' },
  ]), [
    'AN 1 · 2026-11-20T16:00:00Z – Nov 20 18:00',
    'AN 2 · 2026-11-20T16:00:00Z – at: 2026-11-20T19:00:00Z · tz: Asia/Tokyo',
    'AN 3 · morning – Nov 20 09:10',
    'AN 4 · Nov 20 2026 07:30 – 2026-11-31T08:00',
    'AN 5 · 2026-11-20T25:00 – 2026-11-20T08:61',
  ]);
});

test("bookingFacts: a leg time written as an object with more in it than its time and zone (the Amadeus shape: an airport, a terminal) draws the rest beside its clock, in brackets with its labels, and never as a compact range (booking-next: small-next drew \"NH 7 · Nov 20 11:05 – Nov 21 15:40\", the airports and terminals left out)", () => {
  // The re-review's shape: the airports only inside departure and arrival, the leg's tz beside them.
  const amadeus = { flight: 'NH 7', departure: { iataCode: 'SFO', terminal: 'I', at: '2026-11-20T11:05' }, arrival: { iataCode: 'NRT', terminal: '1', at: '2026-11-21T15:40', tz: TOKYO }, tz: LA };
  assert.deepEqual(legLines([amadeus]), ['NH 7 · Nov 20 11:05 (iataCode: SFO · Terminal: I) – Nov 21 15:40 (iataCode: NRT · Terminal: 1)']);
  // { time } with a gate; one side only; a time's own zone is no more (it claims nothing); null and blank values draw nothing.
  assert.deepEqual(legLines([
    { flight: 'AN 1', departure: { airport: 'HND', time: '2026-11-20T07:30', gate: 'G92', tz: TOKYO, note: ' ', seat: null }, arrival: '2026-11-20T09:10' },
    { flight: 'AN 2', departure: { at: '2026-11-20T11:30', tz: TOKYO }, arrival: { at: '2026-11-20T13:05', tz: TOKYO, gate: null } },
    { flight: 'AN 3', arrival: { at: '2026-11-20T15:00', terminal: '2' } },
  ]), [
    'AN 1 · Nov 20 07:30 (airport: HND · Gate: G92) – Nov 20 09:10', // one side has more: each in full, no compact range
    `AN 2 · Nov 20 11:30${DASH}13:05`, // nothing more beside either: the compact range, as before
    'AN 3 · Nov 20 15:00 (Terminal: 2)',
  ]);
  // A time key beside the one read is drawn too (nothing she wrote is dropped); an object whose time can't be read is drawn whole, as written.
  assert.deepEqual(legLines([
    { flight: 'AN 4', departure: { at: '2026-11-20T08:00', time: '08:00' } },
    { flight: 'AN 5', departure: { iataCode: 'HND', at: 'morning' }, arrival: { iataCode: 'ITM', at: '2026-11-20T09:10:00Z' } },
  ]), ['AN 4 · Nov 20 08:00 (time: 08:00)', 'AN 5 · iataCode: HND · at: morning – iataCode: ITM · at: 2026-11-20T09:10:00Z']);
  // The check is the field's, once, as for any leg.
  const b = { kind: 'flight', status: 'unverified', unsure: ['flights'], fields: { flights: [amadeus] } };
  assert.deepEqual([bookingFacts(b).filter((f) => f.unsure).length, checkCount(b)], [1, 1]);
});

test("bookingFacts: a leg draws only what is there: no null, no blank; every other value has its label (annai's word where it has one, else the key as written); a lone leg object is a leg; an object that is no leg is one line with its keys (small-next, round 3: round 2 drew values without their keys, \"Bags: 2 and 1\")", () => {
  const drawn = (/** @type {any} */ fields) => bookingFacts({ kind: 'flight', status: 'unverified', fields }).map((x) => [x.key, x.value, x.unsure]);
  // A null gate and a blank seat: no "null", no empty part.
  assert.deepEqual(drawn({ flights: [{ flight: 'AN 1', gate: null, seat: '  ', from: 'Tokyo' }] }), [['flights', 'AN 1 · Tokyo', true]]);
  // Extras with their labels, in the order written; a leg with only blanks is no line.
  assert.deepEqual(drawn({ flights: [{ flight: 'UA 2', origin: 'DEN', destination: 'BOS', departure: '2026-11-20T12:30', arrival: '2026-11-20T18:20', terminal: 'B', gate: 'M12', seat: '14C', meal: 'vegetarian', stops: 0, wifi: false }, { gate: null }] }),
    [['flights', `UA 2 · DEN → BOS · Nov 20 12:30${DASH}18:20 · Terminal: B · Gate: M12 · Seat: 14C · Meal: vegetarian · stops: 0 · wifi: false`, true]]);
  // A leg that is only a zone draws it (no blank row, nothing she wrote unseen); with times it is their zone, which they don't name.
  assert.deepEqual(drawn({ flights: [{ tz: TOKYO }] }), [['flights', 'tz: Asia/Tokyo', true]]);
  assert.deepEqual(drawn({ flights: [{ flight: 'AN 1' }, { tz: TOKYO }] }), [['flights', 'AN 1\ntz: Asia/Tokyo', true]]);
  assert.deepEqual(drawn({ flights: [{ flight: 'AN 1', departure: '2026-11-20T08:00', tz: TOKYO }] }), [['flights', 'AN 1 · Nov 20 08:00', true]]);
  // A lone leg in a field is a leg, as written in a list.
  assert.deepEqual(drawn({ flight: { flight: 'AN 1', origin: 'HND', destination: 'ITM', departure: '2026-11-20T07:30', arrival: '2026-11-20T09:10' } }), [['flight', `AN 1 · HND → ITM · Nov 20 07:30${DASH}09:10`, true]]);
  // A list of other objects is one line each; a list of strings stays a list.
  assert.deepEqual(drawn({ travellers: [{ name: 'Sam', age: 30 }, { name: 'Alex' }] }), [['travellers', 'name: Sam · age: 30\nname: Alex', true]]);
  assert.deepEqual(drawn({ travellers: ['Sam', 'Alex'] }), [['travellers', 'Sam and Alex', true]]);
  assert.equal(JSON.stringify(drawn({ flights: [{ flight: 'AN 1', gate: null, from: 'Tokyo' }] })).includes('null'), false);
});

test("bookingFacts: an object that is no leg is one line, each value with its key, never JSON (small-next, round 3: round 2 drew \"Test Air and 1234\", values without keys)", () => {
  const drawn = (/** @type {any} */ fields) => bookingFacts({ kind: 'flight', unsure: [], fields }).map((x) => [x.key, x.value]);
  assert.deepEqual(drawn({ gate: { name: 'B', open: null } }), [['gate', 'name: B']]);
  assert.deepEqual(drawn({ wifi: { network: 'Test Air', code: '1234', note: ' ' } }), [['wifi', 'network: Test Air · code: 1234']]);
  assert.deepEqual(drawn({ bags: { checked: 2, carry_on: 1 } }), [['bags', 'Checked bags: 2 · Carry-on: 1']]);
  assert.deepEqual(drawn({ from: { code: 'SEA', city: 'Seattle' }, to: { code: 'ANC' }, seat: '14D' }).map((x) => x[1]), ['14D', 'code: SEA · city: Seattle', 'code: ANC']);
  // A number or a flag inside is a value too; a cost written as an object keeps its keys.
  assert.deepEqual(drawn({ gate: { name: 'B', bags: 2, open: false } }), [['gate', 'name: B · Bags: 2 · open: false']]);
});

test("bookingFacts: a field named like one of the booking's own parts is no second line when the part drew its line, whatever it holds, and is the part's line, as written, when the part drew none; the name beside the heading that says something else is a line under \"Name\"; what is checked is what is drawn (booking-next fix 3: the rule is main's again, a field that says something else is hidden beside a drawn part, as it was before the branch)", () => {
  const at = { at: '2026-11-20T15:00:00-08:00', tz: LA };
  const own = { title: 'Hotel X', start: at, end: at, place: { name: 'Hotel X', address: '1 Test Street' }, confirmation: 'TQ1', cost: { amount: 120, currency: 'USD' } };
  // The same text as each part's line (spaces at the ends aside): one line each, one check each, and the name is the heading's alone.
  const sameFields = { title: ' Hotel X', start: 'Fri, Nov 20, 3:00 PM (PT)', end: 'Fri, Nov 20, 3:00 PM (PT) ', place: 'Hotel X, 1 Test Street', confirmation: 'TQ1', cost: '$120.00' };
  const same = { kind: 'lodging', status: 'unverified', ...own, fields: { ...sameFields, room: '204' } };
  assert.deepEqual(bookingFacts(same).map((x) => [x.key, x.label, x.value]), [['place', 'Place', 'Hotel X, 1 Test Street'], ['start', 'Check-in', 'Fri, Nov 20, 3:00 PM (PT)'],
    ['end', 'Check-out', 'Fri, Nov 20, 3:00 PM (PT)'], ['room', 'Room', '204'], ['confirmation', 'Confirmation', 'TQ1'], ['cost', 'Cost', '$120.00']]);
  assert.equal(checkCount(same), checkOf(same).fields.length, "an old booking: the heading's check and one by each line, one for each part she is told of");
  // Something else, beside a part that drew: not drawn, as on main (the record keeps it and Shiori reads it). The part's line is the only one, with the part's check
  // (marked or not), and the chip counts that one.
  const conf = { kind: 'flight', status: 'unverified', unsure: ['confirmation'], confirmation: 'ABC123', fields: { confirmation: 'XYZ789 (e-ticket)' } };
  assert.deepEqual(bookingFacts(conf).map((x) => [x.key, x.label, x.value, x.unsure]), [['confirmation', 'Confirmation', 'ABC123', true]]);
  assert.equal(checkCount(conf), 1);
  assert.equal(checkWords(conf), 'not sure the confirmation number was read right');
  assert.deepEqual(bookingFacts({ ...conf, unsure: [] }).map((x) => [x.key, x.value, x.unsure]), [['confirmation', 'ABC123', false]], 'not marked: the part\'s line alone, no check');
  assert.equal(checkCount({ ...conf, unsure: [] }), 0);
  const alsoFields = { title: 'Hotel X', start: 'tomorrow', end: 'later', place: 'Hotel X', confirmation: 'TQ1', cost: 'about 120 dollars' };
  const both = { kind: 'lodging', status: 'unverified', ...own, fields: { ...alsoFields, room: '204' } };
  assert.deepEqual(bookingFacts(both).map((x) => [x.key, x.value]), [['place', 'Hotel X, 1 Test Street'], ['start', 'Fri, Nov 20, 3:00 PM (PT)'],
    ['end', 'Fri, Nov 20, 3:00 PM (PT)'], ['room', '204'], ['confirmation', 'TQ1'], ['cost', '$120.00']]);
  // A name beside the heading's that says something else is a line under "Name", with its check; the same name is the heading's alone.
  const named = { kind: 'lodging', status: 'unverified', unsure: ['title'], title: 'Hotel X', fields: { title: 'Hotel X Annex' } };
  assert.deepEqual(bookingFacts(named).map((x) => [x.key, x.label, x.value, x.unsure, x.lang]), [['title', 'Name', 'Hotel X Annex', true, undefined]]);
  assert.equal(checkCount(named), 2, "the heading's check and the line's");
  assert.deepEqual([bookingFacts({ ...named, fields: { title: 'Hotel X' } }), checkCount({ ...named, fields: { title: 'Hotel X' } })], [[], 1], "one name, one check: the heading's");
  // The chip: one check for each line the part draws.
  const marksPlace = { kind: 'lodging', status: 'unverified', unsure: ['place'], place: own.place, fields: { place: 'Hotel X, 1 Test Street' } };
  assert.deepEqual(bookingFacts(marksPlace).map((x) => [x.key, x.value, x.unsure]), [['place', 'Hotel X, 1 Test Street', true]]);
  assert.equal(checkCount(marksPlace), 1);
  assert.deepEqual(checkOf(marksPlace), { fields: ['place'] });
  // An old booking (no unsure key) marks every part once, whichever way it is written.
  const old = { kind: 'lodging', status: 'unverified', place: own.place, fields: { place: 'Hotel X, 1 Test Street' } };
  assert.equal(checkCount(old), 1);
  assert.deepEqual(checkOf(old), { fields: ['place'] });
  // Not there: a real model wrote fields.place with no top-level place. It is the Place line, with its check.
  const field = { kind: 'lodging', status: 'unverified', unsure: ['place'], fields: { place: 'Testville' } };
  assert.deepEqual(bookingFacts(field).map((x) => [x.key, x.label, x.value, x.unsure]), [['place', 'Place', 'Testville', true]]);
  assert.deepEqual(checkOf(field), { fields: ['place'] });
  assert.equal(checkCount(field), 1);
  // An old one with the field only: the same, once.
  assert.equal(checkCount({ kind: 'lodging', status: 'unverified', fields: { place: 'Testville' } }), 1);
  // Not named in unsure: drawn as the Place line, no check.
  assert.deepEqual(bookingFacts({ ...field, unsure: [] }).map((x) => [x.key, x.label, x.value, x.unsure]), [['place', 'Place', 'Testville', false]]);
  // The other parts the same way: the field is the part's line under the part's label, as written (a time is not read, so no zone is guessed for it), in the part's place in the order.
  const bare = { kind: 'lodging', unsure: ['start', 'confirmation', 'cost'], fields: { start: '2026-11-20T15:00', confirmation: 'TQ9', cost: 'about 120 dollars' } };
  assert.deepEqual(bookingFacts(bare, { fallbackTz: LA }).map((x) => [x.key, x.label, x.value, x.unsure]), [
    ['start', 'Check-in', '2026-11-20T15:00', true], ['confirmation', 'Confirmation', 'TQ9', true], ['cost', 'Cost', 'about 120 dollars', true]]);
  // A cost written as an object keeps its keys; round 2 drew "120 and USD".
  assert.deepEqual(bookingFacts({ kind: 'lodging', unsure: ['cost'], fields: { cost: { amount: 120, currency: 'USD' } } }).map((x) => [x.key, x.label, x.value, x.unsure]), [['cost', 'Cost', 'amount: 120 · currency: USD', true]]);
  // A time that can't be read: the same line, as written. Told and drawn agree: Shiori is told "the check-in time", and a Check-in line has the check.
  assert.deepEqual(bookingFacts({ kind: 'lodging', unsure: ['start'], fields: { start: 'tomorrow' } }).map((x) => [x.key, x.label, x.value, x.unsure]), [['start', 'Check-in', 'tomorrow', true]]);
  assert.equal(checkWords({ kind: 'lodging', unsure: ['start'], fields: { start: 'tomorrow' } }), 'not sure the check-in time was read right');
  // A field of another name that is no part is still a line of its own, and so is a field named like the route (the skip is for the five parts that have a line).
  assert.deepEqual(bookingFacts({ kind: 'flight', unsure: [], fields: { from: 'Tokyo', to: 'Osaka', route: 'via Nagoya' } }).map((x) => [x.key, x.value]), [['route', 'Tokyo → Osaka'], ['route', 'via Nagoya']]);
});

test("bookingFacts: an own part that is there but can't be drawn does not hide a field of its name: the field is its line, with its check (small-next, round 3: round 2 told Shiori of it and drew nothing)", () => {
  // A start whose zone annai doesn't know and no trip zone: undrawable. The field of its name is drawn under Check-in, as written.
  const odd = { kind: 'lodging', status: 'unverified', unsure: ['start', 'cost'], start: { at: '2026-11-20T15:00:00+01:00', tz: 'Not/AZone' }, cost: { currency: 'USD' }, fields: { start: 'tomorrow', cost: 'about 120 dollars' } };
  assert.deepEqual(bookingFacts(odd).map((x) => [x.key, x.label, x.value, x.unsure]), [['start', 'Check-in', 'tomorrow', true], ['cost', 'Cost', 'about 120 dollars', true]]);
  assert.equal(checkCount(odd), 2, 'two parts told, two checks drawn');
  // With no field of its name, nothing is drawn (the part can't be): not this part's, and not reachable from Shiori, whom the schema refuses a time that is no time and a cost with no amount.
  assert.deepEqual(bookingFacts({ ...odd, fields: {} }), []);
});

test("bookingFacts: a flight's place has a line, as a stay's has: an old flight's place, which Shiori asks about, is on screen and counted (words-next)", () => {
  const at = { at: '2026-11-20T11:20:00-08:00', tz: 'America/Los_Angeles' };
  const old = { kind: 'flight', status: 'unverified', title: 'ANNAI AIR AN 123', start: at, end: at, place: { name: 'Testville International', address: '1 Runway Road' }, confirmation: 'TESTQ1', fields: { terminal: '2', gate: 'B12' } };
  const f = bookingFacts(old);
  assert.deepEqual(f.map((x) => x.key), ['start', 'end', 'place', 'confirmation', 'terminal', 'gate']);
  assert.deepEqual(f.map((x) => x.label), ['Departs', 'Arrives', 'Place', 'Confirmation', 'Terminal', 'Gate']);
  assert.equal(f.find((x) => x.key === 'place')?.value, 'Testville International, 1 Runway Road');
  assert.deepEqual(f.filter((x) => x.unsure).map((x) => x.key), ['start', 'end', 'place', 'confirmation', 'terminal', 'gate'], 'every part of an old one is checked, its place too');
  assert.equal(checkCount(old), 7, "the Plan's chip counts the place: the name, both times, the place, the confirmation, the terminal, the gate");
  assert.equal(checkCount(old), checkOf(old).fields.length, 'one check for each part Shiori is told of');
});

test("checkCount: the checks the details draw, which the Plan's chip says: a flight's from and to are one Route line, one check; an old flight with a route says one fewer than the parts it marks (booking-say's round 4, fix 1)", () => {
  const at = { at: '2026-11-20T11:20:00-08:00', tz: 'America/Los_Angeles' };
  const marksDrawn = (/** @type {any} */ b) => bookingFacts(b).filter((x) => x.unsure).length + (b.title ? 1 : 0);
  // An old unverified flight (no unsure key): every part it has is marked: the name, both times, the confirmation, and from, to, flight, airline, seat.
  const old = { kind: 'flight', status: 'unverified', title: 'ANNAI AIR AN 123', start: at, end: at, confirmation: 'TESTQ1', fields: { from: 'Seattle (SEA)', to: 'Anchorage (ANC)', flight: 'AN 123', airline: 'ANNAI AIR', seat: '14C' } };
  assert.equal(checkOf(old).fields.length, 9, 'nine parts are marked (checkOf, which Koe is told in words)');
  assert.equal(checkCount(old), 8, 'the details draw eight checks: the name, the Route, Departs, Arrives, the flight, the airline, the seat, the confirmation');
  assert.equal(checkCount(old), marksDrawn(old));
  // A new flight whose unsure names both ends: one Route line, one check.
  assert.equal(checkCount({ ...old, unsure: ['from', 'to'] }), 1);
  assert.equal(checkCount({ ...old, unsure: ['to'] }), 1);
  assert.equal(checkCount({ ...old, unsure: ['from', 'seat'] }), 2);
  // A train shows from and to as two lines of its own, so two checks.
  assert.equal(checkCount({ kind: 'rail', status: 'unverified', unsure: ['from', 'to'], fields: { from: 'Seattle', to: 'Portland' } }), 2);
  // A flight whose route is not in words has no Route line: from and to are fields, two checks.
  assert.equal(checkCount({ kind: 'flight', status: 'unverified', unsure: ['from', 'to'], fields: { from: { code: 'SEA' }, to: { code: 'ANC' } } }), 2);
  // The name counts once; nothing marked, nothing counted.
  assert.equal(checkCount({ kind: 'lodging', status: 'unverified', unsure: ['title'], title: 'Hotel Aurora Test' }), 1);
  assert.equal(checkCount({ kind: 'lodging', status: 'unverified', unsure: [], title: 'Hotel Aurora Test' }), 0);
  assert.equal(checkCount({ kind: 'lodging', status: 'confirmed', title: 'Hotel Aurora Test', start: at }), 0);
  assert.equal(checkCount(null), 0);
  // A blank name or extra is no part, so no check: an old stay with only a blank name, and an old flight with a blank seat and a null gate.
  assert.equal(checkCount({ kind: 'lodging', status: 'unverified', title: '  ' }), 0);
  assert.equal(checkCount({ kind: 'flight', status: 'unverified', title: 'AN 1', fields: { seat: '', gate: null } }), 1);
  // A marked part the details have no line for is no check: a cost with no amount, a time that can't be read. A place with only an address
  // has its line, the address (small-next).
  assert.equal(checkCount({ kind: 'lodging', status: 'unverified', unsure: ['place', 'cost', 'start', 'end'], place: { address: '1 Test Street' }, cost: { currency: 'USD' }, start: { at: 'not a time', tz: 'America/Los_Angeles' }, end: at }), 2, 'only the place and the check-out are drawn');
  // A time with no zone of its own reads in the trip's: the chip is given the Plan's.
  assert.equal(checkCount({ kind: 'lodging', status: 'unverified', unsure: ['start'], start: { at: '2026-11-20T11:20:00' } }), 0);
  assert.equal(checkCount({ kind: 'lodging', status: 'unverified', unsure: ['start'], start: { at: '2026-11-20T11:20:00' } }, { fallbackTz: 'America/Los_Angeles' }), 1);
});

test("bookingFacts: a time with no offset (an imported or restored record) reads on its zone's clock, as the Plan does (the review of seeing-bookings, R7)", () => {
  const NY = 'America/New_York';
  const stay = { kind: 'lodging', unsure: [], start: { at: '2026-10-31T15:00', tz: NY }, end: { at: '2026-11-03T11:00', tz: NY } };
  const f = Object.fromEntries(bookingFacts(stay).map((x) => [x.key, x.value]));
  assert.match(f.start, /^Sat, Oct 31, 3:00\sPM \(ET\)$/);
  assert.match(f.end, /^Tue, Nov 3, 11:00\sAM \(ET\)$/);
  assert.equal(f.nights, '3');
  const [r] = planRows([], [{ path: '/bookings/s.json', booking: stay }], { fallbackTz: 'UTC' });
  assert.equal(r.time, '15:00');
});

test('bookingFacts: a stay counts its nights; an unknown field is shown as written, its label marked English', () => {
  const stay = {
    id: 's', kind: 'lodging', status: 'unverified', source: '/files/hotel.png', title: 'Hotel Aurora Test', unsure: [],
    place: { name: 'Hotel Aurora Test', address: '1 Test Way, Testville' }, start: { at: '2026-11-20T15:00:00-09:00', tz: 'America/Anchorage' },
    end: { at: '2026-11-27T11:00:00-09:00', tz: 'America/Anchorage' }, cost: { amount: 1234.5, currency: 'USD' }, fields: { breakfast: 'included', room: 'King, tower', guests: 2 },
  };
  const f = bookingFacts(stay);
  assert.deepEqual(f.map((x) => [x.key, x.label]), [['place', 'Place'], ['start', 'Check-in'], ['end', 'Check-out'], ['nights', 'Nights'], ['room', 'Room'], ['guests', 'Guests'], ['cost', 'Cost'], ['breakfast', 'breakfast']]);
  assert.equal(f[0].value, 'Hotel Aurora Test, 1 Test Way, Testville');
  assert.equal(f[3].value, '7');
  assert.equal(f[6].value, '$1,234.50');
  assert.deepEqual([f[7].lang, f[0].lang], ['en', undefined]);
  // Her own count of nights wins over the dates'.
  assert.equal(bookingFacts({ ...stay, fields: { nights: 6 } }).find((x) => x.key === 'nights')?.value, '6');
});

test("bookingFacts: other kinds, odd shapes, and a zone annai doesn't know", () => {
  assert.deepEqual(bookingFacts({ id: 'x', kind: 'other', status: 'unverified', source: '/files/x' }), []);
  const car = { kind: 'car', start: { at: '2026-11-25T08:00:00-08:00', tz: 'Nowhere' }, fields: 'not an object', unsure: 'start' };
  assert.deepEqual(bookingFacts(car), []);
  // With the trip's zone to fall back on, the time shows in it.
  assert.match(bookingFacts(car, { fallbackTz: 'America/Los_Angeles' })[0].value, /8:00\sAM \(PT\)/);
  assert.deepEqual(bookingFacts({ kind: 'event', confirmation: 'TESTQ1', fields: { notes: 'Gate opens at 9', extra: { a: 1 } } }).map((x) => [x.key, x.value]), [['confirmation', 'TESTQ1'], ['notes', 'Gate opens at 9'], ['extra', 'a: 1']]);
  for (const odd of [null, 'text', [], { fields: [1, 2] }]) assert.doesNotThrow(() => bookingFacts(odd));
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
  // A hold kept before holds said what they were: its English is a line of its own (holdNote), never inside the sentence.
  const old = t({ last, hold: { kind: 'error', message: 'GitHub had a problem.', at: now, count: 1, retryAt: now, needsYou: false } });
  assert.equal(placeStatus(old, null, now), 'Last backup 2 hours ago. The last try failed.');
  assert.equal(holdNote(old), 'GitHub had a problem.');
  const offline = t({ last, hold: { kind: 'error', message: 'GitHub had a problem.', offline: true, at: now, count: 1, retryAt: now, needsYou: false } });
  assert.equal(placeStatus(offline, null, now), "Last backup 2 hours ago. The last try failed: GitHub had a problem. annai tries again once it's back online.");
  assert.equal(holdNote(offline), '');
  assert.equal(placeStatus(t(), { phase: 'uploading', done: 3, total: 12 }, now), 'Uploading 3 of 12…');
  assert.equal(placeStatus(t(), { phase: 'checking', done: 1, total: 40 }, now), 'Comparing files 1 of 40…');
  assert.equal(placeStatus(t(), { phase: 'building', done: 0, total: 0 }, now), 'Getting the backup ready…');
  assert.equal(placeStatus(t(), { phase: 'downloading', done: 120, total: 650 }, now), 'Getting files: 120 of 650');
  assert.equal(placeStatus(t(), { phase: 'downloading', done: 0, total: 1 }, now), 'Getting the backup…', 'one file is no count');
  assert.equal(placeStatus(t(), { phase: 'downloading', done: 0, total: 0 }, now), 'Getting the backup…');
  assert.equal(placeHref('bt-1 2'), '#/backups/place?id=bt-1%202');
  const held = t({ last: { ...last, at: now - 86_400_000 }, hold: { kind: 'newer', remote: { id: 'x', at: now - 3_600_000, label: 'Android phone' } } });
  assert.equal(newerText(held, { where: 'me/annai-backup', noun: 'phone', tree: true }, now),
    "An Android phone backed up to me/annai-backup 1 hour ago. That was after this phone's last backup. Automatic backups there are paused, so neither device overwrites the other. Import it as a copy to bring its trips here, or back up this phone over it. The other backup stays in its history.");
  assert.equal(newerText(t({ hold: { kind: 'newer', remote: { id: 'x', at: now } } }), { where: 'x', noun: 'computer', tree: false }, now),
    'Another device backed up to x just now. Automatic backups there are paused, so neither device overwrites the other. Import it as a copy to bring its trips here, or back up this computer over it.');
  assert.equal(newerText(t(), { where: 'x', noun: 'phone', tree: true }, now), '');
  // Whole sentences for each kind of device; one annai doesn't name is "another device".
  assert.equal(newerText(t({ last, hold: { kind: 'newer', remote: { id: 'x', at: now, label: 'iPad' } } }), { where: 'x', noun: 'iPad', tree: false }, now),
    "An iPad backed up to x just now. That was after this iPad's last backup. Automatic backups there are paused, so neither device overwrites the other. Import it as a copy to bring its trips here, or back up this iPad over it.");
  assert.equal(placeStatus(t({ hold: { kind: 'newer', remote: { id: 'x', at: now, label: 'toaster' } } }), null, now), 'Paused: there is a newer backup from another device');
  assert.equal(placeStatus(t({ hold: { kind: 'newer', remote: { id: 'x', at: now, label: 'computer' } } }), null, now), 'Paused: there is a newer backup from a computer');
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
  assert.deepEqual(toasts, ['Imported Big Sur from Forgejo / Gitea.', 'Imported Big Sur and Kyoto.', 'Imported 3 trips and conversations from Forgejo / Gitea.', 'Imported from Forgejo / Gitea.']);
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
  assert.equal(limitText(0), '0 bytes');
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
  mediaKeys({ session, tap: () => { taps++; return 'listening'; }, voice }); // the shell's tap (tapShiori: plus.test.js)
  assert.equal(handlers.play, null);
  for (const fn of listeners) fn({ on: true });
  handlers.play();
  handlers.pause();
  handlers.nexttrack();
  assert.equal(taps, 3);
  for (const fn of listeners) fn({ on: false });
  assert.equal(handlers.pause, null);
  assert.doesNotThrow(() => mediaKeys({ session: undefined, tap: () => 'typing', voice }));
});

test("the trace's one-line summaries of live mode: points, firings, reminders and switches", () => {
  assert.equal(traceSummary({ type: 'location', data: { lat: 36.3715, lng: -121.9017, accuracy: 8, speed: 15 } }), '36.3715, -121.9017 ±8 m · 54 km/h');
  assert.equal(traceSummary({ type: 'location', data: { lat: 36.3715, lng: -121.9017, accuracy: 50, source: 'manual' } }), '36.3715, -121.9017 ±50 m · manual');
  assert.equal(traceSummary({ type: 'trigger.fired', data: { watch: 'plan:hearst:leave', text: 'Plan: time to leave soon for "Hearst Castle tour"', late: 17, offline: true } }),
    'plan:hearst:leave · Plan: time to leave soon for "Hearst Castle tour" · late by 17 min · no connection');
  assert.equal(traceSummary({ type: 'reminder', data: { text: 'Tea time.', aloud: true } }), 'said aloud · Tea time.');
  assert.equal(traceSummary({ type: 'state', data: { live: 'on' } }), 'GPS on');
  assert.equal(traceSummary({ type: 'state', data: { voice: 'on', why: 'moving' } }), 'voice on (moving)');
  // The entry for each km of way carries no hold, gap or readings; the odometer shows on every activity entry.
  assert.equal(traceSummary({ type: 'state', data: { activity: 'moving-fast', from: 'moving-fast', speed: 14.2, odometer: 12.345 } }), 'moving-fast, unchanged · 14.2 m/s · 12.3 km');
  assert.match(traceSummary({ type: 'state', data: { activity: 'still', from: 'moving-fast', speed: 0.2, odometer: 3, heldS: 61, gapS: 4, readings: { still: 1 } } }), /^moving-fast to still · 0\.2 m\/s · 3\.0 km · held 61 s/);
});

test('the Offline pack panel: the estimate before anything is downloaded, then what it holds and what an update brings (spec §11.5)', () => {
  const base = { stops: 2, manifest: null, why: null, estimate: 120 * 1024, running: null };
  const none = packWords(/** @type {any} */ (base), 'unknown');
  assert.equal(none.button, 'Download (about 120 kB)');
  assert.match(none.lines[0], /^For when there's no connection: places from OpenStreetMap, Wikipedia summaries and Wikivoyage guides, around the itinerary's 2 stops and along the way between them\./);
  // Wikidata is named for what happens (with a language besides English: English is always read, so one language of the traveller's is two editions) and with what it gets: Wikidata item ids, never a place.
  assert.equal(none.lines[1], "Downloading sends the itinerary's places to OpenStreetMap and Wikipedia and place names to Wikivoyage; with a language besides English, it also sends Wikidata item ids to Wikidata.");
  assert.deepEqual(packWords(/** @type {any} */ ({ ...base, stops: 0 }), 'wifi'), { lines: ['The pack follows the itinerary: once the itinerary has places, it can be downloaded here.'], button: null });
  assert.deepEqual(packWords(/** @type {any} */ ({ ...base, running: { done: 2, total: 6, label: 'Wikipedia near Nepenthe' } }), 'wifi'), { lines: ['Downloading 3 of 6: Wikipedia near Nepenthe…'], button: null });
  const manifest = { at: new Date().toISOString(), bytes: 1_300_000, places: 1200, summaries: 40, files: [{ kind: 'osm', items: 1300 }, { kind: 'wikipedia', items: 45 }, { kind: 'wikivoyage', items: 1 }], guides: [{ title: 'Big Sur', also: [] }], voyage: ['en'], failed: [], stopped: false };
  const done = packWords(/** @type {any} */ ({ ...base, manifest }), 'wifi');
  assert.equal(done.button, null);
  assert.equal(done.lines[0], 'Downloaded just now · 1.2 MB · 1,200 places, 40 Wikipedia summaries, 1 Wikivoyage guide.');
  assert.equal(done.lines[1], 'Guides: Big Sur.');
  assert.equal(done.lines.at(-1), 'On Wi-Fi, annai keeps it up to date by itself while this conversation is open.');
  const changed = packWords(/** @type {any} */ ({ ...base, manifest, why: 'plan', estimate: 30 * 1024 }), 'unknown');
  assert.equal(changed.button, 'Update (about 30 kB)');
  assert.ok(changed.lines.includes('The itinerary changed since.'));
  assert.equal(changed.lines.at(-1), "This browser doesn't tell annai when it is on Wi-Fi, so update it here.");
  const failed = packWords(/** @type {any} */ ({ ...base, manifest: { ...manifest, failed: [{ label: 'OpenStreetMap around Nepenthe', why: 'overpass-api.de answered 504.' }] }, why: 'missing' }), 'wifi');
  assert.equal(failed.button, 'Try again (about 120 kB)');
  assert.ok(failed.lines.includes("One part didn't download: OpenStreetMap around Nepenthe (overpass-api.de answered 504)."));
  assert.equal(packWords(/** @type {any} */ ({ ...base, manifest: { ...manifest, stopped: true }, why: 'missing' }), 'wifi').button, 'Download the rest (about 120 kB)');
  // No limit, and nothing left out: no line says so, whatever an older annai's manifest kept.
  assert.deepEqual(packWords(/** @type {any} */ ({ ...base, manifest: { ...manifest, full: true } }), 'wifi'), done);
  assert.match(packWords(/** @type {any} */ ({ ...base, manifest: { ...manifest, places: 1, summaries: 1, guides: [] } }), 'wifi').lines[0], / · 1 place, 1 Wikipedia summary, 0 Wikivoyage guides\.$/);
  assert.equal(packWords(/** @type {any} */ ({ ...base, manifest, why: 'old' }), 'wifi').button, 'Update (about 120 kB)');
});

test("the Offline pack panel says annai keeps it up to date by itself only where it does: not where the pack waits for the traveller's Try again", () => {
  const manifest = { at: new Date().toISOString(), bytes: 1_300_000, places: 1200, summaries: 40, files: [], guides: [], voyage: ['en'], failed: [{ label: 'OpenStreetMap around Nepenthe', why: 'overpass-api.de stopped early.', part: { source: 'osm', place: { how: 'around', names: ['Nepenthe'] } }, said: { code: 'early', where: 'overpass-api.de', remark: 'x' } }], stopped: false };
  const by = 'On Wi-Fi, annai keeps it up to date by itself while this conversation is open.';
  const status = (/** @type {Record<string, unknown>} */ o) => /** @type {any} */ ({ stops: 2, manifest, why: 'missing', byItself: false, estimate: 120 * 1024, running: null, ...o });
  assert.ok(!packWords(status({}), 'wifi').lines.includes(by), 'an answer annai can\'t use waits for Try again');
  assert.ok(packWords(status({ byItself: true }), 'wifi').lines.includes(by), 'a source that was down comes by itself');
  assert.ok(packWords(status({ why: null }), 'wifi').lines.includes(by), 'up to date, and kept so');
  assert.equal(packWords(status({}), 'unknown').lines.at(-1), "This browser doesn't tell annai when it is on Wi-Fi, so update it here.");
});

test("a pack whose manifest doesn't say when it was downloaded says only that it was, never \"just now\"", () => {
  const base = { stops: 2, why: null, estimate: 120 * 1024, running: null };
  const manifest = { at: '', bytes: 1_300_000, places: 1200, summaries: 40, files: [], guides: [], voyage: ['en'], failed: [], stopped: false };
  assert.equal(packWords(/** @type {any} */ ({ ...base, manifest }), 'wifi').lines[0], 'Downloaded · 1.2 MB · 1,200 places, 40 Wikipedia summaries, 0 Wikivoyage guides.');
  assert.equal(downloadedWhen(''), '');
  assert.equal(downloadedWhen('not a time'), '');
  assert.equal(downloadedWhen(new Date().toISOString()), 'just now');
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
      "Version 1.0.0 is installed now, from trails.example/kit/annai-plugin.json, not where this one comes from. If you keep them, its settings, keys and your choices under Names go to this one; installing fresh removes them.");
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
  assert.deepEqual(disabledCard({ name: 'Tides', why: { kind: 'failed', count: 3 }, message: 'boom' }), {
    tone: 'warn', title: 'The plugin "Tides" was turned off',
    body: 'It failed 3 times in a row. The last error: boom. You can turn it back on in Settings → Plugins.',
  });
  // The last error is a plugin's own words, ended as a sentence so the next one doesn't run into it, unless it ends in a stop of its own.
  for (const [message, ended] of [['boom', 'boom.'], ['boom.', 'boom.'], ['Really?', 'Really?'], ['boom\n', 'boom.']]) {
    assert.equal(disabledCard({ name: 'Tides', why: { kind: 'failed', count: 1 }, message }).body, `It failed 1 time in a row. The last error: ${ended} You can turn it back on in Settings → Plugins.`);
  }
  // A hook loop says so whole: once "It its hooks were handed…", glued (localization L5f), and its last error is that reason, in English: not said twice.
  assert.equal(disabledCard({ name: 'Tides', why: { kind: 'loop', entries: 1000, seconds: 10 }, message: 'its hooks were handed more than 1000 log entries in 10 seconds, which looks like a loop' }).body,
    'Its hooks were handed more than 1,000 log entries in 10 seconds, which looks like a loop. You can turn it back on in Settings → Plugins.');
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

test('handover: the screen a plugin offers for an activity, else Driving when moving fast (choice 5)', async () => {
  const { handover } = await import('../../src/ui/today.js');
  const hike = { pluginId: 'trail-ui', item: { id: 'hike', homeFor: 'walking' } };
  const car = { pluginId: 'road', item: { id: 'road', homeFor: 'moving-fast' } };
  assert.equal(handover('walking', 'still', [hike]), '#/ext/trail-ui/hike');
  assert.equal(handover('walking', 'walking', [hike]), null);
  assert.equal(handover('moving-fast', 'walking', [hike]), '#/drive');
  assert.equal(handover('moving-fast', 'still', [hike, car]), '#/ext/road/road');
  assert.equal(handover('still', 'walking', [hike]), null);
});

test("a typed card's label names its kind as its plugin wrote it (capitals are CSS's); an unknown one is plain Shiori", async () => {
  const { cardWho } = await import('../../src/ui/cards.js');
  const { Registry } = await import('../../src/core/registry.js');
  const registry = new Registry();
  registry.add('tides', 'ui:card-type', { type: 'tides', name: 'Tides', description: 'x', render: () => {} });
  assert.equal(cardWho({ registry }, { type: 'tides' }), 'Shiori · Tides');
  assert.equal(cardWho({ registry }, { type: 'ferries' }), 'Shiori');
  assert.equal(cardWho({ registry }, { title: 'Hi' }), 'Shiori');
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
  assert.equal(traceSummary({ type: 'plugin.reset', data: { plugin: 'web', name: 'Web tools', settings: [], otherSettings: 0, secrets: [], otherSecrets: 1, bytes: 0 } }), 'Web tools · 0 settings, 1 secret · 0 bytes');
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
  assert.equal(cards[0].title, "There's no room left");
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
  assert.deepEqual(announced('out.ask', '', 'Read Testville?', ['Allow', 'Not now'], { own: true }), ['annai asks: ', 'Read Testville?', ' Choices: Allow, Not now.'], "annai's own card says who asks");
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

test('a wake in the conversation says why from its kinds, never the words the model was given; a reminder line says what it is', () => {
  assert.equal(wokeText([{ kind: 'trigger', text: 'Your watch w1 (at 17:00) fired: it is 17:00.' }]), 'Shiori woke for a reminder, or something she watches for.');
  // What fired and which files, from the wake's data; an older wake has none and is said by its kind.
  assert.equal(wokeText([{ kind: 'trigger', text: 'x', titles: ['Tea time.'] }]), 'Shiori woke for a reminder, or something she watches for: Tea time.');
  assert.equal(wokeText([{ kind: 'trigger', text: 'x', titles: ['Tea time', 'Hearst Castle tour'] }]), 'Shiori woke for 2 reminders, or things she watches for: Tea time and Hearst Castle tour.');
  assert.deepEqual(wokeTitles([{ kind: 'trigger', titles: ['Tea time'] }, { kind: 'file', titles: ['no'] }]), ['Tea time']);
  assert.equal(wokeText([{ kind: 'file', text: 'x', files: ['/files/hotel.pdf'] }]), 'Shiori woke to look at the file you added: hotel.pdf.');
  assert.equal(wokeText([{ kind: 'file', text: 'x', files: ['/files/a.jpg', '/files/b.jpg', '/files/c.jpg', '/files/d.jpg'] }]), 'Shiori woke to look at the 4 files you added.');
  assert.equal(wokeText([{ kind: 'file', text: 'x' }]), 'Shiori woke to look at the files you added.');
  assert.equal(wokeText([{ kind: 'recap', text: 'x' }, { kind: 'plugin', plugin: 'trail', text: 'y' }], (id) => `${id}!`), 'Shiori woke to tell you the recap. Shiori woke for the plugin trail!.');
  /** The line's parts, its words as the attributes they get. @param {any} d */
  const line = (d) => reminderParts({ text: 'Tea.', ...d }, () => ({ lang: 'mine' }), (_, a) => `${a.text}@${a.lang}`);
  assert.deepEqual(line({}), ['Reminder: ', 'Tea.@mine', '']);
  assert.deepEqual(line({ aloud: true }), ['Reminder, said aloud: ', 'Tea.@mine', '']);
  assert.deepEqual(line({ title: "Shiori's answer", aloud: false }), ["Shiori's answer: ", 'Tea.@mine', '']);
  assert.deepEqual(line({ title: 'Reminder', aloud: true }), ['Reminder, said aloud: ', 'Tea.@mine', ''], 'any other title is a reminder');
  assert.deepEqual(line({ watch: 'plan:hearst:leave' }), ['Reminder: ', 'Tea.@en', ''], "a plan watch's words are annai's English, as stored");
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

test('the road ahead: how far and how long, and never "about 0 ms" when standing at the stop', () => {
  assert.equal(roadText({ km: 42.3, minutes: 25 }), '≈ 26 mi · about 25 min');
  assert.equal(roadText({ km: 42.3, minutes: 72 }), '≈ 26 mi · about 1 hr, 12 min');
  assert.equal(roadText({ km: 0.01, minutes: 0 }), '≈ 0 mi · about 1 min');
  assert.equal(roadText({ km: 0.02, minutes: null }), '≈ 0 mi · about 1 min');
  assert.equal(roadText({ km: null, minutes: null }), '');
});

test('linkIn puts each link where the words say it, in the order the words have them, and one the words lack after', async () => {
  const { linkIn } = await import('../../src/ui/dom.js');
  const a = /** @type {any} */ ({ textContent: 'Get a key' });
  const b = /** @type {any} */ ({ textContent: 'OpenStreetMap' });
  const c = /** @type {any} */ ({ textContent: 'missing' });
  assert.deepEqual(linkIn('Some networks need a key. Get a key. Then paste it.', a), ['Some networks need a key. ', a, '. Then paste it.']);
  // A translation may put the links in another order; each is still where its words are.
  assert.deepEqual(linkIn('OpenStreetMapのデータ、Get a keyで', a, b), ['', b, 'のデータ、', a, 'で']);
  assert.deepEqual(linkIn('Map data from OpenStreetMap.', b, c), ['Map data from ', b, '.', ' ', c]);
});

test("the Trace's line marks what an entry keeps as written (English) apart from annai's words: errors, reasons, a model's notes, tools' results; never the user's words", async () => {
  const { traceStored, traceSummary } = await import('../../src/ui/screens/trace.js');
  const e = (/** @type {string} */ type, /** @type {any} */ data) => ({ type, data });
  assert.deepEqual(traceStored(e('error', { kind: 'budget', message: 'Steps used up.' })), ['budget: Steps used up.']);
  assert.deepEqual(traceStored(e('live.session', { state: 'closed', why: 'the socket closed' })), ['the socket closed']);
  // A reading kept for a model that can't take a file is a model's English (the re-review of reading-files).
  assert.deepEqual(traceStored(e('reading', { kind: 'pdf', how: 'told', text: "What it says (told by model-u, as you can't read PDFs): Check-in 3 PM." })), ["What it says (told by model-u, as you can't read PDFs): Check-in 3 PM."]);
  assert.deepEqual(traceStored(e('net.request', { kind: 'web', tool: 'fetch', url: 'https://x.test/', error: 'Failed to fetch' })), ['Failed to fetch']);
  assert.deepEqual(traceStored(e('wake', { reasons: [{ kind: 'user', text: 'typed' }, { kind: 'file', text: 'A new file' }] })), ['A new file']);
  assert.deepEqual(traceStored(e('heard', { text: 'どこで食べる？', ms: 900 })), []);
  // Each is in the line as the line shows it, so it can be marked where it is.
  for (const x of [e('error', { kind: 'budget', message: 'x'.repeat(150) }), e('backup.peek', { type: 's3', backup: 'c2', problem: '$.files[0].hash: does not match' })]) {
    for (const kept of traceStored(x)) assert.ok(traceSummary(x).includes(kept), kept);
  }
});

test("a failure line in the Conversation names each model by its provider's name first, whichever failed: a turn's models and a tidy-up's (the final review's finding src1-B)", async () => {
  const { errorWords } = await import('../../src/ui/screens/talk.js');
  const names = (/** @type {string} */ n) => `Acme / ${n}`;
  const why = { attempts: [{ model: 'm-0', name: 'Haiku', outcome: 'auth', ms: 1, error: 'bad key' }] };
  assert.match(String(errorWords({ kind: 'model', why, message: 'Haiku: Bad key.' }, { names })), /^Acme \/ Haiku: /);
  assert.match(String(errorWords({ kind: 'compaction', why, message: 'Haiku: Bad key.' }, { names })), /^Acme \/ Haiku: .* Until it is tidied up/);
  assert.match(String(errorWords({ kind: 'model', why, message: 'Haiku: Bad key.' })), /^Haiku: /);
  assert.equal(errorWords({ kind: 'model', message: 'Haiku: Bad key.' }, { names }), null, 'an older entry is shown as stored');
});

test("undoneWords: what Undo of a hand-over did, and each trip that stays that it changed beyond where the files went back", () => {
  const none = { removed: [], kept: 0, waiting: false, back: [], changed: [] };
  assert.equal(undoneWords({ ...none, removed: ['Testville'], back: [{ id: 'a', title: 'Anchorage' }], changed: [{ id: 'k', title: 'Kyoto' }] }),
    'Undone. Testville is removed, and your files are back in Anchorage. What Shiori did in Kyoto is undone too.');
  assert.equal(undoneWords({ ...none, waiting: true, changed: [{ id: 'k', title: 'Kyoto' }, { id: 'b', title: 'Big Sur' }], kept: 1 }),
    'Undone. Your files are waiting with Shiori again. What Shiori did in Kyoto and Big Sur is undone too. Left 1 file as you changed it.');
  assert.equal(undoneWords({ ...none, back: [{ id: 'a', title: 'Anchorage' }] }), 'Undone. Your files are back in Anchorage.');
  // Some files went back to a trip and the rest have nowhere to go: both places are said, with or without a removal.
  assert.equal(undoneWords({ ...none, waiting: true, back: [{ id: 'k', title: 'Kyoto' }, { id: 'b', title: 'Big Sur' }] }),
    'Undone. Some of your files are back in Kyoto and Big Sur, and the rest are waiting with Shiori.');
  assert.equal(undoneWords({ ...none, removed: ['Osaka'], waiting: true, back: [{ id: 'k', title: 'Kyoto' }] }),
    'Undone. Osaka is removed. Some of your files are back in Kyoto, and the rest are waiting with Shiori.');
  assert.equal(undoneWords({ ...none, removed: ['Osaka', 'Nara'], waiting: true, back: [{ id: 'k', title: 'Kyoto' }] }),
    'Undone. Osaka and Nara are removed. Some of your files are back in Kyoto, and the rest are waiting with Shiori.');
  assert.equal(undoneWords({ ...none, removed: ['Osaka'], waiting: true }), 'Undone. Osaka is removed, and your files are waiting with Shiori.');
  assert.equal(undoneWords(none), 'Undone.');
});

test('movedWords: started, took one, took several, and to a conversation since removed', () => {
  assert.equal(movedWords({ to: 't', started: true, count: 2 }, 'Anchorage · Nov 20–27'), 'Shiori started Anchorage · Nov 20–27 with these files.');
  assert.equal(movedWords({ to: 't', started: true, count: 0 }, 'Anchorage'), 'Shiori started Anchorage.');
  assert.equal(movedWords({ to: 't', started: false, count: 1 }, 'Kyoto'), 'Shiori took 1 file to Kyoto.');
  assert.equal(movedWords({ to: 't', started: false, count: 3 }, 'Kyoto'), 'Shiori took 3 files to Kyoto.');
  assert.equal(movedWords({ to: 't', started: false, count: 3 }, null), 'Shiori took these files to a conversation that has since been removed.');
  // Not her lines: the announcer says nothing of them.
  assert.deepEqual(announced('handover.moved', '', 'Shiori took 1 file to Kyoto.'), ['', '', '']);
});

test("wentWords: the chat's line for a move (open_trip), by the trip's title, or to one since removed; the Trace lists it", () => {
  assert.equal(wentWords('Kyoto · Apr 1–8'), 'Shiori moved this to Kyoto · Apr 1–8.');
  assert.equal(wentWords(null), 'Shiori moved this to a conversation that has since been removed.');
  // Said to a screen reader as it comes, as annai's own lines are: the conversation is about to change.
  assert.deepEqual(announced('conversation.moved', '', 'Shiori moved this to Kyoto.'), ['', 'Shiori moved this to Kyoto.', '']);
  assert.equal(traceSummary(/** @type {any} */ ({ seq: 1, ts: 0, type: 'conversation.moved', actor: 'shiori', data: { to: 'trip-k', title: 'Kyoto' } })), 'moved to Kyoto · trip-k');
});

test('an old #/waiting/file?path=… names no screen and goes home, in place of its entry (as the plan says: old bookmarks go home), since timeline stage 7', () => {
  assert.equal(parseHash('#/waiting/file?path=%2Ffiles%2Fa.pdf').name, 'waiting');
  assert.equal(redirectOf(parseHash('#/waiting/file?path=%2Ffiles%2Fa.pdf'), 'trip-a'), '#/trips');
  assert.equal(redirectOf(parseHash('#/waiting/file?path=%2Ffiles%2Fa.pdf'), null), '#/trips');
  assert.equal(redirectOf(parseHash('#/waiting'), 'trip-a'), '#/trips');
});

test('Undo tapped while Shiori works stops her turn and waits for it to settle before it takes anything back', async () => {
  /** @type {string[]} */
  const did = [];
  const agent = { busy: true, stopKokoro: () => did.push('stop'), idle: async () => { did.push('idle'); agent.busy = false; } };
  await settled(agent);
  assert.deepEqual(did, ['stop', 'idle']);
  await settled(agent);
  assert.deepEqual(did, ['stop', 'idle']);
});

test('fileLine: one booking, several of a kind with their days, mixed kinds, a calendar, waiting', () => {
  const b = (/** @type {string} */ k, /** @type {string | null} */ day) => ({ kind: /** @type {const} */ ('booking'), bookingKind: k, path: `/bookings/${k}${day}.json`, title: '', at: null, day });
  assert.equal(fileLine([b('lodging', '2026-11-20')]), 'Stay · Nov 20');
  assert.equal(fileLine([b('flight', '2026-11-20'), b('flight', '2026-11-27')]), '2 flights · Nov 20, Nov 27');
  assert.equal(fileLine([b('flight', '2026-11-20'), b('flight', '2026-11-20')]), '2 flights · Nov 20');
  assert.equal(fileLine([b('flight', '2026-11-20'), b('lodging', '2026-11-20')]), '1 flight · 1 stay');
  assert.equal(fileLine([b('other', null)]), 'Booking');
  // booking-next: a ferry, a bus and a coach are kinds of their own, counted as such.
  assert.equal(fileLine([b('ferry', '2026-11-20')]), 'Ferry · Nov 20');
  assert.equal(fileLine([b('ferry', '2026-11-20'), b('ferry', '2026-11-22')]), '2 ferries · Nov 20, Nov 22');
  assert.equal(fileLine([b('bus', '2026-11-20'), b('coach', '2026-11-20'), b('coach', '2026-11-21')]), '1 bus · 2 coaches');
  assert.equal(fileLine([b('bus', '2026-11-20'), b('bus', '2026-11-21')]), '2 buses · Nov 20, Nov 21');
  assert.equal(fileLine([{ kind: 'plan', path: '/plan/a.json', title: 'A', at: null, day: null }, { kind: 'plan', path: '/plan/b.json', title: 'B', at: null, day: null }]), 'Itinerary items from a calendar');
  assert.equal(fileLine([{ kind: 'waiting' }]), 'Waiting for Shiori to read it');
  assert.equal(fileLine([{ kind: 'nothing' }]), 'Nothing yet');
});

test('cameFrom: the trip, the Conversation, the Plan, Now, an item, and an old booking crumb', () => {
  assert.deepEqual(cameFrom('#/trip/t-1', 't-1', 't-1'), { hash: '#/trip/t-1', name: 'trip' });
  assert.equal(cameFrom('#/trip/t-2', 't-1', 't-1'), null); // another trip's screen
  assert.deepEqual(cameFrom('#/talk', 't-1', 't-1'), { hash: '#/talk', name: 'talk' });
  assert.equal(cameFrom('#/talk', 't-1', 't-2'), null); // the Conversation is another trip's now
  assert.deepEqual(cameFrom('#/trip/t-1/booking?path=%2Fbookings%2Fa.json', 't-1', null)?.name, 'booking');
  assert.equal(cameFrom('#/settings', 't-1', 't-1'), null);
  // The Plan and an item are crumbs too; the Plan by its plain address means the open trip's.
  assert.deepEqual(cameFrom('#/trip/t-1/plan', 't-1', 't-1'), { hash: '#/trip/t-1/plan', name: 'plan' });
  assert.deepEqual(cameFrom('#/plan', 't-1', 't-1'), { hash: '#/plan', name: 'plan' });
  assert.deepEqual(cameFrom('#/plan', 't-1', 't-2'), { hash: '#/trip/t-1/plan', name: 'plan' }); // another trip is open now: this one's own Plan
  // An old "?from=#/now" (Now went in timeline stage 8): no crumb of its own, so the file's goes to its trip's Details.
  assert.equal(cameFrom('#/now', 't-1', 't-1'), null);
  assert.equal(cameFrom('#/now', 't-1', 't-2'), null);
  assert.deepEqual(cameFrom('#/trip/t-1/item?path=%2Fplan%2Fa.json', 't-1', null), { hash: '#/trip/t-1/item?path=%2Fplan%2Fa.json', name: 'item' });
  assert.deepEqual(cameFrom('#/trip/t-1/recap', 't-1', null), { hash: '#/trip/t-1/recap', name: 'recap' });
});

test('recordHref: a file the user gave and a booking open the details screen; a plan item its own; anything else the raw file', () => {
  assert.equal(recordHref('t-1', '/files/a.pdf', '#/talk'), '#/trip/t-1/booking?path=%2Ffiles%2Fa.pdf&from=%23%2Ftalk');
  assert.match(recordHref('t-1', '/bookings/a.json'), /\/booking\?path=%2Fbookings%2Fa\.json$/);
  assert.match(recordHref('t-1', '/plan/a.json'), /\/item\?path=/);
  assert.match(recordHref('t-1', '/files/scans/a.pdf'), /\/file\?path=/);
  assert.match(recordHref('t-1', '/notes/a.md'), /\/file\?path=/);
});

test('afterDelete: back where it came from, unless that screen was of something deleted', () => {
  const gone = ['/files/a.pdf', '/bookings/a.json', '/plan/a.json'];
  assert.equal(afterDelete('#/trip/t-1/plan', gone, 't-1'), '#/trip/t-1/plan');
  assert.equal(afterDelete('#/now', gone, 't-1'), '#/now');
  assert.equal(afterDelete('#/talk', gone, 't-1'), '#/talk');
  assert.equal(afterDelete('#/trip/t-1', gone, 't-1'), '#/trip/t-1');
  assert.equal(afterDelete('#/trip/t-1/item?path=%2Fplan%2Fa.json', gone, 't-1'), '#/trip/t-1');
  assert.equal(afterDelete('#/trip/t-1/item?path=%2Fplan%2Fb.json', gone, 't-1'), '#/trip/t-1/item?path=%2Fplan%2Fb.json');
  assert.equal(afterDelete('#/trip/t-1/booking?path=%2Ftrip%2Ffiles%2Fa.pdf', gone, 't-1'), '#/trip/t-1');
});

test('countParts: what else goes, in words', () => {
  assert.deepEqual(countParts(2, 1), ['2 bookings', '1 itinerary item']);
  assert.deepEqual(countParts(0, 3), ['3 itinerary items']);
  assert.deepEqual(countParts(0, 0), []);
});

// Fix pass 1, item 9: the Trace says a claim was a claim, and a live line nobody answered was not judged.
test("the trace's lines: a claim says so, a live heard line nobody answered says that, and a plain message is as it was", () => {
  const e = (/** @type {string} */ type, /** @type {any} */ data) => ({ type, data, ts: 0, seq: 1, actor: 'x', scope: 's' });
  assert.equal(traceSummary(e('msg.user', { text: 'Is there parking?', claim: 'h1' })), 'this was for Shiori · Is there parking?');
  assert.equal(traceSummary(e('msg.user', { text: 'Is there parking?' })), 'Is there parking?');
  assert.match(traceSummary(e('heard', { id: 'h', source: 'live', text: 'la la', dismissed: true })), /she didn't answer/);
  assert.match(traceSummary(e('heard', { id: 'h', source: 'mic', ms: 900, text: 'la la', dismissed: true })), /not for Shiori/);
});

// drive-3 design, D4 and D5: the Trace's lines about the sound's context, and the dock's words between a tap and Listening.
test('the Trace shows the sound\'s context on voice.route, voice.mic and voice.shown, and a line from before it was kept reads as it did', async () => {
  const e = (/** @type {string} */ type, /** @type {any} */ data) => ({ type, data, ts: 0, seq: 1, actor: 'system', scope: 'sys-device' });
  const ctx = { state: 'running', time: 812.403 };
  assert.equal(traceSummary(e('voice.mic', { firstFrameMs: 6, renewed: false, ctx })), 'microphone ran after 6 ms · sound running at 812.403 s');
  assert.equal(traceSummary(e('voice.mic', { firstFrameMs: 9, renewed: true, ctx })), 'microphone ran after 9 ms · sound made anew · sound running at 812.403 s');
  assert.equal(traceSummary(e('voice.mic', { firstFrameMs: null, renewed: true, ctx: null })), 'microphone never ran · sound made anew');
  assert.equal(traceSummary(e('voice.shown', { ctx })), 'back in view · sound running at 812.403 s');
  const route = { route: 'speaker', using: null, devices: ['iPhone Microphone'] };
  assert.equal(traceSummary(e('voice.route', { ...route, ctx })), 'audio route speaker · judged by the devices present · iPhone Microphone · sound running at 812.403 s');
  assert.equal(traceSummary(e('voice.route', route)), 'audio route speaker · judged by the devices present · iPhone Microphone', 'an older line, with no ctx');
});

test('the dock has words for every state a half shows, "One moment…" between a tap and Listening among them', async () => {
  const { LABELS } = await import('../../src/core/agent/loop.js');
  assert.equal(LABELS.opening, 'One moment…');
  for (const name of ['sleeping', 'opening', 'thinking', 'speaking', 'listening', 'ignoring', 'hearing', 'waiting', 'away', 'offline']) assert.ok(/** @type {any} */ (LABELS)[name], name);
});

test('addedWords says what a hand-over added once: a file or files, or photos only, whole, never a path', () => {
  const photo = { name: '/files/IMG_1.heic', type: 'image/heic' };
  const note = { name: '/files/notes.txt' };
  assert.deepEqual(addedWords([note]), { what: 'a file', added: 'Added a file' });
  assert.deepEqual(addedWords([note, note, note]), { what: '3 files', added: 'Added 3 files' });
  assert.deepEqual(addedWords([photo]), { what: '1 photo', added: 'Added 1 photo' });
  assert.deepEqual(addedWords([photo, { name: '/files/b.jpg' }]), { what: '2 photos', added: 'Added 2 photos' });
  assert.deepEqual(addedWords([photo, note]), { what: '2 files', added: 'Added 2 files' }, 'one file that is not a photo makes them all files');
  assert.deepEqual(addedWords([{ name: '/files/invite', type: 'text/calendar' }]), { what: 'a file', added: 'Added a file' }, 'a name with no ending, a type that is not a photo');
  assert.equal(addedWords([]).added, 'Added 0 files', 'nothing kept is not "0 photos"');
});

test("an ability's own address lets go first of what its provider holds for it: kept turns, and photo uploads where the type deletes them and the ability has the switch; not for a type that deletes but has no switch", () => {
  const chatCompletions = { deleteUploadRequest() {} };
  const responses = { keeps: { days: 30 } };
  const anthropicMessages = {};
  assert.equal(releasesAtAddress(chatCompletions, true), true, "OpenRouter's chat: its uploads are deleted at the old address, with the old key");
  assert.equal(releasesAtAddress(chatCompletions, false), false, "OpenAI's Chat Completions has no switch: its address must not delete the Responses ability's kept turns (2f467adc)");
  assert.equal(releasesAtAddress(responses, false), true, 'turns kept at the old address');
  assert.equal(releasesAtAddress(responses, true), true);
  assert.equal(releasesAtAddress(anthropicMessages, true), false, 'a type that keeps nothing and deletes nothing');
});

test("a booking whose kind is a name Object's prototype has (toString, constructor) draws as an other booking, never throws", () => {
  for (const kind of ['toString', 'constructor', '__proto__']) {
    assert.doesNotThrow(() => bookingFacts({ kind, unsure: [], confirmation: 'TQ1' }), kind);
    assert.ok(bookingFacts({ kind, unsure: [], confirmation: 'TQ1' }).some((f) => f.value === 'TQ1'), kind);
  }
});

test("bookingFacts: every value beside a leg time's clock has its label, whatever its key: a from, a to or a flight in it is a detail of the time, never the leg's route or number (booking-next fix 1: they were drawn without their labels)", () => {
  assert.deepEqual(legLines([{ flight: 'NH 7', departure: { at: '2026-11-20T11:05', from: 'Terminal 1', to: 'Gate B', flight: 'NH 7B', origin: 'SFO', terminal: 'I' } }]),
    ['NH 7 · Nov 20 11:05 (From: Terminal 1 · To: Gate B · Flight: NH 7B · origin: SFO · Terminal: I)']);
  // On both sides, and with the leg's own route beside: the route is still the route.
  assert.deepEqual(legLines([{ flight: 'NH 7', from: 'SFO', to: 'NRT', departure: { at: '2026-11-20T11:05', from: 'Gate A' }, arrival: { at: '2026-11-21T15:40', to: 'Door 3' } }]),
    ['NH 7 · SFO → NRT · Nov 20 11:05 (From: Gate A) – Nov 21 15:40 (To: Door 3)']);
});

test("bookingFacts: a field named like one of the booking's own parts that drew is not drawn, whatever it holds, as on main: a string that says something else, an object, a list, a number; one line, the part's, with the part's check or none (booking-next fix 3: rounds 1 and 2 drew a second line for some, and a differing string with no check at all)", () => {
  const place = { name: 'Hotel X', address: '1 Test Street' };
  const start = { at: '2026-11-20T19:00:00+09:00', tz: TOKYO };
  const cost = { amount: 120, currency: 'USD' };
  const shapes = /** @type {[string, any][]} */ ([
    ['place', { kind: 'lodging', place, fields: { place: 'Hotel X Inn' } }], // words that differ
    ['place', { kind: 'lodging', place, fields: { place: { name: 'Hotel X' } } }], // a partial place
    ['place', { kind: 'lodging', place, fields: { place: { address: '1 Test Street', name: 'Hotel X' } } }], // the whole of it, in any key order
    ['place', { kind: 'lodging', place, fields: { place: ['Hotel X'] } }], // a list
    ['place', { kind: 'lodging', place, fields: { place: 12 } }], // a number
    ['start', { kind: 'ferry', start, fields: { start: '2026-11-20 10:00' } }], // another time, as words
    ['start', { kind: 'ferry', start, fields: { start: { at: '2026-11-20T10:00', tz: TOKYO } } }], // the clock of the same time, with no offset
    ['start', { kind: 'ferry', start, fields: { start: { at: '2026-11-20T01:00', tz: TOKYO } } }], // another time in the same zone
    ['start', { kind: 'ferry', start, fields: { start: { at: '2026-11-20T19:00:00+09:00', tz: TOKYO, terminal: 'Gate 3' } } }], // an extra key
    ['end', { kind: 'ferry', end: start, fields: { end: 'Nov 21, 7:00 AM' } }],
    ['cost', { kind: 'lodging', cost, fields: { cost: 'about 100 dollars' } }],
    ['cost', { kind: 'lodging', cost, fields: { cost: { currency: 'USD', amount: 120 } } }],
    ['cost', { kind: 'lodging', cost, fields: { cost: 120 } }],
    ['confirmation', { kind: 'flight', confirmation: 'ABC123', fields: { confirmation: 'XYZ789 (e-ticket)' } }],
    ['confirmation', { kind: 'flight', confirmation: 'ABC123', fields: { confirmation: ['XYZ789', 'DEF456'] } }],
  ]);
  const was = process.env.TZ;
  try {
    // The same lines, whatever zone the phone is in.
    for (const zone of ['UTC', LA, TOKYO]) {
      process.env.TZ = zone;
      for (const [key, b] of shapes) {
        const alone = bookingFacts({ ...b, unsure: [], fields: {} }).map((x) => x.value);
        // Marked: the part's line and its check. Not marked: the part's line and no check. The chip says the same.
        for (const [unsure, checks] of /** @type {[string[], number][]} */ ([[[key], 1], [[], 0]])) {
          const f = bookingFacts({ ...b, unsure });
          assert.deepEqual(f.map((x) => [x.key, x.unsure]), [[key, checks === 1]], `${zone}: ${key} ${unsure} ${JSON.stringify(b.fields)}`);
          assert.deepEqual(f.map((x) => x.value), alone, `${zone}: ${key} the part's line, as it is with no field`);
          assert.equal(checkCount({ ...b, unsure }), checks, `${zone}: ${key} ${unsure}`);
        }
      }
    }
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
  // The same, beside a field of another name: that one is a line of its own.
  const f = bookingFacts({ kind: 'lodging', unsure: ['place'], place, fields: { place: 'Hotel Y', room: '204' } });
  assert.deepEqual(f.map((x) => [x.key, x.label, x.value, x.unsure]), [['place', 'Place', 'Hotel X, 1 Test Street', true], ['room', 'Room', '204', false]]);
  // A field written as an object with no part of its name that drew is still that part's line (as written), as before.
  assert.deepEqual(bookingFacts({ kind: 'lodging', unsure: ['cost'], fields: { cost: { amount: 120, currency: 'USD' } } }).map((x) => [x.key, x.label, x.value, x.unsure]), [['cost', 'Cost', 'amount: 120 · currency: USD', true]]);
});

test("bookingFacts: the Route line is checked only for a side it draws: from in words with the to an object, marked 'to', checks the To line, not the Route (booking-next fix 1)", () => {
  const route = (/** @type {any} */ b) => bookingFacts({ kind: 'flight', ...b }).map((x) => [x.key, x.value, x.unsure]);
  assert.deepEqual(route({ unsure: ['to'], fields: { from: 'Seattle (SEA)', to: { code: 'ANC' } } }), [['route', 'Seattle (SEA)', false], ['to', 'code: ANC', true]]);
  assert.deepEqual(route({ unsure: ['from'], fields: { from: { code: 'SEA' }, to: 'Anchorage (ANC)' } }), [['route', 'Anchorage (ANC)', false], ['from', 'code: SEA', true]]);
  // A side the Route draws still checks it.
  assert.deepEqual(route({ unsure: ['to'], fields: { from: 'Seattle (SEA)', to: 'Anchorage (ANC)' } }), [['route', 'Seattle (SEA) → Anchorage (ANC)', true]]);
  assert.equal(checkCount({ kind: 'flight', unsure: ['to'], fields: { from: 'Seattle (SEA)', to: { code: 'ANC' } } }), 1);
});
