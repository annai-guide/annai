// A heard line nothing could write down, for a model that takes no audio (spec §10.3): the flake look's lead (2026-11-25), where a typed "Hello" after
// such a clip failed with "Nothing in the speech-in list worked" until the clip left memory. The turn's own call asks the models it passed over for the line
// once more, with it as "[audio, not transcribed]" (callRole's last pass, standIn): the line's own turn is answered, and so is every later one, while a model
// later in the list that can hear it still gets it first. Its sound stays for a write-down; three turns that worked and couldn't write it down, its own among
// them, give it up (WRITE_TRIES).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear, idleAtOnce } from './agent-kit.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { COOLDOWN_MS } from '../../src/core/llm/fallback.js';
import { Agent } from '../../src/core/agent/loop.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { NOT_TRANSCRIBED } from '../../src/core/voice/resolve.js';
import { useClock } from './clock.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const speakOnly = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }] });
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
const choose = (/** @type {'A' | 'B'} */ letter) => ({ toolCalls: [{ name: 'decide', input: { option: letter } }] });
/** Taps Shiori and says one of the clips. @param {any} k @param {string} name */
async function tapAndSay(k, name) {
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, name);
  await idleAtOnce(k);
}
/** The requests that hold this text. @param {any[]} requests @param {string} text */
const holding = (requests, text) => requests.filter((r) => JSON.stringify(r.messages).includes(text));
/** What a request sent for its heard lines: the part after each label. @param {any} r */
const heardAs = (r) => {
  assert.ok(r, 'the request reached her model');
  const parts = r.messages.flatMap((/** @type {any} */ m) => m.parts);
  return parts.flatMap((/** @type {any} */ p, /** @type {number} */ i) => (p.type === 'text' && /^\[heard[\],]/.test(p.text) ? [parts[i + 1]] : []));
};
/** How many parts of a request are a line as not transcribed: a heard line's, or a spoken answer's in her speak's result. @param {any} r */
const standIns = (r) => r.messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'text' && p.text === NOT_TRANSCRIBED).length;
/** Every error's words, in order. @param {any} k */
const errors = async (k) => (await k.events(['error'])).map((/** @type {any} */ e) => e.data.message);
/** What was said aloud, by whom. @param {any} k */
const spoken = async (k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.half ?? 'one', e.data.text]);
/** What the heard lines were written down as. @param {any} k */
const written = async (k) => (await k.events(['heard.text'])).map((/** @type {any} */ e) => e.data.text);
const STAND_IN = { type: 'text', text: NOT_TRANSCRIBED };

/** The transcription model's failures, how long each rests it, and (for those that rest it not at all) how many times it is asked before her model's first
 * request: a cut send or a model that can't be reached is not asked again in the call (voice.js's cut), and a refused recording is asked once a call
 * (resolve.js's failed asks), though nothing rests either. A timeout arrives at once here: no send time passes in these tests. */
const FAILURES = /** @type {const} */ ([
  ['unreachable, as on a dead link', () => new ProviderError('unreachable', 'no route to the server'), 0, 1],
  ['cut after its send time (the timeout arrives at once here)', () => new ProviderError('timeout', 'No answer in 12 seconds.', { said: { code: 'send', seconds: 12 } }), 0, 1],
  ['refusing the recording', () => new ProviderError('bad-request', 'audio too short', { status: 400 }), 0, 1],
  ['taking no audio format this phone makes (refused before any upload)', () => new ProviderError('bad-request', 'Hear takes no audio format this phone makes (webm).', { said: { code: 'formats', name: 'Hear', formats: ['webm'] } }), 0, 1],
  ['down', () => new ProviderError('server', 'down'), COOLDOWN_MS, null],
  ['rate-limited', () => new ProviderError('rate', 'slow down', { status: 429 }), COOLDOWN_MS, null],
  ['out of credit', () => new ProviderError('credit', 'out of credit', { status: 402 }), COOLDOWN_MS, null],
]);

/**
 * One Shiori, every chat model text-only, the transcription model failing with fail() until back() is called. The ledger: the asks the transcription model got,
 * and how many it had got when her model's first request came.
 * @param {any[]} replies @param {() => Error} fail
 */
