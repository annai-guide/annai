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
  // Her verdict on the third comes after the note's wait: let go sooner, with the spell run out and the mic between frames on a starved CPU, the session closes on quiet first.
  const k = await liveKit([{ heard: 'la la', delayMs: 500 }, { heard: 'la la', delayMs: 500 }, { heard: 'la', delayMs: 8000 }], {
    server: { onText: { match: /go to sleep/, turn: { tool: { name: 'sleep', args: {} } } } },
    agent: { secondMs: 250 }, // the waits for her answers: at the kit's 125 ms a second, a starved CPU's answer comes after "she didn't answer"
    kokoro: [{ rules: [{ match: 'non-stop sound', reply: { toolCalls: [{ name: 'tell_koe', input: { text: 'Only music is playing: go to sleep.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }],
  });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 10 } }); // 2.5 s here: it runs out inside a first turn's 15 s of sound
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done);
    try {
      // The note comes during the turn after the one let go, whose verdict is late (8 s): it waits for that, up to its bounds, then goes in.
      await until(() => k.agent.live.state === 'closed', 100_000);
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
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40; // 3 s spell, 400 ms answer window
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
    await soon(async () => (await lives(k, 'closed')).length === 1); // the state turns closed a moment before its entry is written
    assert.equal((await lives(k, 'closed'))[0].data.why, 'quiet');
  } finally {
    await k.done();
  }
});

test('a heard turn she answers with words clears the brief window: the quiet spell holds after it', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ said: 'The sun sets in half an hour.', audio: tone(0.1) }, { heard: 'where should we eat', said: 'Tacos ahead.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40;
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
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40;
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
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40;
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
    await updateAppSettings(k2.ws, { voice: { closeAfterSeconds: 300 } });
    k2.agent.live.answerSeconds = 40;
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
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40;
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
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40;
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
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40;
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
      await soon(async () => (await k.events(['out.speak'])).some((e) => /Turn right/.test(JSON.stringify(e))));
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
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40;
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
      await soon(async () => (await k.events(['out.speak'])).some((e) => /Turn left/.test(JSON.stringify(e))));
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
    await soon(async () => (await lives(k, 'closed')).length === 1, 3000);
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
      await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
      k.agent.live.answerSeconds = 40;
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
      await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
      k.agent.live.answerSeconds = 40;
      await k.voice.unlock();
      k.voice.route = async () => 'car';
      k.platform.streamSpeed = 1;
      let done = false;
      let feeding = Promise.resolve();
      try {
        const both = Promise.all([k.agent.live.note('Say now: turn left in 200 m.', 'immediate'), k.agent.live.note('Also: the exit after is closed.', 'append')]);
        if (music) feeding = (async () => { await until(() => k.platform.mic.isOpen(), 3000); await feedOn(k, () => done); })();
        await both;
        await soon(async () => (await k.events(['out.speak'])).some((e) => /exit after/.test(JSON.stringify(e))));
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
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40; // 3 s spell, 400 ms answer window
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
    await soon(async () => (await lives(k, 'closed')).length === 1, 3000);
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
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40;
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
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40;
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
      await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1).catch(() => assert.fail('Kokoro was not woken once for the music'));
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

// Re-review 5: the user's question joins Kokoro's turn woken for non-stop sound; its answer is the user's, never dropped as the stretch's.
for (const [how, reply] of /** @type {[string, any][]} */ ([
  ['final text', { text: 'The museum opens at nine tomorrow.' }],
  ['tell_koe with no for_user', { toolCalls: [{ name: 'tell_koe', input: { text: 'The museum opens at nine tomorrow.' } }, { name: 'sleep', input: {} }] }],
])) {
  test(`Koe's question joins Kokoro's turn for non-stop sound: its answer by ${how} reaches Koe (re-review 5)`, async () => {
    const { updateAppSettings } = await import('../../src/core/settings.js');
    const { clip } = await import('./voice-kit.js');
    const k = await liveKit([
      { heard: 'la la', delayMs: 1500 },
      { heard: 'la la la', delayMs: 1500 },
      { heard: 'where should we eat', tool: { name: 'tell_kokoro', args: { text: 'Is the museum open tomorrow? The user asks.' } } },
      { said: 'It opens at nine.', audio: tone(0.5) },
    ], { kokoro: [{ rules: [
      { match: 'non-stop sound', reply: { delayMs: 3500, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, then: { toolCalls: [{ name: 'sleep', input: {} }] } },
      { match: 'museum', reply },
      { match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } },
    ] }] });
    try {
      await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } }); // 3 s here
      await k.voice.unlock();
      k.agent.tap();
      await until(() => k.agent.live.listening, 3000);
      await realtime(k, quiet(0.3));
      await realtime(k, hum(4));
      await realtime(k, quiet(0.9));
      await realtime(k, hum(1.5));
      await realtime(k, quiet(0.9));
      await realtime(k, cat(await clip('where-eat'), quiet(1.5)));
      await until(() => texts(k).some((x) => x.includes('The museum opens at nine tomorrow.')), 8000);
    } finally {
      await k.done();
    }
  });
}

