// One input at a time, and one note at a time (spec §7.1): while a note that went in is not passed on, or an answer is due to a text annai put
// in (a note, a trigger, a recap, the ask once more, a line the user sent) or to the user's spoken turn, nothing new goes in but the ask once
// more; when it is free, one note goes in. So her one whole line answers exactly the one note in flight. Real Gemini (2026-11-12): a second note
// that went in before her continuation for the first made a note neither said nor shown in 17 of 60 questions. Lines and places are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tone, soon } from './koe-live-kit.js';
import { hum, quiet } from './voice-kit.js';
import { RATE, SAID, PASS, FERRY, FOR_USER, LOOKS, CONT, tell, tell2, tell3, shown, words, lines, notesIn, cues, wait, start, quietSession, lineAt } from './live-flight-kit.js';

test('a second note comes 1.3 s into "Checking your notes.", before her continuation: it goes in only once her line for the first is written, and both are said, in order', async () => {
  const { k, t0, w } = await start({ turns: [LOOKS, CONT, { said: PASS, audio: tone(0.8) }, { said: 'Okay.', audio: tone(0.3) }] });
  try {
    await wait(1300);
    await tell2(k);
    await soon(async () => (await words(k)).includes(PASS), 15_000);
    await k.agent.idle();
    w.stop();
    const contAt = await lineAt(k, t0, CONT.said);
    assert.ok(w.at(/pass closes/) >= contAt - 100, `the second went in at ${w.at(/pass closes/)} ms, her line for the first was written at ${contAt} ms`);
    assert.deepEqual(await words(k), ['Hello there.', 'Checking your notes.', CONT.said, PASS]);
    assert.deepEqual(await shown(k), []);
    assert.deepEqual(cues(k), [], 'nothing asked once more');
  } finally {
    w.stop();
    await k.done();
  }
});

test('two notes 0.3 s apart, and a tap in her answer to the first: the second goes in after the tap, the first alone is shown, and the second is said once', async () => {
  const { k, w } = await quietSession([{ said: SAID, audio: tone(1.5), delayMs: 1500 }, { said: PASS, audio: tone(1.5), delayMs: 1500 }, { said: 'Okay.', audio: tone(0.3) }]);
  try {
    await tell(k);
    await wait(300);
    await tell2(k);
    await soon(async () => k.agent.live.view.name === 'speaking', 6000);
    await wait(1000); // inside her answer's sound: the user taps
    k.agent.tap();
    const tapped = w.log.length;
    await soon(async () => (await words(k)).includes(PASS), 12_000);
    await k.agent.idle();
    w.stop();
    assert.deepEqual(await shown(k), [[FOR_USER, false]], 'the cut note alone is shown');
    const pass = (await lines(k)).filter((l) => l.text === PASS);
    assert.equal(pass.length, 1);
    assert.ok(pass[0].voice && !pass[0].cut, 'said aloud, whole');
    assert.ok(w.log.slice(0, tapped).every(([, kind, s]) => kind !== 'in' || !/pass closes/.test(s)), 'the second went in only after the tap');
  } finally {
    w.stop();
    await k.done();
  }
});

test('three notes at once go in one at a time, in Kokoro\'s order, each once her line for the one before is written', async () => {
  const { k, t0, w } = await quietSession([{ said: SAID, audio: tone(1), delayMs: 500 }, { said: PASS, audio: tone(1), delayMs: 500 }, { said: FERRY, audio: tone(1), delayMs: 500 }, { said: 'Okay.', audio: tone(0.3) }]);
  try {
    await Promise.all([tell(k), tell2(k), tell3(k)]);
    await soon(async () => (await words(k)).length === 4, 15_000);
    await k.agent.idle();
    w.stop();
    const notes = notesIn(k);
    assert.equal(notes.length, 3);
    assert.ok(notes.every((n) => n.split('<from_kokoro').length === 2), 'one note in each text');
    assert.deepEqual(notes.map((n) => (/fuel/.test(n) ? 'fuel' : /pass/.test(n) ? 'pass' : 'ferry')), ['fuel', 'pass', 'ferry']);
    assert.ok(w.at(/pass closes/) >= (await lineAt(k, t0, SAID)) - 100, 'the second after her line for the first');
    assert.ok(w.at(/ferry leaves/) >= (await lineAt(k, t0, PASS)) - 100, 'the third after her line for the second');
    assert.deepEqual(await words(k), ['Hello there.', SAID, PASS, FERRY]);
    assert.deepEqual(await shown(k), []);
  } finally {
    w.stop();
    await k.done();
  }
});

test('a note 0.3 s after annai asked for a recap aloud goes in once her recap line is written', async () => {
  const { k, t0, w } = await quietSession([{ said: 'Here is your recap.', audio: tone(1), delayMs: 1500 }, { said: SAID, audio: tone(1), delayMs: 500 }, { said: 'Okay.', audio: tone(0.3) }]);
  try {
    await k.agent.wake({ kind: 'trigger', text: 'Recap the day' });
    await wait(300);
    await tell(k);
    await soon(async () => (await words(k)).length === 3, 12_000);
    await k.agent.idle();
    w.stop();
    const recapAt = await lineAt(k, t0, 'Here is your recap.');
    assert.ok(w.at(/<from_kokoro/) >= recapAt - 100, `the note went in at ${w.at(/<from_kokoro/)} ms, the recap line was written at ${recapAt} ms`);
    assert.deepEqual(await words(k), ['Hello there.', 'Here is your recap.', SAID]);
  } finally {
    w.stop();
    await k.done();
  }
});

