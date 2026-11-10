import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../../plugins-official/anthropic-messages/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { anthropicStandIn } from '../fakes/anthropic-binding.js';

// A reply that calls a server tool (Anthropic's web search or fetch) and a client tool together ends for the client tool with the server tool
// not run: no result block comes with it. The API runs it when the next user message holds only the client tools' results, and the reply after
// begins with its result. Any other block in that message is a 400 "`web_search` tool use with id ... was found without a corresponding
// `web_search_tool_result` block", at the end of the history and in the middle of it. The same history without the call is taken, and the model
// searches again (S4). What the real API took and refused (Opus, Sonnet and Haiku 5.5, 2026-11-10, with web search and web fetch) is in
// docs/lessons-full.md; the stand-in (test/fakes/anthropic-binding.js) answers as it did.

/** What provider-anthropic's description gives a Claude model: the tools its web search and web fetch add to a request that asks for them. */
const PROVIDER_TOOLS = [
  { id: 'anthropic-web-search', name: 'Anthropic web search', kind: 'search', patch: { 'tools+': [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] } },
  { id: 'anthropic-web-fetch', name: 'Anthropic web fetch', kind: 'fetch', patch: { 'tools+': [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 }] } },
];

/** @returns {any} */
function load() {
  /** @type {any} */
  let type = null;
  activate({ providers: { register: (/** @type {any} */ t) => { type = t; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return type;
}
const type = load();
/** @param {any} [over] */
function spec(over = {}) {
  const endpoint = { id: 'ep-2', type: 'anthropic-messages', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', headers: {}, tunables: { ...type.tunables }, extraBody: {} };
  const model = { id: 'm-2', endpoint: 'ep-2', name: 'Haiku', providerId: 'claude-haiku-5-5', input: ['text', 'image'], tools: true, contextWindow: 1000000, maxOutput: null, prices: null, cacheTtls: ['5m', '1h'], reasoning: {}, tunables: {}, extraBody: {}, providerTools: PROVIDER_TOOLS };
  return { endpoint, model, key: 'sk-ant-test', tunables: { ...type.tunables }, request: { messages: [] }, ...over };
}
const MODEL = 'claude-haiku-5-5';
const THINKING = { type: 'thinking', thinking: '', signature: 'sig-1' };
const SEARCH = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'ramen near Kyoto Station' } };
const FETCH = { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_fetch', input: { url: 'https://example.com/a' } };
const GEOCODE = { type: 'tool_use', id: 'toolu_1', name: 'geocode', input: { query: 'Kyoto Station' } };
const FOUND = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com/r', title: 'R', encrypted_content: 'E' }] };
const now = (/** @type {number} */ n) => ({ type: 'text', text: `<now>${n}</now>`, now: true });
const text = (/** @type {string} */ t) => ({ type: 'text', text: t });
const result = { type: 'tool_result', id: 'toolu_1', content: 'Kyoto Station: 34.9858, 135.7588' };
/** The reply as it is stored: the native when it had thinking (it stands in for the parts after it), else its parts. @param {any[]} content @param {boolean} [thinking] */
function reply(content, thinking = true) {
  const parts = content.flatMap((/** @type {any} */ b) => /** @type {any[]} */ (b.type === 'thinking' ? [] : b.type === 'tool_use' ? [{ type: 'tool_call', id: b.id, name: b.name, input: b.input }] : b.type === 'text' ? [{ type: 'text', text: b.text }] : [{ type: 'provider', block: b, model: MODEL }]));
  return { role: 'assistant', parts: thinking ? [{ type: 'native', endpoint: 'e', content, covers: parts.length, prefix: 'p' }, ...parts] : parts };
}
/** A body without its cache markers. @param {any} x */
const bare = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v)));
const marks = (/** @type {any} */ body) => JSON.stringify(body).split('cache_control').length - 1;
/** What a request of these messages sends. @param {any[]} messages @param {string} [tail] */
const build = (messages, tail = '<now>9</now>', providerTools = { kinds: ['search', 'fetch'], off: [] }) => type.build(spec({ request: { system: 'S', cacheTtl: '1h', tail, messages, providerTools } })).body;
/** The request's status at the stand-in, and the refusal it gave; with the server tools annai adds to the body after build (call.js), by name. @param {any} body */
async function sent(body, tools = ['web_search', 'web_fetch']) {
  const claude = anthropicStandIn(() => [{ type: 'text', text: 'Ok.' }]);
  const res = await claude.fetch('https://api.anthropic.com/v1/messages', { body: JSON.stringify({ ...body, tools: [...(body.tools ?? []), ...tools.map((name) => ({ type: name, name }))] }) });
  return { status: res.status, refused: claude.refused.at(-1) };
}
const kinds = (/** @type {any} */ m) => m.content.map((/** @type {any} */ b) => b.type);

for (const [name, thinking] of /** @type {const} */ ([['with thinking (a native)', true], ['without thinking (the reply as parts)', false]])) {
  test(`a fresh exchange ${name}, its user message the tool result alone: this request runs the search, with no tail; the API takes it`, async () => {
    const ask = { role: 'user', parts: [text('Ramen near Kyoto Station?'), now(1)] };
    const body = build([ask, reply([...(thinking ? [THINKING] : []), SEARCH, GEOCODE], thinking), { role: 'user', parts: [result] }], '<now>2</now>');
    assert.deepEqual(body.messages.map(kinds), [['text', 'text'], [...(thinking ? ['thinking'] : []), 'server_tool_use', 'tool_use'], ['tool_result']]);
    assert.equal(JSON.stringify(body).includes('<now>2'), false, 'the tail does not go this request');
    assert.deepEqual(body.messages[2].content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: result.content, cache_control: { type: 'ephemeral', ttl: '1h' } }], 'marked where the tail was to follow');
    assert.equal(marks(body), 2, 'the system and the end');
    assert.deepEqual(await sent(body), { status: 200, refused: undefined });
  });
}

