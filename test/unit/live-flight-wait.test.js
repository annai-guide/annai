// What she says after a call she speaks after (a lookup) is owed like the answer to a text (spec §7.1): annai's answer to the call starts the
// same wait as any input's (SILENT_S, 8 s), nothing new goes in meanwhile, and with nothing back she is asked once more; asked and silent again,
// annai shows the note and says it. All made (the provider's `made`) ends the calling turn once its calls are answered, in the same tick, so
// what she says after is a turn of its own. Real Gemini (2026-11-12): her next sound came within 6.4 s of the last input in 123 of 123 such calls;
// 2 of 124 had no continuation and no turnComplete at all. Lines and places are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, tone, soon, say } from './koe-live-kit.js';
import { until } from './agent-kit.js';
import { SAID, PASS, FOR_USER, NOTE, LOOKS, CONT, tell, tell2, shown, words, cues, asks, silences, wait, start, quietSession, lineAt } from './live-flight-kit.js';

/** The user asks, in the car, a real second; she answers with these turns, and once Kokoro's tell_kokoro has run, Kokoro's note comes. @param {any[]} turns */
async function quietSessionAsks(turns) {
  const k = await liveKit(turns, { pace: 1, agent: { secondMs: 1000 } });
  await k.voice.unlock();
  k.voice.route = async () => 'car';
  k.platform.streamSpeed = 1;
  k.agent.tap();
  await until(() => k.agent.live.listening, 3000);
  await say(k, 'where-eat');
  await soon(async () => (await k.events(['tool.result'])).some((/** @type {any} */ e) => e.data.half === 'koe'), 6000);
  await tell(k);
  return k;
}

/** Her lookup with no continuation at all: the provider ends it after its burst, and says nothing more. */
const NO_MORE = { ...LOOKS, andThen: false };
/** The same, with no turnComplete ever (the real stall). */
const STALLS = { ...LOOKS, andThen: false, endAt: undefined, noEnd: true };

test('a turn that goes on and never gets its turnComplete: all made and its call answered, it ends, so the dock leaves "speaking" as her sound ends', async () => {
  const { k, t0, w } = await start({ turns: [STALLS, { said: 'Okay.', audio: tone(0.3) }] });
  try {
    await wait(t0 + 800 + 500 - Date.now()); // her 0.8 s of sound, and half a second
    assert.equal(k.agent.live.view.name, 'thinking', 'not speaking: what she says after the lookup is due');
    assert.deepEqual(await words(k), ['Hello there.', 'Checking your notes.'], 'her line is written');
  } finally {
    w.stop();
    await k.done();
  }
});

test('OpenAI Realtime: her words, a call she speaks after, answered at once, and the continuation: two lines, and nothing asked once more', async () => {
  const { k, w } = await start({ live: { type: 'openai-realtime' }, pace: 0.05, turns: [{ said: 'Checking your notes.', audio: tone(1.2), tool: { name: 'watch_list', args: {} } }, { said: SAID, audio: tone(1.5) }, { said: 'Asked again: it is open until ten.', audio: tone(0.5) }] });
  try {
    await soon(async () => (await words(k)).includes(SAID), 10_000);
    await wait(1500);
    await k.agent.idle();
    assert.deepEqual(await words(k), ['Hello there.', 'Checking your notes.', SAID]);
    assert.deepEqual(cues(k), []);
    assert.deepEqual(await shown(k), []);
  } finally {
    w.stop();
    await k.done();
  }
});

