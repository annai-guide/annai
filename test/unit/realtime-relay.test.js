// The realtime check's one-answer scenarios, without a browser: what a record of each makes, from made-up frames (relay.mjs, and its place in analyseOne).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../../scripts/realtime/analyse.mjs';
import { analyseRelay, passedText, relayTally, AS_SAID } from '../../scripts/realtime/relay.mjs';
import { analyseOne } from '../../scripts/realtime/run.mjs';
import { SCENARIOS } from '../../scripts/realtime/scenarios.mjs';
import { CLIPS as CLIP_DEFS } from '../../scripts/realtime/clips.mjs';

/** @param {number} at @param {string} dir @param {string} kind @param {Record<string, any>} [more] */
const f = (at, dir, kind, more = {}) => ({ at, dir, kind, ...more });
/** A level track: 0 except where she sounds (from, to in ms), every 20 ms. @param {[number, number][]} sounding @param {number} [until] */
const levels = (sounding, until = 60_000) => Array.from({ length: until / 20 }, (_, i) => [i * 20, sounding.some(([a, b]) => i * 20 >= a && i * 20 < b) ? 0.1 : 0.0005]);
const CLIPS = {
  'do-all': { kind: 'relay', words: "Let's do all three of them." },
  'carry-on': { kind: 'relay', words: "Let's carry on in Kyoto." },
  lunch: { kind: 'question', words: 'Where should we stop for lunch?' },
  bixby: { kind: 'question', words: 'How far is it to Bixby Bridge?' },
  sure: { kind: 'reply', words: 'Sure.' },
  bump: { kind: 'noise', words: '' },
  'stop-reminder': { kind: 'relay', words: 'Stop the hotel reminder.' },
};
const NOTE = '<from_kokoro id="n1">What you asked about is about twenty minutes ahead on Highway 1 (source: example.org).</from_kokoro>';
/** @param {Record<string, any>} over @returns {any} */
const rec = (over) => ({ scenario: 's', route: 'speaker', echoDb: null, startedAt: 0, endedAt: 30_000, keyLine: 1, plays: [], frames: [], level: levels([]), trace: [], errors: [], notes: [], ...over });
/** A line said at `at` (1.5 s long), its turn to 700 ms after it, and what she did after: frames from `then`. @param {string} name @param {number} at @param {any[]} then */
const line = (name, at, then) => ({ play: { name, at, end: at + 1500, gainDb: 0 }, frames: [f(at + 200, 'out', 'activityStart'), f(at + 2200, 'out', 'activityEnd'), f(at + 2000, 'in', 'heard', { text: CLIPS[/** @type {keyof typeof CLIPS} */ (name)].words }), ...then] });

test('a line passed on: her tell_kokoro after "One moment.", no question before the note, and Kokoro given the words as said', () => {
  const a1 = line('do-all', 1000, [f(3500, 'in', 'audio', { bytes: 4800 }), f(3550, 'in', 'said', { text: 'One moment.' }), f(3700, 'in', 'toolCall', { name: 'tell_kokoro' }), f(4200, 'in', 'turnComplete'), f(5600, 'out', 'text', { text: NOTE }), f(6000, 'in', 'audio', { bytes: 9600 }), f(6100, 'in', 'said', { text: 'Is it about twenty minutes?' }), f(8000, 'in', 'turnComplete')]);
  const r = rec({ plays: [a1.play], frames: a1.frames, level: levels([[3500, 4200], [6000, 8000]]), kokoro: [{ at: 3800, kind: 'request', text: '[the user typed] earlier\n[Koe asks] "Let\'s do all three of them."' }] });
  const a = analyse(r, CLIPS);
  const out = analyseRelay(r, a, /** @type {any} */ ({ passOn: true, steps: [] }), CLIPS);
  assert.deepEqual(out.checks.map((c) => [c.name, c.ok]), [['passed on', true], ['passed on as said', true]], 'a question mark in the note she says is the note, not hers');
  assert.deepEqual(out.tally.passed, [1, 1]);
  assert.match(out.text[0], /do-all: passed on; she said "One moment\."; Kokoro got "Let's do all three of them\." \(100% of the words\)/);
});

