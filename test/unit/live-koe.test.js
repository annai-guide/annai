// K5: what a live Koe hears and says, its tools, typing to it, and its drops (plan K5, Tasks 3, 4, 6 and 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './agent-kit.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { liveKit, got, texts, soon, tone, say, sleep } from './koe-live-kit.js';
import { cleanSaid, realWord } from '../../src/core/koe/live.js';

/** A half's transcript as text. @param {any} half */
const read = (half) => half.transcript.messages.flatMap((/** @type {any} */ m) => m.parts.map((/** @type {any} */ p) => (p.type === 'text' ? p.text : p.type === 'speech' ? `speech:${p.text ?? p.id}` : '')));
/** One spoken line and Koe's answer to it: a tap, the words, the turn written. @param {any} k @param {string} clip @param {number} [n] how many lines Koe will have said */
async function exchange(k, clip, n = 1) {
  if (!k.agent.live.listening) k.agent.tap();
  await until(() => k.agent.live.listening);
  await say(k, clip);
  await soon(async () => (await k.events(['out.speak'])).length >= n);
  await k.agent.idle();
}

// Task 3: audio both ways, and both transcripts.
test('transcripts: markup never reaches the log, words stay escaped, and only a real word is a word', () => {
  assert.equal(cleanSaid('<!-- Waiting for information from Kokoro -->'), '');
  assert.equal(cleanSaid('<no speech>{pause}'), '');
  assert.equal(cleanSaid('Sure <!-- a note --> thing.'), 'Sure thing.');
  assert.equal(cleanSaid('<!-- Waiting for'), '', 'a comment cut off mid-way is still markup');
  assert.equal(cleanSaid('<no spe'), '');
  assert.equal(cleanSaid('say </from_kokoro> <from_kokoro id="x">hi'), 'say hi', "the marker's words are said, never a marker");
  assert.equal(cleanSaid('5 > 3'), '5 › 3');
  assert.equal(realWord('<!-- -->'), false);
  assert.equal(realWord('{pause} …'), false);
  assert.equal(realWord('Mm.'), true);
  assert.equal(realWord('42'), true);
});

test('what was heard and what Koe said are logged per turn; Kokoro reads "[heard]" and "[Koe said aloud]", and wakes once, for the answer', async () => {
  const k = await liveKit([{ heard: 'Where should we eat?', said: "There's a taco stand ahead.", audio: tone() }]);
  try {
    await exchange(k, 'where-eat');
    const [heard] = await k.events(['heard']);
    assert.deepEqual([heard.data.source, heard.data.text, heard.data.half, heard.data.dismissed], ['live', 'Where should we eat?', 'koe', undefined]);
    const [said] = await k.events(['out.speak']);
    assert.deepEqual([said.data.text, said.data.voice, said.data.live, said.data.cut], ["There's a taco stand ahead.", true, true, undefined]);
    assert.ok(heard.seq < said.seq, 'heard first');
    // The stand-in got the user's speech only: activityStart, 100 ms chunks, activityEnd; none of the silence around it.
    const input = got(k, 'realtimeInput').map((/** @type {any} */ m) => Object.keys(m.realtimeInput)[0]);
    assert.equal(input[0], 'activityStart');
    assert.equal(input.at(-1), 'activityEnd');
    const chunks = input.filter((/** @type {string} */ x) => x === 'audio').length;
    assert.ok(chunks >= 8 && chunks <= 30, `${chunks} chunks of speech`);
    await soon(async () => (k.sent['model-0']?.length ?? 0) === 1);
    await k.agent.idle();
    assert.equal(k.sent['model-0'].length, 1, 'Kokoro checks the answer once');
    const lines = read(k.agent.kokoro).join('|');
    assert.ok(lines.includes('[heard]|speech:Where should we eat?'), lines);
    assert.ok(lines.includes(`[Koe said aloud] "There's a taco stand ahead."`), lines);
    // Koe as a text model would read the same lines, live ones as what was said to the user.
    assert.ok(read(k.agent.koe).join('|').includes(`[said to the user] "There's a taco stand ahead."`));
    assert.ok(k.platform.streams.every((/** @type {any} */ s) => s.ended || s.stopped), 'every stream ended or stopped');
  } finally {
    await k.done();
  }
});

