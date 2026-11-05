import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { lineKind } from '../../src/ui/line-kind.js';

// One rule for what a line of the Conversation is (the second-drive design, section 1), each row of its table read from a stored
// event's shape, old ones too: the words say it, the tint only assists.
const by = { name: 'Model One', first: null, tried: false };
/** @param {string} type @param {any} data */
const of = (type, data) => {
  const l = /** @type {NonNullable<ReturnType<typeof lineKind>>} */ (lineKind({ type, data }));
  return [l.kind, l.tint, l.icon, l.label];
};

for (const [name, type, data, want] of /** @type {[string, string, any, any[]][]} */ ([
  ['typed', 'msg.user', { text: 'hello' }, ['typed', '', 'keyboard', 'typed']],
  ['typed to Koe', 'msg.user', { text: 'hello', split: true }, ['typed', '', 'keyboard', 'typed']],
  ['typed, as the answer to an ask', 'msg.user', { text: 'hello', answer: 'c1' }, ['typed', '', 'keyboard', 'typed']],
  ['a tapped choice', 'msg.user', { text: 'Yes', chose: true }, ['tapped', '', '', 'tapped']],
  ['only a photo: nothing was typed', 'msg.user', { text: '(a photo)', images: [{}] }, ['sent', '', '', '']],
  ['only files handed over: nothing was typed', 'msg.user', { text: '(files)', handed: [{}] }, ['sent', '', '', '']],
  ['a claim draws as spoken', 'msg.user', { text: 'that was me', claim: 'h1' }, ['spoken', 'blue', 'mic', 'spoken']],
  ['spoken, dictation', 'heard', { id: 'h', source: 'dictation', text: 'hi' }, ['spoken', 'blue', 'mic', 'spoken · phone dictation']],
  ['spoken, live', 'heard', { id: 'h', source: 'live', text: 'hi' }, ['spoken', 'blue', 'mic', 'spoken · live voice']],
  ['spoken, other: a transcribed clip', 'heard', { id: 'h', source: 'mic', text: 'hi' }, ['spoken', 'blue', 'mic', 'spoken']],
  ['spoken, no source at all', 'heard', { id: 'h', text: 'hi' }, ['spoken', 'blue', 'mic', 'spoken']],
  ['words still coming', 'heard', { id: 'h', source: 'mic' }, ['hearing', '', 'mic', 'hearing you']],
  ['words still coming, even if dismissed', 'heard', { id: 'h', source: 'mic', dismissed: true }, ['hearing', '', 'mic', 'hearing you']],
  ['live, unanswered, as live.js stores it', 'heard', { id: 'h', source: 'live', text: 'la la', dismissed: true, gate: 'chatter' }, ['unanswered', '', 'ear', "heard · she didn't answer"]],
  ['the gate judged a clip', 'heard', { id: 'h', source: 'mic', text: 'hi', dismissed: true, gate: 'chatter' }, ['judged', '', 'ear', 'heard · judged not for her']],
  ['the gate judged dictation', 'heard', { id: 'h', source: 'dictation', text: 'hi', dismissed: true }, ['judged', '', 'ear', 'heard · judged not for her']],
  ['Koe live', 'out.speak', { live: true, voice: true, half: 'koe', by }, ['koe-live', 'teal', 'wave', 'Koe · live · Model One']],
  ['Koe live, stored with by: null', 'out.speak', { live: true, voice: true, half: 'koe', by: null }, ['koe-live', 'teal', 'wave', 'Koe · live']],
  ['Koe said aloud', 'out.speak', { half: 'koe', voice: true, by }, ['koe-aloud', 'blue', 'wave', 'Koe · said aloud · Model One']],
  ['Koe said aloud, no model', 'out.speak', { half: 'koe', voice: true, by: null }, ['koe-aloud', 'blue', 'wave', 'Koe · said aloud']],
  ['Koe, text', 'out.speak', { half: 'koe', by }, ['koe-text', '', 'text', 'Koe · text · Model One']],
  ['Kokoro directly', 'out.speak', { half: 'kokoro', by }, ['kokoro', 'violet', 'text', 'Kokoro directly · Model One']],
  ['Kokoro directly, aloud', 'out.speak', { half: 'kokoro', voice: true, by }, ['kokoro', 'violet', 'wave', 'Kokoro directly · Model One']],
  ['Kokoro directly, no model', 'out.speak', { half: 'kokoro' }, ['kokoro', 'violet', 'text', 'Kokoro directly']],
  ['one half', 'out.speak', { by }, ['one', '', '', 'Model One']],
  ['one half, said aloud', 'out.speak', { voice: true, by }, ['one', '', '', 'said aloud · Model One']],
  ['one half, said aloud, an old line', 'out.speak', { voice: true }, ['one', '', '', 'said aloud']],
  ['one half, an old line with no model', 'out.speak', {}, ['one', '', '', '']],
  ['one half, by: null', 'out.speak', { by: null }, ['one', '', '', '']],
  ['Kokoro\'s words said aloud', 'reminder', { answer: true, aloud: true, text: 'x' }, ['kokoros-words', 'violet', '', "Kokoro's words · said aloud"]],
  ['Kokoro\'s words shown', 'reminder', { answer: true, text: 'x' }, ['kokoros-words', 'violet', '', "Kokoro's words · shown"]],
  ['Kokoro\'s words, an older line by its title', 'reminder', { title: "Shiori's answer", text: 'x' }, ['kokoros-words', 'violet', '', "Kokoro's words · shown"]],
  ['a reminder said aloud', 'reminder', { watch: 'w1', text: 'x', aloud: true }, ['reminder', 'amber', '', 'annai · said aloud']],
  ['a reminder shown', 'reminder', { watch: 'w1', text: 'x' }, ['reminder', 'amber', '', 'annai · shown']],
  ['a card takes its half\'s tint and label', 'out.show', { half: 'kokoro', card: {}, by }, ['kokoro', 'violet', 'text', 'Kokoro directly · Model One']],
  ['Koe\'s card', 'out.show', { half: 'koe', card: {}, by }, ['koe-text', '', 'text', 'Koe · text · Model One']],
  ['one half\'s card', 'out.show', { card: {}, by }, ['one', '', '', 'Model One']],
  ['an ask takes its half\'s tint and label', 'out.ask', { half: 'kokoro', question: 'q', by }, ['kokoro', 'violet', 'text', 'Kokoro directly · Model One']],
  ['Koe\'s ask', 'out.ask', { half: 'koe', question: 'q', by: null }, ['koe-text', '', 'text', 'Koe · text']],
])) {
  test(`a line: ${name}`, () => assert.deepEqual(of(type, data), want));
}