test('a line asked about, or answered with no tell_kokoro, is not passed on; a line in her own words is a warning only; one no turn was made of is not counted', () => {
  const asked = line('do-all', 1000, [f(3500, 'in', 'audio', { bytes: 4800 }), f(3550, 'in', 'said', { text: 'All three of which?' }), f(4200, 'in', 'turnComplete')]);
  const own = line('carry-on', 10_000, [f(12_500, 'in', 'said', { text: 'One moment.' }), f(12_600, 'in', 'toolCall', { name: 'tell_kokoro' }), f(13_000, 'in', 'turnComplete')]);
  const unheard = { name: 'lunch', at: 20_000, end: 21_500, gainDb: 0 };
  const r = rec({ plays: [asked.play, own.play, unheard], frames: [...asked.frames, ...own.frames], kokoro: [{ at: 12_700, kind: 'request', text: '[Koe notes] "They want to keep going"' }] });
  const out = analyseRelay(r, analyse(r, CLIPS), /** @type {any} */ ({ passOn: true, steps: [] }), CLIPS);
  const check = (/** @type {string} */ n) => out.checks.find((c) => c.name === n);
  assert.equal(check('passed on')?.ok, false);
  assert.match(String(check('passed on')?.detail), /^1 of 2 lines passed on with no question back \(1 made no turn, not counted\)$/);
  assert.match(out.text[0], /do-all: NOT passed on \(no tell_kokoro\)/);
  assert.equal(check('passed on as said')?.ok, false);
  assert.equal(check('passed on as said')?.soft, true);
  assert.ok(AS_SAID > 0.5 && AS_SAID < 1);
  // Her own buttons are a question back too.
  const buttons = line('do-all', 1000, [f(3500, 'in', 'toolCall', { name: 'tell_kokoro' }), f(3600, 'in', 'toolCall', { name: 'ask' })]);
  const rb = rec({ plays: [buttons.play], frames: buttons.frames });
  assert.match(analyseRelay(rb, analyse(rb, CLIPS), /** @type {any} */ ({ passOn: true, steps: [] }), CLIPS).text[0], /ASKED BACK/);
});

test("what Kokoro was given is Koe's last line to her, without its quotes", () => {
  assert.equal(passedText('[Koe asks] "Where is it?"\nlater\n[Koe notes] "Let\'s carry on in Kyoto."'), "Let's carry on in Kyoto.");
  assert.equal(passedText('nothing of Koe\'s'), '');
});

test('a request that begins with "stop" is acted on when she passes it on, or does it with a tool of her own and says so; silence, words with no act, or a tool with no word fail', () => {
  /** @param {any[]} then */
  const run = (then) => {
    const l = line('stop-reminder', 1000, then);
    const r = rec({ plays: [l.play], frames: l.frames });
    return analyseRelay(r, analyse(r, CLIPS), /** @type {any} */ ({ acted: true, steps: [] }), CLIPS);
  };
  const call = (/** @type {number} */ at, /** @type {string} */ name) => f(at, 'in', 'toolCall', { name });
  const says = (/** @type {number} */ at, /** @type {string} */ text) => [f(at, 'in', 'audio', { bytes: 4800 }), f(at + 50, 'in', 'said', { text })];
  const passed = run([...says(3500, 'One moment.'), call(3700, 'tell_kokoro'), f(4200, 'in', 'turnComplete')]);
  assert.deepEqual([passed.checks[0].name, passed.checks[0].ok], ['acted on it', true]);
  assert.match(passed.text[0], /^   stop-reminder: acted on \(passed on to Kokoro\)/);
  const own = run([...says(3500, 'Checking your reminders.'), call(3700, 'watch_list'), ...says(4200, 'I found no active hotel reminders.'), f(5000, 'in', 'turnComplete')]);
  assert.equal(own.checks[0].ok, true, 'Koe has the reminder tools by design: its own tool and a spoken answer is not a miss');
  assert.match(own.text[0], /acted on \(her own watch_list and an answer\)/);
  for (const [what, then, how] of /** @type {const} */ ([
    ['silence: the stop clause swallowed it', [f(4200, 'in', 'turnComplete')], 'silence'],
    ['"Okay.": the stop\'s own answer', [...says(3500, 'Okay.'), f(4200, 'in', 'turnComplete')], 'only words, no act'],
    ['a tool and then silence', [call(3700, 'watch_cancel'), f(4200, 'in', 'turnComplete')], 'her own watch_cancel and no word'],
  ])) {
    const out = run([...then]);
    assert.equal(out.checks[0].ok, false, what);
    assert.match(out.text[0], new RegExp(`NOT acted on \\(${how}\\)`));
  }
  // A line no turn was made of proves nothing.
  const l = line('stop-reminder', 1000, []);
  const none = rec({ plays: [l.play], frames: [] });
  assert.equal(analyseRelay(none, analyse(none, CLIPS), /** @type {any} */ ({ acted: true, steps: [] }), CLIPS).checks[0].ok, false);
});

