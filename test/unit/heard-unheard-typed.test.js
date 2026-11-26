// A heard line nothing could write down fails its own turn for a model that takes no audio (spec §10.3: skipped like any capability gap), and
// no later one: the flake look's lead (2026-11-25), where a typed "Hello" after such a clip failed with "Nothing in the speech-in list worked"
// until the clip left memory, which only a turn that worked (or a restart) does. Here: which lines a turn marks as past it (what it carried: its wakes,
// the speech its requests sent, the chatter it wrote in), and which asks of the transcription model count towards giving the line up (WRITE_TRIES).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear, idleAtOnce } from './agent-kit.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { COOLDOWN_MS } from '../../src/core/llm/fallback.js';
import { KOE_REST_MS } from '../../src/core/agent/halves.js';
import { WRITE_TRIES } from '../../src/core/agent/loop.js';
import { createTrip } from '../../src/core/scopes.js';
import { NOT_TRANSCRIBED } from '../../src/core/voice/resolve.js';
import { useClock } from './clock.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
/** Taps Shiori and says one of the clips. @param {any} k @param {string} name */
async function tapAndSay(k, name) {
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, name);
  await idleAtOnce(k);
}
/** The requests that hold this typed line. @param {any[]} requests @param {string} text */
const holding = (requests, text) => requests.filter((r) => JSON.stringify(r.messages).includes(text));
/** What a request sent for the heard line: the part after its label. @param {any} r */
const heardAs = (r) => {
  const parts = r.messages.flatMap((/** @type {any} */ m) => m.parts);
  return parts[parts.findIndex((/** @type {any} */ p) => p.type === 'text' && p.text === '[heard]') + 1];
};
/** Every error's words, in order. @param {any} k */
const errors = async (k) => (await k.events(['error'])).map((/** @type {any} */ e) => e.data.message);
/** What was said aloud, by whom. @param {any} k */
const spoken = async (k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.half ?? 'one', e.data.text]);

/** The transcription model's failures: the user's shape (a dead link), its server down (it rests 3 minutes), and a recording it refuses. */
const FAILURES = /** @type {const} */ ([
  ['unreachable, as on a dead link', () => new ProviderError('unreachable', 'no route to the server'), 0],
  ['down', () => new ProviderError('server', 'down'), COOLDOWN_MS],
  ['refusing the recording', () => new ProviderError('bad-request', 'audio too short', { status: 400 }), 0],
]);

for (const [how, fail, rests] of FAILURES) {
  test(`one Shiori, every model text-only, the transcription model ${how}: the heard line fails with the card, a line typed after it is answered with the line as not transcribed, and its words come once the model hears again`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Hello there.'), say('Lunch is near.')]], { voice: { speechIn: ['m-hear'], hears: ['where should we eat'] } });
    const hears = k.llm.transcribe;
    let down = true;
    k.llm.transcribe = async (/** @type {any} */ c) => { if (down) throw fail(); return hears(c); };
    await tapAndSay(k, 'where-eat');
    assert.equal(k.requests.length, 0);
    assert.deepEqual(await errors(k), ['model-0: Nothing in the speech-in list worked for model-0.'], 'its own turn fails, as before');
    k.agent.send('Hello');
    await idleAtOnce(k);
    const [typed] = holding(k.requests, 'Hello');
    assert.ok(typed, 'the typed line reached her model');
    assert.deepEqual(heardAs(typed), { type: 'text', text: NOT_TRANSCRIBED });
    assert.deepEqual(await spoken(k), [['one', 'Hello there.']]);
    assert.equal((await errors(k)).length, 1, 'no second card');
    assert.equal(k.voice.memory.size, 1, 'the sound is kept, to be written down');
    assert.equal((await k.events(['heard.text'])).length, 0);
    // The model hears again (after its rest, if it took one): the next line sends the words, and they are written down.
    if (rests) await new Promise((r) => setTimeout(r, rests));
    down = false;
    k.agent.send('And now?');
    await idleAtOnce(k);
    const [next] = holding(k.requests, 'And now?');
    assert.deepEqual(heardAs(next), { type: 'text', text: 'where should we eat' });
    assert.deepEqual((await k.events(['heard.text'])).map((/** @type {any} */ e) => e.data.text), ['where should we eat']);
    assert.equal(k.voice.memory.size, 0);
  });
}

