import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { compactionNeed, cutAt, renderForSummary, coldSystem, summaryLanguage } from '../../src/core/agent/compaction.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { ME } from '../../src/core/scopes.js';
import { saveModel } from '../../src/core/llm/config.js';
import { record } from '../../src/core/agent/log.js';

const say = (/** @type {string} */ text, /** @type {any} */ extra = {}) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }], ...extra });

test('when housekeeping is due, and when it is forced', () => {
  const base = { window: 100_000, maxBytes: 8 * 2 ** 20, threshold: 0.7 };
  assert.equal(compactionNeed({ ...base, tokens: 50_000, bytes: 1000 }), null);
  assert.equal(compactionNeed({ ...base, tokens: 70_000, bytes: 1000 }), 'due');
  assert.equal(compactionNeed({ ...base, tokens: 91_000, bytes: 1000 }), 'forced');
  assert.equal(compactionNeed({ ...base, tokens: 10, bytes: 6 * 2 ** 20 }), 'due');
  assert.equal(compactionNeed({ ...base, tokens: 10, bytes: 9 * 2 ** 20 }), 'forced');
  assert.equal(compactionNeed({ ...base, window: null, tokens: 1e9, bytes: 10 }), null);
});

test('the cut keeps about a third of the threshold, never fewer than three exchanges, and always compacts the oldest', () => {
  const ex = (/** @type {number} */ seq) => [{ seq, tokens: 10, exchange: true }, { seq: seq + 1, tokens: 1000, exchange: false }];
  const items = [1, 3, 5, 7, 9, 11].flatMap(ex);
  assert.equal(cutAt(items, { keepTokens: 500 }), 7);
  assert.equal(cutAt(items, { keepTokens: 4000 }), 5);
  assert.equal(cutAt(items, { keepTokens: 1e9 }), 3);
  assert.equal(cutAt(items.slice(0, 6), { keepTokens: 0 }), null);
  assert.equal(cutAt(items.slice(0, 6), { keepTokens: 0, minExchanges: 1 }), 5);
});

test('cold: the utility model writes the summary; the last three exchanges stay word for word', async () => {
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'They planned dinner at Nepenthe.' }] });
  for (let i = 0; i < 5; i++) {
    k.agent.send(`Message ${i}`);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  const [c] = await k.events(['compaction']);
  assert.equal(c.data.mode, 'cold');
  const msgs = k.agent.transcript.messages;
  assert.match(/** @type {any} */ (msgs[0].parts[0]).text, /^\[Earlier conversation, summarized \(events \d+–\d+\); recall brings back the exact words\]\nThey planned dinner at Nepenthe\.$/);
  const all = JSON.stringify(msgs);
  // Without a model window, the part kept is large: everything but the oldest exchange, and never fewer than three.
  assert.equal(all.includes('Message 0'), false);
  for (const n of [2, 3, 4]) assert.equal(all.includes(`Message ${n}`), true);
  assert.match(k.requests.at(-1).messages[0].parts[0].text, /Message 0/);
  assert.deepEqual((await Transcript.load(k.store, k.trip)).messages, msgs);
});

test('warm: the model holding the cache summarizes from the cached conversation, and may move facts into memory first', async () => {
  const k = await agentKit([[say('a'), say('b'), say('c'), say('d'),
    { toolCalls: [{ name: 'edit', input: { path: '/me/memory.md', old: '# Memory', new: '# Memory\n- Vegetarian' } }, { name: 'write', input: { path: '/trip/notes/x.md', content: 'no' } }] },
    { text: 'Four greetings; the user is vegetarian.' }]]);
  for (let i = 0; i < 4; i++) {
    k.agent.send(`Hi ${i}`);
    await k.agent.idle();
  }
  const conversation = structuredClone(k.agent.transcript.messages);
  const lastTurn = k.requests.at(-1);
  assert.equal(await k.agent.compact('warm'), true);
  const asked = k.requests[4];
  assert.equal(asked.system, lastTurn.system);
  assert.deepEqual(asked.tools, lastTurn.tools);
  assert.deepEqual(asked.messages, conversation);
  assert.match(asked.tail, /housekeeping/);
  assert.match(await k.ws.readText(ME, '/memory.md'), /Vegetarian/);
  assert.equal(await k.ws.read(k.trip, '/notes/x.md'), undefined);
  assert.equal((await k.events(['compaction']))[0].data.mode, 'warm');
  assert.equal(k.requests.length, 6, "its summary is plain text, as asked: housekeeping isn't the user's turn, so nobody asks again (spec §7.1)");
  assert.deepEqual(k.notices, []);
});

test('due at a pause: housekeeping waits until shortly before the cache expires', async () => {
  /** @type {{ fn: () => void, ms: number }[]} */
  const timers = [];
  const k = await agentKit([[say('x', { usage: { input: 7500, output: 5 } })]], {
    models: [{ contextWindow: 10000 }],
    agent: { timers: { set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.push({ fn, ms }), clear: () => {} } },
  });
  k.agent.send('Hello');
  await k.agent.idle();
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms > 250_000 && timers[0].ms <= 255_000, String(timers[0].ms));
});

test("housekeeping from the timer that fails says so in a notice that names its model by its provider's name first (the user, 2026-11-16; the final review's finding A)", async () => {
  /** @type {(() => void)[]} */
  const timers = [];
  // Shortly before the cache goes cold, the model that holds it writes the summary: here it fails.
  const small = (/** @type {string} */ text) => say(text, { usage: { input: 50, output: 5 } });
  const k = await agentKit([[small('1'), small('2'), small('3'), small('4'), say('5', { usage: { input: 7500, output: 5 } }), { error: 'auth', status: 401, message: 'bad main key' }]], {
    models: [{ contextWindow: 10000 }], agent: { timers: { set: (/** @type {() => void} */ fn) => timers.push(fn), clear: () => {} } },
  });
  for (let i = 1; i <= 5; i++) {
    k.agent.send(`Turn ${i}`);
    await k.agent.idle();
  }
  timers[0]();
  await until(() => k.notices.length > 0);
  assert.equal(k.notices[0].title, "Shiori couldn't tidy up the conversation");
  assert.match(k.notices[0].body, /^E0 \/ model-0: .*bad main key.* She will try again later\.$/is);
});

