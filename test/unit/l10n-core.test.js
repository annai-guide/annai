import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setWords } from '../../src/core/l10n.js';

// Core's words for the user in Japanese (localization L5f, lane 1: the agent, models, voice and live mode), with the drafts that
// ship, beside what a model and the log read of the same things: that stays English. What is stored is data, and the screens make
// their words from it; an entry stored before has its English, shown as it is.

setWords('ja', JSON.parse(await readFile(new URL('../../l10n/ja.json', import.meta.url), 'utf8')));
after(() => setWords('en', null));
// Imported once the words are set, as boot.js sets them before main.js loads: words made at a module's top level are Japanese too.
const { ProviderError, explain, explainPlain } = await import('../../src/core/llm/contract.js');
const { AllFailedError, failedText, whyOf, whyWords } = await import('../../src/core/llm/fallback.js');
const { budgetStop, budgetWords } = await import('../../src/core/agent/budgets.js');
const { LABELS } = await import('../../src/core/agent/loop.js');
const { planWatches, planWords, PLAN } = await import('../../src/core/live/plan-watches.js');
const { chipText, koeWords } = await import('../../src/core/voice/mode.js');
const { micProblem } = await import('../../src/core/voice/mic.js');
const { listenKind } = await import('../../src/core/voice/resolve.js');
const { scopeTitle, ME, SYS } = await import('../../src/core/scopes.js');
const { StorageFullError, StoppedError } = await import('../../src/core/errors.js');
const { messageOf } = await import('../../src/ui/dom.js');
const { runTool } = await import('../../src/core/agent/tools.js');
const { keeperOf } = await import('../../src/core/llm/kept.js');
const { disabledCard } = await import('../../src/ui/plugin-cards.js');
const { reminderParts, errorWords } = await import('../../src/ui/screens/talk.js');
const { Transcript } = await import('../../src/core/agent/transcript.js');

/** The text of the transcript's last line once an event is applied: what a model reads of it. @param {any} e */
function lastLine(e) {
  const tr = new Transcript();
  tr.apply({ seq: 1, ...e }, { texts: {}, images: [] });
  return /** @type {any} */ (tr.messages.at(-1)?.parts[0])?.text;
}

test("an error's kind is the screens' words; a model reads annai's English, and a provider's own words stay as given", () => {
  const e = new ProviderError('auth', 'Invalid API key');
  assert.equal(explain(e), 'キーが拒否されました。設定 → モデルで確認してください。');
  assert.equal(explainPlain(e), 'The key was rejected. Check it in Settings → Models.');
  const redirect = new ProviderError('redirect', 'P answered with a redirect.', { provider: 'P' });
  assert.match(explain(redirect), /^P はリダイレクトで答えました。/);
  const attempts = [{ name: 'Gemini', outcome: 'benched' }, { name: 'Groq', outcome: 'rate', error: 'Rate limit reached' }];
  assert.equal(failedText(attempts), 'Gemini：エラーの後、数分間休んでいます。\nGroq：Rate limit reached.');
  assert.equal(failedText(attempts, { plain: true }), 'Gemini: It is resting for a few minutes after an error.\nGroq: Rate limit reached.');
  assert.equal(failedText([], { offline: true }), 'この端末はオフラインです。');
});

test("why a call failed is data: the log keeps it, a card and the Conversation make the screens' words, a model reads English", () => {
  const why = whyOf(new AllFailedError([{ model: 'm', name: 'Gemini', outcome: 'context', ms: 1 }]), { online: false });
  assert.deepEqual(why, { attempts: [{ name: 'Gemini', outcome: 'context' }], offline: true });
  assert.equal(whyWords(why), 'この端末はオフラインです。\nGemini：会話がこのモデルには長すぎます。');
  assert.equal(whyWords(why, true), 'This device is offline.\nGemini: The conversation is too long for this model.');
  assert.equal(whyWords(whyOf(new AllFailedError([]), { role: 'utility' })), '補助の役割にモデルが設定されていません。設定 → モデルで追加してください。');
  // Both halves down: each half's lines, by its name.
  const both = { halves: { koe: { kind: 'network' }, kokoro: { kind: 'timeout' } } };
  assert.equal(whyWords(both), 'Koe：接続が切れました。\nKokoro：モデルが答え始めるまでに時間がかかりすぎました。');
  assert.equal(whyWords(both, true), 'Koe: The connection dropped.\nKokoro: The model took too long to start answering.');
  // The Conversation's line comes from the entry's data; one stored before has none, and is shown as it was stored.
  assert.equal(errorWords({ kind: 'model', why, message: 'This device is offline.' }), whyWords(why));
  assert.equal(errorWords({ kind: 'model', message: 'Gemini: The connection dropped.' }), null);
  assert.equal(errorWords({ kind: 'silent', message: 'Her model finished without saying anything to you.' }), 'Shiori のモデルは、あなたに何も言わずに終わりました。');
});

