// K5: Koe live (the Koe and Kokoro design, "Realtime sessions"; plan K5), against the stand-in realtime server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './agent-kit.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { liveKit, lives, blocks, got, texts, soon, tone, say, sleep } from './koe-live-kit.js';

// Task 1: choosing the pathway.
test("a realtime model first in Koe for talking: Koe is live; resting, the text model after it talks", async () => {
  const k = await liveKit([], { koe: { talk: { rules: [{ match: '.', reply: sleep }] } } });
  try {
    assert.equal(k.agent.koeState, 'live');
    k.llm.bench.bench('m-live', 60_000);
    assert.equal(await k.agent.split(), true);
    assert.equal(k.agent.koeState, 'text');
  } finally {
    await k.done();
  }
});

// Task 2: a session's life.
test("voice on with a realtime Koe: a tap opens a session with Koe's live instructions, its view of the trip and its tools, and the microphone", async () => {
  const k = await liveKit([]);
  try {
    assert.equal(k.agent.tap(), 'listening');
    await until(() => k.agent.live.listening);
    const { setup } = got(k, 'setup')[0];
    const system = setup.systemInstruction.parts[0].text;
    assert.match(system, /^You are Koe, the voice of Shiori, a travel guide in the annai app, talking with the user in a live voice conversation/);
    assert.match(system, /<now>[\s\S]*voice: on: you speak aloud in this live session[\s\S]*<\/now>/);
    assert.match(system, /<today>\ntrip: Big Sur/);
    assert.ok(system.includes(`Kokoro's notes carry id="${k.agent.nonce}".`));
    const names = setup.tools[0].functionDeclarations.map((/** @type {any} */ f) => f.name);
    for (const n of ['show', 'ask', 'recall', 'list', 'read', 'write', 'tell_kokoro']) assert.ok(names.includes(n), n);
    for (const n of ['speak', 'wait', 'sleep']) assert.ok(!names.includes(n), `no ${n}: it speaks natively, and its turns end by themselves`);
    assert.equal(k.platform.log.filter((/** @type {string} */ l) => l === 'mic open').length, 1);
    assert.equal(k.platform.sessions.at(-1), 'play-and-record');
    assert.deepEqual(await blocks(k), ['live-open']);
    assert.equal(k.agent.state.name, 'listening');
  } finally {
    await k.done();
  }
});

test('a quiet spell closes it: the microphone closes, full-quality playback comes back, and Kokoro is told', async () => {
  const k = await liveKit([]);
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening);
    await until(() => k.agent.live.state === 'closed', 3000); // 30 seconds, at 10 ms a second
    assert.equal(k.platform.log.at(-1), 'mic close');
    assert.equal(k.platform.sessions.at(-1), 'playback');
    await soon(async () => (await lives(k, 'closed')).length === 1);
    assert.deepEqual(await blocks(k), ['live-open', 'live-closed']);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'quiet');
    assert.equal(k.agent.state.name, 'sleeping');
  } finally {
    await k.done();
  }
});

test('voice off, a conversation switch, the page going and Erase each close it at once, its microphone with it', async () => {
  const k = await liveKit([]);
  try {
    /** @param {() => unknown} close @param {string} why */
    const closes = async (close, why) => {
      k.agent.tap();
      await until(() => k.agent.live.listening);
      await close();
      await until(() => k.agent.live.state === 'closed');
      assert.equal(k.platform.log.at(-1), 'mic close', why);
      assert.equal(k.platform.sessions.at(-1), 'playback', why);
      await soon(async () => (await lives(k, 'closed')).at(-1)?.data.why === why);
    };
    await closes(() => k.agent.hush('away'), 'away');
    await closes(() => k.agent.hush('erase'), 'erase');
    await closes(async () => {
      await updateAppSettings(k.ws, { voice: { mode: 'off' } });
      await k.voice.refresh();
      await k.agent.idle();
    }, 'voice off');
    await updateAppSettings(k.ws, { voice: { mode: 'on' } });
    await k.voice.refresh();
    await k.agent.idle();
    await closes(() => k.agent.open(null), 'switch');
  } finally {
    await k.done();
  }
});