test('a fresh exchange whose user message holds more than the results (a photo from a tool, a line, two results): the call is left out and the message goes as stored, with its tail', async () => {
  const two = { type: 'tool_use', id: 'toolu_2', name: 'geocode', input: { query: 'Gion' } };
  const photo = { type: 'image', mediaType: 'image/png', data: 'AAAA' };
  const stored = [
    { role: 'user', parts: [text('Ramen?')] },
    reply([THINKING, SEARCH, GEOCODE, two]),
    { role: 'user', parts: [{ ...result }, { type: 'tool_result', id: 'toolu_2', content: 'Gion', isError: true }, photo, text('[meanwhile, the user wrote] And sushi?')] },
  ];
  const body = build(stored, '<now>2</now>');
  assert.deepEqual(body.messages.map(kinds), [['text'], ['thinking', 'tool_use', 'tool_use'], ['tool_result', 'tool_result', 'image', 'text', 'text']]);
  assert.equal(body.messages[2].content.at(-1).text, '<now>2</now>');
  assert.deepEqual(await sent(body), { status: 200, refused: undefined });
});

test("in the middle of the history, the search this request ran stays with the reply that answers it, and its user message goes as it went: the tool result alone, a now block kept there since left out; the request before is the start of this one", async () => {
  const stored = [
    { role: 'user', parts: [text('Ramen near Kyoto Station?'), now(1)] },
    reply([THINKING, SEARCH, GEOCODE]),
    { role: 'user', parts: [result] },
  ];
  const first = build(stored, '<now>2</now>');
  // The reply that answers it came with thinking: the transcript keeps the now block its request ended with (never sent: it had no tail).
  const kept = [...stored.slice(0, 2), { role: 'user', parts: [result, now(2)] }];
  const answered = reply([FOUND, { type: 'thinking', thinking: '', signature: 'sig-2' }, text('Try Ichiran.')]);
  const next = build([...kept, answered, { role: 'user', parts: [text('Thanks!')] }], '<now>3</now>');
  assert.deepEqual(next.messages.map(kinds), [['text', 'text'], ['thinking', 'server_tool_use', 'tool_use'], ['tool_result'], ['web_search_tool_result', 'thinking', 'text'], ['text', 'text']]);
  assert.equal(JSON.stringify(next).includes('<now>2'), false);
  assert.deepEqual(bare(next.messages.slice(0, 3)), bare(first.messages), 'append-only: what the cache holds of the request before is a start of this one');
  assert.deepEqual(await sent(next), { status: 200, refused: undefined });
  const later = build([...kept, answered, { role: 'user', parts: [text('Thanks!'), now(3)] }, reply([text('Welcome.')], false), { role: 'user', parts: [text('Bye')] }]);
  assert.deepEqual(bare(later.messages.slice(0, 5)), bare(next.messages));
  assert.deepEqual(await sent(later), { status: 200, refused: undefined });
});

