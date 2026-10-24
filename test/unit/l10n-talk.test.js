import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setWords } from '../../src/core/l10n.js';

// The Conversation, voice and Shiori's screens in Japanese (localization L5c), with the drafts that ship, beside what a model reads
// of the same events: that stays English. annai's words in the Conversation are made at display from an event's data; the words
// stored with it (a wake's reason, a reminder's [annai] line) are the model's, and never translated.

setWords('ja', JSON.parse(await readFile(new URL('../../l10n/ja.json', import.meta.url), 'utf8')));
after(() => setWords('en', null));
// Imported once the words are set, as boot.js sets them before main.js loads: words made at a module's top level are Japanese too.
const { wokeText, reminderLine, announced } = await import('../../src/ui/screens/talk.js');
const { SYSTEM } = await import('../../src/ui/talk-panel.js');
const { sample } = await import('../../src/ui/speech-check.js');
const { speaksScreens } = await import('../../src/ui/format.js');
const { Transcript } = await import('../../src/core/agent/transcript.js');

/** The text of the transcript's last line once an event is applied. @param {any} e */
function lastLine(e) {
  const tr = new Transcript();
  tr.apply({ seq: 1, ...e }, { texts: {}, images: [] });
  return /** @type {any} */ (tr.messages.at(-1)?.parts[0])?.text;
}

test('a wake is shown from its kind in the screens\' words, each kind once; the model reads its reason as given, in English', () => {
  const reasons = [{ kind: 'file', text: 'The user added files: /files/hotel.pdf.' }];
  assert.equal(wokeText(reasons), '追加されたファイルを見るため、Shiori が起動しました。');
  assert.equal(lastLine({ type: 'wake', data: { id: 'w-1', reasons } }), '[annai] The user added files: /files/hotel.pdf.');
  // A plugin's by its name; two kinds are two sentences, side by side with no space in Japanese; a kind annai doesn't know, plainly.
  const plugin = { kind: 'plugin', plugin: 'trail', text: 'the trail closes at dusk' };
  assert.equal(wokeText([plugin, plugin, { kind: 'live', text: 'The user turned GPS on.' }], () => 'Trail'),
    'プラグイン Trail により Shiori が起動しました。GPS がオンになったので、Shiori が起動しました。');
  assert.equal(wokeText([{ kind: 'someday', text: 'Something new.' }]), 'Shiori が起動しました。');
});

test('a reminder line is made from its data, said aloud or not, a reminder or her answer; the model is told in English', () => {
  assert.deepEqual(reminderLine({}), ['リマインダー：', '']);
  assert.deepEqual(reminderLine({ aloud: true }), ['リマインダー（読み上げ）：', '']);
  assert.deepEqual(reminderLine({ title: "Shiori's answer" }), ['Shiori の答え：', '']);
  assert.equal(lastLine({ type: 'reminder', data: { watch: 'w', text: 'Leave at 5.', aloud: true } }),
    '[annai] Shown and said aloud by annai itself, since you couldn\'t be reached: "Leave at 5."');
});

test("the announcer's labels are the screens' words, and her words are left as she said them", () => {
  assert.deepEqual(announced('out.ask', '', 'Where should we eat?', ['Ramen', 'Sushi']), ['Shiori の質問：', 'Where should we eat?', '選択肢：Ramen、Sushi。']);
  assert.deepEqual(announced('out.show', 'Trail', 'Pfeiffer Falls'), ['Shiori（Trail）：', 'Pfeiffer Falls', '']);
  assert.deepEqual(announced('out.show', '', '', [], { image: 'x' }), ['Shiori：', '写真', '']);
});

test("Try this model's instructions stay English for the model; the voice sample is in the screens' language when the user speaks it, else English", () => {
  assert.match(SYSTEM, /^You are a helpful travel assistant inside the annai app\./);
  assert.equal(sample(true), 'こんにちは。あなたと話すときは、こんな声です。');
  assert.equal(sample(false), 'Hello! This is how I sound when I talk to you.');
});

test('words sent as the user\'s are in the screens\' language only when the user speaks it: their Languages, else the phone\'s (the user, 2026-10-24)', () => {
  assert.equal(speaksScreens({ languages: { spoken: ['en', 'ja'] } }), true);
  assert.equal(speaksScreens({ languages: { spoken: ['en'] } }), false);
  assert.equal(speaksScreens({}), /^ja\b/.test(navigator.language));
});
