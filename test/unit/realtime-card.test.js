import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../../scripts/realtime/analyse.mjs';
import { analyseCard, asrLines, cardOutcome, heardIn, heardLines, tidy, usageOf } from '../../scripts/realtime/card.mjs';
import { latenessReport, lineRows, percentile, stats } from '../../scripts/realtime/lateness.mjs';
import { readTripResult } from '../../scripts/realtime/kokoro.mjs';

// Stage 5's card with real speech (docs/testing/realtime-check.md): what the analysis makes of a record, without a browser.

/** @param {number} at @param {string} dir @param {string} kind @param {Record<string, any>} [more] */
const f = (at, dir, kind, more = {}) => ({ at, dir, kind, ...more });
const CLIPS = { tomorrow: { kind: 'card', words: "What's on tomorrow in Testville?" }, yes: { kind: 'card', words: 'Yes.' }, 'no-wait': { kind: 'card', words: 'No, wait.' } };

/** A record of the card: Testville asked about at 1000..2800, the card at 6000, its question said 6100..8800, "Yes." played 9800..10640, heard at the socket 11500, written down 14000, granted 17000. */
/** @returns {any} */
function granted(over = {}) {
  return {
    scenario: 'card-yes', route: 'speaker', echoDb: null, startedAt: 0, endedAt: 25_000, keyLine: 1, mode: undefined,
    plays: [{ name: 'tomorrow', at: 1000, end: 2580, gainDb: 0 }, { name: 'yes', at: 9800, end: 10_640, gainDb: 0 }],
    frames: [
      f(100, 'out', 'setup'), f(1450, 'out', 'activityStart'), f(3200, 'out', 'activityEnd'), f(3500, 'in', 'heard', { text: "What's on tomorrow in Testville?" }),
      f(10_100, 'out', 'activityStart'), f(11_300, 'out', 'activityEnd'), f(11_500, 'in', 'heard', { text: 'Yes.' }),
    ],
    level: [], micLevel: [],
    trace: [
      { at: 4500, type: 'heard', data: { id: 'h1', text: "What's on tomorrow in Testville?" } },
      { at: 6000, type: 'out.ask', data: { own: true, question: 'Read Testville, Nov 10 – 17?', options: ['Allow', 'Always for my trips', 'Not now'] } },
      { at: 14_000, type: 'heard', data: { id: 'h2', text: 'Yes.', dismissed: true, gate: 'chatter' } },
      { at: 17_000, type: 'trip.grant', data: { trip: 't', how: 'voice' } },
      { at: 17_010, type: 'trip.read', data: { trip: 't' } },
      { at: 17_020, type: 'tool.result', data: { name: 'read_trip', ok: true, content: 'From "Testville" (t), another of the user\'s trips' } },
    ],
    errors: [], notes: [], media: [{ at: 6100, kind: 'playing', seconds: 2.68, time: 0 }, { at: 8800, kind: 'ended', seconds: 2.68, time: 2.68 }],
    kokoro: [{ at: 17_030, kind: 'request', text: "[heard]\nWhat's on tomorrow in Testville?\n[Koe asks] \"...\"" }],
    ...over,
  };
}

test('the card: a spoken yes is a grant by voice, and the times are from the end of the user\'s word', () => {
  const rec = granted();
  const base = analyse(rec, CLIPS);
  const c = cardOutcome(rec, base);
  assert.equal(c.kind, 'granted-voice');
  assert.equal(c.card?.question, 'Read Testville, Nov 10 – 17?');
  assert.equal(c.qStart, 6100);
  assert.equal(c.qEnd, 8800);
  assert.equal(c.lastEnd, 10_640);
  assert.equal(c.ms.heardEntry, 14_000 - 10_640);
  assert.equal(c.ms.grant, 17_000 - 10_640);
  assert.equal(c.ms.read, 17_010 - 10_640);
  const lines = c.lines;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].final, 'Yes.');
  assert.equal(lines[0].dismissed, true);
  assert.equal(lines[0].clip?.name, 'yes');
  assert.deepEqual([lines[0].chunks.length, lines[0].yes0, lines[0].yesFinal], [1, true, true]);
  const a = analyseCard(rec, base, { expect: { grant: 'voice' } });
  assert.deepEqual(a.checks.map((x) => [x.name, x.ok]), [['card shown', true], ['question said', true], ['card resolved', true], ['granted by voice', true]]);
  assert.match(a.text.join('\n'), /outcome: granted-voice \(grant how=voice, 6\.36 s after the last clip ended/);
});

