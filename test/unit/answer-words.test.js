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

// watch-words-next: a reminder without the answer flag (Shiori's own watch) reads as plain words too, by the same rule (plan-watches.js plainReminder); the
// rest of its places are in watch-words.test.js.
test("a reminder without the answer flag reads as plain words in the card and the voice too, a code's stars kept", async (t) => {
  const s = await shown(t, 'Show code *1234* at the **gate**.', { answer: false });
  assert.deepEqual(s.cards, [['Reminder', 'Show code *1234* at the gate.']]);
  assert.deepEqual(s.given, ['Show code *1234* at the gate.']);
  assert.deepEqual(s.line, ['Show code *1234* at the **gate**.']);
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
// parser reads a star by the whitespace half of CommonMark's flanking rule and by a digit rule (a star straight before a digit or `#` neither opens italics nor closes
// them), a bold as what is between its `**`, and a link it doesn't draw by its name (a phone or mail link with its number or address). Its nodes are what every line and card draws (src/ui/markdown.js:
// text, strong, em, code, and a link only to an http(s) address); plainWords' words are the card at the top and the voice. Numbers and places are made up.

/** @param {string} v */
const textOnly = (v) => [{ t: 'text', v }];

const CODES = 'Press *1234# at the gate, then *9#. Dial *67 then *82 for the **front** desk, not the *side* one.';
const CODES_PLAIN = 'Press *1234# at the gate, then *9#. Dial *67 then *82 for the front desk, not the side one.';

test('two star codes on one line keep their stars in the drawn line (inline and block), and **bold** and *italic* beside them still draw', () => {
  const drawn = [{ t: 'text', v: 'Press *1234# at the gate, then *9#. Dial *67 then *82 for the ' }, { t: 'b', c: [{ t: 'text', v: 'front' }] },
    { t: 'text', v: ' desk, not the ' }, { t: 'i', c: [{ t: 'text', v: 'side' }] }, { t: 'text', v: ' one.' }];
  assert.deepEqual(parseInline(CODES), drawn);
  assert.deepEqual(parseMarkdown(CODES), [{ t: 'p', c: drawn }]);
  assert.deepEqual(parseInline('Dial *67 then *82'), [{ t: 'text', v: 'Dial *67 then *82' }]);
  // A `_` inside a word is none, as before (the half-rule lines, a space on one side each, are in a test of their own below).
  assert.deepEqual(parseInline('a ** b ** c and _d _ e, snake_case_name'), [{ t: 'text', v: 'a ** b ** c and _d _ e, snake_case_name' }]);
  // A `_` opens only at the start of a word and closes only at its end, so `_side_door` and `foo_bar_` hold no italics.
  assert.deepEqual(parseInline('_side_door and foo_bar_ baz'), textOnly('_side_door and foo_bar_ baz'));
  assert.equal(plainWords('_side_door and foo_bar_ baz'), '_side_door and foo_bar_ baz');
});

// Fable's table (the final review of star-codes-next) and the rows of the re-review after it: a code's star is no italic's, with no space before it (Japanese and Chinese),
// with a star inside the code, several to a line, in a bold, and next to an italic that starts or ends at a digit (its stars show: the digit rule's cost). Each line
// reads as written, in the drawn line (one text node) and as plain words.
test("a code's stars stay with no space before them, with a star inside, several to a line, and next to an italic at a digit; such italics show their stars", () => {
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
    // The re-review's rows: an italic that starts with a digit, closed before a code's star in text with no spaces (its closing star once paired with the code's).
    '駅から*5分*、門で*1234#を押してください。',
    '*2泊*で、暗証番号は*1234#です。',
    '*5分*後に*1234#を押す',
    '※ *印の番号は*1234#です',
    '※ *印の番号は*#06#です', // a `#` straight after a star is a code's too: it closes nothing
    // An italic that ends straight before a digit shows its stars too (the digit rule's other cost), and so do two digit-led ones side by side.
    '入場料は*大人*1000円',
    '*10 min*/*15 min*',
    '*1日目*：京都、*2日目*：奈良',
    // Runs of stars that hold nothing (a masked number, a rule) stay as written, though three stars close a bold when a word comes before them.
    'Card ***1234 and ***5678, PIN *****1234.',
    '*** ***',
    // Full-width digits count as digits.
    'ゲートは*１２３４#です。次に*９#',
    'ゲートは*１２３４*です。',
    '入場料は*大人*１０００円',
  ]) {
    assert.deepEqual(parseInline(line), textOnly(line), line);
    assert.equal(plainWords(line), line, line);
  }
  // The same row with an italic at a word and more after it: the code's star is kept; where the italics land next to `*15:00*` is not pinned (a known shape: the
  // closing star of an italic the digit rule doesn't read can pair with the next star on the line).
  const row = 'チェックインは*15:00*から、*重要*：鍵は*9#の箱';
  assert.ok(plainWords(row).endsWith('鍵は*9#の箱'), row);
  assert.ok(/** @type {any} */ (parseInline(row).at(-1)).v.endsWith('鍵は*9#の箱'), row);
  // A code and an emphasis on one line: the code keeps its stars, the emphasis draws.
  const mixed = 'ゲートは*1234#です。*重要*な番号です。';
  assert.deepEqual(parseInline(mixed), [{ t: 'text', v: 'ゲートは*1234#です。' }, { t: 'i', c: textOnly('重要') }, { t: 'text', v: 'な番号です。' }]);
  assert.equal(plainWords(mixed), 'ゲートは*1234#です。重要な番号です。');
  // A code in a bold, the entry's own line in one, a star that opens nothing in one, and two codes in one: the bold draws and holds the stars as text.
  for (const [line, inner] of [['**Gate code: *1234#**', 'Gate code: *1234#'], ['**Press *1234# at the gate, then *9#.**', 'Press *1234# at the gate, then *9#.'], ['**3 * 4 = 12**', '3 * 4 = 12'], ['**ゲート*1234#*9#**', 'ゲート*1234#*9#']]) {
    assert.deepEqual(parseInline(line), [{ t: 'b', c: textOnly(inner) }], line);
    assert.equal(plainWords(line), inner, line);
  }
  assert.deepEqual(parseInline('**Gate code: *1234#** and *side*'), [{ t: 'b', c: textOnly('Gate code: *1234#') }, { t: 'text', v: ' and ' }, { t: 'i', c: textOnly('side') }]);
});

