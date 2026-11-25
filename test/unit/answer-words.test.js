import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, idleAtOnce } from './agent-kit.js';
import { useClock } from './clock.js';
import { parseInline, parseMarkdown, plainWords } from '../../src/core/markdown.js';

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

// star-codes-next changed one reading here: `*1234*` keeps its stars. A `*` straight before a digit never opens italics, since a gate code's star must reach the
// traveller (`*1234#`, `*100*1#`), and a model's `*1234*` can't be told from one; a code without its stars is a wrong code, stars round an emphasised number a blemish.
test("Kokoro's words with a heading, a list, code and italics: no `#`, `*`, `_` or backtick, each block on a line of its own; a fenced block as written; a star before a digit stays", async (t) => {
  const s = await shown(t, '## Tomorrow\n* **Ferry** at 10:40\n* Gate `B3`\n1. Walk to the pier\n2. Board\nGate *1234* and the _side_ door, the *early* one.\n```\nrun *a* and *b*\n- kept\n# kept\n```\nDone.');
  assert.deepEqual(s.cards, [["Shiori's answer", 'Tomorrow\nFerry at 10:40\nGate B3\n1. Walk to the pier\n2. Board\nGate *1234* and the side door, the early one.\nrun *a* and *b*\n- kept\n# kept\nDone.']]);
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

// star-codes-next (the Deferred entry "Two star codes on one line lose their stars, and links the parser doesn't draw stay raw", 2026-11-24): the shared
// parser reads a star by the whitespace half of CommonMark's flanking rule and by a digit rule (a star straight before a digit or `#` never opens italics), and a link
// it doesn't draw by its name (a phone or mail link with its number or address). Its nodes are what every line and card draws (src/ui/markdown.js:
// text, strong, em, code, and a link only to an http(s) address); plainWords' words are the card at the top and the voice. Numbers and places are made up.

const CODES = 'Press *1234# at the gate, then *9#. Dial *67 then *82 for the **front** desk, not the *side* one.';
const CODES_PLAIN = 'Press *1234# at the gate, then *9#. Dial *67 then *82 for the front desk, not the side one.';

test('two star codes on one line keep their stars in the drawn line and card, and **bold** and *italic* beside them still draw', () => {
  const drawn = [{ t: 'text', v: 'Press *1234# at the gate, then *9#. Dial *67 then *82 for the ' }, { t: 'b', c: [{ t: 'text', v: 'front' }] },
    { t: 'text', v: ' desk, not the ' }, { t: 'i', c: [{ t: 'text', v: 'side' }] }, { t: 'text', v: ' one.' }];
  assert.deepEqual(parseInline(CODES), drawn);
  assert.deepEqual(parseMarkdown(CODES), [{ t: 'p', c: drawn }]);
  assert.deepEqual(parseInline('Dial *67 then *82'), [{ t: 'text', v: 'Dial *67 then *82' }]);
  // A `_` inside a word is none, as before (the four half-rule lines, one side with a space each, are the next test).
  assert.deepEqual(parseInline('a ** b ** c and _d _ e, snake_case_name'), [{ t: 'text', v: 'a ** b ** c and _d _ e, snake_case_name' }]);
});

/** @param {string} v */
const textOnly = (v) => [{ t: 'text', v }];

// Fable's table (the final review of star-codes-next): a code's star is no italic's, with no space before it (Japanese and Chinese), with a star inside the code,
// in a list of codes, in a bold, and a model's own `*1234*`. Each line reads as written, in the drawn line and as plain words.
test("a code's stars stay with no space before them, with a star inside, in a list of codes, and in a bold; italics that start with a digit show their stars", () => {
  for (const line of [
    '門で*1234#を押し、次に*9#を押してください。',
    '请在大门按*1234#，然后按*9#。',
    'Dial *100*1# to check the balance.',
    'Use *67,*82 or *69.',
    'Codes: *67/*82',
    'Dial *#06#*#21# for both.',
    'Dial **21*0900000000# to forward.',
    'Gate *1234* and the door *5*, in *3 nights* or *10:30*.',
    'It costs 2*3*4 and 3 * 4 = 12.',
  ]) {
    assert.deepEqual(parseInline(line), textOnly(line), line);
    assert.equal(plainWords(line), line, line);
  }
  // A code and an emphasis on one line: the code keeps its stars, the emphasis draws.
  const mixed = 'ゲートは*1234#です。*重要*な番号です。';
  assert.deepEqual(parseInline(mixed), [{ t: 'text', v: 'ゲートは*1234#です。' }, { t: 'i', c: textOnly('重要') }, { t: 'text', v: 'な番号です。' }]);
  assert.equal(plainWords(mixed), 'ゲートは*1234#です。重要な番号です。');
  // A code in a bold, and the entry's own line in one: the bold draws and holds the stars as text.
  for (const [line, inner] of [['**Gate code: *1234#**', 'Gate code: *1234#'], ['**Press *1234# at the gate, then *9#.**', 'Press *1234# at the gate, then *9#.'], ['**3 * 4 = 12**', '3 * 4 = 12'], ['**ゲート*1234#*9#**', 'ゲート*1234#*9#']]) {
    assert.deepEqual(parseInline(line), [{ t: 'b', c: textOnly(inner) }], line);
    assert.equal(plainWords(line), inner, line);
  }
  assert.deepEqual(parseInline('**Gate code: *1234#** and *side*'), [{ t: 'b', c: textOnly('Gate code: *1234#') }, { t: 'text', v: ' and ' }, { t: 'i', c: textOnly('side') }]);
});

test('a mark with a space on its inner side neither opens nor closes: each half of the rule, on a line of its own', () => {
  for (const line of ['a **b ** c', 'a ** b** c', '_ d_ e', '_d _ e', '* a* b', 'a * b* c']) {
    assert.deepEqual(parseInline(line), textOnly(line), line);
    assert.equal(plainWords(`ok ${line}`), `ok ${line}`, line); // a line that starts with `* ` is a bullet; the others, too, after a word
  }
  assert.equal(plainWords('* a* b'), 'a* b', 'a line of its own that starts with `* ` is a bullet');
  // A bold that doesn't close keeps its stars, and what its inner pieces read follows the same rules: a star after a space closes no italics there, one before a space
  // or a digit opens none.
  assert.deepEqual(parseInline('**a *b * c**'), textOnly('**a *b * c**'));
  for (const line of ['**a * b*c**', '**a *3 b*c**']) assert.deepEqual(parseInline(line), [{ t: 'text', v: line.slice(0, -4) }, { t: 'i', c: textOnly('c') }, { t: 'text', v: '*' }], line);
  // Beside them, a mark with a word on both sides still draws.
  assert.deepEqual(parseInline('a **b** _c_ *d*'), [{ t: 'text', v: 'a ' }, { t: 'b', c: textOnly('b') }, { t: 'text', v: ' ' }, { t: 'i', c: textOnly('c') }, { t: 'text', v: ' ' }, { t: 'i', c: textOnly('d') }]);
});

test('two star codes on one line keep their stars on the card at the top and in the voice, without the marks of bold and italic', async (t) => {
  assert.equal(plainWords(CODES), CODES_PLAIN);
  const s = await shown(t, CODES);
  assert.deepEqual(s.cards, [["Shiori's answer", CODES_PLAIN]]);
  assert.deepEqual(s.given, [CODES_PLAIN]);
  assert.deepEqual(s.voiced, ['Press *1234# at the gate, then *9#.', 'Dial *67 then *82 for the front desk, not the side one.']);
});

const LINKS = 'Call [the **inn**](tel:+1-555-0100), mail [the desk](mailto:desk@example.com), see [the plan](/trip/plan.md) and [this](javascript:alert(1)), or [Maps](https://maps.example.com/x).';
const LINKS_PLAIN = 'Call the inn (+1-555-0100), mail the desk (desk@example.com), see the plan and this, or Maps.';

test("a link the drawer doesn't open (tel:, mailto:, a path, a script) is drawn by its name and never as a link; an http(s) one still is", () => {
  assert.deepEqual(parseInline(LINKS), [
    { t: 'text', v: 'Call the ' }, { t: 'b', c: [{ t: 'text', v: 'inn' }] }, { t: 'text', v: ' (+1-555-0100), mail the desk (desk@example.com), see the plan and this, or ' },
    { t: 'a', href: 'https://maps.example.com/x', c: [{ t: 'text', v: 'Maps' }] }, { t: 'text', v: '.' },
  ]);
  assert.deepEqual(parseMarkdown(`- ${LINKS}`), [{ t: 'ul', items: [parseInline(LINKS)] }]);
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '/trip/plan.md']) {
    assert.deepEqual(parseInline(`[go](${href})`), [{ t: 'text', v: 'go' }], href);
  }
  // The drawer opens only what an allowlist names (http, https): a scheme a denylist of scripts would pass is never a link either.
  for (const href of ['ftp://a.example.com/x', 'blob:https://a.example.com/1', 'intent://x#Intent;end', 'file:///etc/hosts', 'sms:+15550100']) {
    assert.deepEqual(parseInline(`[go](${href})`), [{ t: 'text', v: 'go' }], href);
    assert.equal(plainWords(`[go](${href})`), 'go', href);
  }
});