test('a no that the rule says no to is a failure when it granted, and one that never resolved says so', () => {
  const rec = granted({ scenario: 'card-yes-but' });
  const base = analyse(rec, CLIPS);
  const a = analyseCard(rec, base, { expect: { grant: false } });
  assert.equal(a.checks.find((x) => x.name === 'no grant')?.ok, false);
  const open = granted({ trace: granted().trace.slice(0, 3) });
  const none = analyseCard(open, analyse(open, CLIPS), { expect: { grant: false } });
  assert.equal(cardOutcome(open, analyse(open, CLIPS)).kind, 'none');
  assert.equal(none.checks.find((x) => x.name === 'card resolved')?.ok, false);
  assert.equal(analyseCard(open, analyse(open, CLIPS), { expect: { grant: false, open: true } }).checks.find((x) => x.name === 'card resolved')?.ok, true);
});

test('the lines Koe heard: the entry, its later revisions and the socket chunks, and when the first words alone were a yes', () => {
  const rec = granted({
    plays: [{ name: 'yes', at: 1000, end: 4000, gainDb: 0 }],
    frames: [f(1200, 'out', 'activityStart'), f(4300, 'out', 'activityEnd'), f(4900, 'in', 'heard', { text: 'Yes' }), f(6500, 'in', 'heard', { text: ', but not that one.' })],
    trace: [{ at: 5200, type: 'heard', data: { id: 'h1', text: 'Yes' } }, { at: 7000, type: 'heard.text', data: { of: 'h1', text: 'Yes, but not that one.' } }],
  });
  const [l] = heardLines(rec, analyse(rec, CLIPS));
  assert.equal(l.text0, 'Yes');
  assert.equal(l.final, 'Yes, but not that one.');
  assert.deepEqual(l.revisions.map((r) => r.at), [7000]);
  assert.equal(l.chunks.length, 2);
  assert.deepEqual([l.yes0, l.yesFinal], [true, false]);
  assert.equal(l.maxGapMs, 1800);
  const rows = lineRows([{ rec, file: 'x' }], CLIPS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entryToLastRevision, 1800);
  assert.equal(rows[0].clipToLastRevision, 3000);
  assert.equal(rows[0].firstYesNotWhole, true);
  assert.equal(rows[0].socketPrefixYesNotWhole, true);
  assert.match(latenessReport(rows, 3), /The first words alone read as a yes when the whole line did not: at annai's entry 1, at some socket chunk 1, of 1 lines/);
  assert.match(latenessReport(rows, 1), /With a settle of 1 s, 0 of 1 lines/);
});

test('classic voice: the n-th speech-to-text request is the n-th clip\'s, and what was written down is when it was answered', () => {
  const rec = granted({ mode: 'classic', frames: [], kokoro: [{ at: 2000, kind: 'asr', text: "What's on tomorrow in Testville?", ms: 300, status: 200 }, { at: 11_000, kind: 'asr', text: 'Yes.', ms: 200, status: 200 }] });
  const [a, b] = asrLines(rec);
  assert.equal(a.clip?.name, 'tomorrow');
  assert.equal(b.clip?.name, 'yes');
  assert.equal(b.afterClip, 11_200 - 10_640);
  assert.equal(cardOutcome(rec, analyse(rec, CLIPS)).ms.writeDown, 11_200 - 10_640);
});

test('the words of the user that Shiori was given, and a read_trip result told from its refusal', () => {
  assert.deepEqual(heardIn("[heard]\nYes, but not that one.\n[heard] No, wait.\n[Koe asks] \"x\""), ['Yes, but not that one.', 'No, wait.']);
  assert.deepEqual(heardIn('The user said:\n系。 (heard; may be misheard as Chinese)\n<now>'), ['系。']);
  assert.equal(tidy('<no speech>{pause}Yes. '), 'Yes.');
  const use = (/** @type {string} */ content, error = false) => [{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_trip', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content, ...(error ? { is_error: true } : {}) }] }];
  assert.deepEqual(readTripResult(use('From "Testville" (t), another of the user\'s trips')), { text: 'From "Testville" (t), another of the user\'s trips', denied: false });
  assert.equal(readTripResult(use('Not read: only a tap on annai\'s card, or a yes it hears, allows reading "Testville".'))?.denied, true);
  assert.equal(readTripResult(use('The user tapped Not now: don\'t read "Testville".'))?.denied, true);
  assert.equal(readTripResult([{ role: 'user', content: 'a line' }]), null);
});

test('percentiles by nearest rank, and what a record\'s model turns cost', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.deepEqual(stats([]), { n: 0, median: null, p90: null, p95: null, max: null });
  const rec = granted({ trace: [{ at: 1, type: 'model.turn', data: { answeredBy: 'claude-opus-5-5', usage: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } } }, { at: 2, type: 'model.turn', data: { answeredBy: 'kokoro-model', usage: { input: 400, output: 20 } } }] });
  const u = usageOf(rec);
  assert.equal(u['claude-opus-5-5'].usd, 4 + 2);
  assert.equal(u['kokoro-model'].usd, null);
  assert.equal(u['claude-opus-5-5'].calls, 1);
});
