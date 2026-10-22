import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { TASK_STEPS } from '../../src/core/agent/self-tools.js';
import { utf8 } from '../../src/core/bytes.js';
import { typeForPath } from '../../src/core/paths.js';

const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };

test('task: a helper on the utility model, with only the tools it was given, returns what it found', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'task', input: { prompt: 'List the trip files', tools: ['list', 'speak'] } }] }, sleep]], {
    utility: [{ toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, { text: 'There is trip.json and memory.md.' }],
  });
  /** @type {string[]} */
  const states = [];
  k.agent.on('state', (s) => states.push(s.label));
  k.agent.send('What files do we have?');
  await k.agent.idle();
  const helper = k.requests.filter((r) => r.messages[0].parts[0].text === 'List the trip files');
  assert.equal(helper.length, 2);
  assert.deepEqual(helper[0].tools.map((/** @type {any} */ t) => t.name), ['list']);
  const result = (await k.events(['tool.result'])).find((e) => e.data.name === 'task');
  assert.equal(result.data.content, 'There is trip.json and memory.md.');
  assert.ok((await k.events(['tool.call'])).some((e) => e.data.name === 'list' && e.data.task));
  assert.ok(states.includes('Working on List the trip files'));
});

test(`task: a helper that never finishes stops after ${TASK_STEPS} steps`, async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'task', input: { prompt: 'Loop' } }] }, sleep]], { utility: [{ toolCalls: [{ name: 'list', input: { path: '/me/' } }] }] });
  k.agent.send('Go');
  await k.agent.idle();
  assert.equal(k.requests.filter((r) => r.messages[0].parts[0].text === 'Loop').length, TASK_STEPS);
  assert.match((await k.events(['tool.result'])).find((e) => e.data.name === 'task').data.content, /stopped after 25 steps/);
});

test('skill: a registered skill by name, or the ones there are', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'skill', input: { name: 'driving' } }, { name: 'skill', input: { name: 'hiking' } }, { name: 'speak', input: { text: 'Ready.' } }, { name: 'sleep', input: {} }] }]]);
  k.registry.add('drive', 'skill', { name: 'driving', description: 'Guiding while driving.', text: 'Keep it short while driving.' });
  k.agent.send('Go');
  await k.agent.idle();
  const results = (await k.events(['tool.result'])).filter((e) => e.data.name === 'skill').map((e) => e.data.content);
  assert.deepEqual(results, ['Keep it short while driving.', 'There is no skill called "hiking". Skills: driving.']);
});

