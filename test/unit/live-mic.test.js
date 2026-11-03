// Live mic listening (the drive-test follow-ups design, section 6): event wakes listen briefly, only exchanges keep her listening,
// non-stop sound wakes Kokoro (who decides), urgent notes are said whole, and live Koe's sleep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './agent-kit.js';
import { liveKit, texts, soon, tone, say, sleep, lives } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const RATE = 16_000;
/** The wakes Kokoro got with a reason of annai's that matches. @param {any} k @param {RegExp} re */
const kokoroWakes = async (k, re) => (await k.events(['wake'])).filter((/** @type {any} */ e) => (e.data.reasons ?? []).some((/** @type {any} */ w) => re.test(String(w.text ?? ''))));
/** Feeds sound in real time, a tenth of a second at a time, until stop() says so. @param {any} k @param {() => boolean} stop */
async function feedWhile(k, stop, amp = 0.1) {
  if (k.platform.mic.isOpen()) k.platform.mic.feed(quiet(0.3), RATE); // the room first: the detector learns its floor
  while (!stop()) {
    if (k.platform.mic.isOpen()) k.platform.mic.feed(hum(0.1, amp), RATE);
    await wait(20);
  }
}

/** Sound with no gap in it (music, talk radio), fed 5 times faster than it plays, until stop() says so. @param {any} k @param {() => boolean} stop */
async function feedOn(k, stop) {
  if (k.platform.mic.isOpen()) k.platform.mic.feed(quiet(0.3), RATE);
  const pcm = hum(120);
  for (let i = 0; i < pcm.length && !stop(); i += 1600) {
    if (k.platform.mic.isOpen()) k.platform.mic.feed(pcm.subarray(i, i + 1600), RATE);
    await wait(20);
  }
}

test('a user turn beginning after the quiet spell ran out on one wakes Kokoro once with what was heard; nothing closes by itself', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  // Every turn heard is dismissed (an empty turn of hers): music, not the user.
  const k = await liveKit([{ heard: 'la la la', delayMs: 500 }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 100 } }); // 1 s here
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done); // sound that never stops: the spell runs out in the first turn, and a second begins at its cap
    try {
      await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1, 8000);
      await wait(1500); // more of it: the same stretch
    } finally {
      done = true;
      await feeding;
    }
    const wakes = await kokoroWakes(k, /non-stop sound/);
    assert.equal(wakes.length, 1, 'once for the stretch');
    assert.equal(k.agent.live.state, 'open', 'annai closes nothing on it');
    assert.equal((await lives(k, 'closed')).length, 0);
  } finally {
    await k.done();
  }
});

test("Kokoro's note telling Koe to sleep, on non-stop sound, has live Koe call sleep: the session closes like a tap (sleep)", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  // The turns heard are let go; the note is answered with sleep.
  const k = await liveKit([{ heard: 'la la', delayMs: 500 }, { heard: 'la la', delayMs: 500 }, { heard: 'la' }, { tool: { name: 'sleep', args: {} } }], {
    kokoro: [{ rules: [{ match: 'non-stop sound', reply: { toolCalls: [{ name: 'tell_koe', input: { text: 'Only music is playing: go to sleep.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }],
  });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 100 } });
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done);
    try {
      // The note comes during the turn after the one let go, and waits for that turn to be let go too (it may be the user): a cap later.
      await until(() => k.agent.live.state === 'closed', 12_000);
    } finally {
      done = true;
      await feeding;
    }
    assert.ok(texts(k).some((x) => /go to sleep/.test(x)), 'the note went to Koe');
    await soon(async () => (await lives(k, 'closed')).length === 1);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'sleep');
    assert.equal(k.agent.live.listening, false);
    assert.equal(k.platform.mic.isOpen(), false, 'the microphone is off');
  } finally {
    await k.done();
  }
});

test("live Koe has sleep, described for the live session; the user asking her to sleep closes it after she has said so", async () => {
  const k = await liveKit([{ heard: 'Go to sleep.', said: 'Good night.', audio: tone(0.2), tool: { name: 'sleep', args: {} } }]);
  try {
    const sleepTool = (await k.agent.koe.liveTools()).find((/** @type {any} */ t) => t.name === 'sleep');
    assert.ok(sleepTool, 'live Koe has sleep');
    assert.match(sleepTool.description, /only when the user asks you to sleep or stop listening, or a note from Kokoro tells you to/i);
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await say(k, 'where-eat');
    await until(() => k.agent.live.state === 'closed', 5000);
    const out = await k.events(['out.speak']);
    assert.equal(out.length, 1);
    assert.equal(out[0].data.cut, undefined, 'said whole before it closed');
    await soon(async () => (await lives(k, 'closed')).length === 1);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'sleep');
  } finally {
    await k.done();
  }
});