test('a phone or mail link named in words reads `name (number or address)`, once, in the drawn line, the card and the voice; the number named already is not said twice', async (t) => {
  for (const [line, words] of [
    ['Call [the hotel](tel:+81-00-0000-0000) now.', 'Call the hotel (+81-00-0000-0000) now.'],
    ['[ホテルに電話](tel:+81-00-0000-0000)してください。', 'ホテルに電話 (+81-00-0000-0000)してください。'],
    ['Call [the inn](tel:+1 555 0100) now.', 'Call the inn (+1 555 0100) now.'],
    ['Write to [the desk](mailto:desk@example.com?subject=Late%20check-in&body=Hi) now.', 'Write to the desk (desk@example.com) now.'],
    ['Call [+81 00 0000 0000](tel:+81000000000) now.', 'Call +81 00 0000 0000 now.'],
    ['Call [0120-00-0000](tel:+81-120-00-0000) now.', 'Call 0120-00-0000 (+81-120-00-0000) now.'], // the name is another form of the number: both are shown
    ['Call [**+81-00-0000-0000**](tel:+81-00-0000-0000) now.', 'Call +81-00-0000-0000 now.'],
    ['Mail [Desk@Example.com](mailto:desk@example.com?subject=x) now.', 'Mail Desk@Example.com now.'],
    ['Mail [the desk at desk@example.com](mailto:desk@example.com) now.', 'Mail the desk at desk@example.com now.'],
    ['Call [the inn](TEL:+1-555-0100) now.', 'Call the inn (+1-555-0100) now.'],
  ]) {
    assert.equal(plainWords(line), words, line);
    const s = await shown(t, line);
    assert.deepEqual(s.cards, [["Shiori's answer", words]], line);
    assert.deepEqual(s.given, [words], line);
  }
  // Drawn as words, never as a link: the drawn line holds the number or address in a text node, and no `a` node.
  assert.deepEqual(parseInline('Call [the **inn**](tel:+1-555-0100) now.'), [{ t: 'text', v: 'Call the ' }, { t: 'b', c: textOnly('inn') }, { t: 'text', v: ' (+1-555-0100) now.' }]);
});

