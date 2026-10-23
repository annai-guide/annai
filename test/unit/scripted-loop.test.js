import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });

test("scripted rules through the real loop: a note that joins the turn while its tool runs does not make the request after the tool's results a new wake: the rule's `then` answers", async () => {
  const list = { toolCalls: [{ name: 'list', input: { path: '/trip/' } }] };
  const k = await agentKit([{ rules: [{ match: 'the user wrote', reply: { delayMs: 200, ...list }, then: say('Nothing to add.') }] }]);
  k.agent.send('Look around');
  await until(() => k.requests.length === 1);
  k.agent.enqueue({ kind: 'cue', text: 'Koe said: one moment', logged: true });
  await k.agent.idle();
  // The request after the tool's results carries the joined wake: its words in the message, its reason in the tail.
  assert.match(k.requests[1].tail, /woke for: Koe said: one moment/);
  assert.equal(k.requests[1].messages.at(-1).parts.some((/** @type {any} */ p) => p.type === 'tool_result'), true);
  assert.equal((await k.events(['out.speak'])).map((e) => e.data.text).join(), 'Nothing to add.');
});
