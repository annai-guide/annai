import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, timeline, wordRecall, summary, detail } from '../../scripts/realtime/analyse.mjs';

/** A level track: 0 except where she sounds (from, to in ms), every 20 ms. @param {[number, number][]} sounding @param {number} [until] */
const levels = (sounding, until = 20_000) => Array.from({ length: until / 20 }, (_, i) => [i * 20, sounding.some(([a, b]) => i * 20 >= a && i * 20 < b) ? 0.1 : 0.0005]);
/** @param {number} at @param {string} dir @param {string} kind @param {Record<string, any>} [more] */
const f = (at, dir, kind, more = {}) => ({ at, dir, kind, ...more });

/** One clean question: "lunch" says 1000..2780, annai sends activityStart 1450 .. activityEnd 3200, she answers 4100..7000. */
/** @returns {any} */
function clean(over = {}) {
  return {
    scenario: 'q', route: 'speaker', echoDb: null, startedAt: 0, endedAt: 12_000, keyLine: 1,
    plays: [{ name: 'lunch', at: 1000, end: 2780, gainDb: 0 }],
    frames: [
      f(100, 'out', 'setup'), f(500, 'in', 'setupComplete'),
      f(1450, 'out', 'activityStart'), f(1500, 'out', 'audio', { bytes: 3200 }), f(3200, 'out', 'activityEnd'),
      f(3900, 'in', 'heard', { text: 'Where should we stop for lunch?' }),
      f(4100, 'in', 'audio', { bytes: 9600 }), f(4200, 'in', 'said', { text: 'Try Nepenthe.' }), f(7000, 'in', 'turnComplete'),
    ],
    level: levels([[4160, 7100]]),
    trace: [{ at: 3200, type: 'live.turn', data: { end: 'pause', ms: 1700, floorDb: -60, peakDb: -20 } }],
    errors: [], notes: [],
    ...over,
  };
}
const CLIPS = { lunch: { kind: 'question', words: 'Where should we stop for lunch?' }, yes: { kind: 'yes', words: 'Yes.' }, pause: { kind: 'pause', words: 'Um, find dinner somewhere with a view.' }, silence: { kind: 'silence', words: '' } };
const run = (/** @type {any} */ r) => analyse(r, CLIPS);

test('a clean question: one turn, ended 420 ms after she stopped speaking, answered at once, every check passes', () => {
  const a = run(clean());
  assert.equal(a.turns.length, 1);
  assert.equal(a.clips[0].name, 'lunch');
  assert.equal(a.clips[0].endLagMs, 420);
  assert.equal(a.clips[0].firstAudioMs, 4100 - 2780);
  assert.equal(a.clips[0].firstSoundMs, 4160 - 2780);
  assert.equal(a.clips[0].answered, true);
  assert.equal(a.turns[0].reason, 'pause');
  assert.deepEqual(a.checks.map((c) => [c.name, c.ok]), [['answered', true], ['no echo cut', true], ['turn ends in time', true], ['no errors', true], ['whole sentences heard', true]]);
  assert.equal(a.pass, true);
});

test('a turn that ends 2.6 s after the user stopped fails "turn ends in time"', () => {
  const r = clean();
  r.frames = r.frames.map((x) => (x.kind === 'activityEnd' ? { ...x, at: 5380 } : x));
  const a = run(r);
  assert.equal(a.clips[0].endLagMs, 2600);
  assert.equal(a.checks.find((c) => c.name === 'turn ends in time')?.ok, false);
  assert.equal(a.pass, false);
});

test('a question no turn was made of is "not heard": unanswered, and no turn to time', () => {
  const r = clean();
  r.frames = r.frames.filter((x) => !['activityStart', 'activityEnd', 'audio'].includes(x.kind) || x.dir === 'in').filter((x) => x.kind !== 'heard' && x.kind !== 'said' && !(x.kind === 'audio'));
  const a = run(r);
  assert.equal(a.clips[0].turns, 0);
  assert.equal(a.clips[0].answered, false);
  assert.equal(a.checks.find((c) => c.name === 'answered')?.ok, false);
});

