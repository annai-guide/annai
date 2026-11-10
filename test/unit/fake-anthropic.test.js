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

test('a server tool called beside a client tool: only tool results may follow, wherever it is in the history; the request that answers it is run (the real API, 2026-11-10)', async () => {
  const ss = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'ramen' } };
  const geocode = { type: 'tool_use', id: 'toolu_1', name: 'geocode', input: {} };
  const claude = anthropicStandIn((body) => (body.messages.length === 1 ? [ss, geocode] : [{ type: 'text', text: 'Here.' }]));
  const send = (/** @type {any[]} */ messages) => claude.fetch('https://api.anthropic.com/v1/messages', { body: JSON.stringify({ model: 'claude-sonnet-5-5', messages }) });
  const ask = { role: 'user', content: [{ type: 'text', text: 'Ramen?' }] };
  const first = { role: 'assistant', content: await contentOf(await send([ask])) };
  assert.deepEqual(first.content.map((/** @type {any} */ b) => b.type), ['thinking', 'server_tool_use', 'tool_use']);
  const result = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Kyoto Station' };
  const words = { type: 'text', text: '<now>10:00</now>' };
  const user = (/** @type {any[]} */ content) => ({ role: 'user', content });
  // Only the tool result after it: 200, and the reply begins with the search's result, then its thinking.
  const answered = await send([ask, first, user([result])]);
  assert.equal(answered.status, 200);
  const second = { role: 'assistant', content: await contentOf(answered) };
  assert.deepEqual(second.content.map((/** @type {any} */ b) => b.type), ['web_search_tool_result', 'thinking', 'text']);
  assert.equal(second.content[0].tool_use_id, 'srvtoolu_1');
  // A block after the result is refused, at the end of the history and in the middle of it (though the next reply carries the result).
  assert.equal((await send([ask, first, user([result, words])])).status, 400);
  assert.match(claude.refused.at(-1), /^messages\.1: `web_search` tool use with id `srvtoolu_1` was found without a corresponding `web_search_tool_result` block$/);
  assert.equal((await send([ask, first, user([result]), second, user([words])])).status, 200, 'the same words after the next reply');
  assert.equal((await send([ask, first, user([result, words]), second, user([words])])).status, 400, 'in the middle of the history');
  // A reply after it that doesn't carry the result: refused, whatever its user message holds.
  const other = { role: 'assistant', content: [{ type: 'text', text: 'Sorry.' }] };
  assert.equal((await send([ask, first, user([result]), other, user([words])])).status, 400);
  assert.equal((await send([ask, first, user([result, words]), other, user([words])])).status, 400);
  // Without the tool use, the same history is taken; a last reply that holds one is a paused turn, continued as it is (and no result is made up).
  const without = { role: 'assistant', content: first.content.filter((/** @type {any} */ b) => b.type !== 'server_tool_use') };
  assert.equal((await send([ask, without, user([result, words]), other, user([words])])).status, 200);
  const paused = await send([ask, { role: 'assistant', content: [ss] }]);
  assert.equal(paused.status, 200);
  assert.deepEqual((await contentOf(paused)).map((/** @type {any} */ b) => b.type), ['thinking', 'text']);
});

test('a web fetch called beside a client tool is left in the same way, and its result is a web_fetch_tool_result', async () => {
  const fetchUse = { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_fetch', input: { url: 'https://example.com/a' } };
  const claude = anthropicStandIn((body) => (body.messages.length === 1 ? [fetchUse, { type: 'tool_use', id: 'toolu_2', name: 'geocode', input: {} }] : [{ type: 'text', text: 'Here.' }]));
  const send = (/** @type {any[]} */ messages) => claude.fetch('https://api.anthropic.com/v1/messages', { body: JSON.stringify({ model: 'claude-sonnet-5-5', messages }) });
  const ask = { role: 'user', content: [{ type: 'text', text: 'Read it.' }] };
  const first = { role: 'assistant', content: await contentOf(await send([ask])) };
  const result = { type: 'tool_result', tool_use_id: 'toolu_2', content: 'x' };
  assert.equal((await send([ask, first, { role: 'user', content: [result, { type: 'text', text: 'Hi' }] }])).status, 400);
  assert.match(claude.refused.at(-1), /`web_fetch` tool use with id `srvtoolu_2` was found without a corresponding `web_fetch_tool_result` block/);
  const answered = await send([ask, first, { role: 'user', content: [result] }]);
  assert.equal(answered.status, 200);
  const content = await contentOf(answered);
  assert.equal(content[0].type, 'web_fetch_tool_result');
  assert.equal(content[0].content.url, 'https://example.com/a');
});