// Urgent watches (the drive-test design, section 7): an urgent watch's alert goes into the live session as an urgent note does.
const FIRED = { kind: /** @type {const} */ ('trigger'), text: 'Your watch w-1 (at 10:00) fired. Its reminder: "Turn left at the next exit."', fallbacks: [{ watch: 'w-1', text: 'Turn left at the next exit.' }] };
const ALERT = /Turn left at the next exit/;

for (const urgent of [true, false]) {
  test(`${urgent ? 'an urgent' : 'a plain'} watch firing while music holds a user turn: ${urgent ? 'said at once and whole, the microphone deaf until it is' : 'waits for the turn to end, as today'} (section 7)`, async () => {
    const { updateAppSettings } = await import('../../src/core/settings.js');
    const k = await liveKit([{ heard: 'la la' }, { said: 'Turn left at the next exit.', audio: tone(0.6) }]);
    try {
      await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
      k.agent.live.answerSeconds = 40;
      await k.voice.unlock();
      k.voice.route = async () => 'car'; // where speaking cuts her off (full duplex)
      k.platform.streamSpeed = 1;
      k.agent.tap();
      await until(() => k.agent.live.listening, 3000);
      k.platform.mic.feed(cat(quiet(0.3), hum(5)), RATE); // music: a user turn going on
      assert.equal(k.agent.live.view.name, 'hearing');
      await k.agent.wake({ ...FIRED, ...(urgent ? { urgent: true } : {}) });
      if (!urgent) {
        await wait(500);
        assert.ok(!texts(k).some((x) => ALERT.test(x)), 'not while the turn goes on');
        k.platform.mic.feed(cat(hum(11), quiet(1)), RATE); // the turn reaches the cap
        await soon(async () => texts(k).some((x) => ALERT.test(x)), 3000);
        return;
      }
      await soon(async () => texts(k).some((x) => ALERT.test(x)), 1000);
      assert.ok(texts(k).some((x) => x.startsWith('[annai] ') && ALERT.test(x)), "in a trigger's words, not a note's");
      let done = false;
      const feeding = feedWhile(k, () => done); // the music goes on while she says it
      try {
        await until(() => k.agent.live.view.name === 'speaking', 3000);
        await soon(async () => (await k.events(['out.speak'])).length === 1, 5000);
      } finally {
        done = true;
        await feeding;
      }
      const [out] = await k.events(['out.speak']);
      assert.equal(out.data.cut, undefined, 'never cut by the music');
      assert.equal(out.data.voice, true);
      assert.deepEqual(await k.events(['reminder']), [], 'said by her, not by annai too');
    } finally {
      await k.done();
    }
  });
}

test('an urgent watch firing with no live session (Koe in text) is answered as a plain one is (section 7)', async () => {
  const { agentKit } = await import('./agent-kit.js');
  const run = async (/** @type {boolean} */ urgent) => {
    const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { koe: { talk: [{ toolCalls: [{ name: 'speak', input: { text: 'Turn left at the next exit.' } }, { name: 'sleep', input: {} }] }] } });
    await k.agent.idle();
    assert.equal(k.agent.koeState, 'text');
    await k.agent.wake({ ...FIRED, ...(urgent ? { urgent: true } : {}) });
    await k.agent.idle();
    const koe = k.sent['model-koet'].map((/** @type {any} */ r) => JSON.stringify(r.messages ?? r).replace(/\b[wct]-[a-z0-9]+|\d{4}-\d\d-\d\dT[\d:.]+Z|scripted_\d+_\d+/g, 'ID'));
    assert.ok(koe.some((x) => ALERT.test(x)), 'Koe got it');
    return { koe, events: (await k.events()).map((e) => e.type) };
  };
  assert.deepEqual(await run(true), await run(false));
});