test('a turn the user did not make, begun while she sounded, is her echo: it fails "no echo cut", and an interrupted that follows it is counted', () => {
  const r = clean();
  r.frames.push(f(5000, 'out', 'activityStart'), f(5600, 'out', 'activityEnd'), f(5650, 'in', 'interrupted'));
  const a = run(r);
  assert.equal(a.turns.length, 2);
  assert.equal(a.turns[1].spurious, true);
  assert.equal(a.turns[1].echo, true);
  assert.equal(a.cuts.length, 1);
  assert.equal(a.cuts[0].cause, 'echo');
  assert.equal(a.checks.find((c) => c.name === 'no echo cut')?.ok, false);
});

test('a turn begun in quiet with no clip is a noise turn: spurious, but not her echo', () => {
  const r = clean();
  r.frames.push(f(9000, 'out', 'activityStart'), f(9400, 'out', 'activityEnd'));
  const a = run(r);
  assert.equal(a.turns[1].spurious, true);
  assert.equal(a.turns[1].echo, false);
  assert.equal(a.checks.find((c) => c.name === 'no echo cut')?.ok, true);
  assert.ok(a.notes.some((n) => /noise|nobody/.test(n)));
});

test('the user speaking over her (the next clip begins while she sounds) is a cut by the user, not by echo', () => {
  const r = clean();
  r.plays.push({ name: 'lunch', at: 5000, end: 6780, gainDb: 0 });
  r.frames.push(f(5300, 'out', 'activityStart'), f(5350, 'in', 'interrupted'), f(7000, 'out', 'activityEnd'));
  r.level = levels([[4150, 5400]]);
  const a = run(r);
  assert.equal(a.cuts[0].cause, 'user');
  assert.equal(a.checks.find((c) => c.name === 'no echo cut')?.ok, true);
});

test('a sentence with a thinking pause that is cut in two is noted as split, and passes when the last half is answered in time', () => {
  const r = clean();
  r.plays = [{ name: 'pause', at: 1000, end: 7000, gainDb: 0 }];
  r.frames = [
    f(1450, 'out', 'activityStart'), f(3300, 'out', 'activityEnd'),
    f(5200, 'out', 'activityStart'), f(7400, 'out', 'activityEnd'),
    f(8300, 'in', 'audio', { bytes: 4800 }), f(11_000, 'in', 'turnComplete'),
  ];
  r.level = levels([[8350, 11_000]]);
  r.trace = [];
  const a = run(r);
  assert.equal(a.clips[0].turns, 2);
  assert.equal(a.clips[0].endLagMs, 400);
  assert.ok(a.notes.some((n) => /split/i.test(n)));
  assert.equal(a.pass, true);
});

test('silence expects no turn at all: a quiet session is clean and passes', () => {
  const r = clean();
  r.plays = [{ name: 'silence', at: 1000, end: 9000, gainDb: 0 }];
  r.frames = [f(500, 'in', 'setupComplete')];
  r.level = levels([]);
  r.trace = [];
  const a = run(r);
  assert.equal(a.clips[0].expect, 'nothing');
  assert.equal(a.clips[0].answered, null);
  assert.equal(a.pass, true);
});

test('an error in the trace or a close with a code fails "no errors", with its words', () => {
  const r = clean();
  r.trace.push({ at: 9000, type: 'error', data: { kind: 'live-silent', message: 'The live session gave no answer within 8 seconds.' } });
  r.frames.push(f(9500, 'in', 'close', { code: 1011, reason: 'internal' }));
  const a = run(r);
  const c = a.checks.find((x) => x.name === 'no errors');
  assert.equal(c?.ok, false);
  assert.match(String(c?.detail), /live-silent/);
  assert.match(String(c?.detail), /1011/);
});