test('no continuation after her lookup, and a second note 3 s in: at 8 s she is asked once more and says the first, then the second goes in and is said', async () => {
  const { k, t0, w } = await start({ turns: [NO_MORE, { said: SAID, audio: tone(1) }, { said: PASS, audio: tone(0.8) }, { said: 'Okay.', audio: tone(0.3) }] });
  try {
    await wait(3000);
    await tell2(k);
    await soon(async () => (await words(k)).includes(PASS), 20_000);
    await k.agent.idle();
    const asked = w.at(/^\[annai\] .*Kokoro/);
    assert.ok(asked > 7000 && asked < 10_000, `asked once more at ${asked} ms (the call was answered at about 0.8 s)`);
    assert.equal(cues(k).length, 1);
    assert.ok(w.at(/pass closes/) >= (await lineAt(k, t0, SAID)) - 100, 'the second after her line for the first');
    assert.deepEqual(await words(k), ['Hello there.', 'Checking your notes.', SAID, PASS]);
    assert.deepEqual(await silences(k), ['The live session said nothing within 8 seconds of a tool\'s answer.']);
    assert.deepEqual(await shown(k), []);
  } finally {
    w.stop();
    await k.done();
  }
});

test('her lookup never gets its turnComplete and nothing follows: at 8 s she is asked once more, and says the note', async () => {
  const { k, w } = await start({ turns: [STALLS, { said: SAID, audio: tone(1) }, { said: 'Okay.', audio: tone(0.3) }] });
  try {
    await soon(async () => (await words(k)).includes(SAID), 20_000);
    await k.agent.idle();
    assert.equal(cues(k).length, 1);
    assert.deepEqual(await shown(k), []);
    assert.equal(k.agent.live.state, 'open');
  } finally {
    w.stop();
    await k.done();
  }
});

test('no continuation, and the ask once more gets nothing back either: at 16 s annai shows the note and says it, asked once, the session still open', async () => {
  const { k, w } = await start({ turns: [NO_MORE, { silent: true }] });
  try {
    await soon(async () => (await shown(k)).length > 0, 25_000);
    await wait(500);
    assert.deepEqual(await shown(k), [[FOR_USER, true]], 'shown, and said in annai\'s own voice');
    assert.equal(cues(k).length, 1, 'asked once');
    assert.equal(k.agent.live.state, 'open');
    assert.deepEqual(await silences(k), ['The live session said nothing within 8 seconds of a tool\'s answer.', 'The live session gave nothing back within 8 seconds of being asked once more.']);
  } finally {
    w.stop();
    await k.done();
  }
});

for (const made of [true, false]) {
  test(`a note comes 1.3 s into her own lookup for the user${made ? '' : ', a provider that never says all made'}: it goes in only once her continuation's line is written, and is said`, async () => {
    const { k, t0, w } = await start({ note: false, ...(made ? {} : { live: { made: false } }), turns: [LOOKS, { ...CONT, said: 'You have two reminders set.' }, { said: SAID, audio: tone(1) }, { said: 'Okay.', audio: tone(0.3) }] });
    try {
      await wait(1300);
      await tell(k);
      await soon(async () => (await words(k)).includes(SAID), 15_000);
      await k.agent.idle();
      const contAt = await lineAt(k, t0, 'You have two reminders set.');
      assert.ok(w.at(/<from_kokoro/) >= contAt - 100, `the note went in at ${w.at(/<from_kokoro/)} ms, her continuation was written at ${contAt} ms`);
      assert.deepEqual((await words(k)).slice(-3), ['Checking your notes.', 'You have two reminders set.', SAID]);
      assert.deepEqual(cues(k), []);
    } finally {
      w.stop();
      await k.done();
    }
  });
}

test('her continuation is another lookup she speaks after: the wait starts again at its answer, so a line 6.5 s after it, 8 s past the first answer, is not asked for', async () => {
  const AGAIN = { said: 'And the weather.', audio: tone(0.5), tool: { name: 'watch_list', args: {} }, endAt: 700, andThen: true, delayMs: 1000 };
  const { k, w } = await start({ turns: [LOOKS, AGAIN, { said: SAID, audio: tone(1), delayMs: 6500 }, { said: 'Okay.', audio: tone(0.3) }] });
  try {
    await soon(async () => (await words(k)).includes(SAID), 20_000);
    await k.agent.idle();
    assert.deepEqual((await words(k)).slice(-3), ['Checking your notes.', 'And the weather.', SAID]);
    assert.deepEqual(cues(k), []);
    assert.deepEqual(await silences(k), []);
    assert.deepEqual(await shown(k), []);
  } finally {
    w.stop();
    await k.done();
  }
});