// A bold is what lies between its `**` (it closes at the first `**` after it, and only when no space stands before that `**`; of three stars, on the last two), whatever stars it holds: an italic that starts with a
// digit inside a bold shows its stars and the bold still draws, and a star that pairs with nothing is text. (A bold's inside is read again by the italic rules.)
test("a bold holds the stars of a digit-led italic, a code or a lone star as text, and closes at its own `**`", () => {
  for (const [line, inner, after] of [
    ['**Gate *1234*, then** wait', 'Gate *1234*, then', ' wait'],
    ['**Gate *1234*.** Thanks', 'Gate *1234*.', ' Thanks'],
    ['**今日は*5分*です**', '今日は*5分*です', ''],
    ['**ゲートは*1234*です。**', 'ゲートは*1234*です。', ''],
    ['**Note: *important** and more', 'Note: *important', ' and more'],
    ['**a *b * c**', 'a *b * c', ''], // a star after a space closes no italic, in a bold too
  ]) {
    assert.deepEqual(parseInline(line), [{ t: 'b', c: textOnly(inner) }, ...(after ? [{ t: 'text', v: after }] : [])], line);
    assert.equal(plainWords(line), inner + after, line);
  }
  // Its own italics inside still draw, and three stars close on the last two.
  assert.deepEqual(parseInline('**a *b* c**'), [{ t: 'b', c: [{ t: 'text', v: 'a ' }, { t: 'i', c: textOnly('b') }, { t: 'text', v: ' c' }] }]);
  assert.deepEqual(parseInline('***very***'), [{ t: 'b', c: [{ t: 'i', c: textOnly('very') }] }]);
  assert.deepEqual(parseInline('**a**b**c**'), [{ t: 'b', c: textOnly('a') }, { t: 'text', v: 'b' }, { t: 'b', c: textOnly('c') }]);
  assert.deepEqual(parseInline('**a****b**'), [{ t: 'b', c: textOnly('a') }, { t: 'b', c: textOnly('b') }]);
  // A lone star inside a bold is text, whatever follows it, and the bold closes at its own `**`.
  assert.deepEqual(parseInline('**a * b*c**'), [{ t: 'b', c: textOnly('a * b*c') }]);
  assert.deepEqual(parseInline('**a *3 b*c**'), [{ t: 'b', c: textOnly('a *3 b*c') }]);
});