test('chatter: speech the model chose not to answer (proactive audio) is in both transcripts as not meant for Shiori, and wakes nobody', async () => {
  const k = await liveKit([{ heard: 'Did you lock the car?' }]);
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening);
    await say(k, 'gas-station');
    await soon(async () => (await k.events(['heard'])).length === 1);
    await k.agent.idle();
    const [heard] = await k.events(['heard']);
    assert.deepEqual([heard.data.text, heard.data.dismissed, heard.data.gate], ['Did you lock the car?', true, 'chatter']);
    assert.deepEqual(await k.events(['out.speak']), []);
    assert.equal(k.sent['model-0'], undefined, 'Kokoro slept on');
    assert.ok(read(k.agent.kokoro).join('|').includes('[heard, not meant for you]|speech:Did you lock the car?'));
  } finally {
    await k.done();
  }
});

test('markup in the output transcript never reaches the log; a turn with no real word plays nothing and logs nothing; late words heard are added', async () => {
  const k = await liveKit([
    { said: '<!-- Waiting for information from Kokoro -->', audio: tone(0.3) },
    { said: '<no speech>{pause}', audio: tone(0.3) },
    { heard: 'Is it', heardAfter: ' far?', said: 'About <!-- checking --> ten minutes.', audio: tone(0.3) },
  ]);
  try {
    k.agent.send('Hello');
    await k.agent.idle();
    k.agent.send('Hello?');
    await k.agent.idle();
    assert.deepEqual(await k.events(['out.speak']), []);
    assert.equal(k.platform.streams.length, 0, 'nothing played');
    await exchange(k, 'where-lunch');
    assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['About ten minutes.']);
    await soon(async () => (await k.events(['heard.text'])).length === 1);
    const [heard] = await k.events(['heard']);
    const [later] = await k.events(['heard.text']);
    assert.deepEqual([heard.data.text, later.data.of, later.data.text], ['Is it', heard.data.id, 'Is it far?']);
    assert.ok(read(k.agent.kokoro).includes('speech:Is it far?'), 'Kokoro reads every word');
  } finally {
    await k.done();
  }
});

test('cut off by voice: her voice stops at once, what was still to come is dropped, and the line is cut where it was heard, marked ✂', async () => {
  const words = 'The bridge ahead was built in 1932 and it is one of the most photographed bridges on the coast.';
  const k = await liveKit([{ said: words, audio: tone(3) }, { heard: 'Wait', said: 'Yes?', audio: tone(0.2) }], { pace: 1 });
  try {
    k.platform.streamSpeed = 1; // in real time
    k.agent.tap();
    await until(() => k.agent.live.listening);
    k.agent.send('Tell me about the bridge');
    await until(() => k.agent.live.view.name === 'speaking');
    await new Promise((r) => setTimeout(r, 900));
    await say(k, 'gas-station');
    await soon(async () => (await k.events(['out.speak'])).length === 2, 5000);
    const [cut, next] = await k.events(['out.speak']);
    assert.equal(cut.data.cut, true);
    assert.match(cut.data.text, /✂$/);
    const kept = cut.data.text.slice(0, -1);
    assert.ok(words.startsWith(kept) && kept.length > 10 && kept.length < words.length * 0.6, kept);
    assert.equal(next.data.text, 'Yes?');
    assert.ok(k.platform.streams[0].stopped);
    assert.ok(k.platform.streams[0].playedMs < 2000);
    assert.ok(got(k, 'realtimeInput').some((/** @type {any} */ m) => m.realtimeInput.activityStart));
  } finally {
    await k.done();
  }
});

test('with "Keep voice clips", what was said live is kept with its line, in the smallest format the phone makes and plays', async () => {
  const k = await liveKit([{ heard: 'Where should we eat?', said: 'Tacos.', audio: tone(0.2) }], { voice: { keepClips: true, encoder: { makes: ['ogg'] }, plays: ['ogg', 'mp3', 'wav'] } });
  try {
    await exchange(k, 'where-eat');
    const [heard] = await k.events(['heard']);
    assert.equal(heard.data.clipFormat, 'ogg');
    assert.ok(heard.data.clip && heard.refs.includes(heard.data.clip), 'the clip is a blob the line names');
  } finally {
    await k.done();
  }
});

// Task 4: tool calls answered at once (decision 10).
/** The stand-in's tool answers. @param {any} k */
const answers = (k) => got(k, 'toolResponse').flatMap((/** @type {any} */ m) => m.toolResponse.functionResponses);