test("Koe and Kokoro on text-only models, the transcription model unreachable: the heard line fails both halves with the card, as before; a typed line is answered by Kokoro while Koe rests, and by Koe after her rest", async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: 'the user wrote', reply: say('Kokoro here.') }, { match: '.', reply: sleep }] }], {
    koe: { type: { rules: [{ match: '.', reply: say('Koe here.') }] } },
    voice: { speechIn: ['m-hear'] },
  });
  k.llm.transcribe = async () => { throw new ProviderError('unreachable', 'no route to the server'); };
  await tapAndSay(k, 'where-eat');
  assert.equal(k.agent.koeState, 'down');
  assert.equal(k.requests.length, 0);
  assert.deepEqual(await errors(k), ['model-koe: Nothing in the speech-in list worked for model-koe.',
    'Koe: model-koe: Nothing in the speech-in list worked for model-koe.\nKokoro: model-0: Nothing in the speech-in list worked for model-0.'], 'each half fails it once, as before');
  k.agent.send('Hello');
  await idleAtOnce(k);
  const [kokoro] = holding(k.sent['model-0'] ?? [], 'Hello');
  assert.ok(kokoro, 'Kokoro was sent the typed line');
  assert.deepEqual(heardAs(kokoro), { type: 'text', text: NOT_TRANSCRIBED });
  assert.deepEqual(await spoken(k), [['kokoro', 'Kokoro here.']]);
  assert.equal((await errors(k)).length, 2, 'no new card');
  assert.equal(k.voice.memory.size, 1, 'the sound is kept: one real try of the transcription model failed since');
  await new Promise((r) => setTimeout(r, KOE_REST_MS));
  k.agent.send('Still there?');
  await idleAtOnce(k);
  const [koe] = holding(k.sent['model-koe'] ?? [], 'Still there?');
  assert.ok(koe, 'Koe, rested, was sent the next one');
  assert.deepEqual(heardAs(koe), { type: 'text', text: NOT_TRANSCRIBED });
  assert.deepEqual((await spoken(k)).at(-1), ['koe', 'Koe here.']);
  assert.equal((await errors(k)).length, 2);
  // The count is on the shared segment, so both halves' real asks add up: after Koe's answer and her write-down (two more asks that failed) it is given up.
  assert.equal(k.voice.memory.size, 0, 'the third real ask that failed gave it up, and its sound is let go');
  assert.deepEqual((await k.events(['heard.text'])).map((/** @type {any} */ e) => e.data.text), [NOT_TRANSCRIBED]);
});

// The give-up counts the real asks of the transcription model that failed (Kept.failed), and nothing else: lines typed while a model rests that failed (a server
// error, say) ask it nothing, and cost the heard line no try, so its words still come when the model is back.
test('one Shiori, every model text-only, the transcription model down: lines typed while it rests ask it nothing and cost the heard line no try, so its words are written when it works again', async (t) => {
  useClock(t);
  // WRITE_TRIES answered lines in its rest, one more after it: the number a count of typed lines would give the heard line up at.
  const replies = Array.from({ length: WRITE_TRIES + 1 }, (_, i) => say(`Reply ${i}.`));
  const k = await agentKit([replies], { voice: { speechIn: ['m-hear'], hears: ['where should we eat'] } });
  const hears = k.llm.transcribe;
  let down = true;
  let asked = 0;
  k.llm.transcribe = async (/** @type {any} */ c) => { asked++; if (down) throw new ProviderError('server', 'down'); return hears(c); };
  await tapAndSay(k, 'where-eat');
  const first = asked;
  assert.ok(first > 0, 'its own turn asked it (more than once: a server error is sent again), and it rests 3 minutes');
  for (let i = 0; i < WRITE_TRIES; i++) {
    k.agent.send(`Line ${i}`);
    await idleAtOnce(k);
  }
  assert.equal(asked, first, 'resting, it was asked nothing: not for the requests, not for the write-downs');
  assert.deepEqual(await spoken(k), replies.slice(0, WRITE_TRIES).map((_, i) => ['one', `Reply ${i}.`]));
  assert.equal(k.voice.memory.size, 1, `${WRITE_TRIES} answered turns, and the sound is kept: none asked the model`);
  assert.equal((await k.events(['heard.text'])).length, 0);
  await new Promise((r) => setTimeout(r, COOLDOWN_MS));
  down = false;
  k.agent.send('And now?');
  await idleAtOnce(k);
  const [next] = holding(k.requests, 'And now?');
  assert.deepEqual(heardAs(next), { type: 'text', text: 'where should we eat' });
  assert.deepEqual((await k.events(['heard.text'])).map((/** @type {any} */ e) => e.data.text), ['where should we eat']);
  assert.equal(k.voice.memory.size, 0);
});