test('forced: a turn about to overflow is compacted before its next call', async () => {
  const k = await agentKit([[say('1'), say('2'), say('3'),
    { toolCalls: [{ name: 'list', input: { path: '/trip/' } }], usage: { input: 9500, output: 5 } },
    { text: 'Summary of 1 to 3.' },
    say('done')]], { models: [{ contextWindow: 10000 }] });
  for (let i = 0; i < 4; i++) {
    k.agent.send(`Turn ${i}`);
    await k.agent.idle();
  }
  assert.equal((await k.events(['compaction'])).length, 1);
  assert.match(k.requests.at(-1).messages[0].parts[0].text, /^\[Earlier conversation, summarized/);
  assert.equal((await k.events(['out.speak'])).at(-1).data.text, 'done');
});

test('"request too long" from every model: compact cold first, then try again', async () => {
  const k = await agentKit([[say('1'), say('2'), say('3'), { error: 'context', status: 400, message: 'prompt is too long' }, say('fits now')]], { utility: [{ text: 'Summary.' }] });
  for (let i = 0; i < 4; i++) {
    k.agent.send(`Turn ${i}`);
    await k.agent.idle();
  }
  assert.equal((await k.events(['compaction']))[0].data.mode, 'cold');
  assert.equal((await k.events(['out.speak'])).at(-1).data.text, 'fits now');
  assert.equal(k.notices.length, 0);
});

test('renderForSummary: within a size, the start and the end kept and the middle said to be left out', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: `Message ${i} ${'x'.repeat(200)}` }] }));
  const text = renderForSummary(messages, 2000);
  assert.ok(text.length <= 2000, `${text.length}`);
  assert.match(text, /^User: Message 0 /);
  assert.match(text, /Message 39 x+$/);
  assert.match(text, /\[… \d+ characters left out …\]/);
  assert.equal(renderForSummary(messages.slice(0, 2), 2000), renderForSummary(messages.slice(0, 2)));
});

test("cold: what the utility model is sent fits its window, so a huge exchange can't keep it from summarizing", async () => {
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'Summary.' }] });
  const u = (await k.llm.config()).models['m-u'];
  await saveModel(k.ws, { ...u, user: { ...u.user, contextWindow: 2000 } });
  for (let i = 0; i < 5; i++) {
    k.agent.send(`Message ${i} ${'y'.repeat(6000)}`);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  const sent = k.requests.at(-1);
  // The kit's phone has no language of its own (voice.locale unset), so the setting is the default one; the loop passes the user's lines, the last of them 'Message 4 …'.
  const { languageSettings } = await import('../../src/core/languages.js');
  assert.equal(sent.system, coldSystem(summaryLanguage(`Message 4 ${'y'.repeat(6000)}`, languageSettings({}, undefined))));
  assert.ok(sent.messages[0].parts[0].text.length <= 2000 * 3.5 * 0.5, `${sent.messages[0].parts[0].text.length}`);
});

test('summaries see photos as stubs with their path and part', async () => {
  const text = renderForSummary([{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data: 'x', path: '/trip/files/menu.webp', region: [0, 0, 0.5, 0.5] }] }]);
  assert.equal(text, 'User: [photo /trip/files/menu.webp, part [0, 0, 0.5, 0.5]]');
});

test('requestBytes: photos uploaded to the provider count as their id (spec §6.5)', async () => {
  const { requestBytes } = await import('../../src/core/agent/compaction.js');
  const request = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }, { type: 'image', mediaType: 'image/webp', data: 'A'.repeat(100_000), hash: 'h' }] }] };
  assert.ok(requestBytes(request) > 100_000);
  assert.ok(requestBytes(request, { uploaded: true }) < 1000);
});

test('with uploads, a big photo makes no housekeeping due (spec §6.5, review I7)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  for (const uploading of [false, true]) {
    /** @type {any[]} */
    const timers = [];
    const k = await agentKit([[say('ok')]], { uploading, agent: { timers: { set: (/** @type {any} */ fn) => { timers.push(fn); return timers.length; }, clear: (/** @type {number} */ h) => { timers[h - 1] = null; } } } });
    await updateAppSettings(k.ws, { shiori: { compaction: { maxRequestMiB: 1 } } });
    await k.ws.write(k.trip, '/files/big.webp', new TextEncoder().encode('x'.repeat(700_000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
    k.agent.send('Look', { photos: [{ path: '/trip/files/big.webp' }] });
    await k.agent.idle();
    assert.equal(timers.some(Boolean), !uploading, uploading ? 'uploaded: counted as its id' : 'sent as bytes: due');
  }
});

test('housekeeping reads the conversation by type: location points and the like are not walked (A6)', async () => {
  const { noteQueries } = await import('./store-spy.js');
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'They planned dinner at Nepenthe.' }] });
  for (let i = 0; i < 5; i++) {
    k.agent.send(`Message ${i}`);
    await k.agent.idle();
  }
  const queries = noteQueries(k.store);
  assert.equal(await k.agent.compact('cold'), true);
  const untyped = queries.filter((q) => !(Array.isArray(q.types) && q.types.length));
  assert.deepEqual(untyped, []);
});

