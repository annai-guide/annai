// Fixes 2, item 1: Koe owes the user Kokoro's note, and a message that reached it inside its wait (the emulator re-check: 5 of 5 answers lost).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';

const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
/** @param {...[string, any]} calls */
const calls = (...calls) => ({ toolCalls: calls.map(([name, input]) => ({ name, input })) });
const SAY = 'Say: sunset tonight is at 6:23 PM, but it is overcast.';
/** Kokoro's exact words for the user with it (tell_koe's for_user). */
const FOR_USER = 'Sunset is at 6:23 PM tonight, though it is overcast.';
const RELAY = { text: 'x', toolCalls: [{ name: 'speak', input: { text: 'Sunset is at 6:23, though it is overcast.' } }, { name: 'sleep', input: {} }] };
const CHECK = calls(['speak', { text: 'Let me check.' }], ['tell_kokoro', { text: 'When is sunset?' }], ['wait', { seconds: 600 }]);
/** Kokoro tells Koe and sleeps. @param {string} [text] @param {string} [forUser] its words for the user */
const kokoro = (text = SAY, forUser = text === SAY ? FOR_USER : undefined) => [{ toolCalls: [{ name: 'tell_koe', input: { text, ...(forUser ? { for_user: forUser } : {}) } }, { name: 'sleep', input: {} }] }];
/** What Koe said to the user. @param {any} k */
const said = async (k) => (await k.events(['out.speak'])).filter((e) => e.data.half === 'koe').map((e) => e.data.text);

test('Koe ends its wait on a bare sleep: it is asked once more, with the request forced, and says the note', async () => {
  const k = await agentKit([kokoro()], { koe: { type: [CHECK, sleep, RELAY] } });
  k.agent.send('A sunset drink in Carmel');
  await k.agent.idle();
  assert.deepEqual(await said(k), ['Let me check.', 'Sunset is at 6:23, though it is overcast.']);
  const koe = k.sent['model-koe'];
  assert.equal(koe.length, 3);
  assert.equal(koe[1].toolRequired, true, 'forcing stays on while the note is unsaid');
  assert.match(JSON.stringify(koe[2].messages.at(-1)), /Kokoro's note hasn't reached the user/);
  assert.deepEqual(k.notices, []);
});

test('Koe relays the note as plain text: that is private; it is asked once more', async () => {
  const k = await agentKit([kokoro()], { koe: { type: [CHECK, { text: 'Sunset is at 6:23, though overcast.' }, RELAY] } });
  k.agent.send('A sunset drink in Carmel');
  await k.agent.idle();
  assert.deepEqual(await said(k), ['Let me check.', 'Sunset is at 6:23, though it is overcast.']);
  assert.equal(k.sent['model-koe'].length, 3);
});

test('Koe only asks Kokoro a follow-up after the note: a note to Kokoro does not reach the user', async () => {
  const k = await agentKit([kokoro()], { koe: { type: [CHECK, { toolCalls: [{ name: 'tell_kokoro', input: { text: 'Retry in ten minutes?' } }, { name: 'sleep', input: {} }] }, RELAY] } });
  k.agent.send('A sunset drink in Carmel');
  await k.agent.idle();
  assert.deepEqual((await said(k)).slice(0, 2), ['Let me check.', 'Sunset is at 6:23, though it is overcast.']);
});

test('the note wakes Koe on its own (it had slept) and Koe sleeps at once: asked once more', async () => {
  const k = await agentKit([kokoro()], { koe: { type: [calls(['speak', { text: 'Let me check.' }], ['sleep', {}]), sleep, RELAY] } });
  k.agent.send('A sunset drink in Carmel');
  await k.agent.idle();
  assert.deepEqual(await said(k), ['Let me check.', 'Sunset is at 6:23, though it is overcast.']);
});

