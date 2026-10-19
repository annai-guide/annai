// K1 Task 4: the loop runs as a half (the Koe and Kokoro plan, "Agent as a half").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { record, TALK_TAG, KOE_TAG } from '../../src/core/agent/log.js';
import { resolveEvent } from '../../src/core/agent/transcript.js';
import { readConfig, saveRoles } from '../../src/core/llm/config.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { updateAppSettings } from '../../src/core/settings.js';

/**
 * A half as Halves makes one, without Halves. @param {'kokoro' | 'koe'} name @param {Record<string, any>} [over]
 * @returns {any}
 */
function halfOf(name, over = {}) {
  const koe = name === 'koe';
  return {
    name, tag: koe ? KOE_TAG : TALK_TAG,
    role: async () => ({ role: koe ? 'koe-type' : 'main' }),
    registryTools: !koe, voice: () => !koe, logVoice: !koe, housekeeping: !koe,
    mark: (/** @type {string} */ type) => (type === 'msg.user' ? (koe ? { split: true } : {}) : { half: name }),
    ...(koe ? { nonce: 'testnonce' } : {}),
    ...over,
  };
}

/** A note one half wrote, as the other observes it. @param {any} k @param {'koe' | 'kokoro'} from @param {string} text */
async function noteFrom(k, from, text) {
  const e = await record(k.store, k.trip, { type: 'note', actor: 'shiori', data: { id: `n-${text.length}`, from, mode: 'append', why: 'tool' }, texts: [['text', text]] });
  await k.agent.observe(e, await resolveEvent(k.store, e));
  return e;
}

/** The text parts of a request's last user message. @param {any} req */
const lastUser = (req) => req.messages.filter((/** @type {any} */ m) => m.role === 'user').at(-1).parts.filter((/** @type {any} */ p) => p.type === 'text').map((/** @type {any} */ p) => p.text);

test("a half with registryTools false offers only its own loop tools, and calls the models roles() gives", async () => {
  const k = await agentKit([[{ text: 'main' }], [{ toolCalls: [{ name: 'sleep', input: {} }] }]], { agent: { half: halfOf('koe') } });
  const cfg = await readConfig(k.ws);
  await saveRoles(k.ws, { ...cfg.roles, main: { models: ['m-0'], level: 'medium' }, 'koe-type': { models: ['m-1'], level: 'off' } });
  k.agent.send('Hi');
  await k.agent.idle();
  const names = k.requests[0].tools.map((/** @type {any} */ t) => t.name);
  assert.ok(names.includes('speak') && names.includes('sleep'));
  assert.ok(!names.includes('read') && !names.includes('write'), "the files plugin's tools aren't Koe's: only its own");
  const [turn] = await k.events(['model.turn']);
  assert.equal(turn.data.role, 'koe-type');
  assert.equal(turn.data.tag, KOE_TAG);
  assert.equal(turn.data.answeredBy, 'model-1');
  const [msg] = await k.events(['msg.user']);
  assert.equal(msg.data.split, true, 'what Koe logs of the user is marked as typed to Koe');
  const [wake] = await k.events(['wake']);
  assert.equal(wake.data.half, 'koe');
});

test('cutIn during a model call cancels that call only; the turn goes on, and the next call sees the queued note', async () => {
  const k = await agentKit([[{ delayMs: 500, text: 'thinking' }, { toolCalls: [{ name: 'sleep', input: {} }] }]], { agent: { half: halfOf('kokoro') } });
  k.agent.send('Is Nepenthe open?');
  await until(() => k.requests.length === 1);
  await new Promise((r) => setTimeout(r, 50));
  await noteFrom(k, 'koe', 'They asked about tonight, not lunch.');
  k.agent.wake({ kind: 'note', logged: true, from: 'koe', text: 'Koe notes: They asked about tonight, not lunch.' });
  k.agent.cutIn();
  await k.agent.idle();
  assert.equal(k.requests.length, 2);
  assert.ok(lastUser(k.requests[1]).includes('[Koe notes] "They asked about tonight, not lunch."'), JSON.stringify(lastUser(k.requests[1])));
  assert.match(k.requests[1].tail, /woke for: the user wrote; Koe notes: They asked/);
  assert.equal((await k.events(['wake'])).filter((e) => !e.data.meanwhile).length, 1, 'one turn');
  assert.equal((await k.events(['error'])).length, 0, 'a cut is not a failure');
});

