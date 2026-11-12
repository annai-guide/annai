import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear } from './agent-kit.js';
import { clip, quiet, cat } from './voice-kit.js';
import { useClock } from './clock.js';
import { createTrip } from '../../src/core/scopes.js';

/** speak, as a model whose arguments stream would send it. @param {string} text @param {any} [more] */
const speakStep = (text, more = {}) => ({ stream: true, toolCalls: [{ name: 'speak', input: { text } }], ...more });
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
/** What played, in order. @param {any} k */
const plays = (k) => k.platform.log.filter((/** @type {string} */ l) => l.startsWith('play ')).map((/** @type {string} */ l) => l.replace(/^play m-say:/, ''));
/** The microphone's openings and closings, in order. @param {any} k */
const mics = (k) => k.platform.log.filter((/** @type {string} */ l) => l.startsWith('mic '));
/** Each call of a tool's result, in order. @param {any} k @param {string} name */
const results = async (k, name) => (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.name === name);

test('speak plays as the reply streams in, sentence by sentence, then listens; the spoken answer comes back as heard speech (spec §7.1, §10.1)', async (t) => {
  useClock(t);
  const k = await agentKit([[speakStep('There is a taco stand ahead. Want to stop?', { pieceMs: 15 }), say('Great.')]], { voice: { speechIn: ['m-hear'], hears: ['yes the first one'] } });
  let playedBeforeTheCall = -1;
  k.agent.on('event', (e) => { if (e.type === 'tool.call' && e.data.name === 'speak' && playedBeforeTheCall < 0) playedBeforeTheCall = plays(k).length; });
  k.agent.send('Where should we eat?');
  await until(() => k.agent.state.name === 'listening');
  assert.ok(playedBeforeTheCall >= 1, 'the first sentence played before the reply was complete');
  await hear(k, 'first-one');
  await k.agent.idle();
  assert.deepEqual(plays(k), ['There is a taco stand ahead.', 'Want to stop?', 'Great.']);
  const [speak] = await results(k, 'speak');
  assert.equal(speak.data.content, 'Said aloud. The user said:');
  const [heard] = await k.events(['heard']);
  assert.deepEqual(speak.data.heard, [heard.data.id]);
  assert.equal(heard.data.answer, speak.data.id);
  const last = k.requests[1].messages.at(-1);
  assert.deepEqual(last.parts.slice(0, 2), [{ type: 'tool_result', id: last.parts[0].id, content: 'Said aloud. The user said:' }, { type: 'text', text: 'yes the first one' }]);
  assert.deepEqual(k.transcribed, ['m-hear']);
  assert.equal(k.agent.state.name, 'sleeping');
  assert.equal(mics(k).at(-1), 'mic close');
  assert.deepEqual(k.platform.sessions, ['playback', 'play-and-record', 'playback', 'playback']);
});

test('sleep in the same reply: she speaks and does not listen; the microphone never opens (spec §7.1)', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]], { voice: {} });
  k.agent.send('Dinner is at 6:30');
  await k.agent.idle();
  assert.deepEqual(plays(k), ['Noted.']);
  assert.equal(k.platform.opens, 0);
  assert.equal((await results(k, 'speak'))[0].data.content, 'Said aloud.');
  assert.equal((await k.events(['out.speak']))[0].data.voice, true);
  assert.equal(k.agent.state.name, 'sleeping');
});

test('heard nothing: speak stops listening after the silence limit (spec §7.1)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Anything else?' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: {} });
  k.agent.send('Thanks');
  await k.agent.idle();
  assert.equal((await results(k, 'speak'))[0].data.content, 'Said aloud. Heard nothing (20 seconds).');
  assert.deepEqual(k.platform.log.filter((/** @type {string} */ l) => l.startsWith('mic')), ['mic open', 'mic close']);
});

test('voice off: speak shows a bubble and listens to nothing; the now block says which; voice on asks for first words sooner (spec §6.3, §9.6)', async (t) => {
  useClock(t);
  const off = await agentKit([[say('Here.')]], { voice: { mode: 'off' } });
  off.agent.send('Hi');
  await off.agent.idle();
  assert.deepEqual(plays(off), []);
  assert.equal((await results(off, 'speak'))[0].data.content, 'shown');
  assert.match(off.requests[0].tail, /voice: off/);
  const on = await agentKit([[say('Here.')]], { voice: {} });
  /** @type {any[]} */
  const calls = [];
  const call = on.llm.call;
  on.llm.call = (/** @type {any} */ c) => { calls.push(c); return call(c); };
  on.agent.send('Hi');
  await on.agent.idle();
  assert.match(on.requests[0].tail, /voice: on/);
  assert.equal(calls[0].firstOutputMs, 15_000);
  assert.equal(typeof calls[0].speech, 'function');
});

