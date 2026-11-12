// One answer: a note whose words sound cut off while the provider was still making them is said again from its start, never taken up from its
// middle; Kokoro reads Koe's answer before she starts, for what both halves were given at once; and Koe passes on what the user said, as said.
// Lines and places are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until, agentKit } from './agent-kit.js';
import { liveKit, texts, soon, tone, say } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';
import { KOE_CORE, KOE_LIVE } from '../../src/core/koe/instructions.js';
import { channelTool } from '../../src/core/agent/halves.js';

const RATE = 16_000;
const FOR_USER = 'The fuel station ahead is open until ten tonight.';
const NOTE = 'Tell the user the fuel station ahead is open until ten tonight.';
const SAID = 'The fuel station ahead is open until ten tonight.';
/** Kokoro's tell_koe with for_user, as its tool sends it. @param {any} k */
const tell = (k) => k.agent.channel.send('kokoro', NOTE, 'append', 'tool', undefined, undefined, false, FOR_USER);
/** What annai showed as Shiori's answer (the note's words, when Koe never passed it on). @param {any} k */
const shown = async (k) => (await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text);
/** The asks annai sent because sound cut her off. @param {any} k */
const cutAsks = (k) => texts(k).filter((t) => /^\[annai\] /.test(t) && /cut you off/.test(t));
/** Her lines, as written: words, and whether cut. @param {any} k */
const lines = async (k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.cut)]);

/**
 * A live session in a car (sound at the microphone may cut her), the user in it: a first exchange, then Kokoro's note, which she begins to say.
 * turns: what the stand-in answers after the note's own turn, in order; cue: its answer to annai's ask. @param {{ turns?: any[], cue?: any, pace?: number, note?: any }} [o]
 */
async function noteSaid({ turns = [], cue = { said: SAID, audio: tone(0.2) }, pace = 1, note = { said: SAID, audio: tone(3) } } = {}) {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1) }, note, ...turns], { pace, server: { onText: { match: /cut you off/, turn: cue } } });
  await k.voice.unlock();
  k.voice.route = async () => 'car';
  k.platform.streamSpeed = 1;
  k.agent.tap(); // the user is in this session, so she stays cuttable
  await until(() => k.agent.live.listening, 3000);
  await say(k, 'where-eat');
  await soon(async () => (await k.events(['out.speak'])).length === 1, 4000);
  await k.agent.live.idle();
  k.platform.mic.feed(quiet(0.5), RATE);
  await tell(k);
  await soon(async () => k.agent.live.view.name === 'speaking', 3000);
  return k;
}

/** A bump at the microphone, over her, once some of her words have been heard: a turn of its own. @param {any} k */
async function bump(k) {
  await new Promise((r) => setTimeout(r, 500));
  k.platform.mic.feed(cat(hum(0.8), quiet(1)), RATE);
}

test('a note cut by a sound while the provider still made it is asked for again once the sound\'s turn ends, and said again from its start; nothing is taken up from its middle', async () => {
  // The provider's answer to the sound's own turn comes late (as Gemini's do), and would go on from where its record stopped: the ask goes in first.
  const k = await noteSaid({ turns: [{ said: 'open until ten tonight.', audio: tone(0.5), delayMs: 400 }] });
  try {
    await bump(k);
    await soon(async () => (await lines(k)).some(([text, cut]) => text === SAID && !cut), 8000);
    await k.agent.idle();
    assert.equal(cutAsks(k).length, 1, 'asked once, when the sound\'s turn ended');
    const said = await lines(k);
    assert.deepEqual(said.at(-1), [SAID, false], 'said again whole');
    assert.ok(said.some(([text, cut]) => cut && /✂$/.test(text)), 'the cut words are kept, marked');
    assert.ok(!said.some(([text]) => /^open until ten/.test(text)), 'nothing from its middle');
    assert.deepEqual(await shown(k), [], 'she said it: annai shows nothing');
  } finally {
    await k.done();
  }
});

