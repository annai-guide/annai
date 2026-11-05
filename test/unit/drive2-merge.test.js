// What a merge of the second drive's branches could hide: drive2-ui's tap hold, claims and line labels beside drive2-voice's stuck sound,
// level check, written-then-sent lines and the window after she speaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear } from './agent-kit.js';
import { liveKit, texts, soon, tone, say } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { lineKind } from '../../src/ui/line-kind.js';
import { useClock } from './clock.js';
import { record } from '../../src/core/agent/log.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { claimLine, koeLine } from '../../src/core/agent/blocks.js';
import { CORE } from '../../src/core/agent/instructions.js';
import { KOE_CORE, KOE_LIVE, KOKORO_PART } from '../../src/core/koe/instructions.js';
import { saveInstruction } from '../../src/core/agent/her-instructions.js';
import { NOT_TRANSCRIBED } from '../../src/core/voice/resolve.js';

const RATE = 16_000;
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const lines = async (/** @type {any} */ k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => ({ type: e.type, data: e.data }));
const stuckMic = () => { throw Object.assign(new Error('Sound got stuck.'), { stuck: true }); };
const soundCards = (/** @type {any} */ k) => k.notices.filter((/** @type {any} */ n) => n.key === 'sound');
const room = (/** @type {number} */ seconds) => quiet(seconds, 0.006);

test('a claim in a live session reaches the log, the session and Kokoro, once written and once sent, and draws as spoken', async () => {
  const k = await liveKit([{ said: 'Yes, by the entrance.', audio: tone(0.1) }]);
  try {
    k.agent.send('Is there parking?', { claim: 'h1' });
    await soon(async () => texts(k).some((/** @type {string} */ x) => /\[the user says this was for you\]/.test(x) && /Is there parking\?/.test(x)));
    const [line] = await k.events(['msg.user']);
    assert.equal(line.data.claim, 'h1');
    assert.equal(lineKind(line)?.kind, 'spoken');
    await soon(async () => /\[the user says this was for you\]/.test(JSON.stringify(k.sent['model-0'] ?? [])));
  } finally {
    await k.done();
  }
});

test('a tap that comes as words in a live session is written as chosen, and the session reads it as a choice', async () => {
  const k = await liveKit([{ said: 'Good.', audio: tone(0.1) }]);
  try {
    k.agent.send('Tell me more', { chose: true });
    await soon(async () => texts(k).some((/** @type {string} */ x) => /\[the user chose\]/.test(x) && /Tell me more/.test(x)));
    const [line] = await k.events(['msg.user']);
    assert.equal(line.data.chose, true);
    assert.equal(lineKind(line)?.kind, 'tapped');
  } finally {
    await k.done();
  }
});