test('tapping her while she speaks stops her, keeps where, and opens the microphone; what is said next answers (spec §10.4)', async (t) => {
  useClock(t);
  const k = await agentKit([[speakStep('Bixby Bridge is two miles ahead. It opened in 1932.'), say('OK, the beach.')]], { voice: { playMs: 60, speechIn: ['m-hear'], hears: ['tell me about the beach'] } });
  k.agent.send('What is ahead?');
  await until(() => plays(k).length === 1);
  assert.equal(k.agent.tap(), 'cut');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await k.agent.idle();
  assert.equal((await results(k, 'speak'))[0].data.content, 'The user stopped you after: "Bixby Bridge is…". The user said:');
  assert.ok(!plays(k).includes('It opened in 1932.'));
  assert.equal(k.platform.log.filter((/** @type {string} */ l) => l === 'mic open').length, 1, 'one listening window, from the tap');
  assert.equal(k.requests.length, 2);
});

test('a spoken question answered only in plain text is asked again too, as a typed one is (review a2)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ text: 'Nepenthe is a good choice.' }, say('Nepenthe, on the cliffs.')]], { voice: { playMs: 5, speechIn: ['m-hear'], hears: ['where should we eat'] } });
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await k.agent.idle();
  assert.equal(k.requests.length, 2);
  assert.match(k.requests[1].tail, /The user hasn't been answered/);
  assert.deepEqual((await k.events(['out.speak'])).map((e) => e.data.text), ['Nepenthe, on the cliffs.']);
});

test('a heard segment, once it has come, is not still "speaking": the turn it wakes starts at once (GATHER; the full e2e run)', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Nepenthe.')]], { voice: { playMs: 5, speechIn: ['m-hear'], hears: ['where should we eat'] }, agent: { secondMs: 1000 } });
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await until(() => k.requests.length === 1, 10_000);
  const heard = (await k.events(['heard']))[0];
  assert.ok(Date.now() - heard.ts < 3000, `${Date.now() - heard.ts} ms after the words came (the cap is 20 s)`);
  await k.agent.idle();
});