async function deafKit(replies, fail) {
  /** @type {{ asks: number, beforeFirst: number | null }} */
  const ledger = { asks: 0, beforeFirst: null };
  const k = await agentKit([replies], { voice: { speechIn: ['m-hear'], hears: ['where should we eat'] }, hold: async () => { ledger.beforeFirst ??= ledger.asks; } });
  const hears = k.llm.transcribe;
  let down = true;
  k.llm.transcribe = async (/** @type {any} */ c) => { ledger.asks++; if (down) throw fail(); return hears(c); };
  return { k, back: () => { down = false; }, ledger };
}

for (const [how, fail, rests, askedBefore] of FAILURES) {
  test(`one Shiori, every model text-only, the transcription model ${how}: the heard line's own turn is answered with it as not transcribed, so is a line typed after it, and its words come once the model hears again`, async (t) => {
    useClock(t);
    const { k, back, ledger } = await deafKit([say('I could not hear that.'), say('Hello there.'), say('Lunch is near.')], fail);
    await tapAndSay(k, 'where-eat');
    assert.equal(k.requests.length, 1, 'its own turn reached her model');
    if (askedBefore !== null) assert.equal(ledger.beforeFirst, askedBefore, 'the transcription model was asked once before her model was: the last pass makes no second ask');
    assert.deepEqual(heardAs(k.requests[0]), [STAND_IN]);
    assert.deepEqual(await errors(k), [], 'no card');
    assert.equal(k.voice.memory.size, 1, 'the sound is kept, to be written down');
    k.agent.send('Hello');
    await idleAtOnce(k);
    const [typed] = holding(k.requests, 'Hello');
    assert.deepEqual(heardAs(typed), [STAND_IN]);
    assert.deepEqual(await spoken(k), [['one', 'I could not hear that.'], ['one', 'Hello there.']]);
    assert.deepEqual(await errors(k), []);
    assert.deepEqual(await written(k), []);
    // The model hears again (after its rest, if it took one): the third turn that works is sent the words, and they are written down.
    if (rests) await new Promise((r) => setTimeout(r, rests));
    back();
    k.agent.send('And now?');
    await idleAtOnce(k);
    const [next] = holding(k.requests, 'And now?');
    assert.deepEqual(heardAs(next), [{ type: 'text', text: 'where should we eat' }]);
    assert.deepEqual(await written(k), ['where should we eat']);
    assert.equal(k.voice.memory.size, 0);
  });

  // The count as before the clip-typed branch: each turn that works tries to write the line down, and the third that can't writes it as not transcribed,
  // whatever the failure, a model resting through all three included. Its own turn is the first.
  test(`one Shiori, every model text-only, the transcription model ${how}: by the end of the third turn that worked, its own among them, the heard line is written as not transcribed, and a model back later is not given it`, async (t) => {
    useClock(t);
    const { k, back, ledger } = await deafKit([say('I could not hear that.'), say('One.'), say('Two.'), say('Three.')], fail);
    await tapAndSay(k, 'where-eat');
    // Three, written out (WRITE_TRIES): the line is kept after the first and the second turn that worked, and given up at the third.
    const asks = [ledger.asks];
    for (const line of ['Line 1', 'Line 2']) {
      assert.deepEqual(await written(k), [], `kept after ${asks.length} turn(s) that worked`);
      assert.equal(k.voice.memory.size, 1, 'and its sound with it');
      k.agent.send(line);
      await idleAtOnce(k);
      asks.push(ledger.asks);
    }
    assert.deepEqual(await written(k), [NOT_TRANSCRIBED]);
    assert.equal(k.voice.memory.size, 0, 'its sound is let go');
    if (rests) assert.deepEqual(asks, [asks[0], asks[0], asks[0]], 'a model in its rest is asked nothing by the lines typed in it, or by their write-downs');
    else assert.ok(asks[0] < asks[1] && asks[1] < asks[2], "each turn's try asked the transcription model, one that rests not at all");
    if (rests) await new Promise((r) => setTimeout(r, rests));
    back();
    k.agent.send('Can you hear me now?');
    await idleAtOnce(k);
    assert.deepEqual(heardAs(holding(k.requests, 'Can you hear me now?')[0]), [STAND_IN], 'the line stays not transcribed');
    assert.deepEqual(await errors(k), []);
  });
}

