// K5: Koe live (the Koe and Kokoro design, "Realtime sessions"; plan K5), against the stand-in realtime server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './agent-kit.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { liveKit, lives, blocks, got, texts, soon, tone, say, sleep } from './koe-live-kit.js';
import { quiet, cat } from './voice-kit.js';

// Task 1: choosing the pathway.
test("a realtime model first in Koe's list: Koe is live; resting, the text model after it talks", async () => {
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

test("Koe's pathway follows its list's order: a chat model first talks through the loop, voice on or off; resting, the realtime model after it is live, muted with voice off (the user, 2026-10-19: one Koe list)", async () => {
  const k = await liveKit([], { live: { first: false }, koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
  try {
    assert.equal(k.agent.koeState, 'text', 'voice on');
    await updateAppSettings(k.ws, { voice: { mode: 'off' } });
    await k.voice.refresh();
    await k.agent.idle();
    assert.equal(k.agent.koeState, 'text', 'voice off');
    k.llm.bench.bench('m-koe', 60_000);
    assert.equal(await k.agent.split(), true);
    assert.equal(k.agent.koeState, 'live', 'a session for typing, muted');
  } finally {
    await k.done();
  }
});

test("voice off, a chat model later in Koe's list answers before the realtime one ahead of it, saving the session's unheard audio; voice on, the realtime one is live again", async () => {
  const k = await liveKit([], { koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
  try {
    assert.equal(k.agent.koeState, 'live', 'voice on: Gemini Live, first in the list');
    await updateAppSettings(k.ws, { voice: { mode: 'off' } });
    await k.voice.refresh();
    await k.agent.idle();
    assert.equal(k.agent.koeState, 'text', 'voice off: the chat model after it');
    k.llm.bench.bench('m-koe', 60_000);
    assert.equal(await k.agent.split(), true);
    assert.equal(k.agent.koeState, 'live', 'the chat model resting: the live one, muted');
    k.llm.bench.clear('m-koe');
    await updateAppSettings(k.ws, { voice: { mode: 'on' } });
    await k.voice.refresh();
    await k.agent.idle();
    assert.equal(k.agent.koeState, 'live');
  } finally {
    await k.done();
  }
});

test("a session for typing that closes because the pathway moved to a text model says so, not \"voice off\": voice was off all along (fix pass)", async () => {
  const k = await liveKit([{ said: 'A taco stand, two minutes ahead.', audio: tone(0.2) }], { voice: { mode: 'off' }, koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
  try {
    k.llm.bench.bench('m-koe', 60_000);
    assert.equal(await k.agent.split(), true);
    assert.equal(k.agent.koeState, 'live', 'the chat model resting: Live, muted');
    k.agent.send('Where can we eat?');
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    assert.equal(k.agent.live.state, 'open');
    k.llm.bench.clear('m-koe');
    await k.agent.split();
    assert.equal(k.agent.koeState, 'text');
    await soon(async () => (await lives(k, 'closed')).length === 1);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'pathway');
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
    await updateAppSettings(k.ws, { voice: { silenceSeconds: 60 } }); // it listens for an answer this long (0.6 s here)
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

test("annai's own reminders while a live session's voice plays are shown, never spoken over it (one voice at a time)", async () => {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.2) }]);
  try {
    await k.voice.unlock();
    k.agent.send('Hi');
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    assert.ok(k.agent.live.voiced);
    await k.agent.remind([{ watch: 'w', text: 'Check-out at 11:00 in the other trip' }], 'elsewhere');
    await k.agent.remind([{ watch: 'w', text: 'Fuel is low' }]);
    assert.ok(k.notices.some((/** @type {any} */ n) => n.body === 'Fuel is low'), 'shown');
    assert.ok(!k.said.includes('Fuel is low') && !k.said.includes('Check-out at 11:00 in the other trip'), 'never said by annai over Koe');
    const [shown] = await k.events(['reminder']);
    assert.equal(shown.data.aloud, undefined);
  } finally {
    await k.done();
  }
});

// The fix pass (M2): a live Koe owes Kokoro's notes for the user as a text Koe does: one cue, then annai shows them (spec §6.8).
/** Kokoro's words for the user with its notes here (tell_koe's for_user). */
const FOR_USER = 'Nepenthe is open until 10 tonight.';
/**
 * The user asks, Koe answers, and then Kokoro's note comes. @param {any} k @param {string} text @param {any} [why]
 * @param {{ name: string, input: any }} [call] @param {string} [forUser] its words for the user: FOR_USER with a tell_koe
 */
const noted = async (k, text, why = 'tool', call, forUser = why === 'tool' ? FOR_USER : '') => {
  k.agent.send('Is Nepenthe open tonight?');
  await soon(async () => (await k.events(['out.speak'])).length === 1);
  await k.agent.idle();
  await k.agent.channel.send('kokoro', text, 'append', why, undefined, call, false, forUser);
};
const CUE = /^\[annai\] "Kokoro's note/;
/** Time for a turn that would come, to come. */
const settled = async (/** @type {any} */ k) => {
  await k.agent.idle();
  await new Promise((r) => setTimeout(r, 150));
  await k.agent.idle();
};

test("a live Koe's turn after Kokoro's note says nothing: it is asked once more, in the text cue's words, and then says it; annai shows nothing", async () => {
  const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, {}, { said: "It's open until ten tonight.", audio: tone(0.2) }]);
  try {
    await noted(k, 'Say: Nepenthe is open until 10 PM tonight.');
    await soon(async () => (await k.events(['out.speak'])).length === 2);
    await settled(k);
    const sent = texts(k);
    assert.equal(sent.length, 3, JSON.stringify(sent));
    assert.match(sent[1], /^<from_kokoro/);
    assert.match(sent[2], CUE);
    assert.deepEqual(await k.events(['reminder']), []);
    assert.deepEqual(k.notices, []);
  } finally {
    await k.done();
  }
});

test("a live Koe stays silent on Kokoro's note, asked once more too: annai shows its words for the user (for_user) as Shiori's answer, once", async () => {
  const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, {}]);
  try {
    await noted(k, 'Say: Nepenthe is open until 10 PM tonight.');
    await soon(async () => (await k.events(['reminder'])).length === 1);
    await settled(k);
    assert.deepEqual((await k.events(['reminder'])).map((/** @type {any} */ e) => [e.data.title, e.data.text, e.data.unsaid]), [["Shiori's answer", FOR_USER, true]]);
    assert.equal(texts(k).filter((t) => CUE.test(t)).length, 1, 'one cue');
    assert.equal(texts(k).length, 3);
  } finally {
    await k.done();
  }
});

test('a live Koe silent on "Kokoro couldn\'t check": asked once more, and nothing is shown (plan decision 21)', async () => {
  const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, {}]);
  try {
    await noted(k, "Kokoro couldn't check: The key was rejected. Tell the user you couldn't check, and offer to try again.", 'kokoro-failed');
    await soon(async () => texts(k).length === 3);
    await settled(k);
    assert.match(texts(k)[2], CUE);
    assert.deepEqual(await k.events(['reminder']), []);
    assert.deepEqual(k.notices, []);
  } finally {
    await k.done();
  }
});

