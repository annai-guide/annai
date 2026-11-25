import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, idleAtOnce } from './agent-kit.js';
import { useClock } from './clock.js';

// answer-words-next (the Deferred entry "Kokoro's words shown at the top and said aloud keep their markdown", from the user's screenshots, 2026-11-23):
// Kokoro's words annai shows itself reach the card at the top of the screen and, with voice on, the voice as one plain-words reading made where they are
// shown (loop.js remind): a link by its name, a bare address by its site, no marks. The line keeps the words as written (talk.js draws its links).
// Places and addresses are made up.

const MAP = 'https://maps.example.com/?daddr=Sample%20Visitor%20Center%2C%20Sample%20Lake%20Road%2C%20Testland&dirflg=d';
const OTHER = 'https://other-maps.example.com/dir/?api=1&destination=Sample%20Visitor%20Center&travelmode=driving';

/**
 * Kokoro's words shown by annai, with voice on: the card annai raised, what the voice was given, what the voice itself said sentence by sentence (a
 * provider voice, or the phone's), and the line's stored words. @param {any} t @param {string} text @param {{ phone?: boolean, answer?: boolean }} [o]
 */
async function shown(t, text, { phone = false, answer = true } = {}) {
  useClock(t);
  const k = await agentKit([[]], { voice: phone ? { speechOut: ['browser-voice'] } : {} });
  /** @type {string[]} */
  const given = [];
  /** @type {Promise<unknown>[]} */
  const saying = [];
  const say = k.voice.say.bind(k.voice);
  k.voice.say = (/** @type {string} */ words) => {
    given.push(words);
    const p = say(words);
    saying.push(p);
    return p;
  };
  await k.agent.remind([{ watch: '', text, ...(answer ? { answer: true } : {}) }]);
  await Promise.all(saying);
  const voiced = phone ? k.platform.said.map((/** @type {any} */ s) => s.text) : k.said;
  return { cards: k.notices.map((/** @type {any} */ n) => [n.title, n.body]), given, voiced, line: (await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text) };
}

const LINKED = `Sample Lake: [Maps](${MAP}) · [Other maps](${OTHER}). After the tunnel, turn off at the **visitor center** sign.`;
const PLAIN = 'Sample Lake: Maps · Other maps. After the tunnel, turn off at the visitor center sign.';

test("Kokoro's words with links: the card shows each link by its name, no address and no marks; the line keeps them as written", async (t) => {
  const s = await shown(t, LINKED);
  assert.deepEqual(s.cards, [["Shiori's answer", PLAIN]]);
  assert.deepEqual(s.line, [LINKED], 'the line draws its links from the words as written');
});

test("Kokoro's words with links: the voice is given the card's words, and a provider voice says them", async (t) => {
  const s = await shown(t, LINKED);
  assert.deepEqual(s.given, [PLAIN]);
  assert.deepEqual(s.voiced, ['Sample Lake: Maps · Other maps.', 'After the tunnel, turn off at the visitor center sign.']);
});

test("Kokoro's words with links: the phone's own voice says the same words", async (t) => {
  const s = await shown(t, LINKED, { phone: true });
  assert.deepEqual(s.given, [PLAIN]);
  assert.deepEqual(s.voiced, ['Sample Lake: Maps · Other maps.', 'After the tunnel, turn off at the visitor center sign.']);
});

test('two links and a bare address: the links by their names, the bare address by its site, in the card and in the voice alike', async (t) => {
  const text = `Directions: [Apple Maps](${MAP}) or [Google Maps](${OTHER}). Hours at https://www.sample-lake.example.org/visit/hours?lang=en today.`;
  const words = 'Directions: Apple Maps or Google Maps. Hours at sample-lake.example.org today.';
  const s = await shown(t, text);
  assert.deepEqual(s.cards, [["Shiori's answer", words]]);
  assert.deepEqual(s.given, [words]);
  assert.ok(!s.voiced.join(' ').includes('http'), s.voiced.join(' '));
});

test('a Japanese line with a link: the link by its name, a bare address cut at 。 by its site, the card and the voice alike', async (t) => {
  const text = `正法寺は[地図](${MAP})で見られます。詳しくは https://ja.wikipedia.org/wiki/正法寺。`;
  const words = '正法寺は地図で見られます。詳しくは ja.wikipedia.org。';
  const s = await shown(t, text);
  assert.deepEqual(s.cards, [["Shiori's answer", words]]);
  assert.deepEqual(s.given, [words]);
  assert.deepEqual(s.voiced, ['正法寺は地図で見られます。', '詳しくは ja.wikipedia.org。']);
});

test("Kokoro's words with a heading, a list and code: no `#`, `*` or backtick, each block on a line of its own", async (t) => {
  const s = await shown(t, '## Tomorrow\n* **Ferry** at 10:40\n* Gate `B3`\n1. Walk to the pier\n2. Board');
  assert.deepEqual(s.cards, [["Shiori's answer", 'Tomorrow\nFerry at 10:40\nGate B3\n1. Walk to the pier\n2. Board']]);
});

test("a reminder that isn't Kokoro's words (a watch's) keeps its words as written in the card and the voice: Shiori's own are not changed here", async (t) => {
  const s = await shown(t, 'Show code *1234* at the gate.', { answer: false });
  assert.deepEqual(s.cards, [['Reminder', 'Show code *1234* at the gate.']]);
  assert.deepEqual(s.given, ['Show code *1234* at the gate.']);
});

test("through the halves: Kokoro's gated speak that Koe never passes on shows its links by their names on the card, and the line keeps them", async () => {
  const text = `It opens at 11:30 today: [Maps](${MAP}).`;
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] }]], {
    koe: { type: [{ toolCalls: [{ name: 'speak', input: { text: 'Let me check.' } }, { name: 'tell_kokoro', input: { text: 'Is Nepenthe open?' } }, { name: 'wait', input: { seconds: 600 } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }, { toolCalls: [{ name: 'sleep', input: {} }] }] },
  });
  k.agent.send('Is it open?');
  await idleAtOnce(k);
  assert.deepEqual(k.notices.filter((/** @type {any} */ n) => n.title === "Shiori's answer").map((/** @type {any} */ n) => n.body), ['It opens at 11:30 today: Maps.']);
  assert.deepEqual((await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text), [text]);
});
