import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setWords, t } from '../../src/core/l10n.js';
import { sentences, asSentence } from '../../src/core/intl.js';
import { Registry } from '../../src/core/registry.js';
import { startCards } from '../../src/ui/plugin-cards.js';
import { applyUpdates } from '../../src/ui/plugin-updates.js';
import { micProblem } from '../../src/core/voice/mic.js';
import { errorWords, announced, sourceOf } from '../../src/ui/screens/talk.js';
import { testLive } from '../../src/core/realtime/open.js';
import { recapError } from '../../src/core/after/recap.js';
import { AllFailedError } from '../../src/core/llm/fallback.js';
import { liveKit, at, MONTEREY } from './live-kit.js';

// Outside words end as sentences at the source (the Deferred entry closed by sentences-next): sentences() ends every part but the
// last itself, so a plugin's or a provider's own words never run into the next sentence and no caller has to remember to end them; a
// blank error has a sentence of its own; and on Japanese and Chinese screens a Latin end keeps its space before a Latin start.

/** @type {Record<string, Record<string, any>>} the words that ship */
const WORDS = {};
for (const tag of ['ja', 'zh-Hans', 'zh-Hant']) WORDS[tag] = JSON.parse(await readFile(new URL(`../../l10n/${tag}.json`, import.meta.url), 'utf8'));
/** The screens in a language, with the words that ship. @param {string} tag */
const screens = (tag) => setWords(tag, tag === 'en' ? null : WORDS[tag]);
afterEach(() => setWords('en', null));

test("sentences ends every part but the last as a sentence: a plugin's words with no stop of their own no longer run into the next one", () => {
  // The cards and lines the entry named, as they join (provider.js's toast, import.js's restore lines, auto-backup.js's card, voice.js's test).
  assert.equal(sentences('Roles updated.', "Tide pools couldn't be switched on: boom", "Rock pools couldn't be switched on: fail"),
    "Roles updated. Tide pools couldn't be switched on: boom. Rock pools couldn't be switched on: fail", 'the last part is left as it is');
  assert.equal(sentences('Tide pools: boom', 'Rock pools: fail'), 'Tide pools: boom. Rock pools: fail');
  assert.equal(sentences('the server answered 500', 'Open Backups to fix it.'), 'the server answered 500. Open Backups to fix it.');
  assert.equal(sentences("Voice A couldn't speak: boom", 'Spoken by Voice B.'), "Voice A couldn't speak: boom. Spoken by Voice B.");
  // trip.js's and offline-pack.js's own stop turned "Really?" into "Really." and put one after a 。; now the words keep their own end.
  assert.equal(sentences('Really?', 'Nothing was removed. Try again.'), 'Really? Nothing was removed. Try again.');
  assert.equal(sentences('wait…', 'What came is kept. Try again in a moment.'), 'wait… What came is kept. Try again in a moment.');
  // A part with only spaces is no sentence, and a last part keeps its own end (a status line has none).
  assert.equal(sentences('Last backup 2 hours ago.', ' \n', 'Automatic backups are off'), 'Last backup 2 hours ago. Automatic backups are off');
  assert.equal(sentences('Automatic backups are off', ' '), 'Automatic backups are off', 'a blank last part leaves the one before it last');
  for (const tag of ['ja', 'zh-Hans', 'zh-Hant']) {
    screens(tag);
    assert.equal(sentences('boom', '「設定」でオフにできます。'), 'boom。「設定」でオフにできます。', tag);
    assert.equal(sentences('请检查文档。', '请在设置中调低。'), '请检查文档。请在设置中调低。', `${tag}: a 。 of its own gets no second stop`);
    assert.equal(sentences('Tide pools：boom', 'Rock pools：fail'), 'Tide pools：boom。Rock pools：fail', tag);
  }
});

