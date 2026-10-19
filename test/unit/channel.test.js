// K1 Task 5: the channel between the halves (the Koe and Kokoro design, "The channel between the halves").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { record, TALK_TAG } from '../../src/core/agent/log.js';
import { resolveEvent } from '../../src/core/agent/transcript.js';
import { Channel, channelTool } from '../../src/core/agent/halves.js';
import { ALWAYS_ON, toolList } from '../../src/core/agent/tools.js';

/** Kokoro as the receiving half, and a channel whose Koe side writes into the same log. @param {any[]} script */
async function kokoroKit(script) {
  const k = await agentKit([script], {
    agent: { half: { name: 'kokoro', tag: TALK_TAG, role: 'main', registryTools: true, voice: () => false, logVoice: true, housekeeping: true, mark: () => ({}) } },
  });
  /** @type {string[]} */
  const order = [];
  const channel = new Channel({
    log: {
      koe: async (/** @type {any} */ ev) => {
        order.push('logged');
        const e = await record(k.store, k.trip, { ...ev, data: { ...ev.data, half: 'koe' } });
        await k.agent.observe(e, await resolveEvent(k.store, e));
        return e;
      },
      kokoro: (/** @type {any} */ ev) => k.agent.log(ev),
    },
    deliver: { kokoro: (/** @type {any} */ w) => { order.push('delivered'); k.agent.wake(w); }, koe: () => {} },
    cut: { kokoro: () => { order.push('cut'); k.agent.cutIn(); }, koe: () => {} },
  });
  return { ...k, channel, order };
}

/** The text parts of a request's last user message. @param {any} req */
const lastUser = (req) => req.messages.filter((/** @type {any} */ m) => m.role === 'user').at(-1).parts.filter((/** @type {any} */ p) => p.type === 'text').map((/** @type {any} */ p) => p.text);

test('tell_kokoro returns "sent" in the same step, before Kokoro has done anything', async () => {
  const k = await kokoroKit([{ delayMs: 200, toolCalls: [{ name: 'sleep', input: {} }] }]);
  const tool = channelTool('koe', k.channel);
  assert.equal(tool.name, 'tell_kokoro');
  const started = Date.now();
  const out = await tool.run({ text: 'Is Nepenthe open now?' }, /** @type {any} */ ({ wake: 'k1' }));
  assert.equal(out, 'sent');
  assert.ok(Date.now() - started < 100, 'it never waits for Kokoro');
  assert.equal(k.requests.length, 0);
  await k.agent.idle();
  assert.equal(k.requests.length, 1, 'then Kokoro works on it');
  assert.equal(channelTool('kokoro', k.channel).name, 'tell_koe');
  assert.match(String(/** @type {any} */ (await tool.run({ text: '  ' }, /** @type {any} */ ({ wake: 'k1' }))).content), /needs the text/);
});

test('append to a busy Kokoro arrives before its next model call; to an idle one it starts a turn', async () => {
  const k = await kokoroKit([
    { delayMs: 150, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
  ]);
  k.agent.send('Plan the afternoon');
  await until(() => k.requests.length === 1);
  await k.channel.send('koe', 'They want to see the sunset too.', 'append', 'tool', 'k1');
  await k.agent.idle();
  assert.equal(k.requests.length, 2, 'the first call was not cut');
  assert.ok(lastUser(k.requests[1]).includes('[Koe notes] "They want to see the sunset too."'), JSON.stringify(lastUser(k.requests[1])));
  // Idle: a note starts a turn.
  await k.channel.send('koe', 'Is the bridge open?', 'append', 'tool', 'k2');
  await k.agent.idle();
  assert.equal(k.requests.length, 3);
  assert.match(k.requests[2].tail, /woke for: Koe asks: "Is the bridge open\?"/);
  assert.deepEqual(k.order.slice(0, 2), ['logged', 'delivered']);
});

test('immediate cuts the current call and the turn continues with the note', async () => {
  const k = await kokoroKit([
    { delayMs: 500, text: 'Looking up the lunch places' },
    { toolCalls: [{ name: 'sleep', input: {} }] },
  ]);
  k.agent.send('Where for lunch?');
  await until(() => k.requests.length === 1);
  const started = Date.now();
  await k.channel.send('koe', 'Not lunch: they mean dinner.', 'immediate', 'tool', 'k1');
  await k.agent.idle();
  assert.ok(Date.now() - started < 400, 'the call was cut, not waited out');
  assert.deepEqual(k.order, ['logged', 'delivered', 'cut']);
  assert.equal(k.requests.length, 2);
  assert.ok(lastUser(k.requests[1]).includes('[Koe notes] "Not lunch: they mean dinner."'));
  assert.equal((await k.events(['wake'])).filter((e) => !e.data.meanwhile).length, 1, 'one turn, going on');
});

test('every note is a note event in the open conversation, with from, mode and why; the tell tools are always on', async () => {
  const k = await kokoroKit([{ toolCalls: [{ name: 'sleep', input: {} }] }]);
  await channelTool('koe', k.channel).run({ text: 'Is it far?', mode: 'immediate' }, /** @type {any} */ ({ wake: 'k7' }));
  await k.channel.send('kokoro', 'Open till 10.', 'append', 'final-text', 'w3');
  await k.agent.idle();
  const notes = await k.events(['note']);
  assert.deepEqual(notes.map((e) => [e.data.from, e.data.mode, e.data.why, e.data.wake, e.data.text]), [
    ['koe', 'immediate', 'tool', 'k7', 'Is it far?'],
    ['kokoro', 'append', 'final-text', 'w3', 'Open till 10.'],
  ]);
  assert.ok(notes.every((e) => typeof e.data.id === 'string' && e.data.id));
  assert.ok(ALWAYS_ON.includes('tell_koe') && ALWAYS_ON.includes('tell_kokoro'));
  const tools = toolList({ registry: /** @type {any} */ ({ entries: () => [] }), switches: { tell_koe: false, tell_kokoro: false }, loop: [channelTool('koe', k.channel), channelTool('kokoro', k.channel)] });
  assert.deepEqual(tools.map((t) => t.name), ['tell_kokoro', 'tell_koe'], 'switching either off would leave a half no way to reach the other');
});