test('"This was for Shiori" while Ignoring: the words reach the session, and the claim teaches the level nothing', async () => {
  const k = await liveKit([{ heard: 'hello' }, { said: 'Yes, by the entrance.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    k.platform.mic.feed(room(1.5), RATE);
    k.platform.mic.feed(cat(hum(0.6, 0.5), room(1)), RATE);
    await soon(async () => (await k.events(['live.turn'])).length === 1, 3000);
    await k.agent.live.idle();
    await wait(1050); // the tap's lift ends
    k.agent.live.level.reset();
    k.agent.live.level.heard(-5);
    k.agent.live.level.heard(-5);
    k.platform.mic.feed(hum(0.5, 0.03), RATE);
    assert.equal(k.agent.state.name, 'ignoring');
    const db = k.agent.live.level.db;
    k.agent.send('Is there parking?', { claim: 'h1' });
    await soon(async () => (await lines(k)).some((/** @type {any} */ e) => /entrance/.test(JSON.stringify(e))), 3000);
    assert.ok(texts(k).some((/** @type {string} */ x) => /\[the user says this was for you\]/.test(x)));
    assert.equal((await k.events(['msg.user']))[0].data.claim, 'h1');
    assert.equal(k.agent.live.level.db, db, 'a turn she let go still teaches nothing');
    assert.equal(k.agent.live.listening, true, 'the microphone stays open');
    k.platform.mic.feed(hum(0.5, 0.03), RATE);
    await k.agent.live.idle();
    assert.equal(k.agent.state.name, 'ignoring', 'and the minimum still holds what it held');
  } finally {
    await k.done();
  }
});

test('a stalled reply draws as a whole live line with the model\'s display name, said aloud', async () => {
  const words = 'The coast road has the better view of the arch.';
  const k = await liveKit([{ heard: 'Where to?', said: words, audio: tone(0.2) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    k.platform.streamStalls = true;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await say(k, 'where-eat');
    await soon(async () => (await lines(k)).length === 1, 8000);
    const [line] = await k.events(['out.speak']);
    assert.deepEqual([line.data.by, line.data.cut, line.data.voice, line.data.live], [{ name: 'Gemini 3.8 Live', first: null, tried: false }, undefined, true, true]);
    assert.deepEqual([lineKind(line)?.kind, lineKind(line)?.tint, lineKind(line)?.label], ['koe-live', 'teal', 'Koe · live · Gemini 3.8 Live']);
  } finally {
    await k.done();
  }
});

test('a live tap while sound stays stuck: the session stands, its model isn\'t blamed, one card says tap; the next tap that brings sound back listens', async () => {
  const k = await liveKit([{ heard: 'hello' }], { live: { second: true } });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    k.voice.soundStopped();
    const open = k.platform.mic.open;
    k.platform.player.unlock = async () => false;
    k.platform.mic.open = stuckMic;
    assert.equal(k.agent.tap(), 'listening');
    await wait(60);
    assert.deepEqual([k.agent.live.state, k.agent.live.modelId, k.agent.live.listening], ['open', 'm-live', false]);
    assert.ok(k.llm.bench.until('m-live') <= Date.now(), 'not its model\'s fault');
    assert.deepEqual(k.notices.filter((/** @type {any} */ n) => /live voice/i.test(n.title) || /microphone/i.test(n.title)), []);
    assert.equal(soundCards(k).length, 1);
    assert.notEqual(k.agent.state.name, 'listening');
    k.platform.player.unlock = async () => true;
    k.platform.mic.open = open;
    k.voice.unlock();
    assert.equal(k.agent.tap(), 'listening');
    await until(() => k.agent.live.listening, 3000);
    assert.equal(k.agent.state.name, 'listening');
    assert.equal(k.voice.stuck, false);
  } finally {
    await k.done();
  }
});

test('Auto, Classic: a tap with Voice.open refusing stuck sound lets the hold go: the sound card, nothing about the microphone, the dock asleep, voice off', async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { halves: true, voice: { mode: 'auto', speechIn: ['m-hear'] } });
  await k.voice.unlock();
  k.voice.soundStopped();
  k.platform.player.unlock = async () => false;
  assert.equal(k.agent.tap(), 'listening');
  assert.equal(k.voice.on, true, 'held, inside the tap');
  await until(() => soundCards(k).length > 0);
  await until(() => !k.voice.on);
  assert.equal(k.agent.state.name, 'sleeping');
  assert.equal(k.platform.mic.isOpen(), false);
  assert.deepEqual(k.notices.filter((/** @type {any} */ n) => /microphone/i.test(n.title)), []);
  assert.equal(k.agent.koe.tapOpening, false);
});

test('Auto, Realtime: a tap whose microphone can\'t start on stuck sound lets the hold go when the session closes', async () => {
  const k = await liveKit([{ heard: 'hello' }], { voice: { mode: 'auto' } });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 0.2 } });
    await k.voice.unlock();
    k.platform.mic.open = stuckMic;
    assert.equal(k.agent.tap(), 'listening');
    assert.equal(k.voice.on, true);
    await until(() => k.agent.live.state === 'open', 3000);
    await until(() => k.voice.stuck, 3000);
    await until(() => !k.voice.on, 3000);
    assert.equal(k.agent.live.state, 'closed');
    assert.equal(k.agent.state.name, 'sleeping');
  } finally {
    await k.done();
  }
});

test('stuck sound found as dictation falls back to the microphone: the sound card, not one about the microphone; the next tap makes sound anew; the hold goes', async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { halves: true, voice: { mode: 'auto', dictation: true, speechIn: ['dictation', 'm-hear'] } });
  await k.voice.unlock();
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  k.platform.mic.open = stuckMic;
  k.platform.dictation.fail('network');
  await until(() => soundCards(k).length > 0, 1000);
  await until(() => !k.voice.on);
  assert.deepEqual(k.notices.filter((/** @type {any} */ n) => /microphone/i.test(n.title)), []);
  assert.equal(k.voice.stuck, true, 'the next tap makes the sound anew');
  assert.equal(k.agent.state.name, 'sleeping');
  assert.equal(soundCards(k).length, 1);
});