test("a live Koe silent on Kokoro's gated card: annai shows the card itself", async () => {
  const card = { title: 'Nepenthe', text: 'Open 11:30–22:00 today.' };
  const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, {}]);
  try {
    await noted(k, 'Kokoro wants to show: Nepenthe: Open 11:30–22:00 today.', 'gated:show', { name: 'show', input: { card } });
    await soon(async () => (await k.events(['out.show'])).length === 1);
    await settled(k);
    assert.deepEqual((await k.events(['out.show']))[0].data.card, card);
    assert.deepEqual(await k.events(['reminder']), []);
  } finally {
    await k.done();
  }
});

test("a live Koe that shows a card after Kokoro's note has passed it on: no cue", async () => {
  const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, { tool: { name: 'show', args: { card: { title: 'Nepenthe', text: 'Open till 10 tonight.' } } } }, {}]);
  try {
    await noted(k, 'Say: Nepenthe is open until 10 PM tonight.');
    await soon(async () => (await k.events(['out.show'])).length === 1);
    await settled(k);
    assert.equal(texts(k).length, 2, JSON.stringify(texts(k)));
    assert.deepEqual(await k.events(['reminder']), []);
  } finally {
    await k.done();
  }
});

// The fix pass (S1): a live Koe settles a note it has already said with already_told, as a text Koe does.
test("a live Koe that settles Kokoro's note with already_told: no cue, nothing shown, and the tool's answer adds no speech", async () => {
  const k = await liveKit([{ said: "It's open until ten tonight.", audio: tone(0.2) }, { tool: { name: 'already_told', args: {} } }, {}]);
  try {
    await noted(k, 'Say: Nepenthe is open until 10 PM tonight.');
    await soon(async () => (await k.events(['tool.result'])).some((/** @type {any} */ e) => e.data.name === 'already_told'));
    await settled(k);
    assert.equal(texts(k).length, 2, JSON.stringify(texts(k)));
    assert.deepEqual(await k.events(['reminder']), []);
    const answer = got(k, 'toolResponse').at(-1).toolResponse.functionResponses[0];
    assert.equal(answer.scheduling, 'SILENT');
  } finally {
    await k.done();
  }
});