test('a trigger opens a session, says it, then listens; its reminder is never said by annai too', async () => {
  const k = await liveKit([{ said: 'The sun sets in half an hour.', audio: tone() }]);
  try {
    await k.voice.unlock(); // an earlier tap
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes', fallbacks: [{ watch: 'sun', text: 'Sunset at 18:40' }] });
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    assert.deepEqual(texts(k), ['[annai] "Sunset in 30 minutes"']);
    const [said] = await k.events(['out.speak']);
    assert.deepEqual([said.data.text, said.data.voice, said.data.live, said.data.half], ['The sun sets in half an hour.', true, true, 'koe']);
    assert.equal(k.platform.streams.length, 1);
    assert.ok(k.platform.streams[0].ended && !k.platform.streams[0].stopped);
    assert.ok(k.agent.live.listening, 'then it listens');
    assert.deepEqual(await k.events(['reminder']), []);
    assert.ok(!k.said.includes('Sunset at 18:40'));
    // Kokoro got the trigger too, without the reminder, and its now block says Koe is live.
    const [kokoro] = k.sent['model-0'];
    assert.match(kokoro.tail, /koe: talking with the user live \(use tell_koe\)/);
  } finally {
    await k.done();
  }
});

test('GoAway: a new connection with the handle, and the conversation carries on there', async () => {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.2), handle: 'h-2', goAway: 10 }, { said: 'Yes, I remember.', audio: tone(0.2) }]);
  try {
    k.agent.send('Hi');
    await until(() => k.server.connections().length === 2);
    await soon(async () => (await lives(k, 'resumed')).length === 1);
    k.agent.send('Do you remember?');
    await soon(async () => (await k.events(['out.speak'])).length === 2);
    const setups = got(k, 'setup');
    assert.equal(setups[1].setup.sessionResumption.handle, 'h-2');
    const order = k.server.received().map((/** @type {any} */ m) => (m.setup ? 'setup' : m.clientContent ? m.clientContent.turns[0].parts[0].text : Object.keys(m)[0]));
    assert.deepEqual(order, ['setup', 'Hi', 'setup', 'Do you remember?']);
    // The new connection is ready before the old one closes.
    assert.deepEqual((await lives(k)).map((/** @type {any} */ e) => e.data.state), ['open', 'ready', 'goaway', 'open', 'resumed', 'closed']);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'goaway');
    assert.deepEqual(await blocks(k), ['live-open'], 'one session as Kokoro sees it');
  } finally {
    await k.done();
  }
});

// Security review: the page's lifecycle. The app hushes Shiori when the page goes out of view or away, and before Erase.
/** The page out of view, or back, as the browser says it. @param {boolean} on */
function hidden(on) {
  if (on) /** @type {any} */ (globalThis).document = { visibilityState: 'hidden' };
  else delete (/** @type {any} */ (globalThis).document);
}

test('the page out of view: the session closes and its microphone stops; a page out of view never streams a sound (security review)', async () => {
  const k = await liveKit([]);
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening);
    hidden(true);
    k.agent.hush('away'); // the app, on visibilitychange to hidden and on pagehide
    assert.equal(k.agent.live.state, 'closed');
    assert.equal(k.platform.log.at(-1), 'mic close');
    assert.equal(k.platform.sessions.at(-1), 'playback');
    // Hidden without a word from the app: the first sound it would send closes the session instead.
    hidden(false);
    k.agent.tap();
    await until(() => k.agent.live.listening);
    const before = got(k, 'realtimeInput').length;
    hidden(true);
    await say(k, 'where-eat');
    assert.equal(k.agent.live.state, 'closed');
    assert.equal(got(k, 'realtimeInput').length, before, 'nothing was sent');
    assert.equal(k.platform.log.at(-1), 'mic close');
    await soon(async () => (await lives(k, 'closed')).length === 2);
    assert.deepEqual((await lives(k, 'closed')).map((/** @type {any} */ e) => e.data.why), ['away', 'away']);
  } finally {
    hidden(false);
    await k.done();
  }
});