test("a trigger's session listens only briefly: a heard turn she dismisses doesn't hold it or clear that", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ said: 'The sun sets in half an hour.', audio: tone(0.1) }, { heard: 'mm' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } }); // 3 s spell, 400 ms answer window
    await k.voice.unlock();
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes' });
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await until(() => k.agent.live.listening, 3000);
    // Sound that keeps the detector busy (and a turn she lets go) for longer than the window: it still closes long before the spell.
    const t0 = Date.now();
    let done = false;
    const feeding = feedWhile(k, () => done || k.agent.live.state === 'closed');
    await until(() => k.agent.live.state === 'closed', 2500).finally(() => { done = true; });
    await feeding;
    assert.ok(Date.now() - t0 < 2500, `closed after ${Date.now() - t0} ms`);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'quiet');
  } finally {
    await k.done();
  }
});

test('a heard turn she answers with words clears the brief window: the quiet spell holds after it', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ said: 'The sun sets in half an hour.', audio: tone(0.1) }, { heard: 'where should we eat', said: 'Tacos ahead.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k.voice.unlock();
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes' });
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await until(() => k.agent.live.listening, 3000);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['out.speak'])).length === 2);
    await wait(1000); // past the 400 ms window, inside the 3 s spell
    assert.equal(k.agent.live.state, 'open');
  } finally {
    await k.done();
  }
});

test('a heard turn she answers with a card alone (show, no words) clears the brief window too (review S3)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ said: 'The sun sets in half an hour.', audio: tone(0.1) }, { heard: 'save a note', tool: { name: 'show', args: { card: { title: 'Tacos' } } } }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k.voice.unlock();
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes' });
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await until(() => k.agent.live.listening, 3000);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['heard'])).length === 1);
    await wait(1000); // past the 400 ms window, inside the 3 s spell
    assert.equal(k.agent.live.state, 'open');
  } finally {
    await k.done();
  }
});

test('an urgent note (immediate) is said whole while the detector reports speech; it opens a closed session listening briefly', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'la la' }, { said: 'Turn left in two hundred meters.', audio: tone(0.6) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k.voice.unlock();
    // In the car, where speaking cuts her off (full duplex), her voice playing in real time: sound over it is heard.
    k.voice.route = async () => 'car';
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedWhile(k, () => done); // music, never stopping: a user turn is going on
    try {
      await until(() => k.agent.live.view.name === 'hearing', 3000).catch((e) => { throw new Error(`${e.message}: ${k.agent.live.view.name}`); });
      await k.agent.live.note('Say now: turn left in 200 m.', 'immediate');
      await soon(async () => (await k.events(['out.speak'])).length === 1, 5000);
    } finally {
      done = true;
      await feeding;
    }
    const [out] = await k.events(['out.speak']);
    assert.equal(out.data.cut, undefined, 'never cut by the music');
    assert.equal(out.data.voice, true);
  } finally {
    await k.done();
  }
  // Closed, an immediate note opens a session that listens only briefly.
  const k2 = await liveKit([{ said: 'Turn left now.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k2.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k2.voice.unlock();
    const t0 = Date.now();
    await k2.agent.live.note('Say now: turn left.', 'immediate');
    await soon(async () => (await k2.events(['out.speak'])).length === 1);
    await until(() => k2.agent.live.state === 'closed', 2500);
    assert.ok(Date.now() - t0 < 2500, 'the answer window, not the 3 s spell');
  } finally {
    await k2.done();
  }
});