test('two speaks in one streamed reply: the second plays after the first has listened, never over the open microphone (spec §10.4)', async (t) => {
  useClock(t);
  const k = await agentKit([[
    { stream: true, toolCalls: [{ name: 'speak', input: { text: 'First thing.' } }, { name: 'speak', input: { text: 'Second thing.' } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
  ]], { voice: { playMs: 40, speechIn: ['m-hear'] } });
  k.agent.send('Hi');
  await k.agent.idle();
  assert.deepEqual(k.platform.log, ['play m-say:First thing.', 'mic open', 'mic close', 'play m-say:Second thing.', 'mic open', 'mic close']);
});

test('once she is stopped, a later speak in the same reply is not said and does not listen; it shows as a bubble (spec §10.4)', async (t) => {
  useClock(t);
  const k = await agentKit([[
    { stream: true, toolCalls: [{ name: 'speak', input: { text: 'Bixby Bridge is two miles ahead. It opened in 1932.' } }, { name: 'speak', input: { text: 'Want to stop there?' } }] },
    say('OK, the beach.'),
  ]], { voice: { playMs: 60, speechIn: ['m-hear'], hears: ['tell me about the beach'] } });
  k.agent.send('What is ahead?');
  await until(() => plays(k).length === 1);
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await k.agent.idle();
  const [a, b] = await results(k, 'speak');
  assert.match(a.data.content, /^The user stopped you after: "Bixby Bridge is…"\. The user said:/);
  assert.equal(b.data.content, 'Not said aloud: the user stopped you. It was shown on screen.');
  assert.ok(!plays(k).includes('Want to stop there?'));
  assert.equal(k.platform.log.filter((/** @type {string} */ l) => l === 'mic open').length, 1, 'one listening window, from the tap');
  assert.equal((await k.events(['out.speak']))[1].data.voice, undefined, 'shown, not said');
  assert.equal(k.requests.length, 2);
});

test('tapping her while she sleeps starts listening; the first thing said wakes her; the microphone closes after her turn (spec §10.4)', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Yes, there is a café ahead.')]], { voice: { speechIn: ['m-hear'], hears: ['is there coffee nearby'] } });
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.deepEqual(k.requests[0].messages.at(-1).parts.slice(0, 2), [{ type: 'text', text: '[heard]' }, { type: 'text', text: 'is there coffee nearby' }]);
  assert.match(k.requests[0].tail, /woke for: the user spoke/);
  assert.deepEqual(plays(k), ['Yes, there is a café ahead.']);
  assert.equal(mics(k).at(-1), 'mic close');
  assert.equal(k.agent.state.name, 'sleeping');
});

test('a tap nobody speaks into closes after the silence limit; a tap while she listens stops listening; voice off opens typing', async (t) => {
  useClock(t);
  const k = await agentKit([[say('x')]], { voice: {} });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await until(() => k.agent.state.name === 'sleeping', 1000);
  assert.deepEqual(mics(k), ['mic open', 'mic close']);
  assert.equal(k.requests.length, 0);
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  assert.equal(k.agent.tap(), 'stopped');
  assert.equal(k.agent.state.name, 'sleeping');
  assert.equal(mics(k).at(-1), 'mic close');
  const off = await agentKit([[say('x')]], { voice: { mode: 'off' } });
  assert.equal(off.agent.tap(), 'typing');
});

test('while she thinks, the microphone keeps recording; what is heard reaches her next call as heard while you were thinking (spec §6.1, §10.4)', async (t) => {
  useClock(t);
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'Want tacos?' } }] },
    { delayMs: 120, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] },
    say('Tacos and a coffee, noted.'),
  ]], { voice: { speechIn: ['m-hear'], hears: ['yes please', 'and a coffee'] } });
  k.agent.send('Lunch ideas?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.deepEqual(k.requests[2].messages.at(-1).parts.slice(-2), [{ type: 'text', text: '[heard while you were thinking]' }, { type: 'text', text: 'and a coffee' }]);
  assert.deepEqual((await k.events(['heard'])).map((/** @type {any} */ e) => [Boolean(e.data.answer), Boolean(e.data.meanwhile)]), [[true, false], [false, true]]);
});

test('speech heard while she thinks: her next speak does not wait a silence for an answer; what was said reaches her at once (spec §10.4)', async (t) => {
  useClock(t);
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'Want tacos?' } }] },
    { delayMs: 120, toolCalls: [{ name: 'speak', input: { text: 'Tacos it is.' } }] },
    say('And a coffee, noted.'),
  ]], { voice: { speechIn: ['m-hear'], hears: ['yes please', 'and a coffee'] } });
  k.agent.send('Lunch ideas?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  await hear(k, 'gas-station');
  await k.agent.idle();
  const second = (await results(k, 'speak'))[1];
  assert.equal(second.data.content, 'Said aloud. Not listening for an answer: the user spoke while you were thinking; it follows.');
  assert.ok(second.data.ms < 80, `it took ${second.data.ms} ms: no silence limit (80 ms here) was waited`);
  assert.deepEqual(k.requests[2].messages.at(-1).parts.slice(-2), [{ type: 'text', text: '[heard while you were thinking]' }, { type: 'text', text: 'and a coffee' }]);
});

test('nothing heard is lost: speech that comes as she goes to sleep starts a new turn (spec §10.4)', async (t) => {
  useClock(t);
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'Anything else?' } }] },
    { delayMs: 120, toolCalls: [{ name: 'sleep', input: {} }] },
    say('Got it, a gas station.'),
  ]], { voice: { speechIn: ['m-hear'], hears: ['no thanks', 'actually find gas'] } });
  k.agent.send('Thanks');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.equal(k.requests.length, 3);
  assert.equal((await k.events(['wake'])).length, 2);
  assert.match(JSON.stringify(k.requests[2].messages.at(-1)), /actually find gas/);
  assert.equal(plays(k).at(-1), 'Got it, a gas station.');
});