test("warm housekeeping, whose request still offers the model's own search (so the cached prefix holds), asks for no search (G4)", async () => {
  const { instruction } = await import('../../src/core/agent/compaction.js');
  assert.match(instruction('event 12', 'English'), /Don't search the web now\./);
});

test("a few words in another script don't decide the language: a name in kanji, kana or Cyrillic leaves an English line English; and a line of fewer than 3 words doesn't count (review A6; the summary reads placed since detector-next, languageOf the stray note)", async () => {
  const { languageOf } = await import('../../src/core/languages.js');
  for (const x of ['Is 一蘭 near 渋谷駅 still open tonight?', 'Can we try the ラーメン place by the station?', 'Is the Café Пушкин open on Sundays?']) {
    assert.equal(languageOf(x), 'English', x);
    assert.equal(summaryLanguage([x]), 'English, the language most of what the user wrote is in', x);
  }
  assert.equal(languageOf('今日の夕食はどこにしますか'), 'Japanese');
  assert.equal(languageOf('我们今晚去哪里吃饭'), 'Chinese');
  assert.equal(languageOf('Где можно поужинать сегодня вечером?'), 'Russian');
  assert.equal(summaryLanguage(['We are vegetarian.', 'Also no nuts, please.', 'OK']), 'English, the language most of what the user wrote is in');
  // Lines of two words that do name a language ('はい' is kana, 'Big Sur' reads as French) count for nothing, however many.
  assert.equal(summaryLanguage(['We are vegetarian.', 'Also no nuts, please.', 'はい', 'はい']), 'English, the language most of what the user wrote is in');
  assert.equal(summaryLanguage(['Big Sur', 'はい']), "English, the app's language (nothing the user wrote names a language)");
  assert.equal(summaryLanguage(['OK']), "English, the app's language (nothing the user wrote names a language)", "no line names one: the phone's answer, never a quoted line");
});

test('the summary is asked for in a language named: the one most of what the user wrote is in, else the app\'s (emulator pass: a Spanish summary of an English talk)', async () => {
  assert.equal(summaryLanguage('Also, we are vegetarian.'), 'English, the language most of what the user wrote is in');
  assert.equal(summaryLanguage('¿Dónde podemos cenar esta noche?'), 'Spanish, the language most of what the user wrote is in');
  assert.equal(summaryLanguage('Où est le restaurant ?'), 'French, the language most of what the user wrote is in');
  assert.equal(summaryLanguage('今日の夕食はどこにしますか'), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage(''), "English, the app's language (the user hasn't written anything yet)");
  assert.equal(summaryLanguage('OK'), "English, the app's language (nothing the user wrote names a language)");
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'Summary.' }] });
  for (const m of ['Where should we eat tonight?', 'And tomorrow?', 'We are vegetarian, by the way.', 'Is it far?', 'Thanks, that is all for today.']) {
    k.agent.send(m);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  assert.match(k.requests.at(-1).system, /as plain text, in English, the language most of what the user wrote is in\.$/);
  const { instruction } = await import('../../src/core/agent/compaction.js');
  assert.match(instruction('event 12', 'Spanish, the language most of what the user wrote is in'), /as plain text, in Spanish, the language most of what the user wrote is in\.$/);
});

test('with the languages setting the summary is written in the language it names, not guessed from the text (phase 2); with none it is guessed as before', async () => {
  const { languageSettings } = await import('../../src/core/languages.js');
  const three = languageSettings({ languages: { spoken: ['en', 'zh', 'ja'] } }, 'en-US');
  // A listed language the user wrote in is it.
  assert.equal(summaryLanguage('今日の夕食はどこにしますか', three), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage('Where should we eat?', three), 'English, the language most of what the user wrote is in');
  // A short or unplaceable message, or one in a language not listed, is the first listed language: the guess is never taken for the user's.
  assert.equal(summaryLanguage('OK', three), 'English, the first language the user speaks (English, Chinese (Simplified) and Japanese)');
  assert.equal(summaryLanguage('¿Dónde podemos cenar esta noche?', three), 'English, the first language the user speaks (English, Chinese (Simplified) and Japanese)');
  assert.equal(summaryLanguage('', three), 'English, the first language the user speaks (English, Chinese (Simplified) and Japanese)');
  // A fixed answer language is the summary's.
  const fixed = languageSettings({ languages: { spoken: ['en', 'ja'], answer: 'ja' } }, 'en-US');
  assert.equal(summaryLanguage('Where should we eat?', fixed), 'Japanese, the language Shiori answers in');
  // Nothing chosen (the browser's language is only a default): the guess, as before.
  const none = languageSettings({}, 'en-US');
  assert.equal(summaryLanguage('¿Dónde podemos cenar esta noche?', none), 'Spanish, the language most of what the user wrote is in');
  // With no line of theirs: the same answer as the Languages section gives for her first message (the first listed; with nothing chosen, the phone's).
  assert.equal(summaryLanguage('', none), "English, the language of the user's phone (the user hasn't written anything yet)");
  assert.equal(summaryLanguage('', languageSettings({}, 'ja-JP')), "Japanese, the language of the user's phone (the user hasn't written anything yet)");
});

test('housekeeping reads the setting: a fixed answer language is the summary\'s, whatever the last message looks like (phase 2)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'Summary.' }] });
  await updateAppSettings(k.ws, { languages: { spoken: ['en', 'ja'], answer: 'ja' } });
  for (const m of ['Where should we eat tonight?', 'And tomorrow?', 'We are vegetarian, by the way.', 'Is it far?', 'Thanks, that is all for today.']) {
    k.agent.send(m);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  assert.match(k.requests.at(-1).system, /as plain text, in Japanese, the language Shiori answers in\.$/);
});

test('kanji alone is Japanese for the summary when Japanese is listed and Chinese is not; the matcher is the stray flag\'s (review item 5)', async () => {
  const { languageSettings } = await import('../../src/core/languages.js');
  const ja = languageSettings({ languages: { spoken: ['en', 'ja'] } }, 'en-US');
  assert.equal(summaryLanguage('大丈夫', ja), 'Japanese, the language most of what the user wrote is in');
  const both = languageSettings({ languages: { spoken: ['en', 'ja', 'zh'] } }, 'en-US');
  assert.equal(summaryLanguage('我们今晚去哪里吃饭', both), 'Chinese (Simplified), the language most of what the user wrote is in');
  assert.equal(summaryLanguage('今日の夕食はどこにしますか', both), 'Japanese, the language most of what the user wrote is in');
  const zh = languageSettings({ languages: { spoken: ['en', 'zh'] } }, 'en-US');
  assert.equal(summaryLanguage('今日の夕食はどこにしますか', zh), 'English, the first language the user speaks (English and Chinese (Simplified))', 'kana is Japanese, which is not listed');
});

test('with both Chinese listed, the summary is in the one the user wrote in, by its characters (the check of 18f87b78)', async () => {
  const { languageSettings } = await import('../../src/core/languages.js');
  const both = languageSettings({ languages: { spoken: ['zh', 'zh-Hant', 'en'] } }, 'en-US');
  assert.equal(summaryLanguage('我們今晚去哪裡吃飯', both), 'Chinese (Traditional), the language most of what the user wrote is in');
  assert.equal(summaryLanguage('我们今晚去哪里吃饭', both), 'Chinese (Simplified), the language most of what the user wrote is in');
  assert.equal(summaryLanguage('大家好', both), 'Chinese (Simplified), the language most of what the user wrote is in', 'characters that tell nothing: the first listed');
  assert.equal(summaryLanguage('好的', both), 'Chinese (Simplified), the first language the user speaks (Chinese (Simplified), Chinese (Traditional) and English)', 'a reply of fewer than 3 words counts for no language: the first listed');
  const cantonese = languageSettings({ languages: { spoken: ['yue', 'zh-Hant'] } }, 'en-US');
  assert.equal(summaryLanguage('我們今晚去邊度食飯', cantonese), 'Cantonese, the language most of what the user wrote is in', 'Cantonese listed first keeps Traditional characters');
});