test('a second urgent note cutting the first urgent reply leaves the mark for its own reply: still said whole over the music (review 5)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'la la' }, { said: 'Turn left in two hundred meters.', audio: tone(1.5) }, { said: 'Turn right now.', audio: tone(0.6) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done);
    try {
      await until(() => k.agent.live.view.name === 'hearing', 3000);
      await k.agent.live.note('Say now: turn left in 200 m.', 'immediate');
      await until(() => k.agent.live.view.name === 'speaking', 3000);
      await k.agent.live.note('Say now: turn right.', 'immediate');
      await soon(async () => (await k.events(['out.speak'])).some((e) => /Turn right/.test(JSON.stringify(e))), 6000);
    } finally {
      done = true;
      await feeding;
    }
    const outs = await k.events(['out.speak']);
    const right = outs.find((e) => /Turn right/.test(JSON.stringify(e)));
    assert.equal(right.data.cut, undefined, 'her answer to the second note is not cut by the music');
  } finally {
    await k.done();
  }
});

test('an urgent reply dropped with its connection before a word lets the microphone hear again (review S1)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'la la' }, { said: 'Turn left now.', audio: tone(0.6), delayMs: 4000 }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done);
    try {
      await until(() => k.agent.live.view.name === 'hearing', 3000);
      await k.agent.live.note('Say now: turn left.', 'immediate');
      await wait(400);
      assert.notEqual(k.agent.live.view.name, 'hearing', 'deaf while the urgent answer is awaited');
      k.server.close(1011, 'the server dropped');
      await until(() => k.agent.live.view.name === 'hearing', 5000);
    } finally {
      done = true;
      await feeding;
    }
  } finally {
    await k.done();
  }
});

test('a non-urgent note waits for the user turn going on to end (at most the 15 s cap), then is said', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'la la' }, { said: 'Fuel is low.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    k.platform.mic.feed(cat(quiet(0.3), hum(5)), RATE); // a turn going on
    assert.equal(k.agent.live.view.name, 'hearing');
    const going = k.agent.live.note('Fuel is low.', 'append');
    await wait(200);
    assert.ok(!texts(k).some((x) => /Fuel is low/.test(x)), 'not while the turn goes on');
    k.platform.mic.feed(cat(hum(11), quiet(1)), RATE); // the turn reaches the cap
    await going;
    await soon(async () => texts(k).some((x) => /Fuel is low/.test(x)));
  } finally {
    await k.done();
  }
});

/** Sound fed in real time, a tenth of a second at a time. @param {any} k @param {Int16Array | Float32Array} pcm */
async function realtime(k, pcm) {
  for (let i = 0; i < pcm.length; i += 1600) {
    if (k.platform.mic.isOpen()) k.platform.mic.feed(pcm.subarray(i, i + 1600), RATE);
    await wait(100);
  }
}

for (const music of [true, false]) {
  test(`${music ? 'music, then the user asks' : 'a word as the spell runs out, then the request'}: Koe answers it and Kokoro is not woken for non-stop sound (re-review 1)`, async () => {
    const { updateAppSettings } = await import('../../src/core/settings.js');
    const { clip } = await import('./voice-kit.js');
    const k = await liveKit([
      { heard: music ? 'la la la' : 'Shiori', delayMs: 1500 },
      { heard: 'where should we eat', said: 'Tacos ahead.', audio: tone(0.3) },
    ]);
    try {
      await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 200 } }); // 2 s here
      k.agent.tap();
      await until(() => k.agent.live.listening, 3000);
      await realtime(k, quiet(0.3));
      if (music) {
        await realtime(k, hum(3));
        await realtime(k, quiet(0.8));
      } else {
        await wait(1300);
        await realtime(k, cat(await clip('first-one'), quiet(0.8)));
      }
      await realtime(k, cat(await clip('where-eat'), quiet(1.5)));
      await soon(async () => (await k.events(['out.speak'])).length === 1, 5000);
      await wait(500);
      assert.equal((await kokoroWakes(k, /non-stop sound/)).length, 0, 'the turn after the lapse was answered: no wake for it');
    } finally {
      await k.done();
    }
  });
}