test('speech still going on when the microphone closes for her to speak is kept, and reaches her (spec §10.4)', async (t) => {
  useClock(t);
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'One moment.' } }] },
    { delayMs: 60, stream: true, toolCalls: [{ name: 'speak', input: { text: 'Here is what I found.' } }] },
    say('And the rest, noted.'),
  ]], { voice: { speechIn: ['m-hear'], hears: ['ok', 'and also'] } });
  k.agent.send('Find a park');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  k.platform.mic.feed(cat(quiet(0.3), (await clip('gas-station')).subarray(0, 12_000)), 16_000); // mid-sentence when she starts to speak
  await k.agent.idle();
  assert.deepEqual(k.requests[2].messages.at(-1).parts.slice(-2), [{ type: 'text', text: '[heard while you were thinking]' }, { type: 'text', text: 'and also' }]);
});

test('a reply that breaks off mid-speak stops what it had begun; the next model says its own, whole (spec §9.6)', async (t) => {
  useClock(t);
  const k = await agentKit([[speakStep('First sentence here. Second one never comes.', { breakAt: 4 })], [say('From the other model.')]], { voice: {} });
  k.agent.send('Hi');
  await k.agent.idle();
  assert.equal(plays(k).at(-1), 'From the other model.');
  assert.ok(!plays(k).includes('Second one never comes.'));
  assert.equal((await k.events(['out.speak'])).length, 1);
  assert.equal(k.agent.state.name, 'sleeping');
});

test('ask is spoken too, and a spoken answer answers it; wait listens (spec §7.1)', async (t) => {
  useClock(t);
  const k = await agentKit([[
    { toolCalls: [{ name: 'ask', input: { question: 'Keep the 6:30 dinner?', options: ['Keep it', 'Move it'] } }] },
    { toolCalls: [{ name: 'wait', input: { seconds: 10 } }] },
    { toolCalls: [{ name: 'wait', input: { seconds: 10 } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
  ]], { voice: { speechIn: ['m-hear'], hears: ['keep it', 'one more thing'] } });
  k.agent.send('We are late');
  await until(() => k.agent.state.name === 'listening');
  assert.deepEqual(plays(k), ['Keep the 6:30 dinner?']);
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2 && k.agent.state.name === 'listening');
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.equal((await results(k, 'ask'))[0].data.content, 'The user said:');
  assert.deepEqual((await results(k, 'wait')).map((/** @type {any} */ e) => e.data.content), ['The user said:', 'Nothing yet (10 seconds).']);
});

test('one half: a claim answers a wait as the words it is, and the line says so; and the voice mode holds on a tap with voice off, as one half too', async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] }], { voice: { mode: 'off', speechIn: ['m-hear'] }, halves: true });
  k.agent.send('Is there parking?', { claim: 'h1' });
  await k.agent.idle();
  assert.equal((await k.events(['msg.user']))[0].data.claim, 'h1');
  assert.match(JSON.stringify(k.sent['model-0'][0]), /\[the user says this was for you\] \\+"Is there parking\?/);
  assert.equal(k.agent.tap(), 'listening');
  assert.equal(k.voice.on, true);
  await until(() => k.agent.state.name === 'listening');
  k.agent.tap();
  await until(() => !k.voice.on);
});