// The two Chinese rows are one language for the count (the review of summary-count-next, F4; second opinions 1 to 3): a line is counted for the family, and the
// row is named once, as the one most of the family's lines that tell are in (a line counting once however long, so one pasted text is one line among those that
// tell, and decides when the typed lines tell nothing; the re-review's R1 and W2). Counted row by row, a split trip lost to a third language, and lines whose
// characters tell nothing (the first listed) outvoted the Traditional ones that do.
test("with both Chinese listed, their lines count as one language, and the row is the one most of their lines that tell are in (the review of summary-count-next, F4 and R1); with Cantonese listed between the rows, Traditional forms are the first listed language written in them, Cantonese (detector-next: forms tell no Cantonese from Mandarin, and order decides only the last fallback)", async () => {
  const { languageSettings } = await import('../../src/core/languages.js');
  const both = languageSettings({ languages: { spoken: ['zh', 'zh-Hant', 'en'] } }, 'en-US');
  const most = (/** @type {string} */ name) => `${name}, the language most of what the user wrote is in`;
  const [e1, e2] = ['Where should we eat tonight?', 'Is the museum open today?'];
  const [s1, s2, s3] = ['我们今晚去哪里吃饭', '我们明天去哪里', '我们这个周末去哪里'];
  const [t1, t2] = ['我們今晚去哪裡吃飯', '我們明天去哪裡'];
  // Two Simplified, two Traditional and three English lines: Chinese is four lines, English three (counted row by row: English).
  assert.equal(summaryLanguage([e1, s1, t1, e2, s2, t2, e1], both), most('Chinese (Traditional)'), 'the lines tie: the newest line that tells');
  assert.equal(summaryLanguage([e1, t1, s1, e2, t2, s2, e1], both), most('Chinese (Simplified)'), 'the lines tie: the newest line that tells');
  assert.equal(summaryLanguage([e1, s1, t1, e2, s2, t2, '大家好'], both), most('Chinese (Traditional)'), 'a line that tells nothing is not the newest one that tells');
  assert.equal(summaryLanguage([e1, s1, t1, e2, s2, s3, e1, t2], both), most('Chinese (Simplified)'), 'more Simplified lines than Traditional ones, whatever the newest');
  // The row is the one most of the lines that tell are in, a line counting once whatever its length: one pasted text in the other script (with more
  // telling characters than the typed lines together) doesn't name it.
  assert.equal(summaryLanguage([s1, s2, '這個好吃嗎'], both), most('Chinese (Simplified)'), 'two Simplified lines and one Traditional line, which has more telling characters than either');
  assert.equal(summaryLanguage([s1, s2, s3, '這間餐廳的東西很好吃，開門時間是早上十點，關門時間是晚上九點'], both), most('Chinese (Simplified)'), 'three typed Simplified lines and one pasted Traditional text');
  // A line in another language is no vote for the row, though its characters tell (東 is a Traditional form): the two Chinese lines tie, and the newer is Simplified.
  assert.equal(summaryLanguage(['我們今晚去哪裡吃飯', '我们明天去哪里', 'Is 東京 far from here?'], both), most('Chinese (Simplified)'), 'an English line is no vote for the row');
  // None tells, with English listed first: the first listed Chinese row, not the first listed language.
  const enFirst = languageSettings({ languages: { spoken: ['en', 'zh', 'zh-Hant'] } }, 'en-US');
  assert.equal(summaryLanguage(['大家好', '好想去看夜景', '大家早上好'], enFirst), most('Chinese (Simplified)'), 'none telling, English listed first: the first listed Chinese row');
  // A Traditional writer whose lines mostly carry no character that tells: three that do, five that don't, four English (counted row by row: Simplified,
  // the first listed, five lines against three).
  const plain = ['好想去看夜景', '今天天氣很好', '我想吃拉麵', '大家好', '想去海邊走走'];
  assert.equal(summaryLanguage([e1, plain[0], t1, plain[1], e2, plain[2], t2, plain[3], e1, plain[4], '我們這個週末去哪裡', e2], both), most('Chinese (Traditional)'));
  // The listed order, not the lines, places lines that tell nothing: with Traditional first, they are Traditional.
  const hantFirst = languageSettings({ languages: { spoken: ['zh-Hant', 'zh', 'en'] } }, 'en-US');
  assert.equal(summaryLanguage([e1, ...plain, e2, e1], hantFirst), most('Chinese (Traditional)'));
  // One Chinese row listed: Traditional lines are that row.
  const simplified = languageSettings({ languages: { spoken: ['zh', 'en'] } }, 'en-US');
  assert.equal(summaryLanguage([e1, t1, t2, t1, e2], simplified), most('Chinese (Simplified)'), 'Traditional lines with only Simplified listed');
  // Cantonese between the rows (not of the family): a Traditional line with no character of Cantonese's own is the first listed language written in
  // Traditional forms, Cantonese here (main: the Chinese family, since languageOf named it "Chinese" and the first listed row took it).
  const between = languageSettings({ languages: { spoken: ['zh', 'yue', 'zh-Hant', 'en'] } }, 'en-US');
  assert.equal(summaryLanguage([t1], between), most('Cantonese'));
  assert.equal(summaryLanguage([e1, s1, t1, s2], between), most('Chinese (Simplified)'), 'the two Simplified lines are the family\'s, the Traditional one Cantonese\'s');
});

test('what the user said aloud counts for the summary\'s language, not only what they typed (review item 5, Step S7)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'Summary.' }] });
  await updateAppSettings(k.ws, { languages: { spoken: ['en', 'ja'] } });
  for (const m of ['ok', 'ok again', 'fine', 'go on', 'thanks']) {
    k.agent.send(m);
    await k.agent.idle();
  }
  // A voice-only user: what they said is a heard line, with its words; the last of what the user said is Japanese.
  await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 'sp1', ms: 1200, source: 'dictation', text: '今日の夕食はどこにしますか' } });
  assert.equal(await k.agent.compact('cold'), true);
  assert.match(k.requests.at(-1).system, /as plain text, in Japanese, the language most of what the user wrote is in\.$/);
});

