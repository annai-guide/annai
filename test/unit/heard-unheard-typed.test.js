// A heard line nothing could write down fails its own turn for a model that takes no audio (spec §10.3: skipped like any capability gap), and
// no later one: the flake look's lead (2026-11-25), where a typed "Hello" after such a clip failed with "Nothing in the speech-in list worked"
// until the clip left memory, which only a turn that worked (or a restart) does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear, idleAtOnce } from './agent-kit.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { COOLDOWN_MS } from '../../src/core/llm/fallback.js';
import { KOE_REST_MS } from '../../src/core/agent/halves.js';
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
  await new Promise((r) => setTimeout(r, KOE_REST_MS));
  k.agent.send('Still there?');
  await idleAtOnce(k);
  const [koe] = holding(k.sent['model-koe'] ?? [], 'Still there?');
  assert.ok(koe, 'Koe, rested, was sent the next one');
  assert.deepEqual(heardAs(koe), { type: 'text', text: NOT_TRANSCRIBED });
  assert.deepEqual((await spoken(k)).at(-1), ['koe', 'Koe here.']);
  assert.equal((await errors(k)).length, 2);
  assert.equal(k.voice.memory.size, 1, 'the sound is still kept');
});