test('cutIn while speak plays stops the voice at that point; the turn goes on', async () => {
  const k = await agentKit([[
    { stream: true, toolCalls: [{ name: 'speak', input: { text: 'Bixby Bridge is two miles ahead. It opened in 1932.' } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
  ]], { voice: { playMs: 60, speechIn: ['m-hear'] }, agent: { half: halfOf('kokoro') } });
  k.agent.send('What is ahead?');
  await until(() => k.platform.log.some((/** @type {string} */ l) => l.startsWith('play ')));
  k.agent.cutIn();
  await k.agent.idle();
  assert.ok(!k.platform.log.includes('play m-say:It opened in 1932.'));
  assert.equal(k.requests.length, 2, 'the turn went on');
  const [speak] = (await k.events(['tool.result'])).filter((e) => e.data.name === 'speak');
  assert.match(speak.data.content, /^A note stopped you after: "Bixby Bridge is…"\. It follows\.$/);
});

test("observe adds another writer's event once, by this half's rules, and ignores what it already has", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { agent: { half: halfOf('kokoro') } });
  const e = await noteFrom(k, 'koe', 'Is it far?');
  await k.agent.observe(e, await resolveEvent(k.store, e));
  const texts = k.agent.transcript.messages.flatMap((m) => m.parts).map((p) => (p.type === 'text' ? p.text : ''));
  assert.deepEqual(texts, ['[Koe asks] "Is it far?"']);
  // An event from before the conversation was read is in it already.
  await k.agent.open(k.trip);
  const before = k.agent.transcript.messages.length;
  await k.agent.observe(e, await resolveEvent(k.store, e));
  assert.equal(k.agent.transcript.messages.length, before);
  // One of another conversation is never added.
  await k.agent.observe({ ...e, seq: e.seq + 100, scope: 'elsewhere' }, await resolveEvent(k.store, e));
  assert.equal(k.agent.transcript.messages.length, before);
});

test('a logged wake writes only its wake event; its user lines are not written again', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { agent: { half: halfOf('kokoro') } });
  const e = await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { split: true }, texts: [['text', 'Is Nepenthe open?']] });
  await k.agent.observe(e, await resolveEvent(k.store, e));
  k.agent.wake({ kind: 'user', text: 'Is Nepenthe open?', logged: true });
  await k.agent.idle();
  assert.equal((await k.events(['msg.user'])).length, 1);
  const [wake] = await k.events(['wake']);
  assert.deepEqual(wake.data.reasons, [{ kind: 'user', text: 'Is Nepenthe open?' }]);
  assert.ok(lastUser(k.requests[0]).includes('[the user typed] "Is Nepenthe open?"'));
  assert.match(k.requests[0].tail, /woke for: the user wrote/);
});

test("#applyTurn picks this half's model.turn when the other half wrote one since", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Mine.' } }, { name: 'sleep', input: {} }] }]], { agent: { half: halfOf('kokoro') } });
  const call = k.llm.call;
  k.llm.call = async (/** @type {any} */ c) => {
    const r = await call(c);
    // Koe answers between this half's model.turn being written and its being read.
    if (c.record?.tag === TALK_TAG) await modelTrace(k.store, k.trip).turn({ role: 'koe-type', level: 'off', answeredBy: 'K', attempts: [], usage: {}, cost: 0, tag: KOE_TAG, wake: c.record.wake }, 'Koe words', '', [{ type: 'text', text: 'Koe words' }]);
    return r;
  };
  k.agent.send('Hi');
  await k.agent.idle();
  const assistant = k.agent.transcript.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.deepEqual(assistant[0].parts.map((p) => (p.type === 'tool_call' ? p.name : p.type)), ['speak', 'sleep']);
});