test('chatter the gate set aside (a dismissed heard line, and the words written for it) does not set the summary\'s language (review follow-up 4)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'Summary.' }] });
  await updateAppSettings(k.ws, { languages: { spoken: ['en', 'ja'] } });
  for (const m of ['ok', 'ok ok', 'fine', 'hmm', 'go']) { // none of them places a language
    k.agent.send(m);
    await k.agent.idle();
  }
  // People talking among themselves in Japanese: heard, "not meant for you", its words written later.
  await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 'ch1', ms: 1200, source: 'mic', dismissed: true, gate: 'chatter' } });
  await record(k.store, k.trip, { type: 'heard.text', actor: 'system', data: { of: 'ch1', text: '今日の夕食はどこにしますか', by: 'm-hear' } });
  assert.equal(await k.agent.compact('cold'), true);
  assert.match(k.requests.at(-1).system, /as plain text, in English, the first language the user speaks \(English and Japanese\)\.$/);
});

// annai's own lines for no words ("(files)", "(a photo)", a heard line it couldn't write down) read as English, or as nothing: the one function that
// names the language the user wrote in leaves them out for every caller (compaction's and the recap's: the languages build's entry 3).
test("annai's lines for no words are never the user's words: summaryLanguage leaves them out, whoever calls it", async () => {
  const { languageSettings } = await import('../../src/core/languages.js');
  const { NOT_TRANSCRIBED } = await import('../../src/core/voice/resolve.js');
  const phone = languageSettings({}, 'ja-JP');
  // '': an empty dictation or reply logged as a heard line (loop.js heard.text) is no line of theirs either.
  for (const none of ['(files)', '(a photo)', NOT_TRANSCRIBED, '', '  ']) {
    assert.equal(summaryLanguage([none], phone), "Japanese, the language of the user's phone (the user hasn't written anything yet)", JSON.stringify(none));
  }
  const both = languageSettings({ languages: { spoken: ['en', 'ja'] } }, 'en-US');
  assert.equal(summaryLanguage(['今日の夕食はどこにしますか', '(files)', '(a photo)', '(files)', '(files)'], both), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage(['今日の夕食はどこにしますか', ''], languageSettings({}, 'en-US')), 'Japanese, the language most of what the user wrote is in');
});

// Each of the user's lines of 3 words or more that names a language counts once, and the language with the most lines is named: a trip's last lines are
// "OK", "thanks", an emoji or a place's name (the final review of langs-next, F1; second opinions 1, 2 and 3; the re-review of fix round 1, R1). Main's recap
// read the whole trip; reading the last three lost the trip's language to three of those, and the newest line that names one to "thanks" and "新宿".
test("each line of 3 words or more that names a language counts once; the language with the most is named; with none counted, the first listed or the phone's", async () => {
  const { languageSettings } = await import('../../src/core/languages.js');
  const trip = '今日の夕食はどこにしますか';
  const phone = languageSettings({}, 'en-US');
  const both = languageSettings({ languages: { spoken: ['en', 'ja'] } }, 'en-US');
  // A Japanese trip that ends in lines naming no language is Japanese, for the recap and for compaction, chosen or not.
  assert.equal(summaryLanguage([trip, '😀', '😀', '😀'], phone), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage([trip, 'OK', 'OK', 'OK'], both), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage([trip, 'Nepenthe'], phone), 'Japanese, the language most of what the user wrote is in');
  // A line of one or two words is a reply, a thanks or a name, however it reads: a Japanese trip's last words "ok", "thanks", "bye" don't turn it English.
  const ja = languageSettings({}, 'ja-JP');
  assert.equal(summaryLanguage(['今日は楽しかった', '明日は雨ですか', 'ok', 'thanks', 'bye'], ja), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage(['今日は楽しかった', '明日は雨ですか', 'ok', 'thanks', 'bye'], both), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage(['今日は楽しかった', '明日は雨ですか', 'thanks', 'ok'], phone), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage(['今日は楽しかった', '明日は雨ですか', 'ok', 'hmm', 'sure'], ja), 'Japanese, the language most of what the user wrote is in');
  // The language with the most lines is named, not the one of the newest line that names one: here that line is English, and Japanese has two.
  assert.equal(summaryLanguage(['今日は楽しかった', '明日は雨ですか', 'Is it far?'], phone), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage(['今日は楽しかった', '明日は雨ですか', 'Is it far?', 'ok'], both), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage(['Is it far?', 'Where should we eat tonight?', '今日は楽しかった'], ja), 'English, the language most of what the user wrote is in');
  // No line of 3 words counts: the short lines are not read together either (joined, these read as Spanish), so the phone's answer.
  assert.equal(summaryLanguage(['hola thanks', 'hola bonjour', 'OK'], phone), "English, the language of the user's phone (nothing the user wrote names a language)");
  // Nothing names one: chosen, the first listed; not chosen, the phone's, never a quoted line.
  assert.equal(summaryLanguage(['OK', 'OK!', 'OK.'], both), 'English, the first language the user speaks (English and Japanese)');
  assert.equal(summaryLanguage(['OK'], ja), "Japanese, the language of the user's phone (nothing the user wrote names a language)");
});