// The second fix pass (L1): a note is never lost to a close, a drop, a GoAway or Koe moving to text; it is passed on or shown once.
/** What annai showed for Koe. @param {any} k */
const answers = async (k) => (await k.events(['reminder'])).map((/** @type {any} */ e) => [e.data.title, e.data.text]);
/** What the stand-in got, in order: setup, or a text turn's words. @param {any} k */
const order = (k) => k.server.received().filter((/** @type {any} */ m) => m.setup || m.clientContent).map((/** @type {any} */ m) => (m.setup ? 'setup' : m.clientContent.turns[0].parts[0].text));
const SHOWN = [["Shiori's answer", FOR_USER]];

test('L1: the connection drops right after the cue: the resumed session hears the note again, and annai shows it once when Koe stays silent', async () => {
  const k = await liveKit([
    { said: 'Let me check.', audio: tone(0.2) },
    {}, // silent on the note
    { audio: tone(3), saidAfter: "It's open until ten." }, // the cue's answer, cut by the drop before a word of it
    {}, {}, // the resumed session: silent on the note, then on the cue
  ], { pace: 1 });
  try {
    await noted(k, 'Say: Nepenthe is open until 10 PM tonight.');
    await soon(async () => texts(k).some((t) => CUE.test(t)));
    await new Promise((r) => setTimeout(r, 200));
    k.server.close(1011, 'Internal error encountered.');
    await until(() => k.server.connections().length === 2);
    await soon(async () => (await answers(k)).length === 1, 5000);
    await settled(k);
    assert.deepEqual(await answers(k), SHOWN);
    const resumed = order(k).slice(order(k).lastIndexOf('setup'));
    assert.match(resumed[1], /^<from_kokoro/, 'the note went in again');
  } finally {
    await k.done();
  }
});

test('L1: a GoAway on the silent turn after the note: the new connection hears the note, and annai shows it once when Koe stays silent', async () => {
  const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, { handle: 'h-2', goAway: 10 }, {}, {}]);
  try {
    await noted(k, 'Say: Nepenthe is open until 10 PM tonight.');
    await until(() => k.server.connections().length === 2);
    await soon(async () => (await answers(k)).length === 1, 5000);
    await settled(k);
    assert.deepEqual(await answers(k), SHOWN);
    const resumed = order(k).slice(order(k).lastIndexOf('setup'));
    assert.match(resumed[1], /^<from_kokoro/, 'the note went to the new connection');
  } finally {
    await k.done();
  }
});

test('L1: Koe moves to its text model between the note and the cue: the text Koe owes the note, and passes it on', async () => {
  const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, { audio: tone(2) }], { pace: 1, koe: { type: { rules: [
    { match: 'a note from Kokoro', reply: { toolCalls: [{ name: 'speak', input: { text: "It's open until ten tonight." } }, { name: 'sleep', input: {} }] } },
    { match: '.', reply: sleep },
  ] } } });
  try {
    await noted(k, 'Say: Nepenthe is open until 10 PM tonight.');
    await soon(async () => texts(k).length === 2);
    k.llm.bench.bench('m-live', 60_000);
    await k.agent.split();
    assert.equal(k.agent.koeState, 'text');
    await soon(async () => (await k.events(['out.speak'])).some((/** @type {any} */ e) => !e.data.live && e.data.text === "It's open until ten tonight."));
    await settled(k);
    assert.deepEqual(await answers(k), []);
  } finally {
    await k.done();
  }
});