test('non-stop sound: Kokoro is woken once the turn that began after the lapse reaches the cap, with its words, as input Kokoro sees answered or not', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  // Each turn's words stream in as it goes on (heardFirst); her answers would come too late, the next turn begins at once.
  const k = await liveKit([{ heard: 'first words', heardFirst: true, delayMs: 500 }, { heard: 'second words', heardFirst: true, delayMs: 500 }, { heard: 'third words', heardFirst: true, delayMs: 500 }]);
  try {
    /** @type {any[]} */
    const seen = [];
    const enqueue = k.agent.kokoro.enqueue.bind(k.agent.kokoro);
    k.agent.kokoro.enqueue = (/** @type {any} */ w) => { seen.push(w); return enqueue(w); };
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 100 } }); // 1 s here
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done);
    try {
      await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1, 12_000);
    } finally {
      done = true;
      await feeding;
    }
    const [wake] = await kokoroWakes(k, /non-stop sound/);
    const text = wake.data.reasons.map((/** @type {any} */ w) => w.text).join(' ');
    assert.match(text, /second words/, 'the words of the turn let go');
    assert.doesNotMatch(text, /first words/);
    assert.equal(seen.find((w) => /non-stop sound/.test(w.text))?.input, true, 'gathers for the user input, so Kokoro sees the heard line and Koe\'s reaction');
  } finally {
    await k.done();
  }
});

test("Kokoro's sleep note, late, to a session that closed in a gap meanwhile is nothing: it opens no new session (re-review 2)", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  // Talk radio, with dips just over the pause: the lapse runs out in the first turn, the second is let go while the third goes on (Kokoro
  // is woken, taking 3 s), the third is let go in a gap (closed). Her answers to the first come too late: the second begins and cuts it.
  const k = await liveKit([{ heard: 'one', delayMs: 1500 }, { heard: 'two', delayMs: 300 }, { heard: 'three', delayMs: 300 }, { heard: 'four' }], {
    kokoro: [{ rules: [{ match: 'non-stop sound', reply: { delayMs: 3000, toolCalls: [{ name: 'tell_koe', input: { text: 'Only the radio: go to sleep.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }],
  });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 200 } }); // 2 s here
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await realtime(k, quiet(0.3));
    await realtime(k, hum(3));
    await realtime(k, quiet(0.8));
    await realtime(k, hum(1.5));
    await realtime(k, quiet(0.8));
    await realtime(k, hum(1.5));
    await realtime(k, quiet(2));
    await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1, 5000);
    await until(() => k.agent.live.state === 'closed', 8000);
    await wait(4500); // Kokoro's note comes
    await k.agent.idle();
    assert.equal(k.agent.live.state, 'closed', 'a sleep note to a closed session is nothing');
    assert.equal((await lives(k, 'closed')).length, 1, 'one session, closed in the gap: the note opened no other');
  } finally {
    await k.done();
  }
});

test('two urgent notes sent before any answer: the second reply is said whole over the music (re-review 3)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'la la' }, { said: 'Turn left in two hundred meters.', audio: tone(1.5) }, { said: 'Turn right now.', audio: tone(1.5) }, { heard: 'la' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done);
    try {
      await until(() => k.agent.live.view.name === 'hearing', 3000);
      await Promise.all([k.agent.live.note('Say now: turn left in 200 m.', 'immediate'), k.agent.live.note('Say now: turn right.', 'immediate')]);
      await soon(async () => (await k.events(['out.speak'])).some((e) => /Turn right/.test(JSON.stringify(e))), 8000);
    } finally {
      done = true;
      await feeding;
    }
    const right = (await k.events(['out.speak'])).find((e) => /Turn right/.test(JSON.stringify(e)));
    assert.equal(right.data.cut, undefined, 'not cut by the music');
  } finally {
    await k.done();
  }
});