test("the ask's own text turn cutting a turn that hadn't sounded yet is no second cut: the note is said once more, and annai shows nothing", async () => {
  // The provider's answer to the sound's turn: its sound came, its first word not yet (her voice waits for a word), when the ask cuts it.
  const k = await noteSaid({ turns: [{ said: 'open until ten tonight.', audio: tone(0.5), saidAt: 1500 }] });
  try {
    await bump(k);
    await soon(async () => (await lines(k)).some(([text, cut]) => text === SAID && !cut), 8000);
    await k.agent.idle();
    assert.equal(cutAsks(k).length, 1);
    assert.deepEqual(await shown(k), []);
    assert.deepEqual((await lines(k)).at(-1), [SAID, false]);
  } finally {
    await k.done();
  }
});

test('cut twice: asked once, then annai shows and says the words for the user; never a third ask', async () => {
  const k = await noteSaid({ turns: [{ said: 'open until ten tonight.', audio: tone(0.5), delayMs: 400 }], cue: { said: SAID, audio: tone(3) } });
  try {
    await bump(k);
    await soon(async () => cutAsks(k).length === 1, 6000);
    await soon(async () => k.agent.live.view.name === 'speaking', 4000); // she says it again
    await bump(k);
    await soon(async () => (await shown(k)).length === 1, 8000);
    await k.agent.idle();
    assert.deepEqual(await shown(k), [FOR_USER]);
    assert.equal(cutAsks(k).length, 1, 'one ask, then the backstop');
  } finally {
    await k.done();
  }
});

test('the provider done, then her sound cut: asked once, as before, and said again whole', async () => {
  // The note's turn ends at the provider at once (pace 0); her voice plays it out in real time, and the sound cuts that.
  const k = await noteSaid({ pace: 0, note: { said: SAID, audio: tone(1.5) }, turns: [{ said: 'open until ten tonight.', audio: tone(0.5), delayMs: 400 }] });
  try {
    await bump(k);
    await soon(async () => (await lines(k)).some(([text, cut]) => text === SAID && !cut), 8000);
    await k.agent.idle();
    assert.equal(cutAsks(k).length, 1);
    assert.deepEqual(await shown(k), []);
  } finally {
    await k.done();
  }
});

// Kokoro reads Koe's answer before she starts, for what both halves were given (a typed line, a wake with reminders): her first request then
// holds it, and her "on it" or the reminder isn't said a second time.

/** Every text of a request's user messages. @param {any} req */
const userTexts = (req) => req.messages.filter((/** @type {any} */ m) => m.role === 'user').flatMap((/** @type {any} */ m) => m.parts.filter((/** @type {any} */ p) => p.type === 'text').map((/** @type {any} */ p) => p.text));
/** A second, in these tests: the live wait for Koe's answer is 8 of them (3.2 s), the quiet the user's input needs 1.5 (0.6 s). */
const SECOND = 400;
/** When each of Kokoro's model calls began (model-0 is hers). @returns {{ starts: number[], hold: (c: any) => Promise<void> }} */
function kokoroStarts() {
  /** @type {number[]} */
  const starts = [];
  return { starts, hold: async (c) => { if (c.model.providerId === 'model-0') starts.push(Date.now()); } };
}
/** The page out of view, or back, as the browser says it. @param {boolean} on */
function hidden(on) {
  if (on) /** @type {any} */ (globalThis).document = { visibilityState: 'hidden' };
  else delete (/** @type {any} */ (globalThis).document);
}

test("a typed line in live voice: Kokoro's turn waits for Koe's answer, so her first request holds Koe's line", async () => {
  const { starts, hold } = kokoroStarts();
  const k = await liveKit([{ said: 'Hello. What can I do?', audio: tone(0.3), delayMs: 1000 }], { agent: { secondMs: SECOND }, hold });
  try {
    const sent = Date.now();
    k.agent.send('hello?');
    await until(() => starts.length > 0, 8000);
    await k.agent.idle();
    const first = userTexts(k.sent['model-0'][0]);
    assert.ok(first.some((t) => /^\[Koe said( aloud)?\] "Hello\. What can I do\?"$/.test(t)), JSON.stringify(first));
    assert.ok(starts[0] - sent < 8 * SECOND, `started ${starts[0] - sent} ms after the line, at Koe's line, not at the bound`);
  } finally {
    await k.done();
  }
});