test('on Japanese and Chinese screens, a Latin end before a Latin start keeps its space; anywhere else the language joins as before', () => {
  for (const tag of ['ja', 'zh-Hans', 'zh-Hant']) {
    screens(tag);
    // A provider's own words ending in their own stop, then a model's or a plugin's name (the recap's card, the failed-updates card).
    assert.equal(sentences('GPT-5：Rate limit reached for gpt-5. Please try again in 20s.', 'Haiku：Overloaded。'), 'GPT-5：Rate limit reached for gpt-5. Please try again in 20s. Haiku：Overloaded。', tag);
    assert.equal(sentences('Tide pools：HTTP 404 Not Found.', 'Rock pools：fail'), 'Tide pools：HTTP 404 Not Found. Rock pools：fail', tag);
    assert.equal(sentences('Tide pools：wait…', 'Rock pools：fail'), 'Tide pools：wait… Rock pools：fail', tag);
    assert.equal(sentences('Tide pools：Really?', 'Rock pools：fail'), 'Tide pools：Really? Rock pools：fail', tag);
    assert.equal(sentences('Tide pools：Is it "done?"', 'Rock pools：fail'), 'Tide pools：Is it "done?" Rock pools：fail', `${tag}: after a closing quote too`);
    assert.equal(sentences('Tide pools：wait...', 'Rock pools：fail'), 'Tide pools：wait... Rock pools：fail', `${tag}: three dots are a Latin end`);
    assert.equal(sentences('Tide pools：Not Found.', '(code 404) Retry.'), 'Tide pools：Not Found. (code 404) Retry.', `${tag}: a Latin start after a bracket`);
    // A digit ends and starts a Latin word too ("HTTP 404.", "3 models failed"), and a closer may sit between the letter and the stop:
    // OpenAI's refusal of a value ends "…and 'high'.", a plugin's words in a bracket or a code span end "(see docs)." or "`x`.".
    assert.equal(sentences('Tide pools：HTTP 404.', 'Rock pools：fail'), 'Tide pools：HTTP 404. Rock pools：fail', `${tag}: a digit end`);
    assert.equal(sentences('Tide pools：wait.', '3 models failed'), 'Tide pools：wait. 3 models failed', `${tag}: a digit start`);
    for (const said of ["Supported values are: 'low', 'medium', and 'high'.", 'Fix it (see docs).', 'It is at 100%.', 'Run `x`.', 'Error [E42].', 'He said "done".', 'It was ‘done’.']) {
      assert.equal(sentences(said, 'Haiku：Overloaded。'), `${said} Haiku：Overloaded。`, `${tag}: ${said}`);
    }
    // Joined as the language joins them: a 。 before a Latin name, a Latin stop before Japanese or Chinese, an ellipsis after Japanese.
    assert.equal(sentences('Tide pools：boom。', 'Rock pools：fail'), 'Tide pools：boom。Rock pools：fail', tag);
    assert.equal(sentences('Not Found.', '「設定」でオフにできます。'), 'Not Found.「設定」でオフにできます。', tag);
    assert.equal(sentences('待っています…', 'Rock pools：fail'), '待っています…Rock pools：fail', tag);
    assert.equal(sentences('止まりました！', 'OK'), '止まりました！OK', `${tag}: a full-width end is no Latin end`);
  }
  screens('en');
  assert.equal(sentences('in 20s.', 'Haiku: Overloaded.'), 'in 20s. Haiku: Overloaded.');
});

test("the recap's \"No model could write it\" card: a provider's words that end in their own stop keep a space before the next model's name, in Japanese and Chinese", () => {
  const e = new AllFailedError([
    { model: 'm-0', name: 'GPT-5', outcome: 'rate-limit', ms: 1, error: 'Rate limit reached for gpt-5. Please try again in 20s.' },
    { model: 'm-1', name: 'Haiku', outcome: 'server', ms: 1, error: 'Overloaded' },
  ]);
  screens('ja');
  assert.match(recapError(e), /Please try again in 20s\. Haiku：Overloaded。/);
  screens('zh-Hans');
  assert.match(recapError(e), /Please try again in 20s\. Haiku：Overloaded。/);
  screens('en');
  assert.match(recapError(e), /^No model could write it\. GPT-5: Rate limit reached for gpt-5\. Please try again in 20s\. Haiku: Overloaded\. Check Settings → Models, then try again\.$/);
});

/** A start that throws, as the registry frames it. @param {Error} error */
const startError = (error) => new Registry().guard('hello', 'starting', () => { throw error; })().catch((e) => e);