// The second fix pass (L3): a note no session could take goes to the text Koe alone, never again into a later session.
test('L3: no live session could open for the note: the text Koe has it, and a later session never gets it again; shown once', async () => {
  const k = await liveKit([{ said: "You're welcome.", audio: tone(0.2) }], { koe: { type: [sleep] } });
  try {
    const live = k.llm.live;
    k.llm.live = async () => { k.llm.live = live; throw new Error('no connection'); };
    await k.agent.channel.send('kokoro', 'Say: Nepenthe is open until 10 PM tonight.', 'append', 'tool', undefined, undefined, false, FOR_USER);
    await soon(async () => (await answers(k)).length === 1, 5000);
    await k.agent.idle();
    k.llm.bench.clear('m-live');
    assert.equal(await k.agent.split(), true);
    assert.equal(k.agent.koeState, 'live');
    k.agent.send('Thanks');
    await soon(async () => (await k.events(['out.speak'])).some((/** @type {any} */ e) => e.data.live));
    await settled(k);
    assert.deepEqual(await answers(k), SHOWN);
    assert.ok(!texts(k).some((t) => t.startsWith('<from_kokoro')), 'the note never went into the session');
  } finally {
    await k.done();
  }
});

// The second fix pass (L2): a live show or ask that annai refuses passes nothing on.
for (const [what, tool] of /** @type {const} */ ([
  ['show of a card of a kind no plugin draws', { name: 'show', args: { card: { type: 'ferries', title: 'Nepenthe' } } }],
  ['ask with no options', { name: 'ask', args: { question: 'Shall I book?', options: [] } }],
])) {
  test(`L2: after Kokoro's note, a live Koe's ${what} is refused: Koe gets the cue, then annai shows the note`, async () => {
    const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, { tool }, {}]);
    try {
      await noted(k, 'Say: Nepenthe is open until 10 PM tonight.');
      await soon(async () => (await answers(k)).length === 1, 5000);
      await settled(k);
      assert.equal((await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === tool.name)?.data.ok, false);
      assert.equal(texts(k).filter((t) => CUE.test(t)).length, 1);
      assert.deepEqual(await answers(k), SHOWN);
      assert.deepEqual(await k.events(['out.show', 'out.ask']), []);
    } finally {
      await k.done();
    }
  });
}

// voice-fix item 2 (the iPhone trace, 2026-10-22): Kokoro's notes are words for Koe; annai never shows or says them as they are.
const STORY = 'Tell them a short Big Sur story (source: Wikivoyage, Big Sur). Highway 1 took from 1919 to 1937 to build.';
/** What annai showed or said with the story's words in it: reminders, the voice's clips, the browser voice. @param {any} k */
const storyOut = async (k) => [
  ...(await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text), ...k.said, ...k.platform.log.filter((/** @type {string} */ l) => l.startsWith('browser')),
].filter((t) => /Big Sur|Highway 1/.test(t));

test("a live Koe silent on Kokoro's note with no words for the user: nothing is shown or said; the note goes to Koe again with the user's next words", async () => {
  const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, {}, {}, { said: 'Highway one took eighteen years to build.', audio: tone(0.2) }]);
  try {
    await noted(k, STORY, 'tool', undefined, '');
    await soon(async () => texts(k).filter((t) => CUE.test(t)).length === 1);
    await settled(k);
    assert.deepEqual(await storyOut(k), [], 'never shown or said as it is');
    assert.equal(texts(k).filter((t) => t.includes('Big Sur story')).length, 1);
    k.agent.send('And the story?');
    await soon(async () => texts(k).filter((t) => t.includes('Big Sur story')).length === 2);
    await soon(async () => (await k.events(['out.speak'])).some((/** @type {any} */ e) => /eighteen years/.test(e.data.text)));
    await settled(k);
    assert.deepEqual(await storyOut(k), []);
  } finally {
    await k.done();
  }
});

