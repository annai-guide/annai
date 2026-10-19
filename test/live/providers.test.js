// Opt-in: talks to the real providers with your own keys, a few tokens each (spec §18). Never in CI.
//   ANNAI_LIVE_OPENROUTER_KEY=sk-or-… ANNAI_LIVE_ANTHROPIC_KEY=sk-ant-… npm run test:live
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate as chat } from '../../plugins-official/chat-completions/index.js';
import { activate as anthropic } from '../../plugins-official/anthropic-messages/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { callOnce } from '../../src/core/llm/call.js';
import { testModel } from '../../src/core/llm/check.js';

/** @param {(annai: any) => unknown} activate @returns {any} */
function load(activate) {
  /** @type {any} */
  let t = null;
  activate({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'live' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return t;
}
const model = (/** @type {any} */ over) => ({ id: 'live', provider: 'live', ability: 'chat', name: 'live', input: ['text', 'image'], tools: true, contextWindow: null, maxOutput: null, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, ...over });
const orType = load(chat);
const anType = load(anthropic);
const cases = [
  {
    env: 'ANNAI_LIVE_OPENROUTER_KEY', type: orType,
    endpoint: { id: 'live-or/chat', provider: 'live-or', ability: 'chat', type: 'chat-completions', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: { 'X-Title': 'annai tests' }, tunables: { ...orType.tunables, reasoningField: 'reasoning' }, extraBody: {} },
    model: model({ providerId: 'anthropic/claude-haiku-5.5', reasoning: { low: { reasoning: { effort: 'low' } } } }),
  },
  {
    env: 'ANNAI_LIVE_ANTHROPIC_KEY', type: anType,
    endpoint: { id: 'live-an/chat', provider: 'live-an', ability: 'chat', type: 'anthropic-messages', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', headers: {}, tunables: { ...anType.tunables }, extraBody: {} },
    model: model({ providerId: 'claude-haiku-5-5', reasoning: { off: { thinking: { type: 'disabled' } } } }),
  },
];

for (const c of cases) {
  const key = process.env[c.env];
  const skip = key ? false : `${c.env} is not set`;
  test(`${c.endpoint.name}: the Test button passes against the real API`, { skip }, async () => {
    const r = await testModel({ type: c.type, endpoint: c.endpoint, model: c.model, key: key ?? null });
    assert.equal(r.ok, true, JSON.stringify(r.steps));
  });
  test(`${c.endpoint.name}: a reply streams in, with usage`, { skip }, async () => {
    /** @type {string[]} */
    const pieces = [];
    const reply = await callOnce({
      type: c.type, endpoint: c.endpoint, model: c.model, key: key ?? null, level: 'off',
      request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Count from 1 to 20, separated by spaces.' }] }], maxOutput: 300 },
      onEvent: (e) => { if (e.type === 'text') pieces.push(e.text); },
    });
    assert.ok(pieces.length > 1, 'the text arrived in pieces');
    assert.match(reply.text, /20/);
    assert.ok(reply.usage.output > 0);
  });
  test(`${c.endpoint.name}: a wrong key is a key problem`, { skip }, async () => {
    await assert.rejects(callOnce({ type: c.type, endpoint: c.endpoint, model: c.model, key: 'sk-wrong-0000000000000000', request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }], maxOutput: 16 } }),
      (e) => e instanceof ProviderError && e.kind === 'auth');
  });
  test(`${c.endpoint.name}: the model list`, { skip }, async () => {
    const r = c.type.listRequest({ endpoint: c.endpoint, key });
    const res = await fetch(r.url, { headers: r.headers });
    assert.equal(res.status, 200);
    assert.ok(c.type.readList(await res.json()).some((/** @type {any} */ m) => m.providerId === c.model.providerId));
  });
}