test('a note gets nothing back and a second waits: at 8 s a fresh session gets the first alone, and both are said, the second after the first', async () => {
  const { k, t0, w } = await quietSession([{ silent: true }, { said: SAID, audio: tone(1) }, { said: PASS, audio: tone(1) }, { said: 'Okay.', audio: tone(0.3) }]);
  try {
    await tell(k);
    await wait(1000);
    await tell2(k);
    await soon(async () => (await words(k)).includes(PASS), 20_000);
    await k.agent.idle();
    w.stop();
    const notes = notesIn(k);
    assert.ok(notes.every((n) => n.split('<from_kokoro').length === 2), 'one note in each text');
    assert.deepEqual(notes.map((n) => (/fuel/.test(n) ? 'fuel' : 'pass')), ['fuel', 'fuel', 'pass'], 'the first, again alone, then the second');
    assert.ok(w.at(/pass closes/) >= (await lineAt(k, t0, SAID)) - 100, 'the second after her line for the first');
    assert.deepEqual(await words(k), ['Hello there.', SAID, PASS]);
    assert.deepEqual(await shown(k), []);
  } finally {
    w.stop();
    await k.done();
  }
});

test('the connection drops with a note in flight: it goes in again once on the next one, at once, not after 8 s, and is said', async () => {
  const { k, w } = await quietSession([{ said: SAID, audio: tone(1), delayMs: 2000 }, { said: SAID, audio: tone(1) }, { said: 'Okay.', audio: tone(0.3) }]);
  try {
    await tell(k);
    await soon(async () => notesIn(k).length === 1, 4000);
    await wait(300);
    const dropAt = Date.now();
    k.server.close(1011, 'Internal error');
    await soon(async () => notesIn(k).length === 2, 12_000);
    const again = Date.now() - dropAt;
    assert.ok(again < 5000, `it went in again ${again} ms after the drop`);
    await soon(async () => (await words(k)).includes(SAID), 8000);
    await k.agent.idle();
    w.stop();
    assert.equal(notesIn(k).length, 2);
    assert.deepEqual(cues(k), []);
  } finally {
    w.stop();
    await k.done();
  }
});

test('a note that comes as the user\'s turn ends goes in only once her answer to them has ended, alone, and is said (no exception for their spoken turn)', async () => {
  const { k, t0, w } = await quietSession([{ said: 'Try the harbour cafe.', audio: tone(1), delayMs: 500 }, { said: SAID, audio: tone(1), delayMs: 500 }, { said: 'Okay.', audio: tone(0.3) }]);
  try {
    const starts = () => k.server.received().filter((/** @type {any} */ m) => m.realtimeInput?.activityStart).length;
    const began = starts();
    k.platform.mic.feed(hum(1.5), RATE);
    await soon(async () => starts() > began, 4000);
    await tell(k); // as their turn ends (the stand-in's microphone hears it end at once)
    k.platform.mic.feed(quiet(1), RATE);
    await soon(async () => (await words(k)).includes(SAID), 15_000);
    await k.agent.idle();
    w.stop();
    const answerAt = await lineAt(k, t0, 'Try the harbour cafe.');
    assert.ok(w.at(/<from_kokoro/) >= answerAt - 100, `the note went in at ${w.at(/<from_kokoro/)} ms, her answer to the user was written at ${answerAt} ms`);
    assert.deepEqual(await words(k), ['Hello there.', 'Try the harbour cafe.', SAID]);
    assert.deepEqual(await shown(k), []);
  } finally {
    w.stop();
    await k.done();
  }
});

// Review F8: the fresh session a silent note's rescue opens takes a second to connect; a line the user types meanwhile is the input now, and the old
// note text is not sent after it (it went in after the typed line and replaced its wait).
test('a note gets nothing back, and the user types a line while the fresh session connects: the line goes in, and the old note is not sent after it', async () => {
  const LUNCH = { said: 'Lunch is at noon.', audio: tone(0.5) };
  const { k, w } = await quietSession([{ silent: true }, LUNCH, { said: 'Okay.', audio: tone(0.3) }]);
  try {
    await tell(k);
    await wait(7000);
    const setup = k.agent.live.c.setup;
    k.agent.live.c.setup = async () => { await wait(1200); return setup(); }; // the fresh connection, at 8 s, takes 1.2 s
    await wait(1500);
    k.agent.send('What about lunch?');
    await soon(async () => (await words(k)).includes(LUNCH.said), 15_000);
    await wait(1500);
    await k.agent.idle();
    w.stop();
    assert.equal(notesIn(k).length, 1, 'the note went in once, and not again after the typed line');
    assert.deepEqual(await shown(k), [[FOR_USER, false]], 'the typed line showed the note on a silent card');
  } finally {
    w.stop();
    await k.done();
  }
});