test('the user wrote again inside the wait, and Koe ends without answering: asked once more', async () => {
  const k = await agentKit([[{ delayMs: 1000, ...sleep }]], { koe: { type: [CHECK, { text: 'ok' }, { toolCalls: [{ name: 'speak', input: { text: 'Tomorrow is dry.' } }, { name: 'sleep', input: {} }] }] } });
  k.agent.send('Will it rain in Carmel tomorrow?');
  await until(() => k.agent.koe.waiting);
  k.agent.send('Which day is it?');
  await k.agent.idle();
  assert.equal((await k.events(['tool.result'])).find((e) => e.data.name === 'wait')?.data.content, 'The user wrote: Which day is it?');
  assert.equal(k.sent['model-koe'].length, 3, 'asked once more');
  assert.equal(k.sent['model-koe'][1].toolRequired, true);
  assert.deepEqual((await said(k)).at(-1), 'Tomorrow is dry.');
});

test('Koe still says nothing after being asked: annai shows Kokoro\'s words for the user (for_user), with no "didn\'t answer" card', async () => {
  const k = await agentKit([kokoro()], { koe: { type: [CHECK, sleep] } });
  k.agent.send('A sunset drink in Carmel');
  await k.agent.idle();
  const shown = (await k.events(['reminder'])).map((e) => [e.data.title, e.data.text, e.data.unsaid]);
  assert.deepEqual(shown, [["Shiori's answer", FOR_USER, true]]);
  assert.ok(!k.notices.some((/** @type {any} */ n) => /didn't answer/.test(n.title)));
});

test('"Kokoro has nothing to add" and "was stopped" are not for the user: Koe may end quietly', async () => {
  const k = await agentKit([[sleep]], { koe: { type: [calls(['speak', { text: 'Let me look.' }], ['tell_kokoro', { text: 'Anything?' }], ['wait', { seconds: 600 }]), sleep] } });
  k.agent.send('Anything to see here?');
  await k.agent.idle();
  assert.equal(k.sent['model-koe'].length, 2);
  assert.deepEqual(k.notices, []);
  assert.deepEqual(await k.events(['reminder']), []);
});

// Item 3 (F25 again): Koe asked Kokoro anew 4 s after hearing "Kokoro was stopped", and the plan went on.
test("after the user's Stop, Koe's tell_kokoro is refused in words until the user writes again; then it goes through", async () => {
  const k = await agentKit([[{ delayMs: 30_000, ...sleep }]], { koe: { type: [
    CHECK,
    calls(['tell_kokoro', { text: 'Plan it anyway.' }], ['speak', { text: 'Stopped.' }], ['sleep', {}]),
    calls(['tell_kokoro', { text: 'Plan it, as asked.' }], ['sleep', {}]),
    sleep,
  ] } });
  const turns = () => (k.sent['model-0'] ?? []).length;
  k.agent.send('Plan our afternoon around the sunset');
  await until(() => turns() === 1 && k.agent.koe.waiting, 8000);
  k.agent.stopKokoro();
  await k.agent.idle();
  const asks = (await k.events(['tool.result'])).filter((e) => e.data.name === 'tell_kokoro');
  assert.equal(asks.length, 2);
  assert.equal(asks[1].data.ok, false);
  assert.match(asks[1].data.content, /the user stopped Kokoro/i);
  assert.equal(turns(), 1, 'Kokoro was not asked again');
  assert.deepEqual((await k.events(['note'])).filter((e) => e.data.from === 'koe').map((e) => e.data.text), ['When is sunset?']);
  // The user writes again: Koe may ask.
  k.agent.send('Yes, plan it.');
  await k.agent.idle();
  assert.equal((await k.events(['tool.result'])).filter((e) => e.data.name === 'tell_kokoro').at(-1).data.ok, true);
  assert.equal(turns(), 2);
});

// The fix pass (M1): annai shows only what Kokoro meant the user to have, and a card or a question as itself.
/** Kokoro calls one tool while Koe talks (gated), then sleeps. @param {string} name @param {any} input */
const gated = (name, input) => [{ toolCalls: [{ name, input }, { name: 'sleep', input: {} }] }];
/** What annai showed by itself: reminders, and the cards it put up. @param {any} k */
const backstop = async (k) => (await k.events(['reminder'])).map((e) => [e.data.title, e.data.text]);

test("Kokoro's list fails and Koe never tells the user so, asked once more: still no card (plan decision 21)", async () => {
  const k = await agentKit([[{ error: 'auth', message: 'bad key' }]], { koe: { type: [CHECK, sleep, sleep] } });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  assert.equal(k.sent['model-koe'].length, 3, 'asked once more');
  assert.match(JSON.stringify(k.sent['model-koe'][2].messages.at(-1)), /Kokoro's note/);
  assert.deepEqual(await backstop(k), []);
  assert.deepEqual(k.notices, []);
});

test("Kokoro's plain final text that Koe never says: Koe is asked once more, and annai shows nothing", async () => {
  const k = await agentKit([[{ text: 'Koe already answered this; nothing for me to do here.' }]], { koe: { type: [CHECK, sleep, sleep] } });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  assert.deepEqual((await k.events(['note'])).filter((e) => e.data.from === 'kokoro').map((e) => e.data.why), ['final-text']);
  assert.equal(k.sent['model-koe'].length, 3, 'asked once more');
  assert.deepEqual(await backstop(k), []);
  assert.deepEqual(k.notices, []);
});

test("Kokoro's card, gated while Koe talks, that Koe never passes on: annai shows the card itself, whole, with no wrapper", async () => {
  const card = { title: 'Nepenthe', text: 'Open 11:30–22:00 today.', links: [{ label: 'Site', url: 'https://nepenthe.com' }] };
  const k = await agentKit([gated('show', { card })], { koe: { type: [CHECK, sleep, sleep] } });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  assert.equal(k.sent['model-koe'].length, 3, 'asked once more');
  const shows = await k.events(['out.show']);
  assert.equal(shows.length, 1);
  assert.deepEqual(shows[0].data.card, card);
  assert.deepEqual(await backstop(k), []);
  assert.deepEqual(k.notices, []);
  assert.ok(!JSON.stringify(await k.events(['reminder', 'out.show', 'out.ask', 'out.speak'])).includes('Kokoro wants to'));
});

test("Kokoro's question, gated, that Koe never asks: annai asks it with its buttons, and a tap reaches Koe", async () => {
  const k = await agentKit([gated('ask', { question: 'Which table time?', options: ['18:00', '19:30'] }), [sleep]], { koe: { type: [CHECK, sleep, sleep, calls(['speak', { text: 'Booked for 19:30.' }], ['sleep', {}])] } });
  k.agent.send('Book us at Nepenthe');
  await k.agent.idle();
  const asks = await k.events(['out.ask']);
  assert.deepEqual(asks.map((e) => [e.data.question, e.data.options]), [['Which table time?', ['18:00', '19:30']]]);
  assert.deepEqual(await backstop(k), []);
  assert.deepEqual(k.notices, []);
  k.agent.answer(asks[0].data.id, '19:30');
  await k.agent.idle();
  assert.equal((await k.events(['msg.user'])).at(-1).data.text, '19:30');
  assert.equal((await k.events(['out.speak'])).at(-1).data.text, 'Booked for 19:30.');
});

test("Kokoro's speak, gated, that Koe never passes on: annai shows it as Shiori's answer", async () => {
  const k = await agentKit([gated('speak', { text: 'It opens at 11:30 today.' })], { koe: { type: [CHECK, sleep, sleep] } });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  assert.deepEqual(await backstop(k), [["Shiori's answer", 'It opens at 11:30 today.']]);
});

test('Koe owes a note and a message the user wrote in its wait, and says nothing: annai shows the note, and the "didn\'t answer" card still comes', async () => {
  const k = await agentKit([[{ delayMs: 300, toolCalls: [{ name: 'tell_koe', input: { text: SAY, for_user: FOR_USER } }, { name: 'sleep', input: {} }] }, sleep]], { koe: { type: [CHECK, { delayMs: 600, ...sleep }, sleep] } });
  k.agent.send('A sunset drink in Carmel');
  await until(() => k.agent.koe.waiting);
  k.agent.send('Which day is it?');
  await k.agent.idle();
  assert.deepEqual(await backstop(k), [["Shiori's answer", FOR_USER]]);
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => n.title).filter((t) => /didn't answer/.test(t)), ["Shiori didn't answer"]);
});

// The fix pass's security review: what annai shows for Kokoro is checked as Shiori's own show and ask check it.
test("a gated card of a kind no plugin draws isn't shown as a card: annai gives its words instead, as show refuses it", async () => {
  const k = await agentKit([gated('show', { card: { type: 'ferries', title: 'Nepenthe', text: 'Open till 10.', data: {} } })], { koe: { type: [CHECK, sleep, sleep] } });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  assert.deepEqual(await k.events(['out.show']), []);
  assert.deepEqual(await backstop(k), [["Shiori's answer", 'Nepenthe: Open till 10.']]);
});

test('a gated card annai shows keeps only http(s) links, a photo and a booking inside the trip, and choices that are words, as show does', async () => {
  const card = {
    title: 'Nepenthe', text: 'Open till 10.',
    links: [{ label: 'Site', url: 'https://nepenthe.com' }, { label: 'Run', url: 'javascript:alert(1)' }, { label: 'Data', url: 'data:text/html,<script>1</script>' }],
    image: '/trip/../../me/secret.webp', booking: '/etc/passwd', choice: ['Book', 7],
  };
  const k = await agentKit([gated('show', { card })], { koe: { type: [CHECK, sleep, sleep] } });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  const [shown] = await k.events(['out.show']);
  assert.deepEqual(shown.data.card, { title: 'Nepenthe', text: 'Open till 10.', links: [{ label: 'Site', url: 'https://nepenthe.com' }], choice: ['Book'] });
});

test("a gated question with an option that isn't words isn't asked: annai gives its words instead, as ask refuses it", async () => {
  const k = await agentKit([gated('ask', { question: 'Which table time?', options: ['18:00', 7] })], { koe: { type: [CHECK, sleep, sleep] } });
  k.agent.send('Book us at Nepenthe');
  await k.agent.idle();
  assert.deepEqual(await k.events(['out.ask']), []);
  assert.deepEqual(await backstop(k), [["Shiori's answer", 'Which table time? (18:00, 7)']]);
});

// The fix pass (S1): the cue asks for what the note adds, and Koe settles a note it has already said with already_told.
test("Koe already said what Kokoro's note says, and settles it with already_told: nothing is shown and Koe isn't asked again (probe P4)", async () => {
  const k = await agentKit([kokoro('Say: Nepenthe is open until 10 PM today.')], { koe: { type: { rules: [
    { match: 'the user wrote', reply: calls(['speak', { text: 'Nepenthe is open until 10 tonight.' }], ['sleep', {}]) },
    { match: 'a note from Kokoro', reply: calls(['already_told', {}], ['sleep', {}]) },
  ] } } });
  k.agent.send('Is Nepenthe open tonight?');
  await k.agent.idle();
  assert.deepEqual(await said(k), ['Nepenthe is open until 10 tonight.']);
  assert.equal(k.sent['model-koe'].length, 2, 'no cue');
  assert.deepEqual(await backstop(k), []);
  assert.deepEqual(k.notices, []);
});

test("the cue asks Koe for what the note adds, in its own words, and names already_told; Koe settles it after the cue", async () => {
  const k = await agentKit([kokoro()], { koe: { type: [CHECK, sleep, calls(['already_told', {}], ['sleep', {}])] } });
  k.agent.send('A sunset drink in Carmel');
  await k.agent.idle();
  assert.equal(k.sent['model-koe'].length, 3);
  const cue = JSON.stringify(k.sent['model-koe'][2].messages.at(-1));
  assert.match(cue, /what it adds, in your own words/);
  assert.match(cue, /already_told/);
  assert.doesNotMatch(cue, /Say what the note says/);
  assert.deepEqual(await backstop(k), []);
});

test("already_told settles Kokoro's note, not a message the user wrote in Koe's wait: that is still owed", async () => {
  const k = await agentKit([[{ delayMs: 300, toolCalls: [{ name: 'tell_koe', input: { text: SAY } }, { name: 'sleep', input: {} }] }, sleep]], { koe: { type: [CHECK, { delayMs: 600, ...sleep }, calls(['already_told', {}], ['sleep', {}]), sleep] } });
  k.agent.send('A sunset drink in Carmel');
  await until(() => k.agent.koe.waiting);
  k.agent.send('Which day is it?');
  await k.agent.idle();
  assert.deepEqual(await backstop(k), []);
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => n.title), ["Shiori didn't answer"]);
});

test("Koe's instructions say a note it has already said is settled with already_told, and the tool is always on", async () => {
  const k = await agentKit([[sleep]], { koe: { type: [CHECK, sleep] } });
  k.agent.send('Hi');
  await k.agent.idle();
  const koe = k.sent['model-koe'][0];
  assert.match(koe.system, /if it adds nothing, call already_told/);
  assert.ok(koe.tools.some((/** @type {any} */ t) => t.name === 'already_told'));
  const { ALWAYS_ON } = await import('../../src/core/agent/tools.js');
  assert.ok(ALWAYS_ON.includes('already_told'));
});

// The fix pass (S3): forcing is bounded without a step limit.
test("Koe owes a note and keeps asking Kokoro instead: the cue comes after its first such step, two steps more at most, then annai shows the note (probe P5b)", async () => {
  const more = Array.from({ length: 40 }, (_, j) => calls(['tell_kokoro', { text: `More ${j}` }]));
  const k = await agentKit([kokoro('Say: it is open.', 'It is open.')], { koe: { type: [CHECK, ...more] } });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  const koe = k.sent['model-koe'];
  assert.equal(koe.length, 4, 'the step that owed, then two more after the cue');
  assert.match(JSON.stringify(koe[2].messages.at(-1)), /Kokoro's note hasn't reached the user/);
  assert.deepEqual(await backstop(k), [["Shiori's answer", 'It is open.']]);
  assert.ok(!k.notices.some((/** @type {any} */ n) => /step limit/.test(n.title)));
});

test('Koe looks something up after the note, then says it: the cue comes once, and nothing is shown', async () => {
  const k = await agentKit([kokoro()], { koe: { type: [CHECK, calls(['recall', { query: 'sunset spots' }]), RELAY] } });
  k.agent.send('A sunset drink in Carmel');
  await k.agent.idle();
  assert.equal(k.sent['model-koe'].length, 3);
  assert.deepEqual((await said(k)).at(-1), 'Sunset is at 6:23, though it is overcast.');
  assert.deepEqual(await backstop(k), []);
});

// The fix pass (S2): "woke for" gives each reason once, so a cue already acted on isn't read again at every step.
test('"woke for" gives the wake\'s reasons on the first request only, and each reason or cue that joins later once, on the next; the lines stay in the transcript (probe P8)', async () => {
  const { NOTE_UNSAID } = await import('../../src/core/agent/loop.js');
  const k = await agentKit([kokoro('Say: sunset is at 6:23 PM.')], { koe: { type: [CHECK, sleep, calls(['speak', { text: 'Sunset is at 6:23.' }], ['recall', { query: 'sunset spots' }]), sleep] } });
  k.agent.send('A sunset drink in Carmel');
  await k.agent.idle();
  const woke = k.sent['model-koe'].map((/** @type {any} */ r) => String(r.tail).split('\n').find((l) => l.startsWith('woke for')) ?? '');
  assert.deepEqual(woke, ['woke for: the user wrote', 'woke for: a note from Kokoro', `woke for: ${NOTE_UNSAID}`, '']);
  const last = JSON.stringify(k.sent['model-koe'][3].messages);
  assert.ok(last.includes('sunset is at 6:23 PM') && last.includes("Kokoro's note hasn't reached the user"), 'the note and the cue are in the conversation');
});

test("the user's Try again after the Stop lifts its hold: Koe's tell_kokoro goes through again (the fix pass)", async () => {
  const k = await agentKit([[{ delayMs: 30_000, ...sleep }, sleep]], { koe: { type: [CHECK, sleep, calls(['tell_kokoro', { text: 'Plan it, as asked.' }], ['sleep', {}]), sleep] } });
  k.agent.send('Plan our afternoon around the sunset');
  await until(() => (k.sent['model-0'] ?? []).length === 1 && k.agent.koe.waiting, 8000);
  k.agent.stopKokoro();
  await k.agent.idle();
  k.agent.tryAgain();
  await k.agent.idle();
  const asks = (await k.events(['tool.result'])).filter((e) => e.data.name === 'tell_kokoro');
  assert.deepEqual(asks.map((e) => e.data.ok), [true, true]);
  assert.equal(k.sent['model-0'].length, 2, 'Kokoro was asked again');
});

// The second fix pass (M7): a gated card or question too broken to show reaches the user as its words, or as nothing but a Trace line.
test("a gated card with nothing annai can show and no words of its own: no card, nothing shown, and a line in the Trace", async () => {
  const k = await agentKit([gated('show', { card: { links: [{ label: 'Run', url: 'javascript:alert(1)' }] } })], { koe: { type: [CHECK, sleep, sleep] } });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  assert.deepEqual(await k.events(['out.show']), []);
  assert.deepEqual(await backstop(k), []);
  const trace = (await k.events(['error'])).filter((e) => e.data.kind === 'unshown');
  assert.equal(trace.length, 1);
  assert.equal(trace[0].data.quiet, true);
});

test('a gated question too broken to ask reaches the user as its words, cut as a card\'s text is', async () => {
  const k = await agentKit([gated('ask', { question: `Which table? ${'x'.repeat(5000)}`, options: [] })], { koe: { type: [CHECK, sleep, sleep] } });
  k.agent.send('Book us at Nepenthe');
  await k.agent.idle();
  const [[title, text]] = await backstop(k);
  assert.equal(title, "Shiori's answer");
  assert.ok(text.startsWith('Which table?') && text.length <= 4000, String(text.length));
});

// voice-fix item 2 (the iPhone trace, 2026-10-22: "Tell them a short Big Sur story…" was shown, and read aloud): a note is words for Koe.
test("Kokoro's note with no words for the user that Koe never says: nothing is shown or said; Koe gets it again with the user's next message, and after that only the Trace has it", async () => {
  const note = 'Tell them sunset is at 6:23 PM tonight (timeanddate.com), and that it is overcast.';
  const k = await agentKit([kokoro(note), [sleep], [sleep]], { voice: { mode: 'on' }, koe: { type: [CHECK, sleep, sleep, sleep, sleep, sleep] } });
  k.agent.send('A sunset drink in Carmel');
  await k.agent.idle();
  assert.equal(k.sent['model-koe'].length, 3, 'asked once more');
  assert.deepEqual(await backstop(k), [], 'not shown');
  assert.ok(!k.said.some((/** @type {string} */ t) => t.includes('6:23')), 'not said');
  k.agent.send('And the weather?');
  await k.agent.idle();
  const after = k.sent['model-koe'].slice(3).map((/** @type {any} */ r) => JSON.stringify(r.messages)).join('');
  assert.ok(after.includes('sunset is at 6:23 PM tonight'), "the note is in Koe's next turn");
  assert.deepEqual(await backstop(k), []);
  assert.ok(!k.said.some((/** @type {string} */ t) => t.includes('6:23')));
  assert.equal((await k.events(['error'])).filter((e) => e.data.kind === 'unshown').length, 1, 'a quiet Trace line, once');
});

test("tell_koe gives Kokoro for_user, and Kokoro's instructions say to fill it when it has the user's answer", async () => {
  const k = await agentKit([kokoro()], { koe: { type: [CHECK, RELAY] } });
  k.agent.send('A sunset drink in Carmel');
  await k.agent.idle();
  const tell = k.sent['model-0'][0].tools.find((/** @type {any} */ t) => t.name === 'tell_koe');
  assert.deepEqual(tell.input.properties.for_user, { type: 'string' });
  assert.match(k.sent['model-0'][0].system, /for_user: the exact words for them/);
  const [note] = (await k.events(['note'])).filter((e) => e.data.from === 'kokoro');
  assert.equal(note.data.forUser, FOR_USER, 'kept with the note in the conversation');
});