test("a tap that closes a live session with Kokoro's note still owed says and shows nothing of it: the note goes into the next session", async () => {
  const k = await liveKit([{ heard: 'Tell me a story.', said: 'Sure.', audio: tone(0.2) }]);
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening);
    const { clip } = await import('./voice-kit.js');
    const lunch = await clip('where-lunch');
    k.platform.mic.feed(cat(quiet(0.5), lunch.subarray(0, lunch.length >> 1)), 16_000); // the user is still speaking
    await until(() => k.agent.live.view.name === 'hearing');
    await k.agent.channel.send('kokoro', STORY, 'append', 'tool', undefined, undefined, false, 'Highway 1 through Big Sur took from 1919 to 1937 to build.');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(k.agent.tap(), 'stopped');
    await settled(k);
    assert.equal(k.agent.live.state, 'closed');
    assert.deepEqual(await storyOut(k), [], 'no voice.say, no reminder with its words');
    assert.ok(!texts(k).some((t) => t.includes('Big Sur story')), 'it never went in');
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } }); // 3 s here: past the 1 s a tap's session holds kept notes for
    k.agent.tap();
    await until(() => k.agent.live.listening);
    await soon(async () => texts(k).some((t) => t.includes('Big Sur story')));
  } finally {
    await k.done();
  }
});

test("review S3: the session a tap opens holds a kept note while the user starts to speak: it goes in after their activityEnd, not over them", async () => {
  const k = await liveKit([{ heard: 'Tell me a story.', said: 'Sure.', audio: tone(0.2) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    const { clip } = await import('./voice-kit.js');
    const lunch = await clip('where-lunch');
    k.agent.tap();
    await until(() => k.agent.live.listening && k.platform.log.includes('mic open'));
    k.platform.mic.feed(cat(quiet(0.5), lunch.subarray(0, lunch.length >> 1)), 16_000);
    await until(() => k.agent.live.view.name === 'hearing');
    await k.agent.channel.send('kokoro', STORY, 'append', 'tool', undefined, undefined, false, 'Highway 1 took from 1919 to 1937 to build.');
    await until(() => k.agent.live.owing);
    assert.equal(k.agent.tap(), 'stopped');
    await settled(k);
    k.agent.tap(); // a tap to talk
    await until(() => k.agent.live.listening && k.platform.log.filter((/** @type {string} */ l) => l === 'mic open').length >= 2);
    await new Promise((r) => setTimeout(r, 150)); // they start a moment after the tap
    k.platform.mic.feed(cat(quiet(0.3), lunch, quiet(1)), 16_000);
    await soon(async () => texts(k).some((t) => t.includes('Big Sur story')));
    const all = k.server.received();
    const second = all.slice(all.findIndex((/** @type {any} */ m, /** @type {number} */ i) => m.setup && i > 0));
    const order = second.filter((/** @type {any} */ m) => m.realtimeInput?.activityStart || m.realtimeInput?.activityEnd || m.clientContent).map((/** @type {any} */ m) => (m.clientContent ? 'note' : Object.keys(m.realtimeInput)[0]));
    assert.deepEqual(order, ['activityStart', 'activityEnd', 'note']);
  } finally {
    await k.done();
  }
});

test("review S4: switching to another trip with Kokoro's note still owed shows its words for the user (for_user) in the trip left, not aloud; a note without them shows nothing", async () => {
  const k = await liveKit([{ heard: 'Tell me a story.', said: 'Sure.', audio: tone(0.2) }]);
  try {
    const { clip } = await import('./voice-kit.js');
    const { createTrip } = await import('../../src/core/scopes.js');
    const lunch = await clip('where-lunch');
    k.agent.tap();
    await until(() => k.agent.live.listening && k.platform.log.includes('mic open'));
    k.platform.mic.feed(cat(quiet(0.5), lunch.subarray(0, lunch.length >> 1)), 16_000); // still speaking: the notes wait
    await until(() => k.agent.live.view.name === 'hearing');
    await k.agent.channel.send('kokoro', STORY, 'append', 'tool', undefined, undefined, false, 'Highway 1 took from 1919 to 1937 to build.');
    await k.agent.channel.send('kokoro', 'Tell them to check the tide table too.', 'append', 'tool');
    await until(() => k.agent.live.owing);
    const other = await createTrip(k.ws, { title: 'Carmel' });
    await k.agent.open(other);
    await k.agent.idle();
    const shown = (await k.events(['reminder'])).map((/** @type {any} */ e) => [e.data.title, e.data.text, e.data.unsaid, e.data.aloud]);
    assert.deepEqual(shown, [["Shiori's answer", 'Highway 1 took from 1919 to 1937 to build.', true, undefined]]);
    assert.ok(!k.said.some((/** @type {string} */ t) => t.includes('Highway')), 'not said');
  } finally {
    await k.done();
  }
});

test("the review's minors: a note retold goes in as the user's next spoken turn ends, as an append, not after Koe's first word", async () => {
  const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, {}, {}, { heard: 'And the story?', said: 'Highway one took eighteen years.', audio: tone(2) }], { pace: 1 });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    await noted(k, STORY, 'tool', undefined, '');
    await soon(async () => texts(k).filter((t) => CUE.test(t)).length === 1);
    await settled(k);
    const { clip } = await import('./voice-kit.js');
    const lunch = await clip('where-lunch');
    k.agent.tap();
    await until(() => k.agent.live.listening && k.platform.log.includes('mic open'));
    k.platform.mic.feed(cat(quiet(0.5), lunch, quiet(1)), 16_000);
    await soon(async () => texts(k).filter((t) => t.includes('Big Sur story')).length === 2);
    const last = k.server.received().slice(k.server.received().map((/** @type {any} */ m) => Boolean(m.realtimeInput?.activityEnd)).lastIndexOf(true));
    assert.ok(last.some((/** @type {any} */ m) => m.clientContent?.turns[0].parts[0].text.includes('Big Sur story')), 'after the activityEnd');
    assert.ok(!(await k.events(['out.speak'])).some((/** @type {any} */ e) => /eighteen/.test(e.data.text)), 'before Koe answered the spoken turn');
  } finally {
    await k.done();
  }
});

