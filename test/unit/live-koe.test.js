// K5: what a live Koe hears and says, its tools, typing to it, and its drops (plan K5, Tasks 3, 4, 6 and 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './agent-kit.js';
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