// A model that rests after failing is asked by the requests (resolvePart) and found resting by the write-down, so no write-down ask of it fails: it is never given up,
// however many lines are typed, each after its rest (WRITE_TRIES' comment): the sound is kept until it works.
test('one Shiori, every model text-only, the transcription model down: a line typed after each of its rests asks it again, and the heard line is never given up', async (t) => {
  useClock(t);
  const replies = Array.from({ length: WRITE_TRIES + 2 }, (_, i) => say(`Reply ${i}.`));
  const k = await agentKit([replies], { voice: { speechIn: ['m-hear'], hears: ['where should we eat'] } });
  const hears = k.llm.transcribe;
  let down = true;
  let asked = 0;
  k.llm.transcribe = async (/** @type {any} */ c) => { asked++; if (down) throw new ProviderError('server', 'down'); return hears(c); };
  await tapAndSay(k, 'where-eat');
  for (let i = 0; i <= WRITE_TRIES; i++) {
    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
    const before = asked;
    k.agent.send(`Line ${i}`);
    await idleAtOnce(k);
    assert.ok(asked > before, `line ${i}: its rest is over, so the requests asked it again`);
    assert.equal(k.voice.memory.size, 1, `after ${i + 1} lines (more than WRITE_TRIES by the last) the sound is kept`);
  }
  assert.equal((await k.events(['heard.text'])).length, 0, 'nothing is written as not transcribed');
  await new Promise((r) => setTimeout(r, COOLDOWN_MS));
  down = false;
  k.agent.send('And now?');
  await idleAtOnce(k);
  assert.deepEqual((await k.events(['heard.text'])).map((/** @type {any} */ e) => e.data.text), ['where should we eat'], 'its words come when it works');
  assert.equal(k.voice.memory.size, 0);
});

test('one Shiori, every model text-only, the transcription model unreachable (asked every time): after WRITE_TRIES lines it was really asked for and failed, the heard line is written as not transcribed and its sound let go', async (t) => {
  useClock(t);
  const k = await agentKit([[say('One.'), say('Two.'), say('Three.')]], { voice: { speechIn: ['m-hear'] } });
  let asked = 0;
  k.llm.transcribe = async () => { asked++; throw new ProviderError('unreachable', 'no route to the server'); };
  await tapAndSay(k, 'where-eat');
  for (let i = 1; i <= WRITE_TRIES; i++) {
    const before = asked;
    k.agent.send(`Line ${i}`);
    await idleAtOnce(k);
    assert.ok(asked > before, `line ${i}: the model was asked again, for the request and for the write-down`);
    if (i < WRITE_TRIES) assert.equal(k.voice.memory.size, 1, `after ${i} real tries the sound is kept`);
  }
  assert.deepEqual((await k.events(['heard.text'])).map((/** @type {any} */ e) => e.data.text), [NOT_TRANSCRIBED]);
  assert.equal(k.voice.memory.size, 0);
});

// A turn of another conversation that ends says nothing of this one's heard line: the mark is added to, never replaced by what that turn left unwritten.
test("a turn that fails in another conversation leaves this one's heard line marked: back in it, a typed line is answered at once", async (t) => {
  useClock(t);
  const k = await agentKit([[{ error: 'bad-request', status: 400 }, say('Hello there.')]], { voice: { speechIn: ['m-hear'], hears: ['where should we eat'] } });
  k.llm.transcribe = async () => { throw new ProviderError('unreachable', 'no route to the server'); };
  await tapAndSay(k, 'where-eat');
  assert.equal(k.requests.length, 0);
  await k.agent.open(await createTrip(k.ws, { title: 'Carmel' }));
  k.agent.send('In Carmel');
  await idleAtOnce(k);
  assert.equal(k.requests.length, 1, "Carmel's turn reached her model, and failed");
  await k.agent.open(k.trip);
  k.agent.send('Back in Big Sur');
  await idleAtOnce(k);
  const [back] = holding(k.requests, 'Back in Big Sur');
  assert.ok(back, 'the typed line reached her model');
  assert.deepEqual(heardAs(back), { type: 'text', text: NOT_TRANSCRIBED });
  assert.equal((await errors(k)).length, 1, 'no second card in its conversation');
  assert.deepEqual(await spoken(k), [['one', 'Hello there.']]);
});