test("an italic after a code, or after an italic the digit rule doesn't read, still draws where her stars pair: the code's star (before `#` too) and the digit-led pair stay as written", () => {
  assert.deepEqual(parseInline('*#06#で確認、*重要*です'), [{ t: 'text', v: '*#06#で確認、' }, { t: 'i', c: textOnly('重要') }, { t: 'text', v: 'です' }]);
  assert.deepEqual(parseInline('*大人*1000円、*重要*です'), [{ t: 'text', v: '*大人*1000円、' }, { t: 'i', c: textOnly('重要') }, { t: 'text', v: 'です' }]);
  assert.deepEqual(parseInline('*67 to hide,*重要*'), [{ t: 'text', v: '*67 to hide,' }, { t: 'i', c: textOnly('重要') }]);
});

test('a mark with a space on its inner side neither opens nor closes: each half of the rule, on a line of its own', () => {
  for (const line of ['a **b ** c', 'a ** b** c', '_ d_ e', '_d _ e', '* a* b', 'a * b* c']) {
    assert.deepEqual(parseInline(line), textOnly(line), line);
    assert.equal(plainWords(`ok ${line}`), `ok ${line}`, line); // a line that starts with `* ` is a bullet; the others, too, after a word
  }
  assert.equal(plainWords('* a* b'), 'a* b', 'a line of its own that starts with `* ` is a bullet');
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

test("a link the drawer doesn't open (tel:, mailto:, a path, a script) is never drawn as a link: it reads by its name (a phone or mail link with its number or address); an http(s) one still is drawn", () => {
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

test('a phone or mail link named in words reads `name (number or address)` in the plain words, the card and the voice, and drawn as words, never a link; the number the name holds already is not said twice', async (t) => {
  for (const [line, words] of [
    ['Call [the hotel](tel:+81-00-0000-0000) now.', 'Call the hotel (+81-00-0000-0000) now.'],
    ['[ホテルに電話](tel:+81-00-0000-0000)してください。', 'ホテルに電話 (+81-00-0000-0000)してください。'],
    ['Call [the inn](tel:+1 555 0100) now.', 'Call the inn (+1 555 0100) now.'],
    ['Write to [the desk](mailto:desk@example.com?subject=Late%20check-in&body=Hi) now.', 'Write to the desk (desk@example.com) now.'],
    ['Write to [the desk](mailto:desk@example.com?subject=Late check-in) now.', 'Write to the desk (desk@example.com) now.'], // a space in a mail link's subject: still the link
    ['Call [+81 00 0000 0000](tel:+81000000000) now.', 'Call +81 00 0000 0000 now.'],
    ['Call [0120-00-0000](tel:+81-120-00-0000) now.', 'Call 0120-00-0000 (+81-120-00-0000) now.'], // the name is another form of the number: both are shown
    ['Call [**+81-00-0000-0000**](tel:+81-00-0000-0000) now.', 'Call +81-00-0000-0000 now.'],
    ['Mail [Desk@Example.com](mailto:desk@example.com?subject=x) now.', 'Mail Desk@Example.com now.'],
    ['Mail [the desk at desk@example.com](mailto:desk@example.com) now.', 'Mail the desk at desk@example.com now.'],
    ['Call [the inn](TEL:+1-555-0100) now.', 'Call the inn (+1-555-0100) now.'],
    ['Call [+1 555 0100](TEL:+1-555-0100) now.', 'Call +1 555 0100 now.'], // a capital scheme is a phone link too (with no space in its number): its number is held by the name
    ['[ホテル](tel:０３－１２３４－５６７８)に電話。', 'ホテル (０３－１２３４－５６７８)に電話。'], // full-width digits are digits: a name with none doesn't hold the number
    ['Call [０３－１２３４－５６７８](tel:０３－１２３４－５６７８) now.', 'Call ０３－１２３４－５６７８ now.'],
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

test("a link's address may hold a space, never before a quote; words in parentheses after a bracket are no link unless it is http(s), tel: or mailto:", async (t) => {
  const line = 'See [Big Sur](https://en.wikipedia.org/wiki/Big Sur) or [the inn](tel:+1 555 0100) today.';
  assert.deepEqual(parseInline(line), [
    { t: 'text', v: 'See ' }, { t: 'a', href: 'https://en.wikipedia.org/wiki/Big%20Sur', c: textOnly('Big Sur') }, { t: 'text', v: ' or the inn (+1 555 0100) today.' },
  ]);
  const words = 'See Big Sur or the inn (+1 555 0100) today.';
  assert.equal(plainWords(line), words);
  const s = await shown(t, line);
  assert.deepEqual(s.cards, [["Shiori's answer", words]]);
  assert.deepEqual(s.given, [words]);
  // A title in quotes, double or single, is no part of the address: the link is half drawn, with the address (the right page) and the title as words, as before.
  for (const [titled, words] of [['[a](https://x.test/p "title") x', '[a](x.test "title") x'], ["[a](https://x.test/p 'title') x", "[a](x.test 'title') x"], ["[a](https://x.test/p (a 'b')) x", "[a](x.test (a 'b')) x"]]) {
    assert.deepEqual(parseInline(titled).filter((n) => n.t === 'a').map((n) => /** @type {any} */ (n).href), ['https://x.test/p'], titled);
    assert.equal(plainWords(titled), words, titled);
  }
  // An apostrophe in an address is no title's quote (no space before it): one link, the page it names.
  assert.deepEqual(parseInline("[Hell's Kitchen](https://en.wikipedia.org/wiki/Hell's_Kitchen) is a district."), [
    { t: 'a', href: "https://en.wikipedia.org/wiki/Hell's_Kitchen", c: textOnly("Hell's Kitchen") }, { t: 'text', v: ' is a district.' },
  ]);
  assert.equal(plainWords("[Hell's Kitchen](https://en.wikipedia.org/wiki/Hell's_Kitchen) is a district."), "Hell's Kitchen is a district.");
  // Words in parentheses right after a bracket, with a space in them, are words as written unless the address is http(s), tel: or mailto: (a bare address inside is still one).
  for (const line of ['She wrote [sic](and then left) here.', '[Optional](if time permits): the museum.', 'Go to [see](Tokyo station) first.']) {
    assert.deepEqual(parseInline(line), textOnly(line), line);
    assert.equal(plainWords(line), line, line);
  }
  assert.deepEqual(parseInline('[source](see https://x.test/a for details)'), [
    { t: 'text', v: '[source](see ' }, { t: 'a', href: 'https://x.test/a', c: textOnly('https://x.test/a') }, { t: 'text', v: ' for details)' },
  ]);
  assert.equal(plainWords('[source](see https://x.test/a for details)'), '[source](see x.test for details)');
});

test("a link the drawer doesn't open reads by its name (a phone or mail link with its number or address) on the card at the top and in the voice", async (t) => {
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
  // An escaped code's star closes no italic opened before it (it once read `Press \1234# to open*`, a wrong code): the stars stay, the escape's backslash goes.
  assert.deepEqual(parseInline(String.raw`*Press \*1234# to open*`), textOnly('*Press *1234# to open*'));
  // `\\n` is an escaped backslash and an n, so `\n` as text (with the backslash out of the escape's class, both backslashes would stay).
  assert.deepEqual(parseInline(String.raw`a \\n b`), textOnly('a \\n b'));
  const s = await shown(t, text);
  assert.deepEqual(s.cards, [["Shiori's answer", words]]);
  assert.deepEqual(s.given, [words]);
});
