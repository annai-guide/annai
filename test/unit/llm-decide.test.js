import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, DECIDE_THRESHOLD } from '../../src/core/llm/decide.js';

const options = [{ id: 'stay', label: 'Stay at the overlook' }, { id: 'go', label: 'Leave for dinner' }, { id: 'ask', label: 'Ask the user' }];
/** A call that answers each role from a list, and remembers the requests. @param {Record<string, any[]>} replies */
function fake(replies) {
  /** @type {{ role: string, request: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ role, /** @type {any} */ request) => {
    seen.push({ role, request });
    const reply = replies[role].shift();
    return { reply: { parts: reply.parts ?? [{ type: 'text', text: reply.text ?? '' }], text: reply.text ?? '', logprobs: reply.logprobs } };
  };
  return { call, seen };
}

test('logprobs over the letters are real probabilities', async () => {
  const f = fake({ decide: [{ text: 'B', logprobs: [{ token: 'B', logprob: Math.log(0.72) }, { token: ' A', logprob: Math.log(0.18) }, { token: 'C', logprob: Math.log(0.05) }, { token: 'The', logprob: Math.log(0.05) }] }] });
  const r = await decide({ prompt: 'Sunset is in 10 minutes.', options, call: f.call, logprobs: true });
  assert.equal(r.by, 'decide');
  assert.deepEqual(Object.keys(r.probabilities), ['stay', 'go', 'ask']);
  assert.ok(Math.abs(r.probabilities.go - 0.72 / 0.95) < 1e-9);
  assert.ok(Math.abs(Object.values(r.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const asked = f.seen[0].request;
  assert.equal(asked.logprobs, 10);
  assert.match(asked.messages[0].parts[0].text, /A\. Stay at the overlook\nB\. Leave for dinner\nC\. Ask the user/);
});

test('without logprobs, a decide tool call or a letter is a choice with confidence 1.0', async () => {
  const byTool = fake({ decide: [{ parts: [{ type: 'tool_call', id: 't', name: 'decide', input: { option: 'C' } }] }] });
  assert.deepEqual((await decide({ prompt: 'p', options, call: byTool.call })).probabilities, { stay: 0, go: 0, ask: 1 });
  assert.equal(byTool.seen[0].request.toolChoice, 'decide');
  const byText = fake({ decide: [{ text: 'A. Stay, the light is best now.' }] });
  assert.deepEqual((await decide({ prompt: 'p', options, call: byText.call })).probabilities, { stay: 1, go: 0, ask: 0 });
});

test('below the threshold, or with no readable answer, the main model decides', async () => {
  const unsure = fake({
    decide: [{ text: 'A', logprobs: [{ token: 'A', logprob: Math.log(0.5) }, { token: 'B', logprob: Math.log(0.5) }] }],
    main: [{ text: 'B' }],
  });
  const r = await decide({ prompt: 'p', options, call: unsure.call, logprobs: true });
  assert.equal(r.by, 'main');
  assert.deepEqual(r.probabilities, { stay: 0, go: 1, ask: 0 });
  assert.equal(unsure.seen[1].role, 'main');
  assert.equal(unsure.seen[1].request.toolChoice, undefined);
  assert.equal(DECIDE_THRESHOLD, 0.6);
  const mumble = fake({ decide: [{ text: 'Hmm.' }], main: [{ text: 'C' }] });
  assert.equal((await decide({ prompt: 'p', options, call: mumble.call })).by, 'main');
});

test('a decide model that refuses the forced tool (it thinks): the main model decides by letter', async () => {
  /** @type {{ role: string, request: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ role, /** @type {any} */ request) => {
    seen.push({ role, request });
    if (request.toolChoice) throw new Error('tool_choice that forces tool use is not supported with thinking.');
    return { reply: { parts: [{ type: /** @type {const} */ ('text'), text: 'B' }], text: 'B' } };
  };
  const r = await decide({ prompt: 'Sunset is in 10 minutes.', options, call });
  assert.equal(r.by, 'main');
  assert.equal(r.probabilities.go, 1);
  assert.deepEqual(seen.map((s) => s.role), ['decide', 'main']);
});