test("a typed line Koe passes on (tell_kokoro, no words): Kokoro starts at the tell_kokoro, not at the bound", async () => {
  const { starts, hold } = kokoroStarts();
  const k = await liveKit([{ tool: { name: 'tell_kokoro', args: { text: 'hello?' } }, delayMs: 1200 }, {}], { agent: { secondMs: SECOND }, hold });
  try {
    const sent = Date.now();
    k.agent.send('hello?');
    await until(() => starts.length > 0, 8000);
    const told = (await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'tell_kokoro');
    assert.ok(told, 'Koe passed it on');
    assert.ok(starts[0] >= told.ts - 50, 'not before it');
    assert.ok(starts[0] - sent < 8 * SECOND - 500, `started ${starts[0] - sent} ms after the line`);
    await k.agent.idle();
  } finally {
    await k.done();
  }
});

test("a typed line Koe gives nothing back to: Kokoro starts at the live session's own no-answer bound (8 seconds)", async () => {
  const { starts, hold } = kokoroStarts();
  const k = await liveKit([{}], { agent: { secondMs: SECOND }, hold });
  try {
    const sent = Date.now();
    k.agent.send('hello?');
    await until(() => starts.length > 0, 12_000);
    const at = starts[0] - sent;
    assert.ok(at >= 8 * SECOND - 100 && at < 8 * SECOND + 2500, `started ${at} ms after the line`);
    await k.agent.idle();
  } finally {
    await k.done();
  }
});

test("a typed line whose answer is Koe's sleep: the session closes, and Kokoro waits no longer", async () => {
  const { starts, hold } = kokoroStarts();
  const k = await liveKit([{ tool: { name: 'sleep', args: {} }, delayMs: 600 }], { agent: { secondMs: SECOND }, hold });
  try {
    const sent = Date.now();
    k.agent.send('never mind');
    await until(() => starts.length > 0, 12_000);
    assert.ok(starts[0] - sent < 8 * SECOND - 500, `started ${starts[0] - sent} ms after the line`);
    await k.agent.idle();
  } finally {
    await k.done();
  }
});

test("a typed line when no live session can open (today's spend reached, Koe stays live): Kokoro's turn waits no longer", async () => {
  const usage = { promptTokenCount: 1_000_000, responseTokenCount: 0, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1_000_000 }] };
  const k = await liveKit([{ said: 'Sure.', audio: tone(0.1), usage }], { agent: { secondMs: SECOND } });
  try {
    const { updateAppSettings } = await import('../../src/core/settings.js');
    await updateAppSettings(k.ws, { shiori: { budgets: { spendPerDay: 0.5 } } });
    k.agent.send('Hi');
    await soon(async () => (await k.events(['live.session'])).some((/** @type {any} */ e) => e.data.state === 'closed'));
    await k.agent.idle();
    assert.equal(k.agent.koeState, 'live', 'Koe stays live: the model is not at fault');
    const sent = Date.now();
    k.agent.send('How far is Testville?');
    /** Kokoro's wake for the line (the same budget then stops her turn: its line comes as soon as she starts). */
    const woke = async () => (await k.events(['wake'])).find((/** @type {any} */ e) => e.data.half === 'kokoro' && e.data.reasons.some((/** @type {any} */ r) => r.text === 'How far is Testville?'));
    await soon(async () => Boolean(await woke()), 12_000);
    const at = (await woke()).ts - sent;
    assert.ok(at < 8 * SECOND - 1000, `Kokoro started ${at} ms after the line, not at the live bound`);
    await k.agent.idle();
  } finally {
    await k.done();
  }
});