// No one line decides (the design check of 2026-11-17, option 1): every finding of langs-next's three rounds was one line standing for the whole
// window or trip. Each shape here was named wrongly by the newest line of 3 words or more that names a language.
test("most of the user's lines name the summary's language, not the newest: a closing thanks, a line in a language not listed, two short lines, a tie, a late switch", async () => {
  const { languageSettings } = await import('../../src/core/languages.js');
  const [j1, j2, j3] = ['今日の夕食はどこにしますか', '明日は雨ですか', '今日は楽しかった'];
  const [e1, e2] = ['Where should we eat tonight?', 'Is the museum open today?'];
  const spanish = '¿Dónde podemos cenar esta noche?';
  const phone = languageSettings({}, 'en-US');
  const jaPhone = languageSettings({}, 'ja-JP');
  const both = languageSettings({ languages: { spoken: ['en', 'ja'] } }, 'en-US');
  const most = (/** @type {string} */ name) => `${name}, the language most of what the user wrote is in`;
  for (const s of [phone, jaPhone, both]) {
    // Two Japanese lines and a closing English sentence (main: English).
    assert.equal(summaryLanguage([j1, j2, 'Thank you so much!'], s), most('Japanese'), s.spoken[0].locale);
    // A late switch is the rule's edge (spec §6.5): five English lines then two Japanese are English (main: Japanese); compaction's next window catches up.
    assert.equal(summaryLanguage([...Array(5).fill(e1), j1, j2], s), most('English'), s.spoken[0].locale);
    assert.equal(summaryLanguage([...Array(10).fill(e1), 'はい', '今日はどこに行きますか', 'OK'], s), most('English'), s.spoken[0].locale);
  }
  // With languages chosen, a line in none of them doesn't count (main: the first listed, English, for [en, ja]; Spanish with nothing chosen).
  assert.equal(summaryLanguage([j1, j2, j3, spanish], both), most('Japanese'));
  assert.equal(summaryLanguage([j1, j2, j3, spanish], phone), most('Japanese'));
  // Two lines of fewer than 3 words count for nothing, and are not read together (main: French, from "sur"): the phone's answer.
  assert.equal(summaryLanguage(['Big Sur', 'はい'], phone), "English, the language of the user's phone (nothing the user wrote names a language)");
  assert.equal(summaryLanguage(['Big Sur', 'はい'], jaPhone), "Japanese, the language of the user's phone (nothing the user wrote names a language)");
  // A tie goes to the language written in more recently.
  assert.equal(summaryLanguage([e1, j1], phone), most('Japanese'));
  assert.equal(summaryLanguage([j1, e1], phone), most('English'));
  assert.equal(summaryLanguage([e1, j1, e2, j2], phone), most('Japanese'));
  assert.equal(summaryLanguage([j1, e1, j2, e2], jaPhone), most('English'));
  // More recently written in, not first written later: Japanese was written in last here, English first written in later (without the Map's delete, English).
  assert.equal(summaryLanguage([j1, e1, e2, j2], phone), most('Japanese'));
  assert.equal(summaryLanguage([e1, j1, j2, e2], jaPhone), most('English'));
  // With [en, ja] listed, the Spanish line is none of theirs: English and Japanese tie, and Japanese is the newer (main: English, the first listed).
  assert.equal(summaryLanguage([e1, j1, spanish], both), most('Japanese'));
});

// Han characters alone say Chinese; a Japanese phone's 「大丈夫」 is Japanese: with nothing chosen, Han that says neither joins the side with lines
// of its own, and with none the phone's language takes it, as a listed Japanese does (the final review of langs-next, F1; detector-next).
test("with nothing chosen, Han characters alone are the phone's Japanese, as with Japanese listed; a Chinese line on an English phone names its row, Chinese (Simplified) (detector-next: the summary is asked for in a row, never \"Chinese\")", async () => {
  const { languageSettings } = await import('../../src/core/languages.js');
  const ja = languageSettings({}, 'ja-JP');
  assert.equal(summaryLanguage(['大丈夫'], ja), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage(['今日の夕食はどこにしますか', '大丈夫'], ja), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage(['東京駅'], languageSettings({ languages: { spoken: ['en', 'ja'] } }, 'en-US')), 'Japanese, the language most of what the user wrote is in');
  assert.equal(summaryLanguage(['我们今晚去哪里吃饭'], languageSettings({}, 'en-US')), 'Chinese (Simplified), the language most of what the user wrote is in', 'no Japanese anywhere: Chinese, its row named');
  // 了解 is two words: it counts for nothing, and the phone's answer is Japanese for that reason.
  assert.equal(summaryLanguage(['了解'], ja), "Japanese, the language of the user's phone (nothing the user wrote names a language)");
  // The join of Han that says neither (fix round 1, Haiku-4's finding 1: with the join removed these two passed as English). (a) Nothing chosen on an English phone: two lines that
  // tell nothing join the Chinese line, which beats the one English line; (b) a chosen list with Japanese before Chinese: the two 「大丈夫」 join the Japanese line.
  assert.equal(summaryLanguage(['我们今晚去哪里吃饭', 'Where should we eat tonight?', '大家好', '大家早上好'], languageSettings({}, 'en-US')), 'Chinese (Simplified), the language most of what the user wrote is in');
  assert.equal(summaryLanguage(['今日の夕食はどこにしますか', 'Where should we eat tonight?', '大丈夫', '大丈夫'], languageSettings({ languages: { spoken: ['en', 'ja', 'zh'] } }, 'en-US')), 'Japanese, the language most of what the user wrote is in');
});

// Every row of the re-review of langs-next fix round 1 (R1), by what main and the round's first version answered: a short line (fewer than 3 words, a
// Chinese, Japanese or Korean character a word: spec §14 Short replies) counts for no language.
test("a line of fewer than 3 words counts for no language in the summary's", async () => {
  const { languageSettings, units } = await import('../../src/core/languages.js');
  const trip = '今日の夕食はどこにしますか';
  const eat = 'Where should we eat tonight?';
  const phone = languageSettings({}, 'en-US');
  const jaPhone = languageSettings({}, 'ja-JP');
  const both = languageSettings({ languages: { spoken: ['en', 'ja'] } }, 'en-US');
  assert.deepEqual(['ok', 'Big Sur', 'Thank you.', 'Is it far?', '新宿', '東京', 'はい', 'ありがとう', '大丈夫', '渋谷駅'].map(units), [1, 2, 2, 3, 2, 2, 2, 5, 3, 3]);
  // An English trip's last words are a place's name in kanji: English (the round's first version: Chinese on an English phone, Japanese on a Japanese one).
  assert.equal(summaryLanguage([eat, '新宿', 'ok'], phone), 'English, the language most of what the user wrote is in');
  assert.equal(summaryLanguage([eat, '新宿', 'ok'], jaPhone), 'English, the language most of what the user wrote is in');
  assert.equal(summaryLanguage([eat, '新宿', 'ok'], both), 'English, the language most of what the user wrote is in');
  assert.equal(summaryLanguage([eat, '東京', 'OK', 'OK'], phone), 'English, the language most of what the user wrote is in');
  assert.equal(summaryLanguage([eat, 'はい', 'ok'], jaPhone), 'English, the language most of what the user wrote is in');
  // A Japanese trip's last words are English, or a name in Latin letters (main: French, Spanish; the first version: the same): Japanese.
  for (const last of ['Thank you.', 'Big Sur', 'Los Angeles', 'hola', '¿Qué?', 'ありがとう', 'はい']) {
    assert.equal(summaryLanguage([trip, last], phone), 'Japanese, the language most of what the user wrote is in', last);
    assert.equal(summaryLanguage([trip, last], both), 'Japanese, the language most of what the user wrote is in', last);
  }
  assert.equal(summaryLanguage(['今日は楽しかった', '明日は雨ですか', 'thanks', 'ok'], jaPhone), 'Japanese, the language most of what the user wrote is in');
  // A line of 3 words or more is not a reply: it counts, in any language; one Japanese line against one English is a tie, and the newer is named.
  assert.equal(summaryLanguage([trip, 'Is it far?'], phone), 'English, the language most of what the user wrote is in');
  assert.equal(summaryLanguage([trip, 'Is it far?', 'ok'], both), 'English, the language most of what the user wrote is in');
  // A long booking pasted first names no language (none of the small words): one Japanese line is the trip's.
  assert.equal(summaryLanguage(['Booking confirmation: Hotel Nikko Tokyo, 2 nights from 12 March, reference ABC123, check-in after 3 pm, breakfast included', 'はい', '今日はどこに行きますか', 'ok'], phone), 'Japanese, the language most of what the user wrote is in');
  // Only short lines: none counts, so a lone 新宿 is the phone's answer (the round's rule read the lines together: Chinese on an English phone).
  assert.equal(summaryLanguage(['新宿'], phone), "English, the language of the user's phone (nothing the user wrote names a language)");
  // The size applies whether the languages are chosen or not (a short line counts for no language), and 'answer' still decides before any line.
  assert.equal(summaryLanguage([eat, '新宿', 'ok'], languageSettings({ languages: { spoken: ['en', 'ja'], answer: 'ja' } }, 'en-US')), 'Japanese, the language Shiori answers in');
});

