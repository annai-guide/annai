// The realtime check's one-answer scenarios, without a browser: what a record of each makes, from made-up frames (relay.mjs, and its place in analyseOne).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../../scripts/realtime/analyse.mjs';
import { analyseRelay, passedText, relayTally, AS_SAID } from '../../scripts/realtime/relay.mjs';
import { analyseOne } from '../../scripts/realtime/run.mjs';
import { SCENARIOS } from '../../scripts/realtime/scenarios.mjs';

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

test('a note cut by a noise: cut, asked for again once, and said again from its start passes; from its middle, asked twice, or shown too, fails', () => {
  const q = line('bixby', 1000, [f(3500, 'in', 'toolCall', { name: 'tell_kokoro' }), f(5600, 'out', 'text', { text: NOTE }), f(6000, 'in', 'audio', { bytes: 9600 }), f(6050, 'in', 'said', { text: "It's about" })]);
  const bump = { name: 'bump', at: 6100, end: 6900, gainDb: 0 };
  const after = [f(6300, 'out', 'activityStart'), f(6350, 'in', 'interrupted'), f(7600, 'out', 'activityEnd'), f(7650, 'out', 'text', { text: "[annai] \"Sound cut you off, so the user didn't hear what Kokoro's note says. Say it again, without changing what it claims.\"" })];
  /** @param {any[]} more @param {any[]} [trace] */
  const cutRec = (more, trace = []) => rec({ route: 'headphones', plays: [q.play, bump], frames: [...q.frames, ...after, ...more], level: levels([[6000, 6400], [8000, 10_000]]), trace });
  const check = (/** @type {any} */ r) => analyseRelay(r, analyse(r, CLIPS, { expectCut: true }), /** @type {any} */ ({ noteCut: true, steps: [] }), CLIPS).checks[0];
  const whole = [f(8000, 'in', 'audio', { bytes: 9600 }), f(8100, 'in', 'said', { text: "It's about twenty minutes ahead on Highway 1." })];
  assert.deepEqual([check(cutRec(whole)).name, check(cutRec(whole)).ok], ['cut note said again', true]);
  assert.match(check(cutRec(whole)).detail, /asked again once; after it she said "It's about twenty minutes ahead on Highway 1\." \(from its start\)/);
  assert.equal(check(cutRec([f(8100, 'in', 'said', { text: 'ahead on Highway 1.' })])).ok, false, 'taken up from its middle');
  assert.equal(check(cutRec([...whole, f(9000, 'out', 'text', { text: '[annai] "Sound cut you off, again."' })])).ok, false, 'asked twice');
  assert.equal(check(cutRec(whole, [{ at: 9500, type: 'reminder', data: { unsaid: true, answer: true } }])).ok, false, 'annai showed it as well');
  const uncut = rec({ plays: [q.play, bump], frames: q.frames });
  assert.match(check(uncut).detail, /did not cut her/);
});

test('a typed line gets no more lines of hers than it needs: one for a greeting, two for a request; none is a failure too', () => {
  const typed = [{ at: 1000, text: 'Hello?', lines: 1 }, { at: 20_000, text: 'Add to my notes that we parked on level three.', lines: 2 }];
  const speak = (/** @type {number} */ at, /** @type {string} */ text) => ({ at, type: 'out.speak', data: { live: true }, text });
  const one = rec({ endedAt: 40_000, typed, trace: [speak(3000, 'Hi, what can I do?'), speak(22_000, 'One moment.'), speak(26_000, 'Saved: level three.')] });
  const check = (/** @type {any} */ r) => analyseRelay(r, analyse(r, CLIPS), /** @type {any} */ ({ steps: [] }), CLIPS).checks[0];
  assert.deepEqual([check(one).name, check(one).ok], ['one answer to each typed line', true]);
  const twice = rec({ endedAt: 40_000, typed, trace: [...one.trace, speak(9000, 'Hello there!')] });
  assert.equal(check(twice).ok, false);
  assert.match(check(twice).detail, /"Hello\?" 2 of at most 1/);
  const shown = rec({ endedAt: 40_000, typed: [typed[0]], trace: [speak(3000, 'Hi.'), { at: 9000, type: 'reminder', data: { answer: true, unsaid: true }, text: 'Hello.' }] });
  assert.equal(check(shown).ok, false, 'what annai showed for her counts as a line');
  assert.equal(check(rec({ typed: [typed[0]] })).ok, false, 'no answer at all');
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

test('the one-answer scenarios: lines to pass on, ten acknowledgements after answers, a noise into a note in headphones, typed lines with their most lines', () => {
  const said = (/** @type {any} */ sc) => sc.steps.filter((/** @type {any} */ s) => 'say' in s).map((/** @type {any} */ s) => s.say);
  for (const n of ['relay-pass', 'relay-annai']) {
    assert.equal(SCENARIOS[n].passOn, true);
    assert.equal(said(SCENARIOS[n]).length, 5, 'five lines a run: --times 2 makes the bar\'s ten');
  }
  const acks = SCENARIOS['relay-ack'];
  assert.equal(said(acks).filter((x) => acks.acks?.includes(x)).length, 10, "ten a run: --times 2 makes the bar's twenty");
  acks.steps.forEach((s, i) => { if ('say' in s && acks.acks?.includes(s.say)) assert.ok('answered' in acks.steps[i - 1], 'each said after an answer'); });
  const cut = SCENARIOS['cut-note'];
  assert.equal(cut.route, 'headphones');
  assert.deepEqual(cut.steps.slice(1, 3), [{ noteSounding: 100 }, { say: 'bump' }]);
  for (const n of ['typed-live', 'real-typed-live']) assert.deepEqual(SCENARIOS[n].steps.flatMap((s) => ('type' in s ? [s.lines] : [])), [1, 2]);
  assert.equal(SCENARIOS['real-typed-live'].real, true);
  for (const n of ['relay-pass', 'relay-annai', 'relay-ack', 'cut-note', 'typed-live', 'real-typed-live']) assert.equal(SCENARIOS[n].extra, true, `${n} is by name only`);
});