test("in the middle of the history, a call left out because a line joined its step stays left out, and every message goes as it went", async () => {
  const stored = [
    { role: 'user', parts: [text('Ramen near Kyoto Station?'), now(1)] },
    reply([THINKING, SEARCH, GEOCODE]),
    { role: 'user', parts: [result, text('[meanwhile, the user wrote] Somewhere quiet.')] },
  ];
  const first = build(stored, '<now>2</now>');
  assert.deepEqual(first.messages.map(kinds), [['text', 'text'], ['thinking', 'tool_use'], ['tool_result', 'text', 'text']]);
  assert.deepEqual(await sent(first), { status: 200, refused: undefined });
  // The model searched again in its reply; the now block its request ended with is kept where it was sent.
  const again = { ...SEARCH, id: 'srvtoolu_9' };
  const answered = reply([{ type: 'thinking', thinking: '', signature: 'sig-2' }, again, { ...FOUND, tool_use_id: 'srvtoolu_9' }, text('Try Ichiran.')]);
  const next = build([...stored.slice(0, 2), { role: 'user', parts: [...stored[2].parts, now(2)] }, answered, { role: 'user', parts: [text('Thanks!')] }], '<now>3</now>');
  assert.deepEqual(bare(next.messages.slice(0, 3)), bare(first.messages), 'append-only, the tail kept as it was sent');
  assert.deepEqual(await sent(next), { status: 200, refused: undefined });
});

test("an exchange the request of annai 0.5.0 refused, stored with its tool result and the words after it (the user's line included) and no reply: the call is left out, which heals it, and the model reads the line at once", async () => {
  const stuck = [
    { role: 'user', parts: [text('Ramen near Kyoto Station?')] },
    reply([THINKING, SEARCH, GEOCODE]),
    { role: 'user', parts: [result, text('[Koe said] "Checking."'), text('Try again')] },
  ];
  const body = build(stuck, '<now>3</now>');
  assert.deepEqual(body.messages.map(kinds), [['text'], ['thinking', 'tool_use'], ['tool_result', 'text', 'text', 'text']]);
  assert.deepEqual(await sent(body), { status: 200, refused: undefined });
  // What the released request was: the stand-in refuses it as the API did.
  const released = { ...body, messages: [body.messages[0], { role: 'assistant', content: [THINKING, SEARCH, GEOCODE] }, body.messages[2]] };
  assert.equal((await sent(released)).status, 400);
});

test('a reply after it that holds no result (another model answered, or Koe spoke): the call no reply answers is left out, and the rest goes as stored', async () => {
  const stuck = [
    { role: 'user', parts: [text('Ramen near Kyoto Station?'), now(1)] },
    reply([THINKING, text('Let me look.'), SEARCH, GEOCODE]),
    { role: 'user', parts: [result, now(2)] },
    { role: 'assistant', parts: [text("I couldn't check that now. Want me to try again?")] },
    { role: 'user', parts: [text('Try again')] },
  ];
  const body = build(stuck);
  assert.deepEqual(body.messages.map(kinds), [['text', 'text'], ['thinking', 'text', 'tool_use'], ['tool_result', 'text'], ['text'], ['text', 'text']]);
  assert.deepEqual(await sent(body), { status: 200, refused: undefined });
  // Its two blocks that are left out and what that leaves: an empty reply goes, and the user messages around it are one.
  const bare1 = build([{ role: 'user', parts: [text('Hi')] }, reply([THINKING, SEARCH]), { role: 'user', parts: [text('Try again')] }]);
  assert.deepEqual(bare1.messages.map(kinds), [['text', 'text', 'text']]);
  assert.deepEqual(await sent(bare1), { status: 200, refused: undefined });
});

