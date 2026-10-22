// K1 Task 7: Koe's quick tools and light changes (the Koe and Kokoro design, "Tools: who has what"; plan decision 7, 22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { readConfig, saveModel } from '../../src/core/llm/config.js';
import { lightChange, BIGGER } from '../../src/core/koe/tools.js';
import { selfTools } from '../../src/core/agent/self-tools.js';

const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
/** Kokoro's timers, as live mode's would be. @type {any[]} */
const WATCH = ['watch_set', 'watch_list', 'watch_cancel'].map((name) => ({ name, pluginId: 'core', group: 'Time', description: `${name} (a stand-in)`, input: { type: 'object', properties: {} }, run: async () => `${name} ran` }));

test("Koe's tools are exactly: speak, show, ask, wait, sleep, watch_set, watch_list, watch_cancel, recall, list, read, nearby, guide, write, edit, patch, tell_kokoro, already_told", async () => {
  const k = await agentKit([[sleep]], { koe: { type: [sleep] } });
  await k.host.addBuiltin(new URL('../../src/plugins/places/index.js', import.meta.url).href);
  k.agent.addLoopTools(WATCH);
  k.agent.send('Hi');
  await k.agent.idle();
  assert.deepEqual(k.sent['model-koe'][0].tools.map((/** @type {any} */ t) => t.name), [
    'speak', 'show', 'ask', 'wait', 'sleep', 'watch_set', 'watch_list', 'watch_cancel', 'recall', 'list', 'read', 'nearby', 'guide', 'write', 'edit', 'patch', 'tell_kokoro', 'already_told',
  ]);
  const write = k.sent['model-koe'][0].tools.find((/** @type {any} */ t) => t.name === 'write');
  assert.match(write.description, /Koe: only light changes/);
  // Kokoro has every tool it had, and tell_koe.
  const kokoro = k.sent['model-0'][0].tools.map((/** @type {any} */ t) => t.name);
  for (const n of ['delete', 'search', 'web_search', 'task', 'tune_personality', 'tell_koe']) assert.ok(kokoro.includes(n) || n === 'web_search', n);
});

test('a tool switched off is off for both halves; a helper (task) is never offered the tell tools', async () => {
  const k = await agentKit([[sleep]], { koe: { type: [sleep] }, utility: [{ text: 'Found it.' }] });
  const { updateAppSettings } = await import('../../src/core/settings.js');
  await updateAppSettings(k.ws, { tools: { read: false } });
  k.agent.send('Hi');
  await k.agent.idle();
  assert.ok(!k.sent['model-koe'][0].tools.some((/** @type {any} */ t) => t.name === 'read'));
  assert.ok(!k.sent['model-0'][0].tools.some((/** @type {any} */ t) => t.name === 'read'));
  const task = /** @type {any} */ (selfTools(k.agent.kokoro).find((t) => t.name === 'task'));
  assert.equal(await task.run({ prompt: 'Look it up' }, { id: 't', wake: 'w', scope: k.trip, trip: k.trip, signal: new AbortController().signal }), 'Found it.');
  const offered = k.sent['model-u'][0].tools.map((/** @type {any} */ t) => t.name);
  assert.ok(offered.length && !offered.includes('tell_koe') && !offered.includes('tell_kokoro'), offered.join());
});

test('light changes: a note, a reminder, a flexible item moved, one new flexible item: done; a fixed item, a booking, trip.json, memory, a delete: refused with "ask Kokoro"', async () => {
  const k = await agentKit([[sleep]], { koe: { type: [sleep] } });
  await k.ws.write(k.trip, '/plan/lunch.json', { id: 'lunch', title: 'Lunch at Nepenthe', fixed: false, start: { at: '2026-11-26T12:30:00-08:00', tz: 'America/Los_Angeles' } }, { author: 'user' });
  await k.ws.write(k.trip, '/plan/flight.json', { id: 'flight', title: 'UA123', fixed: true }, { author: 'user' });
  await k.ws.write(k.trip, '/notes/today.md', 'Bring a jacket.', { author: 'user' });
  const ctx = { ws: k.ws, trip: k.trip };
  for (const [name, input] of /** @type {[string, any][]} */ ([
    ['write', { path: '/trip/notes/today.md', content: 'Bring a jacket and water.' }],
    ['write', { path: '/trip/notes/new.md', content: 'A new note.' }],
    ['edit', { path: '/trip/notes/today.md', old: 'jacket', new: 'coat' }],
    ['patch', { path: '/trip/plan/lunch.json', changes: { start: { at: '2026-11-26T13:00:00-08:00', tz: 'America/Los_Angeles' }, notes: 'Later', priority: 2 } }],
    ['write', { path: '/trip/plan/beach.json', content: { id: 'beach', title: 'Pfeiffer Beach', fixed: false } }],
  ])) assert.equal(await lightChange(name, input, ctx), null, `${name} ${input.path}`);
  for (const [name, input] of /** @type {[string, any][]} */ ([
    ['patch', { path: '/trip/plan/flight.json', changes: { notes: 'x' } }],
    ['patch', { path: '/trip/plan/lunch.json', changes: { title: 'Dinner' } }],
    ['patch', { path: '/trip/plan/gone.json', changes: { notes: 'x' } }],
    ['write', { path: '/trip/plan/lunch.json', content: { id: 'lunch', title: 'Lunch', fixed: false } }],
    ['write', { path: '/trip/plan/fixed.json', content: { id: 'fixed', title: 'Show', fixed: true } }],
    ['write', { path: '/trip/bookings/b.json', content: {} }],
    ['write', { path: '/trip/trip.json', content: {} }],
    ['write', { path: '/trip/memory.md', content: 'x' }],
    ['write', { path: '/me/memory.md', content: 'x' }],
    ['edit', { path: '/trip/plan/lunch.json', old: 'a', new: 'b' }],
    ['write', { path: '/trip/notes/../trip.json', content: 'x' }],
    ['write', { path: '/trip/notes/a/b.md', content: 'x' }],
    ['delete', { path: '/trip/notes/today.md' }],
  ])) assert.equal(await lightChange(name, input, ctx), BIGGER, `${name} ${input.path}`);
  assert.equal(BIGGER, "That's a bigger change: ask Kokoro with tell_kokoro.");
});