test('a plugin whose start throws an empty error: "Starting failed." on the start cards and the install screen, never "Starting failed:."', async () => {
  const name = () => 'Hello checks';
  const blank = await startError(new Error(''));
  assert.equal(blank.shown, 'Starting failed.');
  assert.equal(startCards([{ id: 'hello', error: blank }], { name, taken: true }).cards[0].body, 'Starting failed. You can turn it off in Settings → Plugins.');
  assert.equal((await startError(new Error(' \n'))).shown, 'Starting failed.', 'only spaces are no words');
  // Words of its own keep the frame, ended once.
  assert.equal((await startError(new Error('boom'))).shown, 'Starting failed: boom.');
  assert.equal((await startError(new Error('Really?'))).shown, 'Starting failed: Really?');
  for (const [tag, said] of [['ja', '起動に失敗しました。'], ['zh-Hans', '启动失败。'], ['zh-Hant', '啟動失敗。']]) {
    screens(tag);
    const error = await startError(new Error(''));
    assert.equal(error.shown, said, tag);
    assert.ok(startCards([{ id: 'hello', error }], { name, taken: true }).cards[0].body.startsWith(said), tag);
  }
  // The install screen's card ("installed, but it didn't start").
  screens('en');
  const { installPending } = await import('../../src/ui/screens/plugin-install.js');
  const { setPendingPackage } = await import('../../src/ui/plugin-pending.js');
  /** @type {any[]} */
  const cards = [];
  setPendingPackage(/** @type {any} */ ({ files: new Map(), pkg: { id: 'hello', name: 'Hello checks' }, from: { source: 'official' } }));
  const ctx = { plugins: { install: async () => {}, installed: async () => ({ hello: { enabled: true } }), needsRestart: () => false, start: async () => { throw blank; } }, notices: { card: (/** @type {any} */ c) => cards.push(c), toast() {} }, go() {} };
  await installPending(ctx, [], {});
  assert.equal(cards[0].body, 'Starting failed. You can turn it off or remove it in Settings → Plugins.');
});

/** The failed-updates card for two address plugins whose updates throw these, in turn. @param {Error[]} errors */
async function failedCard(errors) {
  let n = 0;
  const host = new Proxy({}, { get: () => () => { throw errors[n++]; } });
  /** @type {any[]} */
  const cards = [];
  const ctx = { plugins: host, notices: { card: (/** @type {any} */ c) => { cards.push(c); return () => {}; }, toast: () => {} } };
  const fail = async () => { throw new Error('not asked'); };
  const updates = /** @type {any} */ ([{ id: 'a', name: 'Tide pools', url: 'https://x.example/a', added: null }, { id: 'b', name: 'Rock pools', url: 'https://x.example/b', added: null }]);
  await applyUpdates(/** @type {any} */ (ctx), updates, /** @type {any} */ ({ addressFetch: fail, fetch: fail }));
  assert.equal(n, 2);
  return cards[0].body;
}

test('a failed update with an empty error gets a line of its own, never "Tide pools:."; on Japanese and Chinese screens a Latin end keeps its space before the next name', async () => {
  assert.equal(await failedCard([new Error(''), new Error('fail')]), 'Tide pools failed with an unknown error. Rock pools: fail.');
  assert.equal(await failedCard([new Error('HTTP 404 Not Found.'), new Error(' ')]), 'Tide pools: HTTP 404 Not Found. Rock pools failed with an unknown error.');
  screens('ja');
  assert.equal(await failedCard([new Error('HTTP 404 Not Found.'), new Error('fail')]), 'Tide pools：HTTP 404 Not Found. Rock pools：fail。');
  assert.equal(await failedCard([new Error(''), new Error('fail')]), 'Tide poolsは原因不明のエラーでアップデートできませんでした。Rock pools：fail。');
  screens('zh-Hans');
  assert.equal(await failedCard([new Error('HTTP 404 Not Found.'), new Error('')]), 'Tide pools：HTTP 404 Not Found. Rock pools 因未知错误未能更新。');
  screens('zh-Hant');
  assert.equal(await failedCard([new Error('wait…'), new Error('')]), 'Tide pools：wait… Rock pools 因未知的錯誤而未能更新。');
});

test("the microphone's card: the browser's or a plugin's words keep their own end, an ellipsis and a quote too, and no words make no sentence", () => {
  const body = (/** @type {string} */ message) => micProblem(new Error(message), 'ios').body;
  const again = 'Try again; if it keeps happening, restart annai.';
  assert.equal(body('boom'), `boom. ${again}`);
  assert.equal(body('wait…'), `wait… ${again}`);
  assert.equal(body('He said "Really?"'), `He said "Really?" ${again}`);
  assert.equal(body(''), again);
  screens('ja');
  assert.equal(body('wait…'), 'wait…もう一度お試しください。繰り返し起きる場合は、annaiを再起動してください。');
  assert.equal(body('boom'), 'boom。もう一度お試しください。繰り返し起きる場合は、annaiを再起動してください。');
});