test("a link not drawn that is named by an address draws its name as a link and the voice says it by its site; inside a link's own name it stays text", async (t) => {
  const line = '[https://sample-inn.example.com/rooms](sample-inn.example.com/rooms) and [see https://a.example.com/x](/trip/plan.md)';
  assert.deepEqual(parseInline(line), [
    { t: 'a', href: 'https://sample-inn.example.com/rooms', c: textOnly('https://sample-inn.example.com/rooms') }, { t: 'text', v: ' and see ' },
    { t: 'a', href: 'https://a.example.com/x', c: textOnly('https://a.example.com/x') },
  ]);
  const words = 'sample-inn.example.com and see a.example.com';
  assert.equal(plainWords(line), words);
  const s = await shown(t, line);
  assert.deepEqual(s.cards, [["Shiori's answer", words]]);
  assert.deepEqual(s.given, [words]);
  // A drawn link's name holds no link (a link in a link): its address stays text.
  assert.deepEqual(parseInline('[see https://a.example.com/x](https://b.example.com/y)'), [{ t: 'a', href: 'https://b.example.com/y', c: textOnly('see https://a.example.com/x') }]);
});

test("a link's address may hold a space, never a quote: it is drawn whole; a titled link is left as it was", async (t) => {
  const line = 'See [Big Sur](https://en.wikipedia.org/wiki/Big Sur) or [the inn](tel:+1 555 0100) today.';
  assert.deepEqual(parseInline(line), [
    { t: 'text', v: 'See ' }, { t: 'a', href: 'https://en.wikipedia.org/wiki/Big%20Sur', c: textOnly('Big Sur') }, { t: 'text', v: ' or the inn (+1 555 0100) today.' },
  ]);
  const words = 'See Big Sur or the inn (+1 555 0100) today.';
  assert.equal(plainWords(line), words);
  const s = await shown(t, line);
  assert.deepEqual(s.cards, [["Shiori's answer", words]]);
  assert.deepEqual(s.given, [words]);
  // A title in quotes is no part of the address: the link is not drawn as one with the title in its address, as before.
  const titled = parseInline('[a](https://x.test/p "title") x');
  assert.deepEqual(titled.filter((n) => n.t === 'a').map((n) => /** @type {any} */ (n).href), ['https://x.test/p']);
  assert.equal(plainWords('[a](https://x.test/p "title") x'), '[a](x.test "title") x');
});