/** annai's fact in Kokoro's wake: Koe is saying the reminder, so she doesn't. */
const SAYING = /Koe is saying these reminders to the user now: \\?"Sunset at 18:40\\?"\. Don't pass them on\./;
const SUNSET = { kind: /** @type {const} */ ('trigger'), text: 'Sunset in 30 minutes', fallbacks: [{ watch: 'sun', text: 'Sunset at 18:40' }] };

test("a reminder's wake that Koe says (live, the page in view; a chat Koe): Kokoro starts at once, told by annai that Koe is saying it", async () => {
  {
    const { starts, hold } = kokoroStarts();
    const k = await liveKit([{ said: 'The sun sets at 18:40.', audio: tone(0.3), delayMs: 1500 }], { agent: { secondMs: SECOND }, hold });
    try {
      await k.voice.unlock();
      const at = Date.now();
      await k.agent.wake(SUNSET);
      await until(() => starts.length > 0, 8000);
      assert.ok(starts[0] - at < 1000, `live: started ${starts[0] - at} ms after the wake, not after Koe's line`);
      assert.ok(userTexts(k.sent['model-0'][0]).some((t) => SAYING.test(t)), JSON.stringify(userTexts(k.sent['model-0'][0])));
      await k.agent.idle();
    } finally {
      await k.done();
    }
  }
  const { starts, hold: mine } = kokoroStarts();
  const k = await agentKit([{ rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] }], {
    koe: { type: { rules: [{ match: '.', reply: { toolCalls: [{ name: 'speak', input: { text: 'Sunset at 18:40.' } }, { name: 'sleep', input: {} }] } }] } },
    agent: { secondMs: 200 },
    // Koe's model takes 1 s: Kokoro starts before its words, with annai's word for them.
    hold: async (c) => {
      await mine(c);
      if (c.model.providerId === 'model-koe') await new Promise((r) => setTimeout(r, 1000));
    },
  });
  const at = Date.now();
  await k.agent.wake(SUNSET);
  await until(() => starts.length > 0, 5000);
  assert.ok(starts[0] - at < 800, `chat Koe: started ${starts[0] - at} ms after the wake`);
  assert.ok(userTexts(k.sent['model-0'][0]).some((t) => SAYING.test(t)));
  await k.agent.idle();
  assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['Sunset at 18:40.'], 'said once, by Koe');
});

test("a reminder's wake with nothing for Koe to say, or while a live session waits for the page: no word of Koe saying it, and Kokoro starts at once", async () => {
  for (const [what, wake, away] of /** @type {const} */ ([['no reminders', { kind: 'trigger', text: 'Sunset in 30 minutes' }, false], ['out of view', SUNSET, true]])) {
    const { starts, hold } = kokoroStarts();
    const k = await liveKit([{ said: 'The sun sets at 18:40.', audio: tone(0.3), delayMs: 2500 }], { agent: { secondMs: SECOND }, hold });
    try {
      await k.voice.unlock();
      if (away) hidden(true);
      const at = Date.now();
      await k.agent.wake(/** @type {any} */ (wake));
      await until(() => starts.length > 0, 8000);
      assert.ok(starts[0] - at < 2000, `${what}: started ${starts[0] - at} ms after the wake`);
      assert.ok(!userTexts(k.sent['model-0'][0]).some((t) => /Koe is saying/.test(t)), `${what}: annai says nothing of Koe saying it`);
    } finally {
      hidden(false);
      await k.done();
    }
  }
});