// realtime-fix2 P5: a "yes" answered only with already_told is silence the watchdog rescues; the user is answered, late.
test('a silent session the watchdog rescued, with her answer after it, is a note, not an error; with none after, it stays an error', () => {
  const r = clean();
  r.endedAt = 20_000;
  r.trace.push({ at: 9000, type: 'error', data: { kind: 'live-silent', message: 'The live session gave no answer within 8 seconds: a fresh one gets it again.', quiet: true } });
  r.frames.push(f(9800, 'in', 'audio', { bytes: 9600 }), f(11_000, 'in', 'turnComplete'));
  const a = run(r);
  assert.equal(a.checks.find((x) => x.name === 'no errors')?.ok, true);
  assert.ok(a.notes.some((n) => /rescued/.test(n) && /live-silent|8 seconds/.test(n)), a.notes.join(' | '));
  assert.equal(a.pass, true);
});

test('what Gemini heard is joined from the transcript frames of a turn and scored against the words said', () => {
  const a = run(clean());
  assert.equal(a.clips[0].heard, 'Where should we stop for lunch?');
  assert.equal(a.clips[0].recall, 1);
  assert.equal(wordRecall('Where should we stop for lunch?', 'where should we stop for lunch'), 1);
  assert.equal(wordRecall('Is there a gas station?', 'is there a gas'), 0.8);
  assert.equal(wordRecall('Yes.', ''), 0);
});

test('timeline: every source in one list, in time order, from the session open, with the user turn explained', () => {
  const r = clean();
  r.trace.push({ at: 4300, type: 'out.speak', data: { cut: false, live: true, voice: true }, text: 'Try Nepenthe.' });
  const lines = timeline(r, run(r)).split('\n');
  assert.ok(lines.length > 8);
  const times = lines.map((l) => Number.parseFloat(l.slice(0, 9)));
  assert.deepEqual([...times].sort((x, y) => x - y), times);
  assert.match(lines.join('\n'), /mic .*say lunch/);
  assert.match(lines.join('\n'), /activityEnd.*0\.42 s after the clip ended/);
  assert.match(lines.join('\n'), /first audio.*1\.32 s/);
  assert.match(lines.join('\n'), /trace .*out\.speak.*Try Nepenthe/);
});

test('summary: a line a scenario, the checks, and the verdict', () => {
  const rec = clean();
  const s = summary([{ rec, a: run(rec) }], { sessions: 1, lines: [1] });
  assert.match(s, /q\b.*PASS/);
  assert.match(s, /1 realtime session/);
  assert.match(s, /overall: PASS/);
});

test('detail: each clip with its turn, its heard words and its timing; each check; the notes', () => {
  const r = clean();
  const text = detail(r, run(r));
  assert.match(text, /== q: PASS/);
  assert.match(text, /lunch .*1 turn \(1\.75 s sent\), ended by pause, 0\.42 s after the user stopped; audio back 1\.32 s after the user stopped/);
  assert.match(text, /heard: "Where should we stop for lunch\?" \(100% of the words\)/);
  assert.match(text, /ok   answered/);
});

test('the tools she called before her first sound are listed with the clip: they are why an answer came late', () => {
  const r = clean();
  r.frames.splice(5, 0, f(3600, 'in', 'toolCall', { name: 'list' }), f(3800, 'in', 'toolCall', { name: 'read' }));
  const a = run(r);
  assert.deepEqual(a.clips[0].tools, ['list', 'read']);
  assert.match(detail(r, a), /after list, read/);
});

test('a question begun as her sound began is "spoken over her": no turn is expected of a half-duplex phone, and it is said so', () => {
  const r = clean();
  r.plays.push({ name: 'lunch', at: 4000, end: 5780, gainDb: 0 });
  r.level = levels([[4150, 7100]]);
  const a = run(r);
  const second = a.clips[1];
  assert.equal(second.turns, 0);
  assert.equal(second.overHer, true);
  assert.ok(a.notes.some((n) => /over her/.test(n)));
});