test("a watch that can't be checked: the trigger's own words keep their end in the Conversation, a question mark and an ellipsis too, in every language", () => {
  const line = (/** @type {string} */ why) => errorWords({ kind: 'trigger', type: 'plan', watch: 'plan:tea:leave', title: 'Tea at the inn', why, message: 'x' });
  assert.equal(line('Really?'), 'The watch for "Tea at the inn" can\'t be checked: Really?');
  assert.equal(line('wait…'), 'The watch for "Tea at the inn" can\'t be checked: wait…');
  assert.equal(line('boom'), 'The watch for "Tea at the inn" can\'t be checked: boom.');
  assert.equal(line('boom.'), 'The watch for "Tea at the inn" can\'t be checked: boom.');
  screens('ja');
  assert.equal(line('Really?'), '「Tea at the inn」の見守りを確認できません：Really?');
  assert.equal(line('boom'), '「Tea at the inn」の見守りを確認できません：boom。');
  screens('zh-Hans');
  assert.equal(line('wait…'), '无法检查“Tea at the inn”的提醒条件：wait…');
  screens('zh-Hant');
  assert.equal(line('boom'), '無法檢查「Tea at the inn」的提醒條件：boom。');
});

test("a watch that can't be checked: the Trace's English keeps the trigger's own question mark and ellipsis, ends words with no stop of their own with a \".\" and a blank error with the sentence's own, on a Japanese screen too", async () => {
  /** The Trace's messages for triggers that throw these. @param {string[]} said */
  const traced = async (said) => {
    const k = await liveKit();
    for (const [i, why] of said.entries()) {
      k.registry.add(`p${i}`, 'trigger', { type: `t${i}`, check() { throw new Error(why); } });
      await k.live.setWatch(k.trip, { when: { type: `t${i}` }, fallback: 'Low tide.' });
    }
    for (let s = 0; s < 3; s++) await k.fix(at('08:31') + s * 1000, MONTEREY);
    return (await k.events(['error'])).map((e) => String(e.data?.message));
  };
  const said = ['Is the tide table downloaded?', 'waiting for the orbit…', 'boom', ''];
  const expected = [/^The t0 watch w-[0-9a-z]+ can't be checked: Is the tide table downloaded\?$/, /^The t1 watch w-[0-9a-z]+ can't be checked: waiting for the orbit…$/,
    /^The t2 watch w-[0-9a-z]+ can't be checked: boom\.$/, /^The t3 watch w-[0-9a-z]+ can't be checked\.$/];
  for (const tag of ['en', 'ja']) {
    screens(tag);
    const messages = await traced(said);
    for (const re of expected) assert.ok(messages.some((m) => re.test(m)), `${tag}: ${re} in\n${messages.join('\n')}`);
  }
  // The flag is what keeps the Trace's English on a screen of another language: "." there, not 。.
  screens('ja');
  assert.equal(asSentence('boom', true), 'boom.');
  assert.equal(asSentence('boom'), 'boom。');
  assert.equal(asSentence("The watch can't be checked: ", true), "The watch can't be checked.");
});

test("a frame made with blank words reads as a sentence of its own, in every language, with no row for it: the watch line, the toast, the voice test, the photo that wasn't sent", () => {
  /** @type {Record<string, string[]>} */
  const want = {
    en: ['The watch for "Tea at the inn" can\'t be checked.', "Roles updated. Voice A couldn't be switched on. Voice B couldn't be switched on.", "Voice A couldn't speak. Spoken by Voice B.", 'photos/a.jpg. The message went without it.'],
    ja: ['「Tea at the inn」の見守りを確認できません。', '役割を更新しました。Voice Aをオンにできませんでした。Voice Bをオンにできませんでした。', 'Voice Aは話せませんでした。話した声：Voice B。', 'photos/a.jpg。メッセージは写真なしで送られました。'],
    'zh-Hans': ['无法检查“Tea at the inn”的提醒条件。', '已更新角色。Voice A 无法开启。Voice B 无法开启。', 'Voice A 无法朗读。朗读的声音：Voice B。', 'photos/a.jpg。消息已发出，但不含这张照片。'],
    'zh-Hant': ['無法檢查「Tea at the inn」的提醒條件。', '已更新角色。Voice A 無法開啟。Voice B 無法開啟。', 'Voice A 無法朗讀。朗讀的聲音：Voice B。', 'photos/a.jpg。訊息已送出，但不含這張照片。'],
  };
  for (const [tag, [watch, toast, voice, photo]] of Object.entries(want)) {
    screens(tag);
    // The frames in the shapes their callers make them (talk.js runs; provider.js, voice.js and loop.js are rebuilt here), with a blank error.
    assert.equal(errorWords({ kind: 'trigger', type: 'plan', watch: 'plan:tea:leave', title: 'Tea at the inn', why: '', message: 'x' }), watch, tag);
    assert.equal(sentences(t`Roles updated.`, ...['Voice A', 'Voice B'].map((n) => asSentence(t`${n} couldn't be switched on: ${''}`))), toast, tag);
    assert.equal(sentences(t`${'Voice A'} couldn't speak: ${''}`, t`Spoken by ${'Voice B'}.`), voice, tag);
    assert.equal(sentences(t`${'photos/a.jpg'}: ${''}`, t`The message went without it.`), photo, tag);
  }
  // A lead-in of a plugin's own before another part reads as a sentence too.
  screens('en');
  assert.equal(sentences('Steps:', 'one'), 'Steps. one');
  assert.equal(sentences('Allowed values:', 'Try again.'), 'Allowed values. Try again.');
  screens('ja');
  assert.equal(sentences('Steps：', 'one'), 'Steps。one');
});