test('a line names the model as it always has when another answered', () => {
  assert.equal(of('out.speak', { half: 'koe', by: { name: 'B', first: 'A', tried: true } })[3], "Koe · text · B · A didn't answer");
  assert.equal(of('out.speak', { by: { name: 'B', first: 'A', tried: false } })[3], 'B · instead of A');
  assert.equal(of('out.speak', { by: { name: 'A', first: 'A', tried: false } })[3], 'A');
});

test('anything else is not one of these lines', () => {
  assert.equal(lineKind({ type: 'wake', data: {} }), null);
  assert.equal(lineKind({ type: 'note', data: {} }), null);
});

/** WCAG's contrast of two #rrggbb colours. @param {string} a @param {string} b */
function contrast(a, b) {
  const lum = (/** @type {string} */ c) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('every label stays readable (4.5:1) on every wash, in both themes; the washes are the design\'s', async () => {
  const css = await readFile(new URL('../../src/ui/tokens.css', import.meta.url), 'utf8');
  const [light, dark] = css.split('@media (prefers-color-scheme: dark)');
  const tokens = (/** @type {string} */ s) => Object.fromEntries([...s.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
  const themes = { light: tokens(light), dark: tokens(dark) };
  assert.deepEqual(['teal-wash', 'teal-line', 'blue-wash', 'blue-line', 'violet-wash', 'violet-line'].map((k) => themes.light[k]), ['#f0f8f6', '#d3e8e4', '#f1f5fc', '#d9e3f4', '#f5f1fb', '#e3daf3']);
  assert.deepEqual(['teal-wash', 'teal-line', 'blue-wash', 'blue-line', 'violet-wash', 'violet-line'].map((k) => themes.dark[k]), ['#18252a', '#27393c', '#1a2230', '#2b3648', '#201d2e', '#352f49']);
  // What sits on what: the label's and the SHIORI line's words on every bubble, the quiet lines' on the page, a reminder's on its amber.
  const pairs = [
    ...['ai-wash', 'sheet', 'teal-wash', 'blue-wash', 'violet-wash', 'paper'].flatMap((bg) => [['ink-2', bg], ['ink', bg]]),
    ...['sheet', 'teal-wash', 'blue-wash', 'violet-wash'].map((bg) => ['ai', bg]),
    ['ai', 'paper'], // This was for Shiori
    ['amber', 'amber-wash'], ['ink', 'amber-wash'],
  ];
  for (const [name, t] of Object.entries(themes)) {
    for (const [fg, bg] of pairs) {
      const ratio = contrast(t[fg], t[bg]);
      assert.ok(ratio >= 4.5, `${name}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
});