// The count is of turns that worked (WRITE_TRIES): housekeeping's write-down, in the cold start's tidy-up and the warm timer, keeps the sound and counts nothing,
// so a line is not given up after one turn that worked and a quiet spell (Haiku src-b F1 of the clip-route-next review).
test("housekeeping's tries to write the heard line down keep its sound and count nothing: after one turn that worked, the cold tidy-up and the warm timer leave it, and the third turn that worked gives it up", async (t) => {
  useClock(t);
  const refused = { error: 'bad-request', status: 400 };
  const k = await agentKit([[say('I could not hear that.'), refused, refused, refused, refused, say('Two.'), say('Three.')]], {
    utility: [{ text: 'Someone spoke.' }], voice: { speechIn: ['m-hear'], hears: ['where should we eat'] },
  });
  k.llm.transcribe = async () => { throw new ProviderError('unreachable', 'no route to the server'); };
  await tapAndSay(k, 'where-eat'); // the first turn that worked (1)
  // Four typed lines whose turns fail (no count), so the heard line is in the part housekeeping would summarize: five exchanges, three kept word for word.
  for (let i = 0; i < 4; i++) {
    k.agent.send(`Message ${i}`);
    await idleAtOnce(k);
  }
  assert.equal(await k.agent.compact('cold'), false, 'the cold start\'s tidy-up: the sound is still at hand');
  assert.equal(await k.agent.compact('warm'), false, "the warm timer's: the same");
  assert.equal((await k.events(['compaction'])).length, 0);
  assert.deepEqual(await written(k), [], 'not given up by housekeeping');
  assert.equal(k.voice.memory.size, 1);
  k.agent.send('Line two');
  await idleAtOnce(k); // the second turn that worked (2)
  assert.deepEqual(await written(k), [], 'kept after the second');
  k.agent.send('Line three');
  await idleAtOnce(k); // the third (3)
  assert.deepEqual(await written(k), [NOT_TRANSCRIBED]);
  assert.equal(k.voice.memory.size, 0);
});

// Every later turn, whatever woke it, goes the same way: a watch's wake, the user's Try again, two lines nothing could hear.
test('after a heard line nothing could write down, a watch firing, Try again, and a second such line are each answered, the lines as not transcribed', async (t) => {
  useClock(t);
  const { k } = await deafKit([say('I could not hear that.'), say('The time came.'), say('Again: I could not hear that.'), say('Nor that.')], () => new ProviderError('unreachable', 'no route to the server'));
  await tapAndSay(k, 'where-eat');
  k.agent.wake({ kind: 'trigger', text: 'Your watch w-1 fired: the time came.', fallbacks: [] });
  await idleAtOnce(k);
  assert.deepEqual(heardAs(holding(k.requests, 'Your watch w-1 fired')[0]), [STAND_IN], "the watch's wake");
  assert.deepEqual(await written(k), [], 'kept after the second turn that worked, the watch');
  k.agent.tryAgain();
  await idleAtOnce(k);
  assert.deepEqual(heardAs(k.requests[2]), [STAND_IN], 'Try again');
  assert.deepEqual(await written(k), [NOT_TRANSCRIBED], 'given up at the third turn that worked, Try again, not before or after');
  assert.equal(k.voice.memory.size, 0);
  await tapAndSay(k, 'gas-station');
  assert.deepEqual(heardAs(k.requests[3]), [STAND_IN, STAND_IN], 'a second heard line, beside the first');
  assert.equal(k.voice.memory.size, 1, "the second's sound is kept");
  assert.equal(k.requests.length, 4);
  assert.deepEqual(await errors(k), []);
  assert.deepEqual((await spoken(k)).map(([, text]) => text), ['I could not hear that.', 'The time came.', 'Again: I could not hear that.', 'Nor that.']);
});

// The last pass still resolves each line for the model it goes to: a line a transcription model can hear goes as words beside one it refused.
test('one recording the transcription model refuses and the next it hears: the next turn sends the first as not transcribed and the second as its words', async (t) => {
  useClock(t);
  const k = await agentKit([[say('I could not hear that.'), say('Gas is near.')]], { voice: { speechIn: ['m-hear'], hears: ['find a gas station'] } });
  const hears = k.llm.transcribe;
  /** @type {number | undefined} */
  let refused;
  k.llm.transcribe = async (/** @type {any} */ c) => {
    refused ??= c.audio.data.length;
    if (c.audio.data.length === refused) throw new ProviderError('bad-request', 'audio too short', { status: 400 });
    return hears(c);
  };
  await tapAndSay(k, 'where-eat');
  assert.deepEqual(heardAs(k.requests[0]), [STAND_IN]);
  await tapAndSay(k, 'gas-station');
  assert.deepEqual(heardAs(k.requests[1]), [STAND_IN, { type: 'text', text: 'find a gas station' }]);
  assert.deepEqual(await errors(k), []);
});