test("a reminder's wake, another conversation opened 300 ms after it, then back: Kokoro takes nothing up on return (annai's own wake is let go)", async () => {
  const { starts, hold: mine } = kokoroStarts();
  const k = await agentKit([{ rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] }], {
    koe: { type: { rules: [{ match: '.', reply: { toolCalls: [{ name: 'speak', input: { text: 'Sunset at 18:40.' } }, { name: 'sleep', input: {} }] } }] } },
    agent: { secondMs: 200 },
    hold: async (c) => {
      await mine(c);
      if (c.model.providerId === 'model-koe') await new Promise((r) => setTimeout(r, 1000));
    },
  });
  const { createTrip } = await import('../../src/core/scopes.js');
  const other = await createTrip(k.ws, { title: 'Testville' });
  await k.agent.wake(SUNSET);
  await new Promise((r) => setTimeout(r, 300));
  await k.agent.open(other);
  await k.agent.idle();
  const before = starts.length;
  await k.agent.open(k.trip);
  await k.agent.idle();
  await new Promise((r) => setTimeout(r, 400));
  await k.agent.idle();
  assert.equal(starts.length - before, 0, 'no request on return');
  assert.ok(!userTexts(k.sent['model-0'].at(-1)).some((t) => /You haven't answered this yet/.test(t)), 'nothing written as unanswered');
});

test("Koe unset, or down: the reminder's wake is Kokoro's alone, as before, with no word of Koe saying it", async () => {
  for (const koe of [undefined, { type: [{ error: 'auth', message: 'bad key' }] }]) {
    const k = await agentKit([{ rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] }], koe ? { koe } : { halves: true });
    if (koe) {
      k.agent.send('Hello?');
      await k.agent.idle();
      assert.equal(k.agent.koeState, 'down');
    }
    await k.agent.wake(SUNSET);
    await k.agent.idle();
    const asked = k.sent['model-0'].filter((/** @type {any} */ r) => userTexts(r).some((t) => /Sunset in 30 minutes/.test(t)));
    assert.ok(asked.length, `${koe ? 'down' : 'unset'}: Kokoro was asked`);
    assert.ok(!asked.some((/** @type {any} */ r) => userTexts(r).some((t) => /Koe is saying/.test(t))), `${koe ? 'down' : 'unset'}: no word of Koe`);
    assert.equal((await k.events(['reminder'])).length, 1, `${koe ? 'down' : 'unset'}: Kokoro slept, so annai said it, once`);
  }
});

// Koe's instructions, at the source: passing on is the default, said in the same words to a chat Koe, a live one and in tell_kokoro's own
// description; no standing excuse; the lines that get no reply say what to do, and a live Koe is told once that every word it makes is heard.
test("Koe passes on what the user said as they said it, in its instructions and in tell_kokoro's description; meanwhile it says \"One moment.\" and asks nothing of its own", () => {
  const tool = channelTool('koe', /** @type {any} */ ({ send: async () => 'sent' }));
  for (const k of [KOE_CORE, KOE_LIVE, tool.description]) assert.match(k, /what the user said,? as they said it|what they said, as they said it/);
  for (const k of [KOE_CORE, KOE_LIVE]) {
    const line = k.split('\n').find((l) => l.startsWith('- Anything else the user says to you'));
    assert.ok(line, 'one line says it');
    assert.match(line, /"One moment\.", (then )?tell_kokoro what they said, as they said it/);
    assert.match(line, /Ask them nothing of your own, and never say it's done until a note says so\./);
    assert.doesNotMatch(k, /can't check|can't be reached|saying you're checking/, 'no ready excuse, and no promise to check');
    assert.doesNotMatch(k, /\bwhen the user asks for something done\b/i, 'one rule, not two');
  }
});

test("the lines that get no reply say what to do, and name no state; a live Koe is told once that every word it makes is spoken aloud", () => {
  for (const k of [KOE_CORE, KOE_LIVE]) {
    assert.doesNotMatch(k, /Silence is|Say nothing at all|thinks aloud, say nothing/);
    assert.match(k, /single stray words and a language the user doesn't speak get no reply: no words, no sound\./);
  }
  assert.match(KOE_LIVE, /only acknowledges \(okay, cool, thanks\) or thinks aloud, it gets no reply: no words, no sound\./);
  assert.equal(KOE_LIVE.split('\n').filter((l) => /Every word you produce is spoken aloud to the user, so never describe what you are doing or that you are staying quiet\./.test(l)).length, 1);
  assert.doesNotMatch(KOE_CORE, /spoken aloud to the user/, "a chat Koe's own text is never shown or said");
});