test("a budget's stop is data: its card in the screens' words, the log's English for the Trace", () => {
  const over = budgetStop({ budgets: { stepsPerWake: 25 }, steps: 25, spent: 0 });
  assert.equal(over?.title, 'Shiori が止まりました：ステップ数の上限');
  assert.deepEqual({ which: over?.which, steps: /** @type {any} */ (over)?.steps }, { which: 'steps', steps: 25 });
  const data = { which: /** @type {const} */ ('steps'), steps: 25 };
  assert.match(budgetWords(data, true).body, /^She took the 25 steps a wake may take/);
  assert.equal(errorWords({ kind: 'budget', ...data, message: 'x' }), budgetWords(data).body);
});

test("the dock's states and the voice chip's line are the screens' words", () => {
  assert.equal(LABELS.sleeping, 'タップして話す');
  assert.equal(LABELS.offline, 'オフライン · リマインダーは使えます');
  const way = { mode: 'realtime', using: 'classic', why: 'resting', koe: true, split: true, path: 'text' };
  const koe = koeWords(way, true);
  assert.deepEqual(koe, { text: 'クラシック', reason: '（リアルタイム休止中）', note: 'リアルタイムはエラーの後で休んでいます。使えるようになるまで、クラシックが話します。' });
  assert.equal(chipText({ setting: 'auto', on: true, why: 'car audio' }, koe.text), '音声オン · カーオーディオ · クラシック');
  assert.equal(chipText({ setting: 'auto', on: false, why: 'not sure' }), '音声自動 · オフ');
});

test("a plan's reminder: Shiori reads annai's English, the user's words are made from its data wherever they are shown", () => {
  const at = Date.parse('2026-11-27T12:00:00-08:00');
  const items = [{ path: '/plan/tea.json', item: { title: 'Tea at the inn', start: { at: new Date(at).toISOString(), tz: 'America/Los_Angeles' }, fixed: true } }];
  const [w] = planWatches(items, new Map(), { fallbackTz: 'UTC' });
  assert.equal(w.fallback, 'In 15 min: Tea at the inn at 12:00.');
  assert.equal(planWords(/** @type {any} */ (w.say)), 'あと15分：Tea at the inn（12:00）。');
  // Worked out as it fires (late, from where the user is): data too.
  const late = { event: 'late', what: { title: 'Lunch', at, tz: 'America/Los_Angeles' }, minutes: 36 };
  assert.equal(planWords(late), '遅れています：Lunch（12:00）。あと約36分の距離です。');
  assert.equal(PLAN.validate({}), 'the plan sets its own watches');
  // The Conversation's line: from the data; an older entry's English as stored, marked as English.
  const mine = () => ({});
  const make = (/** @type {string} */ _tag, /** @type {any} */ a) => `${a.lang ?? ''}|${a.text}`;
  const shown = reminderParts({ watch: 'plan:tea:coming-up', text: w.fallback, plan: w.say }, mine, make);
  assert.deepEqual(shown, ['リマインダー：', '|あと15分：Tea at the inn（12:00）。', '']);
  assert.deepEqual(reminderParts({ watch: 'plan:tea:coming-up', text: w.fallback }, mine, make), ['リマインダー：', 'en|In 15 min: Tea at the inn at 12:00.', '']);
  // Her answer annai shows for her is called so from its data, as an older entry's title called it.
  assert.equal(reminderParts({ watch: '', text: 'Tea.', answer: true }, mine, make)[0], 'Shiori の答え：');
  // What Shiori is told of it stays annai's English.
  assert.equal(lastLine({ type: 'reminder', data: { watch: 'plan:tea:coming-up', text: w.fallback, plan: w.say } }),
    `[annai] Shown by annai itself, since you couldn't be reached: "${w.fallback}"`);
});