// A Stop while the heard line's transcription is under way: the last pass meets the Stop as any later model does, and the turn ends as stopped, with no card
// for the line beside "Stopped by the user." (one came before the last pass: "Nothing in the speech-in list worked").
test("the user's Stop during the heard line's transcription ends the turn as stopped, with no card for the line", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Hello there.')]], { voice: { speechIn: ['m-hear'] } });
  let asked = false;
  k.llm.transcribe = (/** @type {any} */ c) => new Promise((_, reject) => {
    asked = true;
    c.signal?.addEventListener('abort', () => reject(new ProviderError('cancelled', 'Stopped.')));
  });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await until(() => asked);
  k.agent.interrupt();
  await idleAtOnce(k);
  assert.deepEqual(await errors(k), ['Stopped by the user.']);
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => n.title), []);
  assert.deepEqual(await spoken(k), []);
});

// The same Stop, then a line typed: the stopped turn's line is read as not transcribed, and the typed line is answered (the model hears nothing of the Stop).
test("a Stop during the heard line's transcription, then a typed line: the typed line is answered with the stopped line as not transcribed, and no card comes beyond the Stop's", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Again.')]], { voice: { speechIn: ['m-hear'] } });
  let asked = false;
  k.llm.transcribe = (/** @type {any} */ c) => new Promise((_, reject) => {
    asked = true;
    c.signal?.addEventListener('abort', () => reject(new ProviderError('cancelled', 'Stopped.')));
  });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await until(() => asked);
  k.agent.interrupt();
  await idleAtOnce(k);
  assert.deepEqual(await errors(k), ['Stopped by the user.']);
  k.llm.transcribe = async () => { throw new ProviderError('unreachable', 'no route to the server'); };
  k.agent.send('Hello');
  await idleAtOnce(k);
  const [typed] = holding(k.requests, 'Hello');
  assert.deepEqual(heardAs(typed), [STAND_IN]);
  assert.deepEqual(await errors(k), ['Stopped by the user.']);
  assert.deepEqual(await spoken(k), [['one', 'Again.']]);
});

