// A heard line nothing could write down fails its own turn for a model that takes no audio (spec §10.3: skipped like any capability gap), and
// no later one: the flake look's lead (2026-11-25), where a typed "Hello" after such a clip failed with "Nothing in the speech-in list worked"
// until the clip left memory, which only a turn that worked (or a restart) does.
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
});

// The give-up counts the real asks of the transcription model that failed (Kept.failed), and nothing else (the fix round of clip-typed-next, Haiku F1): lines
// typed while it rests ask it nothing, and cost the heard line no try, so its words still come when the model is back.
test('one Shiori, every model text-only, the transcription model down: lines typed while it rests ask it nothing and cost the heard line no try, so its words are written when it works again', async (t) => {
  useClock(t);
  const k = await agentKit([[say('One.'), say('Two.'), say('Three.'), say('Four.')]], { voice: { speechIn: ['m-hear'], hears: ['where should we eat'] } });
  const hears = k.llm.transcribe;
  let down = true;
  let asked = 0;
  k.llm.transcribe = async (/** @type {any} */ c) => { asked++; if (down) throw new ProviderError('server', 'down'); return hears(c); };
  await tapAndSay(k, 'where-eat');
  const first = asked;
  assert.ok(first > 0, 'its own turn asked it (more than once: a server error is sent again), and it rests 3 minutes');
  for (const text of ['Hello', 'Hello again', 'And again']) {
    k.agent.send(text);
    await idleAtOnce(k);
  }
  assert.equal(asked, first, 'resting, it was asked nothing: not for the requests, not for the write-downs');
  assert.deepEqual(await spoken(k), [['one', 'One.'], ['one', 'Two.'], ['one', 'Three.']]);
  assert.equal(k.voice.memory.size, 1, 'three answered turns, and the sound is kept: none asked the model');
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

test('one Shiori, every model text-only, the transcription model unreachable (asked every time): after WRITE_TRIES lines it was really asked for and failed, the heard line is written as not transcribed and its sound let go', async (t) => {
  useClock(t);
  const k = await agentKit([[say('One.'), say('Two.'), say('Three.')]], { voice: { speechIn: ['m-hear'] } });
  k.llm.transcribe = async () => { throw new ProviderError('unreachable', 'no route to the server'); };
  await tapAndSay(k, 'where-eat');
  for (let i = 1; i < WRITE_TRIES; i++) {
    k.agent.send(`Line ${i}`);
    await idleAtOnce(k);
    assert.equal(k.voice.memory.size, 1, `after ${i} real tries the sound is kept`);
  }
  k.agent.send(`Line ${WRITE_TRIES}`);
  await idleAtOnce(k);
  assert.deepEqual((await k.events(['heard.text'])).map((/** @type {any} */ e) => e.data.text), [NOT_TRANSCRIBED]);
  assert.equal(k.voice.memory.size, 0);
});

// The mark is added to, never replaced by what a turn of another conversation left unwritten (Fable 2).
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

// A turn that worked whose write-down failed leaves the line unwritten too (Haiku F3): her audio model answered it and fails the next line, with a text-only
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

// What it doesn't do (Haiku F3's caveat): a line heard as the turn ends has no turn yet, and isn't in the transcript, so it can't be marked; its own turn, with
// her audio model failing and a text-only one behind it, fails with the card as for any heard line (spec §10.3), though the line before it is marked.
test("a line heard as a turn ends keeps its own turn's card where nothing can hear it, though the heard line before it is past its turn", async (t) => {
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