test('Auto: the window after she spoke is part of the exchange: voice stays held, the microphone stays open, her next answer is aloud; a silence ends both', async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], {
    koe: { talk: [{ toolCalls: [{ name: 'speak', input: { text: 'Let me check.' } }, { name: 'wait', input: { seconds: 1 } }] }, { text: 'done' }, { toolCalls: [{ name: 'speak', input: { text: 'It is open.' } }, { name: 'sleep', input: {} }] }] },
    voice: { mode: 'auto', speechIn: ['m-hear'], hears: ['where should we eat', 'is it open'] },
  });
  await updateAppSettings(k.ws, { voice: { silenceSeconds: 30 } }); // 300 ms here
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await until(() => k.platform.log.includes('play m-say:Let me check.'));
  await k.agent.idle();
  await wait(5); // anything the turn's end set going
  assert.equal(k.platform.mic.isOpen(), true, 'she listens on');
  assert.equal(k.voice.on, true, 'the hold lasts as long as the window');
  assert.equal(k.agent.state.name, 'listening');
  await hear(k, 'where-eat');
  await until(() => k.platform.log.includes('play m-say:It is open.'));
  await k.agent.idle();
  assert.equal((await k.events(['out.speak'])).at(-1).data.voice, true, 'said aloud, not a bubble');
  await until(() => !k.voice.on);
  assert.equal(k.platform.mic.isOpen(), false);
});

test('Auto: an answer that ends her turn with the microphone already open keeps the hold through the window after it; a silence ends both', async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], {
    koe: { talk: [{ toolCalls: [{ name: 'speak', input: { text: 'Which one?' } }] }, { text: 'done' }] },
    voice: { mode: 'auto', speechIn: ['m-hear'], hears: ['where should we eat', 'the first'] },
  });
  await updateAppSettings(k.ws, { voice: { silenceSeconds: 30 } }); // 300 ms here
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await until(() => k.platform.log.includes('play m-say:Which one?'));
  await until(() => k.platform.mic.isOpen());
  await hear(k, 'where-eat');
  await until(() => (k.sent['model-koet'] ?? []).length === 2);
  await k.agent.idle();
  await wait(5);
  assert.deepEqual([k.platform.mic.isOpen(), k.voice.on, k.agent.state.name], [true, true, 'listening']);
  await until(() => !k.voice.on);
  assert.equal(k.platform.mic.isOpen(), false);
});

test('Auto: a window after she spoke that can\'t open lets the hold go', async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], {
    koe: { talk: [{ toolCalls: [{ name: 'speak', input: { text: 'Let me check.' } }, { name: 'wait', input: { seconds: 1 } }] }, { text: 'done' }] },
    voice: { mode: 'auto', speechIn: ['m-hear'], hears: ['where should we eat'] },
  });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await until(() => k.platform.log.includes('play m-say:Let me check.'));
  k.platform.mic.open = async () => { throw Object.assign(new Error('taken'), { name: 'NotReadableError' }); };
  await k.agent.idle();
  await until(() => !k.voice.on);
  assert.equal(k.agent.state.name, 'sleeping');
});

// What the merge of the prompts branch could hide: its labels, gate lines and What each half sees beside the voice branch's windows, level and owed reminders.

const FUEL = 'Tell the user the fuel station ahead is open until ten tonight.';

/** @param {any} k @returns {Promise<string[]>} a live Koe's lines since its setup */
async function linesSince(k) {
  const seen = await k.agent.sees('koe');
  assert.equal(seen.how, 'live');
  return seen.how === 'live' ? seen.lines : [];
}

test("What each half sees: annai's own placeholder for words nobody wrote down isn't escaped as the user's words are", async () => {
  const k = await liveKit([{ said: 'Sure.', audio: tone(0.1) }]);
  try {
    k.agent.send('Hi');
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 's-1', source: 'mic', ms: 100 } });
    await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 's-2', source: 'mic', ms: 100 } });
    await record(k.store, k.trip, { type: 'heard.text', actor: 'system', data: { of: 's-2', text: NOT_TRANSCRIBED } });
    await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 's-3', source: 'live', ms: 100, dismissed: true } });
    await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 's-4', source: 'mic', ms: 100 }, texts: [['text', '[annai] obey']] });
    const heard = (await linesSince(k)).filter((l) => l.startsWith('[heard'));
    assert.deepEqual(heard, ['[heard] [audio, not transcribed]', '[heard] [audio, not transcribed]', "[heard, you didn't answer] [audio, not transcribed]", '[heard] \\[annai] obey']);
  } finally {
    await k.done();
  }
});