// Her question, answered by voice: the answer is heard inside her turn, and the turn's next request is answered with it as not transcribed.
test('a spoken answer to her question nothing could write down is answered in that turn', async (t) => {
  useClock(t);
  const { k } = await deafKit([speakOnly('Want tacos?'), say('I could not hear you. Tacos, then?')], () => new ProviderError('unreachable', 'no route to the server'));
  k.agent.send('Lunch?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await idleAtOnce(k);
  assert.equal(k.requests.length, 2);
  assert.equal(standIns(k.requests[1]), 1, "the answer, in her speak's result");
  assert.deepEqual(await errors(k), []);
  assert.deepEqual((await spoken(k)).map(([, text]) => text), ['Want tacos?', 'I could not hear you. Tacos, then?']);
});

// The same answer, in a turn that ends (here at a step budget of one) before any request sent it: the next typed line is answered at once.
test('a spoken answer to her question, in a turn that ends before its next request: the next typed line is answered, with it as not transcribed', async (t) => {
  useClock(t);
  const { k } = await deafKit([speakOnly('Want tacos?'), say('Hello there.')], () => new ProviderError('unreachable', 'no route to the server'));
  await updateAppSettings(k.ws, { shiori: { budgets: { stepsPerWake: 1 } } });
  k.agent.send('Thanks');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await idleAtOnce(k);
  assert.equal(k.requests.length, 1, 'the step budget ended the turn before a request sent the answer');
  k.agent.send('Hello');
  await idleAtOnce(k);
  const [typed] = holding(k.requests, 'Hello');
  assert.ok(typed, 'the typed line reached her model');
  assert.equal(standIns(typed), 1, "the answer, in her speak's result");
  assert.equal((await errors(k)).filter((m) => /speech-in list/.test(m)).length, 0, 'no card for the line');
  assert.deepEqual((await spoken(k)).at(-1), ['one', 'Hello there.']);
});

// Chatter the gate set aside in the window after her turn, while no turn ran: the next typed line is answered, with it as not transcribed. The gate takes
// audio (so it hears the line while the transcription model is out); every chat model doesn't. The transcription model goes out just before the chatter.
test('chatter set aside while no turn ran, which nothing could write down: the next typed line is answered, with it as not transcribed', async (t) => {
  useClock(t);
  const k = await agentKit([[speakOnly('Anything else?'), { text: 'Enjoy the drive.' }, say('Hello there.')]], {
    voice: { speechIn: ['send-audio', 'm-hear'], decide: [choose('A'), choose('B')], gateHears: true, hears: ['no thanks'] },
  });
  k.agent.send('Thanks');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one'); // for her: it ends speak's wait, and she answers in words, not asleep: the window after her turn opens
  await idleAtOnce(k);
  assert.deepEqual(await written(k), ['no thanks']);
  await until(() => k.agent.state.name === 'listening');
  k.llm.transcribe = async () => { throw new ProviderError('unreachable', 'no route to the server'); };
  await hear(k, 'gas-station');
  await idleAtOnce(k);
  const heard = await k.events(['heard']);
  assert.deepEqual(heard.map((/** @type {any} */ e) => e.data.gate), ['shiori', 'chatter']);
  assert.ok(!heard[1].data.wake, 'set aside with no turn');
  const before = k.requests.length;
  k.agent.send('Hello');
  await idleAtOnce(k);
  const [typed] = holding(k.requests.slice(before), 'Hello');
  assert.ok(typed, 'the typed line reached her model');
  assert.equal(standIns(typed), 1, 'the chatter, as not transcribed');
  assert.deepEqual(await errors(k), []);
  assert.deepEqual((await spoken(k)).at(-1), ['one', 'Hello there.']);
});

// With Keep voice clips on, a restart reads the clip back from the conversation, and nothing tells its first turn from a later one: the first line typed
// after the restart is answered. The heard line's own turn fails here for its model's own reason (a 400), the same with or without the last pass.
test('Keep voice clips on, annai restarted after a heard line nothing could write down: the first line typed after it is answered, with it as not transcribed', async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: 'the user wrote', reply: say('Hello there.') }, { match: '.', reply: { error: 'bad-request', status: 400 } }] }], { voice: { speechIn: ['m-hear'], keepClips: true } });
  k.llm.transcribe = async () => { throw new ProviderError('unreachable', 'no route to the server'); };
  await tapAndSay(k, 'where-eat');
  assert.equal((await errors(k)).length, 1, 'its own turn failed');
  const [heard] = await k.events(['heard']);
  assert.ok(heard.data.clip, 'its clip is kept');
  // The restart: the page and its memory are gone; a new agent opens the conversation, with the clip in it.
  k.agent.leaving();
  k.voice.memory.drop(heard.data.id);
  const again = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, codec: k.codec, voice: k.voice, timeZone: () => 'UTC', secondMs: 10 });
  again.addLoopTools(selfTools(again));
  await again.open(k.trip);
  await idleAtOnce({ agent: again });
  const before = k.requests.length;
  again.send('Hello');
  await idleAtOnce({ agent: again });
  const [typed] = holding(k.requests.slice(before), 'Hello');
  assert.ok(typed, 'the first typed line reached her model');
  assert.deepEqual(heardAs(typed), [STAND_IN]);
  assert.equal((await errors(k)).length, 1, 'no second card');
  assert.deepEqual((await spoken(k)).at(-1), ['one', 'Hello there.'], 'it was answered');
  assert.equal(k.voice.memory.size, 1, 'the clip read back is in memory, to be written down');
});