test('an acknowledgement after her answer: sound back from its turn to the next clip fails "acknowledgements left quiet"; it is no question to answer', () => {
  const q = line('lunch', 1000, [f(3500, 'in', 'audio', { bytes: 4800 }), f(5000, 'in', 'turnComplete')]);
  const ack = line('sure', 8000, [f(10_500, 'in', 'audio', { bytes: 4800 }), f(10_600, 'in', 'said', { text: 'Okay.' }), f(11_000, 'in', 'turnComplete')]);
  const loud = rec({ plays: [q.play, ack.play], frames: [...q.frames, ...ack.frames], level: levels([[3500, 5000], [10_500, 11_000]]) });
  const a = analyse(loud, CLIPS, { acks: ['sure'] });
  assert.equal(a.clips.find((c) => c.name === 'sure')?.expect, 'ack');
  assert.match(String(a.checks.find((c) => c.name === 'answered')?.detail), /^1 of 1 questions/);
  const out = analyseRelay(loud, a, /** @type {any} */ ({ acks: ['sure'], steps: [] }), CLIPS);
  assert.deepEqual(out.checks.map((c) => [c.name, c.ok]), [['acknowledgements left quiet', false]]);
  assert.deepEqual(out.tally.acks, [1, 1]);
  assert.match(out.text[0], /sure at 8\.0 s got sound back: "Okay\."/);
  const still = rec({ plays: [q.play, ack.play], frames: [...q.frames, ...ack.frames.filter((x) => x.dir === 'out' || x.kind === 'heard')], level: levels([[3500, 5000]]) });
  assert.equal(analyseRelay(still, analyse(still, CLIPS, { acks: ['sure'] }), /** @type {any} */ ({ acks: ['sure'], steps: [] }), CLIPS).checks[0].ok, true);
});

/** Her line in annai's trace, as the record keeps it: a short text in its data (a longer one is the entry's own text, from its blob). @param {number} at @param {string} text @param {Record<string, any>} [more] */
const speak = (at, text, more = {}) => ({ at, type: 'out.speak', data: { live: true, text, ...more } });
/** annai's card for words of hers the user didn't hear: it shows it when it hears the sound, 62 to 157 ms before the provider's `interrupted` frame (22 real runs). @param {number} at */
const card = (at) => ({ at, type: 'reminder', data: { text: 'What you asked about is about twenty minutes ahead on Highway 1.', unsaid: true, answer: true } });
const WHOLE = "It's about twenty minutes ahead on Highway 1.";