test("the review's minors: a note held to be retold is let go once Koe reaches the user anyway", async () => {
  const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, {}, {}, { said: 'Sunset is soon.', audio: tone(0.2) }, { said: 'Sure.', audio: tone(0.2) }]);
  try {
    await noted(k, STORY, 'tool', undefined, '');
    await soon(async () => texts(k).filter((t) => CUE.test(t)).length === 1);
    await settled(k);
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes', fallbacks: [] });
    await soon(async () => (await k.events(['out.speak'])).some((/** @type {any} */ e) => e.data.text === 'Sunset is soon.'));
    await settled(k);
    k.agent.send('Thanks');
    await soon(async () => (await k.events(['out.speak'])).some((/** @type {any} */ e) => e.data.text === 'Sure.'));
    assert.equal(texts(k).filter((t) => t.includes('Big Sur story')).length, 1, 'not retold');
  } finally {
    await k.done();
  }
});

test("Kokoro's note that comes while the user is still speaking goes in as soon as they finish (activityEnd), not after Koe's answer", async () => {
  const k = await liveKit([{ heard: 'Where should we eat?', said: 'There is a taco stand ahead, and a diner after the bridge.', audio: tone(2) }, { said: 'And Nepenthe is open.', audio: tone(0.2) }], { pace: 1 });
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening);
    const { clip } = await import('./voice-kit.js');
    const lunch = await clip('where-lunch');
    k.platform.mic.feed(cat(quiet(0.5), lunch.subarray(0, lunch.length >> 1)), 16_000);
    await until(() => k.agent.live.view.name === 'hearing');
    await k.agent.channel.send('kokoro', 'Say: Nepenthe is open until 10 PM tonight.', 'append', 'tool', undefined, undefined, false, FOR_USER);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!texts(k).length, 'not while they speak');
    k.platform.mic.feed(cat(lunch.subarray(lunch.length >> 1), quiet(1)), 16_000);
    await soon(async () => got(k, 'realtimeInput').some((/** @type {any} */ m) => m.realtimeInput.activityEnd));
    await new Promise((r) => setTimeout(r, 300));
    const order = k.server.received().filter((/** @type {any} */ m) => m.realtimeInput?.activityEnd || m.clientContent).map((/** @type {any} */ m) => (m.clientContent ? 'note' : 'end'));
    assert.deepEqual(order, ['end', 'note'], 'the note followed activityEnd within 300 ms');
  } finally {
    await k.done();
  }
});