test('ended() gets the final text, whether the turn told the other half, slept, or spoke', async () => {
  /** @type {any[]} */
  const ends = [];
  const k = await agentKit([[
    { text: 'Plain words, out of habit.' },
    { toolCalls: [{ name: 'tell_koe', input: { text: 'Open till 10.' } }, { name: 'sleep', input: {} }] },
    { toolCalls: [{ name: 'speak', input: { text: 'Hi.' } }] },
    { text: 'Done.' },
  ]], { agent: { half: halfOf('kokoro', { ended: (/** @type {any} */ t) => ends.push(t) }) } });
  k.agent.addLoopTools([{ name: 'tell_koe', pluginId: 'core', description: 'Tell Koe.', input: { type: 'object', properties: { text: { type: 'string' } } }, run: async () => 'sent' }]);
  for (const text of ['one', 'two', 'three']) {
    k.agent.send(text);
    await k.agent.idle();
  }
  assert.deepEqual(ends.map((t) => [t.ok, t.finalText, t.told, t.slept, t.spoke]), [
    [true, 'Plain words, out of habit.', false, false, false],
    [true, '', true, true, false],
    [true, 'Done.', false, false, true],
  ]);
  assert.deepEqual(ends[0].kinds, ['user']);
  assert.ok(ends.every((t) => typeof t.wakeId === 'string'));
});

test('admit() applies quiet hours and the hourly limit as wake() did, once', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { agent: { half: halfOf('kokoro') } });
  await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 1 } } });
  const w = { kind: /** @type {const} */ ('trigger'), text: 'Sunset soon', fallbacks: [{ watch: 'w1', text: 'Sunset at 18:40' }] };
  assert.equal(await k.agent.admit(w), true);
  assert.equal(await k.agent.admit(w), false);
  for (let i = 0; i < 100 && !(await k.events(['reminder'])).length; i++) await new Promise((r) => setTimeout(r, 2));
  await until(() => k.notices.some((/** @type {any} */ n) => n.title === 'Shiori skipped a wake'));
  assert.equal(k.notices.filter((/** @type {any} */ n) => n.title === 'Shiori skipped a wake').length, 1);
  assert.equal((await k.events(['reminder'])).length, 1, 'the dropped wake\'s reminder is said once');
  assert.equal(k.requests.length, 0, 'admit wakes nobody');
  await updateAppSettings(k.ws, { shiori: { budgets: { quietHours: { from: '00:00', to: '23:59' } } } });
  /** @type {any[]} */
  const again = [];
  assert.equal(await k.agent.admit({ ...w, fallbacks: [] }, (/** @type {any} */ x) => again.push(x)), false);
  assert.equal(k.requests.length, 0);
});

test("Koe's wait ends when a note is queued, and when nothing-to-add is; the user's typing still ends it", async () => {
  const k = await agentKit([[{ text: 'unused' }], [
    { toolCalls: [{ name: 'speak', input: { text: "I'm checking." } }, { name: 'wait', input: { seconds: 30 } }] },
    { toolCalls: [{ name: 'speak', input: { text: 'Open till 10.' } }, { name: 'sleep', input: {} }] },
    { toolCalls: [{ name: 'wait', input: { seconds: 30 } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
    { toolCalls: [{ name: 'wait', input: { seconds: 30 } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
  ]], { agent: { half: halfOf('koe') } });
  const cfg = await readConfig(k.ws);
  await saveRoles(k.ws, { ...cfg.roles, main: { models: ['m-0'], level: 'medium' }, 'koe-type': { models: ['m-1'], level: 'off' } });
  k.agent.send('Is Nepenthe open?');
  await until(() => k.agent.state.name === 'waiting');
  await noteFrom(k, 'kokoro', 'Nepenthe is open till 10 tonight.');
  k.agent.wake({ kind: 'note', logged: true, from: 'kokoro', text: 'a note from Kokoro' });
  await k.agent.idle();
  const waits = (await k.events(['tool.result'])).filter((e) => e.data.name === 'wait');
  assert.equal(waits[0].data.content, 'Kokoro: see the note below.');
  assert.deepEqual(lastUser(k.requests[1]), ['<from_kokoro id="testnonce">Nepenthe is open till 10 tonight.</from_kokoro>']);
  // Nothing to add is a note too.
  k.agent.send('Thanks');
  await until(() => k.agent.state.name === 'waiting');
  await noteFrom(k, 'kokoro', 'Kokoro has nothing to add.');
  k.agent.wake({ kind: 'note', logged: true, from: 'kokoro', text: 'a note from Kokoro' });
  await k.agent.idle();
  // Typing ends it as before.
  k.agent.send('And tomorrow?');
  await until(() => k.agent.state.name === 'waiting');
  k.agent.send('Never mind');
  await k.agent.idle();
  const after = (await k.events(['tool.result'])).filter((e) => e.data.name === 'wait').map((e) => e.data.content);
  assert.deepEqual(after.slice(1), ['Kokoro: see the note below.', 'The user wrote: Never mind']);
});