test('an urgent note and an appended one from one Kokoro reply: the urgent is said whole first, the other after it (re-review 3)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'la la' }, { said: 'Turn left in two hundred meters.', audio: tone(1.5) }, { said: 'The exit after is closed.', audio: tone(0.6) }, { heard: 'la' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done);
    try {
      await until(() => k.agent.live.view.name === 'hearing', 3000);
      await Promise.all([k.agent.live.note('Say now: turn left in 200 m.', 'immediate'), k.agent.live.note('Also: the exit after is closed.', 'append')]);
      await soon(async () => (await k.events(['out.speak'])).some((e) => /Turn left/.test(JSON.stringify(e))), 8000);
      await soon(async () => texts(k).some((x) => /exit after/.test(x)), 5000); // the appended one goes in once the urgent one is said
    } finally {
      done = true;
      await feeding;
    }
    const left = (await k.events(['out.speak'])).find((e) => /Turn left/.test(JSON.stringify(e)));
    assert.equal(left.data.cut, undefined, 'the urgent one was said whole');
  } finally {
    await k.done();
  }
});

test("the dismissed run held for a moment when the spell runs out is looked at again: a discarded one doesn't leave the session open for good (review S1)", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'la' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 150 } }); // 1.5 s here
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await realtime(k, quiet(0.3));
    await realtime(k, quiet(1.0));
    // A short click as the spell runs out: a held run, let go as no turn.
    k.platform.mic.feed(hum(0.12, 0.2), RATE);
    await realtime(k, quiet(2));
    await until(() => k.agent.live.state === 'closed', 3000);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'quiet');
  } finally {
    await k.done();
  }
});

/** The text turns the stand-in got, either flavour's. @param {any} k */
const textsIn = (k) => k.server.received().flatMap((/** @type {any} */ m) => (m.clientContent ? texts({ server: { received: () => [m] } })
  : m.type === 'conversation.item.create' ? (m.item?.content ?? []).filter((/** @type {any} */ p) => p.text).map((/** @type {any} */ p) => p.text) : []));
/** The user's turns the stand-in got, either flavour's. @param {any} k */
const turnsIn = (k) => k.server.received().filter((/** @type {any} */ m) => m.type === 'input_audio_buffer.commit' || m.realtimeInput?.activityEnd).length;

for (const [flavour, answer] of /** @type {const} */ ([['gemini', 'nothing'], ['openai', 'nothing'], ['openai', 'already_told'], ['gemini', 'already_told']])) {
  test(`an urgent note answered with ${answer} (${flavour}): the mark ends at its cap (no sound of hers), the note waiting goes in, and the user is heard (re-review 1, fix 4)`, async () => {
    const { updateAppSettings } = await import('../../src/core/settings.js');
    const { clip } = await import('./voice-kit.js');
    const first = answer === 'nothing' ? {} : { tool: { name: 'already_told', args: {} } };
    const k = await liveKit([first, { said: 'Exit closed.', audio: tone(0.3) }, { heard: 'where should we eat', said: 'Tacos ahead.', audio: tone(0.3) }], flavour === 'openai' ? { live: { type: 'openai-realtime' } } : {});
    try {
      await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
      await k.voice.unlock();
      k.agent.tap();
      await until(() => k.agent.live.listening, 3000);
      await realtime(k, quiet(0.3));
      await k.agent.live.note('Say now: turn left.', 'immediate');
      await wait(700);
      k.agent.live.note('Also: exit closed.', 'append');
      await soon(async () => textsIn(k).some((x) => /exit closed/.test(x)), 2000).catch(() => assert.fail('the appended note never went in: the urgent mark held it'));
      await soon(async () => (await k.events(['out.speak'])).some((e) => /Exit closed/.test(JSON.stringify(e))), 3000);
      const before = turnsIn(k);
      await realtime(k, cat(await clip('where-eat'), quiet(1)));
      await soon(async () => turnsIn(k) > before, 2000).catch(() => assert.fail('the user was not heard: the microphone stayed deaf'));
    } finally {
      await k.done();
    }
  });
}