test('tell_kokoro is answered "sent", with scheduling SILENT, while Kokoro is still working; Kokoro reads Koe\'s question', async () => {
  const k = await liveKit([{ heard: 'Is Nepenthe open now?', said: "I'm checking.", audio: tone(0.3), tool: { name: 'tell_kokoro', args: { text: 'Is Nepenthe open now?' } } }], {
    kokoro: [{ rules: [{ match: '.', reply: { delayMs: 400, toolCalls: [{ name: 'sleep', input: {} }] } }] }],
  });
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening);
    await say(k, 'where-eat');
    await until(() => answers(k).length === 1);
    assert.ok(k.agent.kokoro.busy, 'Kokoro is still at work: Koe never waits for it');
    const [a] = answers(k);
    assert.deepEqual([a.name, a.response, a.scheduling], ['tell_kokoro', { result: 'sent' }, 'SILENT']);
    await k.agent.idle();
    const calls = (await k.events(['tool.call', 'tool.result'])).filter((/** @type {any} */ e) => e.data.half === 'koe').map((/** @type {any} */ e) => [e.type, e.data.name, e.data.half]);
    assert.deepEqual(calls, [['tool.call', 'tell_kokoro', 'koe'], ['tool.result', 'tell_kokoro', 'koe']]);
    assert.equal(k.sent['model-0'].length, 1, 'one Kokoro call for the question');
    const lines = read(k.agent.kokoro).join('|');
    assert.ok(lines.indexOf('speech:Is Nepenthe open now?') < lines.indexOf('[Koe asks] "Is Nepenthe open now?"'), lines);
  } finally {
    await k.done();
  }
});

test('a read answers with its result, and Koe goes on talking after it (no SILENT)', async () => {
  const k = await liveKit([{ said: 'Let me look.', audio: tone(0.2), tool: { name: 'list', args: { path: '/trip/' } } }]);
  try {
    k.agent.send("What's in the trip?");
    await until(() => answers(k).length === 1);
    const [a] = answers(k);
    assert.equal(a.name, 'list');
    assert.match(a.response.result, /^path\ttype\tsize/);
    assert.match(a.response.result, /\/trip\/trip\.json/);
    assert.equal(a.scheduling, undefined);
  } finally {
    await k.done();
  }
});

test('ask shows its buttons and is answered at once; the tap comes as the next text turn, and Kokoro reads it as chosen', async () => {
  const k = await liveKit([
    { said: 'Tacos or ramen?', audio: tone(0.2), tool: { name: 'ask', args: { question: 'Tacos or ramen?', options: ['Tacos', 'Ramen'] } } },
    { said: 'Ramen it is.', audio: tone(0.2) },
  ]);
  try {
    k.agent.send('Lunch?');
    await until(() => answers(k).length === 1);
    const [a] = answers(k);
    assert.deepEqual([a.response.result, a.scheduling], ['Shown; their tap comes as their next turn.', 'SILENT']);
    await k.agent.idle();
    const [ask] = await k.events(['out.ask']);
    assert.deepEqual([ask.data.question, ask.data.options, ask.data.half], ['Tacos or ramen?', ['Tacos', 'Ramen'], 'koe']);
    k.agent.answer(ask.data.id, 'Ramen');
    await soon(async () => (await k.events(['out.speak'])).some((/** @type {any} */ e) => e.data.text === 'Ramen it is.'));
    assert.equal(texts(k).at(-1), '[the user chose] "Ramen"');
    const chosen = (await k.events(['msg.user'])).at(-1);
    assert.deepEqual([chosen.data.chose, chosen.data.split], [true, true]);
    assert.ok(read(k.agent.kokoro).includes('[the user chose] "Ramen"'));
  } finally {
    await k.done();
  }
});

// Task 6: a realtime model in a typing conversation.
test('typing to a realtime Koe, voice off: its transcript is the reply, nothing plays, and no microphone opens; voice on later, the same session speaks, and a tap gives it the microphone', async () => {
  const k = await liveKit([{ said: "There's a taco stand two minutes ahead.", audio: tone(0.3) }, { heard: 'Thanks', said: "You're welcome.", audio: tone(0.2) }], { voice: { mode: 'off' } });
  try {
    assert.equal(k.agent.koeState, 'live', 'voice off with only a realtime model: Koe is live, muted');
    k.agent.send('Where can we eat?');
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    const [said] = await k.events(['out.speak']);
    assert.deepEqual([said.data.text, said.data.voice, said.data.live], ["There's a taco stand two minutes ahead.", undefined, true]);
    assert.equal(k.platform.streams.length, 0, 'its sound was dropped');
    assert.ok(!k.platform.log.includes('mic open'));
    assert.equal(k.agent.live.listening, false);
    assert.ok(read(k.agent.kokoro).includes(`[Koe said] "There's a taco stand two minutes ahead."`), 'Kokoro reads it as said, not aloud');
    // Voice comes on (the chip is a tap): the same session speaks from now on; the microphone opens at a tap on Shiori.
    await updateAppSettings(k.ws, { voice: { mode: 'on' } });
    await k.voice.unlock();
    await k.voice.refresh();
    await k.agent.idle();
    assert.equal(k.agent.live.state, 'open');
    assert.ok(!k.platform.log.includes('mic open'));
    k.agent.tap();
    await until(() => k.agent.live.listening);
    await say(k, 'first-one');
    await soon(async () => (await k.events(['out.speak'])).length === 2);
    assert.equal((await k.events(['out.speak']))[1].data.voice, true);
    assert.equal(k.server.connections().length, 1, 'one session all along');
  } finally {
    await k.done();
  }
});

