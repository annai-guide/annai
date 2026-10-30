import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicStandIn, BINDING_BETA } from '../fakes/anthropic-binding.js';

// The stand-in checks thinking blocks as the preserved-thinking docs say Claude 5.5 does (fetched 2026-10-29).

/** The content of a reply, read back from its stream. @param {Response} res */
async function contentOf(res) {
  const blocks = /** @type {any[]} */ ([]);
  for (const chunk of (await res.text()).split('\n\n')) {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const e = JSON.parse(line.slice(6));
    if (e.type === 'content_block_start') blocks[e.index] = { ...e.content_block };
    if (e.type === 'content_block_delta') {
      const b = blocks[e.index];
      if (e.delta.type === 'thinking_delta') b.thinking += e.delta.thinking;
      if (e.delta.type === 'signature_delta') b.signature += e.delta.signature;
      if (e.delta.type === 'text_delta') b.text += e.delta.text;
      if (e.delta.type === 'input_json_delta') b.input = JSON.parse(e.delta.partial_json);
    }
  }
  return blocks;
}

/** A conversation of three replies in one turn, each with thinking, and the requests that made them. */
async function turn() {
  let n = 0;
  const claude = anthropicStandIn(() => [{ type: 'tool_use', id: `toolu_${++n}`, name: 'list', input: {} }]);
  const send = (/** @type {any[]} */ messages) => claude.fetch('https://api.anthropic.com/v1/messages', { body: JSON.stringify({ model: 'claude-sonnet-5-5', system: [{ type: 'text', text: 'S' }], messages }) });
  /** @type {any[]} */
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }];
  for (let i = 0; i < 3; i++) {
    const res = await send(messages);
    assert.equal(res.status, 200);
    const content = await contentOf(res);
    messages.push({ role: 'assistant', content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: content[1].id, content: 'r' }] });
  }
  return { claude, send, messages };
}

test('the whole chain sent back is taken; all removed, or the oldest removed, is taken too', async () => {
  const { claude, send, messages } = await turn();
  assert.equal((await send(messages)).status, 200);
  const drop = (/** @type {number[]} */ at) => messages.map((m, i) => (at.includes(i) ? { ...m, content: m.content.filter((/** @type {any} */ b) => b.type !== 'thinking') } : m));
  assert.equal((await send(drop([1, 3, 5]))).status, 200, 'all of them');
  assert.equal((await send(drop([1]))).status, 200, 'the oldest');
  assert.deepEqual(claude.refused, []);
});

test('a gap in the chain, a changed message before a block, or changed words are refused', async () => {
  const { claude, send, messages } = await turn();
  const gap = messages.map((m, i) => (i === 3 ? { ...m, content: m.content.filter((/** @type {any} */ b) => b.type !== 'thinking') } : m));
  assert.equal((await send(gap)).status, 400);
  assert.match(claude.refused.at(-1), /bound to a different conversation/);
  const edited = messages.map((m, i) => (i === 0 ? { ...m, content: [{ type: 'text', text: 'Hi!' }] } : m));
  assert.equal((await send(edited)).status, 400);
  const words = messages.map((m, i) => (i === 5 ? { ...m, content: m.content.map((/** @type {any} */ b) => (b.type === 'thinking' ? { ...b, thinking: 'Other words.' } : b)) } : m));
  assert.equal((await send(words)).status, 400);
  assert.match(claude.refused.at(-1), /cannot be modified/);
});

test('a cache entry written at a mark is read by a later mark within 20 blocks of it, and not beyond', async () => {
  const claude = anthropicStandIn(() => [{ type: 'text', text: 'ok' }]);
  const text = (/** @type {string} */ t, mark = false) => ({ type: 'text', text: t, ...(mark ? { cache_control: { type: 'ephemeral' } } : {}) });
  const send = async (/** @type {any[]} */ content) => {
    await claude.fetch('https://api.anthropic.com/v1/messages', { body: JSON.stringify({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content }] }) });
    return claude.usage.at(-1);
  };
  const base = Array.from({ length: 5 }, (_, i) => text(`block ${i}`));
  assert.equal((await send([...base.slice(0, 4), text('block 4', true)])).cache_read_input_tokens, 0);
  const near = await send([...base, ...Array.from({ length: 10 }, (_, i) => text(`more ${i}`)), text('end', true)]);
  assert.ok(near.cache_read_input_tokens > 0, 'within reach');
  const far = await send([...base, ...Array.from({ length: 30 }, (_, i) => text(`far ${i}`)), text('end', true)]);
  assert.equal(far.cache_read_input_tokens, 0, 'out of reach of the only mark');
});

test('the binding controls: block_binding needs the beta header, and the header makes each reply carry input_transformations', async () => {
  const claude = anthropicStandIn(() => [{ type: 'text', text: 'ok' }]);
  const ask = (/** @type {any} */ thinking, /** @type {Record<string, string>} */ headers) => claude.fetch('https://api.anthropic.com/v1/messages', { headers, body: JSON.stringify({ model: 'claude-sonnet-5-5', thinking, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] }) });
  const binding = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } };
  assert.equal((await ask(binding, {})).status, 400, 'the field without the header');
  assert.match(claude.refused.at(-1), /block_binding: Extra inputs are not permitted/);
  const res = await ask(binding, { 'anthropic-beta': `other-beta,${BINDING_BETA}` });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /"input_transformations":\[\]/);
  assert.doesNotMatch(await (await ask(undefined, {})).text(), /input_transformations/);
});
