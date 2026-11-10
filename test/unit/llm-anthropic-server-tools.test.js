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
// `web_search_tool_result` block", at the end of the history and in the middle of it. What the real API took and refused (Opus, Sonnet and Haiku
// 5.5, 2026-11-10, with web search and web fetch) is in docs/lessons-full.md; the stand-in (test/fakes/anthropic-binding.js) answers as it did.

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
/** The request's status at the stand-in, and the refusal it gave. @param {any} body */
async function sent(body) {
  const claude = anthropicStandIn(() => [{ type: 'text', text: 'Ok.' }]);
  const res = await claude.fetch('https://api.anthropic.com/v1/messages', { body: JSON.stringify(body) });
  return { status: res.status, refused: claude.refused.at(-1) };
}
const kinds = (/** @type {any} */ m) => m.content.map((/** @type {any} */ b) => b.type);

for (const [name, thinking] of /** @type {const} */ ([['with thinking (a native)', true], ['without thinking (the reply as parts)', false]])) {
  test(`a fresh exchange ${name}: the user message that answers the reply holds the tool result alone and the request has no tail; the API takes it`, async () => {
    const ask = { role: 'user', parts: [text('Ramen near Kyoto Station?'), now(1)] };
    const body = build([ask, reply([...(thinking ? [THINKING] : []), SEARCH, GEOCODE], thinking), { role: 'user', parts: [result, now(2)] }], '<now>2</now>');
    assert.deepEqual(body.messages.map(kinds), [['text', 'text'], [...(thinking ? ['thinking'] : []), 'server_tool_use', 'tool_use'], ['tool_result']]);
    assert.equal(JSON.stringify(body).includes('<now>2'), false, 'neither the kept now block nor the tail goes this request');
    assert.deepEqual(body.messages[2].content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: result.content, cache_control: { type: 'ephemeral', ttl: '1h' } }], 'marked where the tail was to follow');
    assert.equal(marks(body), 2, 'the system and the end');
    assert.deepEqual(await sent(body), { status: 200, refused: undefined });
  });
}

test('a fresh exchange with two tool calls and a photo from a tool: all the results stay, the photo and the words wait', async () => {
  const two = { type: 'tool_use', id: 'toolu_2', name: 'geocode', input: { query: 'Gion' } };
  const photo = { type: 'image', mediaType: 'image/png', data: 'AAAA' };
  const body = build([
    { role: 'user', parts: [text('Ramen?')] },
    reply([SEARCH, GEOCODE, two], false),
    { role: 'user', parts: [{ ...result }, { type: 'tool_result', id: 'toolu_2', content: 'Gion', isError: true }, photo, text('Shown on screen.')] },
  ]);
  assert.deepEqual(body.messages[2].content.map((/** @type {any} */ b) => [b.type, b.tool_use_id, b.is_error]), [['tool_result', 'toolu_1', undefined], ['tool_result', 'toolu_2', true]]);
  assert.deepEqual(await sent(body), { status: 200, refused: undefined });
});

test("the same exchange in the middle of the history: what waited goes to the user message after the reply that answers it, in the order it had; the request before is the start of this one", async () => {
  const stored = [
    { role: 'user', parts: [text('Ramen near Kyoto Station?'), now(1)] },
    reply([THINKING, SEARCH, GEOCODE]),
    { role: 'user', parts: [result, now(2), text('Shown on screen. Voice is off.')] },
  ];
  const first = build(stored, '<now>2</now>');
  const answered = reply([FOUND, { type: 'thinking', thinking: '', signature: 'sig-2' }, text('Try Ichiran.')]);
  const next = build([...stored, answered, { role: 'user', parts: [text('Thanks!')] }], '<now>3</now>');
  assert.deepEqual(next.messages.map(kinds), [['text', 'text'], ['thinking', 'server_tool_use', 'tool_use'], ['tool_result'], ['web_search_tool_result', 'thinking', 'text'], ['text', 'text', 'text', 'text']]);
  assert.deepEqual(next.messages[4].content.map((/** @type {any} */ b) => b.text), ['<now>2</now>', 'Shown on screen. Voice is off.', 'Thanks!', '<now>3</now>'], 'after the reply, before the tail');
  assert.equal(next.messages[4].content[2].cache_control?.ttl, '1h', 'the tail stays after the last mark');
  assert.deepEqual(bare(next.messages.slice(0, 3)), bare(first.messages), 'append-only: what the cache holds of the request before is a start of this one');
  assert.deepEqual(await sent(next), { status: 200, refused: undefined });
  // And later, with more after it: the same.
  const later = build([...stored, answered, { role: 'user', parts: [text('Thanks!')] }, reply([text('Welcome.')], false), { role: 'user', parts: [text('Bye')] }]);
  assert.deepEqual(bare(later.messages.slice(0, 5)), bare(next.messages).map((/** @type {any} */ m, /** @type {number} */ i) => (i === 4 ? { ...m, content: m.content.slice(0, -1) } : m)));
  assert.deepEqual(await sent(later), { status: 200, refused: undefined });
});