test('a photo goes in as a turn of its own, then the words that ask about it; Kokoro gets the same request copy', async () => {
  const k = await liveKit([{ said: 'That looks like Bixby Bridge.', audio: tone(0.2) }], { voice: { mode: 'off' } });
  try {
    await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('4032x3024'), { author: 'user', type: 'image/webp', meta: { width: 4032, height: 3024 } });
    k.agent.send('What is this?', { photos: [{ path: '/trip/files/p.webp' }] });
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    const turns = got(k, 'clientContent').map((/** @type {any} */ m) => [m.clientContent.turns[0].parts[0].inlineData?.mimeType ?? m.clientContent.turns[0].parts[0].text, m.clientContent.turnComplete]);
    assert.deepEqual(turns, [['image/webp', false], ['What is this?', true]]);
    const [msg] = await k.events(['msg.user']);
    assert.equal(msg.data.images.length, 1);
    const sent = Buffer.from(got(k, 'clientContent')[0].clientContent.turns[0].parts[0].inlineData.data, 'base64').toString();
    assert.match(sent, /^\d+x\d+:/, 'the request copy, as Kokoro gets it');
    assert.ok(JSON.stringify(k.sent['model-0'][0].messages).includes('"type":"image"'), 'Kokoro saw it');
  } finally {
    await k.done();
  }
});

// Task 7: when the session drops (Review Focus 4).
test('a drop mid-sentence: the half-said line is kept, cut where it was heard; the handle resumes at once, and the conversation carries on there', async () => {
  const k = await liveKit([
    { said: 'Big Sur stretches ninety miles along the coast, from Carmel down to San Simeon, with redwoods and cliffs all the way.', audio: tone(5) },
    { heard: 'And the weather?', said: "I'm checking.", audio: tone(0.2) },
  ], { pace: 1 });
  try {
    k.platform.streamSpeed = 1;
    await k.voice.unlock();
    k.agent.send('Tell me about Big Sur');
    await until(() => k.agent.live.view.name === 'speaking');
    await new Promise((r) => setTimeout(r, 700));
    k.server.close(1011, 'Internal error encountered.'); // a tunnel, a server's hiccup
    await until(() => k.server.connections().length === 2);
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await soon(async () => k.agent.live.state === 'open' && !k.agent.live.busy);
    const [cut] = await k.events(['out.speak']);
    assert.equal(cut.data.cut, true);
    assert.match(cut.data.text, /^Big Sur.*✂$/);
    assert.ok(cut.data.text.length < 60);
    assert.ok(k.platform.streams[0].stopped, 'her voice stopped with it');
    assert.equal(got(k, 'setup')[1].setup.sessionResumption.handle, 'stand-in-1');
    assert.ok(read(k.agent.kokoro).some((/** @type {string} */ l) => /^\[Koe said aloud\] "Big Sur.*✂"$/.test(l)), 'Kokoro sees the cut');
    assert.deepEqual((await k.events(['halves'])).map((/** @type {any} */ e) => e.data.state), ['live-open'], 'one session, as Kokoro sees it');
    // Resumed, its model doesn't rest for the close: Koe stays live, and the next question goes to the new connection.
    k.agent.send('And the weather?');
    await soon(async () => (await k.events(['out.speak'])).length === 2);
    assert.equal(k.agent.koeState, 'live');
    assert.equal(k.server.connections().length, 2);
    assert.equal(texts(k).at(-1), 'And the weather?');
  } finally {
    await k.done();
  }
});