test('a trigger or a note while the page is out of view opens nothing; back in view, it is said, and the microphone waits for a tap (security review)', async () => {
  const k = await liveKit([{ said: 'Your train leaves in twenty minutes, from platform 4.', audio: tone(0.3) }]);
  try {
    await k.voice.unlock(); // an earlier tap
    hidden(true);
    await k.agent.wake({ kind: 'trigger', text: 'Train in 20 minutes', fallbacks: [{ watch: 'train', text: 'Train at 10:40' }] });
    await k.agent.channel.send('kokoro', 'It leaves from platform 4.', 'immediate', 'tool');
    await k.agent.idle();
    assert.equal(k.server.connections().length, 0, 'no session');
    assert.ok(!k.platform.log.includes('mic open'), 'no microphone');
    assert.equal(k.agent.live.state, 'closed');
    hidden(false);
    k.agent.shown(); // the app, on visibilitychange to visible
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    // Both in one text turn, so neither cuts the other off.
    assert.equal(texts(k).length, 1);
    assert.deepEqual(texts(k)[0].split('\n').sort(), [`<from_kokoro id="${k.agent.nonce}">It leaves from platform 4.</from_kokoro>`, '[annai] "Train in 20 minutes"']);
    assert.equal((await k.events(['out.speak']))[0].data.voice, true, 'said aloud: sound was unlocked');
    assert.ok(!k.platform.log.includes('mic open'), 'the microphone waits for a tap');
    assert.equal(k.agent.live.listening, false);
    k.agent.shown();
    await k.agent.idle();
    assert.equal(k.server.connections().length, 1, 'nothing waits: nothing opens');
  } finally {
    hidden(false);
    await k.done();
  }
});

test('Erase closes the session and forgets it before anything is wiped: what comes next starts afresh (security review)', async () => {
  const k = await liveKit([{ said: 'Hi.', audio: tone(0.2), handle: 'h-9' }]);
  try {
    k.agent.send('Hello');
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    k.agent.hush('erase');
    assert.equal(k.agent.live.state, 'closed');
    await soon(async () => (await lives(k, 'closed')).length === 1);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'erase');
    k.agent.send('Hello again');
    await until(() => got(k, 'setup').length === 2);
    assert.deepEqual(got(k, 'setup')[1].setup.sessionResumption, {}, 'no handle: nothing of the erased conversation resumes');
  } finally {
    await k.done();
  }
});

// Task 5: notes, and Kokoro's blocks (decision 14; Review Focus 2).
test("an append note waits for Koe's turn to end and its voice to finish playing, then goes in as <from_kokoro> text, and Koe says it", async () => {
  const k = await liveKit([{ said: 'Nepenthe is a restaurant on the cliffs.', audio: tone(1) }, { said: "It's open until ten tonight.", audio: tone(0.3) }], { pace: 1 });
  try {
    k.platform.streamSpeed = 1;
    await k.voice.unlock();
    k.agent.send('What is Nepenthe?');
    await until(() => k.agent.live.view.name === 'speaking');
    await k.agent.channel.send('kokoro', 'Nepenthe is open until 22:00 today (nepenthe.com).', 'append', 'tool');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(texts(k), ['What is Nepenthe?'], 'not while she speaks');
    await soon(async () => texts(k).length === 2);
    const [stream] = k.platform.streams;
    assert.ok(stream.ended && !stream.stopped && stream.playedMs >= 950, 'her voice played to its end first');
    assert.equal(texts(k)[1], `<from_kokoro id="${k.agent.nonce}">Nepenthe is open until 22:00 today (nepenthe.com).</from_kokoro>`);
    await soon(async () => (await k.events(['out.speak'])).length === 2);
    assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.text, e.data.cut]), [['Nepenthe is a restaurant on the cliffs.', undefined], ["It's open until ten tonight.", undefined]]);
  } finally {
    await k.done();
  }
});

