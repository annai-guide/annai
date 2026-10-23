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
  // Review N7: only a rescue (a fresh session, or the ask again) answered before the next clip; a second silence stays an error.
  const second = clean();
  second.trace.push({ at: 9000, type: 'error', data: { kind: 'live-silent', message: 'The live session gave no answer within 8 seconds.', quiet: true } });
  second.frames.push(f(9800, 'in', 'audio', { bytes: 9600 }));
  assert.equal(run(second).checks.find((x) => x.name === 'no errors')?.ok, false);
  const late = clean();
  late.plays.push({ name: 'yes', at: 9500, end: 10_300, gainDb: 0 });
  late.trace.push({ at: 9000, type: 'error', data: { kind: 'live-silent', message: 'The live session gave no answer within 8 seconds: it is asked again.', quiet: true } });
  late.frames.push(f(11_000, 'in', 'audio', { bytes: 9600 }));
  assert.equal(run(late).checks.find((x) => x.name === 'no errors')?.ok, false, 'answered only after the next clip: not rescued');
});

test('the cards annai showed while she listened are in the notes, so one shown for nothing (the talk-over card with nobody talking) shows', () => {
  const a = run(clean({ cards: ['Tap Shiori to talk over her'] }));
  assert.ok(a.notes.some((n) => n === 'card: Tap Shiori to talk over her'), a.notes.join(' | '));
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

// Phase 2: the languages check. A scenario that sets the languages (rec.languages) expects each answer in the language its clip was spoken in.
const LANGS = { ...CLIPS, sure: { kind: 'reply', words: 'Sure.', lang: 'en' }, ja: { kind: 'sentence', words: 'この近くに、おいしいラーメン屋さんはありますか。', lang: 'ja' }, zh: { kind: 'sentence', words: '附近有什么好吃的餐馆吗？', lang: 'zh' } };
/** A rec with one clip played, a turn for it, what Gemini heard and what she said. @param {string} name @param {string} heard @param {string} said @param {Record<string, any>} [over] */
function spoke(name, heard, said, over = {}) {
  return clean({
    plays: [{ name, at: 1000, end: 2780, gainDb: 0 }],
    frames: [
      f(100, 'out', 'setup'), f(500, 'in', 'setupComplete'),
      f(1450, 'out', 'activityStart'), f(1500, 'out', 'audio', { bytes: 3200 }), f(3200, 'out', 'activityEnd'),
      f(3900, 'in', 'heard', { text: heard }), f(4100, 'in', 'audio', { bytes: 9600 }), f(4200, 'in', 'said', { text: said }), f(7000, 'in', 'turnComplete'),
    ],
    languages: { spoken: ['en', 'zh', 'ja'], answer: 'follow', applied: true },
    ...over,
  });
}
const check = (/** @type {any} */ a) => a.checks.find((/** @type {any} */ c) => c.name === 'language kept');

test('language kept: a short English reply heard as English and answered in English passes; no scenario that sets no languages has the check', () => {
  const a = analyse(spoke('sure', 'Sure.', 'Great, I will look into that.'), LANGS);
  assert.equal(check(a)?.ok, true);
  assert.equal(a.pass, true);
  assert.equal(a.clips[0].heardLang, '');
  assert.equal(check(run(clean())), undefined, 'the older scenarios are not held to it');
});

test('language kept: the short reply answered in Spanish, as the trace of 2026-10-22 had it, fails, and what Gemini heard is noted', () => {
  const a = analyse(spoke('sure', '¿Qué?', 'Lo siento, ¿qué quieres decir? No te he entendido bien.'), LANGS);
  assert.equal(check(a)?.ok, false);
  assert.match(check(a)?.detail ?? '', /sure answered in Spanish/);
  assert.equal(a.pass, false);
  assert.equal(a.clips[0].heardLang, 'Spanish');
  assert.ok(a.notes.some((n) => /Gemini heard "¿Qué\?" for "Sure\." \(Spanish\)/.test(n)), a.notes.join(' | '));
});

test('language kept: a Japanese sentence answered in Japanese passes, answered in English or Chinese fails; a Chinese sentence answered in Chinese passes, in Japanese fails', () => {
  const ok = (/** @type {string} */ name, /** @type {string} */ heard, /** @type {string} */ said) => check(analyse(spoke(name, heard, said), LANGS));
  assert.equal(ok('ja', 'この近くにおいしいラーメン屋さんはありますか', '駅の近くに人気のお店がありますよ。').ok, true);
  assert.match(ok('ja', 'この近くにおいしいラーメン屋さんはありますか', 'There is a popular place near the station.').detail, /ja answered in English/);
  assert.match(ok('ja', 'この近くにおいしいラーメン屋さんはありますか', '车站附近有一家很受欢迎的店。').detail, /ja answered in Chinese/);
  assert.equal(ok('zh', '附近有什么好吃的餐馆吗', '车站附近有一家很受欢迎的店。').ok, true);
  assert.match(ok('zh', '附近有什么好吃的餐馆吗', '駅の近くに人気のお店がありますよ。').detail, /zh answered in Japanese/);
});

test('language kept: an answer too short to place passes; no transcript of her words is a note, not a failure', () => {
  assert.equal(check(analyse(spoke('sure', 'Sure.', 'Mm.'), LANGS))?.ok, true);
  const none = analyse(spoke('sure', 'Sure.', ''), LANGS);
  assert.equal(check(none)?.ok, true);
  assert.ok(none.notes.some((n) => /sure: no transcript of what she said/.test(n)), none.notes.join(' | '));
});

test('wordRecall reads Japanese and Chinese by character, as they have no spaces between words', () => {
  assert.equal(wordRecall('この近くにおいしいラーメン屋さんはありますか。', 'この近くにおいしいラーメン屋さんはありますか'), 1);
  assert.ok(wordRecall('この近くにおいしいラーメン屋さんはありますか。', 'どこにありますか') < 0.5);
  assert.equal(wordRecall('附近有什么好吃的餐馆吗？', '附近有什么好吃的餐馆吗'), 1);
});

test('the notes carry what annai did with the languages: the setup frame\'s hints, a heard line it flagged as stray, and a build with no setting', () => {
  const r = spoke('sure', '¿Qué?', 'Sorry, could you say that again?');
  r.frames[0] = f(100, 'out', 'setup', { text: 'languageCodes en,zh-Hans,ja; the instructions have a Languages section' });
  r.trace.push({ at: 3950, type: 'heard', actor: 'user', data: { text: '¿Qué?', strayLanguage: 'Spanish' } });
  const a = analyse(r, LANGS);
  assert.ok(a.notes.some((n) => n === 'setup: languageCodes en,zh-Hans,ja; the instructions have a Languages section'), a.notes.join(' | '));
  assert.ok(a.notes.some((n) => /annai flagged the heard line "¿Qué\?" as Spanish/.test(n)), a.notes.join(' | '));
  const old = analyse(spoke('sure', 'Sure.', 'Great.', { languages: { spoken: ['en'], answer: 'follow', applied: false, why: 'this build of annai has no languages setting' } }), LANGS);
  assert.ok(old.notes.some((n) => /languages setting not applied: this build of annai has no languages setting/.test(n)), old.notes.join(' | '));
  assert.match(detail(r, a), /languages set: en, zh, ja; she answers in: follow\n/);
});

test('detail names the language each clip was heard and answered in, when it is not the clip\'s', () => {
  const r = spoke('sure', '¿Qué?', 'Lo siento, ¿qué quieres decir? No te he entendido bien.');
  assert.match(detail(r, analyse(r, LANGS)), /heard: "¿Qué\?".*\[heard as Spanish\].*\[answered in Spanish\]/);
});

test('the timeline shows the words of a heard line annai wrote, and marks one it flagged as stray', () => {
  const r = clean();
  r.trace.push({ at: 3950, type: 'heard', actor: 'user', data: { text: '¿Qué?', strayLanguage: 'Spanish' } }, { at: 4000, type: 'heard', actor: 'user', data: { text: 'Yes.' } });
  const text = timeline(r, run(r));
  assert.match(text, /trace\s+heard "¿Qué\?" STRAY\(Spanish\)/);
  assert.match(text, /trace\s+heard "Yes\."\n/);
});