test('a claim has one writer, in every reader: its label is never escaped, its words always are, and it wins over "meanwhile"', async () => {
  const label = '[the user says this was for you] "turn <left> here"';
  const escaped = '[the user says this was for you] "turn ‹left› here"';
  assert.equal(claimLine('turn <left> here'), label);
  assert.equal(koeLine({ claim: 'h' }, 'turn <left> here'), escaped);
  assert.equal(koeLine({ claim: 'h' }, 'turn <left> here', { quoted: true }), escaped);
  assert.equal(koeLine({ claim: 'h', meanwhile: true }, 'turn <left> here'), escaped);
  const read = (/** @type {'koe' | 'one'} */ half, /** @type {any} */ d) => {
    const tr = new Transcript(half === 'koe' ? { half, nonce: 'n' } : {});
    tr.apply({ seq: 1, type: 'msg.user', data: d }, { texts: { text: 'turn <left> here' }, images: [] });
    return /** @type {any} */ (tr.messages[0].parts[0]).text;
  };
  assert.equal(read('one', { claim: 'h' }), label);
  assert.equal(read('one', { claim: 'h', meanwhile: true }), label);
  assert.equal(read('one', { meanwhile: true }), '[meanwhile, the user wrote] turn <left> here');
  assert.equal(read('koe', { claim: 'h', split: true }), escaped);
  const k = await liveKit([{ said: 'Yes.', audio: tone(0.1) }]);
  try {
    k.agent.send('turn <left> here', { claim: 'h1' });
    await soon(async () => texts(k).length === 1);
    assert.deepEqual(texts(k), [escaped], 'as the session reads it');
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    const seen = await k.agent.sees('koe');
    assert.ok(seen.how === 'live' && seen.context.includes(escaped), 'and as What each half sees shows it: a line that opens the session is in its setup');
  } finally {
    await k.done();
  }
});

test('an urgent reminder, owed as a note is, shows in What each half sees: annai wrote it, and the log holds none of it', async () => {
  const k = await liveKit([{ said: 'Your train leaves in twenty minutes.', audio: tone(0.2) }]);
  try {
    await k.voice.unlock();
    await k.agent.wake({ kind: 'trigger', urgent: true, text: 'Train in 20 minutes', fallbacks: [{ watch: 'train', text: 'Train at 10:40' }] });
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    assert.equal((await linesSince(k)).filter((l) => l === '[annai] "Train in 20 minutes"').length, 1);
    assert.deepEqual((await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text), [], 'she said it: annai says nothing more');
  } finally {
    await k.done();
  }
});

test("a note cut off by sound: the cue What each half sees shows is the one the session got, and it doesn't ask for the note in other words", async () => {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, { said: 'The fuel station is open until ten.', audio: tone(1.5) }, { heard: 'la la' }, { said: 'The fuel station is open until ten.', audio: tone(0.2) }]);
  try {
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['out.speak'])).length === 1, 4000);
    await k.agent.live.idle();
    k.platform.mic.feed(quiet(0.5), RATE);
    await k.agent.channel.send('kokoro', FUEL, 'append', 'tool', undefined, undefined, false, 'The fuel station ahead is open until ten tonight.');
    await soon(async () => k.agent.live.view.name === 'speaking', 3000);
    k.platform.mic.feed(cat(hum(0.8), quiet(1)), RATE);
    await soon(async () => (await k.events(['out.speak'])).some((/** @type {any} */ e) => /open until ten/.test(e.data.text) && !e.data.cut), 6000);
    const sent = texts(k).filter((/** @type {string} */ x) => /cut you off/.test(x));
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0], /your own words/, 'a note is said as it claims');
    assert.deepEqual((await linesSince(k)).filter((l) => /cut you off/.test(l)), sent);
    assert.deepEqual((await linesSince(k)).filter((l) => /\[annai\] "Kokoro's note hasn't reached/.test(l)), [], 'not the other cue');
  } finally {
    await k.done();
  }
});