// Voice turning off while she says a speak line or a question aloud (by hand, or auto mode as the car slows): her speech is cut, and nothing
// listens for the turn after it. The microphone stays shut, the dock doesn't say Listening, and what is said next answers nothing; speak says
// voice mode is off, and her question goes straight on to its buttons.
for (const how of ['by hand', 'auto mode as the car slows']) {
  /**
   * A kit whose voice is on, and a way to turn it off: the chip's tap, or the drive ending under auto (voice off, on only while driving).
   * @param {any[]} script
   */
  const kitWithVoiceOff = async (script) => {
    const k = await agentKit([script], { voice: { mode: how === 'by hand' ? 'on' : 'off', playMs: 5000, speechIn: ['m-hear'], hears: ['the first one'] } });
    /** @type {Set<() => void>} */
    const changes = new Set();
    let driving = how !== 'by hand';
    if (driving) {
      k.registry.add('live', 'activity', { now: () => (driving ? 'moving-fast' : 'still'), held: () => driving, onChange: (/** @type {() => void} */ fn) => { changes.add(fn); } });
      await until(() => changes.size === 1);
      for (const fn of changes) fn();
      await until(() => k.voice.on);
    }
    const off = async () => {
      if (how === 'by hand') await k.voice.choose('off');
      else {
        driving = false;
        for (const fn of changes) fn();
      }
      await until(() => !k.voice.on);
      await new Promise((r) => setTimeout(r, 20)); // far less than her question's 8 s or the 20 s of silence
    };
    /** What is said into the microphone now: nobody hears it, whatever the dock says. */
    const speaks = async () => {
      k.platform.mic.feed(cat(quiet(0.3), await clip('first-one'), quiet(1)), 16_000);
      await new Promise((r) => setTimeout(r, 30));
    };
    return { k, off, speaks };
  };

  test(`voice turning off ${how} while she says a speak line: the microphone doesn't open, the dock doesn't say Listening, what is said next isn't her answer, and speak says voice mode is off (spec §10.5)`, async (t) => {
    useClock(t);
    const { k, off, speaks } = await kitWithVoiceOff([{ toolCalls: [{ name: 'speak', input: { text: 'Which day would you like?' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]);
    /** @type {string[]} */
    const states = [];
    k.agent.on('state', (/** @type {any} */ s) => states.push(s.name));
    k.agent.send('Plan our day');
    await until(() => k.said.includes('Which day would you like?') && k.agent.state.name === 'speaking');
    await off();
    await speaks();
    await k.agent.idle();
    assert.deepEqual(mics(k), [], 'the microphone never opened');
    assert.ok(!states.includes('listening') && !states.includes('hearing'), `the dock never said Listening: ${states}`);
    assert.deepEqual(k.transcribed, [], 'what was said into it was heard by no one');
    assert.deepEqual(await k.events(['heard']), []);
    assert.equal((await results(k, 'speak'))[0].data.content, `The user stopped you after: "Which day…". annai couldn't listen: voice mode is off. The user may type.`);
    assert.equal(k.agent.state.name, 'sleeping');
  });

  test(`voice turning off ${how} while she says her question aloud: the microphone doesn't open, the dock says she waits, what is said next isn't the answer, and the buttons still answer a tap (spec §10.5)`, async (t) => {
    useClock(t);
    const { k, off, speaks } = await kitWithVoiceOff([{ toolCalls: [{ name: 'ask', input: { question: 'Lunch or dinner?', options: ['Lunch', 'Dinner'] } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]);
    /** @type {string[]} */
    const states = [];
    k.agent.on('state', (/** @type {any} */ s) => states.push(s.name));
    k.agent.send('Plan our day');
    await until(() => k.said.includes('Lunch or dinner?') && k.agent.state.name === 'speaking');
    await off();
    await speaks();
    assert.deepEqual(mics(k), [], 'the microphone never opened');
    assert.ok(!states.includes('listening') && !states.includes('hearing'), `the dock never said Listening: ${states}`);
    assert.equal(k.agent.state.name, 'waiting', 'it waits for the buttons');
    assert.notEqual(k.agent.pendingId, null, 'the question still waits');
    assert.deepEqual(k.transcribed, [], 'what was said into it was heard by no one');
    await new Promise((r) => setTimeout(r, 200)); // past her question's 8 s: still waiting
    assert.notEqual(k.agent.pendingId, null, 'it waits for a tap, with no time limit');
    k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Lunch');
    await k.agent.idle();
    assert.equal((await results(k, 'ask'))[0].data.content, 'The user chose: Lunch');
    assert.deepEqual(mics(k), []);
  });

  test(`voice turning off ${how} while she says a speak line that sleeps in the same reply: the result doesn't say the microphone is open (spec §10.5)`, async (t) => {
    useClock(t);
    const { k, off } = await kitWithVoiceOff([{ toolCalls: [{ name: 'speak', input: { text: 'Which day would you like?' } }, { name: 'sleep', input: {} }] }]);
    k.agent.send('Plan our day');
    await until(() => k.said.includes('Which day would you like?') && k.agent.state.name === 'speaking');
    await off();
    await k.agent.idle();
    assert.deepEqual(mics(k), [], 'the microphone never opened');
    assert.equal((await results(k, 'speak'))[0].data.content, 'The user stopped you after: "Which day…".');
    assert.equal(k.agent.state.name, 'sleeping');
  });
}

test('a tap on Shiori while she says a speak line that sleeps in the same reply: the microphone opens, and the result says so (spec §10.4)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Which day would you like?' } }, { name: 'sleep', input: {} }] }]], { voice: { playMs: 5000, speechIn: ['m-hear'], hears: ['the first one'] } });
  k.agent.send('Plan our day');
  await until(() => k.said.includes('Which day would you like?') && k.agent.state.name === 'speaking');
  assert.equal(k.agent.tap(), 'cut');
  await until(() => mics(k).includes('mic open'));
  await k.agent.idle();
  assert.equal((await results(k, 'speak'))[0].data.content, 'The user stopped you after: "Which day…". The microphone is open: what they say next wakes you.');
});

