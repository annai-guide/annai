// Fixes 2, item 1: Koe owes the user Kokoro's note, and a message that reached it inside its wait (the emulator re-check: 5 of 5 answers lost).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';

const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
/** @param {...[string, any]} calls */
const calls = (...calls) => ({ toolCalls: calls.map(([name, input]) => ({ name, input })) });
const SAY = 'Say: sunset tonight is at 6:23 PM, but it is overcast.';
const RELAY = { text: 'x', toolCalls: [{ name: 'speak', input: { text: 'Sunset is at 6:23, though it is overcast.' } }, { name: 'sleep', input: {} }] };
const CHECK = calls(['speak', { text: 'Let me check.' }], ['tell_kokoro', { text: 'When is sunset?' }], ['wait', { seconds: 600 }]);
/** Kokoro tells Koe and sleeps. @param {string} [text] */
const kokoro = (text = SAY) => [{ toolCalls: [{ name: 'tell_koe', input: { text } }, { name: 'sleep', input: {} }] }];
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
  assert.match(JSON.stringify(koe[2].messages.at(-1)), /Kokoro's note is for the user/);
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

test('Koe still says nothing after being asked: annai shows the note itself, in plain words, with no "didn\'t answer" card', async () => {
  const k = await agentKit([kokoro()], { koe: { type: [CHECK, sleep] } });
  k.agent.send('A sunset drink in Carmel');
  await k.agent.idle();
  const shown = (await k.events(['reminder'])).map((e) => [e.data.title, e.data.text, e.data.unsaid]);
  assert.deepEqual(shown, [["Shiori's answer", 'Sunset tonight is at 6:23 PM, but it is overcast.', true]]);
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