test("a link the drawer doesn't open reads by its name on the card at the top and in the voice", async (t) => {
  assert.equal(plainWords(LINKS), LINKS_PLAIN);
  const s = await shown(t, LINKS);
  assert.deepEqual(s.cards, [["Shiori's answer", LINKS_PLAIN]]);
  assert.deepEqual(s.given, [LINKS_PLAIN]);
  assert.deepEqual(s.voiced, [LINKS_PLAIN]);
});

test('***very*** reads as bold italic (a bold may hold italics), and a backslash escape drops its backslash, outside code', async (t) => {
  const text = String.raw`It is ***very*** good, **not *that* far**. Press \*1234# then \*9#, a \_ and a \\, but ` + '`a\\*b`.';
  assert.deepEqual(parseInline(text), [
    { t: 'text', v: 'It is ' }, { t: 'b', c: [{ t: 'i', c: [{ t: 'text', v: 'very' }] }] }, { t: 'text', v: ' good, ' },
    { t: 'b', c: [{ t: 'text', v: 'not ' }, { t: 'i', c: [{ t: 'text', v: 'that' }] }, { t: 'text', v: ' far' }] },
    { t: 'text', v: '. Press *1234# then *9#, a _ and a \\, but ' }, { t: 'code', c: 'a\\*b' }, { t: 'text', v: '.' },
  ]);
  const words = 'It is very good, not that far. Press *1234# then *9#, a _ and a \\, but a\\*b.';
  assert.equal(plainWords(text), words);
  // `\\n` is an escaped backslash and an n, so `\n` as text (with the backslash out of the escape's class, both backslashes would stay).
  assert.deepEqual(parseInline(String.raw`a \\n b`), textOnly('a \\n b'));
  const s = await shown(t, text);
  assert.deepEqual(s.cards, [["Shiori's answer", words]]);
  assert.deepEqual(s.given, [words]);
});