// A text-only model ahead of an audio model resting after a rate limit, and the reverse: the heard line's own turn is answered by the text-only model with
// it as not transcribed; the next line asks the resting audio model first (one resting model a turn, §9.6), which hears it and writes it down.
for (const order of /** @type {const} */ (['text-only first', 'audio first'])) {
  test(`one Shiori, a text-only model and an audio one (${order}), the transcription model unreachable: the audio model rate-limited, the heard line is answered by the text-only one, and the next line gives the audio model the sound`, async (t) => {
    useClock(t);
    const deaf = [say('I could not hear that.'), say('Never.')];
    const ears = [{ error: 'rate', message: 'slow down', status: 429 }, say('Tacos are near.'), { text: 'where should we eat' }];
    const first = order === 'text-only first';
    const k = await agentKit(first ? [deaf, ears] : [ears, deaf], { models: first ? [{}, { input: ['text', 'image', 'audio'] }] : [{ input: ['text', 'image', 'audio'] }, {}], voice: { speechIn: ['send-audio', 'm-hear'] } });
    k.llm.transcribe = async () => { throw new ProviderError('unreachable', 'no route to the server'); };
    const [text, audio] = first ? ['model-0', 'model-1'] : ['model-1', 'model-0'];
    await tapAndSay(k, 'where-eat');
    assert.deepEqual(heardAs((k.sent[text] ?? [])[0]), [STAND_IN], 'the text-only model answered it as not transcribed');
    assert.equal((k.sent[audio] ?? []).length, 1, 'the audio model was asked once, and was rate-limited');
    assert.deepEqual(await errors(k), []);
    k.agent.send('Hello');
    await idleAtOnce(k);
    const [heard] = holding(k.sent[audio] ?? [], 'Hello');
    assert.equal(heardAs(heard)[0]?.type, 'audio', 'the resting audio model was asked, with the sound');
    assert.equal((k.sent[text] ?? []).length, 1, 'the text-only model was sent nothing more');
    assert.deepEqual(await written(k), ['where should we eat'], 'and it wrote the line down');
    assert.deepEqual((await spoken(k)).map(([, s]) => s), ['I could not hear that.', 'Tacos are near.']);
  });
}

// A turn that worked whose write-down failed leaves the line in memory; when her audio model fails the next line, the text-only model behind it answers it.
test("her audio model heard the line and its write-down failed; when it fails the next line, the text-only model behind it answers, with the line as not transcribed", async (t) => {
  useClock(t);
  const fail = { error: 'bad-request', status: 400 };
  const k = await agentKit([[say('Hello there.'), fail, fail], [say('From the other one.')]], { models: [{ input: ['text', 'image', 'audio'] }, {}], voice: { speechIn: ['send-audio'] } });
  await tapAndSay(k, 'where-eat');
  assert.equal((k.sent['model-0'] ?? []).length, 2, 'the audio model answered it, and was asked to write it down');
  assert.deepEqual(await written(k), [], 'its write-down failed');
  assert.equal(k.voice.memory.size, 1);
  k.agent.send('Hello');
  await idleAtOnce(k);
  const [other] = holding(k.sent['model-1'] ?? [], 'Hello');
  assert.ok(other, 'the text-only model was sent the typed line');
  assert.deepEqual(heardAs(other), [STAND_IN]);
  assert.deepEqual(await errors(k), [], 'no card');
  assert.deepEqual(await spoken(k), [['one', 'Hello there.'], ['one', 'From the other one.']]);
});

// Halves, every chat model text-only, the transcription model unreachable: Koe answers the heard line with it as not transcribed, and is not down; so is a
// line typed after it.
test('Koe and Kokoro on text-only models, the transcription model unreachable: Koe answers the heard line, with it as not transcribed, and stays up; a typed line after it is answered too', async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], {
    koe: { type: { rules: [{ match: 'the user spoke', reply: say('Sorry, I missed that.') }, { match: 'the user wrote', reply: say('Koe here.') }] } },
    voice: { speechIn: ['m-hear'] },
  });
  k.llm.transcribe = async () => { throw new ProviderError('unreachable', 'no route to the server'); };
  /** The write-downs that were run (the loop's, after a turn that worked), by segment: each fails, the transcription model being out. @type {string[]} */
  const writeDowns = [];
  const writeDown = k.voice.writeDown.bind(k.voice);
  k.voice.writeDown = async (/** @type {string} */ id, /** @type {any} */ o) => { writeDowns.push(id); return writeDown(id, o); };
  await tapAndSay(k, 'where-eat');
  assert.equal(writeDowns.length, 1, "after Koe's answer the line's write-down was tried");
  assert.notEqual(k.agent.koeState, 'down');
  assert.deepEqual(heardAs((k.sent['model-koe'] ?? [])[0]), [STAND_IN]);
  assert.deepEqual(await errors(k), [], 'no card from either half');
  k.agent.send('Hello');
  await idleAtOnce(k);
  const [koe] = holding(k.sent['model-koe'] ?? [], 'Hello');
  assert.deepEqual(heardAs(koe), [STAND_IN]);
  assert.deepEqual((await spoken(k)).map(([half, s]) => `${half}: ${s}`), ['koe: Sorry, I missed that.', 'koe: Koe here.']);
  assert.deepEqual(await errors(k), []);
  assert.equal(writeDowns.length, 2, "and after the second turn's");
  assert.equal(k.voice.memory.size, 1, "the sound is kept: the transcription model could write nothing down in either of Koe's turns");
});