test('talk radio whose dips are shorter than her verdict: a late turn whose answer the next piece cuts before a sound is let go, and Kokoro is woken once (re-review 2, S4)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'and now the news', delayMs: 1500 }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 200 } }); // 2 s here
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await realtime(k, quiet(0.3));
    const t0 = Date.now();
    while (Date.now() - t0 < 9000 && !(await kokoroWakes(k, /non-stop sound/)).length) {
      await realtime(k, hum(1.5));
      await realtime(k, quiet(0.9));
    }
    assert.equal((await kokoroWakes(k, /non-stop sound/)).length, 1, 'Kokoro is woken');
    assert.equal(k.agent.live.state, 'open', 'annai closes nothing on sound');
  } finally {
    await k.done();
  }
});

for (const music of [false, true]) {
  test(`a closed session, ${music ? 'music' : 'quiet'}: an urgent note and an appended one from one Kokoro reply, the urgent goes in first and is said whole (re-review 3)`, async () => {
    const { updateAppSettings } = await import('../../src/core/settings.js');
    const k = await liveKit([{ said: 'Turn left in two hundred meters.', audio: tone(1.5) }, { said: 'The exit after is closed.', audio: tone(0.6) }, { heard: 'la' }]);
    try {
      await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
      await k.voice.unlock();
      k.voice.route = async () => 'car';
      k.platform.streamSpeed = 1;
      let done = false;
      let feeding = Promise.resolve();
      try {
        const both = Promise.all([k.agent.live.note('Say now: turn left in 200 m.', 'immediate'), k.agent.live.note('Also: the exit after is closed.', 'append')]);
        if (music) feeding = (async () => { await until(() => k.platform.mic.isOpen(), 3000); await feedOn(k, () => done); })();
        await both;
        await soon(async () => (await k.events(['out.speak'])).some((e) => /exit after/.test(JSON.stringify(e))), 8000);
      } finally {
        done = true;
        await feeding;
      }
      const order = texts(k);
      const left = order.findIndex((x) => /turn left/.test(x));
      const exit = order.findIndex((x) => /exit after/.test(x));
      assert.ok(left >= 0 && left < exit, `the urgent one first: ${JSON.stringify(order)}`);
      const said = (await k.events(['out.speak'])).find((e) => /Turn left/.test(JSON.stringify(e)));
      assert.ok(said, 'the urgent one was said');
      assert.equal(said.data.cut, undefined, 'whole');
    } finally {
      await k.done();
    }
  });
}

test("a brief session's heard turn answered with a silent tool, then words (tool then words), clears the brief window (S3)", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([
    { said: 'The sun sets in half an hour.', audio: tone(0.1) },
    { heard: 'where should we eat', tool: { name: 'already_told', args: {} }, andThen: true },
    { said: 'Tacos ahead.', audio: tone(0.1) },
  ]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } }); // 3 s spell, 400 ms answer window
    await k.voice.unlock();
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes' });
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await until(() => k.agent.live.listening, 3000);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['out.speak'])).length === 2);
    await wait(1000); // past the 400 ms window, inside the 3 s spell
    assert.equal(k.agent.live.state, 'open', 'her words answered the user: the quiet spell, not the brief window');
  } finally {
    await k.done();
  }
});

for (const end of ['final text', 'tell_koe']) {
  test(`Kokoro woken only for non-stop sound, its turn ending with ${end} and no words for the user, to a closed session: nothing, no session opens (S2)`, async () => {
    const reply = end === 'final text' ? { text: 'Only the radio: nothing to do.' } : { toolCalls: [{ name: 'tell_koe', input: { text: 'Only the radio: go to sleep.' } }, { name: 'sleep', input: {} }] };
    const k = await liveKit([{ said: 'Good night.', audio: tone(0.1) }], { kokoro: [{ rules: [{ match: 'non-stop sound', reply }, { match: '.', reply: sleep }] }] });
    try {
      await k.voice.unlock();
      assert.equal(k.agent.live.state, 'closed');
      k.agent.live.c.noisy?.('la la la');
      await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1);
      await wait(300);
      await k.agent.idle();
      assert.equal(k.agent.live.state, 'closed');
      assert.equal((await lives(k)).length, 0, 'no session opened');
      assert.equal(k.server.received().filter((/** @type {any} */ m) => m.setup).length, 0, 'none connected');
    } finally {
      await k.done();
    }
  });
}