test('a note cut by a noise: shown once, nothing asked again, and heard whole once at most passes; heard twice, asked again, or not shown fails', () => {
  // The provider's burst holds the whole note before her voice is cut (as Gemini's do): what she was making is the measure of "whole".
  const q = line('bixby', 1000, [f(3500, 'in', 'toolCall', { name: 'tell_kokoro' }), f(5600, 'out', 'text', { text: NOTE }), f(6000, 'in', 'audio', { bytes: 9600 }), f(6050, 'in', 'said', { text: "It's about twenty minutes " }), f(6060, 'in', 'said', { text: 'ahead on Highway 1.' })]);
  const bump = { name: 'bump', at: 6100, end: 6900, gainDb: 0 };
  const after = [f(6300, 'out', 'activityStart'), f(6350, 'in', 'interrupted'), f(7600, 'out', 'activityEnd')];
  /** @param {any[]} more @param {any[]} trace */
  const cutRec = (more, trace) => rec({ route: 'headphones', plays: [q.play, bump], frames: [...q.frames, ...after, ...more], level: levels([[6000, 6400], [8000, 10_000]]), trace: [speak(6400, "It's✂", { cut: true }), card(6290), ...trace] });
  const check = (/** @type {any} */ r) => analyseRelay(r, analyse(r, CLIPS, { expectCut: true }), /** @type {any} */ ({ noteCut: true, steps: [] }), CLIPS).checks[0];
  const once = cutRec([f(8000, 'in', 'audio', { bytes: 9600 })], [speak(10_000, WHOLE)]);
  assert.deepEqual([check(once).name, check(once).ok], ['cut note heard once at most', true]);
  assert.match(check(once).detail, /^the note heard whole once after the cut; asked again 0 times; shown once; her lines after it: "It's about twenty minutes ahead on Highway 1\."$/);
  assert.equal(check(cutRec([], [speak(10_000, 'ahead on Highway 1.')])).ok, true, 'her answer going on from the middle: shown, so nothing is lost');
  assert.equal(check(cutRec([], [])).ok, true, 'nothing more of hers');
  const twice = cutRec([], [speak(10_000, WHOLE), speak(14_000, WHOLE)]);
  assert.equal(check(twice).ok, false, 'heard twice (an ask and a "what?" each answered with it)');
  assert.match(check(twice).detail, /the note heard whole 2 times/);
  const asked = cutRec([f(7600, 'out', 'text', { text: "[annai] \"Sound cut you off, so the user didn't hear what Kokoro's note says.\"" })], [speak(10_000, WHOLE)]);
  assert.equal(check(asked).ok, false, 'asked again');
  assert.match(check(asked).detail, /asked again once/);
  assert.equal(check(cutRec([f(9000, 'out', 'text', { text: '[annai] "Kokoro\'s note hasn\'t reached the user."' })], [])).ok, false, 'the plain ask is an ask too');
  const unshown = rec({ route: 'headphones', plays: [q.play, bump], frames: [...q.frames, ...after], trace: [speak(6400, "It's✂", { cut: true })] });
  assert.match(check(unshown).detail, /shown 0 times/);
  assert.equal(check(unshown).ok, false, 'not shown');
  const uncut = rec({ plays: [q.play, bump], frames: q.frames });
  assert.match(check(uncut).detail, /the bump did not cut her/);
  // The entry's own text (a long line, kept in a blob) is read as well as its data's.
  const long = cutRec([], [{ at: 10_000, type: 'out.speak', data: { live: true }, text: WHOLE }, speak(14_000, WHOLE)]);
  assert.match(check(long).detail, /the note heard whole 2 times/);
});

test('"heard whole" is measured against the note: a line that stops short of it ("It\'s about twenty.") is not whole, whatever the provider had made when cut; the card is counted from the sound\'s start', () => {
  // The provider had made only "It's about" when the sound cut her (its words come slower than its sound): her later "It's about twenty." held all of those.
  const q = line('bixby', 1000, [f(3500, 'in', 'toolCall', { name: 'tell_kokoro' }), f(5600, 'out', 'text', { text: NOTE }), f(6000, 'in', 'audio', { bytes: 9600 }), f(6050, 'in', 'said', { text: "It's about " })]);
  const bump = { name: 'bump', at: 6100, end: 6900, gainDb: 0 };
  const after = [f(6300, 'out', 'activityStart'), f(6350, 'in', 'interrupted'), f(7600, 'out', 'activityEnd')];
  /** @param {any[]} trace */
  const cutRec = (trace) => rec({ route: 'headphones', plays: [q.play, bump], frames: [...q.frames, ...after], level: levels([[6000, 6400]]), trace });
  const check = (/** @type {any} */ r) => analyseRelay(r, analyse(r, CLIPS, { expectCut: true }), /** @type {any} */ ({ noteCut: true, steps: [] }), CLIPS).checks[0];
  const part = check(cutRec([speak(6400, "It's✂", { cut: true }), card(6290), speak(10_000, "It's about twenty."), speak(14_000, 'ahead on Highway 1.')]));
  assert.match(part.detail, /^the note heard whole 0 times after the cut; asked again 0 times; shown once;/, 'two parts of it are no whole saying ("It\'s about twenty." held every word she had made when cut)');
  assert.equal(part.ok, true);
  const twice = check(cutRec([speak(6400, "It's✂", { cut: true }), card(6290), speak(10_000, WHOLE), speak(14_000, 'It is about twenty minutes ahead on Highway 1.')]));
  assert.match(twice.detail, /the note heard whole 2 times/);
  assert.equal(twice.ok, false);
  // The card at annai's own detection (before the provider's frame) is shown once; one before the sound began is not the sound's.
  assert.match(check(cutRec([speak(6400, "It's✂", { cut: true }), card(6101)])).detail, /shown once/);
  assert.match(check(cutRec([speak(6400, "It's✂", { cut: true }), card(5900)])).detail, /shown 0 times/);
  // The note's words are read from the note, which is as long as Kokoro wrote it: a whole saying in other words (Opus's) keeps over a third of them.
  const long = { ...q, frames: q.frames.map((x) => (x.kind === 'text' ? { ...x, text: '<from_kokoro id="n1">GPS is off, so annai does not know where the user is. Say: "I can\'t see where you are. Bixby Bridge is about 13 miles south of Carmel on Highway 1. Where are you starting from?"</from_kokoro>' } : x)) };
  const rl = rec({ route: 'headphones', plays: [long.play, bump], frames: [...long.frames, ...after], level: levels([[6000, 6400]]), trace: [speak(6400, 'I can\'t✂', { cut: true }), card(6290), speak(12_000, "I can't see where you are. Bixby Bridge is about thirteen miles south of Carmel on Highway One. Where are you starting from?")] });
  assert.match(check(rl).detail, /the note heard whole once after the cut/);
});