// With nothing chosen the phone's language stands for its script, as a listed language does (the re-review of fix round 1: main said Russian for a
// Bulgarian line, Arabic for Persian). Its R2 (a proposed known limitation, asked of the user: a Chinese trip on a Japanese phone came out Japanese) is
// closed by placed (detector-next): a line whose writing shows another language than the phone's is that language.
test("with nothing chosen, the phone's language stands for its script (Bulgarian, Persian, Serbian on their phones), and a line whose writing shows another language is that one: Simplified on a Taiwanese phone, Chinese on a Japanese phone (detector-next: the R2 question closed by measurement)", async () => {
  const { languageSettings } = await import('../../src/core/languages.js');
  const at = (/** @type {string} */ locale, /** @type {string[]} */ lines) => summaryLanguage(lines, languageSettings({}, locale));
  assert.equal(at('bg-BG', ['Къде можем да вечеряме тази вечер?']), 'Bulgarian, the language most of what the user wrote is in');
  assert.equal(at('bg-BG', ['Къде можем да вечеряме тази вечер?', 'ok']), 'Bulgarian, the language most of what the user wrote is in');
  assert.equal(at('fa-IR', ['امشب کجا شام بخوریم؟']), 'Persian, the language most of what the user wrote is in');
  assert.equal(at('sr-RS', ['Где можемо да вечерамо вечерас?']), 'Serbian, the language most of what the user wrote is in');
  assert.equal(at('zh-TW', ['我们今晚去哪里吃饭']), 'Chinese (Simplified), the language most of what the user wrote is in', 'Simplified forms (main: the phone\'s Traditional)');
  assert.equal(at('ja-JP', ['我们今晚去哪里吃饭']), 'Chinese (Simplified), the language most of what the user wrote is in', 'characters only Chinese writes (main: the phone\'s Japanese)');
  assert.equal(at('ja-JP', ['東京駅', '大丈夫']), 'Japanese, the language most of what the user wrote is in', 'Han that says neither, on a Japanese phone: Japanese');
  // Not another phone's: a Russian line on an English phone is Russian, and Han characters alone on one are Chinese.
  assert.equal(at('en-US', ['Где можно поужинать сегодня вечером?']), 'Russian, the language most of what the user wrote is in');
  assert.equal(at('en-US', ['Къде можем да вечеряме тази вечер?']), 'Russian, the language most of what the user wrote is in');
});

test("files sent alone don't push the user's words out of what housekeeping reads for the summary's language", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'Summary.' }] });
  await updateAppSettings(k.ws, { languages: { spoken: ['en', 'ja'] } });
  for (const m of ['今日の夕食はどこにしますか', 'ラーメンがいいな', '駅の近くで', '明日の予定は？', 'ありがとう']) {
    k.agent.send(m);
    await k.agent.idle();
  }
  // Three hand-overs with no words, as the log keeps them: annai's "(files)", newest.
  for (let i = 0; i < 3; i++) await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: '(files)' } });
  assert.equal(await k.agent.compact('cold'), true);
  assert.match(k.requests.at(-1).system, /as plain text, in Japanese, the language most of what the user wrote is in\.$/);
});

test("housekeeping counts every line since the last summary: a Japanese talk that ends in an English thanks is summarized in Japanese (the design check of 2026-11-17)", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'Summary.' }] });
  await updateAppSettings(k.ws, { languages: { spoken: ['en', 'ja'] } });
  for (const m of ['今日の夕食はどこにしますか', 'ラーメンがいいな', '明日の予定は？', 'Thank you so much!', 'ok']) {
    k.agent.send(m);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  assert.match(k.requests.at(-1).system, /as plain text, in Japanese, the language most of what the user wrote is in\.$/);
});

// The window is the lines since the last summary (loop.js compact: the events after the last compaction's end): the second summary of a trip that
// changed language is in the new one, though the whole trip has more lines in the old (the review of summary-count-next, second opinion 3).
test("housekeeping counts the lines since the last summary, not the whole trip: a trip that changed language is summarized in the new one the second time", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'First summary.' }, { text: 'Second summary.' }] });
  await updateAppSettings(k.ws, { languages: { spoken: ['en', 'ja'] } });
  const english = ['Where should we eat tonight?', 'Is the museum open today?', 'What is the weather like there?', 'Can we get tickets for the show?', 'How far is it from here?'];
  for (const m of english) {
    k.agent.send(m);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold', { keepTokens: 0 }), true);
  assert.match(k.requests.at(-1).system, /as plain text, in English, the language most of what the user wrote is in\.$/);
  // The first summary kept the last three English exchanges word for word; the second window is those three and four Japanese lines.
  for (const m of ['今日の夕食はどこにしますか', 'ラーメンがいいな', '明日の予定は？', '駅の近くで']) {
    k.agent.send(m);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  assert.match(k.requests.at(-1).system, /as plain text, in Japanese, the language most of what the user wrote is in\.$/, 'the whole trip is five English lines against four Japanese');
});