// A turn that worked whose write-down failed leaves the line unwritten too: her audio model answered it and fails the next line, with a text-only
// model behind it that nothing can write the line down for: it answers at once, and doesn't fail once first.
test('a turn that worked whose write-down failed: the line is past its turn, so when her audio model fails the next line, the text-only model behind it answers it', async (t) => {
  useClock(t);
  const fail = { error: 'bad-request', status: 400 };
  const k = await agentKit([[say('Hello there.'), fail, fail], [say('From the other one.')]], { models: [{ input: ['text', 'image', 'audio'] }, {}], voice: { speechIn: ['send-audio'] } });
  await tapAndSay(k, 'where-eat');
  assert.equal((await k.events(['heard.text'])).length, 0, 'the audio model heard it, and its write-down failed');
  assert.equal(k.voice.memory.size, 1);
  k.agent.send('Hello');
  await idleAtOnce(k);
  const [other] = holding(k.sent['model-1'] ?? [], 'Hello');
  assert.ok(other, 'the text-only model was sent the typed line');
  assert.deepEqual(heardAs(other), { type: 'text', text: NOT_TRANSCRIBED });
  assert.deepEqual(await errors(k), [], 'no card');
  assert.deepEqual(await spoken(k), [['one', 'Hello there.'], ['one', 'From the other one.']]);
});

// A line heard as the turn ends has no turn yet, and isn't in the transcript, so the ending turn can't mark it: its own turn, with
// her audio model failing and a text-only one behind it, fails with the card as for any heard line (spec §10.3).
test("a line heard as a turn ends keeps its own turn's card where nothing can hear it", async (t) => {
  useClock(t);
  const fail = { error: 'bad-request', status: 400 };
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Anything else?' } }] }, { delayMs: 120, toolCalls: [{ name: 'sleep', input: {} }] }, fail, fail, fail], [say('From the other one.')]], {
    models: [{ input: ['text', 'image', 'audio'] }, {}], voice: { speechIn: ['send-audio'] },
  });
  k.agent.send('Thanks');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  await hear(k, 'gas-station');
  await idleAtOnce(k);
  assert.equal((await k.events(['heard'])).length, 2, 'both were heard');
  assert.deepEqual(k.sent['model-1'] ?? [], [], 'the text-only model was sent nothing');
  assert.deepEqual((await errors(k)).map((m) => m.split('\n').at(-1)), ['model-1: Nothing in the speech-in list worked for model-1.']);
});

// A turn marks what it carried, not every line its transcript holds: Kokoro's transcript holds Koe's lines,
// and a turn of Kokoro's that fails before any request of it sent Koe's line must not mark it, or its next turn sends its text-only model the line as not
// transcribed and never asks the audio model behind it (spec §10.3).
test("Halves: a line of Koe's that Kokoro's failed turn never carried is not marked, so its next turn gives the audio model behind its text-only one the sound", async (t) => {
  useClock(t);
  const fail = { error: 'bad-request', status: 400 };
  const k = await agentKit([[{ delayMs: 1500, ...fail }, sleep], [fail, sleep]], {
    models: [{}, { input: ['text', 'image', 'audio'] }],
    koe: { talk: [say('Hello there.'), say('Tacos are close.'), fail], input: ['text', 'image', 'audio'] },
    voice: { speechIn: ['send-audio'] },
  });
  k.agent.send('Hello'); // Koe answers it, and Kokoro's turn for Koe's answer starts: its text-only model takes 1.5 s to fail, and its audio model fails too
  await until(() => (k.sent['model-0'] ?? []).length === 1);
  await tapAndSay(k, 'where-eat'); // while it runs: Koe hears this one by audio and answers, and its write-down fails; Kokoro's request has gone without it
  await idleAtOnce(k);
  assert.equal((await errors(k)).length, 1, "Kokoro's first turn failed");
  assert.equal((k.sent['model-0'] ?? []).length, 1, "its second turn skipped the text-only model, as a capability gap: the line was not marked by a turn that never carried it");
  const [, second] = k.sent['model-1'];
  const parts = second.messages.flatMap((/** @type {any} */ m) => m.parts);
  assert.equal(parts[parts.findIndex((/** @type {any} */ p) => p.type === 'text' && p.text === '[heard]') + 1]?.type, 'audio', 'the audio model behind it was sent the sound');
});