test('a note cut by a spoken "stop": a word like "Okay." after it at most, nothing passed on, shown once, no fresh session or drop passes; more words, a pass-on, a retry fail', () => {
  const q = line('bixby', 1000, [f(3500, 'in', 'toolCall', { name: 'tell_kokoro' }), f(5600, 'out', 'text', { text: NOTE }), f(6000, 'in', 'audio', { bytes: 9600 }), f(6050, 'in', 'said', { text: WHOLE })]);
  const stop = { name: 'stop', at: 6100, end: 6600, gainDb: 0 };
  const after = [f(6300, 'out', 'activityStart'), f(6350, 'in', 'interrupted'), f(7300, 'out', 'activityEnd')];
  const STOPS = { ...CLIPS, stop: { kind: 'stop', words: 'Stop.' } };
  /** @param {any[]} more @param {[number, number][]} sound @param {any[]} [trace] */
  const stopRec = (more, sound, trace = []) => rec({ route: 'headphones', plays: [q.play, stop], frames: [...q.frames, ...after, ...more], level: levels([[6000, 6400], ...sound]), trace: [speak(6400, "It's✂", { cut: true }), card(6290), ...trace] });
  const check = (/** @type {any} */ r) => analyseRelay(r, analyse(r, STOPS, { expectCut: true }), /** @type {any} */ ({ noteCut: 'stop', steps: [] }), STOPS).checks[0];
  const quiet = stopRec([], []);
  assert.deepEqual([check(quiet).name, check(quiet).ok], ['stopped when told', true]);
  assert.match(check(quiet).detail, /^after the "stop": nothing; asked again 0 times; shown once$/);
  assert.equal(analyse(quiet, STOPS, { expectCut: true }).clips.find((c) => c.name === 'stop')?.expect, 'stop', 'no question to answer');
  const okay = stopRec([f(8000, 'in', 'audio', { bytes: 4800 })], [[8000, 8400]], [speak(8500, 'Okay.')]);
  assert.equal(check(okay).ok, true, 'a word is fine');
  assert.match(check(okay).detail, /^after the "stop": "Okay\."/);
  const letGo = stopRec([], [], [{ at: 16_000, type: 'error', data: { kind: 'live-silent', message: 'The live session gave nothing back within 8 seconds of a turn: taken as let go.' } }]);
  assert.equal(check(letGo).ok, true, 'a turn the session let go is its choice');
  assert.match(check(letGo).detail, /the turn was let go/);
  const again = stopRec([f(8000, 'in', 'audio', { bytes: 9600 })], [[8000, 11_000]], [speak(11_000, WHOLE)]);
  assert.equal(check(again).ok, false);
  assert.match(check(again).detail, /^she said "It's about twenty minutes ahead on Highway 1\." after the "stop"/);
  assert.equal(check(stopRec([f(7800, 'in', 'toolCall', { name: 'tell_kokoro' })], [])).ok, false, 'passed on');
  const fresh = stopRec([f(14_500, 'out', 'setup')], [], [{ at: 14_400, type: 'error', data: { kind: 'live-silent', message: 'The live session gave no answer within 8 seconds: a fresh one gets it again.' } }]);
  assert.equal(check(fresh).ok, false, 'retried on a fresh session');
  assert.match(check(fresh).detail, /1 fresh session; live-silent: The live session gave no answer/);
  assert.equal(check(stopRec([], [], [{ at: 22_000, type: 'error', data: { kind: 'live-dropped', message: 'Live voice was dropped.' } }])).ok, false, 'live voice dropped');
});