test('a scenario that expects her to be cut by the user fails when she was not, and passes when she was', () => {
  const r = clean();
  assert.equal(analyse(r, CLIPS, { expectCut: true }).checks.find((c) => c.name === 'she is cut by the user')?.ok, false);
  r.plays.push({ name: 'lunch', at: 5000, end: 6780, gainDb: 0 });
  r.frames.push(f(5300, 'out', 'activityStart'), f(5350, 'in', 'interrupted'), f(7000, 'out', 'activityEnd'));
  r.level = levels([[4150, 5400]]);
  assert.equal(analyse(r, CLIPS, { expectCut: true }).checks.find((c) => c.name === 'she is cut by the user')?.ok, true);
});

test('the echo the microphone carried is measured against her own level while no clip played, so a run says whether its echo mode worked', () => {
  const r = clean();
  // she plays at 0.1 rms from 4160 to 7100; the microphone carries 0.025 (-12 dB) of it, plus a room at 0.001, and a clip until 2780
  r.micLevel = Array.from({ length: 600 }, (_, i) => [i * 20, i * 20 >= 4160 && i * 20 < 7100 ? 0.025 : 0.001]);
  r.echoDb = -12;
  const a = run(r);
  assert.ok(Math.abs((a.echoMeasuredDb ?? 99) - -12) < 0.5, String(a.echoMeasuredDb));
  r.micLevel = Array.from({ length: 600 }, (_, i) => [i * 20, 0.001]);
  assert.ok(run(r).notes.some((n) => /echo/.test(n) && /did not reach/.test(n)));
});

test('a quick reply 150 ms after she stopped is not "over her": if it makes no turn, that is a failure, not the design', () => {
  const r = clean();
  r.plays.push({ name: 'yes', at: 7250, end: 8100, gainDb: 0 });
  const a = run(r);
  assert.equal(a.clips[1].overHer, false);
  assert.equal(a.clips[1].answered, false);
  assert.equal(a.checks.find((c) => c.name === 'answered')?.ok, false);
});

test('a sentence cut at its thinking pause and answered half-heard is a warning, not a failure: coverage and recall are in the clip, the soft check says which', () => {
  const r = clean();
  r.plays = [{ name: 'pause', at: 1000, end: 7000, gainDb: 0 }];
  r.frames = [
    f(1450, 'out', 'activityStart'), f(1500, 'out', 'audio', { bytes: 3200 }), f(4500, 'out', 'activityEnd'),
    f(4800, 'in', 'heard', { text: 'Um, find dinner' }), f(5200, 'in', 'audio', { bytes: 4800 }), f(9000, 'in', 'turnComplete'),
  ];
  r.level = levels([[5250, 9000]]);
  r.trace = [];
  const a = run(r);
  assert.equal(a.clips[0].sentMs, 3050);
  assert.ok(a.clips[0].coverage < 0.6, String(a.clips[0].coverage));
  const soft = a.checks.find((c) => c.name === 'whole sentences heard');
  assert.equal(soft?.ok, false);
  assert.equal(soft?.soft, true);
  assert.match(String(soft?.detail), /pause.*51%|pause.*5\d%/);
  assert.equal(a.pass, true, 'a warning does not fail the scenario');
  assert.deepEqual(a.warnings, ['whole sentences heard']);
  assert.match(summary([{ rec: r, a }], { sessions: 1, lines: [1] }), /overall: PASS \(1 warning\)/);
});

test('a clean run has no warnings, and says nothing of them', () => {
  const a = run(clean());
  assert.deepEqual(a.warnings, []);
  assert.equal(a.checks.find((c) => c.name === 'whole sentences heard')?.ok, true);
  assert.doesNotMatch(summary([{ rec: clean(), a }], { sessions: 1, lines: [] }), /warning/);
});