test("the microphone's and listening's problems: the card in the screens' words, what a model reads in English", () => {
  const denied = micProblem(Object.assign(new Error('x'), { name: 'NotAllowedError' }), 'ios');
  assert.equal(denied.title, 'annai はマイクを使えません');
  assert.match(denied.body, /^許可されていません。iPhone では：/);
  assert.equal(denied.plain, "annai can't use the microphone");
  // A plugin's message and annai's advice, each a sentence of its own.
  assert.equal(micProblem(new Error('マイクが止まりました。'), 'ios').body, 'マイクが止まりました。もう一度試してください。何度も起きる場合は annai を再起動してください。');
  const deaf = /** @type {any} */ (listenKind({ list: [], model: null, asr: () => false, dictation: true }));
  assert.match(deaf.words, /^Shiori にはあなたの声が聞こえません/);
  assert.match(deaf.why, /^Shiori can't hear you: the speech-in list is empty/);
});

test("scopes' titles, storage errors, a provider that keeps turns and a plugin switched off: the screens' words, from data", () => {
  assert.equal(scopeTitle({ id: ME, title: 'Me' }), '自分');
  assert.equal(scopeTitle({ id: SYS, title: 'System log' }), 'システムログ');
  assert.equal(scopeTitle({ id: 'trip-1', title: 'Big Sur' }), 'Big Sur');
  assert.deepEqual(keeperOf({ holds: 'at least 30 days', provider: 'provider-openai' }, 'provider-another-address', 'My server'), { name: 'My server', holds: null, server: true, note: '' });
  assert.match(disabledCard({ name: 'Tides', why: { kind: 'failed', count: 3 }, message: 'boom' }).body, /^3回続けて失敗しました。最後のエラー：boom/);
});

test("an error a model may read keeps annai's English in message; the screens show its shown words (LESSONS 2026-10-27)", async () => {
  for (const e of [new StorageFullError(), new StoppedError(), new AllFailedError([])]) {
    assert.match(e.message, /^[\x20-\x7e]+$/, `${e.name}'s message is English`);
    assert.match(String(e.shown), /[\u3040-\u30ff\u4e00-\u9fff]/, `${e.name}'s shown is Japanese`);
    assert.equal(messageOf(e), e.shown);
  }
  // A tool that hits a full disk: Shiori reads the English.
  const { output } = await runTool(/** @type {any} */ ({ name: 'write', run: async () => { throw new StorageFullError(); } }), {}, /** @type {any} */ ({ signal: new AbortController().signal }));
  assert.equal(output.content, `Error: ${new StorageFullError().message}`);
  // Kept as data in a turn's error: the Conversation's words in Japanese, a model's in English.
  const why = whyOf(new StorageFullError());
  assert.deepEqual(why, { message: new StorageFullError().message, name: 'StorageFullError' });
  assert.match(whyWords(why), /^この端末の annai の保存領域がいっぱいです/);
  assert.equal(whyWords(why, true), new StorageFullError().message);
});

test("a watch that can't be checked is named by its reminder in the Conversation, never by its id or its trigger's code", () => {
  const line = errorWords({ kind: 'trigger', type: 'place', watch: 'w-abc', reminder: 'Tea at the inn.', why: 'its place is not a place', message: 'x' });
  assert.match(String(line), /Tea at the inn/);
  assert.doesNotMatch(String(line), /w-abc|place の/);
});

test("a plan watch that can't be checked is named by its plan item's title, never by its English fallback; an older entry shows as stored", () => {
  const line = String(errorWords({ kind: 'trigger', type: 'plan', watch: 'plan:tea:leave', title: 'Tea at the inn', why: 'x', message: 'x' }));
  assert.match(line, /Tea at the inn/);
  assert.doesNotMatch(line, /Leave soon/);
  // One kept before it had the title: its English fallback is no name for a Japanese sentence; the stored English shows, marked.
  assert.equal(errorWords({ kind: 'trigger', type: 'plan', watch: 'plan:tea:leave', reminder: 'Leave soon: Tea at the inn at 16:00.', why: 'x', message: 'The plan watch plan:tea:leave can\'t be checked: x.' }), null);
});

test("a watch that can't be checked is named briefly: its reminder's first sentence, about 80 characters at most", () => {
  const long = `Time to stretch your legs and look at the sea before the bus. ${'Then walk on to the old harbour and the market. '.repeat(10)}`;
  const line = String(errorWords({ kind: 'trigger', type: 'time', watch: 'w-1', reminder: long, why: 'x', message: 'x' }));
  assert.match(line, /Time to stretch your legs and look at the sea before the bus/);
  assert.doesNotMatch(line, /harbour/);
  const run = String(errorWords({ kind: 'trigger', type: 'time', watch: 'w-1', reminder: 'a'.repeat(300), why: 'x', message: 'x' }));
  assert.ok(run.length < 140, run);
  assert.match(String(errorWords({ kind: 'trigger', type: 'time', watch: 'w-2', reminder: 'お茶の時間です。そのあと港まで歩きます。', why: 'x', message: 'x' })), /「お茶の時間です」/);
  // Cut by characters: an emoji at the cut is kept whole, never half a surrogate pair.
  const emoji = String(errorWords({ kind: 'trigger', type: 'time', watch: 'w-3', reminder: `${'a'.repeat(78)}🌊🌊🌊`, why: 'x', message: 'x' }));
  assert.match(emoji, /a{78}🌊…/u);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  const family = String(errorWords({ kind: 'trigger', type: 'time', watch: 'w-4', reminder: `${'a'.repeat(78)}👨‍👩‍👧‍👦🇯🇵 and more`, why: 'x', message: 'x' }));
  assert.match(family, /a{78}👨‍👩‍👧‍👦…/u, 'a family emoji at the cut is kept whole');
});

test("a wrong passphrase on Import, and an address with a name or password, say so in the screens' words", async () => {
  const { decrypt, PassphraseError } = await import('../../src/core/archive-crypto.js');
  const { refuseUserinfo } = await import('../../src/core/address.js');
  const e = await decrypt(new Blob([new TextEncoder().encode('PK plain zip')]), 'p').then(() => null, (x) => x);
  assert.ok(e instanceof PassphraseError);
  assert.equal(e.message, 'This file is not encrypted.', 'English for a backup\'s log and hold');
  assert.equal(messageOf(e), 'このファイルは暗号化されていません。');
  assert.throws(() => refuseUserinfo(new URL('https://me:pw@trails.example/kit.zip')), /^Error: [^A-Za-z]/);
});