test('a typed line gets no more lines of hers than it needs: one for a greeting, two for a request; none is a failure too', () => {
  const typed = [{ at: 1000, text: 'Hello?', lines: 1 }, { at: 20_000, text: 'Add to my notes that we parked on level three.', lines: 2 }];
  const one = rec({ endedAt: 40_000, typed, trace: [speak(3000, 'Hi, what can I do?'), speak(22_000, 'One moment.'), speak(26_000, 'Saved: level three.')] });
  const check = (/** @type {any} */ r) => analyseRelay(r, analyse(r, CLIPS), /** @type {any} */ ({ steps: [] }), CLIPS).checks[0];
  assert.deepEqual([check(one).name, check(one).ok], ['one answer to each typed line', true]);
  const twice = rec({ endedAt: 40_000, typed, trace: [...one.trace, speak(9000, 'Hello there!')] });
  assert.equal(check(twice).ok, false);
  assert.match(check(twice).detail, /"Hello\?" 2 of at most 1/);
  assert.match(analyseRelay(twice, analyse(twice, CLIPS), /** @type {any} */ ({ steps: [] }), CLIPS).text[0], /typed "Hello\?": 2 lines \(at most 1\): "Hi, what can I do\?" \/ "Hello there!"/, 'her words read from the record');
  const shown = rec({ endedAt: 40_000, typed: [typed[0]], trace: [speak(3000, 'Hi.'), { at: 9000, type: 'reminder', data: { answer: true, unsaid: true, text: 'Hello.' } }] });
  assert.equal(check(shown).ok, false, 'what annai showed for her counts as a line');
  assert.equal(check(rec({ typed: [typed[0]] })).ok, false, 'no answer at all');
});

test('a reminder said once passes "reminder said once"; said by both halves (her and annai\'s voice), or by nobody, fails', () => {
  const sc = /** @type {any} */ ({ once: 'hotel desk', steps: [] });
  const check = (/** @type {any[]} */ trace) => analyseRelay(rec({ trace }), analyse(rec({ trace }), CLIPS), sc, CLIPS).checks[0];
  assert.deepEqual([check([speak(30_000, "It's time to check in at the hotel desk.")]).name, check([speak(30_000, "It's time to check in at the hotel desk.")]).ok], ['reminder said once', true]);
  const both = check([speak(30_000, 'Check in at the hotel desk.'), { at: 31_000, type: 'reminder', data: { text: 'Check in at the hotel desk.', aloud: true } }]);
  assert.deepEqual([both.ok, both.detail], [false, 'said 2 times']);
  assert.equal(check([{ at: 31_000, type: 'reminder', data: { text: 'Check in at the hotel desk.' } }]).ok, false, 'shown only is not said');
  assert.equal(check([]).ok, false, 'never said');
});

test('the bars over a whole report, each scenario on its own: lines passed on, and acknowledgements with sound back, each said against its bar', () => {
  /** @param {string} scenario @param {any} relay */
  const run = (scenario, relay) => ({ rec: { scenario }, a: { pass: true, relay } });
  assert.deepEqual(relayTally([run('relay-pass', { passed: [4, 5] }), run('relay-ack', { acks: [0, 10] }), run('relay-pass', { passed: [5, 5] }), run('relay-annai', { passed: [5, 5] }), run('relay-ack', { acks: [1, 10] })]), [
    'relay-pass: passed on, no question back, 9 of 10 lines in 2 runs (the bar: at least 9 of 10) MET',
    'relay-ack: acknowledgements with sound back, 1 of 20 in 2 runs (the bar: none in 20) NOT MET',
    'relay-annai: passed on, no question back, 5 of 5 lines in 1 run (the bar: at least 9 of 10; too few lines: --times) NOT MET',
  ]);
  assert.deepEqual(relayTally([run('questions-a', undefined)]), []);
});