test("a refused change isn't made, and Koe hears to ask Kokoro", async () => {
  const k = await agentKit([[sleep]], { koe: { type: [{ toolCalls: [{ name: 'write', input: { path: '/trip/bookings/b.json', content: { id: 'b' } } }, { name: 'write', input: { path: '/trip/notes/n.md', content: 'Sunset at 18:40' } }, { name: 'sleep', input: {} }] }] } });
  k.agent.send('Note the sunset, and book the inn');
  await k.agent.idle();
  const results = (await k.events(['tool.result'])).filter((e) => e.data.half === 'koe' && e.data.name === 'write').map((e) => [e.data.ok, e.data.content]);
  assert.deepEqual(results[0], [false, "That's a bigger change: ask Kokoro with tell_kokoro."]);
  assert.equal(results[1][0], true);
  assert.ok(!(await k.ws.read(k.trip, '/bookings/b.json')));
  assert.equal(await k.ws.readText(k.trip, '/notes/n.md'), 'Sunset at 18:40');
});

test("a text Koe's photos are judged against its chat models only: a realtime model in its list that declares no photos doesn't keep them from it (fix pass)", async () => {
  const k = await agentKit([[sleep]], { koe: { type: [sleep], input: ['text', 'image'] }, live: { origin: 'http://127.0.0.1:9' } });
  const rec = (await readConfig(k.ws)).models['m-live'];
  await saveModel(k.ws, { ...rec, user: { ...rec.user, input: ['text'] } });
  await k.agent.split(); // voice off: the chat model after Live answers
  assert.equal(k.agent.koeState, 'text');
  await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('4032x3024'), { author: 'user', type: 'image/webp', meta: { width: 4032, height: 3024 } });
  k.agent.send('', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.ok(k.sent['model-koe'][0].messages.some((/** @type {any} */ m) => m.parts.some((/** @type {any} */ p) => p.type === 'image')));
});

test('a photo reaches Koe only when its model takes photos; otherwise a stub, and Kokoro gets the photo', async () => {
  for (const input of [['text'], ['text', 'image']]) {
    const k = await agentKit([[sleep]], { koe: { type: [sleep], input } });
    await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('4032x3024'), { author: 'user', type: 'image/webp', meta: { width: 4032, height: 3024 } });
    k.agent.send('', { photos: [{ path: '/trip/files/p.webp' }] });
    await k.agent.idle();
    const types = (/** @type {any} */ req) => req.messages.flatMap((/** @type {any} */ m) => m.parts.map((/** @type {any} */ p) => (p.type === 'text' ? p.text : p.type)));
    const koe = types(k.sent['model-koe'][0]);
    if (input.includes('image')) assert.ok(koe.includes('image'), JSON.stringify(koe));
    else assert.deepEqual(koe.slice(0, 2), ['(a photo)', '[a photo; Kokoro sees it]']);
    assert.ok(types(k.sent['model-0'][0]).includes('image'), 'Kokoro sees it');
    assert.ok(types(k.sent['model-0'][0]).includes('[the user sent a photo]'));
  }
});

// The fix pass (S4): Koe answers at once, so it never waits on a PDF being told; Kokoro reads it.
test("Koe reads a PDF its model can't read, typing or live: told at once to ask Kokoro, and no model is asked to tell it", async () => {
  const k = await agentKit([[sleep]], { koe: { type: [{ toolCalls: [{ name: 'read', input: { path: '/trip/files/booking.pdf' } }] }, sleep] }, utility: [{ text: 'Hotel booking: check-in 3 PM.' }] });
  const u = (await k.llm.config()).models['m-u'];
  await saveModel(k.ws, { ...u, user: { ...u.user, input: ['text', 'pdf'] } });
  await k.ws.write(k.trip, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  k.agent.send('When is check-in?');
  await k.agent.idle();
  const read = (await k.events(['tool.result'])).find((e) => e.data.name === 'read' && e.data.half === 'koe');
  assert.equal(read.data.content, "The PDF /trip/files/booking.pdf.\nYou can't read PDFs; ask Kokoro about it.");
  assert.equal(read.data.document, undefined);
  const live = await k.agent.koe.liveCall({ id: 'c1', name: 'read', input: { path: '/trip/files/booking.pdf' } }, 'w1');
  assert.equal(live.content, "The PDF /trip/files/booking.pdf.\nYou can't read PDFs; ask Kokoro about it.");
  assert.equal(live.document, undefined);
  assert.equal((k.sent['model-u'] ?? []).length, 0, 'nobody was asked to tell it');
});

test('a Koe whose model reads PDFs gets the PDF itself', async () => {
  const k = await agentKit([[sleep]], { koe: { type: [{ toolCalls: [{ name: 'read', input: { path: '/trip/files/booking.pdf' } }] }, sleep], input: ['text', 'image', 'pdf'] } });
  await k.ws.write(k.trip, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  k.agent.send('When is check-in?');
  await k.agent.idle();
  assert.match(JSON.stringify(k.sent['model-koe'][1].messages), /"type":"document"/);
});