// Halves, Koe on text-only models, Kokoro's main model takes audio ("Send audio to the model" is in the list), the transcription model unreachable (Fable F1 of
// the clip-route-next review, probe P8): Kokoro's list hears the line, so Koe's turn does not take the last pass. Koe's call fails as it did before the branch,
// Kokoro answers the line from its sound and its audio model writes the words down. (Koe answering from the stand-in left the line unwritten for good.)
test("Halves, Koe on text-only models and Kokoro's model takes audio: Koe's turn is not answered with the line as not transcribed; Kokoro hears it, answers it aloud, and writes the words down", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Tacos are near.'), { text: 'where should we eat' }]], {
    models: [{ input: ['text', 'image', 'audio'] }],
    koe: { type: { rules: [{ match: '.', reply: say('Koe: I could not hear that.') }] } },
    voice: { speechIn: ['send-audio', 'm-hear'] },
  });
  k.llm.transcribe = async () => { throw new ProviderError('unreachable', 'no route to the server'); };
  await tapAndSay(k, 'where-eat');
  assert.deepEqual(k.sent['model-koe'] ?? [], [], "Koe's text-only model was sent nothing: no stand-in");
  const [first] = k.sent['model-0'] ?? [];
  assert.equal(heardAs(first)[0]?.type, 'audio', "Kokoro's audio model was sent the sound");
  assert.deepEqual((await spoken(k)).map(([half, s]) => `${half}: ${s}`), ['kokoro: Tacos are near.']);
  assert.deepEqual(await written(k), ['where should we eat'], 'and its audio model wrote the line down');
  assert.equal(k.voice.memory.size, 0);
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => n.title), [], 'no card');
});

// Halves, Koe hearing the line as sound, Kokoro text-only, and Koe's write-down slow: Kokoro's turn for Koe's answer, before the words exist, is answered
// with the line as not transcribed, with no card (it showed the card "Nothing in the speech-in list worked" though Koe had answered).
test("Halves, Koe hears the line as sound and Kokoro is text-only: Kokoro's turn before Koe's write-down is answered, with the line as not transcribed, and no card", async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], {
    koe: { talk: [say('Sure.'), { delayMs: 500, text: 'where should we eat' }], input: ['text', 'audio'] },
    voice: { speechIn: ['send-audio'] },
  });
  await tapAndSay(k, 'where-eat');
  const kokoro = k.sent['model-0'] ?? [];
  assert.ok(kokoro.length >= 1, 'Kokoro was asked');
  assert.deepEqual(heardAs(kokoro[0]), [STAND_IN], 'before the words were written down');
  assert.deepEqual(await errors(k), [], 'no card');
  assert.deepEqual(await written(k), ['where should we eat'], "Koe's write-down came after");
});

// Halves, Kokoro's list a text-only model then an audio one: its turn passes the text-only model over and gives the audio one the sound.
test("Halves, Kokoro's text-only model ahead of an audio one: Kokoro's turn before Koe's write-down gives the audio model the sound, and the text-only one is sent nothing", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Never.')], [sleep]], {
    models: [{}, { input: ['text', 'image', 'audio'] }],
    koe: { talk: [say('Sure.'), { delayMs: 500, text: 'where should we eat' }], input: ['text', 'audio'] },
    voice: { speechIn: ['send-audio'] },
  });
  await tapAndSay(k, 'where-eat');
  assert.deepEqual(k.sent['model-0'] ?? [], [], 'the text-only model was sent nothing');
  assert.equal(heardAs((k.sent['model-1'] ?? [])[0])[0]?.type, 'audio');
  assert.deepEqual(await errors(k), []);
  assert.deepEqual(await written(k), ['where should we eat'], "Koe's write-down came after");
});