test("an exchange the request of annai 0.5.0 refused, stored with its tool result and the words after it (the user's line included) and no reply: sent as a fresh exchange, which heals it", async () => {
  const stuck = [
    { role: 'user', parts: [text('Ramen near Kyoto Station?'), now(1)] },
    reply([THINKING, SEARCH, GEOCODE]),
    { role: 'user', parts: [result, now(2), text('Shown on screen.'), text('Try again')] },
  ];
  const body = build(stuck, '<now>3</now>');
  assert.deepEqual(body.messages.map(kinds), [['text', 'text'], ['thinking', 'server_tool_use', 'tool_use'], ['tool_result']]);
  assert.deepEqual(await sent(body), { status: 200, refused: undefined });
  // What the released request was: the stand-in refuses it as the API did.
  const released = { ...body, messages: [body.messages[0], body.messages[1], { role: 'user', content: [...body.messages[2].content, { type: 'text', text: '<now>3</now>' }] }] };
  assert.equal((await sent(released)).status, 400);
  // The words are held, not lost: after the reply that follows, they are in the next request.
  const next = build([...stuck, reply([FOUND, text('Try Ichiran.')], false), { role: 'user', parts: [text('Thanks')] }]);
  assert.deepEqual(next.messages.at(-1).content.map((/** @type {any} */ b) => b.text), ['<now>2</now>', 'Shown on screen.', 'Try again', 'Thanks', '<now>9</now>']);
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
  const fresh = build([{ role: 'user', parts: [text('Read it.')] }, reply([FETCH, GEOCODE], false), { role: 'user', parts: [result, now(2)] }]);
  assert.deepEqual(fresh.messages.map(kinds), [['text'], ['server_tool_use', 'tool_use'], ['tool_result']]);
  assert.deepEqual(await sent(fresh), { status: 200, refused: undefined });
  const gone = build([{ role: 'user', parts: [text('Read it.')] }, reply([FETCH, GEOCODE], false), { role: 'user', parts: [result] }, { role: 'assistant', parts: [text('Sorry.')] }, { role: 'user', parts: [text('Again')] }]);
  assert.deepEqual(gone.messages.map(kinds), [['text'], ['tool_use'], ['tool_result'], ['text'], ['text', 'text']]);
  assert.deepEqual(await sent(gone), { status: 200, refused: undefined });
});

test('what needs no change goes as it did: a search answered in its own reply, a paused turn, a tool call without a server tool', async () => {
  const searched = reply([THINKING, SEARCH, FOUND, text('Ichiran.'), GEOCODE]);
  const done = build([{ role: 'user', parts: [text('Ramen?')] }, searched, { role: 'user', parts: [result, now(2)] }], '<now>2</now>');
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
    { role: 'user', parts: [result, text('Try again')] },
  ];
  for (const off of [{ kinds: ['fetch'], off: [] }, { kinds: ['search'], off: ['anthropic-web-search'] }, null]) {
    const body = build(stored, '<now>3</now>', /** @type {any} */ (off));
    assert.deepEqual(body.messages.map(kinds), [['text'], ['thinking', 'tool_use'], ['tool_result', 'text', 'text']], String(JSON.stringify(off)));
    assert.equal((await sent(body)).status, 200);
  }
  // The search was answered by the reply after: nothing to run, so nothing needs the tool, and the pair goes as it came.
  const answered = reply([FOUND, text('Try Ichiran.')], false);
  const pair = build([...stored, answered, { role: 'user', parts: [text('Thanks')] }], '<now>4</now>', { kinds: [], off: [] });
  assert.deepEqual(pair.messages.map(kinds), [['text'], ['thinking', 'server_tool_use', 'tool_use'], ['tool_result'], ['web_search_tool_result', 'text'], ['text', 'text', 'text']]);
  assert.deepEqual(await sent(pair), { status: 200, refused: undefined });
});