test('recall brings back the exact words from before a compaction, with photos as stubs', async () => {
  const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
  const k = await agentKit([[say('Nepenthe opens at 11:30.'), say('ok'), say('ok'), say('ok'), { toolCalls: [{ name: 'recall', input: { query: 'nepenthe' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]], { utility: [{ text: 'Summary.' }] });
  await k.ws.write(k.trip, '/files/menu.webp', new TextEncoder().encode('800x600'), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  for (const [m, photos] of /** @type {[string, any[]][]} */ ([['When does Nepenthe open?', [{ path: '/trip/files/menu.webp', region: [0, 0, 0.5, 0.5] }]], ['One', []], ['Two', []], ['Three', []]])) {
    k.agent.send(m, { photos });
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  k.agent.send('What did you say about Nepenthe?');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'recall');
  const text = r.data.content ?? '';
  assert.match(text, /user: When does Nepenthe open\? \[photo \/trip\/files\/menu\.webp, part \[0, 0, 0\.5, 0\.5\]\]/);
  assert.match(text, /Shiori said: Nepenthe opens at 11:30\./);
});

test('skill: a file from the skill, as text or as an image; a missing one says what there is (choice 9)', async () => {
  const k = await agentKit([[{ toolCalls: [
    { name: 'skill', input: { name: 'tide-pools' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'references/safety.md' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'assets/chart.png' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'scripts/fetch.py' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'assets/data.bin' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'nope.md' } },
    { name: 'sleep', input: {} },
  ] }]]);
  const kept = new Map([['references/safety.md', utf8('Watch the waves.')], ['assets/chart.png', new Uint8Array([137, 80, 78, 71])], ['scripts/fetch.py', utf8('print(1)')], ['assets/data.bin', new Uint8Array(3)]]);
  k.registry.add('tide-pools', 'skill', {
    name: 'tide-pools', description: 'Tide pools.', text: async () => '# Tide pools',
    files: async () => [...kept.keys()], read: async (/** @type {string} */ f) => (kept.has(f) ? { bytes: kept.get(f), type: typeForPath(f) } : null),
  });
  k.agent.send('Go');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).filter((e) => e.data.name === 'skill');
  assert.equal(r[0].data.content, '# Tide pools\n\nFiles in this skill (read one with skill({ name: "tide-pools", file })): references/safety.md, assets/chart.png, scripts/fetch.py, assets/data.bin');
  assert.equal(r[1].data.content, 'Watch the waves.');
  assert.equal(r[2].data.images.length, 1);
  assert.equal(r[3].data.content, 'print(1)');
  assert.equal(r[4].data.content, "assets/data.bin is application/octet-stream, 3 bytes: annai can't show this kind of file.");
  assert.match(r[5].data.content, /^There is no file nope\.md in the skill tide-pools\. Its files: references\/safety\.md/);
});

/** A Shiori whose helper (the utility model) reads PDFs or not, and a PDF in the trip. @param {any[]} main @param {any[]} utility @param {{ helperPdf?: boolean, mainInput?: string[] }} o */
async function helperKit(main, utility, { helperPdf = false, mainInput = ['text', 'image'] } = {}) {
  const { saveModel } = await import('../../src/core/llm/config.js');
  const k = await agentKit([main], { models: [{ input: mainInput }], utility });
  if (helperPdf) {
    const u = (await k.llm.config()).models['m-u'];
    await saveModel(k.ws, { ...u, user: { ...u.user, input: ['text', 'pdf'] } });
  }
  await k.ws.write(k.trip, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  return k;
}
const helperReads = { toolCalls: [{ name: 'read', input: { path: '/trip/files/booking.pdf' } }] };
const delegate = { toolCalls: [{ name: 'task', input: { prompt: 'Read the booking PDF', tools: ['read'] } }] };
/** The helper's requests. @param {any} k */
const helperRequests = (k) => k.requests.filter((/** @type {any} */ r) => r.messages[0].parts[0].text === 'Read the booking PDF');

test("task: a helper whose model reads PDFs gets the document itself from its read, as Shiori would (the third emulator pass)", async () => {
  const k = await helperKit([delegate, sleep], [helperReads, { text: 'Check-in 4 PM, PRI-88412.' }], { helperPdf: true });
  k.agent.send('What does the booking say?');
  await k.agent.idle();
  const last = helperRequests(k)[1].messages.at(-1);
  const doc = last.parts.find((/** @type {any} */ p) => p.type === 'document');
  assert.equal(doc?.mediaType, 'application/pdf');
  assert.ok(doc.data.length > 0);
  assert.equal(last.parts[0].type, 'tool_result');
});

test("task: a helper whose model reads no PDFs is told it in words by a model that does, with the main loop's words", async () => {
  const k = await helperKit([delegate, { text: 'Hotel booking: check-in 4 PM, PRI-88412.' }, sleep], [helperReads, { text: 'Check-in 4 PM.' }], { mainInput: ['text', 'pdf'] });
  k.agent.send('What does the booking say?');
  await k.agent.idle();
  const last = helperRequests(k)[1].messages.at(-1);
  assert.equal(last.parts.some((/** @type {any} */ p) => p.type === 'document'), false);
  assert.match(last.parts[0].content, /^The PDF \/trip\/files\/booking\.pdf\.\nWhat it says \(told by model-0, as you can't read PDFs\): Hotel booking: check-in 4 PM, PRI-88412\.$/);
});

test("task: with no model that reads PDFs, the helper's result says it can't be read, not just that a PDF is there", async () => {
  const k = await helperKit([delegate, sleep], [helperReads, { text: 'I could not read it.' }]);
  k.agent.send('What does the booking say?');
  await k.agent.idle();
  const last = helperRequests(k)[1].messages.at(-1);
  assert.match(last.parts[0].content, /\nNo model here can read PDFs, so what it says can't be told\.$/);
});

test("task: a helper's photo goes to it as an image when its model sees photos", async () => {
  const photo = { toolCalls: [{ name: 'read', input: { path: '/trip/files/menu.webp' } }] };
  const k = await helperKit([delegate, sleep], [photo, { text: 'A menu.' }]);
  await k.ws.write(k.trip, '/files/menu.webp', new TextEncoder().encode('800x600'), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  k.agent.send('Look at the menu');
  await k.agent.idle();
  assert.equal(helperRequests(k)[1].messages.at(-1).parts.some((/** @type {any} */ p) => p.type === 'image'), true);
});