// Fix pass 5, 1: Kokoro's sleep note came during a music turn; the user's question began before that turn's verdict. The note waits for
// the question's verdict too: answered, it is dropped, never put in right after the user spoke.
// late: that turn's verdict comes as the question goes on (a verdict that marks only its own turn, never the question).
for (const late of [false, true]) {
  test(`Kokoro's sleep note during a music turn the user's question begins before its verdict${late ? ', which comes during the question' : ''}: nothing, it waits for the question's verdict (fix 5)`, async () => {
    const { updateAppSettings } = await import('../../src/core/settings.js');
    const { clip } = await import('./voice-kit.js');
    const k = await liveKit([
      { heard: 'la la', delayMs: 1500 },
      { heard: 'la la la', delayMs: 1500 },
      { heard: 'la la la la', delayMs: 1500, ...(late ? { interruptOn: /** @type {const} */ ('text') } : {}) },
      { heard: 'where should we eat', said: 'Tacos ahead, two miles.', audio: tone(0.5), delayMs: 600 },
      { tool: { name: 'sleep', args: {} } },
    ], { kokoro: [{ rules: [{ match: 'non-stop sound', reply: { delayMs: 300, toolCalls: [{ name: 'tell_koe', input: { text: 'Only music: go to sleep.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }] });
    try {
      await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 200 } }); // 2 s here
      await k.voice.unlock();
      k.agent.tap();
      await until(() => k.agent.live.listening, 3000);
      await realtime(k, quiet(0.3));
      await realtime(k, hum(3)); // the spell runs out in it
      await realtime(k, quiet(0.9));
      await realtime(k, hum(1.5)); // begun after the lapse; let go as the next begins: Kokoro is woken
      await realtime(k, quiet(0.9));
      await realtime(k, hum(1.5)); // the sleep note comes during this one; the question begins before its verdict
      await realtime(k, quiet(0.9));
      await realtime(k, cat(await clip('where-eat'), quiet(2)));
      await soon(async () => (await k.events(['out.speak'])).some((e) => /Tacos/.test(JSON.stringify(e))), 5000);
      await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1).catch(() => assert.fail('Kokoro was not woken once for the music'));
      await wait(500);
      await k.agent.idle();
      assert.ok(!texts(k).some((x) => /go to sleep/.test(x)), `the sleep note never went in: ${JSON.stringify(texts(k))}`);
      assert.ok(!(await lives(k, 'closed')).some((e) => e.data.why === 'sleep'), 'no sleep closed it');
    } finally {
      await k.done();
    }
  });
}

// Fix pass 5, 2: the user's own input (typed, a choice tapped) joining Kokoro's turn woken for non-stop sound makes it a turn of its own.
for (const [how, o] of /** @type {[string, any][]} */ ([['typed', {}], ['a choice tapped', { chose: true }]])) {
  test(`the user's message (${how}) joins Kokoro's turn for non-stop sound: its answer by final text reaches Koe (fix 5)`, async () => {
    const k = await liveKit([{ said: 'Let me check.', audio: tone(0.1) }, { said: 'It opens at nine.', audio: tone(0.1) }], {
      kokoro: [{ rules: [
        { match: 'non-stop sound', reply: { delayMs: 1500, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] } },
        { match: 'the user wrote', reply: { text: 'The museum opens at nine tomorrow.' } },
        { match: '.', reply: sleep },
      ] }],
    });
    try {
      await k.voice.unlock();
      k.agent.live.c.noisy?.('la la la');
      await until(() => k.agent.kokoro.busy, 2000);
      await wait(200);
      k.agent.send('Is the museum open tomorrow?', o);
      await soon(async () => texts(k).some((x) => x.includes('The museum opens at nine tomorrow.')), 6000).catch(() => assert.fail(`the answer was dropped as the stretch's: ${JSON.stringify(texts(k))}`));
    } finally {
      await k.done();
    }
  });
}

// Fix pass 5, 3: her answer to an urgent note in two parts (Gemini goes on by itself): the music never cuts the second.
test('an urgent note answered in two turns, the second with no word yet as the first ends: the second is said whole over the music too (fix 5)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  // In real time (pace 1): the second turn's sound comes over 1.2 s, its first word 0.9 s in, after the first has played out.
  const k = await liveKit([{ heard: 'la la' }, { said: 'Turn left now.', audio: tone(0.3), andThen: true }, { said: 'Then keep right for the bridge.', audio: tone(1.2), saidAt: 900 }], { pace: 1 });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40;
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done);
    try {
      await until(() => k.agent.live.view.name === 'hearing', 3000);
      await k.agent.live.note('Say now: turn left, then keep right.', 'immediate');
      await soon(async () => (await k.events(['out.speak'])).some((e) => /keep right/.test(JSON.stringify(e))));
    } finally {
      done = true;
      await feeding;
    }
    const outs = await k.events(['out.speak']);
    const second = outs.find((e) => /keep right/.test(JSON.stringify(e)));
    assert.equal(second.data.cut, undefined, `the second part is not cut by the music: ${JSON.stringify(outs.map((e) => e.data))}`);
  } finally {
    await k.done();
  }
});

// Fix pass 5, 3: her first part calls a tool she speaks after: the microphone stays deaf until the part after it has played.
test('an urgent note answered with words and a tool she speaks after: the microphone stays deaf between the parts, and the second is said whole (fix 5)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([
    { heard: 'la la' },
    { said: 'Turn left now.', audio: tone(0.3), tool: { name: 'list', args: { path: '/trip/' } }, andThen: true },
    { said: 'Then keep right for the bridge.', audio: tone(0.6), delayMs: 1500 },
  ], { pace: 1 });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300 } });
    k.agent.live.answerSeconds = 40;
    await k.voice.unlock();
    k.voice.route = async () => 'car';
    k.platform.streamSpeed = 1;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done);
    try {
      await until(() => k.agent.live.view.name === 'hearing', 3000);
      await k.agent.live.note('Say now: turn left, then keep right.', 'immediate');
      await soon(async () => (await k.events(['out.speak'])).some((e) => /Turn left/.test(JSON.stringify(e))), 5000);
      await wait(300);
      assert.notEqual(k.agent.live.view.name, 'hearing', 'deaf while the rest of her answer is to come');
      await soon(async () => (await k.events(['out.speak'])).some((e) => /keep right/.test(JSON.stringify(e))), 6000);
    } finally {
      done = true;
      await feeding;
    }
    const second = (await k.events(['out.speak'])).find((e) => /keep right/.test(JSON.stringify(e)));
    assert.equal(second.data.cut, undefined, 'the second part is not cut by the music');
  } finally {
    await k.done();
  }
});