test("analyseOne adds the one-answer checks to the general ones, and a turn the session let go is a note, not an error", () => {
  const ack = line('sure', 1000, []);
  const r = rec({ scenario: 'relay-ack', plays: [ack.play], frames: ack.frames, trace: [{ at: 10_000, type: 'error', data: { kind: 'live-silent', message: 'The live session gave nothing back within 8 seconds of a turn: taken as let go.', quiet: true } }] });
  const a = analyseOne(r, CLIPS, SCENARIOS['relay-ack']);
  assert.deepEqual(a.checks.map((c) => [c.name, c.ok]), [['answered', true], ['no echo cut', true], ['turn ends in time', true], ['no errors', true], ['whole sentences heard', true], ['acknowledgements left quiet', true]]);
  assert.equal(a.pass, true);
  assert.ok(a.notes.some((n) => /^let go at 10\.0 s: live-silent/.test(n)));
  assert.deepEqual(/** @type {any} */ (a).relay, { acks: [0, 1] });
});

test('the one-answer scenarios: lines to pass on, ten acknowledgements after answers, a noise or a "stop" into a note in headphones, typed lines with their most lines, a reminder said once', () => {
  const said = (/** @type {any} */ sc) => sc.steps.filter((/** @type {any} */ s) => 'say' in s).map((/** @type {any} */ s) => s.say);
  for (const n of ['relay-pass', 'relay-annai']) {
    assert.equal(SCENARIOS[n].passOn, true);
    assert.equal(said(SCENARIOS[n]).length, 5, 'five lines a run: --times 2 makes the bar\'s ten');
  }
  // Koe has the reminder tools by design (KOE_TOOLS), so a question about a reminder is no line only Kokoro can answer.
  for (const clip of said(SCENARIOS['relay-annai'])) assert.doesNotMatch(String(CLIP_DEFS[clip].text), /remind|timer|alarm/i, clip);
  const acks = SCENARIOS['relay-ack'];
  assert.equal(said(acks).filter((x) => acks.acks?.includes(x)).length, 10, "ten a run: --times 2 makes the bar's twenty");
  acks.steps.forEach((s, i) => { if ('say' in s && acks.acks?.includes(s.say)) assert.ok('answered' in acks.steps[i - 1], 'each said after an answer'); });
  for (const n of ['cut-note', 'cut-note-stop', 'real-cut-note']) {
    assert.equal(SCENARIOS[n].route, 'headphones');
    assert.deepEqual(SCENARIOS[n].steps.slice(1, 3), [{ noteSounding: 100 }, { say: n === 'cut-note-stop' ? 'stop' : 'bump' }]);
    assert.equal(SCENARIOS[n].noteCut, n === 'cut-note-stop' ? 'stop' : true, `${n} is held to the cut note's bar`);
  }
  assert.deepEqual(SCENARIOS['cut-note-stop'].steps.at(-1), { wait: 25_000 }, 'past the 16.5 s a retry and a drop would take');
  assert.deepEqual(said(SCENARIOS['relay-stop-request']), ['stop-reminder']);
  assert.deepEqual([SCENARIOS['relay-stop-request'].acted, SCENARIOS['relay-stop-request'].passOn], [true, undefined]);
  for (const n of ['typed-live', 'real-typed-live']) assert.deepEqual(SCENARIOS[n].steps.flatMap((s) => ('type' in s ? [s.lines] : [])), [1, 2]);
  assert.deepEqual(SCENARIOS['real-typed-plan'].steps.flatMap((s) => ('type' in s ? [s.lines] : [])), [2]);
  assert.deepEqual(SCENARIOS['real-typed-plan'].seed, { plan: true });
  assert.deepEqual([SCENARIOS['real-reminder-live'].seed, SCENARIOS['real-reminder-live'].once], [{ reminderInS: 28 }, 'hotel desk']);
  for (const n of ['real-typed-live', 'real-typed-plan', 'real-reminder-live', 'real-cut-note']) assert.equal(SCENARIOS[n].real, true);
  for (const n of ['relay-pass', 'relay-annai', 'relay-ack', 'cut-note', 'cut-note-stop', 'real-cut-note', 'relay-stop-request', 'typed-live', 'real-typed-live', 'real-typed-plan', 'real-reminder-live']) assert.equal(SCENARIOS[n].extra, true, `${n} is by name only`);
});