test("a call that failed after reporting its prompt doesn't add to the next prompt's size: housekeeping isn't due early (the third review of phone-fixes-1, R3)", async () => {
  /** @type {{ fn: () => void, ms: number }[]} */
  const timers = [];
  const enc = new TextEncoder();
  const ev = (/** @type {string} */ name, /** @type {any} */ data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const start = (/** @type {string} */ id) => ev('message_start', { type: 'message_start', message: { id, usage: { input_tokens: 6000, output_tokens: 1 } } });
  const block = (/** @type {number} */ index, /** @type {string} */ name, /** @type {string} */ json) => ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `tu${index}`, name, input: {} } })
    + ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } }) + ev('content_block_stop', { type: 'content_block_stop', index });
  let n = 0;
  // The first call reports a 6000-token prompt, then is overloaded; the same model is asked again and answers, at 6000.
  const fetch = async () => {
    n++;
    const body = n === 1
      ? start('m1') + ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
      : start('m2') + block(0, 'speak', '{"text":"Hi."}') + block(1, 'sleep', '{}')
        + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } }) + ev('message_stop', { type: 'message_stop' });
    return new Response(enc.encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const k = await agentKit([{ ability: { type: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', tunables: { cacheTtl: '5m' } } }], {
    models: [{ providerId: 'claude-sonnet-5-5', contextWindow: 10000 }], fetch,
    agent: { timers: { set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.push({ fn, ms }), clear: () => {} } },
  });
  k.agent.send('Hello');
  await k.agent.idle();
  assert.equal(n, 2);
  const [turn] = await k.events(['model.turn']);
  assert.equal(turn.data.usage.input, 12000, "the turn's record counts both calls");
  assert.equal(timers.length, 0, 'a 6000-token prompt in a 10000 window is not due for housekeeping (threshold 0.7)');
});

test("warm housekeeping goes on past a reader that fails to a model that reads no PDFs, the newest PDF a note (2026-10-28, 04:04)", async () => {
  // Main: model-0 reads PDFs (it reads the booking, then fails the summary, out of credit); model-1 reads none and writes the summary.
  const readAndSleep = { toolCalls: [{ name: 'speak', input: { text: 'Got it.' } }, { name: 'read', input: { path: '/trip/files/booking.pdf' } }, { name: 'sleep', input: {} }] };
  const k = await agentKit([[say('a'), say('b'), say('c'), readAndSleep, { error: 'credit', status: 402 }], [{ text: 'Summary.' }]], { models: [{ input: ['text', 'pdf'] }, { input: ['text'] }] });
  await k.ws.write(k.trip, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  for (const text of ['Hi', 'Hello', 'Hey', 'Read the booking']) {
    k.agent.send(text);
    await k.agent.idle();
  }
  assert.match(JSON.stringify(k.agent.transcript.messages.at(-1)), /"type":"document"/, 'the PDF is in the newest message');
  assert.equal(await k.agent.summarizeNow(), 'done');
  const asked = JSON.stringify(k.sent['model-1'].at(-1).messages);
  assert.match(asked, /\[a PDF: booking\.pdf\]/);
  assert.doesNotMatch(asked, /"type":"document"/);
  assert.equal((await k.events(['compaction'])).at(-1).data.mode, 'warm');
  assert.equal((await k.events(['error'])).filter((e) => e.data.kind === 'compaction').length, 0);
});

test("the retry after housekeeping for a request too long doesn't describe the user's photo again: its kept reading goes in (the review of reading-files)", async () => {
  const k = await agentKit([[say('1'), say('2'), say('3'), { error: 'context', status: 400, message: 'prompt is too long' }, say('fits now')]], { models: [{ input: ['text'] }], utility: [{ text: 'A menu; the fish is circled.' }, { text: 'Summary.' }, { text: 'A menu again.' }] });
  await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('800x600'), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  for (let i = 0; i < 3; i++) {
    k.agent.send(`Turn ${i}`);
    await k.agent.idle();
  }
  k.agent.send("What's this?", { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.equal((await k.events(['out.speak'])).at(-1).data.text, 'fits now');
  assert.equal(k.sent['model-u'].length, 2, 'one description and one summary');
  assert.match(JSON.stringify(k.sent['model-0'].at(-1).messages), /the fish is circled/);
});

test("the housekeeping estimate counts what the main models are sent: one photo sent five times is one picture, not five (round 9)", async () => {
  const k = await agentKit([[say('A view.')]], { models: [{ input: ['text', 'image'], contextWindow: 7000 }], utility: [{ text: 'Summary.' }] });
  await k.ws.write(k.trip, '/files/view.webp', new TextEncoder().encode('800x600'), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  for (let i = 0; i < 5; i++) {
    k.agent.send(`Look ${i}`, { photos: [{ path: '/trip/files/view.webp' }] });
    await k.agent.idle();
  }
  assert.equal(new Set(k.requests.at(-1).messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'image').map((/** @type {any} */ p) => p.hash)).size, 1);
  assert.equal((await k.events(['model.turn'])).filter((e) => e.data.tag === 'compaction').length, 0, 'no tidy-up tried for copies it never sends');
});

test('requestBytes and estimateTokens count a native for what it adds beyond the parts it covers, not twice (the keep-reasoning review)', async () => {
  const { requestBytes } = await import('../../src/core/agent/compaction.js');
  const { estimateTokens } = await import('../../src/core/llm/fallback.js');
  const page = 'P'.repeat(60_000);
  const parts = [{ type: 'provider', block: { type: 'result', page }, model: 'm' }];
  const user = { role: 'user', parts: [{ type: 'text', text: 'Hi' }] };
  const bare = /** @type {any} */ ({ messages: [user, { role: 'assistant', parts }] });
  // The reply as the provider returned it holds the page again, and 20 KB of thinking.
  const content = [{ type: 'thinking', thinking: '', signature: 'S'.repeat(20_000) }, { type: 'result', page }];
  const kept = /** @type {any} */ ({ messages: [user, { role: 'assistant', parts: [{ type: 'native', endpoint: 'e', content, covers: 1, prefix: 'p' }, ...parts] }] });
  const extra = requestBytes(kept) - requestBytes(bare);
  assert.ok(extra > 19_000 && extra < 21_000, `the native adds its signature, not the page again: ${extra}`);
  const tokens = estimateTokens(kept) - estimateTokens(bare);
  assert.ok(tokens > 5_000 && tokens < 6_500, `${tokens} tokens`);
  // A reply with nothing to add counts as it did.
  const same = /** @type {any} */ ({ messages: [user, { role: 'assistant', parts: [{ type: 'native', endpoint: 'e', content: [{ type: 'result', page }], covers: 1, prefix: 'p' }, ...parts] }] });
  assert.ok(requestBytes(same) - requestBytes(bare) < 200);
});