test('an immediate note goes in at once and cuts Koe off mid-sentence; her line is kept up to there, and she corrects herself', async () => {
  const k = await liveKit([
    { said: 'Bixby Bridge is a steel suspension bridge from the nineteen fifties, built for the highway.', audio: tone(6) },
    { said: "Sorry, I was wrong: it's a concrete arch from 1932.", audio: tone(0.3) },
  ], { pace: 1 });
  try {
    k.platform.streamSpeed = 1;
    await k.voice.unlock();
    k.agent.send('Tell me about Bixby Bridge');
    await until(() => k.agent.live.view.name === 'speaking');
    await new Promise((r) => setTimeout(r, 600));
    // How much of her turn was heard goes with it, for a protocol that cuts its record there (OpenAI's truncate, K6).
    const s = k.sessions.at(-1);
    /** @type {any[]} */
    const seen = [];
    const text = s.text;
    s.text = (/** @type {string} */ t, /** @type {any} */ o) => { seen.push(o); return text(t, o); };
    const at = Date.now();
    await k.agent.channel.send('kokoro', "It's a concrete arch bridge, opened in 1932 (Caltrans).", 'immediate', 'tool');
    await until(() => texts(k).length === 2);
    assert.ok(Date.now() - at < 300, 'at once');
    assert.equal(seen[0].interrupt, true);
    assert.ok(seen[0].playedMs >= 500 && seen[0].playedMs < 2000, String(seen[0].playedMs));
    await soon(async () => (await k.events(['out.speak'])).length === 2, 5000);
    const [cut, fixed] = await k.events(['out.speak']);
    assert.equal(cut.data.cut, true);
    assert.match(cut.data.text, /^Bixby.*✂$/);
    assert.ok(!cut.data.text.includes('steel'), 'cut before the wrong claim was heard');
    assert.ok(cut.data.text.length < 60, cut.data.text);
    assert.equal(fixed.data.text, "Sorry, I was wrong: it's a concrete arch from 1932.");
    assert.ok(k.platform.streams[0].stopped);
  } finally {
    await k.done();
  }
});

test("opening and closing sessions again and again: Kokoro's system text and tools stay byte for byte the same; only blocks are added (Review Focus 2)", async () => {
  const k = await liveKit([{ said: 'Sure.', audio: tone(0.1) }], { kokoro: [{ rules: [{ match: '.', reply: sleep }] }] });
  try {
    for (let i = 0; i < 3; i++) {
      k.agent.send(`Question ${i}`);
      await soon(async () => (k.sent['model-0']?.length ?? 0) === i + 1);
      await k.agent.idle();
      k.agent.hush('away');
    }
    const asks = k.sent['model-0'];
    for (const r of asks.slice(1)) {
      assert.equal(r.system, asks[0].system);
      assert.deepEqual(r.tools, asks[0].tools);
    }
    await soon(async () => (await blocks(k)).length === 6);
    assert.deepEqual(await blocks(k), ['live-open', 'live-closed', 'live-open', 'live-closed', 'live-open', 'live-closed']);
    const last = JSON.stringify(asks[2].messages);
    assert.ok(last.includes('[annai] A live voice session opened: Koe speaks natively, and its words reach you as [Koe said aloud].'), last);
    assert.ok(last.includes('[annai] The live voice session closed.'));
  } finally {
    await k.done();
  }
});

test("with no session open, a live Koe never takes the microphone from the speech pipeline (one voice and one mic at a time)", async () => {
  const k = await liveKit([], { koe: { talk: { rules: [{ match: '.', reply: sleep }] } } });
  try {
    k.llm.bench.bench('m-live', 60_000); // Koe talks through its text model
    await k.agent.split();
    assert.equal(k.agent.koeState, 'text');
    assert.equal(k.agent.tap(), 'listening');
    await until(() => k.agent.state.name === 'listening');
    await k.agent.split(); // what voice is, worked out again
    await k.agent.idle();
    assert.equal(k.agent.state.name, 'listening');
    assert.notEqual(k.platform.log.at(-1), 'mic close', JSON.stringify(k.platform.log));
  } finally {
    await k.done();
  }
});