// Voice turning off inside the awaits that open her microphone (the speech-in list is read, her settings are read first): the one place every
// listening window of a turn opens says no when voice is off, whoever asks. Nothing opens, the dock never says Listening, and each falls back as it
// does when it can't listen: speak says so, her question and the wait tool go to typing and the buttons.
/**
 * A kit whose voice is on, and whose first listening window turns voice off by hand as it opens (the chip's tap lands in the microphone's own awaits).
 * @param {any[]} script @param {boolean} [off] false: voice stays on, the same wrapper only counts
 */
const kitVoiceOffWhileOpening = async (script, off = true) => {
  const k = await agentKit([script], { voice: { speechIn: ['m-hear'], hears: ['the first one'] } });
  const howToListen = k.voice.howToListen.bind(k.voice);
  let asked = 0;
  k.voice.howToListen = async (/** @type {string} */ role) => {
    if (!asked++ && off) await k.voice.choose('off');
    return howToListen(role);
  };
  /** @type {string[]} */
  const states = [];
  k.agent.on('state', (/** @type {any} */ s) => states.push(s.name));
  return { k, states, asked: () => asked };
};

test('voice turning off as the microphone opens for speak: no microphone, no Listening, and speak says it could not listen (spec §10.5)', async (t) => {
  useClock(t);
  const { k, states } = await kitVoiceOffWhileOpening([{ toolCalls: [{ name: 'speak', input: { text: 'Which day would you like?' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]);
  k.agent.send('Plan our day');
  await k.agent.idle();
  assert.ok(k.said.includes('Which day would you like?'), 'said aloud first');
  assert.deepEqual(mics(k), [], 'the microphone never opened');
  assert.ok(!states.includes('listening') && !states.includes('hearing'), `the dock never said Listening: ${states}`);
  assert.equal((await results(k, 'speak'))[0].data.content, "Said aloud. annai couldn't listen: voice mode is off. The user may type.");
  assert.equal(k.agent.state.name, 'sleeping');
});

test('voice turning off as the microphone opens for her question: no microphone, no Listening, and the buttons wait with no time limit (spec §10.5)', async (t) => {
  useClock(t);
  const { k, states } = await kitVoiceOffWhileOpening([{ toolCalls: [{ name: 'ask', input: { question: 'Lunch or dinner?', options: ['Lunch', 'Dinner'] } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]);
  k.agent.send('Plan our day');
  await until(() => k.said.includes('Lunch or dinner?') && k.agent.state.name === 'waiting');
  await new Promise((r) => setTimeout(r, 200)); // far past her question's 8 s: still waiting
  assert.deepEqual(mics(k), [], 'the microphone never opened');
  assert.ok(!states.includes('listening') && !states.includes('hearing'), `the dock never said Listening: ${states}`);
  assert.notEqual(k.agent.pendingId, null, 'it waits for a tap, with no time limit');
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Lunch');
  await k.agent.idle();
  assert.equal((await results(k, 'ask'))[0].data.content, 'The user chose: Lunch');
  assert.deepEqual(mics(k), []);
});

test('voice turning off as the microphone opens for the wait tool: no microphone, no Listening, and it waits for typing as with voice off (spec §10.5)', async (t) => {
  useClock(t);
  const { k, states } = await kitVoiceOffWhileOpening([{ toolCalls: [{ name: 'wait', input: { seconds: 10 } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]);
  k.agent.send('Give me a minute');
  await until(() => ['waiting', 'listening'].includes(k.agent.state.name));
  assert.deepEqual(mics(k), [], 'the microphone never opened');
  assert.ok(!states.includes('listening') && !states.includes('hearing'), `the dock never said Listening: ${states}`);
  assert.equal(k.agent.state.name, 'waiting');
  k.agent.send('Ready');
  await k.agent.idle();
  assert.equal((await results(k, 'wait'))[0].data.content, 'The user wrote: Ready');
});

test('voice on throughout: the same openings listen as they always did, and a tap on Shiori opens the microphone (spec §10.4)', async (t) => {
  useClock(t);
  const speak = await kitVoiceOffWhileOpening([{ toolCalls: [{ name: 'speak', input: { text: 'Which day would you like?' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }], false);
  speak.k.agent.send('Plan our day');
  await until(() => speak.k.agent.state.name === 'listening');
  await hear(speak.k, 'first-one');
  await speak.k.agent.idle();
  assert.equal(speak.asked(), 1);
  assert.ok(speak.states.includes('listening'));
  assert.equal(mics(speak.k)[0], 'mic open');
  assert.equal((await results(speak.k, 'speak'))[0].data.content, 'Said aloud. The user said:');
  // A tap, with voice on by its setting and with voice off, which a tap holds on for its exchange.
  for (const mode of ['on', 'off']) {
    const tapped = await agentKit([{ rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] }], { halves: true, voice: { mode: /** @type {'on' | 'off'} */ (mode), speechIn: ['m-hear'], hears: ['the first one'] } });
    assert.equal(tapped.agent.tap(), 'listening');
    await until(() => tapped.agent.state.name === 'listening');
    assert.equal(tapped.voice.on, true);
    assert.deepEqual(mics(tapped), ['mic open'], `a tap with voice ${mode} opens the microphone`);
    tapped.agent.tap();
    await until(() => !tapped.voice.on || mode === 'on');
  }
});

// Voice turning off inside the open itself, past the check above (the browser still starting the microphone): the microphone it opened closes
// again, and each listening falls back as above.
/** @param {any[]} script */
const kitVoiceOffInsideOpen = async (script) => {
  const k = await agentKit([script], { voice: { speechIn: ['m-hear'], hears: ['the first one'] } });
  const open = k.voice.open.bind(k.voice);
  let opened = 0;
  k.voice.open = async (/** @type {any} */ o) => {
    if (!opened++) await k.voice.choose('off');
    return open(o);
  };
  /** @type {string[]} */
  const states = [];
  k.agent.on('state', (/** @type {any} */ s) => states.push(s.name));
  return { k, states };
};

test('voice turning off inside the microphone\'s own opening for speak: it closes again, no Listening, and speak says it could not listen (spec §10.5)', async (t) => {
  useClock(t);
  const { k, states } = await kitVoiceOffInsideOpen([{ toolCalls: [{ name: 'speak', input: { text: 'Which day would you like?' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]);
  k.agent.send('Plan our day');
  await k.agent.idle();
  assert.ok(!states.includes('listening') && !states.includes('hearing'), `the dock never said Listening: ${states}`);
  assert.notEqual(mics(k).at(-1), 'mic open', `none left open: ${mics(k)}`);
  assert.equal((await results(k, 'speak'))[0].data.content, "Said aloud. annai couldn't listen: voice mode is off. The user may type.");
  assert.equal(k.agent.state.name, 'sleeping');
});

test('voice turning off inside the microphone\'s own opening for her question: no Listening, and the buttons wait with no time limit (spec §10.5)', async (t) => {
  useClock(t);
  const { k, states } = await kitVoiceOffInsideOpen([{ toolCalls: [{ name: 'ask', input: { question: 'Lunch or dinner?', options: ['Lunch', 'Dinner'] } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]);
  k.agent.send('Plan our day');
  await until(() => k.said.includes('Lunch or dinner?') && !k.voice.on);
  await new Promise((r) => setTimeout(r, 200)); // far past her question's 8 s: still waiting
  assert.ok(!states.includes('listening') && !states.includes('hearing'), `the dock never said Listening: ${states}`);
  assert.notEqual(mics(k).at(-1), 'mic open', `none left open: ${mics(k)}`);
  assert.notEqual(k.agent.pendingId, null, 'it waits for a tap, with no time limit');
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Lunch');
  await k.agent.idle();
  assert.equal((await results(k, 'ask'))[0].data.content, 'The user chose: Lunch');
});

test('voice turning off inside the microphone\'s own opening for the wait tool: no Listening, and it waits for typing (spec §10.5)', async (t) => {
  useClock(t);
  const { k, states } = await kitVoiceOffInsideOpen([{ toolCalls: [{ name: 'wait', input: { seconds: 10 } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]);
  k.agent.send('Give me a minute');
  await until(() => !k.voice.on);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!states.includes('listening') && !states.includes('hearing'), `the dock never said Listening: ${states}`);
  assert.deepEqual([k.agent.state.name, k.agent.state.label], ['waiting', 'Your turn']);
  assert.notEqual(mics(k).at(-1), 'mic open', `none left open: ${mics(k)}`);
  k.agent.send('Ready');
  await k.agent.idle();
  assert.equal((await results(k, 'wait'))[0].data.content, 'The user wrote: Ready');
});

// A Stop, or another conversation opening, while the microphone is still opening for a listening: the tool's run goes on behind the ended turn, and
// when the microphone opens it must leave no wait behind (a wait with no turn took the user's next line as its answer, and nothing replied).
for (const how of ['Stop', 'switch']) {
  // quiet: nothing is left listening (a line she says ends her turn with the window she listens on after it, which is a different matter: a Stop's, here)
  for (const [what, script, ready, quiet] of /** @type {[string, any[], (k: any) => boolean, boolean][]} */ ([
    ['the wait tool', [{ toolCalls: [{ name: 'wait', input: { seconds: 600 } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }], () => true, true],
    ['her question aloud', [{ toolCalls: [{ name: 'ask', input: { question: 'Lunch or dinner?', options: ['Lunch', 'Dinner'] } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }], (k) => k.said.includes('Lunch or dinner?'), true],
    ['a line she says (the listening after it)', [{ toolCalls: [{ name: 'speak', input: { text: 'Which day would you like?' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }], (k) => k.said.includes('Which day would you like?'), false],
  ])) {
    test(`a ${how} while the microphone opens for ${what}: no wait is left behind, and the user's next line is a turn of its own, answered`, async (t) => {
      useClock(t);
      const k = await agentKit([script], { voice: { speechIn: ['m-hear'], hears: ['the first one'] } });
      const open = k.voice.open.bind(k.voice);
      /** @type {() => void} */
      let release = () => {};
      const held = new Promise((r) => { release = () => r(undefined); });
      let opening = false;
      k.voice.open = async (/** @type {any} */ o) => {
        opening = true;
        await held;
        return open(o);
      };
      k.agent.send('Plan our day');
      await until(() => opening && ready(k));
      /** @type {string | null} */
      let other = null;
      if (how === 'Stop') k.agent.interrupt();
      else {
        other = await createTrip(k.ws, { title: 'Carmel' });
        await k.agent.open(other);
      }
      release();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(k.agent.pendingId, null, 'no wait is left');
      if (quiet) {
        assert.equal(k.agent.state.name, 'sleeping');
        assert.notEqual(mics(k).at(-1), 'mic open', `none left open: ${mics(k)}`);
      }
      const requests = k.requests.length;
      k.agent.send('Something else');
      await k.agent.idle();
      assert.ok(k.requests.length > requests, 'the line woke her: it was no one\'s answer');
      const lines = (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(other ?? k.trip, { types: ['msg.user'] }))).map((/** @type {any} */ e) => [e.data.text ?? '', Boolean(e.data.answer)]);
      assert.deepEqual(lines.at(-1), ['Something else', false], 'written as a line of theirs, not as the stopped call\'s answer');
    });
  }
}

test('voice turning off as the microphone opens for the window after she speaks: no microphone, no Listening, and the dock says she sleeps (spec §10.5)', async (t) => {
  useClock(t);
  const { k, states } = await kitVoiceOffWhileOpening([{ toolCalls: [{ name: 'speak', input: { text: 'Let me check.' } }, { name: 'note_it', input: {} }] }, { text: 'Done.' }]);
  k.registry.add('test', 'tool', { name: 'note_it', description: 'Notes it.', input: { type: 'object' }, run: async () => 'noted' });
  k.agent.send('Is it open?');
  await k.agent.idle();
  assert.ok(k.said.includes('Let me check.'), 'said aloud first');
  assert.deepEqual(mics(k), [], 'the microphone never opened');
  assert.ok(!states.includes('listening') && !states.includes('hearing'), `the dock never said Listening: ${states}`);
  assert.equal(k.agent.state.name, 'sleeping');
});