// Fix pass 5, 4: an open that fails for an urgent note leaves no mark: what waits still goes in, and the microphone hears.
test('an urgent note whose session fails to open leaves no mark behind: the next note still goes in (fix 5)', async () => {
  const k = await liveKit([{ said: 'Noted.', audio: tone(0.1) }]);
  const budgets = k.agent.live.c.budgets;
  try {
    await k.voice.unlock();
    k.agent.live.c.budgets = () => Promise.reject(new Error('the settings could not be read'));
    await assert.rejects(k.agent.live.note('Say now: turn left.', 'immediate'));
    k.agent.live.c.budgets = budgets;
    await k.agent.live.note('The museum closes at five.', 'append');
    await soon(async () => texts(k).some((x) => /museum closes/.test(x)), 3000).catch(() => assert.fail('the note waited behind a mark left from the failed open'));
  } finally {
    k.agent.live.c.budgets = budgets;
    await k.done();
  }
});

// Fix pass 5, 5: a session closing while the microphone opens for an urgent note: the note is handed on, never put into the next session.
test('an urgent note whose session closes while its microphone opens is handed on, never said in the next session (fix 5)', async () => {
  const k = await liveKit([{ said: 'Noted.', audio: tone(0.1) }]);
  try {
    await k.voice.unlock();
    assert.equal(await k.agent.live.open('shown'), true);
    assert.equal(k.agent.live.listening, false);
    const p = k.agent.live.note('Say now: turn left.', 'immediate');
    k.agent.live.close('tap');
    assert.equal(await p, false, 'no session took it: Halves hands it on');
    assert.equal(await k.agent.live.open('shown'), true);
    await wait(300);
    assert.ok(!texts(k).some((x) => /turn left/.test(x)), `not said in the next session: ${JSON.stringify(texts(k))}`);
  } finally {
    await k.done();
  }
});