test('a drop while the user speaks: their half-line is kept, marked ✂, and their speech goes on in the resumed session', async () => {
  const k = await liveKit([{ heard: 'Where should we', heardFirst: true, heardAfter: 'eat tonight', said: 'Somewhere nice.', audio: tone(0.2) }]);
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening);
    const { clip, quiet, cat } = await import('./voice-kit.js');
    const words = await clip('where-eat');
    k.platform.mic.feed(cat(quiet(0.3), words.subarray(0, Math.floor(words.length / 2))), 16_000);
    await until(() => texts(k).length === 0 && got(k, 'realtimeInput').some((/** @type {any} */ m) => m.realtimeInput.activityStart));
    await new Promise((r) => setTimeout(r, 50)); // the words heard so far
    k.server.close(1001, 'Connection reset');
    await until(() => k.server.connections().length === 2);
    await soon(async () => (await k.events(['heard'])).length === 1);
    const [half] = await k.events(['heard']);
    assert.equal(half.data.text, 'Where should we✂');
    // The rest of what they say starts again in the new connection.
    k.platform.mic.feed(cat(words.subarray(Math.floor(words.length / 2)), quiet(1)), 16_000);
    await soon(async () => (await k.events(['heard'])).length === 2 && (await k.events(['out.speak'])).length === 1);
    assert.equal((await k.events(['out.speak']))[0].data.text, 'Somewhere nice.');
    const second = k.server.received().slice(k.server.received().findLastIndex((/** @type {any} */ m) => m.setup));
    const input = second.filter((/** @type {any} */ m) => m.realtimeInput).map((/** @type {any} */ m) => Object.keys(m.realtimeInput)[0]);
    assert.equal(input[0], 'activityStart');
    assert.equal(input.at(-1), 'activityEnd');
    assert.deepEqual((await k.events(['heard'])).map((/** @type {any} */ e) => e.data.text), ['Where should we✂', 'eat tonight']);
  } finally {
    await k.done();
  }
});

test("a drop that can't resume: its model rests, Kokoro is told, and the text model after it finishes the answer through the speech pipeline", async () => {
  const k = await liveKit([{ said: 'Nepenthe is a restaurant high on the cliffs, and it has been there since 1949, with a view south along the coast.', audio: tone(5) }], {
    pace: 1,
    koe: { talk: { rules: [{ match: 'the live session dropped', reply: { toolCalls: [{ name: 'speak', input: { text: 'Sorry, we got cut off: it has a view south along the coast.' } }, { name: 'sleep', input: {} }] } }] } },
  });
  try {
    k.platform.streamSpeed = 1;
    await k.voice.unlock();
    k.agent.send('What is Nepenthe?');
    await until(() => k.agent.live.view.name === 'speaking');
    await new Promise((r) => setTimeout(r, 500));
    await k.server.stop(); // gone: no resuming
    await soon(async () => (await k.events(['out.speak'])).length === 2, 5000);
    await k.agent.idle();
    const said = (await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.text.replace(/^(.{12}).*✂$/, '$1…✂'), Boolean(e.data.live), Boolean(e.data.voice)]);
    assert.deepEqual(said, [['Nepenthe is …✂', true, true], ['Sorry, we got cut off: it has a view south along the coast.', false, true]]);
    assert.ok(k.platform.log.includes('play m-say:Sorry, we got cut off: it has a view south along the coast.'), 'through the speech pipeline');
    assert.match(JSON.stringify(k.sent['model-koet'][0].messages), /\[annai\] \\"the live session dropped while you were answering; finish briefly\\"/);
    assert.ok((await k.events(['halves'])).some((/** @type {any} */ e) => e.data.state === 'live-dropped'));
    assert.equal(k.agent.koeState, 'text');
    assert.ok(k.llm.bench.until('m-live') > Date.now(), 'the live model rests');
  } finally {
    await k.done();
  }
});

test("a drop that can't resume, with no model after it: Koe is down, and Kokoro finishes the answer", async () => {
  const k = await liveKit([{ said: 'The drive to Carmel takes about an hour along the coast road, with views all the way.', audio: tone(5) }], {
    pace: 1,
    kokoro: [{ rules: [{ match: "Koe can't speak", reply: { toolCalls: [{ name: 'speak', input: { text: 'We lost the line: about an hour.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }],
  });
  try {
    k.platform.streamSpeed = 1;
    await k.voice.unlock();
    k.agent.send('How far is Carmel?');
    await until(() => k.agent.live.view.name === 'speaking');
    await new Promise((r) => setTimeout(r, 400));
    await k.server.stop();
    await soon(async () => (await k.events(['out.speak'])).some((/** @type {any} */ e) => e.data.half === 'kokoro'), 5000);
    await k.agent.idle();
    assert.equal(k.agent.koeState, 'down');
    const states = (await k.events(['halves'])).map((/** @type {any} */ e) => e.data.state);
    assert.ok(states.includes('live-dropped') && states.includes('koe-down'), states.join());
  } finally {
    await k.done();
  }
});
