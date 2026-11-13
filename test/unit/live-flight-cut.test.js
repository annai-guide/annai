// Cutting in (spec §7.1): anything that cuts in on her (the user's spoken start, a line they send: typed, a tapped choice, a hand-over; annai's
// own urgent reminder) passes the note in flight on if her turn was heard whole, else shows it on a silent card, and stops her voice. Kokoro's
// own immediate note replaces the note she is saying (the user's pick, 2026-11-12). Lines and places are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tone, soon } from './koe-live-kit.js';
import { SAID, FOR_USER, LOOKS, CONT, shown, lines, words, cues, wait, start, quietSession } from './live-flight-kit.js';

const LUNCH = { said: 'Lunch is at noon.', audio: tone(0.5) };
const OKAY = { said: 'Okay.', audio: tone(0.3) };

for (const [what, send] of /** @type {const} */ ([['a typed line', (/** @type {any} */ k) => k.agent.send('What about lunch?')], ['a tapped choice', (/** @type {any} */ k) => k.agent.answer('call_gone', 'Lunch')]])) {
  test(`${what} in the quiet after "Checking your notes.": the note in flight is shown on a silent card`, async () => {
    const { k, w } = await start({ turns: [LOOKS, CONT, LUNCH, OKAY] });
    try {
      await wait(1500);
      send(k);
      await soon(async () => (await words(k)).includes(LUNCH.said), 10_000);
      await wait(500);
      assert.deepEqual(await shown(k), [[FOR_USER, false]]);
    } finally {
      w.stop();
      await k.done();
    }
  });
}

test('a typed line while "Checking your notes." still plays: her voice stops, and the note is shown on a silent card', async () => {
  const { k, w } = await start({ turns: [LOOKS, CONT, LUNCH, OKAY] });
  try {
    await wait(300);
    k.agent.send('What about lunch?');
    await soon(async () => (await words(k)).includes(LUNCH.said), 10_000);
    await wait(500);
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
    assert.ok((await lines(k)).some((l) => l.text.startsWith('Checking') && l.cut), 'her line cut where it stopped');
  } finally {
    w.stop();
    await k.done();
  }
});

/** annai's urgent reminder (an urgent watch fired), with its words for the user. @param {any} k */
const urgent = (k) => k.agent.wake({ kind: 'trigger', text: 'Leave now', fallbacks: [{ watch: 'ferry', text: 'Leave now for the ferry.' }], urgent: true });

test('annai\'s urgent reminder cuts in while she says a note: the note is shown on a silent card, and the reminder is said', async () => {
  const { k, w } = await start({ turns: [{ said: SAID, audio: tone(3) }, { said: 'Leave now for the ferry.', audio: tone(0.8) }, OKAY] });
  try {
    await wait(800);
    await urgent(k);
    await soon(async () => (await words(k)).includes('Leave now for the ferry.'), 8000);
    await wait(500);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[FOR_USER, false]], 'the note, not the reminder');
    assert.ok((await lines(k)).some((l) => l.text.startsWith('The fuel') && l.cut));
  } finally {
    w.stop();
    await k.done();
  }
});

test('annai\'s urgent reminder cuts in on a note, and her answer to it says nothing: the reminder is still asked for', async () => {
  const { k, w } = await start({ turns: [{ said: SAID, audio: tone(3) }, { said: '' }, { said: 'Leave now for the ferry.', audio: tone(0.8) }, OKAY] });
  try {
    await wait(800);
    await urgent(k);
    await soon(async () => cues(k).length > 0, 14_000); // once the urgent mark's own bound has passed (URGENT_S, 8 s: no sound of hers came)
    await soon(async () => (await words(k)).includes('Leave now for the ferry.'), 8000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[FOR_USER, false]]);
  } finally {
    w.stop();
    await k.done();
  }
});

// Kokoro's own immediate note replaces the note she is saying (the user's pick, 2026-11-12: "Urgent replaces it"): tell_koe tells Kokoro so.
test('Kokoro\'s immediate note cuts in while she says a note, and a tap stops her answer to it: only the immediate note is shown', async () => {
  const NOW = 'The road ahead is closed; take the coast road.';
  const { k, w } = await start({ turns: [{ said: SAID, audio: tone(3) }, { said: NOW, audio: tone(3) }, OKAY] });
  try {
    await wait(800);
    await k.agent.channel.send('kokoro', `Tell the user: ${NOW}`, 'immediate', 'tool', undefined, undefined, false, NOW);
    await soon(async () => k.platform.streams.length === 3, 8000); // her answer to it plays
    await wait(800);
    k.agent.tap();
    await wait(1000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[NOW, false]], 'the first note, replaced, is neither shown nor asked for');
    assert.deepEqual(cues(k), []);
  } finally {
    w.stop();
    await k.done();
  }
});

// annai's own reminder in flight is not Kokoro's note: Kokoro's immediate note replaces Kokoro's own, but cuts in on a reminder as annai's urgent
// reminder does, a silent card unless she said it whole. (Review of 2026-11-12, F1: the reminder was neither said nor shown.)
test('Kokoro\'s immediate note cuts in while she says annai\'s reminder: the reminder is shown on a silent card, and the note is said', async () => {
  const REMIND = 'In ten minutes, leave for the ferry at pier three.';
  const NOW = 'The road ahead is closed; take the coast road.';
  const { k, w } = await quietSession([{ said: REMIND, audio: tone(3) }, { said: NOW, audio: tone(0.8) }, OKAY]);
  try {
    await k.agent.wake({ kind: 'trigger', text: 'Leave soon', fallbacks: [{ watch: 'ferry', text: REMIND }] });
    await soon(async () => k.agent.live.view.name === 'speaking', 8000);
    await wait(400);
    await k.agent.channel.send('kokoro', `Tell the user: ${NOW}`, 'immediate', 'tool', undefined, undefined, false, NOW);
    await soon(async () => (await words(k)).includes(NOW), 8000);
    await wait(500);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [[REMIND, false]], 'the reminder, on a silent card, and not the note she said');
    assert.deepEqual(cues(k), []);
  } finally {
    w.stop();
    await k.done();
  }
});