// Fix pass 6: the stretch's note waits for the user's turn's verdict at most about 3 s after that turn ends, then goes in on the urgent
// path, so a turn that follows can neither hold it for good nor cut her sleep call.
const SLEEP_NOTE = { kokoro: [{ rules: [{ match: 'non-stop sound', reply: { toolCalls: [{ name: 'tell_koe', input: { text: 'Only the radio: go to sleep.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }] };
/** When the sleep note went in, and when Kokoro sent it. @param {any} k */
const sleepNote = async (k) => (await k.events(['note'])).find((/** @type {any} */ e) => e.data.from === 'kokoro')?.at;

test('talk radio whose pauses are just over the pause setting, every verdict landing in the next piece: the sleep note goes in within the bound, and she sleeps (fix 6, probe h3)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  // Every answer (a sleep call) waits past the next piece's start however slow the CPU, so it cuts it before it begins; the note's
  // answer, the microphone deaf, comes at once and is not cut.
  const k = await liveKit([{ heard: 'and now the news', heardFirst: true, tool: { name: 'sleep', args: {} }, delayMs: 8000 }], { ...SLEEP_NOTE, server: { onText: { match: /go to sleep/, turn: { tool: { name: 'sleep', args: {} } } } } });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 200 } }); // 2 s here
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = (async () => {
      await realtime(k, quiet(0.3));
      while (!done && k.agent.live.state !== 'closed') {
        await realtime(k, hum(2));
        await realtime(k, quiet(0.9));
      }
    })();
    /** @type {number | undefined} */
    let inAt;
    try {
      await soon(async () => texts(k).some((x) => /go to sleep/.test(x)), 100_000).catch(() => assert.fail('the sleep note never went in'));
      inAt = Date.now();
      await until(() => k.agent.live.state === 'closed', 60_000);
    } finally {
      done = true;
      await feeding;
    }
    const sent = await sleepNote(k);
    // The note waits for the turn going on as it came (2 s of radio at most), at most about 3 s, and then the next piece, going on at
    // that bound, is given its own wait (fix 7): one piece later.
    assert.ok(sent && inAt - sent < 10_000, `went in ${inAt - sent} ms after Kokoro sent it`);
    assert.equal((await kokoroWakes(k, /non-stop sound/)).length, 1, 'Kokoro was woken once');
    assert.deepEqual((await lives(k, 'closed')).map((e) => e.data.why), ['sleep'], 'she slept');
  } finally {
    await k.done();
  }
});

test('steady music, every turn running to the cap and her answers cut by the next: the sleep note goes in and she sleeps, once (fix 6, probe n2)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  // Each answer waits long enough to be cut by the next turn however slow the CPU; the note's comes at once, as the sleep note's first test.
  const k = await liveKit([{ tool: { name: 'sleep', args: {} }, delayMs: 8000 }], { ...SLEEP_NOTE, agent: { secondMs: 250 }, server: { onText: { match: /go to sleep/, turn: { tool: { name: 'sleep', args: {} } } } } });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 10 } }); // 2.5 s here
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    let done = false;
    const feeding = feedOn(k, () => done || k.agent.live.state === 'closed');
    try {
      await until(() => k.agent.live.state === 'closed', 100_000).catch(() => assert.fail(`she never slept: ${JSON.stringify(texts(k))}`));
    } finally {
      done = true;
      await feeding;
    }
    assert.equal(texts(k).filter((x) => /go to sleep/.test(x)).length, 1, 'the note went in once');
    assert.equal((await kokoroWakes(k, /non-stop sound/)).length, 1, 'Kokoro was woken once');
    await soon(async () => (await lives(k, 'closed')).length === 1); // written just after it closes
    assert.deepEqual((await lives(k, 'closed')).map((e) => e.data.why), ['sleep']);
  } finally {
    await k.done();
  }
});