// The Stop in the moment before the turn's first request: nothing of the line was sent, and the line is still the turn's own (join marks the heard wakes it began
// with), so a line typed after it is answered at once, not failed once with the card.
test('a heard line whose turn the user stopped before its first request is past its turn: a line typed after it is answered', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Hello there.')]], { voice: { speechIn: ['m-hear'] } });
  k.llm.transcribe = async () => { throw new ProviderError('unreachable', 'no route to the server'); };
  const config = k.llm.config;
  let stopped = false;
  k.llm.config = () => {
    if (!stopped && k.agent.state.name === 'hearing') { // the turn reads the list of models just before its first call (#steps): the user's Stop comes then
      stopped = true;
      k.agent.interrupt();
    }
    return config.call(k.llm);
  };
  await tapAndSay(k, 'where-eat');
  assert.equal(k.requests.length, 0, 'the turn ended before any request carried the line');
  assert.equal(k.voice.memory.size, 1, 'its sound is kept');
  k.agent.send('Hello');
  await idleAtOnce(k);
  const [typed] = holding(k.requests, 'Hello');
  assert.ok(typed, 'the typed line reached her model');
  assert.deepEqual(heardAs(typed), { type: 'text', text: NOT_TRANSCRIBED });
  assert.deepEqual(await errors(k), ['Stopped by the user.'], 'no card for the line');
  assert.deepEqual(await spoken(k), [['one', 'Hello there.']]);
});

// A format this phone can't make for the transcription model is refused before any request (voice.js #hear): nothing was asked, so it counts no try, and the
// sound stays for as long as the model asks for a format the phone can't make.
test("one Shiori, every model text-only, the transcription model takes no audio format this phone makes: lines typed after the heard line are answered, and none of them counts a try", async (t) => {
  useClock(t);
  const k = await agentKit([[say('One.'), say('Two.'), say('Three.'), say('Four.')]], { voice: { speechIn: ['m-hear'] } });
  k.llm.types().get('hear').tunables = { audioIn: ['mp3'] };
  await tapAndSay(k, 'where-eat');
  assert.deepEqual(await errors(k), ['model-0: Nothing in the speech-in list worked for model-0.'], 'its own turn fails, as before');
  for (let i = 0; i <= WRITE_TRIES; i++) {
    k.agent.send(`Line ${i}`);
    await idleAtOnce(k);
  }
  assert.deepEqual((await spoken(k)).length, WRITE_TRIES + 1, 'every line typed after it was answered');
  assert.deepEqual(k.transcribed, [], 'the model was never asked: the phone has no format for it');
  assert.equal(k.voice.memory.size, 1, 'more lines than the give-up allows, and the sound is kept');
  assert.equal((await k.events(['heard.text'])).length, 0);
});

// Chatter heard while a turn ran is written in as the turn ends (#writeChatter), after its last step, so no request of it carried it; it is the turn's own all the same,
// and a failed turn marks it: a line typed after it is answered, not failed once on it. The gate hears audio, and her audio
// model fails the typed line with a text-only one behind it that nothing can write the lines down for.
test("chatter heard while a turn ran, written in as that turn failed, is past its turn: when her audio model fails the next line, the text-only model behind it answers it", async (t) => {
  useClock(t);
  const choose = (/** @type {'A' | 'B'} */ letter) => ({ toolCalls: [{ name: 'decide', input: { option: letter } }] });
  const fail = { error: 'bad-request', status: 400 };
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Anything else?' } }] }, { delayMs: 120, ...fail }, fail], [say('From the other one.')]], {
    models: [{ input: ['text', 'image', 'audio'] }, {}], voice: { speechIn: ['send-audio'], decide: [choose('A'), choose('B')], gateHears: true },
  });
  k.agent.send('Thanks');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one'); // for her: it ends speak's wait, and her next request, which fails on both models, is in flight ...
  await until(() => (k.sent['model-0'] ?? []).length === 2);
  await hear(k, 'gas-station'); // ... when this is heard, and judged chatter: it is written in as that turn ends
  await idleAtOnce(k);
  assert.deepEqual((await k.events(['heard'])).map((/** @type {any} */ e) => e.data.gate), ['shiori', 'chatter']);
  assert.equal((await errors(k)).length, 1, 'the turn failed');
  assert.equal(k.voice.memory.size, 2, 'both sounds are kept');
  k.agent.send('Hello');
  await idleAtOnce(k);
  const [typed] = holding(k.sent['model-1'] ?? [], 'Hello');
  assert.ok(typed, 'the text-only model was sent the typed line');
  assert.equal(JSON.stringify(typed.messages).split(NOT_TRANSCRIBED).length - 1, 2, 'both lines as not transcribed');
  assert.equal((await errors(k)).length, 1, 'no second card');
  assert.deepEqual((await spoken(k)).at(-1), ['one', 'From the other one.']);
});