test("the screen reader hears her words, and a card's, ended before the choices or the links that follow", () => {
  assert.deepEqual(announced('out.ask', '', 'Where do you want to eat', ['Yes', 'No']), ['Shiori asks: ', 'Where do you want to eat.', ' Choices: Yes, No.']);
  assert.deepEqual(announced('out.ask', '', 'Where do you want to eat?', ['Yes', 'No']), ['Shiori asks: ', 'Where do you want to eat?', ' Choices: Yes, No.'], 'a question keeps its own end');
  assert.deepEqual(announced('out.show', '', 'Pfeiffer Falls', ['Open']), ['Shiori: ', 'Pfeiffer Falls.', ' Choices: Open.'], "a card's words");
  assert.deepEqual(announced('out.speak', '', 'It closes at ten'), ['Shiori: ', 'It closes at ten', ''], 'nothing follows, so nothing is added');
  const card = { from: 'Google Search', title: 'From Google Search', text: 'Nepenthe closes at ten tonight' };
  assert.deepEqual(announced('grounded', '', 'From Google Search Nepenthe closes at ten tonight nepenthe.example', [], card), ['From Google Search. ', 'Nepenthe closes at ten tonight.', ' nepenthe.example']);
  assert.deepEqual(announced('grounded', '', 'From Google Search Nepenthe closes at ten tonight', [], card), ['From Google Search. ', 'Nepenthe closes at ten tonight', ''], 'no links after it, so no stop');
  screens('ja');
  assert.deepEqual(announced('out.ask', '', 'どこで食べたいですか', ['はい', 'いいえ']), ['Shioriの質問：', 'どこで食べたいですか。', '選択肢：はい、いいえ。']);
  // On a Japanese screen the card's source is sourceOf's word for Google Search and its title the card's own row, as talk.js draws them.
  assert.deepEqual(announced('grounded', '', `${t`From ${sourceOf({})}`} Nepenthe closes at ten tonight nepenthe.example`, [], { ...card, from: sourceOf({}), title: t`From ${sourceOf({})}` }), ['Google 検索より。', 'Nepenthe closes at ten tonight。', 'nepenthe.example']);
});

test("the live Test says what the model answered aloud as a sentence: a \"?\" or \"!\" it ends with stays, a stop is added where it has none, in every language", async () => {
  /** @param {string} said */
  const detail = async (said) => {
    /** @type {((e: any) => void) | undefined} */
    let listener;
    const session = /** @type {any} */ ({
      ready: Promise.resolve(), closed: new Promise(() => {}), close() {},
      on: (/** @type {(e: any) => void} */ fn) => { listener = fn; return () => {}; },
      text() { listener?.({ type: 'said', text: said }); listener?.({ type: 'audio', data: new Uint8Array(4) }); listener?.({ type: 'turn', end: 'done' }); },
    });
    return (await testLive(session)).steps.at(-1)?.detail;
  };
  for (const [tag, want] of /** @type {[string, string[]][]} */ ([
    ['en', ['It answered aloud: OK.', 'It answered aloud: OK.', 'It answered aloud: OK?', 'It answered aloud: OK!']],
    ['ja', ['音声で応答しました：「OK」。', '音声で応答しました：「OK」。', '音声で応答しました：「OK?」', '音声で応答しました：「OK!」']],
    ['zh-Hans', ['它用语音回答了：“OK”。', '它用语音回答了：“OK”。', '它用语音回答了：“OK?”', '它用语音回答了：“OK!”']],
  ])) {
    screens(tag);
    assert.deepEqual([await detail('OK'), await detail('OK.'), await detail('OK?'), await detail('OK!')], want, tag);
  }
});