test("the sleep note waiting on the user's question, which Koe answers by asking Kokoro alone: nothing, the user is in it (fix 6)", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const { clip } = await import('./voice-kit.js');
  const k = await liveKit([
    { heard: 'la la', delayMs: 1500 },
    { heard: 'la la la', delayMs: 1500 },
    { heard: 'is the museum open tomorrow', tool: { name: 'tell_kokoro', args: { text: 'Is the museum open tomorrow? The user asks.' } } },
    { said: 'It opens at nine.', audio: tone(0.5) },
    { tool: { name: 'sleep', args: {} } },
  ], { kokoro: [{ rules: [
    { match: 'non-stop sound', reply: { delayMs: 300, toolCalls: [{ name: 'tell_koe', input: { text: 'Only music: go to sleep.' } }, { name: 'sleep', input: {} }] } },
    { match: 'museum', reply: { delayMs: 5000, toolCalls: [{ name: 'tell_koe', input: { text: 'It opens at nine.', for_user: 'It opens at nine.' } }, { name: 'sleep', input: {} }] } },
    { match: '.', reply: sleep },
  ] }] });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 200 } }); // 2 s here
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await realtime(k, quiet(0.3));
    await realtime(k, hum(3));
    await realtime(k, quiet(0.9));
    await realtime(k, hum(1.5)); // let go as the question begins: Kokoro is woken, its note comes while the user asks
    await realtime(k, quiet(0.9));
    await realtime(k, cat(await clip('where-eat'), quiet(1.5)));
    await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1).catch(() => assert.fail('Kokoro was not woken once for the music'));
    await wait(4000); // past the bound, Kokoro still working on the question
    assert.ok(!texts(k).some((x) => /go to sleep/.test(x)), `the sleep note never went in: ${JSON.stringify(texts(k))}`);
    assert.ok(!(await lives(k, 'closed')).some((e) => e.data.why === 'sleep'), 'no sleep closed it');
  } finally {
    await k.done();
  }
});

