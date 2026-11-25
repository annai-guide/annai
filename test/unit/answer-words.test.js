import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, idleAtOnce } from './agent-kit.js';
import { useClock } from './clock.js';
import { plainWords } from '../../src/core/markdown.js';

// answer-words-next (the Deferred entry "Kokoro's words shown at the top and said aloud keep their markdown", from the user's screenshots, 2026-11-23):
// Kokoro's words annai shows itself reach the card at the top of the screen and, with voice on, the voice as one plain-words reading made where they are
// shown (loop.js remind): a link by its name, a bare address by its site and the parts of its path in other than ASCII, no marks. The line keeps the words as written (talk.js draws its links).
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
  assert.deepEqual(s.voiced, ['Directions: Apple Maps or Google Maps.', 'Hours at sample-lake.example.org today.']);
});

test('a Japanese line with a link: the link by its name, a bare address cut at 。 by its site and the title in it, the card and the voice alike', async (t) => {
  const text = `正法寺は[地図](${MAP})で見られます。詳しくは https://ja.wikipedia.org/wiki/正法寺。`;
  const words = '正法寺は地図で見られます。詳しくは ja.wikipedia.org 正法寺。';
  const s = await shown(t, text);
  assert.deepEqual(s.cards, [["Shiori's answer", words]]);
  assert.deepEqual(s.given, [words]);
  assert.deepEqual(s.voiced, ['正法寺は地図で見られます。', '詳しくは ja.wikipedia.org 正法寺。']);
});

test("Kokoro's words with a heading, a list, code and italics: no `#`, `*`, `_` or backtick, each block on a line of its own; a fenced block as written", async (t) => {
  const s = await shown(t, '## Tomorrow\n* **Ferry** at 10:40\n* Gate `B3`\n1. Walk to the pier\n2. Board\nGate *1234* and the _side_ door.\n```\nrun *a* and *b*\n- kept\n# kept\n```\nDone.');
  assert.deepEqual(s.cards, [["Shiori's answer", 'Tomorrow\nFerry at 10:40\nGate B3\n1. Walk to the pier\n2. Board\nGate 1234 and the side door.\nrun *a* and *b*\n- kept\n# kept\nDone.']]);
});

test('a numbered line keeps its number as written, in the card and in the voice: a list starting at 2, blank lines between items, a nested bullet, a date', async (t) => {
  for (const [text, words] of [
    ['Two options are left:\n2. The 10:40 ferry\n3. The 12:15 ferry', 'Two options are left:\n2. The 10:40 ferry\n3. The 12:15 ferry'],
    ['1. Take the ferry at 10:40.\n\n2. Walk to the pier.\n\n3. Board.', '1. Take the ferry at 10:40.\n2. Walk to the pier.\n3. Board.'],
    ['1. Ferry at 10:40\n   - from pier B\n2. Bus at **11:05**', '1. Ferry at 10:40\nfrom pier B\n2. Bus at 11:05'],
    ['24. Dezember ist der Markt geschlossen.', '24. Dezember ist der Markt geschlossen.'],
  ]) {
    const s = await shown(t, text);
    assert.deepEqual(s.cards, [["Shiori's answer", words]], text);
    assert.deepEqual(s.given, [words], text);
  }
});

test('a bare address with a site in another script is read by the site as written, not as punycode, in the card and in the voice', async (t) => {
  const s = await shown(t, 'See https://www.サンプル.example.jp/shop?x=1 today.');
  assert.deepEqual(s.cards, [["Shiori's answer", 'See サンプル.example.jp today.']]);
  assert.deepEqual(s.given, ['See サンプル.example.jp today.']);
  assert.deepEqual(s.voiced, ['See サンプル.example.jp today.']);
});

test("words written right after an address with no space (the parser takes them into it) are kept, and so is a title in another script, percent-encoded or not", async (t) => {
  const title = 'サンプル湖';
  for (const [text, words] of [
    ['詳細はhttps://www.sample-tera.example.jp/をご覧ください。', '詳細はsample-tera.example.jp をご覧ください。'],
    ['访问https://www.sample-hu.example.cn/了解更多信息', '访问sample-hu.example.cn 了解更多信息'],
    [`詳しくは https://ja.wikipedia.org/wiki/${encodeURIComponent(title)} を参照。`, '詳しくは ja.wikipedia.org サンプル湖 を参照。'],
    [`詳しくは https://ja.wikipedia.org/wiki/${title}_%28北区%29 を参照。`, '詳しくは ja.wikipedia.org サンプル湖 (北区) を参照。'],
    ['Cut mid-escape https://sample.example.org/wiki/%E3%82 today.', 'Cut mid-escape sample.example.org today.'],
  ]) {
    const s = await shown(t, text);
    assert.deepEqual(s.cards, [["Shiori's answer", words]], text);
    assert.deepEqual(s.given, [words], text);
  }
});

test("a key in Kokoro's words is blanked once, and the card and the voice (a provider's, the phone's) get that one text", async (t) => {
  for (const phone of [false, true]) {
    const s = await shown(t, 'Your code is Bearer sk12345678abc now.', { phone });
    assert.deepEqual(s.cards, [["Shiori's answer", 'Your code is Bearer «key» now.']]);
    assert.deepEqual(s.given, ['Your code is Bearer «key» now.']);
    assert.deepEqual(s.voiced, ['Your code is Bearer «key» now.']);
  }
});

test("a reminder without the answer flag keeps its words as written in the card and the voice: they are not changed here", async (t) => {
  const s = await shown(t, 'Show code *1234* at the gate.', { answer: false });
  assert.deepEqual(s.cards, [['Reminder', 'Show code *1234* at the gate.']]);
  assert.deepEqual(s.given, ['Show code *1234* at the gate.']);
});

test("through the halves: Kokoro's gated speak that Koe never passes on shows its links by their names on the card, and the line keeps them", async (t) => {
  useClock(t);
  const text = `It opens at 11:30 today: [Maps](${MAP}).`;
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] }]], {
    koe: { type: [{ toolCalls: [{ name: 'speak', input: { text: 'Let me check.' } }, { name: 'tell_kokoro', input: { text: 'Is Nepenthe open?' } }, { name: 'wait', input: { seconds: 600 } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }, { toolCalls: [{ name: 'sleep', input: {} }] }] },
  });
  k.agent.send('Is it open?');
  await idleAtOnce(k);
  assert.deepEqual(k.notices.filter((/** @type {any} */ n) => n.title === "Shiori's answer").map((/** @type {any} */ n) => n.body), ['It opens at 11:30 today: Maps.']);
  assert.deepEqual((await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text), [text]);
});

test("an address's words: a `+` reads as a space, a link named by its address reads its name as written, and one stray `%` loses nothing else", () => {
  assert.equal(plainWords('See https://www.maps.example.com/search/?api=1&query=サンプル寺+駐車場 today.'), 'See maps.example.com サンプル寺 駐車場 today.');
  assert.equal(plainWords('[https://見本.jp/店](https://見本.jp/店)を見て'), '見本.jp 店を見て');
  assert.equal(plainWords('See [https://a.example.com](https://b.example.com/) now.'), 'See a.example.com now.');
  assert.equal(plainWords('See https://ja.wiki.example.org/wiki/%E6%AD%A3%E6%B3%95%E5%AF%BA?ref=100% today.'), 'See ja.wiki.example.org 正法寺 today.');
});