test("Kokoro's turn woken for non-stop sound and a watch together: its note with words for the user still reaches the user, the session closed or not (re-review 4)", async () => {
  const reply = { toolCalls: [{ name: 'tell_koe', input: { text: 'Fuel is low: tell the user.', for_user: 'Fuel is low.' } }, { name: 'sleep', input: {} }] };
  const k = await liveKit([{ said: 'Fuel is low.', audio: tone(0.1) }], { kokoro: [{ rules: [{ match: 'Fuel', reply }, { match: '.', reply: sleep }] }] });
  try {
    await k.voice.unlock();
    k.agent.live.c.noisy?.('la la la');
    k.agent.kokoro.enqueue({ kind: 'cue', text: 'A watch fired: Fuel is low.', logged: true });
    await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1);
    const [wake] = await kokoroWakes(k, /non-stop sound/);
    assert.ok(wake.data.reasons.some((/** @type {any} */ w) => /watch fired/.test(String(w.text))), 'the two wakes went into one turn');
    await soon(async () => texts(k).some((x) => /Fuel is low/.test(x)), 3000);
  } finally {
    await k.done();
  }
});

test("a turn let go after the quiet spell ran out, while the detector holds a run that is then discarded: the session still closes (S1)", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'la', delayMs: 600 }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 150 } }); // 1.5 s here
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await realtime(k, quiet(0.3));
    await realtime(k, hum(2.5)); // the spell runs out in it
    await realtime(k, quiet(1.0));
    k.platform.mic.feed(hum(0.12, 0.2), RATE); // a click, held as her verdict (let go) comes, then discarded
    await realtime(k, quiet(1));
    await until(() => k.agent.live.state === 'closed', 3000);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'quiet');
  } finally {
    await k.done();
  }
});

test('an urgent note over a user turn the provider answers together with the note, as one turn: the microphone hears again once her line has played, before the cap (fix 4, probe i)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  // The music's turn, cut by the note, gets no end of its own: the note's answer is the provider's next turn, and the only one.
  const k = await liveKit([{ silent: true }, { said: 'Turn left now.', audio: tone(0.5) }, { heard: 'la' }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done);
    try {
      await until(() => k.agent.live.view.name === 'hearing', 3000);
      const t0 = Date.now();
      await k.agent.live.note('Say now: turn left.', 'immediate');
      await soon(async () => (await k.events(['out.speak'])).some((e) => /Turn left/.test(JSON.stringify(e))), 3000);
      // The music goes on: heard again as soon as her line has played, not at the 20 s ceiling (2.5 s here).
      await until(() => k.agent.live.view.name === 'hearing', 1500).catch(() => assert.fail('the microphone stayed deaf after her line'));
      assert.ok(Date.now() - t0 < 2300, `heard again ${Date.now() - t0} ms after the note: the ceiling, not her line's end`);
    } finally {
      done = true;
      await feeding;
    }
  } finally {
    await k.done();
  }
});

test('an urgent note while the user is mid-sentence, on a provider that never ends that turn nor answers the note: the microphone is deaf no longer than the cap (fix 4)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ silent: true }, { silent: true }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 40 } });
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    k.agent.live.c.asked = () => true; // Kokoro works on Koe's question: the silence watchdog waits, nothing else ends the wait
    let done = false;
    const feeding = feedOn(k, () => done);
    try {
      await until(() => k.agent.live.view.name === 'hearing', 3000);
      const t0 = Date.now();
      await k.agent.live.note('Say now: turn left.', 'immediate');
      await wait(400);
      assert.notEqual(k.agent.live.view.name, 'hearing', 'deaf while her answer may come');
      await until(() => k.agent.live.view.name === 'hearing', 3000).catch(() => assert.fail('the microphone stayed deaf'));
      assert.ok(Date.now() - t0 < 1800, `heard again ${Date.now() - t0} ms after the note: the 8 s cap is 1 s here`);
    } finally {
      done = true;
      await feeding;
    }
  } finally {
    await k.done();
  }
});