// Fix pass 7, 1: the sleep note came during a music turn; the user's question begins 0.3 s after that turn ends. At the bound the
// question is never cut (still going on: c2), nor pre-empted (ended, her verdict not yet in: c5): it gets its own wait for her verdict.
// Her verdicts come ms after a turn ends (the silence watchdog, 8 of the session's seconds, later still).
for (const [name, clips, ms] of /** @type {[string, string[], number][]} */ ([
  ['a 3.5 s question still going on at the bound (probe c2)', ['gas-station', 'where-lunch'], 1000],
  ['a short question whose answer comes after the bound (probe c5)', ['where-eat'], 1400],
])) {
  test(`Kokoro's sleep note during music, ${name}: Koe answers it and the note is dropped (fix 7)`, async () => {
    const { updateAppSettings } = await import('../../src/core/settings.js');
    const { clip } = await import('./voice-kit.js');
    const k = await liveKit([
      ...Array.from({ length: 4 }, () => ({ heard: 'la la', delayMs: ms })),
      { heard: 'is there a gas station', said: 'There is one in two miles.', audio: tone(0.8), delayMs: ms },
      { tool: { name: 'sleep', args: {} } },
    ], { agent: { secondMs: 200 }, kokoro: [{ rules: [{ match: 'non-stop sound', reply: { delayMs: 1500, toolCalls: [{ name: 'tell_koe', input: { text: 'Only music: go to sleep.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }] });
    try {
      await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 10 } }); // 2 s here
      await k.voice.unlock();
      k.agent.tap();
      await until(() => k.agent.live.listening, 3000);
      await realtime(k, quiet(0.3));
      await realtime(k, hum(3)); // the spell runs out in it
      for (let i = 1; i < 4; i++) {
        await realtime(k, quiet(0.9));
        await realtime(k, hum(i === 1 ? 1.5 : 3)); // the sleep note comes during the last
      }
      await realtime(k, quiet(1));
      await realtime(k, cat(...(await Promise.all(clips.map((c) => clip(c)))), quiet(2)));
      await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1).catch(() => assert.fail('Kokoro was not woken once for the music'));
      await soon(async () => (await k.events(['out.speak'])).some((e) => /two miles/.test(JSON.stringify(e)))).catch(() => assert.fail(`Koe never answered: ${JSON.stringify(texts(k))}`));
      await wait(500);
      assert.ok(!texts(k).some((x) => /go to sleep/.test(x)), `the sleep note never went in: ${JSON.stringify(texts(k))}`);
      assert.ok(!(await lives(k, 'closed')).some((e) => e.data.why === 'sleep'), 'no sleep closed it');
    } finally {
      await k.done();
    }
  });
}

// After fix 7 (Step): the sleep note came during a music turn that ran to the cap; the user asks after a gap. Only a turn begun at
// once after a cap is the same sound: this question gets its own wait, and is never cut.
test("Kokoro's sleep note during music that ran to the cap, then a question after a gap: Koe answers it and the note is dropped", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const { clip } = await import('./voice-kit.js');
  const k = await liveKit([
    ...Array.from({ length: 4 }, (_, i) => ({ heard: 'la la', delayMs: i === 3 ? 2500 : 1000 })),
    { heard: 'is there a gas station', said: 'There is one in two miles.', audio: tone(0.8), delayMs: 1000 },
    { tool: { name: 'sleep', args: {} } },
  ], { agent: { secondMs: 200 }, kokoro: [{ rules: [{ match: 'non-stop sound', reply: { delayMs: 1500, toolCalls: [{ name: 'tell_koe', input: { text: 'Only music: go to sleep.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }] });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 10 } }); // 2 s here
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await realtime(k, quiet(0.3));
    await realtime(k, hum(3)); // the spell runs out in it
    await realtime(k, quiet(0.9));
    await realtime(k, hum(1.5)); // let go as the next begins: Kokoro is woken
    await realtime(k, quiet(0.9));
    await realtime(k, hum(15.1)); // runs to the cap and stops just after it; the sleep note comes during it
    await realtime(k, quiet(1));
    await realtime(k, cat(await clip('gas-station'), await clip('where-lunch'), quiet(2)));
    await soon(async () => (await k.events(['out.speak'])).some((e) => /two miles/.test(JSON.stringify(e)))).catch(() => assert.fail(`Koe never answered: ${JSON.stringify(texts(k))}`));
    await wait(500);
    assert.ok(!texts(k).some((x) => /go to sleep/.test(x)), `the sleep note never went in: ${JSON.stringify(texts(k))}`);
    assert.ok(!(await lives(k, 'closed')).some((e) => e.data.why === 'sleep'), 'no sleep closed it');
  } finally {
    await k.done();
  }
});

// Fix pass 7, 2: her answer to the user's question comes as the next turn (more music) goes on: it is still an exchange, and the
// sleep note waiting on that question is dropped.
test("Kokoro's sleep note waiting on the user's question, whose answer comes during the next music turn: the note is dropped (fix 7)", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const { clip } = await import('./voice-kit.js');
  const k = await liveKit([
    { heard: 'la la', delayMs: 1000 },
    { heard: 'la la la', delayMs: 1000 },
    { heard: 'la la la la', delayMs: 1000 },
    { heard: 'where should we eat', said: 'Tacos ahead, two miles.', audio: tone(0.5), delayMs: 1500, interruptOn: 'text' },
    { heard: 'la la', delayMs: 1000 },
    { tool: { name: 'sleep', args: {} } },
  ], { agent: { secondMs: 250 }, kokoro: [{ rules: [{ match: 'non-stop sound', reply: { delayMs: 1500, toolCalls: [{ name: 'tell_koe', input: { text: 'Only music: go to sleep.' } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }] });
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 8 } }); // 2 s here
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await realtime(k, quiet(0.3));
    await realtime(k, hum(3)); // the spell runs out in it
    await realtime(k, quiet(0.9));
    await realtime(k, hum(1.5)); // let go as the next begins: Kokoro is woken
    await realtime(k, quiet(0.9));
    await realtime(k, hum(3)); // the sleep note comes during this one
    await realtime(k, quiet(1));
    await realtime(k, cat(await clip('where-eat'), quiet(0.9), hum(2), quiet(2))); // her answer comes during the music after it
    await soon(async () => (await kokoroWakes(k, /non-stop sound/)).length === 1).catch(() => assert.fail('Kokoro was not woken once for the music'));
    await wait(3000);
    assert.ok(!texts(k).some((x) => /go to sleep/.test(x)), `the sleep note never went in: ${JSON.stringify(texts(k))}`);
    assert.ok(!(await lives(k, 'closed')).some((e) => e.data.why === 'sleep'), 'no sleep closed it');
  } finally {
    await k.done();
  }
});