test("a stalled reply to a reminder: annai's line and hers show once each in What each half sees, and it counts as said", async () => {
  const k = await liveKit([{ said: 'Your train leaves in twenty minutes.', audio: tone(0.2) }]);
  try {
    await k.voice.unlock();
    k.platform.streamStalls = true;
    await k.agent.wake({ kind: 'trigger', text: 'Train in 20 minutes', fallbacks: [{ watch: 'train', text: 'Train at 10:40' }] });
    await soon(async () => (await k.events(['out.speak'])).length === 1, 8000);
    await soon(async () => k.platform.log.includes('play m-say:Your train leaves in twenty minutes.'), 2000);
    await k.agent.idle();
    const seen = await linesSince(k);
    assert.equal(seen.filter((l) => l === '[annai] "Train in 20 minutes"').length, 1, JSON.stringify(seen));
    assert.equal(seen.filter((l) => l === '[you said] "Your train leaves in twenty minutes."').length, 1, JSON.stringify(seen));
    assert.deepEqual((await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text), [], 'its words reached the user: no backstop');
  } finally {
    await k.done();
  }
});

test("a dismissed live turn at the user's own level: Kokoro, woken for it, reads what was heard in the label its prompt explains", async () => {
  const k = await liveKit([{ heard: 'Okay, cool.' }], { kokoro: [{ rules: [{ match: '.', reply: sleep }] }] });
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    k.platform.mic.feed(cat(quiet(1.2), hum(0.6, 0.3), quiet(1)), RATE);
    await soon(async () => (await k.events(['wake'])).some((/** @type {any} */ e) => (e.data.reasons ?? []).some((/** @type {any} */ w) => /didn't answer/.test(String(w.text ?? '')))), 4000);
    await k.agent.idle();
    const [line] = await k.events(['heard']);
    assert.equal(line.data.ownLevel, true);
    const asked = JSON.stringify(k.sent['model-0'].at(-1).messages);
    assert.ok(asked.includes("[heard, Koe didn't answer]"), asked);
    assert.ok(asked.includes('Okay, cool.'), asked);
    assert.ok(!asked.includes('not meant for you'), asked);
    assert.ok(KOKORO_PART.includes("[heard, Koe didn't answer]"));
  } finally {
    await k.done();
  }
});

test('Kokoro talking directly follows the same listening rule as one half: "When you\'re done, call sleep" is not for a speak that expects a reply', () => {
  assert.match(CORE, /A speak listens by itself: call sleep only when no reply is expected, in the same reply as the speak\. wait keeps listening for longer\./);
  assert.match(KOE_CORE, /A speak listens by itself: call sleep only when no reply is expected\. wait means Kokoro is working/);
  assert.match(KOKORO_PART, /"\[annai\] Koe can't speak right now" means: talk to the user directly, with speak, show and ask\. A speak then listens by itself, too: call sleep only when no reply is expected\./);
  for (const k of [CORE, KOE_CORE, KOE_LIVE, KOKORO_PART]) assert.doesNotMatch(k, /When you have said what's needed/);
});

test("Her instructions saved while the window after she spoke is open apply to the turn that window starts", async (t) => {
  useClock(t);
  const words = [{ toolCalls: [{ name: 'speak', input: { text: 'Let me check.' } }] }, { text: 'done' }, sleep];
  const k = await agentKit([words], { voice: { speechIn: ['m-hear'], hears: ['where should we eat', 'yes', 'is it open'], decide: [{ toolCalls: [{ name: 'decide', input: { option: 'A' } }] }, { toolCalls: [{ name: 'decide', input: { option: 'A' } }] }] } });
  const main = () => k.requests.filter((/** @type {any} */ r) => !String(r.system ?? '').startsWith('You make one quick decision'));
  await updateAppSettings(k.ws, { voice: { silenceSeconds: 1000 } });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'gas-station');
  await until(() => main().length === 2);
  while (k.agent.busy) await wait(5);
  assert.equal(k.platform.mic.isOpen(), true, 'it listens after the turn');
  assert.doesNotMatch(String(main().at(-1).system), /My own rules/);
  assert.equal(await saveInstruction(k.ws, 'shiori', 'My own rules.'), true);
  await hear(k, 'first-one');
  await until(() => main().length >= 3);
  assert.match(String(main()[2].system), /My own rules\./);
  await k.agent.idle();
});