for (const [when, delayMs] of /** @type {const} */ ([['after Koe answered the user', 2500], ['while the user asks', 300]])) {
  test(`Kokoro's sleep note for non-stop sound, coming ${when}: nothing, it never closes the session on the user (fix 4, probe j)`, async () => {
    const { updateAppSettings } = await import('../../src/core/settings.js');
    const { clip } = await import('./voice-kit.js');
    const k = await liveKit([
      { heard: 'la la', delayMs: 1500 },
      { heard: 'la la la', delayMs: 1500 },
      { heard: 'where should we eat', said: 'Tacos ahead, two miles.', audio: tone(0.5) },
      { tool: { name: 'sleep', args: {} } },
    ], { kokoro: [{ rules: [{ match: 'non-stop sound', reply: { delayMs, toolCalls: [{ name: 'tell_koe', input: { text: 'Only music: go to sleep.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }] });
    try {
      await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 200 } }); // 2 s here
      await k.voice.unlock();
      k.agent.tap();
      await until(() => k.agent.live.listening, 3000);
      await realtime(k, quiet(0.3));
      await realtime(k, hum(3));
      await realtime(k, quiet(0.9));
      await realtime(k, hum(1.5));
      await realtime(k, quiet(0.9));
      await realtime(k, cat(await clip('where-eat'), quiet(1.5)));
      await soon(async () => (await k.events(['out.speak'])).some((e) => /Tacos/.test(JSON.stringify(e))), 5000);
      assert.equal((await kokoroWakes(k, /non-stop sound/)).length, 1, 'Kokoro was woken for the music');
      await wait(Math.max(0, delayMs - 1000) + 1000);
      await k.agent.idle();
      assert.ok(!texts(k).some((x) => /go to sleep/.test(x)), `the stale sleep note never went in: ${JSON.stringify(texts(k))}`);
      assert.ok(!(await lives(k, 'closed')).some((e) => e.data.why === 'sleep'), 'no sleep closed it (the quiet spell may)');
    } finally {
      await k.done();
    }
  });
}

test('a late turn let go while the quiet spell must look again (Kokoro works on a question): Kokoro is still woken for the non-stop sound (fix 4, Step)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ heard: 'la la', delayMs: 1500 }, { heard: 'la la la', delayMs: 200 }]);
  const asked = k.agent.live.c.asked;
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 200 } }); // 2 s here
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await realtime(k, quiet(0.3));
    await realtime(k, hum(3)); // the spell runs out in it
    k.agent.live.c.asked = () => true; // from now on, the spell's end re-arms it
    await realtime(k, quiet(0.9));
    await realtime(k, hum(1.5)); // begun after the lapse, let go
    await realtime(k, quiet(1));
    await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1, 2000).catch(() => assert.fail('Kokoro was not woken'));
    assert.equal(k.agent.live.state, 'open');
  } finally {
    k.agent.live.c.asked = asked;
    await k.done();
  }
});

test("Kokoro's turn woken by a watch that the non-stop line joins: its note with no words for the user goes as ever, the session closed (fix 4, Step)", async () => {
  const k = await liveKit([{ said: 'The museum closes at five.', audio: tone(0.1) }], {
    // Its next step, after the non-stop line joined, answers both: a note with no words for the user.
    kokoro: [{ rules: [{ match: 'watch fired', reply: { delayMs: 600, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] } },
      { match: 'non-stop sound', reply: { toolCalls: [{ name: 'tell_koe', input: { text: 'The museum closes at five: mention it.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }],
  });
  try {
    await k.voice.unlock();
    k.agent.kokoro.enqueue({ kind: 'cue', text: 'A watch fired: the museum closes at five.', logged: true });
    await until(() => k.agent.kokoro.busy, 2000);
    await wait(100);
    k.agent.live.c.noisy?.('la la la'); // joins the turn running
    await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1, 3000);
    const [joined] = await kokoroWakes(k, /non-stop sound/);
    assert.equal(joined.data.meanwhile, true, 'it joined the watch\'s turn');
    await soon(async () => texts(k).some((x) => /museum closes/.test(x)), 4000).catch(() => assert.fail('the watch\'s note was dropped as the non-stop line\'s'));
  } finally {
    await k.done();
  }
});