test('a web fetch is the same', async () => {
  const fresh = build([{ role: 'user', parts: [text('Read it.')] }, reply([FETCH, GEOCODE], false), { role: 'user', parts: [result] }]);
  assert.deepEqual(fresh.messages.map(kinds), [['text'], ['server_tool_use', 'tool_use'], ['tool_result']]);
  assert.deepEqual(await sent(fresh), { status: 200, refused: undefined });
  const joined = build([{ role: 'user', parts: [text('Read it.')] }, reply([FETCH, GEOCODE], false), { role: 'user', parts: [result, text('Also the second page.')] }]);
  assert.deepEqual(joined.messages.map(kinds), [['text'], ['tool_use'], ['tool_result', 'text', 'text']]);
  assert.deepEqual(await sent(joined), { status: 200, refused: undefined });
  const gone = build([{ role: 'user', parts: [text('Read it.')] }, reply([FETCH, GEOCODE], false), { role: 'user', parts: [result] }, { role: 'assistant', parts: [text('Sorry.')] }, { role: 'user', parts: [text('Again')] }]);
  assert.deepEqual(gone.messages.map(kinds), [['text'], ['tool_use'], ['tool_result'], ['text'], ['text', 'text']]);
  assert.deepEqual(await sent(gone), { status: 200, refused: undefined });
});

test('what needs no change goes as it did: a search answered in its own reply, a paused turn, a tool call without a server tool', async () => {
  const searched = reply([THINKING, SEARCH, FOUND, text('Ichiran.'), GEOCODE]);
  const done = build([{ role: 'user', parts: [text('Ramen?')] }, searched, { role: 'user', parts: [result, text('More?')] }], '<now>2</now>');
  assert.deepEqual(done.messages.map(kinds), [['text'], ['thinking', 'server_tool_use', 'web_search_tool_result', 'text', 'tool_use'], ['tool_result', 'text', 'text']], 'its text and the tail stay');
  assert.deepEqual(await sent(done), { status: 200, refused: undefined });
  // A paused turn is continued as it is: her own message last, nothing after it, its search still to run.
  const paused = build([{ role: 'user', parts: [text('Ramen?'), now(1)] }, reply([THINKING, SEARCH])]);
  assert.deepEqual(paused.messages.map(kinds), [['text', 'text'], ['thinking', 'server_tool_use']]);
  assert.deepEqual(await sent(paused), { status: 200, refused: undefined });
  const plain = build([{ role: 'user', parts: [text('Hi')] }, reply([THINKING, GEOCODE]), { role: 'user', parts: [result, now(2)] }]);
  assert.deepEqual(plain.messages.map(kinds), [['text'], ['thinking', 'tool_use'], ['tool_result', 'text', 'text']]);
});

test("a call this request would run with its tool missing (web search switched off since) is left out, the API refusing that too; one a reply after it answers is a pair like any other", async () => {
  const stored = [
    { role: 'user', parts: [text('Ramen near Kyoto Station?')] },
    reply([THINKING, SEARCH, GEOCODE]),
    { role: 'user', parts: [result] },
  ];
  for (const off of [{ kinds: ['fetch'], off: [] }, { kinds: ['search'], off: ['anthropic-web-search'] }, null]) {
    const body = build(stored, '<now>3</now>', /** @type {any} */ (off));
    assert.deepEqual(body.messages.map(kinds), [['text'], ['thinking', 'tool_use'], ['tool_result', 'text']], String(JSON.stringify(off)));
    assert.equal((await sent(body, [])).status, 200);
  }
  // Sent with the call, without its tool: the stand-in refuses it as the API did.
  const resumed = build(stored, '<now>3</now>');
  assert.deepEqual(await sent(resumed, ['web_fetch']), { status: 400, refused: '`web_search` tool use with id `srvtoolu_1` was found without a corresponding `web_search_tool_result` block, but no `web_search` tool was provided' });
  // The search was answered by the reply after: nothing to run, so nothing needs the tool, and the pair goes as it came.
  const answered = reply([FOUND, text('Try Ichiran.')], false);
  const pair = build([...stored, answered, { role: 'user', parts: [text('Thanks')] }], '<now>4</now>', { kinds: [], off: [] });
  assert.deepEqual(pair.messages.map(kinds), [['text'], ['thinking', 'server_tool_use', 'tool_use'], ['tool_result'], ['web_search_tool_result', 'text'], ['text', 'text']]);
  assert.deepEqual(await sent(pair, []), { status: 200, refused: undefined });
});