test('her continuation is an empty turn: the note is asked for at once, not after 8 s', async () => {
  const { k, w } = await start({ turns: [LOOKS, { said: '', delayMs: 500 }, { said: SAID, audio: tone(1) }, { said: 'Okay.', audio: tone(0.3) }] });
  try {
    await soon(async () => cues(k).length > 0, 10_000);
    assert.ok(w.at(/^\[annai\] .*Kokoro/) < 5000, `asked at ${w.at(/^\[annai\] .*Kokoro/)} ms`);
    await soon(async () => (await words(k)).includes(SAID), 10_000);
    await k.agent.idle();
    assert.deepEqual(await silences(k), []);
  } finally {
    w.stop();
    await k.done();
  }
});

// "One moment." and tell_kokoro, its turnComplete 0.9 s after its burst; the note goes in as all made ends that turn, and Gemini ends the turn
// it meets with interrupted and its turnComplete 20 ms later (19 of 19 real turns, 2026-11-12). That is the end of a turn annai had ended:
// no answer to the note, and no sign the session is alive. Silent on the note, the session is replaced, and a fresh one gets the note again.
test('the provider ends a turn annai had ended with interrupted and its turnComplete, after the note went in, then nothing: a fresh session gets the note again at 8 s, and she says it', async () => {
  const k = await quietSessionAsks([{ heard: 'where to', said: 'One moment.', audio: tone(0.8), tool: { name: 'tell_kokoro', args: { text: 'Where should we stop?' } }, endAt: 900 }, { silent: true }, { said: SAID, audio: tone(0.3) }]);
  try {
    await soon(async () => (await words(k)).includes(SAID), 20_000);
    await k.agent.idle();
    assert.deepEqual(await silences(k), ['The live session gave no answer within 8 seconds: a fresh one gets it again.']);
    assert.deepEqual(asks(k), [], 'nothing asked of the old one');
  } finally {
    await k.done();
  }
});

// An interrupted is the end of the turn before, never a reply to what went in: a typed line that meets her turn gets Gemini's interrupted for
// that turn, and nothing for the line itself. The line's 8 s run on: a fresh session gets it again.
test('a typed line cuts her turn, the provider sends interrupted for it and says nothing to the line: at 8 s a fresh session gets the line again', async () => {
  const { k, w } = await start({ turns: [{ said: SAID, audio: tone(3) }, { said: 'Lunch is at noon.', audio: tone(0.5) }], server: { onText: { match: /What about lunch/, turn: { silent: true } } } });
  try {
    await wait(800);
    k.agent.send('What about lunch?');
    await soon(async () => (await silences(k)).length > 0, 12_000);
    assert.deepEqual((await silences(k)).slice(0, 1), ['The live session gave no answer within 8 seconds: a fresh one gets it again.']);
  } finally {
    w.stop();
    await k.done();
  }
});

// Review F3: an urgent note's mark ends with her answer, though her answer is a lookup and nothing follows it: the microphone hears again and the
// ask once more goes in at about 9 s (0.8 s of her words and the 8 s), not at the mark's 20 s ceiling.
test('Kokoro\'s immediate note answered by a lookup and no continuation: she is asked once more at about 9 s, not after the 20 s ceiling', async () => {
  const { k, t0, w } = await quietSession([NO_MORE, { said: SAID, audio: tone(1) }, { said: 'Okay.', audio: tone(0.3) }]);
  try {
    const sent = Date.now() - t0;
    await k.agent.channel.send('kokoro', NOTE, 'immediate', 'tool', undefined, undefined, false, FOR_USER);
    await soon(async () => cues(k).length > 0, 25_000);
    const asked = w.at(/^\[annai\] .*Kokoro/) - sent;
    assert.ok(asked > 7500 && asked < 12_000, `asked once more ${asked} ms after the note`);
    await soon(async () => (await words(k)).includes(SAID), 10_000);
    await k.agent.idle();
  } finally {
    w.stop();
    await k.done();
  }
});
