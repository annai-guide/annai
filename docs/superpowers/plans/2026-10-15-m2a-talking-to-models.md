# Milestone 2a: Talking to Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** annai can talk to language models, with fallback across them, and the trace shows every request. Endpoints, models, keys and roles are set in Settings → Models in three ways:
- from annai's templates
- by hand
- by signing in with OpenRouter

Usage, cost and errors are normalized across providers.

**Architecture:**
- **The core (`src/core/llm/`) contains no protocol.** It holds:
  - the provider contract: annai's message format, stream events, usage and errors
  - the shared stream helpers
  - model settings
  - the logic for one model call, and for calling a role's models in order with fallback
  - the trace records for model calls
  - templates
- **Each protocol is an official plugin, installed on demand** from `plugins-official/`: Chat Completions, Anthropic Messages, and a scripted fake model. annai installs one from its own catalog after checking the SHA-256 of every file.
- **The UI** adds Settings → Models: endpoints, models, roles, the Test button, OpenRouter sign-in, and a plain "Talk to your models" conversation.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26), the in-browser suites, and Playwright 1.63.0 (Chromium as Pixel 7, WebKit as iPhone 15).

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`. Milestone 2 is §20 row 2. This plan is its first of three parts, "Talking to models". It covers:
- the provider contract and its helpers (§9.1)
- endpoint and model settings (§9.2), reasoning levels (§9.3) and patches (§9.4)
- roles and fallback (§9.6)
- templates, onboarding and the Test button (§9.8)
- usage, cost, errors and keys (§9.9)
- the scripted fake model and provider fixtures (§18)

Done when: a plain text conversation works with fallback across two providers, and the trace shows every request.

## Global Constraints

- **Dependencies:** zero runtime dependencies. Dev dependencies stay TypeScript, Playwright and `@types/node`.
- **Modules and types:** native ES modules, no build step. JSDoc types are checked by `npm run typecheck` (three tsconfigs).
- **Platforms:** iOS (Safari) and Android (Chrome) are both required. Modern browsers only.
- **Security policy:** the Content Security Policy in `_headers` applies, including `connect-src 'self' https: http://localhost:* http://127.0.0.1:*`.
  - No `innerHTML`; model output never goes into it (§15).
  - Never set a `style` attribute.
- **Writes:** every write is one transaction. Fingerprints are computed before the transaction opens. Inside a transaction, await only `Tx` calls.
- **Shipped files:**
  - Every file under `src/` and `assets/` is listed in `sw.js` `SHELL`; a unit test checks this.
  - After any shipped file changes, run `npm run stamp`.
  - Files under `plugins-official/` and `catalog/` are not shipped in the shell. They are fetched when needed.
- **Size:** shipped JS + CSS stays under the budget. Task 1 raises it from 300 KiB to 400 KiB for milestone 2, on purpose.
- **"The core contains no protocol" (§9.1).** Endpoint types are plugins, installed from `catalog/plugins.json` with a SHA-256 per file (§5.3).
- **"Keys live only in `secrets`. They're never in context and are redacted from the trace" (§9.9).** No key is ever written to a file or an event. An error a provider echoes is scrubbed.
- **Everything stored must be named (§4.9).** A blob the trace keeps is written in the same transaction as the event that lists it in `refs`.
- **"A model request is logged as a reference, not a copy" (§4.5).** Request bodies are not stored.
- **Precedence (§9.2):** "user setting > template > plugin default".
- **Units:** prices are USD per million tokens. Usage is tokens.
- **Copy:** plain words; every error says what happened and what to do next.
- **Ports and WebKit:** the dev server and Playwright use port 8790. WebKit runs in Docker:
  `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test`.

## Verified facts (checked 2026-10-15)

- **OpenRouter sign-in** (openrouter.ai/docs, OAuth PKCE):
  - The browser goes to `https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256&state=…`.
  - OpenRouter returns to `callback_url` with `?code=…` (and the `state` it was given).
  - The key comes from `POST https://openrouter.ai/api/v1/auth/keys` with `{ code, code_verifier, code_challenge_method }`, which returns `{ key }`.
  - Codes are single-use and expire after 10 minutes. Localhost callbacks are allowed on any port.
  - Leaving out `callback_url` is "headless mode": OpenRouter shows the code for the user to copy.
  - A Home Screen app on iPhone keeps its storage apart from Safari, where the callback lands. So annai uses headless mode there.
- **OpenRouter's model list** (`GET https://openrouter.ai/api/v1/models`, public) gives, per model:
  - `context_length`
  - `architecture.input_modalities`
  - `supported_parameters` (it includes `tools`)
  - `top_provider.max_completion_tokens`
  - `pricing`: USD per token, as strings. It has `prompt`, `completion`, `input_cache_read`, `input_cache_write`, `input_cache_write_1h`, and `overrides[]` with `min_prompt_tokens` for long-prompt prices.
- **Anthropic errors** (platform.claude.com/docs/en/api/errors):
  - 400 `invalid_request_error` (also spend limits), 401 `authentication_error`, 402 `billing_error`, 403 `permission_error`, 404 `not_found_error`, 413 `request_too_large`, 429 `rate_limit_error` (with `retry-after`), 500 `api_error`, 504 `timeout_error`, 529 `overloaded_error`.
  - Errors in a stream arrive as an `error` event: `{"type":"error","error":{"type":…,"message":…}}`.
  - Thinking blocks must be passed back unchanged.
  - Current models take `thinking: {type: "adaptive"}` with `output_config.effort`.
  - Claude Haiku 5.5 accepts `thinking: {type: "disabled"}`. Claude Sonnet 5.5 uses `{type: "between_tools"}` instead.
  - Opus 5.5 and Sonnet 5.5 refuse forced `tool_choice`, so the Test button never forces a tool.
- **Browser access to Anthropic** needs the `anthropic-dangerous-direct-browser-access: true` header.
- **The model ids and prices in `catalog/templates.json`** were taken from OpenRouter's list on this date.

## Review Focus

These are failure modes the spec implies but no feature test covers. Each line names the test that pins it.

1. **A provider that echoes the key in an error** ("Incorrect API key provided: sk-…"). The key must never reach the trace.
   Pinned by Task 8: "a key the provider echoes in an error never reaches the trace". The Task 12 e2e checks the whole trace text too.
2. **A reply cut off partway,** for example when the phone switches from Wi-Fi to cellular. What was said stays, and the next model continues without repeating it.
   Pinned by Task 8: "the caller can stop a call, and what it said so far is kept with a cut-off", and Task 9: "a reply cut off partway is continued by the next model".
3. **OpenAI's 429 that means out of quota.** It must not be treated as "wait and retry". Fall back to the next model at once.
   Pinned by Task 1: "error responses become error kinds the fallback acts on".
4. **Server-sent event quirks:** keep-alive comments, CRLF, a Japanese character split between chunks, `data:` without a space, a stream without `[DONE]`.
   Pinned by Task 3's `sse` tests and Task 6: "a stream that ends early is a network error".
5. **A model that never starts answering,** such as a free model on a cold start. annai falls back after the first-output limit instead of hanging.
   Pinned by Task 8: "no first output in time is a timeout", and Task 9: "a timeout benches the model and the next one answers".

## Not in this plan

These items sit next to this work and land later, so none is dropped silently.

- **Part 2, Shiori herself:**
  - the agent loop, and context order (§6.3). This plan's adapters already accept `cacheTtl` and place Anthropic's cache markers.
  - cache warmth (§6.4), and switching back to a preferred model once the backup's cache is cold (§9.6)
  - compaction, including "request too long: compact first" (§9.6). Here the fallback only skips to a model with a larger window.
  - quick decision `decide()` (§9.7)
  - provider-side tools, and "search via / fetch via" (§9.5)
  - budgets and the stuck-loop check (§6.6)
  - cost per wake and per trip (§9.9). This plan has cost per call and per role call.
  - the conversation screen, the dock and the avatar
- **Part 3, photos to the model (§4.8):**
  - request copies
  - repairing refused images, and learned image limits
  - provider uploads and their expiry
  - the Test button's upload check (§9.8)

  This plan already classifies the `image` and `upload` error kinds and falls back.
- **Later:**
  - The speech roles (milestone 3) and the search role (part 2).
  - The OpenAI Responses and Gemini endpoint types (§9.1), "added during milestones 2 and 3 as needed" (§20). Gemini works now through its OpenAI-compatible endpoint (a template).
  - Updating an installed official plugin happens when the user installs it again: Install, or adding an endpoint of its type, installs the catalog's version. A general "update available" for plugins comes with milestone 8.

## File structure

```
scripts/size.mjs                       budget 300 → 400 KiB for milestone 2
scripts/catalog.mjs                    writes/checks catalog/plugins.json (file hashes)
catalog/plugins.json                   official on-demand plugins: id, version, what they provide, SHA-256 per file
catalog/templates.json                 endpoint templates: OpenRouter, Anthropic, OpenAI, Gemini, Groq, DeepSeek, Mistral, local, custom, scripted
plugins-official/scripted-model/       the scripted fake model (type "scripted")
plugins-official/chat-completions/     the Chat Completions endpoint type
plugins-official/anthropic-messages/   the Anthropic Messages endpoint type
src/core/llm/contract.js               message format, stream events, ProviderError, error kinds, portability, endpoint types
src/core/llm/cost.js                   usage merging and cost
src/core/llm/reasoning.js              reasoning levels and the nearest-level rule
src/core/llm/sse.js                    the streamed-response reader
src/core/llm/partial-json.js           the half-finished-JSON reader
src/core/llm/retry.js                  retry with backoff
src/core/llm/config.js                 endpoints, models, roles (two layers each), keys in secrets
src/core/llm/official.js               installing official plugins; ensureType
src/core/llm/trace.js                  net.request and model.turn events
src/core/llm/call.js                   one model call
src/core/llm/fallback.js               a role call: candidates, retries, benching, continuation
src/core/llm/templates.js              templates: load (cached), add, update, listed models
src/core/llm/check.js                  the Test button and the reasoning-level test
src/core/llm/service.js                createLlm: what the UI uses
src/core/registry.js                   + fail()
src/core/plugins.js                    + annai.providers.register, annai.helpers
src/ui/dom.js                          + jsonField
src/ui/format.js                       + formatCost, outcomeText
src/ui/screens/models.js               Settings → Models: endpoints, roles, talk
src/ui/screens/endpoint.js             one endpoint and its models
src/ui/screens/model.js                one model
src/ui/talk-panel.js                   "Talk to your models"
src/ui/openrouter.js                   Sign in with OpenRouter
src/ui/screens/trace.js                model calls in the trace, stored text
src/ui/screens/settings.js             a Models section
src/ui/shell.js, src/app/main.js       the models screen; createLlm; finishing a sign-in
test/fixtures/llm/…                    recorded-format streams and model lists
test/live/providers.test.js            opt-in live suite (never in CI)
docs/plugins.md, README.md, docs/testing/device-checklist-m2a.md
```

---

### Task 1: The provider contract: errors and portability

**Files:**
- Create: `src/core/llm/contract.js`
- Modify: `scripts/size.mjs` (budget), `sw.js` (`SHELL`)
- Test: `test/unit/llm-contract.test.js`

**Interfaces:**
- Produces:
  - **Types:** `Part`, `Message`, `ToolDef`, `Request`, `Usage`, `StopReason`, `StreamEvent`, `ErrorKind` (JSDoc).
  - **`class ProviderError extends Error`**, constructed as `(kind: ErrorKind, message: string, more?: { status?, retryAfter?, partial?, cause? })`. It has the fields `kind`, `status`, `retryAfter` (ms) and `partial` (string, default `''`).
  - **`errorFromResponse(status: number, body: string, headers?: Headers): ProviderError`**
  - **`explain(e: ProviderError): string`:** plain words for a kind.
  - **`portable(messages: Message[], modelKey: string): Message[]`** and **`safeId(id: string): string`**

- [ ] **Step 1: Raise the size budget for milestone 2**

In `scripts/size.mjs`, change the budget line to:

```js
const BUDGET = 400 * 1024; // bytes, uncompressed; raised from 300 KiB for milestone 2 (models, roles, the talk screen)
```

- [ ] **Step 2: Write the failing tests**

Create `test/unit/llm-contract.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, errorFromResponse, explain, portable, safeId } from '../../src/core/llm/contract.js';

const json = (/** @type {any} */ o) => JSON.stringify(o);

test('error responses become error kinds the fallback acts on (spec §9.9)', () => {
  const kind = (/** @type {number} */ status, body = '', /** @type {Record<string, string>} */ headers = {}) => errorFromResponse(status, body, new Headers(headers)).kind;
  assert.equal(kind(401, json({ error: { message: 'Invalid API key' } })), 'auth');
  assert.equal(kind(403), 'auth');
  assert.equal(kind(402, json({ error: { message: 'Insufficient credits' } })), 'credit');
  assert.equal(kind(404), 'not-found');
  assert.equal(kind(413), 'context');
  assert.equal(kind(429), 'rate');
  // OpenAI says "out of quota" with a 429: that is no reason to wait.
  assert.equal(kind(429, json({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', code: 'insufficient_quota' } })), 'credit');
  assert.equal(kind(503), 'overloaded');
  assert.equal(kind(529, json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })), 'overloaded');
  assert.equal(kind(500), 'server');
  assert.equal(kind(504), 'server');
  assert.equal(kind(400, json({ error: { message: 'prompt is too long: 1048577 tokens > 1000000 maximum' } })), 'context');
  assert.equal(kind(400, json({ error: { message: "This model's maximum context length is 128000 tokens." } })), 'context');
  assert.equal(kind(400, json({ error: { message: 'Image exceeds 5 MB maximum' } })), 'image');
  assert.equal(kind(400, json({ error: { message: 'Unknown parameter: foo' } })), 'bad-request');
});

test('an error keeps its status, its message and how long the provider asked to wait', () => {
  const e = errorFromResponse(429, json({ error: { message: 'Slow down' } }), new Headers({ 'retry-after': '3' }));
  assert.ok(e instanceof ProviderError);
  assert.equal(e.status, 429);
  assert.equal(e.message, 'Slow down');
  assert.equal(e.retryAfter, 3000);
  assert.equal(errorFromResponse(429, '', new Headers({ 'retry-after-ms': '250' })).retryAfter, 250);
  const at = new Date(Date.now() + 5000).toUTCString();
  const r = errorFromResponse(429, '', new Headers({ 'retry-after': at })).retryAfter ?? 0;
  assert.ok(r > 3000 && r <= 5000, `a retry-after date gave ${r} ms`);
  assert.equal(errorFromResponse(500, 'Internal Server Error').message, 'Internal Server Error');
  assert.equal(errorFromResponse(502, '').message, 'HTTP 502');
  assert.equal(errorFromResponse(400, json({ message: 'top-level message' })).message, 'top-level message');
});

test('every kind has plain words', () => {
  for (const k of ['auth', 'credit', 'rate', 'overloaded', 'context', 'image', 'upload', 'blocked', 'unreachable', 'bad-request', 'not-found', 'server', 'network', 'timeout', 'cancelled', 'plugin']) {
    assert.match(explain(new ProviderError(/** @type {any} */ (k), 'x')), /^[A-Za-z].*\.$/, k);
  }
  assert.match(explain(new ProviderError('blocked', 'x')), /doesn't allow web apps/);
});

test('portable: reasoning signed by another model is dropped, and tool-call ids every provider accepts (spec §9.6)', () => {
  /** @type {import('../../src/core/llm/contract.js').Message[]} */
  const messages = [
    { role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
    { role: 'assistant', parts: [
      { type: 'reasoning', text: 'mine', signature: 's1', model: 'model-a' },
      { type: 'reasoning', text: 'theirs', signature: 's2', model: 'model-b' },
      { type: 'reasoning', text: 'unsigned', model: 'model-b' },
      { type: 'tool_call', id: 'call:1/x', name: 'look', input: {} },
    ] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'call:1/x', content: 'ok' }] },
    { role: 'assistant', parts: [{ type: 'reasoning', text: '', redacted: 'opaque', model: 'model-b' }] },
  ];
  const out = portable(messages, 'model-a');
  assert.deepEqual(out[1].parts.map((p) => (p.type === 'reasoning' ? p.text : p.type)), ['mine', 'unsigned', 'tool_call']);
  const call = /** @type {any} */ (out[1].parts[2]);
  const result = /** @type {any} */ (out[2].parts[0]);
  assert.equal(call.id, 'call_1_x');
  assert.equal(result.id, call.id);
  assert.equal(out.length, 3, 'a message left empty is dropped');
  assert.equal(safeId(''), 'call');
  assert.equal(safeId('x'.repeat(100)).length, 64);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test test/unit/llm-contract.test.js`
Expected: FAIL. The module can't be found: `Cannot find module …/src/core/llm/contract.js`.

- [ ] **Step 4: Write the contract**

Create `src/core/llm/contract.js`:

```js
/**
 * The provider contract (spec §9.1): annai's own message format in and out, the events a
 * streamed reply is made of, normalized usage and normalized errors. Endpoint-type plugins
 * translate between this and one wire protocol; the core contains no protocol.
 *
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'image', mediaType: string, data: string }
 *   | { type: 'tool_call', id: string, name: string, input: any }
 *   | { type: 'tool_result', id: string, content: string, isError?: boolean }
 *   | { type: 'reasoning', text: string, signature?: string, redacted?: string, model?: string }} Part
 *   image.data is base64. reasoning.model is the provider model id that wrote it: a signed block
 *   (signature or redacted) is only ever sent back to that model.
 * @typedef {{ role: 'user' | 'assistant', parts: Part[] }} Message
 * @typedef {{ name: string, description: string, input: Record<string, any> }} ToolDef  input: a JSON Schema
 * @typedef {{ system?: string, messages: Message[], tools?: ToolDef[], maxOutput?: number, cacheTtl?: '5m' | '1h' }} Request
 * @typedef {{ input: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number, output: number, reasoning: number, cost?: number }} Usage
 *   Tokens. input leaves out cache reads and writes; output includes reasoning, which is also
 *   counted on its own. cost is in USD, when the provider reports it.
 * @typedef {'end' | 'tool' | 'length' | 'refusal' | 'other'} StopReason
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'reasoning', text: string, signature?: string, redacted?: string }
 *   | { type: 'tool_input', id: string, name: string, partial: string }
 *   | { type: 'tool_call', id: string, name: string, input: any }
 *   | { type: 'usage', usage: Partial<Usage> }
 *   | { type: 'stop', reason: StopReason }} StreamEvent
 *   reasoning is one whole block; tool_input is a tool call's arguments so far, to show progress.
 * @typedef {'auth' | 'credit' | 'rate' | 'overloaded' | 'context' | 'image' | 'upload' | 'blocked' | 'unreachable'
 *   | 'bad-request' | 'not-found' | 'server' | 'network' | 'timeout' | 'cancelled' | 'plugin'} ErrorKind
 */

/** What the user is told, by kind of error (spec §9.9). */
const PLAIN = Object.freeze({
  auth: 'The key was rejected. Check it in Settings → Models.',
  credit: 'This account is out of credit.',
  rate: 'The provider says too many requests for now.',
  overloaded: 'The provider is overloaded right now.',
  context: 'The conversation is too long for this model.',
  image: "This model didn't accept the photo.",
  upload: 'A photo uploaded earlier has expired.',
  blocked: "This endpoint doesn't allow web apps like annai to call it.",
  unreachable: "annai couldn't reach this endpoint. It may be down, or it may not allow web apps.",
  'bad-request': "The provider didn't accept the request. Check the endpoint's tunables.",
  'not-found': "The provider doesn't know this model or address. Check the model id and the base URL.",
  server: 'The provider had a problem on its side.',
  network: 'The connection dropped.',
  timeout: 'The model took too long to start answering.',
  cancelled: 'Stopped.',
  plugin: 'The plugin for this endpoint type failed.',
});

export class ProviderError extends Error {
  /**
   * @param {ErrorKind} kind @param {string} message
   * @param {{ status?: number, retryAfter?: number, partial?: string, cause?: unknown }} [more]
   *   retryAfter: ms the provider asked to wait; partial: what the reply had already said
   */
  constructor(kind, message, more = {}) {
    super(message, more.cause === undefined ? undefined : { cause: more.cause });
    this.name = 'ProviderError';
    /** @type {ErrorKind} */
    this.kind = kind;
    this.status = more.status;
    this.retryAfter = more.retryAfter;
    this.partial = more.partial ?? '';
  }
}

/** Plain words for an error, by its kind. @param {ProviderError} e */
export function explain(e) {
  return PLAIN[e.kind] ?? e.message;
}

/**
 * The core's reading of an error response. Endpoint types refine the kind with their own codes.
 * @param {number} status @param {string} body @param {Headers} [headers]
 * @returns {ProviderError}
 */
export function errorFromResponse(status, body, headers) {
  const message = messageOf(body) || `HTTP ${status}`;
  return new ProviderError(kindOf(status, message), message, { status, retryAfter: retryAfterOf(headers) });
}

/** @param {number} status @param {string} message @returns {ErrorKind} */
function kindOf(status, message) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credit';
  if (status === 404) return 'not-found';
  if (status === 413) return 'context';
  if (status === 429) return /quota|billing|credit|balance/i.test(message) ? 'credit' : 'rate';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  if (/context|too long|too many tokens|maximum.*tokens/i.test(message)) return 'context';
  if (/image/i.test(message)) return 'image';
  return 'bad-request';
}

/** The message in an error body: JSON's error.message or message, else the start of the text. @param {string} body */
function messageOf(body) {
  if (!body) return '';
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : '');
    if (typeof m === 'string' && m) return m.slice(0, 500);
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 300);
}

/** How long the provider asked to wait, in ms. @param {Headers} [headers] @returns {number | undefined} */
function retryAfterOf(headers) {
  const ms = headers?.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const v = headers?.get('retry-after');
  if (!v) return undefined;
  if (Number.isFinite(Number(v))) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * The transcript as one model may see it (spec §9.6): reasoning signed by another model is
 * dropped, and tool-call ids are rewritten into a form every provider accepts.
 * @param {Message[]} messages @param {string} modelKey the provider model id the request goes to
 * @returns {Message[]}
 */
export function portable(messages, modelKey) {
  return messages
    .map((m) => ({
      role: m.role,
      parts: m.parts.flatMap((p) => {
        if (p.type === 'reasoning') return (p.signature || p.redacted) && p.model !== modelKey ? [] : [p];
        if (p.type === 'tool_call' || p.type === 'tool_result') return [{ ...p, id: safeId(p.id) }];
        return [p];
      }),
    }))
    .filter((m) => m.parts.length);
}

/** A tool-call id every provider accepts: letters, digits, "_" and "-", at most 64. @param {string} id */
export function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'call';
}
```

In `sw.js`, add the new file to `SHELL` right after `'/src/core/hash.js',`:

```js
  '/src/core/llm/contract.js',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/llm-contract.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: typecheck clean, all unit tests pass, size under 400 KiB, stamp current.

```bash
git add scripts/size.mjs src/core/llm/contract.js sw.js test/unit/llm-contract.test.js
git commit -m "The provider contract: annai's message format, stream events and error kinds"
```

---

### Task 2: Usage, cost and reasoning levels

**Files:**
- Create: `src/core/llm/cost.js`, `src/core/llm/reasoning.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/llm-cost.test.js`

**Interfaces:**
- Consumes: `Usage` (Task 1).
- Produces:
  - **From `cost.js`:**
    - the types `PriceSet` and `Prices` (USD per million tokens, with `tiers?: { above, …prices }[]`)
    - `NO_USAGE`
    - `mergeUsage(acc: Usage, part: Partial<Usage>): Usage`: later numbers win
    - `addUsage(a, b): Usage`: sums tokens only
    - `costOf(usage: Usage, prices: Prices | null | undefined): number | undefined`
    - `addCost(a?: number, b?: number): number | undefined`
  - **From `reasoning.js`:**
    - `LEVELS`: `['off','low','medium','high','max']`
    - `ROLE_LEVELS`: `{ main: 'medium', utility: 'low', decide: 'off' }`
    - `nearestLevel(map, level): string | null`
    - `levelPatch(map, level): any | null`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/llm-cost.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_USAGE, mergeUsage, addUsage, costOf, addCost } from '../../src/core/llm/cost.js';
import { LEVELS, ROLE_LEVELS, nearestLevel, levelPatch } from '../../src/core/llm/reasoning.js';

/** @param {number | undefined} a @param {number} b */
const close = (a, b) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

test('cost is usage × prices per million tokens, by kind of token (spec §9.9)', () => {
  const prices = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 };
  const usage = { ...NO_USAGE, input: 1000, cacheRead: 10_000, cacheWrite: 2000, cacheWrite1h: 1000, output: 500, reasoning: 200 };
  close(costOf(usage, prices), (1000 * 2 + 10_000 * 0.1 + 2000 * 2.5 + 1000 * 4 + 500 * 10) / 1e6);
});

test('a long prompt is priced by its tier', () => {
  const prices = { input: 0.1, output: 0.5, cacheRead: 0.01, tiers: [{ above: 99_999, input: 0.5, output: 2.5, cacheRead: 0.05 }] };
  close(costOf({ ...NO_USAGE, input: 50_000, output: 1000 }, prices), (50_000 * 0.1 + 1000 * 0.5) / 1e6);
  close(costOf({ ...NO_USAGE, input: 90_000, cacheRead: 60_000, output: 1000 }, prices), (90_000 * 0.5 + 60_000 * 0.05 + 1000 * 2.5) / 1e6);
});

test('missing cache prices fall back to the input price; a reported cost wins; no prices is unknown', () => {
  close(costOf({ ...NO_USAGE, cacheRead: 1000, cacheWrite: 1000, cacheWrite1h: 1000 }, { input: 1, output: 1 }), 3000 / 1e6);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, cost: 0.5 }, { input: 1, output: 1 }), 0.5);
  assert.equal(costOf({ ...NO_USAGE, input: 1000 }, null), undefined);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, cost: 0.25 }, null), 0.25);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, output: 10 }, { input: 0, output: 0 }), 0);
});

test('mergeUsage keeps the latest number of each kind; addUsage and addCost sum calls', () => {
  const a = mergeUsage(mergeUsage({ ...NO_USAGE }, { input: 50, cacheRead: 8000, output: 1 }), { output: 7 });
  assert.deepEqual(a, { ...NO_USAGE, input: 50, cacheRead: 8000, output: 7 });
  assert.equal(mergeUsage(a, { cost: 0.01 }).cost, 0.01);
  assert.deepEqual(addUsage(a, { ...NO_USAGE, input: 1, output: 1, reasoning: 2 }), { ...NO_USAGE, input: 51, cacheRead: 8000, output: 8, reasoning: 2 });
  assert.equal(addCost(undefined, undefined), undefined);
  assert.equal(addCost(undefined, 0.5), 0.5);
  close(addCost(0.25, 0.5), 0.75);
});

test("reasoning levels: the model's own, else the nearest, the cheaper on a tie (spec §9.3)", () => {
  assert.deepEqual(LEVELS, ['off', 'low', 'medium', 'high', 'max']);
  assert.deepEqual(ROLE_LEVELS, { main: 'medium', utility: 'low', decide: 'off' });
  const map = { low: { e: 'low' }, high: { e: 'high' } };
  assert.equal(nearestLevel(map, 'low'), 'low');
  assert.equal(nearestLevel(map, 'medium'), 'low', 'a tie goes to the cheaper level');
  assert.equal(nearestLevel(map, 'max'), 'high');
  assert.equal(nearestLevel(map, 'off'), 'low');
  assert.equal(nearestLevel({}, 'medium'), null);
  assert.equal(nearestLevel(undefined, 'medium'), null);
  assert.deepEqual(levelPatch(map, 'max'), { e: 'high' });
  assert.equal(levelPatch({}, 'high'), null);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/llm-cost.test.js`
Expected: FAIL. The module can't be found: `Cannot find module …/src/core/llm/cost.js`.

- [ ] **Step 3: Write cost.js and reasoning.js**

Create `src/core/llm/cost.js`:

```js
/**
 * Usage and cost (spec §9.9). Prices are USD per million tokens. A tier replaces the base prices
 * when the prompt is longer than its `above` tokens, as some providers charge more for long prompts.
 * @typedef {import('./contract.js').Usage} Usage
 * @typedef {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number, cacheWrite1h?: number }} PriceSet
 * @typedef {PriceSet & { tiers?: (PriceSet & { above: number })[] }} Prices
 */

/** @type {Readonly<Usage>} */
export const NO_USAGE = Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 });
const FIELDS = /** @type {const} */ (['input', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'output', 'reasoning']);

/**
 * The usage a stream reported so far, updated by a later report: each number given replaces the
 * earlier one (providers report running totals).
 * @param {Usage} acc @param {Partial<Usage>} part @returns {Usage}
 */
export function mergeUsage(acc, part) {
  const out = { ...acc };
  for (const k of FIELDS) {
    const v = part[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  if (typeof part.cost === 'number' && Number.isFinite(part.cost)) out.cost = part.cost;
  return out;
}

/** The tokens of two calls added up (costs are added with addCost). @param {Partial<Usage>} a @param {Partial<Usage>} b @returns {Usage} */
export function addUsage(a, b) {
  const out = { ...NO_USAGE };
  for (const k of FIELDS) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

/**
 * The cost of a call in USD: what the provider reported, else usage × prices. Undefined when
 * neither is known. Cache prices the model doesn't list cost what input costs.
 * @param {Usage} usage @param {Prices | null | undefined} prices @returns {number | undefined}
 */
export function costOf(usage, prices) {
  if (typeof usage.cost === 'number') return usage.cost;
  if (!prices) return undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite + usage.cacheWrite1h;
  const tier = (prices.tiers ?? []).filter((t) => prompt > t.above).sort((x, y) => y.above - x.above)[0];
  const p = { ...prices, ...tier };
  const input = p.input ?? 0;
  const per = (/** @type {number} */ n, /** @type {number | undefined} */ price) => (n * (price ?? 0)) / 1e6;
  return per(usage.input, input) + per(usage.cacheRead, p.cacheRead ?? input) + per(usage.cacheWrite, p.cacheWrite ?? input)
    + per(usage.cacheWrite1h, p.cacheWrite1h ?? p.cacheWrite ?? input) + per(usage.output, p.output);
}

/** Two costs added up; unknown only when both are. @param {number | undefined} a @param {number | undefined} b */
export function addCost(a, b) {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}
```

Create `src/core/llm/reasoning.js`:

```js
/**
 * Reasoning levels (spec §9.3). Each model maps levels to a request patch; a level the map lacks
 * uses the nearest one it has, and on a tie the cheaper.
 */
export const LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'max']);

/** Each role's default level, which the user can change. */
export const ROLE_LEVELS = Object.freeze({ main: 'medium', utility: 'low', decide: 'off' });

/** @param {Record<string, any> | undefined} map @param {string} level @returns {string | null} */
export function nearestLevel(map, level) {
  const have = LEVELS.filter((l) => map && Object.hasOwn(map, l));
  if (!have.length) return null;
  const want = Math.max(0, LEVELS.indexOf(level));
  let best = have[0];
  for (const l of have) {
    const d = Math.abs(LEVELS.indexOf(l) - want);
    const bd = Math.abs(LEVELS.indexOf(best) - want);
    if (d < bd || (d === bd && LEVELS.indexOf(l) < LEVELS.indexOf(best))) best = l;
  }
  return best;
}

/** The request patch for a level, or null when the model has no reasoning map. @param {Record<string, any> | undefined} map @param {string} level */
export function levelPatch(map, level) {
  const l = nearestLevel(map, level);
  return l && map ? map[l] : null;
}
```

In `sw.js`, add to `SHELL`, after `'/src/core/llm/contract.js',`:

```js
  '/src/core/llm/cost.js',
```

And after `'/src/core/llm/cost.js',`:

```js
  '/src/core/llm/reasoning.js',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/llm-cost.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: all green.

```bash
git add src/core/llm/cost.js src/core/llm/reasoning.js sw.js test/unit/llm-cost.test.js
git commit -m "Usage, cost per million tokens with long-prompt tiers, and reasoning levels"
```

---

### Task 3: The stream helpers: events, half-finished JSON, retry

**Files:**
- Create: `src/core/llm/sse.js`, `src/core/llm/partial-json.js`, `src/core/llm/retry.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/llm-stream.test.js`

**Interfaces:**
- Consumes: `ProviderError` (Task 1).
- Produces:
  - `sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string, data: string }>`. A connection that drops mid-stream is a `ProviderError('network')`; an abort is rethrown as it is.
  - `parsePartialJSON(text: string): any`: the value so far, or `undefined`
  - `retry(fn, { tries=3, base=500, retryIf, sleep }): Promise<T>`: waits base, then base×3, and so on

- [ ] **Step 1: Write the failing tests**

Create `test/unit/llm-stream.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError } from '../../src/core/llm/contract.js';

/** A body that delivers these chunks one at a time. @param {(string | Uint8Array)[]} chunks */
function body(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) {
        const x = chunks[i++];
        c.enqueue(typeof x === 'string' ? enc.encode(x) : x);
      } else c.close();
    },
  });
}
/** @template T @param {AsyncIterable<T>} it */
async function all(it) {
  /** @type {T[]} */
  const out = [];
  for await (const x of it) out.push(x);
  return out;
}

test('sse: events, data lines, comments and every line ending', async () => {
  const got = await all(sse(body([': OPENROUTER PROCESSING\n\n', 'event: ping\ndata: {}\n\n', 'data: a\r\ndata: b\r\n\r\n', 'data:no-space\r', '\n\r\n', 'data: last'])));
  assert.deepEqual(got, [
    { event: 'ping', data: '{}' },
    { event: 'message', data: 'a\nb' },
    { event: 'message', data: 'no-space' },
    { event: 'message', data: 'last' },
  ]);
});

test('sse: a character split between two chunks arrives whole', async () => {
  const bytes = new TextEncoder().encode('data: 案内\n\n');
  const got = await all(sse(body([bytes.slice(0, 8), bytes.slice(8)])));
  assert.deepEqual(got, [{ event: 'message', data: '案内' }]);
});

test('sse: stopping early cancels the body', async () => {
  let cancelled = false;
  const b = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n')); },
    cancel() { cancelled = true; },
  });
  for await (const e of sse(b)) {
    assert.equal(e.data, '1');
    break;
  }
  assert.equal(cancelled, true);
});

test('sse: a connection that drops mid-stream is a network error, after what arrived', async () => {
  let n = 0;
  const b = new ReadableStream({
    pull(c) {
      if (n++ === 0) c.enqueue(new TextEncoder().encode('data: 1\n\n'));
      else c.error(new TypeError('network error'));
    },
  });
  /** @type {string[]} */
  const got = [];
  await assert.rejects((async () => { for await (const e of sse(b)) got.push(e.data); })(), (e) => e instanceof ProviderError && e.kind === 'network');
  assert.deepEqual(got, ['1']);
});

test('parsePartialJSON reads JSON that is still arriving', () => {
  assert.deepEqual(parsePartialJSON('{"text": "Hello wor'), { text: 'Hello wor' });
  assert.deepEqual(parsePartialJSON('{"a": [1, 2, {"b": "c'), { a: [1, 2, { b: 'c' }] });
  assert.deepEqual(parsePartialJSON('{"text": "Hi", "mo'), { text: 'Hi' });
  assert.deepEqual(parsePartialJSON('{"text": "Hi",'), { text: 'Hi' });
  assert.deepEqual(parsePartialJSON('{"ok": tr'), {});
  assert.deepEqual(parsePartialJSON('{"say": "a \\"quote'), { say: 'a "quote' });
  assert.deepEqual(parsePartialJSON('{"say": "line\\'), { say: 'line' });
  assert.deepEqual(parsePartialJSON('{"say": "caf\\u00e'), { say: 'caf' });
  assert.deepEqual(parsePartialJSON('{"say": "案内'), { say: '案内' });
  assert.deepEqual(parsePartialJSON('{"a": 1}'), { a: 1 });
  assert.equal(parsePartialJSON(''), undefined);
  assert.equal(parsePartialJSON('nonsense'), undefined);
});

test('retry waits longer each time and gives up when told to', async () => {
  /** @type {number[]} */
  const waits = [];
  const sleep = async (/** @type {number} */ ms) => { waits.push(ms); };
  let n = 0;
  assert.equal(await retry(async () => { if (++n < 3) throw new Error('flaky'); return 'ok'; }, { sleep }), 'ok');
  assert.deepEqual(waits, [500, 1500]);
  await assert.rejects(retry(async () => { throw new Error('always'); }, { tries: 2, sleep }), /always/);
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error('fatal'); }, { retryIf: () => false, sleep }), /fatal/);
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/llm-stream.test.js`
Expected: FAIL. The module can't be found: `Cannot find module …/src/core/llm/sse.js`.

- [ ] **Step 3: Write the three helpers**

Create `src/core/llm/sse.js`:

```js
import { ProviderError } from './contract.js';

/**
 * Server-sent events from a response body: "the streamed-response reader" (spec §9.1).
 * Comment lines (":", such as OpenRouter's keep-alives) are skipped. Lines may end in \n, \r\n or
 * \r, and a character may be split between chunks. Stopping early cancels the body. A connection
 * that drops mid-stream is a ProviderError of kind "network"; an abort stays an abort.
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<{ event: string, data: string }>}
 */
export async function* sse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  /** @type {string[]} */
  let data = [];
  let finished = false;
  /** @param {string} line @returns {{ event: string, data: string } | null} an event, when the line ends one */
  const take = (line) => {
    if (line === '') {
      const out = data.length ? { event: event || 'message', data: data.join('\n') } : null;
      event = '';
      data = [];
      return out;
    }
    if (line.startsWith(':')) return null;
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    return null;
  };
  try {
    for (;;) {
      /** @type {ReadableStreamReadResult<Uint8Array>} */
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        const name = /** @type {any} */ (e)?.name;
        if (name === 'AbortError' || name === 'TimeoutError') throw e;
        throw new ProviderError('network', 'The connection dropped.', { cause: e });
      }
      const { value, done } = chunk;
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (;;) {
        const i = buf.search(/[\r\n]/);
        if (i < 0) break;
        if (buf[i] === '\r' && i === buf.length - 1 && !done) break; // a \n may follow in the next chunk
        const line = buf.slice(0, i);
        buf = buf.slice(buf[i] === '\r' && buf[i + 1] === '\n' ? i + 2 : i + 1);
        const out = take(line);
        if (out) yield out;
      }
      if (done) {
        if (buf) take(buf);
        buf = '';
        const out = take('');
        if (out) yield out;
        finished = true;
        return;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
```

Create `src/core/llm/partial-json.js`:

```js
/**
 * Reads JSON that is still arriving: "the half-finished-JSON reader" (spec §9.1). It closes what
 * is open (a string, arrays, objects) and drops a dangling key, comma or half-written value, so a
 * tool's arguments can be used while they stream. Undefined when nothing usable has arrived yet.
 * @param {string} text
 * @returns {any}
 */
export function parsePartialJSON(text) {
  let s = text.trimEnd();
  while (s) {
    try {
      return JSON.parse(close(s));
    } catch {
      s = s.slice(0, -1).trimEnd();
    }
  }
  return undefined;
}

/** s with an escape cut short dropped, and its open string, arrays and objects closed. @param {string} s */
function close(s) {
  /** @type {string[]} */
  const stack = [];
  let inString = false;
  let end = s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') {
        const need = s[i + 1] === 'u' ? 6 : 2;
        if (i + need > s.length) {
          end = i;
          break;
        }
        i += need - 1;
      } else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return s.slice(0, end) + (inString ? '"' : '') + stack.reverse().join('');
}
```

Create `src/core/llm/retry.js`:

```js
/**
 * Runs fn until it succeeds or the tries run out, waiting base ms, then 3× as long each time:
 * "retry with backoff" (spec §5.4).
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{ tries?: number, base?: number, retryIf?: (e: unknown) => boolean, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function retry(fn, { tries = 3, base = 500, retryIf = () => true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt + 1 >= tries || !retryIf(e)) throw e;
      await sleep(base * 3 ** attempt);
    }
  }
}
```

In `sw.js`, add these lines to `SHELL`. Put the first after `'/src/core/llm/cost.js',` and the other two after `'/src/core/llm/reasoning.js',`:

```js
  '/src/core/llm/partial-json.js',
```

```js
  '/src/core/llm/retry.js',
  '/src/core/llm/sse.js',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/llm-stream.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: all green.

```bash
git add src/core/llm/sse.js src/core/llm/partial-json.js src/core/llm/retry.js sw.js test/unit/llm-stream.test.js
git commit -m "Stream helpers: server-sent events, half-finished JSON, retry with backoff"
```

---

### Task 4: Model settings: endpoints, models, roles and keys

**Files:**
- Create: `src/core/llm/config.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/llm-config.test.js`

**Interfaces:**
- Consumes: `LEVELS` and `ROLE_LEVELS` (Task 2), and `Prices` (Task 2).
- Produces, all from `config.js`:
  - **Records:** the types `EndpointRecord` and `ModelRecord`, each with `template: { id, version, values } | null` and `user: values`.
  - **Effective values:** the types `Endpoint`, `Model`, `Roles` and `ModelConfig`. A role is `{ models, level, firstOutputSeconds? }`.
  - **Constants:** `CHAT_ROLES`: `['main', 'utility', 'decide']`.
  - **Reading:**
    - `readConfig(ws): Promise<ModelConfig>`
    - `endpointOf(rec, tunableDefaults?): Endpoint` and `endpointBase(rec, tunableDefaults?)`
    - `modelOf(rec): Model` and `modelBase(rec)`
    - `diffLayer(edited, base): object`
  - **Creating and saving:**
    - `newEndpoint(type, { template?, user? }, now?)` and `newModel(endpointId, { template?, user? }, now?)`
    - `saveEndpoint(ws, rec, models?)`, `saveModel(ws, rec)` and `saveRoles(ws, roles)`
  - **Removing:** `removeEndpoint(ws, store, id)` and `removeModel(ws, id)`.
  - **Keys:** `setKey(store, endpointId, key | null)` and `getKey(store, endpointId): Promise<string | null>`.

Files live in the settings scope (`sys:settings`):
- `/llm/endpoints/<id>.json`
- `/llm/models/<id>.json`
- `/llm/roles.json`

Keys are the secrets `llm:<endpointId>`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/llm-config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, ValidationError } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS_SETTINGS } from '../../src/core/scopes.js';
import {
  CHAT_ROLES, readConfig, endpointOf, endpointBase, modelOf, modelBase, diffLayer, newEndpoint, newModel,
  saveEndpoint, saveModel, saveRoles, removeEndpoint, removeModel, setKey, getKey,
} from '../../src/core/llm/config.js';

async function setup() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  return { store, ws };
}

const openrouter = () => newEndpoint('chat-completions', {
  template: { id: 'openrouter', version: 1, values: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', tunables: { reasoningField: 'reasoning' } } },
});

test('settings round-trip, and effective values are plugin defaults < template < user (spec §9.2)', async () => {
  const { ws } = await setup();
  const ep = { ...openrouter(), user: { name: 'My router' } };
  const m = newModel(ep.id, {
    template: { id: 'openrouter/x', version: 1, values: { providerId: 'x/y', contextWindow: 1000, prices: { input: 1, output: 2 } } },
    user: { contextWindow: 500 },
  });
  await saveEndpoint(ws, ep, [m]);
  const cfg = await readConfig(ws);
  const e = endpointOf(cfg.endpoints[ep.id], { reasoningField: 'auto', usageInStream: true });
  assert.equal(e.name, 'My router');
  assert.equal(e.baseUrl, 'https://openrouter.ai/api/v1');
  assert.deepEqual(e.tunables, { reasoningField: 'reasoning', usageInStream: true });
  assert.deepEqual(e.headers, {});
  const mm = modelOf(cfg.models[m.id]);
  assert.equal(mm.name, 'x/y', 'a model is named by its provider id until the user names it');
  assert.equal(mm.contextWindow, 500);
  assert.deepEqual(mm.prices, { input: 1, output: 2 });
  assert.deepEqual(mm.input, ['text']);
  assert.equal(mm.tools, true);
  assert.equal(endpointBase(cfg.endpoints[ep.id]).name, 'OpenRouter');
  assert.equal(modelBase(cfg.models[m.id]).contextWindow, 1000);
});

test("a newer template changes what the user left alone, never what they changed", () => {
  const rec = newModel('ep-1', { template: { id: 't/x', version: 1, values: { providerId: 'x', contextWindow: 1000, maxOutput: 100 } }, user: { maxOutput: 50 } });
  const updated = { ...rec, template: { id: 't/x', version: 2, values: { providerId: 'x', contextWindow: 2000, maxOutput: 200 } } };
  assert.equal(modelOf(updated).contextWindow, 2000);
  assert.equal(modelOf(updated).maxOutput, 50);
});

test('diffLayer keeps only what the user changed', () => {
  const base = { name: 'OpenRouter', baseUrl: 'https://x', headers: {}, tunables: { a: 1 }, extraBody: {} };
  assert.deepEqual(diffLayer({ ...base }, base), {});
  assert.deepEqual(diffLayer({ ...base, name: 'Mine', tunables: { a: 2 } }, base), { name: 'Mine', tunables: { a: 2 } });
});

test('model names are unique, whatever their case', async () => {
  const { ws } = await setup();
  const ep = openrouter();
  await saveEndpoint(ws, ep);
  await saveModel(ws, newModel(ep.id, { user: { providerId: 'a/b', name: 'Haiku' } }));
  await assert.rejects(saveModel(ws, newModel(ep.id, { user: { providerId: 'c/d', name: 'haiku' } })), (e) => e instanceof ValidationError && /already used/.test(e.errors.join()));
  await assert.rejects(saveModel(ws, newModel(ep.id, { user: {} })), ValidationError);
  await assert.rejects(saveModel(ws, newModel('ep-gone', { user: { providerId: 'z' } })), ValidationError);
});

test('roles: every chat role, its default level, and only models that exist', async () => {
  const { ws } = await setup();
  const ep = openrouter();
  const a = newModel(ep.id, { user: { providerId: 'a' } });
  await saveEndpoint(ws, ep, [a]);
  await saveRoles(ws, { main: { models: [a.id, 'm-gone'], level: 'high', firstOutputSeconds: 20 }, utility: { models: [], level: 'low' } });
  const { roles } = await readConfig(ws);
  assert.deepEqual(Object.keys(roles).sort(), [...CHAT_ROLES].sort());
  assert.deepEqual(roles.main, { models: [a.id], level: 'high', firstOutputSeconds: 20 });
  assert.deepEqual(roles.decide, { models: [], level: 'off' });
  await assert.rejects(saveRoles(ws, { main: { models: [], level: 'extreme' } }), ValidationError);
});

test('removing an endpoint removes its models, their places in roles, and its key', async () => {
  const { ws, store } = await setup();
  const ep = openrouter();
  const other = newEndpoint('anthropic-messages', { user: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com' } });
  const a = newModel(ep.id, { user: { providerId: 'a' } });
  const b = newModel(other.id, { user: { providerId: 'b' } });
  await saveEndpoint(ws, ep, [a]);
  await saveEndpoint(ws, other, [b]);
  await saveRoles(ws, { main: { models: [a.id, b.id], level: 'medium' } });
  await setKey(store, ep.id, 'sk-or-1234567890');
  await removeEndpoint(ws, store, ep.id);
  const cfg = await readConfig(ws);
  assert.deepEqual(Object.keys(cfg.endpoints), [other.id]);
  assert.deepEqual(Object.keys(cfg.models), [b.id]);
  assert.deepEqual(cfg.roles.main.models, [b.id]);
  assert.equal(await getKey(store, ep.id), null);
  await removeModel(ws, b.id);
  assert.deepEqual((await readConfig(ws)).roles.main.models, []);
});

test('keys live only in secrets, never in the settings files (spec §9.9)', async () => {
  const { ws, store } = await setup();
  const ep = openrouter();
  await saveEndpoint(ws, ep);
  await setKey(store, ep.id, 'sk-or-secret-key-1');
  assert.equal(await getKey(store, ep.id), 'sk-or-secret-key-1');
  for (const f of await ws.list(SYS_SETTINGS, '/')) assert.doesNotMatch(String(await ws.readText(SYS_SETTINGS, f.path)), /sk-or-secret/);
  await setKey(store, ep.id, null);
  assert.equal(await getKey(store, ep.id), null);
});

test('records that are not valid are refused on save and skipped on read', async () => {
  const { ws } = await setup();
  await assert.rejects(saveEndpoint(ws, /** @type {any} */ ({ id: 'BAD ID', type: '', template: null, user: {}, created: 1 })), ValidationError);
  await ws.write(SYS_SETTINGS, '/llm/endpoints/broken.json', { nope: true }, { author: 'user' });
  const ep = openrouter();
  await saveEndpoint(ws, ep);
  assert.deepEqual(Object.keys((await readConfig(ws)).endpoints), [ep.id]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/llm-config.test.js`
Expected: FAIL. The module can't be found: `Cannot find module …/src/core/llm/config.js`.

- [ ] **Step 3: Write config.js**

Create `src/core/llm/config.js`:

```js
import { validate } from '../schema.js';
import { mergePatch } from '../patch.js';
import { ValidationError } from '../workspace.js';
import { SYS_SETTINGS, newId } from '../scopes.js';
import { LEVELS, ROLE_LEVELS } from './reasoning.js';

/**
 * Endpoints, models and roles (spec §9.2, §9.6), kept as files in the settings scope, and API keys,
 * kept only in secrets (§9.9). Every endpoint and model stores two layers: what a template (or a
 * fetched model list) said, and what the user changed. Effective values are plugin defaults, then
 * the template, then the user's (§9.2: user setting > template > plugin default), so a template
 * update never overwrites the user's changes.
 * @typedef {import('../workspace.js').Workspace} Workspace @typedef {import('../types.js').Store} Store
 * @typedef {import('./cost.js').Prices} Prices
 * @typedef {{ name?: string, baseUrl?: string, headers?: Record<string, string>, tunables?: Record<string, any>, extraBody?: Record<string, any> }} EndpointValues
 * @typedef {{ name?: string, providerId?: string, input?: string[], tools?: boolean, contextWindow?: number | null, maxOutput?: number | null,
 *   prices?: Prices | null, cacheTtls?: string[], reasoning?: Record<string, any>, tunables?: Record<string, any>, extraBody?: Record<string, any> }} ModelValues
 * @typedef {{ id: string, type: string, template: { id: string, version: number, values: EndpointValues } | null, user: EndpointValues,
 *   verified?: Record<string, any>, created: number }} EndpointRecord
 * @typedef {{ id: string, endpoint: string, template: { id: string, version: number, values: ModelValues } | null, user: ModelValues,
 *   verified?: Record<string, any>, created: number }} ModelRecord
 * @typedef {{ id: string, type: string, name: string, baseUrl: string, headers: Record<string, string>, tunables: Record<string, any>, extraBody: Record<string, any> }} Endpoint
 * @typedef {{ id: string, endpoint: string, name: string, providerId: string, input: string[], tools: boolean, contextWindow: number | null,
 *   maxOutput: number | null, prices: Prices | null, cacheTtls: string[], reasoning: Record<string, any>, tunables: Record<string, any>,
 *   extraBody: Record<string, any> }} Model
 * @typedef {Record<string, { models: string[], level: string, firstOutputSeconds?: number }>} Roles
 *   firstOutputSeconds: how long to wait for a model's first words before trying the next (spec §9.6)
 * @typedef {{ endpoints: Record<string, EndpointRecord>, models: Record<string, ModelRecord>, roles: Roles }} ModelConfig
 */

/** The roles that call chat models; an empty one uses the main list (spec §9.6). */
export const CHAT_ROLES = Object.freeze(['main', 'utility', 'decide']);

const endpointPath = (/** @type {string} */ id) => `/llm/endpoints/${id}.json`;
const modelPath = (/** @type {string} */ id) => `/llm/models/${id}.json`;
const ROLES_PATH = '/llm/roles.json';
const secretId = (/** @type {string} */ endpointId) => `llm:${endpointId}`;

const ENDPOINT_DEFAULTS = Object.freeze({ name: '', baseUrl: '', headers: {}, tunables: {}, extraBody: {} });
const MODEL_DEFAULTS = Object.freeze({
  name: '', providerId: '', input: ['text'], tools: true, contextWindow: null, maxOutput: null, prices: null,
  cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {},
});

const OBJECT = { type: 'object' };
const VALUES = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 120 },
    baseUrl: { type: 'string', maxLength: 2000 },
    providerId: { type: 'string', maxLength: 300 },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    tunables: OBJECT,
    extraBody: OBJECT,
    reasoning: OBJECT,
    input: { type: 'array', items: { enum: ['text', 'image', 'pdf', 'audio'] } },
    tools: { type: 'boolean' },
    contextWindow: { type: ['integer', 'null'], minimum: 1 },
    maxOutput: { type: ['integer', 'null'], minimum: 1 },
    prices: { type: ['object', 'null'] },
    cacheTtls: { type: 'array', items: { enum: ['5m', '1h'] } },
  },
};
const TEMPLATE = { type: ['object', 'null'], required: ['id', 'version', 'values'], properties: { id: { type: 'string' }, version: { type: 'integer', minimum: 0 }, values: VALUES } };
const ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,80}$' };
const ENDPOINT_SCHEMA = {
  type: 'object',
  required: ['id', 'type', 'template', 'user', 'created'],
  properties: { id: ID, type: { type: 'string', minLength: 1 }, template: TEMPLATE, user: VALUES, verified: OBJECT, created: { type: 'number' } },
};
const MODEL_SCHEMA = {
  type: 'object',
  required: ['id', 'endpoint', 'template', 'user', 'created'],
  properties: { id: ID, endpoint: { type: 'string', minLength: 1 }, template: TEMPLATE, user: VALUES, verified: OBJECT, created: { type: 'number' } },
};
const ROLES_SCHEMA = {
  type: 'object',
  additionalProperties: {
    type: 'object',
    required: ['models', 'level'],
    properties: { models: { type: 'array', items: { type: 'string' } }, level: { enum: LEVELS }, firstOutputSeconds: { type: 'integer', minimum: 1, maximum: 600 } },
  },
};

/** @param {any} schema @param {any} value @param {string} path */
function check(schema, value, path) {
  const errors = validate(schema, value);
  if (errors.length) throw new ValidationError(path, errors);
}

/** @param {string} type @param {{ template?: EndpointRecord['template'], user?: EndpointValues }} [layers] @returns {EndpointRecord} */
export function newEndpoint(type, { template = null, user = {} } = {}, now = Date.now()) {
  return { id: newId('ep'), type, template, user, created: now };
}

/** @param {string} endpoint @param {{ template?: ModelRecord['template'], user?: ModelValues }} [layers] @returns {ModelRecord} */
export function newModel(endpoint, { template = null, user = {} } = {}, now = Date.now()) {
  return { id: newId('m'), endpoint, template, user, created: now };
}

/** The endpoint without the user's changes: plugin defaults, then the template. @param {EndpointRecord} rec @param {Record<string, any>} [tunableDefaults] */
export function endpointBase(rec, tunableDefaults = {}) {
  return { ...ENDPOINT_DEFAULTS, ...mergePatch({ ...ENDPOINT_DEFAULTS, tunables: tunableDefaults }, rec.template?.values ?? {}) };
}

/** The endpoint as calls see it. @param {EndpointRecord} rec @param {Record<string, any>} [tunableDefaults] @returns {Endpoint} */
export function endpointOf(rec, tunableDefaults = {}) {
  const v = { ...ENDPOINT_DEFAULTS, ...mergePatch(endpointBase(rec, tunableDefaults), rec.user ?? {}) };
  return { id: rec.id, type: rec.type, ...v, name: v.name || rec.type };
}

/** The model without the user's changes. @param {ModelRecord} rec */
export function modelBase(rec) {
  return { ...MODEL_DEFAULTS, ...mergePatch(MODEL_DEFAULTS, rec.template?.values ?? {}) };
}

/** The model as calls see it; it is named by its provider id until the user names it. @param {ModelRecord} rec @returns {Model} */
export function modelOf(rec) {
  const v = { ...MODEL_DEFAULTS, ...mergePatch(modelBase(rec), rec.user ?? {}) };
  return { id: rec.id, endpoint: rec.endpoint, ...v, name: v.name || v.providerId };
}

/** The user layer that turns base into edited: only the values that differ. @param {Record<string, any>} edited @param {Record<string, any>} base */
export function diffLayer(edited, base) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(edited)) if (JSON.stringify(v) !== JSON.stringify(base[k])) out[k] = v;
  return out;
}

/** Every endpoint, model and role. Records that aren't valid are skipped. @param {Workspace} ws @returns {Promise<ModelConfig>} */
export async function readConfig(ws) {
  /** @type {ModelConfig} */
  const cfg = { endpoints: {}, models: {}, roles: {} };
  for (const f of await ws.list(SYS_SETTINGS, '/llm/endpoints/')) {
    const rec = await ws.readJSON(SYS_SETTINGS, f.path).catch(() => null);
    if (rec && !validate(ENDPOINT_SCHEMA, rec).length) cfg.endpoints[rec.id] = rec;
  }
  for (const f of await ws.list(SYS_SETTINGS, '/llm/models/')) {
    const rec = await ws.readJSON(SYS_SETTINGS, f.path).catch(() => null);
    if (rec && !validate(MODEL_SCHEMA, rec).length && cfg.endpoints[rec.endpoint]) cfg.models[rec.id] = rec;
  }
  cfg.roles = rolesFrom(await ws.readJSON(SYS_SETTINGS, ROLES_PATH).catch(() => null), cfg.models);
  return cfg;
}

/** Every chat role with its level, keeping only models that exist. @param {any} saved @param {Record<string, ModelRecord>} models @returns {Roles} */
function rolesFrom(saved, models) {
  const s = saved && typeof saved === 'object' ? saved : {};
  /** @type {Roles} */
  const out = {};
  for (const role of new Set([...CHAT_ROLES, ...Object.keys(s)])) {
    const r = s[role] ?? {};
    out[role] = {
      models: (Array.isArray(r.models) ? r.models : []).filter((/** @type {any} */ id) => typeof id === 'string' && models[id]),
      level: LEVELS.includes(r.level) ? r.level : /** @type {Record<string, string>} */ (ROLE_LEVELS)[role] ?? 'off',
      ...(Number.isInteger(r.firstOutputSeconds) && r.firstOutputSeconds >= 1 ? { firstOutputSeconds: r.firstOutputSeconds } : {}),
    };
  }
  return out;
}

/** Saves an endpoint, and any of its models given, in one transaction. @param {Workspace} ws @param {EndpointRecord} rec @param {ModelRecord[]} [models] */
export async function saveEndpoint(ws, rec, models = []) {
  check(ENDPOINT_SCHEMA, rec, endpointPath(rec.id));
  for (const m of models) check(MODEL_SCHEMA, m, modelPath(m.id));
  await ws.writeMany(SYS_SETTINGS, [{ path: endpointPath(rec.id), content: rec }, ...models.map((m) => ({ path: modelPath(m.id), content: m }))], { author: 'user' });
}

/** Saves a model. Its endpoint must exist, and no other model may have its name. @param {Workspace} ws @param {ModelRecord} rec */
export async function saveModel(ws, rec) {
  const path = modelPath(rec.id);
  check(MODEL_SCHEMA, rec, path);
  const cfg = await readConfig(ws);
  if (!cfg.endpoints[rec.endpoint]) throw new ValidationError(path, ['$.endpoint: that endpoint no longer exists']);
  const name = modelOf(rec).name;
  if (!name) throw new ValidationError(path, ["$.providerId: give the provider's model id"]);
  for (const other of Object.values(cfg.models)) {
    if (other.id !== rec.id && modelOf(other).name.toLowerCase() === name.toLowerCase()) {
      throw new ValidationError(path, [`$.name: "${name}" is already used by another model`]);
    }
  }
  await ws.write(SYS_SETTINGS, path, rec, { author: 'user' });
}

/** @param {Workspace} ws @param {Roles} roles */
export async function saveRoles(ws, roles) {
  check(ROLES_SCHEMA, roles, ROLES_PATH);
  await ws.write(SYS_SETTINGS, ROLES_PATH, roles, { author: 'user' });
}

/** @param {Roles} roles @param {Set<string>} gone @returns {Roles} */
function without(roles, gone) {
  return Object.fromEntries(Object.entries(roles).map(([role, r]) => [role, { ...r, models: r.models.filter((id) => !gone.has(id)) }]));
}

/** Removes an endpoint with its models, their places in roles, and its key. @param {Workspace} ws @param {Store} store @param {string} id */
export async function removeEndpoint(ws, store, id) {
  const cfg = await readConfig(ws);
  const gone = new Set(Object.values(cfg.models).filter((m) => m.endpoint === id).map((m) => m.id));
  await ws.writeMany(SYS_SETTINGS, [
    { path: endpointPath(id), content: null },
    ...[...gone].map((m) => ({ path: modelPath(m), content: null })),
    { path: ROLES_PATH, content: without(cfg.roles, gone) },
  ], { author: 'user' });
  await setKey(store, id, null);
}

/** Removes a model and its places in roles. @param {Workspace} ws @param {string} id */
export async function removeModel(ws, id) {
  const cfg = await readConfig(ws);
  await ws.writeMany(SYS_SETTINGS, [{ path: modelPath(id), content: null }, { path: ROLES_PATH, content: without(cfg.roles, new Set([id])) }], { author: 'user' });
}

/** Stores an endpoint's API key, or removes it (null or empty), only in secrets. @param {Store} store @param {string} endpointId @param {string | null} key */
export async function setKey(store, endpointId, key) {
  await store.tx(['secrets'], 'readwrite', async (t) => {
    if (key) await t.putSecret(secretId(endpointId), key);
    else await t.deleteSecret(secretId(endpointId));
  });
}

/** @param {Store} store @param {string} endpointId @returns {Promise<string | null>} */
export async function getKey(store, endpointId) {
  const v = await store.tx(['secrets'], 'readonly', (t) => t.getSecret(secretId(endpointId)));
  return typeof v === 'string' && v ? v : null;
}
```

In `sw.js`, add to `SHELL` after `'/src/core/llm/contract.js',`:

```js
  '/src/core/llm/config.js',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/llm-config.test.js`
Expected: PASS, 8 tests.

If `removeEndpoint` fails while deleting a model file, check how `Workspace.writeMany` treats `content: null` for a path that exists. It must delete it. The test only deletes existing files.

- [ ] **Step 5: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: all green.

```bash
git add src/core/llm/config.js sw.js test/unit/llm-config.test.js
git commit -m "Model settings: endpoints, models and roles in two layers; keys only in secrets"
```

---

### Task 5: Endpoint types are plugins, installed on demand

**Files:**
- Modify: `src/core/llm/contract.js` (add the `EndpointType` types and `endpointTypes()`)
- Modify: `src/core/registry.js` (add `fail()`)
- Modify: `src/core/plugins.js` (add `annai.providers.register` and `annai.helpers`)
- Create: `src/core/llm/official.js`
- Create: `plugins-official/scripted-model/annai-plugin.json` and `plugins-official/scripted-model/index.js`
- Create: `scripts/catalog.mjs`
- Create: `catalog/plugins.json` (generated)
- Modify: `package.json` (scripts), `.github/workflows/ci.yml`, `tsconfig.json` (include `plugins-official`), `sw.js` (`SHELL`)
- Test: `test/unit/llm-plugins.test.js`

**Interfaces:**
- Consumes:
  - `ProviderError` and `errorFromResponse` (Task 1)
  - `sse`, `parsePartialJSON` and `retry` (Task 3)
  - the types `Endpoint` and `Model` (Task 4)
- Produces:
  - **From `contract.js`:**
    - the type `CallSpec`: `{ endpoint, model, key, tunables, request, signal? }`
    - the type `EndpointType`: `{ type, name, pluginId, tunables?, build?, read?, run?, classify?, listRequest?, readList?, list? }`
    - the type `ListedModel`
    - `endpointTypes(registry): Map<string, EndpointType>`
  - **For plugins:**
    - `annai.providers.register(type)` (registry kind `'endpoint-type'`)
    - `annai.helpers`: `{ sse, parsePartialJSON, ProviderError, errorFromResponse, retry }`
  - **From `registry.js`:** `registry.fail(pluginId, name, error)`.
  - **From `official.js`:**
    - `officialPlugins(opts): Promise<CatalogPlugin[]>`
    - `installOfficial(host, entry, opts)`
    - `ensureType(host, type, opts)`, where `opts` is `{ fetch?, base? }`
  - **The `scripted` endpoint type.** Its `script` tunable is a list of steps, used one per call per endpoint; the last step repeats. A step is one of:
    - `{ text?, reasoning?, toolCalls?, usage?, delayMs? }`: a reply
    - `{ error: kind, message?, status?, retryAfter? }`: a failure
    - `{ text, cut: true }`: says the text, then the connection drops

- [ ] **Step 1: Write the failing tests**

Create `test/unit/llm-plugins.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry, PluginError } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { endpointTypes, ProviderError } from '../../src/core/llm/contract.js';
import { ensureType } from '../../src/core/llm/official.js';
import { utf8 } from '../../src/core/bytes.js';

const root = new URL('../../', import.meta.url);

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  // In Node there is no service worker: load installed plugin files from the workspace as data: URLs.
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const host = new PluginHost({ registry, workspace: ws, importModule });
  return { registry, ws, host, importModule };
}

/** A fetch that serves annai's own catalog and official plugin files from this repository. @param {(path: string, bytes: Uint8Array) => Uint8Array} [tamper] */
function repoFetch(tamper = (_p, b) => b) {
  /** @type {string[]} */
  const asked = [];
  const get = async (/** @type {any} */ url) => {
    const path = new URL(String(url), 'http://annai.test').pathname;
    asked.push(path);
    try {
      return new Response(tamper(path, new Uint8Array(await readFile(new URL(`.${path}`, root)))));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  return { get, asked };
}

/** @param {any} type @param {any} spec */
async function events(type, spec) {
  const out = [];
  for await (const e of type.run(spec)) out.push(e);
  return out;
}

test('an official plugin is installed from the catalog only when every file matches it (spec §5.3)', async () => {
  const { host, registry } = await setup();
  const tampered = repoFetch((p, b) => (p.endsWith('/index.js') ? utf8('export function activate() {}') : b));
  await assert.rejects(ensureType(host, 'scripted', { fetch: tampered.get }), (e) => e instanceof PluginError && /doesn't match/.test(e.message));
  assert.equal((await host.installed())['scripted-model'], undefined);
  const real = repoFetch();
  await ensureType(host, 'scripted', { fetch: real.get });
  const type = endpointTypes(registry).get('scripted');
  assert.equal(type?.pluginId, 'scripted-model');
  assert.equal((await host.installed())['scripted-model'].source, 'official');
});

test('ensureType starts an installed plugin instead of downloading it again, and knows no other types', async () => {
  const { host, ws, importModule } = await setup();
  await ensureType(host, 'scripted', { fetch: repoFetch().get });
  const relaunched = new PluginHost({ registry: new Registry(), workspace: ws, importModule });
  const again = repoFetch();
  await ensureType(relaunched, 'scripted', { fetch: again.get });
  assert.deepEqual(again.asked, ['/catalog/plugins.json']);
  assert.ok(endpointTypes(relaunched.registry).has('scripted'));
  await assert.rejects(ensureType(relaunched, 'no-such-type', { fetch: repoFetch().get }), /isn't an endpoint type annai knows/);
});

test('an endpoint type needs build() and read(), or run()', async () => {
  const { host } = await setup();
  const files = new Map([
    ['annai-plugin.json', utf8(JSON.stringify({ id: 'half-type', name: 'Half', version: '1.0.0', api: 1, entry: 'index.js' }))],
    ['index.js', utf8("export function activate(annai) { return annai.providers.register({ type: 'half', build() {} }); }")],
  ]);
  await host.install(files);
  await assert.rejects(host.start('half-type'), /needs build\(\) and read\(\), or run\(\)/);
});

test('the scripted model replies from its script, one step per call, the last one repeating (spec §18)', async () => {
  const { host, registry } = await setup();
  await ensureType(host, 'scripted', { fetch: repoFetch().get });
  const type = endpointTypes(registry).get('scripted');
  const endpoint = { id: 'ep-1', tunables: { script: [{ text: 'Hello there, friend.', reasoning: 'Greet them.' }, { error: 'credit', status: 402 }, { text: 'Kyoto is', cut: true }] } };
  const first = await events(type, { endpoint });
  assert.deepEqual(first.filter((e) => e.type === 'reasoning'), [{ type: 'reasoning', text: 'Greet them.' }]);
  assert.equal(first.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hello there, friend.');
  assert.ok(first.filter((e) => e.type === 'text').length > 1, 'the text arrives in pieces');
  assert.deepEqual(first.at(-1), { type: 'stop', reason: 'end' });
  await assert.rejects(events(type, { endpoint }), (e) => e instanceof Error && e.name === 'ProviderError' && /** @type {any} */ (e).kind === 'credit');
  const cut = [];
  await assert.rejects((async () => { for await (const e of type.run({ endpoint })) cut.push(e); })(), (e) => /** @type {any} */ (e).kind === 'network');
  assert.equal(cut.map((e) => e.text).join(''), 'Kyoto is');
  await assert.rejects(events(type, { endpoint }), (e) => /** @type {any} */ (e).kind === 'network', 'the last step repeats');
  assert.deepEqual(await type.list(), [{ providerId: 'scripted', name: 'Scripted', contextWindow: 200000, maxOutput: 4096, input: ['text', 'image'], tools: true }]);
});

test('the error classes plugins get are the core ones', async () => {
  const { host, registry } = await setup();
  await ensureType(host, 'scripted', { fetch: repoFetch().get });
  const type = endpointTypes(registry).get('scripted');
  await assert.rejects(events(type, { endpoint: { id: 'e', tunables: { script: [{ error: 'auth' }] } } }), ProviderError);
});

test('registry.fail counts a failure found outside guard()', () => {
  /** @type {any[]} */
  const logged = [];
  const r = new Registry({ log: (ev) => logged.push(ev), maxFailures: 2 });
  r.add('p', 'endpoint-type', { type: 'x' });
  r.fail('p', 'reading a stream', new Error('bad chunk'));
  assert.equal(logged[0].type, 'plugin.error');
  r.fail('p', 'reading a stream', new Error('bad chunk'));
  assert.equal(r.isDisabled('p'), true);
  assert.deepEqual(r.list('endpoint-type'), []);
});

test('catalog/plugins.json lists every official plugin', async () => {
  const catalog = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8'));
  const dirs = (await readdir(new URL('plugins-official/', root), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(catalog.plugins.map((/** @type {any} */ p) => p.id).sort(), dirs);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/llm-plugins.test.js`
Expected: FAIL. `contract.js` provides no export named `endpointTypes`.

- [ ] **Step 3: Add the endpoint-type types to the contract**

Append to `src/core/llm/contract.js`:

```js
/**
 * @typedef {object} CallSpec  what an endpoint type is given for one call
 * @property {import('./config.js').Endpoint} endpoint
 * @property {import('./config.js').Model} model
 * @property {string | null} key
 * @property {Record<string, any>} tunables  the endpoint's tunables with the model's over them
 * @property {Request} request
 * @property {AbortSignal} [signal]
 * @typedef {{ providerId: string, name?: string, contextWindow?: number, maxOutput?: number, input?: string[], tools?: boolean,
 *   prices?: import('./cost.js').Prices }} ListedModel
 * @typedef {object} EndpointType  what an endpoint-type plugin registers (spec §9.1)
 * @property {string} type  its id, e.g. "chat-completions"
 * @property {string} name  shown in Settings
 * @property {string} pluginId  set by annai
 * @property {Record<string, any>} [tunables]  defaults for the type's tunables (spec §9.2)
 * @property {(c: CallSpec) => { url: string, headers: Record<string, string>, body: any }} [build]  the HTTP request for annai's request
 * @property {(res: Response, c: CallSpec) => AsyncIterable<StreamEvent>} [read]  the events of a successful streamed response
 * @property {(c: CallSpec) => AsyncIterable<StreamEvent>} [run]  instead of build and read, for types that need no network
 * @property {(status: number, body: string) => ErrorKind | null} [classify]  a sharper kind for an error response, or null
 * @property {(c: { endpoint: import('./config.js').Endpoint, key: string | null }) => { url: string, headers: Record<string, string> }} [listRequest]
 * @property {(json: any) => ListedModel[]} [readList]
 * @property {(c: { endpoint: import('./config.js').Endpoint, key: string | null }) => Promise<ListedModel[]>} [list]  for types with run
 */

/**
 * The endpoint types running plugins provide, by type id; the first plugin to provide a type wins.
 * @param {import('../registry.js').Registry} registry @returns {Map<string, EndpointType>}
 */
export function endpointTypes(registry) {
  /** @type {Map<string, EndpointType>} */
  const out = new Map();
  for (const t of registry.list('endpoint-type')) if (!out.has(t.type)) out.set(t.type, t);
  return out;
}
```

- [ ] **Step 4: Give plugins `providers` and `helpers`, and the registry `fail()`**

In `src/core/registry.js`, add this method to `Registry`, right after `enable()`:

```js
  /** Counts a failure of a plugin's code that annai caught outside guard(), e.g. while reading a stream. @param {string} pluginId @param {string} name @param {unknown} e */
  fail(pluginId, name, e) {
    this.#fail(pluginId, name, e);
  }
```

In `src/core/plugins.js`, add these imports below the existing ones:

```js
import { ProviderError, errorFromResponse } from './llm/contract.js';
import { sse } from './llm/sse.js';
import { parsePartialJSON } from './llm/partial-json.js';
import { retry } from './llm/retry.js';
```

Below `const STATE = '/installed.json';`, add:

```js
/** Shared helpers every plugin gets (spec §5.4, §9.1). */
const HELPERS = Object.freeze({ sse, parsePartialJSON, ProviderError, errorFromResponse, retry });
```

In `#api(id)`, add two entries to the frozen object, after `events`:

```js
      providers: Object.freeze({
        /** An endpoint type (spec §9.1): build() and read(), or run() for types that need no network. */
        register: (/** @type {any} */ type) => {
          if (typeof type?.type !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(type.type)) {
            throw new PluginError(id, 'an endpoint type needs a "type" id of lowercase letters, digits and dashes');
          }
          if (typeof type.run !== 'function' && (typeof type.build !== 'function' || typeof type.read !== 'function')) {
            throw new PluginError(id, `the endpoint type "${type.type}" needs build() and read(), or run()`);
          }
          return registry.add(id, 'endpoint-type', Object.freeze({ ...type, name: String(type.name ?? type.type), pluginId: id }));
        },
      }),
      helpers: HELPERS,
```

- [ ] **Step 5: Write the scripted model plugin**

Create `plugins-official/scripted-model/annai-plugin.json`:

```json
{
  "id": "scripted-model",
  "name": "Scripted model",
  "version": "0.1.0",
  "api": 1,
  "entry": "index.js",
  "description": "A model that replies from a script, for tests and plugin authors. It never uses the network.",
  "provides": { "endpoint-type": ["scripted"] }
}
```

Create `plugins-official/scripted-model/index.js`:

```js
/**
 * The scripted fake model (spec §18): an endpoint type that replies from a script instead of the
 * network, for deterministic, free tests. The script is the endpoint's `script` tunable, a list of
 * steps used one per call (the last one repeats):
 *   { text, reasoning, toolCalls: [{ name, input }], usage, delayMs }   a reply
 *   { error: kind, message, status, retryAfter }                        a failure (spec §9.9 kinds)
 *   { text, cut: true }                                                 says text, then the connection drops
 * @param {any} annai
 */
export function activate(annai) {
  const { ProviderError } = annai.helpers;
  /** @type {Map<string, number>} calls so far, by endpoint */
  const calls = new Map();
  return annai.providers.register({
    type: 'scripted',
    name: 'Scripted model (for testing)',
    tunables: { script: [{ text: 'Hello from the scripted model.' }] },
    /** @param {{ endpoint: any, signal?: AbortSignal }} c */
    async *run({ endpoint, signal }) {
      const script = Array.isArray(endpoint.tunables?.script) && endpoint.tunables.script.length ? endpoint.tunables.script : [{ text: '' }];
      const n = calls.get(endpoint.id) ?? 0;
      calls.set(endpoint.id, n + 1);
      const step = script[Math.min(n, script.length - 1)] ?? {};
      if (step.delayMs) await sleep(step.delayMs, signal);
      if (step.error) throw new ProviderError(step.error, step.message ?? `Scripted ${step.error}.`, { status: step.status, retryAfter: step.retryAfter });
      if (step.reasoning) yield { type: 'reasoning', text: step.reasoning };
      for (const piece of pieces(step.text ?? '')) yield { type: 'text', text: piece };
      if (step.cut) throw new ProviderError('network', 'The scripted connection dropped.');
      const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
      for (const [i, c] of toolCalls.entries()) yield { type: 'tool_call', id: `scripted_${n}_${i}`, name: c.name, input: c.input ?? {} };
      yield { type: 'usage', usage: step.usage ?? { input: 12, output: 6 } };
      yield { type: 'stop', reason: toolCalls.length ? 'tool' : 'end' };
    },
    async list() {
      return [{ providerId: 'scripted', name: 'Scripted', contextWindow: 200000, maxOutput: 4096, input: ['text', 'image'], tools: true }];
    },
  });
}

/** Text in pieces of 8 characters, as a stream would bring it. @param {string} text */
function pieces(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 8) out.push(text.slice(i, i + 8));
  return out;
}

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}
```

- [ ] **Step 6: Write the catalog script, and generate the catalog**

Create `scripts/catalog.mjs`:

```js
// Writes catalog/plugins.json from plugins-official/: each official plugin's id, name, version,
// what it provides and the SHA-256 of every file, which annai checks before installing (spec §5.3).
// With --check it only says whether the committed catalog is current (npm run check, CI).
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'plugins-official');
const out = join(root, 'catalog', 'plugins.json');

/** Every file under d, as paths relative to it, in a stable order. @param {string} d @param {string} [prefix] @returns {Promise<string[]>} */
async function files(d, prefix = '') {
  /** @type {string[]} */
  const list = [];
  for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isDirectory()) list.push(...(await files(join(d, e.name), `${prefix}${e.name}/`)));
    else list.push(`${prefix}${e.name}`);
  }
  return list;
}

const plugins = [];
for (const e of (await readdir(dir, { withFileTypes: true })).filter((x) => x.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
  const base = join(dir, e.name);
  const manifest = JSON.parse(await readFile(join(base, 'annai-plugin.json'), 'utf8'));
  if (manifest.id !== e.name) throw new Error(`plugins-official/${e.name}: its annai-plugin.json says the id is "${manifest.id}"`);
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const f of await files(base)) hashes[f] = createHash('sha256').update(await readFile(join(base, f))).digest('hex');
  plugins.push({ id: manifest.id, name: manifest.name, version: manifest.version, provides: manifest.provides ?? {}, files: hashes });
}
const text = JSON.stringify({ format: 1, plugins }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if ((await readFile(out, 'utf8').catch(() => '')) !== text) {
    console.error('catalog/plugins.json is stale: run npm run catalog');
    process.exit(1);
  }
  console.log('catalog/plugins.json is current');
} else {
  await writeFile(out, text);
  console.log(`catalog/plugins.json: ${plugins.length} plugin(s)`);
}
```

In `package.json`, add a `catalog` script, and make `check` also verify the catalog:

```json
    "catalog": "node scripts/catalog.mjs",
    "check": "npm run typecheck && npm test && npm run size && node scripts/stamp.mjs --check && node scripts/catalog.mjs --check"
```

In `.github/workflows/ci.yml`, add this step after `- run: node scripts/stamp.mjs --check`:

```yaml
      - run: node scripts/catalog.mjs --check
```

In `tsconfig.json`, change `include` to:

```json
  "include": ["src/**/*.js", "plugins-official/**/*.js", "scripts/**/*.mjs", "playwright.config.js"]
```

Create the catalog directory, then generate the catalog:

```bash
mkdir -p catalog && npm run catalog
```

Expected: `catalog/plugins.json: 1 plugin(s)`.

- [ ] **Step 7: Write official.js**

Create `src/core/llm/official.js`:

```js
import { sha256Hex } from '../hash.js';
import { PluginError } from '../registry.js';
import { endpointTypes } from './contract.js';

/**
 * annai's official on-demand plugins (spec §5.3, §9.1): listed in /catalog/plugins.json with the
 * SHA-256 of every file, fetched from /plugins-official/<id>/ on annai's own origin, checked, then
 * installed like any plugin. Choosing an endpoint type whose plugin is missing installs it.
 * @typedef {import('../plugins.js').PluginHost} PluginHost
 * @typedef {{ id: string, name: string, version: string, provides: Record<string, string[]>, files: Record<string, string> }} CatalogPlugin
 * @typedef {{ fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string }} FetchOptions
 */

const defaultFetch = (/** @type {string} */ url, /** @type {RequestInit | undefined} */ init) => fetch(url, init);

/** @param {FetchOptions} [opts] @returns {Promise<CatalogPlugin[]>} */
export async function officialPlugins({ fetch: get = defaultFetch, base = '' } = {}) {
  /** @type {Response} */
  let res;
  try {
    res = await get(`${base}/catalog/plugins.json`, { cache: 'no-cache' });
  } catch {
    throw new PluginError('catalog', "annai's list of plugins couldn't be loaded. Check the connection and try again.");
  }
  if (!res.ok) throw new PluginError('catalog', `annai's list of plugins couldn't be loaded (HTTP ${res.status}). Try again later.`);
  const json = await res.json();
  return Array.isArray(json?.plugins) ? json.plugins : [];
}

/**
 * Downloads, checks and installs one official plugin, then starts it. Nothing is stored unless
 * every file matches the catalog.
 * @param {PluginHost} host @param {CatalogPlugin} entry @param {FetchOptions} [opts]
 */
export async function installOfficial(host, entry, { fetch: get = defaultFetch, base = '' } = {}) {
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const [name, hash] of Object.entries(entry.files)) {
    const url = `${base}/plugins-official/${encodeURIComponent(entry.id)}/${name.split('/').map(encodeURIComponent).join('/')}`;
    /** @type {Response} */
    let res;
    try {
      res = await get(url, { cache: 'no-cache' });
    } catch {
      throw new PluginError(entry.id, "couldn't be downloaded. Check the connection and try again.");
    }
    if (!res.ok) throw new PluginError(entry.id, `couldn't be downloaded (${name}: HTTP ${res.status}). Try again later.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(bytes)) !== hash) throw new PluginError(entry.id, `wasn't installed: ${name} doesn't match annai's catalog`);
    files.set(name, bytes);
  }
  await host.install(files, { source: 'official' });
  await host.start(entry.id);
}

/**
 * Makes an endpoint type available. Nothing to do when a running plugin provides it. Otherwise it
 * starts the installed official plugin that provides it, or installs the catalog's version.
 * @param {PluginHost} host @param {string} type @param {FetchOptions} [opts]
 */
export async function ensureType(host, type, opts = {}) {
  if (endpointTypes(host.registry).has(type)) return;
  const entry = (await officialPlugins(opts)).find((p) => p.provides?.['endpoint-type']?.includes(type));
  if (!entry) throw new PluginError(type, "isn't an endpoint type annai knows. Install a plugin that provides it.");
  const state = (await host.installed())[entry.id];
  if (state && state.version === entry.version) {
    if (!state.enabled) await host.setEnabled(entry.id, true);
    else await host.start(entry.id);
  } else {
    await installOfficial(host, entry, opts);
  }
  if (!endpointTypes(host.registry).has(type)) throw new PluginError(entry.id, `didn't provide the endpoint type ${type}`);
}
```

In `sw.js`, add to `SHELL` after `'/src/core/llm/contract.js',`:

```js
  '/src/core/llm/official.js',
```

The order there doesn't matter (the test sorts), but keep the `llm` files together.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test test/unit/llm-plugins.test.js test/unit/plugins.test.js`
Expected: PASS. The 7 new tests pass, and the existing plugin tests still pass.

- [ ] **Step 9: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: all green, including `catalog/plugins.json is current`.

```bash
git add src/core/llm/contract.js src/core/llm/official.js src/core/registry.js src/core/plugins.js plugins-official/scripted-model catalog/plugins.json scripts/catalog.mjs package.json .github/workflows/ci.yml tsconfig.json sw.js test/unit/llm-plugins.test.js
git commit -m "Endpoint types are plugins: providers.register, helpers, the scripted model, on-demand install"
```

---

### Task 6: The Chat Completions endpoint type

**Files:**
- Create: `plugins-official/chat-completions/annai-plugin.json`, `plugins-official/chat-completions/index.js`
- Create: `test/fixtures/llm/chat-completions/text.sse`, `tools.sse`, `error-midstream.sse`, `cut.sse`, `models-openrouter.json`
- Modify: `catalog/plugins.json` (regenerate)
- Test: `test/unit/llm-chat-completions.test.js`

**Interfaces:**
- Consumes:
  - `EndpointType` and `CallSpec` (Task 5)
  - the helpers `sse`, `ProviderError` and `errorFromResponse`
- Produces: the endpoint type `chat-completions`. Its tunables and their defaults:
  - `path`: `'/chat/completions'`
  - `maxTokensField`: `'max_tokens'`. OpenAI's newer models want `'max_completion_tokens'`.
  - `systemRole`: `'system'`, or `'developer'`.
  - `usageInStream`: `true`
  - `reasoningField`: `'auto'`, or `'reasoning'` (OpenRouter), or `'reasoning_content'` (DeepSeek).
  - `imageDetail`: `null`

It works with OpenAI, OpenRouter, Gemini's OpenAI-compatible endpoint, Groq, DeepSeek, Mistral and local servers.

- [ ] **Step 1: Write the fixtures**

These follow the providers' documented stream formats. `text.sse` is OpenRouter's, with a keep-alive comment and the cost in its usage.

Create `test/fixtures/llm/chat-completions/text.sse` (it ends with an empty line):

```
: OPENROUTER PROCESSING

data: {"id":"gen-1","object":"chat.completion.chunk","model":"anthropic/claude-haiku-5.5","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"gen-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning":"The user greets me. "},"finish_reason":null}]}

data: {"id":"gen-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning":"Reply warmly."},"finish_reason":null}]}

data: {"id":"gen-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"こんにちは! "},"finish_reason":null}]}

data: {"id":"gen-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Welcome to Kyoto."},"finish_reason":"stop"}]}

data: {"id":"gen-1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":40,"total_tokens":1240,"prompt_tokens_details":{"cached_tokens":1000},"completion_tokens_details":{"reasoning_tokens":12},"cost":0.000125}}

data: [DONE]

```

Create `test/fixtures/llm/chat-completions/tools.sse`:

```
data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"report_color","arguments":""}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"col"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"or\":\"red\"}"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":300,"completion_tokens":20}}

data: [DONE]

```

Create `test/fixtures/llm/chat-completions/error-midstream.sse`. This is how OpenRouter reports a provider failure after the reply started:

```
data: {"choices":[{"index":0,"delta":{"content":"Kyoto is"},"finish_reason":null}]}

data: {"error":{"code":502,"message":"Provider returned error"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}

```

Create `test/fixtures/llm/chat-completions/cut.sse`. This stream ends with no `finish_reason` and no `[DONE]`:

```
data: {"choices":[{"index":0,"delta":{"content":"Kyoto is"},"finish_reason":null}]}

```

Create `test/fixtures/llm/chat-completions/models-openrouter.json`. These are two entries trimmed from `GET https://openrouter.ai/api/v1/models` on 2026-10-15:

```json
{
  "data": [
    {
      "id": "anthropic/claude-haiku-5.5",
      "name": "Anthropic: Claude Haiku 5.5",
      "context_length": 1000000,
      "architecture": { "modality": "text+image+file->text", "input_modalities": ["text", "image", "file"], "output_modalities": ["text"] },
      "pricing": {
        "prompt": "0.0000001", "completion": "0.0000005", "web_search": "0.01",
        "input_cache_read": "0.00000001", "input_cache_write": "0.000000125", "input_cache_write_1h": "0.0000002",
        "overrides": [{ "min_prompt_tokens": 100000, "prompt": "0.0000005", "completion": "0.0000025", "input_cache_read": "0.00000005", "input_cache_write": "0.000000625", "input_cache_write_1h": "0.000001" }]
      },
      "top_provider": { "context_length": 1000000, "max_completion_tokens": 128000, "is_moderated": true },
      "supported_parameters": ["include_reasoning", "max_completion_tokens", "max_tokens", "reasoning", "reasoning_effort", "response_format", "stop", "structured_outputs", "tool_choice", "tools", "verbosity"]
    },
    {
      "id": "google/gemma-4-31b-it:free",
      "name": "Google: Gemma 4 31B (free)",
      "context_length": 262144,
      "architecture": { "input_modalities": ["image", "text", "video"], "output_modalities": ["text"] },
      "pricing": { "prompt": "0", "completion": "0" },
      "top_provider": { "context_length": 262144, "max_completion_tokens": 32768 },
      "supported_parameters": ["max_tokens", "reasoning", "tools"]
    }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/unit/llm-chat-completions.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activate } from '../../plugins-official/chat-completions/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';

/** The endpoint type, registered the way annai's plugin host would. @returns {any} */
function load() {
  /** @type {any} */
  let type = null;
  activate({ providers: { register: (/** @type {any} */ t) => { type = t; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return type;
}
const type = load();
const fixture = (/** @type {string} */ name) => readFile(new URL(`../fixtures/llm/chat-completions/${name}`, import.meta.url), 'utf8');
/** A spec for one call. @param {any} [over] */
function spec(over = {}) {
  const endpoint = { id: 'ep-1', type: 'chat-completions', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1/', headers: { 'X-Title': 'annai' }, tunables: { ...type.tunables }, extraBody: {} };
  const model = { id: 'm-1', endpoint: 'ep-1', name: 'Haiku', providerId: 'anthropic/claude-haiku-5.5', input: ['text', 'image'], tools: true, contextWindow: 1000000, maxOutput: 8000, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {} };
  return { endpoint, model, key: 'sk-or-test', tunables: { ...type.tunables }, request: { messages: [] }, ...over };
}
/** @param {string} text @param {any} [s] */
async function read(text, s = spec()) {
  const out = [];
  for await (const e of type.read(new Response(text), s)) out.push(e);
  return out;
}

test('build: annai’s request as an OpenAI-style chat completion', () => {
  const s = spec({
    request: {
      system: 'Be brief.',
      maxOutput: 500,
      tools: [{ name: 'report_color', description: 'Report a color.', input: { type: 'object', properties: { color: { type: 'string' } } } }],
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'What color?' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
        { role: 'assistant', parts: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_call', id: 'call_1', name: 'report_color', input: { color: 'red' } }] },
        { role: 'user', parts: [{ type: 'tool_result', id: 'call_1', content: 'noted' }, { type: 'text', text: 'Thanks' }] },
      ],
    },
  });
  const { url, headers, body } = type.build(s);
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.deepEqual(headers, { 'content-type': 'application/json', authorization: 'Bearer sk-or-test', 'X-Title': 'annai' });
  assert.equal(body.model, 'anthropic/claude-haiku-5.5');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 500);
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'report_color', description: 'Report a color.', parameters: { type: 'object', properties: { color: { type: 'string' } } } } }]);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: [{ type: 'text', text: 'What color?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'report_color', arguments: '{"color":"red"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'noted' },
    { role: 'user', content: 'Thanks' },
  ]);
});

test('build: the tunables for OpenAI and for endpoints without usage in streams or a key', () => {
  const tunables = { ...type.tunables, maxTokensField: 'max_completion_tokens', systemRole: 'developer', usageInStream: false, imageDetail: 'high' };
  const s = spec({ key: null, tunables, request: { system: 'S', messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/jpeg', data: 'BBBB' }] }] } });
  const { headers, body } = type.build(s);
  assert.equal(headers.authorization, undefined);
  assert.equal(body.max_completion_tokens, 8000, "the model's maximum output, when the request sets none");
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.stream_options, undefined);
  assert.deepEqual(body.messages[0], { role: 'developer', content: 'S' });
  assert.deepEqual(body.messages[1].content, [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB', detail: 'high' } }]);
});

test('read: text, reasoning, usage with cache reads and reported cost, and the stop reason', async () => {
  const events = await read(await fixture('text.sse'));
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'The user greets me. Reply warmly.' },
    { type: 'text', text: 'こんにちは! ' },
    { type: 'text', text: 'Welcome to Kyoto.' },
    { type: 'usage', usage: { input: 200, cacheRead: 1000, cacheWrite: 0, output: 40, reasoning: 12, cost: 0.000125 } },
    { type: 'stop', reason: 'end' },
  ]);
});

test('read: a streamed tool call, its arguments as they arrive, then the whole call', async () => {
  const events = await read(await fixture('tools.sse'));
  assert.deepEqual(events.filter((e) => e.type === 'tool_input').map((e) => e.partial), ['', '{"col', '{"color":"red"}']);
  assert.deepEqual(events.filter((e) => e.type === 'tool_call'), [{ type: 'tool_call', id: 'call_abc', name: 'report_color', input: { color: 'red' } }]);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'tool' });
});

test('read: an error inside the stream becomes a ProviderError of the right kind', async () => {
  const seen = [];
  await assert.rejects((async () => { for await (const e of type.read(new Response(await fixture('error-midstream.sse')), spec())) seen.push(e); })(),
    (e) => e instanceof ProviderError && e.kind === 'server' && /Provider returned error/.test(e.message));
  assert.deepEqual(seen, [{ type: 'text', text: 'Kyoto is' }]);
});

test('a stream that ends early is a network error', async () => {
  await assert.rejects(read(await fixture('cut.sse')), (e) => e instanceof ProviderError && e.kind === 'network');
});

test('classify: OpenAI-style error codes', () => {
  const body = (/** @type {string} */ code) => JSON.stringify({ error: { message: 'x', code } });
  assert.equal(type.classify(400, body('context_length_exceeded')), 'context');
  assert.equal(type.classify(429, body('insufficient_quota')), 'credit');
  assert.equal(type.classify(401, body('invalid_api_key')), 'auth');
  assert.equal(type.classify(404, body('model_not_found')), 'not-found');
  assert.equal(type.classify(400, body('something_else')), null);
  assert.equal(type.classify(500, 'not json'), null);
});

test("list: OpenRouter's model list becomes models with windows, inputs, tools and prices per million tokens", async () => {
  const { url, headers } = type.listRequest({ endpoint: spec().endpoint, key: 'sk-or-test' });
  assert.equal(url, 'https://openrouter.ai/api/v1/models');
  assert.equal(headers.authorization, 'Bearer sk-or-test');
  const models = type.readList(JSON.parse(await fixture('models-openrouter.json')));
  assert.deepEqual(models[0], {
    providerId: 'anthropic/claude-haiku-5.5', name: 'Anthropic: Claude Haiku 5.5', contextWindow: 1000000, maxOutput: 128000, input: ['text', 'image'], tools: true,
    prices: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2, tiers: [{ above: 99999, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 }] },
  });
  assert.deepEqual(models[1].prices, { input: 0, output: 0 });
  assert.deepEqual(type.readList({ data: [{ id: 'gpt-x', object: 'model' }] }), [{ providerId: 'gpt-x' }]);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test test/unit/llm-chat-completions.test.js`
Expected: FAIL. The module can't be found: `Cannot find module …/plugins-official/chat-completions/index.js`.

- [ ] **Step 4: Write the plugin**

Create `plugins-official/chat-completions/annai-plugin.json`:

```json
{
  "id": "chat-completions",
  "name": "Chat Completions",
  "version": "0.1.0",
  "api": 1,
  "entry": "index.js",
  "description": "Talks to OpenAI-style chat completion endpoints: OpenAI, OpenRouter, Gemini, Groq, DeepSeek, Mistral and local servers.",
  "provides": { "endpoint-type": ["chat-completions"] }
}
```

Create `plugins-official/chat-completions/index.js`:

```js
/**
 * The Chat Completions endpoint type (spec §9.1): annai's request in, an OpenAI-style streamed
 * chat completion out. Used by OpenAI, OpenRouter, Gemini's OpenAI-compatible endpoint, Groq,
 * DeepSeek, Mistral and local servers; their differences are tunables (spec §9.2).
 */
const TUNABLES = Object.freeze({
  path: '/chat/completions',
  maxTokensField: 'max_tokens', // OpenAI's newer models want "max_completion_tokens"
  systemRole: 'system', // or "developer"
  usageInStream: true, // ask for usage in the stream (stream_options.include_usage)
  reasoningField: 'auto', // where reasoning text comes back: "reasoning" (OpenRouter), "reasoning_content" (DeepSeek), or either
  imageDetail: null, // e.g. "high"
});
const STOP = /** @type {Record<string, string>} */ ({ stop: 'end', tool_calls: 'tool', function_call: 'tool', length: 'length', content_filter: 'refusal' });
const CODES = /** @type {Record<string, string>} */ ({ context_length_exceeded: 'context', insufficient_quota: 'credit', invalid_api_key: 'auth', model_not_found: 'not-found' });

/** @param {any} annai */
export function activate(annai) {
  const { sse, ProviderError, errorFromResponse } = annai.helpers;
  return annai.providers.register({
    type: 'chat-completions',
    name: 'Chat Completions',
    tunables: TUNABLES,
    /** @param {any} c */
    build: (c) => build(c),
    /** @param {Response} res @param {any} c */
    read: (res, c) => read(res, c, { sse, ProviderError, errorFromResponse }),
    classify,
    /** @param {{ endpoint: any, key: string | null }} c */
    listRequest: ({ endpoint, key }) => ({ url: join(endpoint.baseUrl, '/models'), headers: auth(endpoint, key) }),
    readList,
  });
}

/** @param {string} base @param {string} path */
const join = (base, path) => String(base).replace(/\/+$/, '') + path;

/** @param {any} endpoint @param {string | null} key @returns {Record<string, string>} */
function auth(endpoint, key) {
  return { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(endpoint.headers ?? {}) };
}

/** @param {any} c */
function build({ endpoint, model, key, tunables: t, request }) {
  /** @type {any[]} */
  const messages = [];
  if (request.system) messages.push({ role: t.systemRole, content: request.system });
  for (const m of request.messages) messages.push(...wire(m, t));
  /** @type {Record<string, any>} */
  const body = { model: model.providerId, messages, stream: true };
  if (t.usageInStream) body.stream_options = { include_usage: true };
  const max = request.maxOutput ?? model.maxOutput;
  if (max) body[t.maxTokensField] = max;
  if (request.tools?.length) {
    body.tools = request.tools.map((/** @type {any} */ x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.input } }));
  }
  return { url: join(endpoint.baseUrl, t.path), headers: { 'content-type': 'application/json', ...auth(endpoint, key) }, body };
}

/** One of annai's messages as chat messages: tool results become "tool" messages ahead of the rest. @param {any} m @param {any} t */
function wire(m, t) {
  if (m.role === 'assistant') {
    const text = m.parts.filter((/** @type {any} */ p) => p.type === 'text').map((/** @type {any} */ p) => p.text).join('');
    const calls = m.parts.filter((/** @type {any} */ p) => p.type === 'tool_call');
    /** @type {any} */
    const out = { role: 'assistant', content: text || null };
    if (calls.length) out.tool_calls = calls.map((/** @type {any} */ c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
    return [out];
  }
  const results = m.parts.filter((/** @type {any} */ p) => p.type === 'tool_result').map((/** @type {any} */ p) => ({ role: 'tool', tool_call_id: p.id, content: p.content }));
  const rest = m.parts.filter((/** @type {any} */ p) => p.type === 'text' || p.type === 'image');
  if (!rest.length) return results;
  const content = rest.every((/** @type {any} */ p) => p.type === 'text')
    ? rest.map((/** @type {any} */ p) => p.text).join('\n')
    : rest.map((/** @type {any} */ p) => (p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}`, ...(t.imageDetail ? { detail: t.imageDetail } : {}) } }));
  return [...results, { role: 'user', content }];
}

/**
 * The events of a streamed chat completion. Reasoning is gathered into one block, given before the
 * first text or tool call; tool calls are given whole at the end, with their arguments as they arrive.
 * @param {Response} res @param {any} c @param {any} helpers
 */
async function* read(res, { tunables: t }, { sse, ProviderError, errorFromResponse }) {
  /** @type {Map<number, { id: string, name: string, args: string }>} */
  const calls = new Map();
  let reasoning = '';
  /** @type {string | null} */
  let finish = null;
  let done = false;
  const flush = () => {
    const r = reasoning;
    reasoning = '';
    return r ? [{ type: 'reasoning', text: r }] : [];
  };
  for await (const { data } of sse(/** @type {ReadableStream<Uint8Array>} */ (res.body))) {
    if (data === '[DONE]') {
      done = true;
      break;
    }
    /** @type {any} */
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      const e = errorFromResponse(typeof chunk.error.code === 'number' ? chunk.error.code : 500, JSON.stringify({ error: chunk.error }));
      const sharper = classify(e.status ?? 500, JSON.stringify({ error: chunk.error }));
      throw new ProviderError(sharper ?? e.kind, e.message, { status: e.status });
    }
    const choice = chunk.choices?.[0];
    const d = choice?.delta ?? {};
    const r = t.reasoningField === 'auto' ? d.reasoning_content ?? d.reasoning : d[t.reasoningField];
    if (typeof r === 'string') reasoning += r;
    if (typeof d.content === 'string' && d.content) {
      yield* flush();
      yield { type: 'text', text: d.content };
    }
    for (const tc of d.tool_calls ?? []) {
      yield* flush();
      const i = tc.index ?? 0;
      const cur = calls.get(i) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name && !cur.name) cur.name = tc.function.name;
      if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
      calls.set(i, cur);
      yield { type: 'tool_input', id: cur.id, name: cur.name, partial: cur.args };
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (chunk.usage) yield { type: 'usage', usage: usageOf(chunk.usage) };
  }
  if (!done && !finish) throw new ProviderError('network', 'The reply stopped before it finished.');
  yield* flush();
  for (const [i, c] of [...calls].sort((a, b) => a[0] - b[0])) {
    yield { type: 'tool_call', id: c.id || `call_${i}`, name: c.name, input: parseArgs(c.args) };
  }
  yield { type: 'stop', reason: STOP[finish ?? 'stop'] ?? 'other' };
}

/** A tool call's arguments; the raw text when they aren't valid JSON, for the tool to refuse. @param {string} args */
function parseArgs(args) {
  try {
    return JSON.parse(args || '{}');
  } catch {
    return args;
  }
}

/** Chat Completions usage, normalized: input leaves out cached tokens. @param {any} u */
function usageOf(u) {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const written = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    input: Math.max(0, (u.prompt_tokens ?? 0) - cached - written),
    cacheRead: cached,
    cacheWrite: written,
    output: u.completion_tokens ?? 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
    ...(typeof u.cost === 'number' ? { cost: u.cost } : {}),
  };
}

/** A sharper kind for an OpenAI-style error code, or null. @param {number} _status @param {string} body */
function classify(_status, body) {
  try {
    const e = JSON.parse(body)?.error;
    return CODES[String(e?.code ?? e?.type ?? '')] ?? null;
  } catch {
    return null;
  }
}

/** USD per token, as OpenRouter writes it, to USD per million tokens. @param {any} v */
const perMillion = (v) => (v === undefined || v === null || v === '' ? undefined : Number((Number(v) * 1e6).toPrecision(6)));

/** @param {any} p */
function pricesOf(p) {
  if (!p) return undefined;
  /** @type {Record<string, any>} */
  const out = { input: perMillion(p.prompt), output: perMillion(p.completion) };
  const extra = { cacheRead: p.input_cache_read, cacheWrite: p.input_cache_write, cacheWrite1h: p.input_cache_write_1h };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = perMillion(v);
  if (Array.isArray(p.overrides) && p.overrides.length) {
    out.tiers = p.overrides.map((/** @type {any} */ o) => {
      /** @type {Record<string, any>} */
      const tier = { above: (o.min_prompt_tokens ?? 1) - 1 };
      const pairs = { input: o.prompt, output: o.completion, cacheRead: o.input_cache_read, cacheWrite: o.input_cache_write, cacheWrite1h: o.input_cache_write_1h };
      for (const [k, v] of Object.entries(pairs)) if (v !== undefined) tier[k] = perMillion(v);
      return tier;
    });
  }
  return out;
}

/** The models an endpoint lists. OpenRouter's list says much more than OpenAI's, which gives ids only. @param {any} json */
function readList(json) {
  return (Array.isArray(json?.data) ? json.data : []).filter((/** @type {any} */ m) => typeof m?.id === 'string').map((/** @type {any} */ m) => {
    /** @type {Record<string, any>} */
    const out = { providerId: m.id };
    if (m.name) out.name = m.name;
    const window = m.context_length ?? m.top_provider?.context_length;
    if (window) out.contextWindow = window;
    if (m.top_provider?.max_completion_tokens) out.maxOutput = m.top_provider.max_completion_tokens;
    const kinds = m.architecture?.input_modalities;
    if (Array.isArray(kinds)) out.input = ['text', 'image'].filter((k) => kinds.includes(k));
    if (Array.isArray(m.supported_parameters)) out.tools = m.supported_parameters.includes('tools');
    const prices = pricesOf(m.pricing);
    if (prices) out.prices = prices;
    return out;
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/llm-chat-completions.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 6: Regenerate the catalog, check, commit**

Run: `npm run catalog && npm run check`
Expected: `catalog/plugins.json: 2 plugin(s)`, then all green. `sw.js` doesn't change, because plugins aren't shipped files.

```bash
git add plugins-official/chat-completions catalog/plugins.json test/fixtures/llm/chat-completions test/unit/llm-chat-completions.test.js
git commit -m "Chat Completions endpoint type: OpenAI, OpenRouter, Gemini, Groq, DeepSeek, Mistral, local"
```

---

### Task 7: The Anthropic Messages endpoint type

**Files:**
- Create: `plugins-official/anthropic-messages/annai-plugin.json`, `plugins-official/anthropic-messages/index.js`
- Create: `test/fixtures/llm/anthropic/text.sse`, `thinking-tools.sse`, `error.sse`, `cut.sse`
- Modify: `catalog/plugins.json` (regenerate)
- Test: `test/unit/llm-anthropic.test.js`

**Interfaces:**
- Consumes: the same as Task 6.
- Produces: the endpoint type `anthropic-messages`. Its tunables and their defaults:
  - `path`: `'/v1/messages'`
  - `version`: `'2023-06-01'`
  - `browserAccess`: `true`, which sends `anthropic-dangerous-direct-browser-access`
  - `beta`: `''`, the value of `anthropic-beta`
  - `defaultMaxTokens`: `8192`

  With `request.cacheTtl`, it places `cache_control` on the system prompt and on the last block of the last message.

- [ ] **Step 1: Write the fixtures**

These follow Anthropic's documented stream format. `text.sse` is also the reply in this milestone's browser test.

Create `test/fixtures/llm/anthropic/text.sse`:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-haiku-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":50,"cache_creation_input_tokens":2000,"cache_read_input_tokens":8000,"cache_creation":{"ephemeral_5m_input_tokens":1500,"ephemeral_1h_input_tokens":500},"output_tokens":1}}}

event: ping
data: {"type":"ping"}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from "}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"B."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":7}}

event: message_stop
data: {"type":"message_stop"}

```

Create `test/fixtures/llm/anthropic/thinking-tools.sse`:

```
event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":300,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"A red square. "}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Call the tool."}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCgIYAh=="}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"EmwKAhgBEgy3"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: content_block_start
data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_01A","name":"report_color","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"color\": \"re"}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"d\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":2}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}

event: message_stop
data: {"type":"message_stop"}

```

Create `test/fixtures/llm/anthropic/error.sse`:

```
event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Kyoto is"}}

event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}

```

Create `test/fixtures/llm/anthropic/cut.sse`:

```
event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Kyoto is"}}

```

- [ ] **Step 2: Write the failing tests**

Create `test/unit/llm-anthropic.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activate } from '../../plugins-official/anthropic-messages/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';

/** @returns {any} */
function load() {
  /** @type {any} */
  let type = null;
  activate({ providers: { register: (/** @type {any} */ t) => { type = t; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return type;
}
const type = load();
const fixture = (/** @type {string} */ name) => readFile(new URL(`../fixtures/llm/anthropic/${name}`, import.meta.url), 'utf8');
/** @param {any} [over] */
function spec(over = {}) {
  const endpoint = { id: 'ep-2', type: 'anthropic-messages', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', headers: {}, tunables: { ...type.tunables }, extraBody: {} };
  const model = { id: 'm-2', endpoint: 'ep-2', name: 'Haiku', providerId: 'claude-haiku-5-5', input: ['text', 'image'], tools: true, contextWindow: 1000000, maxOutput: null, prices: null, cacheTtls: ['5m', '1h'], reasoning: {}, tunables: {}, extraBody: {} };
  return { endpoint, model, key: 'sk-ant-test', tunables: { ...type.tunables }, request: { messages: [] }, ...over };
}
/** @param {string} text */
async function read(text) {
  const out = [];
  for await (const e of type.read(new Response(text), spec())) out.push(e);
  return out;
}

test('build: annai’s request as a Messages API request, with browser access and cache markers', () => {
  const s = spec({
    request: {
      system: 'Be brief.',
      cacheTtl: '1h',
      tools: [{ name: 'report_color', description: 'Report a color.', input: { type: 'object' } }],
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'What color?' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
        { role: 'assistant', parts: [
          { type: 'reasoning', text: 'A red square.', signature: 'sig', model: 'claude-haiku-5-5' },
          { type: 'reasoning', text: '', redacted: 'opaque', model: 'claude-haiku-5-5' },
          { type: 'reasoning', text: 'not signed', model: 'claude-haiku-5-5' },
          { type: 'tool_call', id: 'toolu_1', name: 'report_color', input: { color: 'red' } },
        ] },
        { role: 'user', parts: [{ type: 'text', text: 'And?' }, { type: 'tool_result', id: 'toolu_1', content: 'noted', isError: false }] },
        { role: 'user', parts: [{ type: 'text', text: 'Hello?' }] },
      ],
    },
  });
  const { url, headers, body } = type.build(s);
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(headers, { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant-test', 'anthropic-dangerous-direct-browser-access': 'true' });
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.stream, true);
  assert.deepEqual(body.system, [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
  assert.deepEqual(body.tools, [{ name: 'report_color', description: 'Report a color.', input_schema: { type: 'object' } }]);
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'What color?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'A red square.', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'tool_use', id: 'toolu_1', name: 'report_color', input: { color: 'red' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'noted' },
      { type: 'text', text: 'And?' },
      { type: 'text', text: 'Hello?', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ] },
  ]);
});

test('build: a 5-minute cache, a beta header, no key, and the request’s own maximum', () => {
  const s = spec({ key: null, tunables: { ...type.tunables, browserAccess: false, beta: 'files-api-2025-04-14' }, request: { system: 'S', cacheTtl: '5m', maxOutput: 100, messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } });
  const { headers, body } = type.build(s);
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], undefined);
  assert.equal(headers['anthropic-beta'], 'files-api-2025-04-14');
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(type.build(spec({ request: { messages: [] } })).body.system, undefined);
});

test('read: text with cache reads and writes of both lifetimes, and the stop reason', async () => {
  assert.deepEqual(await read(await fixture('text.sse')), [
    { type: 'usage', usage: { input: 50, cacheRead: 8000, cacheWrite: 1500, cacheWrite1h: 500, output: 1 } },
    { type: 'text', text: 'Hello from ' },
    { type: 'text', text: 'B.' },
    { type: 'usage', usage: { output: 7 } },
    { type: 'stop', reason: 'end' },
  ]);
});

test('read: signed thinking, redacted thinking and a tool call streamed in pieces', async () => {
  const events = await read(await fixture('thinking-tools.sse'));
  assert.deepEqual(events.filter((e) => e.type === 'reasoning'), [
    { type: 'reasoning', text: 'A red square. Call the tool.', signature: 'EqQBCgIYAh==' },
    { type: 'reasoning', text: '', redacted: 'EmwKAhgBEgy3' },
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'tool_input').map((e) => e.partial), ['', '{"color": "re', '{"color": "red"}']);
  assert.deepEqual(events.filter((e) => e.type === 'tool_call'), [{ type: 'tool_call', id: 'toolu_01A', name: 'report_color', input: { color: 'red' } }]);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'tool' });
});

test('read: an error event and a stream that stops early', async () => {
  await assert.rejects(read(await fixture('error.sse')), (e) => e instanceof ProviderError && e.kind === 'overloaded' && e.message === 'Overloaded');
  await assert.rejects(read(await fixture('cut.sse')), (e) => e instanceof ProviderError && e.kind === 'network');
});

test('classify: Anthropic error types', () => {
  const body = (/** @type {string} */ t, msg = 'x') => JSON.stringify({ type: 'error', error: { type: t, message: msg } });
  assert.equal(type.classify(401, body('authentication_error')), 'auth');
  assert.equal(type.classify(403, body('permission_error')), 'auth');
  assert.equal(type.classify(402, body('billing_error')), 'credit');
  assert.equal(type.classify(429, body('rate_limit_error')), 'rate');
  assert.equal(type.classify(529, body('overloaded_error')), 'overloaded');
  assert.equal(type.classify(413, body('request_too_large')), 'context');
  assert.equal(type.classify(404, body('not_found_error')), 'not-found');
  assert.equal(type.classify(500, body('api_error')), 'server');
  assert.equal(type.classify(504, body('timeout_error')), 'server');
  assert.equal(type.classify(400, body('invalid_request_error', 'prompt is too long: 1048577 tokens > 1000000 maximum')), 'context');
  assert.equal(type.classify(400, body('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.')), 'credit');
  assert.equal(type.classify(400, body('invalid_request_error', 'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum')), 'image');
  assert.equal(type.classify(400, body('invalid_request_error', 'max_tokens: must be positive')), 'bad-request');
  assert.equal(type.classify(500, 'not json'), null);
});

test('list: the models API', () => {
  const { url, headers } = type.listRequest({ endpoint: spec().endpoint, key: 'sk-ant-test' });
  assert.equal(url, 'https://api.anthropic.com/v1/models');
  assert.equal(headers['x-api-key'], 'sk-ant-test');
  assert.deepEqual(type.readList({ data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 1000000, max_tokens: 128000 }, { id: 'claude-x' }] }), [
    { providerId: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 1000000, maxOutput: 128000 },
    { providerId: 'claude-x' },
  ]);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test test/unit/llm-anthropic.test.js`
Expected: FAIL. The module can't be found: `Cannot find module …/plugins-official/anthropic-messages/index.js`.

- [ ] **Step 4: Write the plugin**

Create `plugins-official/anthropic-messages/annai-plugin.json`:

```json
{
  "id": "anthropic-messages",
  "name": "Anthropic Messages",
  "version": "0.1.0",
  "api": 1,
  "entry": "index.js",
  "description": "Talks to Anthropic's Messages API and to endpoints that speak it.",
  "provides": { "endpoint-type": ["anthropic-messages"] }
}
```

Create `plugins-official/anthropic-messages/index.js`:

```js
/**
 * The Anthropic Messages endpoint type (spec §9.1). Browsers may call Anthropic only with the
 * "anthropic-dangerous-direct-browser-access" header. Thinking comes back as signed blocks, which
 * are sent back unchanged to the model that wrote them (annai's core drops them for any other).
 */
const TUNABLES = Object.freeze({ path: '/v1/messages', version: '2023-06-01', browserAccess: true, beta: '', defaultMaxTokens: 8192 });
const STOP = /** @type {Record<string, string>} */ ({ end_turn: 'end', stop_sequence: 'end', tool_use: 'tool', max_tokens: 'length', refusal: 'refusal', pause_turn: 'other' });
const TYPES = /** @type {Record<string, string>} */ ({
  authentication_error: 'auth', permission_error: 'auth', billing_error: 'credit', rate_limit_error: 'rate', overloaded_error: 'overloaded',
  request_too_large: 'context', not_found_error: 'not-found', api_error: 'server', timeout_error: 'server',
});

/** @param {any} annai */
export function activate(annai) {
  const { sse, ProviderError } = annai.helpers;
  return annai.providers.register({
    type: 'anthropic-messages',
    name: 'Anthropic Messages',
    tunables: TUNABLES,
    /** @param {any} c */
    build: (c) => build(c),
    /** @param {Response} res */
    read: (res) => read(res, sse, ProviderError),
    classify,
    /** @param {{ endpoint: any, key: string | null }} c */
    listRequest: ({ endpoint, key }) => ({ url: join(endpoint.baseUrl, '/v1/models'), headers: headersFor(endpoint, key, { ...TUNABLES, ...endpoint.tunables }) }),
    readList,
  });
}

/** @param {string} base @param {string} path */
const join = (base, path) => String(base).replace(/\/+$/, '') + path;
/** @param {string} ttl */
const cacheControl = (ttl) => (ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });

/** @param {any} endpoint @param {string | null} key @param {any} t @returns {Record<string, string>} */
function headersFor(endpoint, key, t) {
  return {
    'content-type': 'application/json',
    'anthropic-version': t.version,
    ...(key ? { 'x-api-key': key } : {}),
    ...(t.browserAccess ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
    ...(t.beta ? { 'anthropic-beta': t.beta } : {}),
    ...(endpoint.headers ?? {}),
  };
}

/** @param {any} c */
function build({ endpoint, model, key, tunables: t, request }) {
  /** @type {Record<string, any>} */
  const body = { model: model.providerId, max_tokens: request.maxOutput ?? model.maxOutput ?? t.defaultMaxTokens, messages: wire(request.messages, model.providerId), stream: true };
  if (request.system) body.system = [{ type: 'text', text: request.system, ...(request.cacheTtl ? { cache_control: cacheControl(request.cacheTtl) } : {}) }];
  if (request.tools?.length) body.tools = request.tools.map((/** @type {any} */ x) => ({ name: x.name, description: x.description, input_schema: x.input }));
  if (request.cacheTtl && body.messages.length) {
    const last = body.messages.at(-1).content;
    last[last.length - 1] = { ...last[last.length - 1], cache_control: cacheControl(request.cacheTtl) };
  }
  return { url: join(endpoint.baseUrl, t.path), headers: headersFor(endpoint, key, t), body };
}

/**
 * annai's messages as Messages API messages: one message per turn (messages of the same role are
 * joined), tool results first in a user turn, and thinking only when this model signed it.
 * @param {any[]} messages @param {string} providerId
 */
function wire(messages, providerId) {
  /** @type {{ role: string, content: any[] }[]} */
  const out = [];
  for (const m of messages) {
    const blocks = m.parts.flatMap((/** @type {any} */ p) => {
      if (p.type === 'text') return [{ type: 'text', text: p.text }];
      if (p.type === 'image') return [{ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }];
      if (p.type === 'tool_call') return [{ type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} }];
      if (p.type === 'tool_result') return [{ type: 'tool_result', tool_use_id: p.id, content: p.content, ...(p.isError ? { is_error: true } : {}) }];
      if (p.type === 'reasoning' && p.model === providerId) {
        if (p.redacted) return [{ type: 'redacted_thinking', data: p.redacted }];
        if (p.signature) return [{ type: 'thinking', thinking: p.text, signature: p.signature }];
      }
      return [];
    });
    if (!blocks.length) continue;
    const prev = out.at(-1);
    if (prev && prev.role === m.role) prev.content.push(...blocks);
    else out.push({ role: m.role, content: blocks });
  }
  for (const m of out) if (m.role === 'user') m.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
  return out;
}

/** The events of a streamed Messages API reply. @param {Response} res @param {any} sse @param {any} ProviderError */
async function* read(res, sse, ProviderError) {
  /** @type {Map<number, any>} */
  const blocks = new Map();
  /** @type {string | null} */
  let stop = null;
  let finished = false;
  for await (const { event, data } of sse(/** @type {ReadableStream<Uint8Array>} */ (res.body))) {
    /** @type {any} */
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      continue;
    }
    const type = e.type ?? event;
    if (type === 'error') {
      throw new ProviderError(TYPES[e.error?.type] ?? 'server', String(e.error?.message ?? 'The provider reported an error.'));
    } else if (type === 'message_start') {
      const u = e.message?.usage;
      if (u) yield { type: 'usage', usage: usageOf(u) };
    } else if (type === 'content_block_start') {
      const b = { ...e.content_block, json: '', thinking: e.content_block?.thinking ?? '', signature: e.content_block?.signature ?? '' };
      blocks.set(e.index, b);
      if (b.type === 'text' && b.text) yield { type: 'text', text: b.text };
    } else if (type === 'content_block_delta') {
      const b = blocks.get(e.index) ?? {};
      const d = e.delta ?? {};
      if (d.type === 'text_delta' && d.text) yield { type: 'text', text: d.text };
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature;
      else if (d.type === 'input_json_delta') {
        b.json = (b.json ?? '') + d.partial_json;
        yield { type: 'tool_input', id: b.id, name: b.name, partial: b.json };
      }
    } else if (type === 'content_block_stop') {
      const b = blocks.get(e.index);
      if (b?.type === 'thinking') yield { type: 'reasoning', text: b.thinking, ...(b.signature ? { signature: b.signature } : {}) };
      else if (b?.type === 'redacted_thinking') yield { type: 'reasoning', text: '', redacted: b.data };
      else if (b?.type === 'tool_use') yield { type: 'tool_call', id: b.id, name: b.name, input: parseArgs(b.json) };
    } else if (type === 'message_delta') {
      if (e.delta?.stop_reason) stop = e.delta.stop_reason;
      if (e.usage) yield { type: 'usage', usage: usageOf(e.usage) };
    } else if (type === 'message_stop') {
      finished = true;
      break;
    }
  }
  if (!finished) throw new ProviderError('network', 'The reply stopped before it finished.');
  yield { type: 'stop', reason: STOP[stop ?? 'end_turn'] ?? 'other' };
}

/** @param {string} json */
function parseArgs(json) {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return json;
  }
}

/** Anthropic usage, normalized; only the numbers this report gives. @param {any} u */
function usageOf(u) {
  /** @type {Record<string, number>} */
  const out = {};
  if (typeof u.input_tokens === 'number') out.input = u.input_tokens;
  if (typeof u.cache_read_input_tokens === 'number') out.cacheRead = u.cache_read_input_tokens;
  if (u.cache_creation) {
    out.cacheWrite = u.cache_creation.ephemeral_5m_input_tokens ?? 0;
    out.cacheWrite1h = u.cache_creation.ephemeral_1h_input_tokens ?? 0;
  } else if (typeof u.cache_creation_input_tokens === 'number') {
    out.cacheWrite = u.cache_creation_input_tokens;
  }
  if (typeof u.output_tokens === 'number') out.output = u.output_tokens;
  return out;
}

/** @param {number} _status @param {string} body */
function classify(_status, body) {
  /** @type {any} */
  let e;
  try {
    e = JSON.parse(body)?.error;
  } catch {
    return null;
  }
  if (!e?.type) return null;
  if (TYPES[e.type]) return TYPES[e.type];
  if (e.type !== 'invalid_request_error') return null;
  const m = String(e.message ?? '');
  if (/prompt is too long|too many tokens|context/i.test(m)) return 'context';
  if (/credit balance/i.test(m)) return 'credit';
  if (/image/i.test(m)) return 'image';
  return 'bad-request';
}

/** @param {any} json */
function readList(json) {
  return (Array.isArray(json?.data) ? json.data : []).filter((/** @type {any} */ m) => typeof m?.id === 'string').map((/** @type {any} */ m) => {
    /** @type {Record<string, any>} */
    const out = { providerId: m.id };
    if (m.display_name) out.name = m.display_name;
    if (m.max_input_tokens) out.contextWindow = m.max_input_tokens;
    if (m.max_tokens) out.maxOutput = m.max_tokens;
    return out;
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/llm-anthropic.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Regenerate the catalog, check, commit**

Run: `npm run catalog && npm run check`
Expected: `catalog/plugins.json: 3 plugin(s)`, then all green.

```bash
git add plugins-official/anthropic-messages catalog/plugins.json test/fixtures/llm/anthropic test/unit/llm-anthropic.test.js
git commit -m "Anthropic Messages endpoint type: browser access, signed thinking, cache markers"
```

---

### Task 8: One model call, and its place in the trace

**Files:**
- Create: `src/core/llm/call.js`, `src/core/llm/trace.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/llm-call.test.js`

**Interfaces:**
- Consumes:
  - `ProviderError`, `errorFromResponse`, `portable`, and the types `EndpointType` and `CallSpec` (Tasks 1 and 5)
  - `mergePatch` (`src/core/patch.js`)
  - `levelPatch` (Task 2) and `NO_USAGE`, `mergeUsage`, `costOf` (Task 2)
  - the types `Endpoint` and `Model` (Task 4)
- Produces:
  - **From `trace.js`:** `modelTrace(store, scope)` returns `{ secret(key), request(info), turn(info, text) }`.
    - It writes `net.request` and `model.turn` events.
    - `turn(info, text, reasoning?)` stores the reply's text and its reasoning as blobs, named in the event's `refs` (with `data.stored: ['reply', 'reasoning']`), in the same transaction.
    - Echoed keys become `«key»`.
  - **From `call.js`:**
    - `applyPatches(body, endpoint, model, level)`
    - `callOnce({ type, endpoint, model, key, request, level?, fetch?, signal?, firstOutputMs?, onEvent?, trace?, registry?, now? }): Promise<Reply>`
    - The type `Reply`: `{ parts: Part[], text: string, usage: Usage, cost: number | undefined, stop: StopReason, model: string }`.
    - Its errors are always `ProviderError`. `partial` is set when text arrived before the failure.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/llm-call.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { callOnce, applyPatches } from '../../src/core/llm/call.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { text as textOf } from '../../src/core/bytes.js';

const endpoint = (over = {}) => ({ id: 'ep-1', type: 'test', name: 'Test endpoint', baseUrl: 'https://llm.test', headers: {}, tunables: {}, extraBody: {}, ...over });
const model = (over = {}) => ({ id: 'm-1', endpoint: 'ep-1', name: 'Test model', providerId: 'test-1', input: ['text'], tools: true, contextWindow: 100000, maxOutput: 1000, prices: { input: 1, output: 2 }, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, ...over });
/** @type {any} */
const request = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] };

/** An endpoint type with no network that runs the given generator. @param {(c: any) => AsyncGenerator<any>} run */
const runType = (run) => /** @type {any} */ ({ type: 'test-run', name: 'Run', pluginId: 'run-plugin', run });
/** An HTTP endpoint type whose stream is these events. @param {any[]} events @param {any} [extra] */
const httpType = (events, extra = {}) => /** @type {any} */ ({
  type: 'test', name: 'Test', pluginId: 'test-plugin',
  build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: { authorization: `Bearer ${c.key}` }, body: { model: c.model.providerId, messages: c.request.messages } }),
  read: async function* () { for (const e of events) yield e; },
  ...extra,
});
/** @param {any} store */
const traced = async (store) => store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS));

test('one call puts the reply together, with its usage and cost, and tells the trace', async () => {
  const store = createMemoryStore();
  const seen = [];
  const reply = await callOnce({
    type: runType(async function* () {
      yield { type: 'reasoning', text: 'Think.', signature: 'sig' };
      yield { type: 'text', text: 'Hello ' };
      yield { type: 'text', text: 'there' };
      yield { type: 'tool_call', id: 'c1', name: 'look', input: { at: 'map' } };
      yield { type: 'usage', usage: { input: 1000, output: 400 } };
      yield { type: 'usage', usage: { output: 500 } };
      yield { type: 'stop', reason: 'tool' };
    }),
    endpoint: endpoint(), model: model(), key: null, request, onEvent: (e) => seen.push(e), trace: modelTrace(store, SYS),
  });
  assert.deepEqual(reply.parts, [
    { type: 'reasoning', text: 'Think.', signature: 'sig', model: 'test-1' },
    { type: 'text', text: 'Hello there' },
    { type: 'tool_call', id: 'c1', name: 'look', input: { at: 'map' } },
  ]);
  assert.equal(reply.text, 'Hello there');
  assert.equal(reply.usage.input, 1000);
  assert.equal(reply.usage.output, 500);
  assert.ok(Math.abs(/** @type {number} */ (reply.cost) - (1000 * 1 + 500 * 2) / 1e6) < 1e-12);
  assert.equal(reply.stop, 'tool');
  assert.equal(reply.model, 'm-1');
  assert.equal(seen.length, 7);
  const [ev] = await traced(store);
  assert.equal(ev.type, 'net.request');
  assert.equal(ev.data.outcome, 'ok');
  assert.equal(ev.data.model, 'Test model');
  assert.equal(ev.data.endpoint, 'Test endpoint');
  assert.equal(typeof ev.data.firstMs, 'number');
});

test("patches: the endpoint's extra fields, then the model's, then the reasoning level's (spec §9.2–9.4)", async () => {
  const ep = endpoint({ extraBody: { a: 2, b: 1 } });
  const m = model({ extraBody: { b: 2, 'tools+': [2] }, reasoning: { high: { effort: 'high' } } });
  assert.deepEqual(applyPatches({ a: 1, tools: [1] }, ep, m, 'max'), { a: 2, b: 2, tools: [1, 2], effort: 'high' });
  /** @type {any} */
  let sent = null;
  await callOnce({
    type: httpType([{ type: 'text', text: 'ok' }, { type: 'stop', reason: 'end' }]), endpoint: ep, model: m, key: 'sk-1', request, level: 'high',
    fetch: async (url, init) => { sent = { url, init }; return new Response('streamed'); },
  });
  assert.equal(sent.url, 'https://llm.test/v1/chat');
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers.authorization, 'Bearer sk-1');
  assert.deepEqual(JSON.parse(sent.init.body), { model: 'test-1', messages: request.messages, a: 2, b: 2, tools: [2], effort: 'high' });
});

test('an error response becomes a ProviderError, sharpened by the endpoint type', async () => {
  const type = httpType([], { classify: (/** @type {number} */ _s, /** @type {string} */ body) => (body.includes('special') ? 'context' : null) });
  await assert.rejects(callOnce({ type, endpoint: endpoint(), model: model(), key: null, request, fetch: async () => new Response(JSON.stringify({ error: { message: 'x', code: 'special' } }), { status: 400 }) }),
    (e) => e instanceof ProviderError && e.kind === 'context' && e.status === 400);
});

test('a key the provider echoes in an error never reaches the trace', async () => {
  const store = createMemoryStore();
  const key = 'sk-live-abcdef123456';
  await assert.rejects(callOnce({
    type: httpType([]), endpoint: endpoint(), model: model(), key, request, trace: modelTrace(store, SYS),
    fetch: async () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}.` } }), { status: 401 }),
  }), (e) => e instanceof ProviderError && e.kind === 'auth');
  const log = JSON.stringify(await traced(store));
  assert.ok(!log.includes(key), log);
  assert.ok(log.includes('«key»'));
});

test("a fetch that fails is 'unreachable'", async () => {
  await assert.rejects(callOnce({ type: httpType([]), endpoint: endpoint(), model: model(), key: null, request, fetch: async () => { throw new TypeError('Failed to fetch'); } }),
    (e) => e instanceof ProviderError && e.kind === 'unreachable');
});

test('no first output in time is a timeout, whether the request or the stream is slow', async () => {
  const never = runType(async function* () { await new Promise(() => {}); });
  await assert.rejects(callOnce({ type: never, endpoint: endpoint(), model: model(), key: null, request, firstOutputMs: 30 }), (e) => e instanceof ProviderError && e.kind === 'timeout');
  const hanging = async (/** @type {any} */ _url, /** @type {any} */ init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(callOnce({ type: httpType([]), endpoint: endpoint(), model: model(), key: null, request, firstOutputMs: 30, fetch: /** @type {any} */ (hanging) }),
    (e) => e instanceof ProviderError && e.kind === 'timeout');
});

test('the caller can stop a call, and what it said so far is kept with a cut-off', async () => {
  const stop = new AbortController();
  const slow = runType(async function* () {
    yield { type: 'text', text: 'Kyoto is' };
    await new Promise(() => {});
  });
  await assert.rejects(callOnce({ type: slow, endpoint: endpoint(), model: model(), key: null, request, signal: stop.signal, onEvent: () => stop.abort() }),
    (e) => e instanceof ProviderError && e.kind === 'cancelled');
  const cut = runType(async function* () {
    yield { type: 'text', text: 'Kyoto is' };
    throw new ProviderError('network', 'dropped');
  });
  await assert.rejects(callOnce({ type: cut, endpoint: endpoint(), model: model(), key: null, request }), (e) => e instanceof ProviderError && e.kind === 'network' && e.partial === 'Kyoto is');
});

test("a bug in an endpoint type counts against its plugin, and the call fails as 'plugin'", async () => {
  /** @type {any[]} */
  const logged = [];
  const registry = new Registry({ log: (ev) => logged.push(ev) });
  const buggy = runType(async function* () { yield { type: 'text', text: 'a' }; throw new Error('oops'); });
  await assert.rejects(callOnce({ type: buggy, endpoint: endpoint(), model: model(), key: null, request, registry }), (e) => e instanceof ProviderError && e.kind === 'plugin');
  assert.equal(logged[0].type, 'plugin.error');
  assert.equal(logged[0].actor, 'plugin:run-plugin');
});

test('reasoning signed by another model is never sent to this one', async () => {
  /** @type {any} */
  let sent = null;
  const type = httpType([{ type: 'stop', reason: 'end' }], { build: (/** @type {any} */ c) => { sent = c.request.messages; return { url: 'https://llm.test', headers: {}, body: {} }; } });
  const history = { messages: [...request.messages, { role: 'assistant', parts: [{ type: 'reasoning', text: 'x', signature: 's', model: 'other' }, { type: 'text', text: 'Hello' }] }] };
  await callOnce({ type, endpoint: endpoint(), model: model(), key: null, request: history, fetch: async () => new Response('') });
  assert.deepEqual(sent[1].parts, [{ type: 'text', text: 'Hello' }]);
});

test('model.turn keeps the reply and its reasoning as blobs it names, in one transaction (spec §4.9, §9.3)', async () => {
  const store = createMemoryStore();
  const trace = modelTrace(store, SYS);
  trace.secret('sk-abcdefgh12345');
  await trace.turn({ role: 'main', level: 'medium', answeredBy: 'Test model', attempts: [{ model: 'm-1', name: 'Test model', outcome: 'auth', ms: 5, error: 'bad key sk-abcdefgh12345' }], usage: null, cost: undefined, stop: 'end' }, 'Hello there', 'They said hello.');
  const [ev] = await traced(store);
  assert.equal(ev.type, 'model.turn');
  assert.equal(ev.data.attempts[0].error, 'bad key «key»');
  assert.deepEqual(ev.data.stored, ['reply', 'reasoning']);
  assert.equal(ev.refs.length, 2);
  const texts = [];
  for (const hash of ev.refs) texts.push(textOf(new Uint8Array(/** @type {any} */ (await store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash))).data)));
  assert.deepEqual(texts, ['Hello there', 'They said hello.']);
  await trace.turn({ role: 'main', level: 'off', answeredBy: null, attempts: [], usage: null, cost: undefined }, '');
  assert.equal((await traced(store))[1].refs, undefined, 'nothing to keep, nothing named');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/llm-call.test.js`
Expected: FAIL. The module can't be found: `Cannot find module …/src/core/llm/call.js`.

- [ ] **Step 3: Write trace.js**

Create `src/core/llm/trace.js`:

```js
import { sha256Hex } from '../hash.js';
import { utf8, ownBuffer } from '../bytes.js';

/**
 * Model calls in the trace (spec §4.5, §9.6, §15): a net.request for every attempt, and a
 * model.turn for every role call. Request bodies aren't kept: a model request is logged as a
 * reference, not a copy. The reply's text and its reasoning are kept, as blobs the model.turn names
 * in refs, written in the same transaction (§4.9). Keys never reach the trace; any a provider echoes back in an
 * error are blanked out. Writing to the trace never breaks a call, not even on a full device.
 * @typedef {import('../types.js').Store} Store
 * @typedef {{ endpoint: string, model: string, providerModel: string, url: string, status: number, ms: number, firstMs: number | null,
 *   outcome: string, error?: string, usage: any, cost?: number }} RequestInfo
 * @typedef {{ model: string, name: string, outcome: string, ms: number, cost?: number, error?: string }} Attempt
 * @typedef {{ role: string, level: string, answeredBy: string | null, attempts: Attempt[], usage: any, cost: number | undefined, stop?: string }} TurnInfo
 */

/** @param {Store} store @param {string} scope */
export function modelTrace(store, scope) {
  /** @type {Set<string>} */
  const secrets = new Set();
  const scrub = (/** @type {unknown} */ s) => {
    let out = String(s ?? '');
    for (const k of secrets) out = out.split(k).join('«key»');
    return out;
  };
  /**
   * Appends an event, keeping each non-empty text as a blob it names in refs; data.stored says
   * which is which.
   * @param {{ ts: number, type: string, actor: string, data: any }} ev @param {[string, string][]} texts [name, text] pairs
   */
  const append = async (ev, texts) => {
    try {
      const kept = [];
      for (const [name, text] of texts) {
        if (!text) continue;
        const bytes = utf8(text);
        kept.push({ name, bytes, hash: await sha256Hex(bytes) });
      }
      if (!kept.length) {
        await store.tx(['events'], 'readwrite', (t) => t.appendEvent(scope, ev));
        return;
      }
      await store.tx(['blobs', 'events'], 'readwrite', async (t) => {
        for (const k of kept) {
          if (!(await t.hasBlob(k.hash))) await t.putBlob({ hash: k.hash, type: 'text/plain; charset=utf-8', size: k.bytes.byteLength, data: ownBuffer(k.bytes) });
        }
        await t.appendEvent(scope, { ...ev, data: { ...ev.data, stored: kept.map((k) => k.name) }, refs: kept.map((k) => k.hash) });
      });
    } catch {
      // the trace must never break a call
    }
  };
  return {
    /** A key the calls use, so that an echo of it can be blanked out. Short strings are ignored. @param {string} key */
    secret(key) {
      if (typeof key === 'string' && key.length >= 8) secrets.add(key);
    },
    /** @param {RequestInfo} i */
    request(i) {
      const data = { kind: 'model', ...i, ...(i.error ? { error: scrub(i.error) } : {}), url: scrub(i.url) };
      return append({ ts: Date.now(), type: 'net.request', actor: 'system', data }, []);
    },
    /**
     * @param {TurnInfo} i @param {string} text the reply's text
     * @param {string} [reasoning] the reply's reasoning: never shown in the conversation, visible here (spec §9.3)
     */
    turn(i, text, reasoning = '') {
      const data = { ...i, attempts: i.attempts.map((a) => (a.error ? { ...a, error: scrub(a.error) } : a)) };
      return append({ ts: Date.now(), type: 'model.turn', actor: 'system', data }, [['reply', scrub(text)], ['reasoning', scrub(reasoning)]]);
    },
  };
}
```

- [ ] **Step 4: Write call.js**

Create `src/core/llm/call.js`:

```js
import { ProviderError, errorFromResponse, portable } from './contract.js';
import { mergePatch } from '../patch.js';
import { levelPatch } from './reasoning.js';
import { NO_USAGE, mergeUsage, costOf } from './cost.js';

/**
 * One model call (spec §9.1): the endpoint type builds the request, annai merges in the
 * endpoint's and the model's extra fields and the reasoning level, sends it, and puts the
 * streamed reply together. It never falls back; callRole does that (§9.6).
 * @typedef {import('./contract.js').EndpointType} EndpointType
 * @typedef {import('./contract.js').CallSpec} CallSpec
 * @typedef {import('./contract.js').Request} Request
 * @typedef {import('./contract.js').Part} Part
 * @typedef {import('./contract.js').Usage} Usage
 * @typedef {import('./contract.js').StreamEvent} StreamEvent
 * @typedef {import('./contract.js').StopReason} StopReason
 * @typedef {import('./config.js').Endpoint} Endpoint
 * @typedef {import('./config.js').Model} Model
 * @typedef {ReturnType<typeof import('./trace.js').modelTrace>} ModelTrace
 * @typedef {{ parts: Part[], text: string, usage: Usage, cost: number | undefined, stop: StopReason, model: string }} Reply
 * @typedef {(url: string, init: RequestInit) => Promise<Response>} Fetch
 */

const defaultFetch = /** @type {Fetch} */ ((url, init) => fetch(url, init));

/**
 * The body with the endpoint's extra fields, then the model's, then the reasoning level's patch
 * merged in (spec §9.2–9.4; a key ending in "+" appends to an array).
 * @param {any} body @param {Endpoint} endpoint @param {Model} model @param {string} level
 */
export function applyPatches(body, endpoint, model, level) {
  let out = mergePatch(body, endpoint.extraBody ?? {}, { append: true });
  out = mergePatch(out, model.extraBody ?? {}, { append: true });
  const r = levelPatch(model.reasoning, level);
  return r ? mergePatch(out, r, { append: true }) : out;
}

/**
 * @param {{ type: EndpointType, endpoint: Endpoint, model: Model, key: string | null, request: Request, level?: string,
 *   fetch?: Fetch, signal?: AbortSignal, firstOutputMs?: number, onEvent?: (e: StreamEvent) => void, trace?: ModelTrace,
 *   registry?: import('../registry.js').Registry, now?: () => number }} c
 *   firstOutputMs: how long to wait for the first output, and then between pieces of output
 * @returns {Promise<Reply>}
 */
export async function callOnce({ type, endpoint, model, key, request, level = 'off', fetch: get = defaultFetch, signal, firstOutputMs = 30_000, onEvent = () => {}, trace, registry, now = Date.now }) {
  if (key) trace?.secret(key);
  /** @type {CallSpec} */
  const spec = { endpoint, model, key, tunables: { ...endpoint.tunables, ...model.tunables }, request: { ...request, messages: portable(request.messages, model.providerId) } };
  const started = now();
  const timer = new AbortController();
  const late = () => timer.abort(new DOMException('No output in time.', 'TimeoutError'));
  let t = setTimeout(late, firstOutputMs);
  const linked = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  /** @type {Part[]} */
  const parts = [];
  /** @type {Usage} */
  let usage = { ...NO_USAGE };
  /** @type {StopReason} */
  let stop = 'end';
  /** @type {number | null} */
  let firstMs = null;
  let status = 0;
  let url = `${type.type}:`;
  /** @param {StreamEvent} ev */
  const take = (ev) => {
    clearTimeout(t);
    t = setTimeout(late, firstOutputMs);
    if (firstMs === null && ev.type !== 'usage') firstMs = now() - started;
    if (ev.type === 'text') {
      const last = parts.at(-1);
      if (last?.type === 'text') last.text += ev.text;
      else parts.push({ type: 'text', text: ev.text });
    } else if (ev.type === 'reasoning') {
      parts.push({ type: 'reasoning', text: ev.text, ...(ev.signature ? { signature: ev.signature } : {}), ...(ev.redacted ? { redacted: ev.redacted } : {}), model: model.providerId });
    } else if (ev.type === 'tool_call') {
      parts.push({ type: 'tool_call', id: ev.id, name: ev.name, input: ev.input });
    } else if (ev.type === 'usage') {
      usage = mergeUsage(usage, ev.usage);
    } else if (ev.type === 'stop') {
      stop = ev.reason;
    }
    onEvent(ev);
  };
  const info = () => ({ endpoint: endpoint.name, model: model.name, providerModel: model.providerId, url, status, ms: now() - started, firstMs, usage });
  try {
    if (type.run) {
      for await (const ev of untilAborted(type.run({ ...spec, signal: linked }), linked)) take(ev);
    } else {
      const built = /** @type {NonNullable<EndpointType['build']>} */ (type.build)(spec);
      url = built.url;
      /** @type {Response} */
      let res;
      try {
        res = await get(built.url, { method: 'POST', headers: built.headers, body: JSON.stringify(applyPatches(built.body, endpoint, model, level)), signal: linked });
      } catch (e) {
        throw cannotConnect(e, linked);
      }
      status = res.status;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = errorFromResponse(res.status, text, res.headers);
        const sharper = type.classify?.(res.status, text);
        if (sharper) err.kind = sharper;
        throw err;
      }
      for await (const ev of untilAborted(/** @type {NonNullable<EndpointType['read']>} */ (type.read)(res, spec), linked)) take(ev);
    }
  } catch (e) {
    clearTimeout(t);
    const err = asProviderError(e, linked, type, registry);
    if (err.kind !== 'cancelled' && !err.partial) err.partial = textOf(parts);
    await trace?.request({ ...info(), outcome: err.kind, error: err.message });
    throw err;
  }
  clearTimeout(t);
  const cost = costOf(usage, model.prices);
  await trace?.request({ ...info(), outcome: 'ok', ...(cost !== undefined ? { cost } : {}) });
  return { parts, text: textOf(parts), usage, cost, stop, model: model.id };
}

/** @param {Part[]} parts */
function textOf(parts) {
  return parts.filter((p) => p.type === 'text').map((p) => /** @type {any} */ (p).text).join('');
}

/**
 * The events of an async iterable until the signal aborts, even if the iterable is stuck waiting.
 * @template T @param {AsyncIterable<T>} iterable @param {AbortSignal} signal @returns {AsyncGenerator<T>}
 */
async function* untilAborted(iterable, signal) {
  const it = iterable[Symbol.asyncIterator]();
  /** @type {Promise<never>} */
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const r = await Promise.race([it.next(), aborted]);
      if (r.done) return;
      yield r.value;
    }
  } finally {
    // Don't wait: a generator stuck in an await would never answer.
    it.return?.()?.catch(() => {});
  }
}

/** A failed fetch: an abort stays an abort; anything else means annai couldn't reach the endpoint. @param {unknown} e @param {AbortSignal} signal */
function cannotConnect(e, signal) {
  const name = /** @type {any} */ (e)?.name;
  if (signal.aborted || name === 'AbortError' || name === 'TimeoutError') return e;
  return new ProviderError('unreachable', String(/** @type {any} */ (e)?.message ?? e), { cause: e });
}

/**
 * Whatever went wrong, as a ProviderError. Running out of time is "timeout", the caller stopping
 * is "cancelled", and any other error from the endpoint type's code is a bug in its plugin, which
 * counts against the plugin (spec §5.5).
 * @param {unknown} e @param {AbortSignal} signal @param {EndpointType} type @param {import('../registry.js').Registry} [registry]
 */
function asProviderError(e, signal, type, registry) {
  if (e instanceof ProviderError) return e;
  const name = /** @type {any} */ (e)?.name;
  if (name === 'TimeoutError' || signal.reason?.name === 'TimeoutError') return new ProviderError('timeout', 'No output started in time.', { cause: e });
  if (name === 'AbortError' || signal.aborted) return new ProviderError('cancelled', 'Stopped.', { cause: e });
  registry?.fail(type.pluginId, `endpoint type ${type.type}`, e);
  return new ProviderError('plugin', String(/** @type {any} */ (e)?.message ?? e), { cause: e });
}
```

In `sw.js`, add to `SHELL` after `'/src/core/hash.js',`:

```js
  '/src/core/llm/call.js',
```

After `'/src/core/llm/sse.js',`, add:

```js
  '/src/core/llm/trace.js',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/llm-call.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 6: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: all green.

```bash
git add src/core/llm/call.js src/core/llm/trace.js sw.js test/unit/llm-call.test.js
git commit -m "One model call: patches, streaming, timeouts, plain errors, and the trace without keys"
```

---

### Task 9: Roles and fallback

**Files:**
- Create: `src/core/llm/fallback.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/llm-fallback.test.js`

**Interfaces:**
- Consumes:
  - `callOnce` and `Reply` (Task 8)
  - `modelOf`, `endpointOf` and `CHAT_ROLES` (Task 4)
  - `addUsage`, `addCost` and `NO_USAGE` (Task 2), and `ROLE_LEVELS` (Task 2)
  - the scripted model plugin (Task 5), in the tests
- Produces:
  - **Constants:**
    - `COOLDOWN_MS` = 180 000
    - `SHORT_WAIT_MS` = 10 000
    - `OVERLOAD_RETRIES` = [500, 1500]
    - `NETWORK_RETRIES` = [1000, 3000]
  - **`class Bench`**, with `bench(id, ms, now?)`, `until(id): number` and `clear(id)`.
  - **`class AllFailedError extends Error`**, with `attempts` and `said`.
  - **Helpers:** `candidates(config, role): string[]`, `gap(model, request)`, `estimateTokens(request)` and `continueAfter(request, said)`.
  - **`callRole(c)`.** Its input `c` is `{ role, request, level?, config, types, keyFor, bench, fetch?, signal?, onEvent?, trace?, registry?, sleep?, now?, firstOutputMs? }`.

    The wait for a model's first words is `c.firstOutputMs`, else the role's `firstOutputSeconds` (30 s by default).

    It returns `Promise<{ reply, attempts, usage, cost, answeredBy }>`. Each attempt is `{ model, name, outcome, ms, cost?, error? }`; `outcome` is `'ok'`, an `ErrorKind`, or a reason for skipping (`'removed'`, `'type-missing'`, `'benched'`, `'no-images'`, `'no-tools'`, `'too-long'`).

What each kind of failure leads to (spec §9.6):

| Failure | What happens |
|---|---|
| overloaded | two quick retries (500 ms, 1500 ms), then the model is benched and the next one is tried |
| rate-limited | a wait of 10 s or less is waited out once; otherwise the model is benched for the wait (or 3 minutes) and the next one is tried |
| network or server | two retries (1 s, 3 s), then bench and next |
| context, image, upload or bad request | next, without benching: another request may fit |
| everything else (auth, credit, blocked, unreachable, not-found, timeout, plugin) | bench and next |
| no first output in time | the model is benched and the next one is tried. The wait is the role's `firstOutputSeconds`, 30 s by default; voice will ask for less (milestone 3) |
| a reply cut off partway | the next model gets "said so far … ✂" and continues |
| cancelled | stop |

- [ ] **Step 1: Write the failing tests**

Create `test/unit/llm-fallback.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { callRole, candidates, Bench, AllFailedError, COOLDOWN_MS, continueAfter } from '../../src/core/llm/fallback.js';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';

/** A fresh scripted endpoint type, as the plugin registers it. @returns {any} */
function scriptedType() {
  /** @type {any} */
  let t = null;
  scripted({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'scripted-model' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return t;
}

/**
 * A config with one scripted endpoint per script, one model on each, and those models in main.
 * @param {any[][]} scripts @param {{ models?: any[], types?: [string, any][] , endpointTypes?: string[] }} [opts]
 */
function setup(scripts, { models = [], types = [], endpointTypes = [] } = {}) {
  /** @type {any} */
  const config = { endpoints: {}, models: {}, roles: { main: { models: [], level: 'medium' }, utility: { models: [], level: 'low' }, decide: { models: [], level: 'off' } } };
  scripts.forEach((script, i) => {
    config.endpoints[`ep-${i}`] = { id: `ep-${i}`, type: endpointTypes[i] ?? 'scripted', template: null, user: { name: `E${i}`, tunables: { script } }, created: 0 };
    config.models[`m-${i}`] = { id: `m-${i}`, endpoint: `ep-${i}`, template: null, user: { providerId: `model-${i}`, prices: { input: 1, output: 1 }, ...(models[i] ?? {}) }, created: 0 };
    config.roles.main.models.push(`m-${i}`);
  });
  /** @type {number[]} */
  const waits = [];
  let clock = 1_000_000;
  const store = createMemoryStore();
  return {
    config, waits, store,
    bench: new Bench(),
    types: new Map([['scripted', scriptedType()], ...types]),
    tick: (/** @type {number} */ ms) => { clock += ms; },
    base: () => ({ config, types: undefined, bench: undefined, keyFor: async () => null, sleep: async (/** @type {number} */ ms) => { waits.push(ms); }, now: () => clock, trace: modelTrace(store, SYS) }),
  };
}
/** @type {any} */
const hello = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] };
/** @param {ReturnType<typeof setup>} s @param {any} [over] */
const call = (s, over = {}) => callRole({ ...s.base(), types: s.types, bench: s.bench, role: 'main', request: hello, ...over });

test('the first model that answers is the answer, with no fallback', async () => {
  const s = setup([[{ text: 'Hi from A.' }], [{ text: 'Hi from B.' }]]);
  const r = await call(s);
  assert.equal(r.reply.text, 'Hi from A.');
  assert.equal(r.answeredBy, 'model-0');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['ok']);
});

test('out of credit: the next model answers, and the first one rests (benched) for a while', async () => {
  const s = setup([[{ error: 'credit', status: 402 }], [{ text: 'Hi from B.' }]]);
  const r = await call(s);
  assert.equal(r.reply.text, 'Hi from B.');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['credit', 'ok']);
  const again = await call(s);
  assert.deepEqual(again.attempts.map((a) => a.outcome), ['benched', 'ok']);
  s.tick(COOLDOWN_MS + 1);
  assert.deepEqual((await call(s)).attempts.map((a) => a.outcome), ['credit', 'ok']);
  const turns = (await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }))).map((e) => e.data.answeredBy);
  assert.deepEqual(turns, ['model-1', 'model-1', 'model-1']);
});

test('overloaded: two quick retries, then the next model', async () => {
  const s = setup([[{ error: 'overloaded' }, { error: 'overloaded' }, { text: 'Third time lucky.' }]]);
  assert.equal((await call(s)).reply.text, 'Third time lucky.');
  assert.deepEqual(s.waits, [500, 1500]);
  const t = setup([[{ error: 'overloaded' }], [{ text: 'B.' }]]);
  const r = await call(t);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['overloaded', 'overloaded', 'overloaded', 'ok']);
  assert.deepEqual(t.waits, [500, 1500]);
});

test('rate-limited: a short wait is waited out; a long one benches the model for that long', async () => {
  const s = setup([[{ error: 'rate', retryAfter: 2000 }, { text: 'After the wait.' }]]);
  assert.equal((await call(s)).reply.text, 'After the wait.');
  assert.deepEqual(s.waits, [2000]);
  const t = setup([[{ error: 'rate', retryAfter: 60_000 }], [{ text: 'B.' }]]);
  assert.equal((await call(t)).reply.text, 'B.');
  assert.deepEqual(t.waits, []);
  assert.equal(t.bench.until('m-0'), 1_000_000 + 60_000);
});

test('a model that declines has still answered', async () => {
  const s = setup([[{ text: "I can't help with that." }], [{ text: 'B.' }]]);
  const r = await call(s);
  assert.equal(r.reply.text, "I can't help with that.");
  assert.equal(r.attempts.length, 1);
});

test("models that can't take the request are skipped: photos, tools, a window too small", async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }], [{ text: 'C.' }], [{ text: 'D.' }]], {
    models: [{}, { input: ['text', 'image'], tools: false }, { input: ['text', 'image'], contextWindow: 10 }, { input: ['text', 'image'] }],
  });
  const request = {
    messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }, { type: 'text', text: 'What is this?' }] }],
    tools: [{ name: 'look', description: 'Look.', input: { type: 'object' } }],
  };
  const r = await call(s, { request });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['no-images', 'no-tools', 'too-long', 'ok']);
  assert.equal(r.reply.text, 'D.');
});

test('a reply cut off partway is continued by the next model, without repeating it (spec §9.6)', async () => {
  /** @type {any} */
  let seen = null;
  const spy = /** @type {any} */ ({
    type: 'spy', name: 'Spy', pluginId: 'spy',
    run: async function* (/** @type {any} */ c) {
      seen = c.request;
      yield { type: 'text', text: ' the old capital.' };
      yield { type: 'stop', reason: 'end' };
    },
  });
  const s = setup([[{ text: 'Kyoto is', cut: true }], []], { types: [['spy', spy]], endpointTypes: ['scripted', 'spy'] });
  /** @type {string[]} */
  const streamed = [];
  const r = await call(s, { onEvent: (/** @type {any} */ e) => { if (e.type === 'text') streamed.push(e.text); } });
  assert.equal(r.reply.text, 'Kyoto is the old capital.');
  assert.equal(streamed.join(''), 'Kyoto is the old capital.');
  assert.match(seen.messages.at(-1).parts[0].text, /You had already said: "Kyoto is✂"/);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['network', 'ok']);
  assert.equal(continueAfter(hello, 'x').messages.length, 2);
});

test('when every model fails: AllFailedError with every attempt, and the trace still has the turn', async () => {
  const s = setup([[{ error: 'credit' }], [{ error: 'auth' }]]);
  await assert.rejects(call(s), (e) => e instanceof AllFailedError && e.attempts.map((a) => a.outcome).join() === 'credit,auth');
  const [turn] = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.equal(turn.data.answeredBy, null);
  assert.equal(turn.data.attempts.length, 2);
});

test('an empty chat role uses the main list; other roles have only their own', () => {
  /** @type {any} */
  const config = { roles: { main: { models: ['a', 'b'], level: 'medium' }, utility: { models: [], level: 'low' }, decide: { models: ['c'], level: 'off' } } };
  assert.deepEqual(candidates(config, 'utility'), ['a', 'b']);
  assert.deepEqual(candidates(config, 'decide'), ['c']);
  assert.deepEqual(candidates(config, 'speech-out'), []);
});

test('stopping a call stops the fallback too', async () => {
  const s = setup([[{ delayMs: 1000, text: 'Too late.' }], [{ text: 'B.' }]]);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 10);
  await assert.rejects(call(s, { signal: stop.signal }), (e) => e instanceof ProviderError && e.kind === 'cancelled');
});

test('a timeout benches the model and the next one answers', async () => {
  const s = setup([[{ delayMs: 500, text: 'Slow.' }], [{ text: 'B.' }]]);
  const r = await call(s, { firstOutputMs: 20 });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['timeout', 'ok']);
  assert.ok(s.bench.until('m-0') > 1_000_000);
});

test("a role's own wait for the first words decides when a slow model is passed over", async () => {
  const s = setup([[{ delayMs: 1500, text: 'Slow.' }], [{ text: 'B.' }]]);
  s.config.roles.main.firstOutputSeconds = 1;
  const r = await call(s);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['timeout', 'ok']);
});

test('the trace keeps what the answering model reasoned', async () => {
  const s = setup([[{ reasoning: 'They want a greeting.', text: 'Hi.' }]]);
  await call(s);
  const [turn] = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.deepEqual(turn.data.stored, ['reply', 'reasoning']);
});

test('a model whose endpoint type is missing is skipped', async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]], { endpointTypes: ['gone', 'scripted'] });
  assert.deepEqual((await call(s)).attempts.map((a) => a.outcome), ['type-missing', 'ok']);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/llm-fallback.test.js`
Expected: FAIL. The module can't be found: `Cannot find module …/src/core/llm/fallback.js`.

- [ ] **Step 3: Write fallback.js**

Create `src/core/llm/fallback.js`:

```js
import { callOnce } from './call.js';
import { ProviderError } from './contract.js';
import { NO_USAGE, addUsage, addCost } from './cost.js';
import { modelOf, endpointOf, CHAT_ROLES } from './config.js';
import { ROLE_LEVELS } from './reasoning.js';

/**
 * Roles and fallback (spec §9.6). A role's models are tried front to back; an empty chat role uses
 * the main list. Models that can't take the request are skipped, a model that fails rests (it is
 * "benched") for a while, and a model that answers, even to decline, is the answer.
 * @typedef {import('./config.js').ModelConfig} ModelConfig
 * @typedef {import('./config.js').Model} Model
 * @typedef {import('./contract.js').Request} Request
 * @typedef {import('./contract.js').EndpointType} EndpointType
 * @typedef {import('./call.js').Reply} Reply
 * @typedef {import('./trace.js').Attempt} Attempt
 */

export const COOLDOWN_MS = 3 * 60_000;
export const SHORT_WAIT_MS = 10_000;
export const OVERLOAD_RETRIES = Object.freeze([500, 1500]);
export const NETWORK_RETRIES = Object.freeze([1000, 3000]);

/** Models resting after a failure, until a time. One per run of annai. */
export class Bench {
  /** @type {Map<string, number>} */
  #until = new Map();
  /** @param {string} id @param {number} ms */
  bench(id, ms, now = Date.now()) {
    this.#until.set(id, Math.max(this.#until.get(id) ?? 0, now + ms));
  }
  /** @param {string} id */
  until(id) {
    return this.#until.get(id) ?? 0;
  }
  /** @param {string} id */
  clear(id) {
    this.#until.delete(id);
  }
}

/** Every model of a role failed. attempts says how; said is any text a reply had already given. */
export class AllFailedError extends Error {
  /** @param {Attempt[]} attempts @param {string} [said] */
  constructor(attempts, said = '') {
    super("Shiori can't reach her model.");
    this.name = 'AllFailedError';
    this.attempts = attempts;
    this.said = said;
  }
}

/** The models a role tries, in order: its own, or the main list for an empty chat role. @param {ModelConfig} config @param {string} role */
export function candidates(config, role) {
  const own = config.roles[role]?.models ?? [];
  if (own.length || role === 'main' || !CHAT_ROLES.includes(role)) return own;
  return config.roles.main?.models ?? [];
}

/** A rough token count, enough to skip models whose window is clearly too small. @param {Request} request */
export function estimateTokens(request) {
  let chars = (request.system ?? '').length + JSON.stringify(request.tools ?? []).length;
  let images = 0;
  for (const m of request.messages) {
    for (const p of m.parts) {
      if (p.type === 'image') images++;
      else chars += JSON.stringify(p).length;
    }
  }
  return Math.ceil(chars / 3.5) + images * 1600 + (request.maxOutput ?? 0);
}

/** Why a model can't take this request, or null (spec §9.6: the list also handles capability gaps). @param {Model} model @param {Request} request */
export function gap(model, request) {
  if (request.messages.some((m) => m.parts.some((p) => p.type === 'image')) && !model.input.includes('image')) return 'no-images';
  if (request.tools?.length && model.tools === false) return 'no-tools';
  if (model.contextWindow && estimateTokens(request) > model.contextWindow) return 'too-long';
  return null;
}

/** The request again, telling the next model what the cut-off reply had said. @param {Request} request @param {string} said @returns {Request} */
export function continueAfter(request, said) {
  const note = `[annai: your reply was cut off by a connection problem. You had already said: "${said}✂". Continue exactly where it stops, without repeating any of it.]`;
  return { ...request, messages: [...request.messages, { role: 'user', parts: [{ type: 'text', text: note }] }] };
}

/** @param {ProviderError} err @param {number} retry @returns {{ wait?: number, bench?: number }} */
function nextStep(err, retry) {
  switch (err.kind) {
    case 'overloaded':
      return retry < OVERLOAD_RETRIES.length ? { wait: OVERLOAD_RETRIES[retry] } : { bench: COOLDOWN_MS };
    case 'rate':
      return err.retryAfter !== undefined && err.retryAfter <= SHORT_WAIT_MS && retry === 0 ? { wait: err.retryAfter } : { bench: err.retryAfter ?? COOLDOWN_MS };
    case 'network':
    case 'server':
      return retry < NETWORK_RETRIES.length ? { wait: NETWORK_RETRIES[retry] } : { bench: COOLDOWN_MS };
    case 'context':
    case 'image':
    case 'upload':
    case 'bad-request':
      return {};
    default:
      return { bench: COOLDOWN_MS };
  }
}

/** The reply with what an earlier, cut-off reply had said in front of its text. @param {Reply} reply @param {string} said @returns {Reply} */
function prefixed(reply, said) {
  const parts = reply.parts.slice();
  const i = parts.findIndex((p) => p.type === 'text');
  if (i >= 0) parts[i] = { type: 'text', text: said + /** @type {any} */ (parts[i]).text };
  else parts.unshift({ type: 'text', text: said });
  return { ...reply, parts, text: said + reply.text };
}

const defaultSleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls a role's models in order until one answers (spec §9.6), and records the whole call as
 * one model.turn in the trace.
 * @param {{ role: string, request: Request, level?: string, config: ModelConfig, types: Map<string, EndpointType>,
 *   keyFor: (endpointId: string) => Promise<string | null>, bench: Bench, fetch?: import('./call.js').Fetch, signal?: AbortSignal,
 *   onEvent?: (e: import('./contract.js').StreamEvent) => void, trace?: import('./call.js').ModelTrace, registry?: import('../registry.js').Registry,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, firstOutputMs?: number }} c
 * @returns {Promise<{ reply: Reply, attempts: Attempt[], usage: import('./contract.js').Usage, cost: number | undefined, answeredBy: string }>}
 */
export async function callRole(c) {
  const { role, config, types, bench, now = Date.now, sleep = defaultSleep } = c;
  const level = c.level ?? config.roles[role]?.level ?? /** @type {Record<string, string>} */ (ROLE_LEVELS)[role] ?? 'off';
  /** @type {Attempt[]} */
  const attempts = [];
  let request = c.request;
  let said = '';
  let usage = { ...NO_USAGE };
  /** @type {number | undefined} */
  let cost;
  /** @param {string | null} answeredBy @param {string} text @param {string} [stop] @param {string} [reasoning] */
  const record = (answeredBy, text, stop, reasoning) => c.trace?.turn({ role, level, answeredBy, attempts, usage, cost, ...(stop ? { stop } : {}) }, text, reasoning);
  // How long to wait for the first words: the caller's limit, else the role's own setting (spec §9.6: configurable).
  const firstOutputMs = c.firstOutputMs ?? (config.roles[role]?.firstOutputSeconds ?? 30) * 1000;
  for (const id of candidates(config, role)) {
    const rec = config.models[id];
    const epRec = rec ? config.endpoints[rec.endpoint] : undefined;
    const type = epRec ? types.get(epRec.type) : undefined;
    const model = rec ? modelOf(rec) : null;
    const skip = !rec || !epRec || !model ? 'removed' : !type ? 'type-missing' : bench.until(id) > now() ? 'benched' : gap(model, request);
    if (skip || !model || !type || !epRec) {
      attempts.push({ model: id, name: model?.name ?? id, outcome: skip ?? 'removed', ms: 0 });
      continue;
    }
    const endpoint = endpointOf(epRec, type.tunables);
    const key = await c.keyFor(endpoint.id);
    for (let retry = 0; ; retry++) {
      const started = now();
      try {
        const reply = await callOnce({
          type, endpoint, model, key, request, level, fetch: c.fetch, signal: c.signal, onEvent: c.onEvent,
          trace: c.trace, registry: c.registry, now, firstOutputMs,
        });
        usage = addUsage(usage, reply.usage);
        cost = addCost(cost, reply.cost);
        attempts.push({ model: id, name: model.name, outcome: 'ok', ms: now() - started, ...(reply.cost !== undefined ? { cost: reply.cost } : {}) });
        const full = said ? prefixed(reply, said) : reply;
        const reasoning = full.parts.map((p) => (p.type === 'reasoning' ? p.text : '')).filter(Boolean).join('\n\n');
        await record(model.name, full.text, reply.stop, reasoning);
        return { reply: full, attempts, usage, cost, answeredBy: model.name };
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError('plugin', String(/** @type {any} */ (e)?.message ?? e));
        attempts.push({ model: id, name: model.name, outcome: err.kind, ms: now() - started, error: err.message });
        if (err.kind === 'cancelled') {
          await record(null, said + err.partial);
          throw err;
        }
        if (err.partial) {
          // Handled like an interruption: the next model continues from here.
          said += err.partial;
          request = continueAfter(c.request, said);
          break;
        }
        const step = nextStep(err, retry);
        if (step.wait !== undefined) {
          await sleep(step.wait);
          continue;
        }
        if (step.bench !== undefined) bench.bench(id, step.bench, now());
        break;
      }
    }
  }
  await record(null, said);
  throw new AllFailedError(attempts, said);
}
```

In `sw.js`, add to `SHELL` after `'/src/core/llm/contract.js',`:

```js
  '/src/core/llm/fallback.js',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/llm-fallback.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: all green.

```bash
git add src/core/llm/fallback.js sw.js test/unit/llm-fallback.test.js
git commit -m "Roles and fallback: retries, benching, capability gaps, continuing a cut-off reply"
```

---

### Task 10: Templates, and one service for the UI

**Files:**
- Create: `catalog/templates.json`
- Create: `src/core/llm/templates.js`, `src/core/llm/service.js`
- Modify: `src/app/main.js` (create the service; tell it when plugins can load)
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/llm-templates.test.js`

**Interfaces:**
- Consumes:
  - from Task 4: `readConfig`, `newEndpoint`, `newModel`, `saveEndpoint`, `saveModel`, `saveRoles`, `setKey`, `getKey`, `modelOf`, `endpointOf`
  - `ensureType` (Task 5), `callRole` and `Bench` (Task 9), `modelTrace` (Task 8)
  - `endpointTypes`, `ProviderError` and `errorFromResponse` (Tasks 1 and 5)
- Produces:
  - **From `templates.js`:**
    - the types `EndpointTemplate` and `TemplateCatalog`
    - `loadTemplates({ ws, fetch?, base? }): Promise<TemplateCatalog>`
    - `addFromTemplate({ ws, store }, tpl, { key?, roles? }): Promise<string>`, which returns the endpoint id. `roles` is `'recommended'`, `'free'` or `null`; only empty roles are filled.
    - `useSuggestion({ ws }, endpointId, tpl, which)`, which overwrites the roles the suggestion names
    - `templateUpdates(config, catalog): { endpoint: string, template: EndpointTemplate }[]`
    - `applyTemplate({ ws }, endpointId, tpl)`
    - `addListedModel({ ws }, endpointId, listed): Promise<string>`
  - **From `service.js`:** `createLlm({ store, ws, plugins, fetch?, base?, ready?, pluginsCanLoad? })` returns `{ bench, ready, types(), config(), templates(), keyFor(id), ensureType(type), call({ role?, request, level?, onEvent?, signal?, scope? }), listModels(endpointId) }`.
    - `call` resolves to what `callRole` returns.
    - The UI reaches the service as `ctx.llm`.

- [ ] **Step 1: Write the catalog**

Create `catalog/templates.json`. The OpenRouter and Anthropic entries come from OpenRouter's model list of 2026-10-15. Prices are USD per million tokens. The reasoning maps follow each provider's current controls (see Verified facts):

```json
{
  "format": 1,
  "endpoints": [
    {
      "id": "openrouter", "version": 1, "type": "chat-completions", "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "headers": { "HTTP-Referer": "https://annai.guide", "X-Title": "annai" },
      "tunables": { "reasoningField": "reasoning" },
      "keyUrl": "https://openrouter.ai/settings/keys",
      "signIn": "openrouter",
      "note": "One key for many providers. Free models allow 50 requests a day (1,000 a day after $10 of credits).",
      "models": [
        { "providerId": "anthropic/claude-sonnet-5.5", "name": "Anthropic: Claude Sonnet 5.5", "contextWindow": 1000000, "maxOutput": 128000, "input": ["text", "image"], "tools": true,
          "prices": { "input": 2, "output": 10, "cacheRead": 0.1, "cacheWrite": 2.5, "cacheWrite1h": 4 },
          "reasoning": { "low": { "reasoning": { "effort": "low" } }, "medium": { "reasoning": { "effort": "medium" } }, "high": { "reasoning": { "effort": "high" } } } },
        { "providerId": "anthropic/claude-haiku-5.5", "name": "Anthropic: Claude Haiku 5.5", "contextWindow": 1000000, "maxOutput": 128000, "input": ["text", "image"], "tools": true,
          "prices": { "input": 0.1, "output": 0.5, "cacheRead": 0.01, "cacheWrite": 0.125, "cacheWrite1h": 0.2,
            "tiers": [{ "above": 99999, "input": 0.5, "output": 2.5, "cacheRead": 0.05, "cacheWrite": 0.625, "cacheWrite1h": 1 }] },
          "reasoning": { "low": { "reasoning": { "effort": "low" } }, "medium": { "reasoning": { "effort": "medium" } }, "high": { "reasoning": { "effort": "high" } } } },
        { "providerId": "anthropic/claude-opus-5.5", "name": "Anthropic: Claude Opus 5.5", "contextWindow": 1000000, "maxOutput": 128000, "input": ["text", "image"], "tools": true,
          "prices": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 5, "cacheWrite1h": 8 },
          "reasoning": { "low": { "reasoning": { "effort": "low" } }, "medium": { "reasoning": { "effort": "medium" } }, "high": { "reasoning": { "effort": "high" } } } },
        { "providerId": "google/gemma-4-31b-it:free", "name": "Google: Gemma 4 31B (free)", "contextWindow": 262144, "maxOutput": 32768, "input": ["text", "image"], "tools": true,
          "prices": { "input": 0, "output": 0 } },
        { "providerId": "google/gemma-4-26b-a4b-it:free", "name": "Google: Gemma 4 26B A4B (free)", "contextWindow": 262144, "maxOutput": 32768, "input": ["text", "image"], "tools": true,
          "prices": { "input": 0, "output": 0 } }
      ],
      "roles": {
        "free": { "main": ["google/gemma-4-31b-it:free"], "utility": ["google/gemma-4-26b-a4b-it:free"], "decide": ["google/gemma-4-26b-a4b-it:free"] },
        "recommended": { "main": ["anthropic/claude-sonnet-5.5"], "utility": ["anthropic/claude-haiku-5.5"], "decide": ["anthropic/claude-haiku-5.5"] }
      }
    },
    {
      "id": "anthropic", "version": 1, "type": "anthropic-messages", "name": "Anthropic",
      "baseUrl": "https://api.anthropic.com",
      "keyUrl": "https://platform.claude.com/settings/keys",
      "models": [
        { "providerId": "claude-sonnet-5-5", "name": "Claude Sonnet 5.5", "contextWindow": 1000000, "maxOutput": 128000, "input": ["text", "image"], "tools": true,
          "prices": { "input": 2, "output": 10, "cacheRead": 0.1, "cacheWrite": 2.5, "cacheWrite1h": 4 }, "cacheTtls": ["5m", "1h"],
          "reasoning": { "off": { "thinking": { "type": "between_tools" } }, "low": { "output_config": { "effort": "low" } }, "medium": { "output_config": { "effort": "medium" } }, "high": { "output_config": { "effort": "high" } }, "max": { "output_config": { "effort": "max" } } } },
        { "providerId": "claude-haiku-5-5", "name": "Claude Haiku 5.5", "contextWindow": 1000000, "maxOutput": 128000, "input": ["text", "image"], "tools": true,
          "prices": { "input": 0.1, "output": 0.5, "cacheRead": 0.01, "cacheWrite": 0.125, "cacheWrite1h": 0.2,
            "tiers": [{ "above": 99999, "input": 0.5, "output": 2.5, "cacheRead": 0.05, "cacheWrite": 0.625, "cacheWrite1h": 1 }] }, "cacheTtls": ["5m", "1h"],
          "reasoning": { "off": { "thinking": { "type": "disabled" } }, "low": { "output_config": { "effort": "low" } }, "medium": { "output_config": { "effort": "medium" } }, "high": { "output_config": { "effort": "high" } } } },
        { "providerId": "claude-opus-5-5", "name": "Claude Opus 5.5", "contextWindow": 1000000, "maxOutput": 128000, "input": ["text", "image"], "tools": true,
          "prices": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 5, "cacheWrite1h": 8 }, "cacheTtls": ["5m", "1h"],
          "reasoning": { "low": { "output_config": { "effort": "low" } }, "medium": { "output_config": { "effort": "medium" } }, "high": { "output_config": { "effort": "high" } }, "max": { "output_config": { "effort": "max" } } } }
      ],
      "roles": { "recommended": { "main": ["claude-sonnet-5-5"], "utility": ["claude-haiku-5-5"], "decide": ["claude-haiku-5-5"] } }
    },
    { "id": "openai", "version": 1, "type": "chat-completions", "name": "OpenAI", "baseUrl": "https://api.openai.com/v1",
      "tunables": { "maxTokensField": "max_completion_tokens", "systemRole": "developer" }, "keyUrl": "https://platform.openai.com/api-keys",
      "note": "Add models with Fetch model list." },
    { "id": "gemini", "version": 1, "type": "chat-completions", "name": "Google Gemini", "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
      "keyUrl": "https://aistudio.google.com/apikey", "note": "Uses Gemini's OpenAI-compatible endpoint. Add models with Fetch model list." },
    { "id": "groq", "version": 1, "type": "chat-completions", "name": "Groq", "baseUrl": "https://api.groq.com/openai/v1", "keyUrl": "https://console.groq.com/keys" },
    { "id": "deepseek", "version": 1, "type": "chat-completions", "name": "DeepSeek", "baseUrl": "https://api.deepseek.com",
      "tunables": { "reasoningField": "reasoning_content" }, "keyUrl": "https://platform.deepseek.com/api_keys" },
    { "id": "mistral", "version": 1, "type": "chat-completions", "name": "Mistral", "baseUrl": "https://api.mistral.ai/v1", "keyUrl": "https://console.mistral.ai/api-keys" },
    { "id": "local", "version": 1, "type": "chat-completions", "name": "Local server (Ollama, LM Studio, llama.cpp)", "baseUrl": "http://localhost:11434/v1",
      "note": "On a phone, the server needs an HTTPS address, such as a tunnel: localhost only reaches the device annai runs on." },
    { "id": "custom-chat-completions", "version": 1, "type": "chat-completions", "name": "Other: Chat Completions", "baseUrl": "" },
    { "id": "custom-anthropic", "version": 1, "type": "anthropic-messages", "name": "Other: Anthropic Messages", "baseUrl": "https://api.anthropic.com" },
    { "id": "scripted", "version": 1, "type": "scripted", "name": "Scripted model (for testing)",
      "models": [{ "providerId": "scripted", "name": "Scripted", "contextWindow": 200000, "maxOutput": 4096, "input": ["text", "image"], "tools": true, "prices": { "input": 0, "output": 0 } }] }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/unit/llm-templates.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { readConfig, modelOf, endpointOf, getKey, saveEndpoint, saveRoles } from '../../src/core/llm/config.js';
import { loadTemplates, addFromTemplate, useSuggestion, templateUpdates, applyTemplate, addListedModel } from '../../src/core/llm/templates.js';
import { createLlm } from '../../src/core/llm/service.js';

const root = new URL('../../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('catalog/templates.json', root), 'utf8'));
const tpl = (/** @type {string} */ id) => catalog.endpoints.find((/** @type {any} */ t) => t.id === id);

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  return { registry, store, ws };
}

/** A fetch that serves this repository's files, as annai's own origin would. */
const repoFetch = async (/** @type {any} */ url) => {
  try {
    return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
  } catch {
    return new Response('not found', { status: 404 });
  }
};

test("catalog/templates.json: types annai can install, ids that are unique, suggestions it can keep", async () => {
  const plugins = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8')).plugins;
  const provided = new Set(plugins.flatMap((/** @type {any} */ p) => p.provides?.['endpoint-type'] ?? []));
  const ids = new Set();
  for (const t of catalog.endpoints) {
    assert.ok(provided.has(t.type), `${t.id}: no plugin provides ${t.type}`);
    assert.ok(!ids.has(t.id), `${t.id} twice`);
    ids.add(t.id);
    const providers = new Set((t.models ?? []).map((/** @type {any} */ m) => m.providerId));
    for (const m of t.models ?? []) assert.ok(typeof m.prices?.input === 'number' && typeof m.prices?.output === 'number', `${t.id}/${m.providerId}: prices`);
    for (const suggestion of Object.values(t.roles ?? {})) {
      for (const list of Object.values(/** @type {Record<string, string[]>} */ (suggestion))) for (const p of list) assert.ok(providers.has(p), `${t.id}: suggests ${p}`);
    }
  }
});

test('adding from a template: the endpoint, its models, its key, and suggested models for empty roles only', async () => {
  const { ws, store } = await setup();
  const or = await addFromTemplate({ ws, store }, tpl('openrouter'), { key: 'sk-or-test-1', roles: 'free' });
  let cfg = await readConfig(ws);
  assert.equal(endpointOf(cfg.endpoints[or]).baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(cfg.endpoints[or].template?.id, 'openrouter');
  assert.equal(Object.values(cfg.models).length, 5);
  assert.equal(await getKey(store, or), 'sk-or-test-1');
  const name = (/** @type {string} */ id) => modelOf(cfg.models[id]).name;
  assert.deepEqual(cfg.roles.main.models.map(name), ['Google: Gemma 4 31B (free)']);
  assert.deepEqual(cfg.roles.utility.models.map(name), ['Google: Gemma 4 26B A4B (free)']);
  await addFromTemplate({ ws, store }, tpl('anthropic'), { roles: 'recommended' });
  cfg = await readConfig(ws);
  assert.deepEqual(cfg.roles.main.models.map(name), ['Google: Gemma 4 31B (free)'], 'a role the user already has is kept');
  await useSuggestion({ ws }, or, tpl('openrouter'), 'recommended');
  cfg = await readConfig(ws);
  assert.deepEqual(cfg.roles.main.models.map(name), ['Anthropic: Claude Sonnet 5.5']);
});

test('adding the same template twice gives the second set of models names of their own', async () => {
  const { ws, store } = await setup();
  await addFromTemplate({ ws, store }, tpl('anthropic'), { roles: null });
  await addFromTemplate({ ws, store }, tpl('anthropic'), { roles: null });
  const names = Object.values((await readConfig(ws)).models).map((m) => modelOf(m).name).sort();
  assert.ok(names.includes('Claude Haiku 5.5') && names.includes('Claude Haiku 5.5 (2)'), names.join());
});

test("a newer template is offered, and applying it keeps the user's own changes (spec §9.8)", async () => {
  const { ws, store } = await setup();
  const id = await addFromTemplate({ ws, store }, tpl('anthropic'), { roles: null });
  let cfg = await readConfig(ws);
  const rec = cfg.endpoints[id];
  await saveEndpoint(ws, { ...rec, user: { name: 'My Anthropic' } });
  const v2 = structuredClone(tpl('anthropic'));
  v2.version = 2;
  v2.baseUrl = 'https://api2.anthropic.com';
  v2.models[1].contextWindow = 2000000;
  const newer = { ...catalog, endpoints: [v2] };
  cfg = await readConfig(ws);
  assert.deepEqual(templateUpdates(cfg, newer).map((u) => u.endpoint), [id]);
  assert.deepEqual(templateUpdates(cfg, catalog), []);
  await applyTemplate({ ws }, id, v2);
  cfg = await readConfig(ws);
  const e = endpointOf(cfg.endpoints[id]);
  assert.equal(e.name, 'My Anthropic');
  assert.equal(e.baseUrl, 'https://api2.anthropic.com');
  const haiku = Object.values(cfg.models).map(modelOf).find((m) => m.providerId === 'claude-haiku-5-5');
  assert.equal(haiku?.contextWindow, 2000000);
  assert.deepEqual(templateUpdates(cfg, newer), []);
});

test('a model from a fetched list keeps what the list said, under a name of its own', async () => {
  const { ws, store } = await setup();
  const id = await addFromTemplate({ ws, store }, tpl('openrouter'), { roles: null });
  const m = await addListedModel({ ws }, id, { providerId: 'x/haiku', name: 'Anthropic: Claude Haiku 5.5', contextWindow: 1000, tools: true });
  const model = modelOf((await readConfig(ws)).models[m]);
  assert.equal(model.name, 'Anthropic: Claude Haiku 5.5 (2)');
  assert.equal(model.contextWindow, 1000);
});

test("templates load when online and come from last time's copy when offline", async () => {
  const { ws } = await setup();
  const online = await loadTemplates({ ws, fetch: repoFetch });
  assert.equal(online.endpoints[0].id, 'openrouter');
  const offline = await loadTemplates({ ws, fetch: async () => { throw new TypeError('offline'); } });
  assert.deepEqual(offline, online);
  const { ws: fresh } = await setup();
  assert.deepEqual(await loadTemplates({ ws: fresh, fetch: async () => { throw new TypeError('offline'); } }), { format: 1, endpoints: [] });
});

test('the service: installs an endpoint type on demand, calls a role with fallback, traces it, lists models', async () => {
  const { registry, store, ws } = await setup();
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const plugins = new PluginHost({ registry, workspace: ws, importModule });
  const llm = createLlm({ store, ws, plugins, fetch: repoFetch });
  await llm.ensureType('scripted');
  const id = await addFromTemplate({ ws, store }, tpl('scripted'), { roles: null });
  const cfg = await readConfig(ws);
  await saveRoles(ws, { ...cfg.roles, main: { models: Object.keys(cfg.models), level: 'medium' } });
  const r = await llm.call({ request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } });
  assert.equal(r.reply.text, 'Hello from the scripted model.');
  assert.equal(r.answeredBy, 'Scripted');
  const kinds = (await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS))).map((e) => e.type);
  assert.ok(kinds.includes('net.request') && kinds.includes('model.turn'), kinds.join());
  assert.deepEqual((await llm.listModels(id)).map((m) => m.providerId), ['scripted']);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test test/unit/llm-templates.test.js`
Expected: FAIL. The module can't be found: `Cannot find module …/src/core/llm/templates.js`.

- [ ] **Step 4: Write templates.js**

Create `src/core/llm/templates.js`:

```js
import { SYS_SETTINGS } from '../scopes.js';
import { readConfig, newEndpoint, newModel, saveEndpoint, saveModel, saveRoles, setKey, modelOf } from './config.js';

/**
 * Templates (spec §9.8): annai's catalog of endpoints and popular models, with their
 * capabilities, prices, reasoning maps and quirks. The user's settings are copies: a template's
 * values become the template layer of an endpoint or model, and a newer template is offered,
 * never applied silently.
 * @typedef {import('./config.js').ModelValues & { providerId: string }} TemplateModel
 * @typedef {{ id: string, version: number, type: string, name: string, baseUrl?: string, headers?: Record<string, string>,
 *   tunables?: Record<string, any>, extraBody?: Record<string, any>, keyUrl?: string, note?: string, signIn?: string,
 *   models?: TemplateModel[], roles?: Record<string, Record<string, string[]>> }} EndpointTemplate
 * @typedef {{ format: number, endpoints: EndpointTemplate[] }} TemplateCatalog
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {import('../types.js').Store} Store
 * @typedef {import('./config.js').Roles} Roles
 */

const CACHE = '/llm/catalog/templates.json';
/** @type {TemplateCatalog} */
const EMPTY = Object.freeze({ format: 1, endpoints: [] });

/** @param {any} json @returns {json is TemplateCatalog} */
function valid(json) {
  return json?.format === 1 && Array.isArray(json.endpoints)
    && json.endpoints.every((/** @type {any} */ t) => typeof t?.id === 'string' && typeof t.type === 'string' && typeof t.name === 'string' && Number.isInteger(t.version));
}

/**
 * annai's templates, fetched when online and kept for offline use (spec §9.8).
 * @param {{ ws: Workspace, fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string }} c
 * @returns {Promise<TemplateCatalog>}
 */
export async function loadTemplates({ ws, fetch: get = (url, init) => fetch(url, init), base = '' }) {
  try {
    const res = await get(`${base}/catalog/templates.json`, { cache: 'no-cache' });
    if (res.ok) {
      const json = await res.json();
      if (valid(json)) {
        await ws.write(SYS_SETTINGS, CACHE, json, { author: 'system' }).catch(() => {});
        return json;
      }
    }
  } catch {
    // offline: the copy from last time
  }
  const cached = await ws.readJSON(SYS_SETTINGS, CACHE).catch(() => null);
  return valid(cached) ? cached : EMPTY;
}

/** @param {EndpointTemplate} tpl @returns {import('./config.js').EndpointValues} */
function endpointValues(tpl) {
  /** @type {import('./config.js').EndpointValues} */
  const v = { name: tpl.name, baseUrl: tpl.baseUrl ?? '' };
  if (tpl.headers) v.headers = tpl.headers;
  if (tpl.tunables) v.tunables = tpl.tunables;
  if (tpl.extraBody) v.extraBody = tpl.extraBody;
  return v;
}

/** name, or "name (2)", "name (3)"…: the first no other model has. @param {string} name @param {Set<string>} taken lower-case names */
function uniqueName(name, taken) {
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const n = `${name} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/**
 * Roles with a template's suggestion filled in. With onlyEmpty, roles the user has set are kept.
 * @param {Roles} roles @param {Map<string, string>} byProvider provider model id → model id
 * @param {Record<string, string[]> | undefined} suggestion @param {boolean} onlyEmpty
 */
function suggested(roles, byProvider, suggestion, onlyEmpty) {
  const next = structuredClone(roles);
  for (const [role, providers] of Object.entries(suggestion ?? {})) {
    if (onlyEmpty && next[role]?.models.length) continue;
    const models = providers.map((p) => byProvider.get(p)).filter((x) => typeof x === 'string');
    if (models.length) next[role] = { models, level: next[role]?.level ?? 'off' };
  }
  return next;
}

/**
 * Adds an endpoint from a template: the endpoint, its models (each under a name no other model
 * has), its key, and the template's suggested models for roles that are still empty.
 * @param {{ ws: Workspace, store: Store }} c @param {EndpointTemplate} tpl
 * @param {{ key?: string | null, roles?: string | null }} [opts] roles: which suggestion ("recommended", "free"), or none
 * @returns {Promise<string>} the endpoint's id
 */
export async function addFromTemplate({ ws, store }, tpl, { key = null, roles = 'recommended' } = {}) {
  const cfg = await readConfig(ws);
  const taken = new Set(Object.values(cfg.models).map((m) => modelOf(m).name.toLowerCase()));
  const endpoint = newEndpoint(tpl.type, { template: { id: tpl.id, version: tpl.version, values: endpointValues(tpl) } });
  const models = (tpl.models ?? []).map((m) => {
    const rec = newModel(endpoint.id, { template: { id: `${tpl.id}/${m.providerId}`, version: tpl.version, values: m } });
    const name = modelOf(rec).name;
    const unique = uniqueName(name, taken);
    taken.add(unique.toLowerCase());
    if (unique !== name) rec.user = { name: unique };
    return rec;
  });
  await saveEndpoint(ws, endpoint, models);
  if (key) await setKey(store, endpoint.id, key);
  const suggestion = roles ? tpl.roles?.[roles] : undefined;
  if (suggestion) {
    const byProvider = new Map(models.map((m) => [modelOf(m).providerId, m.id]));
    await saveRoles(ws, suggested(cfg.roles, byProvider, suggestion, true));
  }
  return endpoint.id;
}

/**
 * Puts a template's suggestion ("free", "recommended") in the roles it names, replacing what
 * they had, using this endpoint's models.
 * @param {{ ws: Workspace }} c @param {string} endpointId @param {EndpointTemplate} tpl @param {string} which
 */
export async function useSuggestion({ ws }, endpointId, tpl, which) {
  const cfg = await readConfig(ws);
  const byProvider = new Map(Object.values(cfg.models).filter((m) => m.endpoint === endpointId).map((m) => [modelOf(m).providerId, m.id]));
  await saveRoles(ws, suggested(cfg.roles, byProvider, tpl.roles?.[which], false));
}

/**
 * Endpoints made from a template that annai's catalog now has a newer version of.
 * @param {import('./config.js').ModelConfig} cfg @param {TemplateCatalog} catalog
 * @returns {{ endpoint: string, template: EndpointTemplate }[]}
 */
export function templateUpdates(cfg, catalog) {
  const byId = new Map(catalog.endpoints.map((t) => [t.id, t]));
  /** @type {{ endpoint: string, template: EndpointTemplate }[]} */
  const out = [];
  for (const e of Object.values(cfg.endpoints)) {
    const t = e.template ? byId.get(e.template.id) : undefined;
    if (t && e.template && t.version > e.template.version) out.push({ endpoint: e.id, template: t });
  }
  return out;
}

/**
 * Applies a newer template to an endpoint and to the models it made: only their template layers
 * change, so the user's own changes stay.
 * @param {{ ws: Workspace }} c @param {string} endpointId @param {EndpointTemplate} tpl
 */
export async function applyTemplate({ ws }, endpointId, tpl) {
  const cfg = await readConfig(ws);
  const endpoint = cfg.endpoints[endpointId];
  const byProvider = new Map((tpl.models ?? []).map((m) => [m.providerId, m]));
  const models = Object.values(cfg.models)
    .filter((m) => m.endpoint === endpointId && m.template?.id.startsWith(`${tpl.id}/`))
    .map((m) => {
      const values = byProvider.get(modelOf(m).providerId);
      return values && m.template ? { ...m, template: { id: m.template.id, version: tpl.version, values } } : m;
    });
  await saveEndpoint(ws, { ...endpoint, template: { id: tpl.id, version: tpl.version, values: endpointValues(tpl) } }, models);
}

/**
 * Adds a model from an endpoint's fetched list: what the list said is its template layer.
 * @param {{ ws: Workspace }} c @param {string} endpointId @param {import('./contract.js').ListedModel} listed
 * @returns {Promise<string>} the model's id
 */
export async function addListedModel({ ws }, endpointId, listed) {
  const cfg = await readConfig(ws);
  const taken = new Set(Object.values(cfg.models).map((m) => modelOf(m).name.toLowerCase()));
  const rec = newModel(endpointId, { template: { id: `list/${listed.providerId}`, version: 0, values: listed } });
  const name = modelOf(rec).name;
  const unique = uniqueName(name, taken);
  if (unique !== name) rec.user = { name: unique };
  await saveModel(ws, rec);
  return rec.id;
}
```

- [ ] **Step 5: Write service.js**

Create `src/core/llm/service.js`:

```js
import { SYS } from '../scopes.js';
import { readConfig, getKey, endpointOf } from './config.js';
import { endpointTypes, ProviderError, errorFromResponse } from './contract.js';
import { ensureType } from './official.js';
import { loadTemplates } from './templates.js';
import { callRole, Bench } from './fallback.js';
import { modelTrace } from './trace.js';

/**
 * Everything the UI needs to talk to models (spec §9): settings, endpoint types installed on
 * demand, templates, and role calls with fallback, traced.
 * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, plugins: import('../plugins.js').PluginHost,
 *   fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string, ready?: Promise<unknown>, pluginsCanLoad?: () => Promise<unknown> }} c
 *   ready: settles once the installed plugins have started; pluginsCanLoad: settles when a plugin's files can be loaded
 *   (in browsers, once a service worker controls the page)
 */
export function createLlm({ store, ws, plugins, fetch: get = (url, init) => fetch(url, init), base = '', ready = Promise.resolve(), pluginsCanLoad = () => Promise.resolve() }) {
  const bench = new Bench();
  const types = () => endpointTypes(plugins.registry);
  /** @param {string} type */
  const ensure = async (type) => {
    await ready;
    if (types().has(type)) return;
    await pluginsCanLoad();
    await ensureType(plugins, type, { fetch: get, base });
  };
  return {
    bench,
    ready,
    types,
    config: () => readConfig(ws),
    templates: () => loadTemplates({ ws, fetch: get, base }),
    /** @param {string} id */
    keyFor: (id) => getKey(store, id),
    ensureType: ensure,
    /**
     * A role call with fallback, traced in scope (spec §9.6).
     * @param {{ role?: string, request: import('./contract.js').Request, level?: string, onEvent?: (e: import('./contract.js').StreamEvent) => void,
     *   signal?: AbortSignal, scope?: string }} c
     */
    async call({ role = 'main', request, level, onEvent, signal, scope = SYS }) {
      await ready;
      return callRole({
        role, request, level, config: await readConfig(ws), types: types(), keyFor: (id) => getKey(store, id), bench,
        fetch: get, signal, onEvent, trace: modelTrace(store, scope), registry: plugins.registry,
      });
    },
    /** The models an endpoint offers: its "fetch model list" (spec §9.2). @param {string} endpointId @returns {Promise<import('./contract.js').ListedModel[]>} */
    async listModels(endpointId) {
      const rec = (await readConfig(ws)).endpoints[endpointId];
      if (!rec) throw new ProviderError('not-found', 'That endpoint no longer exists.');
      await ensure(rec.type);
      const type = /** @type {import('./contract.js').EndpointType} */ (types().get(rec.type));
      const endpoint = endpointOf(rec, type.tunables);
      const key = await getKey(store, endpointId);
      if (type.list) return type.list({ endpoint, key });
      if (!type.listRequest || !type.readList) throw new ProviderError('bad-request', "This endpoint type can't list its models. Add them by id.");
      const r = type.listRequest({ endpoint, key });
      /** @type {Response} */
      let res;
      try {
        res = await get(r.url, { headers: r.headers });
      } catch (e) {
        throw new ProviderError('unreachable', String(/** @type {any} */ (e)?.message ?? e));
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = errorFromResponse(res.status, text, res.headers);
        const sharper = type.classify?.(res.status, text);
        if (sharper) err.kind = sharper;
        throw err;
      }
      return type.readList(await res.json());
    },
  };
}
```

In `sw.js`, add to `SHELL` after `'/src/core/llm/sse.js',`:

```js
  '/src/core/llm/service.js',
```

And after `'/src/core/llm/sse.js',`, also add:

```js
  '/src/core/llm/templates.js',
```

- [ ] **Step 6: Create the service when annai starts**

In `src/app/main.js`, add the import:

```js
import { createLlm } from '../core/llm/service.js';
```

In `boot()`, replace these lines:

```js
  const plugins = new PluginHost({ registry, workspace: ws });
  await plugins.addBuiltin(new URL('../plugins/core-schemas/index.js', import.meta.url).href);

  const shell = startShell(root, { store, ws, registry, plugins, version: VERSION });
```

with:

```js
  const plugins = new PluginHost({ registry, workspace: ws });
  await plugins.addBuiltin(new URL('../plugins/core-schemas/index.js', import.meta.url).href);
  /** @type {(v?: unknown) => void} */
  let pluginsStarted = () => {};
  const llm = createLlm({ store, ws, plugins, ready: new Promise((resolve) => { pluginsStarted = resolve; }), pluginsCanLoad: controllerReady });

  const shell = startShell(root, { store, ws, registry, plugins, llm, version: VERSION });
```

Replace `  startPlugins(plugins, shell);` with:

```js
  startPlugins(plugins, shell).finally(() => pluginsStarted());
```

Add this function below `startPlugins`:

```js
/**
 * Settles once a service worker controls this page (or after 15 s), because installed plugin
 * files load through it (spec §5.3). On a first visit that takes a moment.
 */
function controllerReady(timeoutMs = 15_000) {
  if (!('serviceWorker' in navigator) || navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      resolve(undefined);
    };
    const t = setTimeout(done, timeoutMs);
    navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
  });
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/unit/llm-templates.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 8: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: all green.

```bash
git add catalog/templates.json src/core/llm/templates.js src/core/llm/service.js src/app/main.js sw.js test/unit/llm-templates.test.js
git commit -m "Templates for ten endpoints, kept for offline use, and the service the UI talks to models through"
```

---

### Task 11: Settings → Models

**Files:**
- Modify: `src/ui/dom.js` (add `jsonField`)
- Modify: `src/ui/format.js` (add `formatCost` and `outcomeText`)
- Create: `src/ui/screens/models.js`, `src/ui/screens/endpoint.js`, `src/ui/screens/model.js`
- Modify: `src/ui/shell.js` (the `models` screen), `src/ui/router.js` (doc comment), `src/ui/screens/settings.js` (a Models section)
- Modify: `src/ui/base.css`, `sw.js` (`SHELL`)
- Test: `test/unit/ui-pure.test.js`, `test/e2e/models.spec.js`

**Interfaces:**
- Consumes:
  - `ctx.llm` (Task 10)
  - from Task 4: `endpointOf`, `endpointBase`, `modelOf`, `modelBase`, `diffLayer`, `newModel`, `saveEndpoint`, `saveModel`, `saveRoles`, `setKey`, `removeEndpoint`, `removeModel`, `CHAT_ROLES`
  - from Task 10: `addFromTemplate`, `templateUpdates`, `applyTemplate`, `addListedModel`
  - `LEVELS` (Task 2)
- Produces:
  - `jsonField(label, id, value): { el, read() }`
  - `formatCost(usd?: number): string`
  - `outcomeText(outcome: string): string`
  - `messageOf(error): string`, exported from `endpoint.js`
  - **Routes:** `#/models`, `#/models/endpoint?id=…` and `#/models/model?id=…`.
  - **Labels** the end-to-end tests rely on:
    - The Models screen:
      - "Add an endpoint", with an "Add" button
      - "Add a model to <role>", with an "Add to <role>" button
      - "Reasoning for <role>"
      - "Wait for the first words (seconds)"
      - role rows that read "1. <model name>"
    - The endpoint page:
      - "Name", "Base URL" and "API key"
      - "Save"
      - "Add a model by id", with an "Add model" button
      - "Fetch model list"
      - a "← Models" link
    - The model page:
      - "Name", "Provider model id", "Takes photos", "Calls tools"
      - "Context window (tokens)" and "Maximum output (tokens)"
      - "Save"

- [ ] **Step 1: Write the failing unit tests**

In `test/unit/ui-pure.test.js`, add `formatCost` and `outcomeText` to the format import:

```js
import { relTime, bytes, dateRange, takenText, backupText, formatCost, outcomeText } from '../../src/ui/format.js';
```

Then add:

```js
test('formatCost: free, small, ordinary and unknown costs', () => {
  assert.equal(formatCost(0), 'free');
  assert.equal(formatCost(0.000125), '$0.0001');
  assert.equal(formatCost(0.0042), '$0.0042');
  assert.equal(formatCost(1.234), '$1.23');
  assert.equal(formatCost(undefined), 'cost unknown');
});

test('outcomeText: what happened to a model, in a few words', () => {
  assert.equal(outcomeText('credit'), 'out of credit');
  assert.equal(outcomeText('benched'), 'resting after an error');
  assert.equal(outcomeText('no-images'), "doesn't take photos");
  assert.equal(outcomeText('something-new'), 'something-new');
});
```

- [ ] **Step 2: Write the failing end-to-end tests**

Create `test/e2e/models.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker } from './helpers.js';

/**
 * From the Models screen: adds an endpoint from a template (installing its plugin), names it,
 * sets its base URL and key, adds one model by id, and comes back.
 * @param {import('@playwright/test').Page} page @param {string} template
 * @param {{ name: string, url: string, key: string, model: string }} o
 */
export async function addEndpoint(page, template, { name, url, key, model }) {
  await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
  await page.getByLabel('Add an endpoint').selectOption({ label: template });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: template })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Base URL').fill(url);
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByLabel('Add a model by id').fill(model);
  await page.getByRole('button', { name: 'Add model' }).click();
  await expect(page.getByRole('link', { name: new RegExp(`^${model}`) })).toBeVisible();
  await page.getByRole('link', { name: '← Models' }).click();
}

test('endpoints, models and roles are set in Settings → Models, survive a reload, and the key is never shown', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Chat Completions', { name: 'Endpoint A', url: 'https://a.example.test/v1', key: 'sk-test-secret-a', model: 'a-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'a-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await expect(page.getByText('1. a-model')).toBeVisible();
  await page.getByLabel('Reasoning for main').selectOption('high');
  await expect(page.getByLabel('Reasoning for main')).toHaveValue('high');
  await page.reload();
  await expect(page.getByText('1. a-model')).toBeVisible();
  await expect(page.getByLabel('Reasoning for main')).toHaveValue('high');
  await page.getByRole('link', { name: /Endpoint A/ }).click();
  await expect(page.getByLabel('API key')).toHaveValue('');
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /saved/);
  expect(await page.content()).not.toContain('sk-test-secret-a');
});

test('a model is edited on its own page', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Chat Completions', { name: 'Endpoint A', url: 'https://a.example.test/v1', key: 'sk-a', model: 'a-model' });
  await page.getByRole('link', { name: /Endpoint A/ }).click();
  await page.getByRole('link', { name: /^a-model/ }).click();
  await expect(page.getByLabel('Provider model id')).toHaveValue('a-model');
  await page.getByLabel('Name', { exact: true }).fill('Fast one');
  await page.getByLabel('Context window (tokens)').fill('32000');
  await page.getByLabel('Takes photos').check();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('link', { name: '← Endpoint A' }).click();
  await expect(page.getByRole('link', { name: /^Fast one/ })).toContainText('32K context');
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test test/unit/ui-pure.test.js`
Expected: FAIL. `format.js` provides no export named `formatCost`.

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/models.spec.js`
Expected: FAIL in both engines, while waiting for the heading "Models".

- [ ] **Step 4: Add jsonField, formatCost and outcomeText**

Append to `src/ui/dom.js`:

```js
/**
 * A labelled JSON editor for a settings object. read() parses it, or throws in plain words.
 * @param {string} label @param {string} id @param {any} value
 */
export function jsonField(label, id, value) {
  const area = h('textarea', { id, rows: 4, spellcheck: 'false', autocapitalize: 'off', class: 'mono' });
  area.value = JSON.stringify(value ?? {}, null, 2);
  return {
    el: field(label, area),
    read() {
      const text = area.value.trim();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${label} isn't valid JSON.`);
      }
    },
  };
}
```

Append to `src/ui/format.js`:

```js
/** A cost in USD for people: "free", "$0.0042", "$1.23", or "cost unknown". @param {number | undefined} usd */
export function formatCost(usd) {
  if (usd === undefined || !Number.isFinite(usd)) return 'cost unknown';
  if (usd === 0) return 'free';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** @type {Record<string, string>} */
const OUTCOMES = {
  ok: 'answered', auth: 'key rejected', credit: 'out of credit', rate: 'too many requests', overloaded: 'overloaded',
  context: 'too long for it', image: "didn't take the photo", upload: 'photo upload expired', blocked: "doesn't allow web apps",
  unreachable: "couldn't connect", 'bad-request': 'refused the request', 'not-found': 'unknown model or address', server: 'provider error',
  network: 'connection dropped', timeout: 'too slow to start', cancelled: 'stopped', plugin: 'plugin failed', removed: 'removed',
  'type-missing': 'its plugin is missing', benched: 'resting after an error', 'no-images': "doesn't take photos", 'no-tools': "can't use tools",
  'too-long': 'conversation too long for it',
};

/** What happened to one model in a role call, in a few words (spec §9.6). @param {string} outcome */
export function outcomeText(outcome) {
  return OUTCOMES[outcome] ?? outcome;
}
```

- [ ] **Step 5: Write the screens**

Create `src/ui/screens/models.js`:

```js
import { h, field } from '../dom.js';
import { endpointOf, modelOf, saveRoles, CHAT_ROLES } from '../../core/llm/config.js';
import { LEVELS } from '../../core/llm/reasoning.js';
import { addFromTemplate, templateUpdates } from '../../core/llm/templates.js';
import { renderEndpoint, messageOf } from './endpoint.js';
import { renderModel } from './model.js';

/** @type {Record<string, string>} */
const ROLE_NAMES = { main: 'Main: talks with you', utility: 'Utility: summaries and small jobs', decide: 'Quick decision: yes-or-no checks' };

/**
 * Settings → Models (spec §9.2, §9.6, §9.8): the endpoints annai calls, their models, and which
 * models each role tries, in order.
 * @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route
 */
export async function renderModels(ctx, route) {
  if (route.parts[1] === 'endpoint') return renderEndpoint(ctx, route.params.id ?? '');
  if (route.parts[1] === 'model') return renderModel(ctx, route.params.id ?? '');
  await ctx.llm.ready;
  const [cfg, catalog] = await Promise.all([ctx.llm.config(), ctx.llm.templates()]);
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Models' }),
    h('p', { class: 'sub', text: 'Where Shiori thinks: the endpoints annai calls, their models, and which models each role tries, in order.' }),
    endpointsSection(ctx, cfg, catalog),
    rolesSection(ctx, cfg));
}

/** @param {any} ctx @param {import('../../core/llm/config.js').ModelConfig} cfg @param {import('../../core/llm/templates.js').TemplateCatalog} catalog */
function endpointsSection(ctx, cfg, catalog) {
  const types = ctx.llm.types();
  const updates = new Set(templateUpdates(cfg, catalog).map((u) => u.endpoint));
  const rows = Object.values(cfg.endpoints).sort((a, b) => a.created - b.created).map((rec) => {
    const e = endpointOf(rec, types.get(rec.type)?.tunables);
    const n = Object.values(cfg.models).filter((m) => m.endpoint === rec.id).length;
    const sub = [types.get(rec.type)?.name ?? rec.type, `${n} model${n === 1 ? '' : 's'}`, updates.has(rec.id) ? 'template update available' : null];
    return h('li', {}, h('a', { class: 'card', href: `#/models/endpoint?id=${encodeURIComponent(rec.id)}` },
      h('span', { class: 'name', text: e.name }),
      h('span', { class: 'sub', text: sub.filter(Boolean).join(' · ') })));
  });
  const status = h('p', { class: 'sub', role: 'status' });
  const pick = h('select', { id: 'endpoint-template' }, ...catalog.endpoints.map((t) => h('option', { value: t.id, text: t.name })));
  const add = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      const tpl = catalog.endpoints.find((t) => t.id === pick.value);
      if (!tpl) return;
      add.disabled = true;
      try {
        if (!types.has(tpl.type)) status.textContent = 'Installing the plugin for this endpoint…';
        await ctx.llm.ensureType(tpl.type);
        const id = await addFromTemplate(ctx, tpl, { roles: 'recommended' });
        ctx.go(`#/models/endpoint?id=${encodeURIComponent(id)}`);
      } catch (e) {
        status.textContent = messageOf(e);
      } finally {
        add.disabled = false;
      }
    },
  }, 'Add');
  return h('section', { class: 'panel', 'aria-label': 'Endpoints' },
    h('h2', { class: 'section', text: 'Endpoints' }),
    rows.length ? h('ul', { class: 'cards' }, ...rows) : h('p', { class: 'empty', text: 'No endpoints yet. Add one below.' }),
    catalog.endpoints.length
      ? h('div', { class: 'row' }, field('Add an endpoint', pick), h('div', { class: 'acts' }, add))
      : h('p', { class: 'sub', text: "annai's list of endpoints hasn't been loaded yet. Connect to the internet and open this screen again." }),
    status);
}

/** @param {any} ctx @param {import('../../core/llm/config.js').ModelConfig} cfg */
function rolesSection(ctx, cfg) {
  const models = Object.values(cfg.models).map(modelOf);
  const nameOf = (/** @type {string} */ id) => models.find((m) => m.id === id)?.name ?? id;
  const save = async (/** @type {import('../../core/llm/config.js').Roles} */ roles) => {
    await saveRoles(ctx.ws, roles);
    ctx.render();
  };
  return h('section', { class: 'panel', 'aria-label': 'Roles' },
    h('h2', { class: 'section', text: 'Roles' }),
    h('p', { class: 'sub', text: 'Each role tries its models from the top. When one fails, the next one answers. An empty role uses the main list.' }),
    ...CHAT_ROLES.map((role) => roleBlock(role, cfg.roles, models, nameOf, save)));
}

/**
 * @param {string} role @param {import('../../core/llm/config.js').Roles} roles @param {import('../../core/llm/config.js').Model[]} models
 * @param {(id: string) => string} nameOf @param {(roles: any) => Promise<void>} save
 */
function roleBlock(role, roles, models, nameOf, save) {
  const r = roles[role];
  /** @param {number} i @param {number} by */
  const moved = (i, by) => {
    const list = r.models.slice();
    [list[i], list[i + by]] = [list[i + by], list[i]];
    return { ...roles, [role]: { ...r, models: list } };
  };
  const items = r.models.map((id, i) => h('li', { class: 'role-item' },
    h('span', { text: `${i + 1}. ${nameOf(id)}` }),
    h('button', { class: 'btn ghost', type: 'button', 'aria-label': `Move ${nameOf(id)} up`, disabled: i === 0, onclick: () => save(moved(i, -1)) }, '↑'),
    h('button', { class: 'btn ghost', type: 'button', 'aria-label': `Move ${nameOf(id)} down`, disabled: i === r.models.length - 1, onclick: () => save(moved(i, 1)) }, '↓'),
    h('button', { class: 'btn ghost', type: 'button', 'aria-label': `Remove ${nameOf(id)} from ${role}`, onclick: () => save({ ...roles, [role]: { ...r, models: r.models.filter((_, j) => j !== i) } }) }, '✕')));
  const others = models.filter((m) => !r.models.includes(m.id));
  const pick = h('select', { id: `role-${role}-add` }, ...others.map((m) => h('option', { value: m.id, text: m.name })));
  const level = h('select', { id: `role-${role}-level`, onchange: () => save({ ...roles, [role]: { ...r, level: level.value } }) }, ...LEVELS.map((l) => h('option', { value: l, text: l })));
  level.value = r.level;
  const wait = h('input', {
    id: `role-${role}-wait`, inputmode: 'numeric', placeholder: '30', value: r.firstOutputSeconds ?? '',
    onchange: () => {
      const n = Math.round(Number(wait.value));
      const { firstOutputSeconds: _, ...rest } = r;
      save({ ...roles, [role]: wait.value.trim() && n >= 1 && n <= 600 ? { ...rest, firstOutputSeconds: n } : rest });
    },
  });
  return h('div', { class: 'role' },
    h('h3', { class: 'role-name', text: ROLE_NAMES[role] ?? role }),
    items.length ? h('ol', { class: 'role-list' }, ...items) : h('p', { class: 'sub', text: role === 'main' ? 'No models yet. Add one.' : 'Uses the main list.' }),
    h('div', { class: 'row' },
      others.length ? field(`Add a model to ${role}`, pick) : null,
      others.length ? h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => save({ ...roles, [role]: { ...r, models: [...r.models, pick.value] } }) }, `Add to ${role}`)) : null,
      field(`Reasoning for ${role}`, level),
      field('Wait for the first words (seconds)', wait)));
}
```

Create `src/ui/screens/endpoint.js`:

```js
import { h, field, twoStep, jsonField } from '../dom.js';
import { endpointOf, endpointBase, modelOf, newModel, saveEndpoint, saveModel, setKey, removeEndpoint, diffLayer } from '../../core/llm/config.js';
import { templateUpdates, applyTemplate, addListedModel } from '../../core/llm/templates.js';

/** An error in plain words; for a ValidationError, its own words without the field path. @param {any} e */
export function messageOf(e) {
  if (Array.isArray(e?.errors)) return e.errors.map((/** @type {string} */ x) => x.replace(/^\$[^:]*: /, '')).join(' ');
  return String(e?.message ?? e);
}

/** @param {string} text */
function gone(text) {
  return h('div', { class: 'screen' }, h('h1', { class: 'title', text }), h('p', {}, h('a', { href: '#/models' }, 'Back to Models')));
}

/** @param {import('../../core/llm/cost.js').Prices | null} prices */
function priceLine(prices) {
  if (!prices) return null;
  if (!prices.input && !prices.output) return 'free';
  return `$${prices.input ?? '?'} in, $${prices.output ?? '?'} out per million tokens`;
}

/**
 * One endpoint: how annai talks to a server (spec §9.2), and its models.
 * @param {any} ctx @param {string} id
 */
export async function renderEndpoint(ctx, id) {
  await ctx.llm.ready;
  const [cfg, catalog] = await Promise.all([ctx.llm.config(), ctx.llm.templates()]);
  const rec = cfg.endpoints[id];
  if (!rec) return gone('This endpoint no longer exists');
  const type = ctx.llm.types().get(rec.type);
  const e = endpointOf(rec, type?.tunables);
  const base = endpointBase(rec, type?.tunables);
  const hasKey = Boolean(await ctx.llm.keyFor(id));
  const update = templateUpdates(cfg, catalog).find((u) => u.endpoint === id);
  const from = rec.template ? catalog.endpoints.find((t) => t.id === rec.template?.id) : undefined;
  const status = h('p', { class: 'sub', role: 'status' });
  const name = h('input', { id: 'endpoint-name', autocomplete: 'off', value: e.name });
  const url = h('input', { id: 'endpoint-url', autocomplete: 'off', autocapitalize: 'off', inputmode: 'url', value: e.baseUrl, placeholder: 'https://…' });
  const key = h('input', { id: 'endpoint-key', type: 'password', autocomplete: 'off', placeholder: hasKey ? 'saved (type a new one to replace it)' : 'not set' });
  const headers = jsonField('Extra headers (JSON)', 'endpoint-headers', e.headers);
  const tunables = jsonField('Tunables (JSON)', 'endpoint-tunables', e.tunables);
  const extra = jsonField('Extra request fields (JSON)', 'endpoint-extra', e.extraBody);
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      try {
        const edited = { name: name.value.trim() || base.name, baseUrl: url.value.trim(), headers: headers.read(), tunables: tunables.read(), extraBody: extra.read() };
        await saveEndpoint(ctx.ws, { ...rec, user: diffLayer(edited, base) });
        if (key.value.trim()) await setKey(ctx.store, id, key.value.trim());
        ctx.notices.toast('Saved');
        ctx.render();
      } catch (err) {
        status.textContent = messageOf(err);
      }
    },
  }, 'Save');
  const models = Object.values(cfg.models).filter((m) => m.endpoint === id).map(modelOf);
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/models' }, '← Models')),
    h('h1', { class: 'title', text: e.name }),
    h('p', { class: 'sub', text: [type?.name ?? rec.type, rec.template ? `from annai's ${rec.template.values.name ?? rec.template.id} template` : null].filter(Boolean).join(' · ') }),
    type ? null : installPanel(ctx, rec.type),
    update ? updatePanel(ctx, id, update.template) : null,
    h('section', { class: 'panel', 'aria-label': 'Endpoint' },
      field('Name', name), field('Base URL', url), field('API key', key),
      from?.note || from?.keyUrl
        ? h('p', { class: 'sub' }, from.note ?? '', from.note && from.keyUrl ? ' ' : '', from.keyUrl ? h('a', { href: from.keyUrl, target: '_blank', rel: 'noopener' }, 'Get a key') : null)
        : null,
      headers.el, tunables.el, extra.el,
      h('div', { class: 'acts' }, save,
        hasKey ? h('button', { class: 'btn', type: 'button', onclick: async () => { await setKey(ctx.store, id, null); ctx.notices.toast('Key removed'); ctx.render(); } }, 'Remove key') : null),
      status),
    modelsSection(ctx, id, models),
    h('div', { class: 'acts' }, twoStep('Remove endpoint', 'Tap again to remove it', async () => {
      await removeEndpoint(ctx.ws, ctx.store, id);
      ctx.go('#/models');
    })));
}

/** @param {any} ctx @param {string} typeId */
function installPanel(ctx, typeId) {
  const status = h('p', { class: 'sub', role: 'status', text: `This endpoint needs the plugin for "${typeId}", which isn't running.` });
  const btn = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      btn.disabled = true;
      status.textContent = 'Installing…';
      try {
        await ctx.llm.ensureType(typeId);
        ctx.render();
      } catch (e) {
        status.textContent = messageOf(e);
        btn.disabled = false;
      }
    },
  }, 'Install it');
  return h('section', { class: 'panel', 'aria-label': 'Plugin' }, status, h('div', { class: 'acts' }, btn));
}

/** @param {any} ctx @param {string} id @param {import('../../core/llm/templates.js').EndpointTemplate} tpl */
function updatePanel(ctx, id, tpl) {
  return h('section', { class: 'panel', 'aria-label': 'Template update' },
    h('p', { text: `annai's ${tpl.name} template has changed. Applying it keeps your own changes.` }),
    h('div', { class: 'acts' }, h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        await applyTemplate(ctx, id, tpl);
        ctx.notices.toast('Template applied');
        ctx.render();
      },
    }, 'Apply update')));
}

/** @param {any} ctx @param {string} endpointId @param {import('../../core/llm/config.js').Model[]} models */
function modelsSection(ctx, endpointId, models) {
  const status = h('p', { class: 'sub', role: 'status' });
  const listSlot = h('div', {});
  const providerId = h('input', { id: 'model-id', autocomplete: 'off', autocapitalize: 'off', placeholder: "the provider's model id" });
  const add = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const value = providerId.value.trim();
      if (!value) return;
      try {
        await saveModel(ctx.ws, newModel(endpointId, { user: { providerId: value } }));
        ctx.render();
      } catch (e) {
        status.textContent = messageOf(e);
      }
    },
  }, 'Add model');
  const fetchList = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      fetchList.disabled = true;
      status.textContent = 'Asking the endpoint for its models…';
      try {
        const listed = await ctx.llm.listModels(endpointId);
        status.textContent = `${listed.length} model${listed.length === 1 ? '' : 's'}.`;
        listSlot.replaceChildren(listedModels(ctx, endpointId, listed, models));
      } catch (e) {
        status.textContent = messageOf(e);
      } finally {
        fetchList.disabled = false;
      }
    },
  }, 'Fetch model list');
  const rows = models.map((m) => h('li', {}, h('a', { class: 'card', href: `#/models/model?id=${encodeURIComponent(m.id)}` },
    h('span', { class: 'name', text: m.name }),
    h('span', { class: 'sub', text: [m.providerId !== m.name ? m.providerId : null, m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K context` : null, priceLine(m.prices)].filter(Boolean).join(' · ') }))));
  return h('section', { class: 'panel', 'aria-label': 'Models' },
    h('h2', { class: 'section', text: 'Models' }),
    rows.length ? h('ul', { class: 'cards' }, ...rows) : h('p', { class: 'empty', text: 'No models yet.' }),
    h('div', { class: 'row' }, field('Add a model by id', providerId), h('div', { class: 'acts' }, add, fetchList)),
    status,
    listSlot);
}

/**
 * The models an endpoint listed, minus those already added, with a filter.
 * @param {any} ctx @param {string} endpointId @param {import('../../core/llm/contract.js').ListedModel[]} listed @param {import('../../core/llm/config.js').Model[]} have
 */
function listedModels(ctx, endpointId, listed, have) {
  const owned = new Set(have.map((m) => m.providerId));
  const filter = h('input', { id: 'model-filter', autocomplete: 'off', placeholder: 'for example: haiku' });
  const list = h('ul', { class: 'listed' });
  const show = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = listed.filter((m) => !owned.has(m.providerId) && (!q || `${m.providerId} ${m.name ?? ''}`.toLowerCase().includes(q))).slice(0, 50);
    list.replaceChildren(...rows.map((m) => h('li', { class: 'acts' },
      h('span', { text: m.name && m.name !== m.providerId ? `${m.name} (${m.providerId})` : m.providerId }),
      h('button', {
        class: 'btn', type: 'button', 'aria-label': `Add ${m.providerId}`,
        onclick: async () => {
          await addListedModel(ctx, endpointId, m);
          ctx.render();
        },
      }, 'Add'))));
  };
  filter.addEventListener('input', show);
  show();
  return h('div', {}, field('Filter the list', filter), list);
}
```

Create `src/ui/screens/model.js`:

```js
import { h, field, checkbox, twoStep, jsonField } from '../dom.js';
import { modelOf, modelBase, endpointOf, saveModel, removeModel, diffLayer } from '../../core/llm/config.js';
import { messageOf } from './endpoint.js';

/** A positive whole number from an input, or null when it's empty. @param {string} v */
function num(v) {
  const n = Math.round(Number(v));
  return v.trim() && Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * One model: what it can do and what it costs (spec §9.2).
 * @param {any} ctx @param {string} id
 */
export async function renderModel(ctx, id) {
  await ctx.llm.ready;
  const cfg = await ctx.llm.config();
  const rec = cfg.models[id];
  if (!rec) return h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'This model no longer exists' }), h('p', {}, h('a', { href: '#/models' }, 'Back to Models')));
  const m = modelOf(rec);
  const base = modelBase(rec);
  const epRec = cfg.endpoints[rec.endpoint];
  const ep = endpointOf(epRec, ctx.llm.types().get(epRec.type)?.tunables);
  const back = `#/models/endpoint?id=${encodeURIComponent(rec.endpoint)}`;
  const status = h('p', { class: 'sub', role: 'status' });
  const name = h('input', { id: 'model-name', autocomplete: 'off', value: m.name });
  const providerId = h('input', { id: 'model-provider-id', autocomplete: 'off', autocapitalize: 'off', value: m.providerId });
  const images = checkbox('Takes photos', m.input.includes('image'));
  const tools = checkbox('Calls tools', m.tools !== false);
  const window = h('input', { id: 'model-window', inputmode: 'numeric', value: m.contextWindow ?? '' });
  const max = h('input', { id: 'model-max', inputmode: 'numeric', value: m.maxOutput ?? '' });
  const prices = jsonField('Prices, USD per million tokens (JSON)', 'model-prices', m.prices ?? {});
  const ttls = h('input', { id: 'model-ttls', autocomplete: 'off', value: m.cacheTtls.join(', '), placeholder: '5m, 1h' });
  const reasoning = jsonField('Reasoning levels (JSON)', 'model-reasoning', m.reasoning);
  const tunables = jsonField('Tunables (JSON)', 'model-tunables', m.tunables);
  const extra = jsonField('Extra request fields (JSON)', 'model-extra', m.extraBody);
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      try {
        const p = prices.read();
        const pid = providerId.value.trim();
        const edited = {
          name: name.value.trim() === pid ? base.name : name.value.trim(),
          providerId: pid,
          input: [...new Set([...m.input.filter((x) => x !== 'image'), ...(images.input.checked ? ['image'] : [])])],
          tools: tools.input.checked,
          contextWindow: num(window.value),
          maxOutput: num(max.value),
          prices: Object.keys(p).length ? p : null,
          cacheTtls: ttls.value.split(/[\s,]+/).filter((x) => x === '5m' || x === '1h'),
          reasoning: reasoning.read(),
          tunables: tunables.read(),
          extraBody: extra.read(),
        };
        await saveModel(ctx.ws, { ...rec, user: diffLayer(edited, base) });
        ctx.notices.toast('Saved');
        ctx.render();
      } catch (err) {
        status.textContent = messageOf(err);
      }
    },
  }, 'Save');
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: back }, `← ${ep.name}`)),
    h('h1', { class: 'title', text: m.name }),
    h('section', { class: 'panel', 'aria-label': 'Model' },
      field('Name', name), field('Provider model id', providerId),
      h('div', { class: 'checks' }, images.el, tools.el),
      h('div', { class: 'row' }, field('Context window (tokens)', window), field('Maximum output (tokens)', max)),
      prices.el, field('Cache lifetimes (5m, 1h)', ttls), reasoning.el, tunables.el, extra.el,
      h('div', { class: 'acts' }, save), status),
    h('div', { class: 'acts' }, twoStep('Remove model', 'Tap again to remove it', async () => {
      await removeModel(ctx.ws, id);
      ctx.go(back);
    })));
}
```

- [ ] **Step 6: Route to the screens, link them from Settings, and style them**

In `src/ui/shell.js`, import the screen and add it to `SCREENS`:

```js
import { renderModels } from './screens/models.js';
```

```js
const SCREENS = { trips: renderTrips, trip: renderTrip, file: renderFile, settings: renderSettings, import: renderImport, trace: renderTrace, plugins: renderPlugins, models: renderModels };
```

In `src/ui/router.js`, extend the routes listed in the doc comment of `parseHash`:

```js
 * Hash routes: "#/trips", "#/trip/<id>", "#/trip/<id>/file?path=…", "#/settings",
 * "#/plugins", "#/models", "#/models/endpoint?id=…", "#/models/model?id=…", "#/trace", "#/import?inbox=1".
```

In `src/ui/screens/settings.js`, add this section right before the `section('Plugins', …)` line:

```js
    section('Models', h('p', { class: 'sub', text: 'The endpoints and models Shiori uses, and the order each role tries them in.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/models' }, 'Models'))),
```

Append to `src/ui/base.css`:

```css
/* Settings → Models */
.role { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--line); }
.role-name { font-size: 15px; font-weight: 700; margin: 0; }
.role-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; }
.role-item { display: flex; align-items: center; gap: 2px; }
.role-item span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
textarea.mono { font-family: var(--f-mono); font-size: 13px; }
.listed { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 50vh; overflow: auto; }
.listed li { justify-content: space-between; }
```

In `sw.js`, add the three screens to `SHELL`. Put `'/src/ui/screens/endpoint.js',` after `'/src/ui/screens/file.js',`. Put `'/src/ui/screens/model.js',` and `'/src/ui/screens/models.js',` after `'/src/ui/screens/import.js',`:

```js
  '/src/ui/screens/endpoint.js',
```

```js
  '/src/ui/screens/model.js',
  '/src/ui/screens/models.js',
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/unit/ui-pure.test.js`
Expected: PASS.

Run: `npm run stamp && docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/models.spec.js test/e2e/shell.spec.js`
Expected: PASS in both engines.

- [ ] **Step 8: Check, commit**

Run: `npm run check`
Expected: all green, and size under 400 KiB.

```bash
git add src/ui/dom.js src/ui/format.js src/ui/screens/models.js src/ui/screens/endpoint.js src/ui/screens/model.js src/ui/shell.js src/ui/router.js src/ui/screens/settings.js src/ui/base.css sw.js test/unit/ui-pure.test.js test/e2e/models.spec.js
git commit -m "Settings → Models: endpoints from templates, models, keys, and the order of each role"
```

---

### Task 12: The Test button, "Talk to your models", and model calls in the trace

**Files:**
- Create: `src/core/llm/check.js`, `src/ui/model-check.js`, `src/ui/talk-panel.js`
- Modify: `src/core/llm/service.js` (add `test`, `testLevels` and `probe`)
- Modify: `src/ui/screens/models.js` (the talk panel), `src/ui/screens/endpoint.js` and `src/ui/screens/model.js` (the test panel)
- Modify: `src/ui/screens/trace.js` (summaries of model calls; the stored text)
- Modify: `src/ui/base.css`, `sw.js` (`SHELL`)
- Test: `test/unit/llm-check.test.js`, `test/e2e/models.spec.js`

**Interfaces:**
- Consumes:
  - `callOnce` (Task 8), `explain` and `ProviderError` (Task 1), `LEVELS` (Task 2)
  - `saveModel`, `modelOf` and `endpointOf` (Task 4)
  - `AllFailedError` (Task 9)
  - `formatCost` and `outcomeText` (Task 11)
  - `ctx.llm` (Task 10)
- Produces:
  - **From `check.js`:**
    - `TEST_IMAGE`: a 16×16 red PNG, as base64
    - `testModel({ type, endpoint, model, key, fetch?, probe?, firstOutputMs? }): Promise<{ ok, steps: { step: 'access'|'key'|'tools'|'images', ok, detail }[] }>`
    - `testLevels({ type, endpoint, model, key, fetch? }): Promise<Record<level, 'ok' | ErrorKind>>`
  - **Additions to `ctx.llm`:** `test(modelId)` and `testLevels(modelId)`. Both record what they found in the model's `verified`.
  - **From `model-check.js`:** `testPanel(ctx, modelId, verified, title?)`.
  - **From `talk-panel.js`:** `talkPanel(ctx)`.
  - **Labels:**
    - the talk panel: "Message", "Send", "Stop"
    - the test panel: "Test" and "Test reasoning levels"

- [ ] **Step 1: Write the failing unit tests**

Create `test/unit/llm-check.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { testModel, testLevels, TEST_IMAGE } from '../../src/core/llm/check.js';
import { readConfig, modelOf } from '../../src/core/llm/config.js';
import { addFromTemplate } from '../../src/core/llm/templates.js';
import { createLlm } from '../../src/core/llm/service.js';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';

/** @returns {any} */
function scriptedType() {
  /** @type {any} */
  let t = null;
  scripted({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'scripted-model' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return t;
}
/** @param {any[]} script @param {any} [model] */
function scriptedCase(script, model = {}) {
  return {
    type: scriptedType(),
    endpoint: { id: `ep-${Math.random()}`, type: 'scripted', name: 'S', baseUrl: '', headers: {}, tunables: { script }, extraBody: {} },
    model: { id: 'm', endpoint: 'ep', name: 'S', providerId: 'scripted', input: ['text', 'image'], tools: true, contextWindow: null, maxOutput: null, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, ...model },
    key: null,
  };
}

test('the Test button: access, key, tool calls and photos all work (spec §9.8)', async () => {
  const r = await testModel(scriptedCase([{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['access', true], ['key', true], ['tools', true], ['images', true]]);
  assert.match(r.steps[1].detail, /The model said: "OK"/);
  assert.match(TEST_IMAGE, /^iVBORw0KGgo/);
});

test('a rejected key is a key problem, in plain words', async () => {
  const r = await testModel(scriptedCase([{ error: 'auth', status: 401 }]));
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps.map((s) => s.step), ['key']);
  assert.match(r.steps[0].detail, /key was rejected/);
});

test('"this endpoint blocks web apps" is told apart from "annai couldn\'t reach it"', async () => {
  const type = /** @type {any} */ ({ type: 'http', name: 'HTTP', pluginId: 'p', build: () => ({ url: 'https://llm.test/v1/chat', headers: {}, body: {} }), read: async function* () {} });
  const base = { ...scriptedCase([]), type, fetch: async () => { throw new TypeError('Failed to fetch'); } };
  const blocked = await testModel({ ...base, probe: async () => true });
  assert.match(blocked.steps[0].detail, /doesn't allow web apps/);
  const down = await testModel({ ...base, probe: async () => false });
  assert.match(down.steps[0].detail, /couldn't reach this endpoint/);
});

test("a model that ignores the tool and doesn't see the square fails those steps only", async () => {
  const r = await testModel(scriptedCase([{ text: 'OK' }, { text: 'It is blue.' }]));
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['access', true], ['key', true], ['tools', false], ['images', false]]);
  const textOnly = await testModel(scriptedCase([{ text: 'OK' }, { text: 'red' }], { input: ['text'], tools: false }));
  assert.deepEqual(textOnly.steps.map((s) => s.step), ['access', 'key']);
});

test('testLevels tries each reasoning level the model has (spec §9.3)', async () => {
  const r = await testLevels(scriptedCase([{ text: 'OK' }, { error: 'bad-request' }], { reasoning: { low: { a: 1 }, high: { a: 2 } } }));
  assert.deepEqual(r, { low: 'ok', high: 'bad-request' });
});

test('the service records what the Test button found on the model', async () => {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const root = new URL('../../', import.meta.url);
  const repoFetch = async (/** @type {any} */ url) => {
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws, importModule }), fetch: repoFetch });
  const catalog = JSON.parse(await readFile(new URL('catalog/templates.json', root), 'utf8'));
  await llm.ensureType('scripted');
  await addFromTemplate({ ws, store }, catalog.endpoints.find((/** @type {any} */ t) => t.id === 'scripted'), { roles: null });
  const [id] = Object.keys((await readConfig(ws)).models);
  await llm.test(id);
  const verified = (await readConfig(ws)).models[id].verified;
  assert.equal(verified?.access, true);
  assert.equal(verified?.key, true);
  assert.equal(typeof verified?.at, 'number');
  assert.equal(modelOf((await readConfig(ws)).models[id]).name, 'Scripted');
});
```

- [ ] **Step 2: Write the failing end-to-end tests**

Add to `test/e2e/models.spec.js`. Put the import at the top of the file, and the tests at the end:

```js
import { readFile } from 'node:fs/promises';
```

```js
test('the Test button checks access, the key, tool calls and photos', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await page.getByLabel('Add an endpoint').selectOption({ label: 'Scripted model (for testing)' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scripted model (for testing)' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Tunables (JSON)').fill(JSON.stringify({ script: [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }] }));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByText('Everything works.')).toBeVisible();
  await expect(page.getByText('✓ Photos work: it saw the red square.')).toBeVisible();
});

test('a conversation falls back from one provider to another, and the trace shows every request (milestone 2, part 1)', async ({ page }) => {
  const reply = await readFile(new URL('../fixtures/llm/anthropic/text.sse', import.meta.url), 'utf8');
  await page.route('**/test-llm/a/v1/chat/completions', (route) => route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }) }));
  await page.route('**/test-llm/b/v1/messages', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: reply }));
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  const origin = new URL(page.url()).origin;
  await addEndpoint(page, 'Other: Chat Completions', { name: 'Endpoint A', url: `${origin}/test-llm/a/v1`, key: 'sk-test-secret-a', model: 'a-model' });
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Endpoint B', url: `${origin}/test-llm/b`, key: 'sk-test-secret-b', model: 'b-model' });
  for (const m of ['a-model', 'b-model']) {
    await page.getByLabel('Add a model to main').selectOption({ label: m });
    await page.getByRole('button', { name: 'Add to main' }).click();
  }
  await expect(page.getByText('2. b-model')).toBeVisible();
  await page.getByLabel('Message').fill('Hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.talk-text').last()).toHaveText('Hello from B.');
  await expect(page.getByText(/^b-model · .* after 1 failed attempt \(a-model: out of credit\)$/)).toBeVisible();
  await page.getByRole('link', { name: 'Trace' }).click();
  await page.getByLabel('Type contains').fill('model.turn');
  await expect(page.getByText(/main: b-model · 2 attempts/)).toBeVisible();
  await page.getByLabel('Type contains').fill('net.request');
  await expect(page.getByText(/a-model · credit \(402\)/)).toBeVisible();
  await expect(page.getByText(/b-model · ok \(200\)/)).toBeVisible();
  for (const summary of await page.locator('ol.trace summary').all()) await summary.click();
  expect(await page.locator('ol.trace').innerText()).not.toContain('sk-test-secret');
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test test/unit/llm-check.test.js`
Expected: FAIL. The module can't be found: `Cannot find module …/src/core/llm/check.js`.

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/models.spec.js -g "Test button|falls back"`
Expected: FAIL in both engines. The test-button test waits for the "Test" button; the fallback test waits for the label "Message".

- [ ] **Step 4: Write check.js, and the service's test methods**

Create `src/core/llm/check.js`:

```js
import { callOnce } from './call.js';
import { ProviderError, explain } from './contract.js';
import { LEVELS } from './reasoning.js';

/** A 16×16 red PNG: the small image the Test button sends (spec §9.8). */
export const TEST_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4IydHEmIY1TCqYfhqAACaMxgQdrf9VwAAAABJRU5ErkJggg==';
const REPORT = {
  name: 'report_color',
  description: 'Report the color of the square in the picture.',
  input: { type: 'object', properties: { color: { type: 'string', description: 'one word' } }, required: ['color'] },
};
/** @type {import('./contract.js').Request} */
const SAY_OK = { system: 'This is a connection test.', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Reply with the word OK.' }] }], maxOutput: 256 };

/**
 * @typedef {{ step: 'access' | 'key' | 'tools' | 'images', ok: boolean, detail: string }} TestStep
 * @typedef {{ type: import('./contract.js').EndpointType, endpoint: import('./config.js').Endpoint, model: import('./config.js').Model,
 *   key: string | null, fetch?: import('./call.js').Fetch, probe?: (url: string) => Promise<boolean>, firstOutputMs?: number }} TestCase
 */

/** @param {unknown} e */
const asError = (e) => (e instanceof ProviderError ? e : new ProviderError('plugin', String(/** @type {any} */ (e)?.message ?? e)));

/**
 * The Test button (spec §9.8): one tiny request, then one with a small tool and a small image.
 * It says in plain words what works. "This endpoint blocks web apps" is told apart from
 * "annai couldn't reach it" by asking again in a way that skips the browser's access check
 * (the probe), which only reaches a server that is there.
 * @param {TestCase} c @returns {Promise<{ ok: boolean, steps: TestStep[] }>}
 */
export async function testModel(c) {
  const { type, endpoint, model, key, probe } = c;
  const base = { type, endpoint, model, key, fetch: c.fetch, firstOutputMs: c.firstOutputMs ?? 60_000, level: 'off' };
  /** @type {TestStep[]} */
  const steps = [];
  try {
    const r = await callOnce({ ...base, request: SAY_OK });
    steps.push({ step: 'access', ok: true, detail: 'annai can reach this endpoint from the browser.' });
    steps.push({ step: 'key', ok: true, detail: `The key works. The model said: "${r.text.trim().slice(0, 60)}".` });
  } catch (e) {
    const err = asError(e);
    if (err.kind === 'unreachable' && probe && type.build) {
      const { url } = type.build({ endpoint, model, key, tunables: { ...endpoint.tunables, ...model.tunables }, request: { messages: [] } });
      if (await probe(url)) err.kind = 'blocked';
    }
    steps.push({ step: err.kind === 'auth' || err.kind === 'credit' ? 'key' : 'access', ok: false, detail: explain(err) });
    return { ok: false, steps };
  }
  const useImage = model.input.includes('image');
  const useTools = model.tools !== false;
  if (useImage || useTools) {
    const ask = useTools ? 'What color is the square? Answer by calling report_color.' : 'What color is the square? Answer in one word.';
    /** @type {import('./contract.js').Part[]} */
    const parts = [...(useImage ? [/** @type {const} */ ({ type: 'image', mediaType: 'image/png', data: TEST_IMAGE })] : []), { type: 'text', text: ask }];
    try {
      const r = await callOnce({ ...base, request: { messages: [{ role: 'user', parts }], ...(useTools ? { tools: [REPORT] } : {}), maxOutput: 512 } });
      const call = r.parts.find((p) => p.type === 'tool_call' && p.name === REPORT.name);
      if (useTools) steps.push({ step: 'tools', ok: Boolean(call), detail: call ? 'Tool calls work.' : "The model answered but didn't call the test tool." });
      if (useImage) {
        const answer = call?.type === 'tool_call' ? JSON.stringify(call.input) : r.text;
        const red = /red/i.test(answer);
        steps.push({ step: 'images', ok: red, detail: red ? 'Photos work: it saw the red square.' : `It didn't see the red square (it said ${answer.slice(0, 60)}).` });
      }
    } catch (e) {
      const err = asError(e);
      steps.push({ step: err.kind === 'image' || !useTools ? 'images' : 'tools', ok: false, detail: explain(err) });
    }
  }
  return { ok: steps.every((s) => s.ok), steps };
}

/**
 * "The Test button can try each level and record which ones work" (spec §9.3).
 * @param {TestCase} c @returns {Promise<Record<string, string>>} level → "ok", or the kind of error
 */
export async function testLevels(c) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const level of LEVELS.filter((l) => Object.hasOwn(c.model.reasoning ?? {}, l))) {
    try {
      await callOnce({ type: c.type, endpoint: c.endpoint, model: c.model, key: c.key, fetch: c.fetch, level, firstOutputMs: c.firstOutputMs ?? 60_000, request: SAY_OK });
      out[level] = 'ok';
    } catch (e) {
      out[level] = asError(e).kind;
    }
  }
  return out;
}
```

In `src/core/llm/service.js`:

1. Extend the imports:

   ```js
   import { readConfig, getKey, endpointOf, modelOf, saveModel } from './config.js';
   import { testModel, testLevels } from './check.js';
   ```

2. Add `probe` to `createLlm`'s options, after `pluginsCanLoad`, and document it in the JSDoc. It is a request in `no-cors` mode, which the browser lets through to any server that answers:

   ```js
   probe = (/** @type {string} */ url) => get(url, { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false),
   ```

3. Inside `createLlm`, before `return {`, add a helper that finds everything one model's call needs:

   ```js
     /** @param {string} modelId */
     const resolve = async (modelId) => {
       const cfg = await readConfig(ws);
       const rec = cfg.models[modelId];
       const epRec = rec ? cfg.endpoints[rec.endpoint] : undefined;
       if (!rec || !epRec) throw new ProviderError('not-found', 'That model no longer exists.');
       await ensure(epRec.type);
       const type = /** @type {import('./contract.js').EndpointType} */ (types().get(epRec.type));
       return { rec, type, endpoint: endpointOf(epRec, type.tunables), model: modelOf(rec), key: await getKey(store, epRec.id) };
     };
   ```

4. Add these methods to the returned object:

   ```js
       /** The Test button for one model; what it found is recorded on the model (spec §9.8). @param {string} modelId */
       async test(modelId) {
         const { rec, type, endpoint, model, key } = await resolve(modelId);
         const result = await testModel({ type, endpoint, model, key, fetch: get, probe });
         const found = Object.fromEntries(result.steps.map((s) => [s.step, s.ok]));
         await saveModel(ws, { ...rec, verified: { ...(rec.verified ?? {}), ...found, at: Date.now() } });
         return result;
       },
       /** Tries each reasoning level of one model, and records which work (spec §9.3). @param {string} modelId */
       async testLevels(modelId) {
         const { rec, type, endpoint, model, key } = await resolve(modelId);
         const levels = await testLevels({ type, endpoint, model, key, fetch: get });
         await saveModel(ws, { ...rec, verified: { ...(rec.verified ?? {}), levels, levelsAt: Date.now() } });
         return levels;
       },
   ```

In `sw.js`, add to `SHELL` after `'/src/core/llm/call.js',`:

```js
  '/src/core/llm/check.js',
```

- [ ] **Step 5: Write the test panel and the talk panel, and add them to the screens**

Create `src/ui/model-check.js`:

```js
import { h } from './dom.js';
import { relTime, outcomeText } from './format.js';

/**
 * The Test button (spec §9.8) and "Test reasoning levels" (§9.3) for one model, with what the
 * last test found.
 * @param {any} ctx @param {string} modelId @param {Record<string, any> | undefined} verified @param {string} [title]
 */
export function testPanel(ctx, modelId, verified, title = 'Test') {
  const out = h('ul', { class: 'checks-result' });
  const last = verified?.at
    ? `Last tested ${relTime(verified.at)}: ${['key', 'tools', 'images'].filter((k) => k in verified).map((k) => `${k} ${verified[k] ? '✓' : '✗'}`).join(', ')}.`
    : 'Not tested yet.';
  const status = h('p', { class: 'sub', role: 'status', text: last });
  /** @param {{ ok: boolean, text: string }[]} lines */
  const show = (lines) => out.replaceChildren(...lines.map((l) => h('li', { class: l.ok ? 'ok' : 'bad', text: `${l.ok ? '✓' : '✗'} ${l.text}` })));
  const run = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      run.disabled = true;
      status.textContent = 'Testing: a tiny request, then one with a tool and a small picture…';
      try {
        const r = await ctx.llm.test(modelId);
        status.textContent = r.ok ? 'Everything works.' : 'Something needs attention:';
        show(r.steps.map((/** @type {any} */ s) => ({ ok: s.ok, text: s.detail })));
      } catch (e) {
        status.textContent = String(/** @type {any} */ (e)?.message ?? e);
      } finally {
        run.disabled = false;
      }
    },
  }, 'Test');
  const levels = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      levels.disabled = true;
      status.textContent = 'Trying each reasoning level…';
      try {
        const r = Object.entries(await ctx.llm.testLevels(modelId));
        status.textContent = r.length ? 'Reasoning levels:' : 'This model has no reasoning levels to try.';
        show(r.map(([level, outcome]) => ({ ok: outcome === 'ok', text: `${level}: ${outcome === 'ok' ? 'works' : outcomeText(outcome)}` })));
      } catch (e) {
        status.textContent = String(/** @type {any} */ (e)?.message ?? e);
      } finally {
        levels.disabled = false;
      }
    },
  }, 'Test reasoning levels');
  return h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), h('div', { class: 'acts' }, run, levels), status, out);
}
```

Create `src/ui/talk-panel.js`:

```js
import { h, field } from './dom.js';
import { AllFailedError } from '../core/llm/fallback.js';
import { ProviderError, explain } from '../core/llm/contract.js';
import { formatCost, outcomeText } from './format.js';

const SYSTEM = 'You are a helpful travel assistant inside the annai app. This conversation only checks that the models work, so keep your replies short.';

/** The line under a reply: who answered, the tokens, the cost, and which models failed first. @param {any} result */
function metaLine(result) {
  const u = result.usage;
  const tokens = u.input + u.cacheRead + u.cacheWrite + u.cacheWrite1h + u.output;
  const failed = result.attempts.filter((/** @type {any} */ a) => a.outcome !== 'ok');
  let line = `${result.answeredBy} · ${tokens} tokens · ${formatCost(result.cost)}`;
  if (failed.length) line += `, after ${failed.length} failed attempt${failed.length === 1 ? '' : 's'} (${failed.map((/** @type {any} */ a) => `${a.name}: ${outcomeText(a.outcome)}`).join('; ')})`;
  return line;
}

/** @param {unknown} err */
function failure(err) {
  if (err instanceof AllFailedError) {
    if (!err.attempts.length) return 'No model is set for the main role. Add one under Roles.';
    return `No model answered: ${err.attempts.map((a) => `${a.name}: ${outcomeText(a.outcome)}`).join('; ')}.`;
  }
  if (err instanceof ProviderError) return explain(err);
  return String(/** @type {any} */ (err)?.message ?? err);
}

/**
 * "Talk to your models": a plain text conversation through the main role, with fallback, to try
 * the models. Nothing is kept but the trace; Shiori's real conversation comes in milestone 2's
 * second part. Replies only ever go into textContent (spec §15).
 * @param {any} ctx
 */
export function talkPanel(ctx) {
  /** @type {import('../core/llm/contract.js').Message[]} */
  const messages = [];
  const log = h('ol', { class: 'talk', 'aria-live': 'polite' });
  const input = h('textarea', { id: 'talk-input', rows: 2 });
  /** @type {AbortController | null} */
  let running = null;
  const send = h('button', { class: 'btn pri', type: 'submit' }, 'Send');
  const stop = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => running?.abort() }, 'Stop');
  const form = h('form', {
    class: 'talk-form',
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || running) return;
      input.value = '';
      messages.push({ role: 'user', parts: [{ type: 'text', text }] });
      log.append(h('li', { class: 'talk-you', text }));
      const reply = h('div', { class: 'talk-text' });
      const meta = h('div', { class: 'sub' });
      log.append(h('li', { class: 'talk-model' }, reply, meta));
      running = new AbortController();
      send.disabled = true;
      stop.hidden = false;
      try {
        const result = await ctx.llm.call({
          role: 'main', request: { system: SYSTEM, messages, maxOutput: 1024 }, signal: running.signal,
          onEvent: (/** @type {any} */ ev) => { if (ev.type === 'text') reply.textContent += ev.text; },
        });
        reply.textContent = result.reply.text;
        messages.push({ role: 'assistant', parts: result.reply.parts });
        meta.textContent = metaLine(result);
      } catch (err) {
        messages.pop();
        meta.textContent = failure(err);
        if (err instanceof AllFailedError) ctx.notices.card({ tone: 'warn', title: "Shiori can't reach her model", body: failure(err) });
      } finally {
        running = null;
        send.disabled = false;
        stop.hidden = true;
      }
    },
  }, field('Message', input), h('div', { class: 'acts' }, send, stop));
  return h('section', { class: 'panel', 'aria-label': 'Talk to your models' },
    h('h2', { class: 'section', text: 'Talk to your models' }),
    h('p', { class: 'sub', text: 'A plain conversation through the main role, to try your models. Each request shows in Trace.' }),
    log,
    form);
}
```

In `src/ui/screens/models.js`, import the panel, and add it after `rolesSection(ctx, cfg)` in `renderModels`:

```js
import { talkPanel } from '../talk-panel.js';
```

```js
    rolesSection(ctx, cfg),
    talkPanel(ctx));
```

In `src/ui/screens/endpoint.js`, import the test panel:

```js
import { testPanel } from '../model-check.js';
```

In `renderEndpoint`, add this argument after `modelsSection(ctx, id, models),`. It tests the endpoint's first model:

```js
    models[0] ? testPanel(ctx, models[0].id, cfg.models[models[0].id].verified, `Test ${models[0].name}`) : null,
```

In `src/ui/screens/model.js`, import the test panel the same way:

```js
import { testPanel } from '../model-check.js';
```

In `renderModel`, add this argument after the `'Model'` panel section:

```js
    testPanel(ctx, id, rec.verified),
```

- [ ] **Step 6: Show model calls in the trace**

In `src/ui/screens/trace.js`:

1. Add the import:

   ```js
   import { formatCost } from '../format.js';
   ```

2. Change the description line to:

   ```js
       h('p', { class: 'sub', text: 'Everything annai recorded: file changes, model calls, imports, plugin problems and errors. Newest first.' }),
   ```

3. Pass `ctx` to `row`: `rows.map((e) => row(ctx, e, titles))`.

4. Replace `row` with this, and add `summaryOf` and `storedText`:

```js
/** @param {any} ctx @param {any} e @param {Map<string, string>} titles */
function row(ctx, e, titles) {
  return h('li', {}, h('details', {},
    h('summary', {},
      h('span', { class: 'tm', text: new Date(e.ts).toLocaleString() }),
      h('span', { class: 'k', text: e.type }),
      h('span', { class: 'sub', text: `${titles.get(e.scope) ?? e.scope} · ${e.actor}` }),
      h('span', { class: 'd', text: summaryOf(e) })),
    h('pre', { text: JSON.stringify(e, null, 2) }),
    e.refs?.length ? storedText(ctx, e) : null));
}

/** One line about an event. @param {any} e */
function summaryOf(e) {
  const d = e.data ?? {};
  if (e.type.startsWith('file.')) return d.path ?? '';
  if (e.type === 'model.turn') {
    const n = (d.attempts ?? []).length;
    return `${d.role}: ${d.answeredBy ?? 'no answer'} · ${n} attempt${n === 1 ? '' : 's'}${d.cost !== undefined ? ` · ${formatCost(d.cost)}` : ''}`;
  }
  if (e.type === 'net.request') return `${d.model ?? ''} · ${d.outcome ?? ''}${d.status ? ` (${d.status})` : ''} · ${d.ms ?? '?'} ms`;
  return d.message ?? d.title ?? '';
}

/**
 * Shows the content an event names: a model's reply and its reasoning, say (spec §15: the trace
 * makes everything the agent read visible). Text is shown; anything else is described.
 * @param {any} ctx @param {any} e an event with refs; data.stored names them, when it is there
 */
function storedText(ctx, e) {
  const out = h('pre', { hidden: true });
  const btn = h('button', {
    class: 'btn ghost', type: 'button',
    onclick: async () => {
      /** @type {string[]} */
      const texts = [];
      for (const [i, hash] of e.refs.entries()) {
        const b = await ctx.store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.getBlob(hash));
        const body = !b ? '(no longer stored)'
          : /^text\/|json/.test(b.type) ? new TextDecoder().decode(new Uint8Array(b.data).subarray(0, 200_000))
            : `(${b.type}, ${b.size} bytes)`;
        const label = e.data?.stored?.[i];
        texts.push(label ? `${label}:\n${body}` : body);
      }
      out.textContent = texts.join('\n\n');
      out.hidden = false;
      btn.hidden = true;
    },
  }, 'Show what was stored');
  return h('div', {}, btn, out);
}
```

Append to `src/ui/base.css`:

```css
/* Talk to your models, and test results */
.talk { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.talk-you { align-self: flex-end; max-width: 85%; padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius); white-space: pre-wrap; overflow-wrap: anywhere; }
.talk-model { display: flex; flex-direction: column; gap: 4px; }
.talk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.checks-result { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.checks-result .bad { color: var(--risk); }
```

In `sw.js`, add to `SHELL`. Put `'/src/ui/model-check.js',` after `'/src/ui/install.js',`, and `'/src/ui/talk-panel.js',` after `'/src/ui/storage-full.js',`:

```js
  '/src/ui/model-check.js',
```

```js
  '/src/ui/talk-panel.js',
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/unit/llm-check.test.js`
Expected: PASS, 6 tests.

Run: `npm run stamp && docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/models.spec.js test/e2e/trace.spec.js`
Expected: PASS in both engines, the finish-line test included.

The model requests are POSTs, which annai's service worker passes straight to the network, so `page.route` sees them. If an engine hides them from `page.route` anyway, use `context.route` with the same patterns, and record a ruling.

- [ ] **Step 8: Check, commit**

Run: `npm run check`
Expected: all green.

```bash
git add src/core/llm/check.js src/core/llm/service.js src/ui/model-check.js src/ui/talk-panel.js src/ui/screens/models.js src/ui/screens/endpoint.js src/ui/screens/model.js src/ui/screens/trace.js src/ui/base.css sw.js test/unit/llm-check.test.js test/e2e/models.spec.js
git commit -m "The Test button, a plain conversation through the main role, and model calls in the trace"
```

---

### Task 13: Sign in with OpenRouter, the live suite, and the docs

**Files:**
- Create: `src/ui/openrouter.js`
- Modify: `src/ui/screens/models.js` (the sign-in section), `src/ui/screens/endpoint.js` (the suggested-models buttons), `src/app/main.js` (finishing a sign-in)
- Modify: `sw.js` (`SHELL`)
- Create: `test/unit/openrouter.test.js`, `test/live/providers.test.js`
- Modify: `test/e2e/models.spec.js`
- Modify: `package.json` (add `test:live`)
- Modify: `docs/plugins.md`, `README.md`
- Create: `docs/testing/device-checklist-m2a.md`

**Interfaces:**
- Consumes:
  - `addFromTemplate` and `useSuggestion` (Task 10)
  - `ctx.llm` (Task 10)
  - `platform` and `isStandalone` (`src/ui/platform.js`)
  - `callOnce` and `testModel` (Tasks 8 and 12), in the live suite
- Produces, all from `openrouter.js`:
  - `AUTH_URL` and `KEYS_URL`
  - `needsCode(): boolean`
  - `signInUrl({ callback, storage?, now? }): Promise<string>`
  - `callbackFrom(search): { code, state } | null`
  - `exchange({ code, state, fetch?, storage?, now? }): Promise<string>`
  - `connectOpenRouter(ctx, key): Promise<string>`
  - `finishSignIn(ctx, env?): Promise<boolean>`

  The verifier waits in `localStorage` under `annai.openrouter` for at most 15 minutes. It is never a key. The key goes only to secrets, through `addFromTemplate`.

- [ ] **Step 1: Write the failing unit tests**

Create `test/unit/openrouter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { readConfig, modelOf, getKey } from '../../src/core/llm/config.js';
import { signInUrl, callbackFrom, exchange, finishSignIn, AUTH_URL, KEYS_URL } from '../../src/ui/openrouter.js';

/** A Storage-like map. */
function memoryStorage() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return { getItem: (/** @type {string} */ k) => m.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, v); }, removeItem: (/** @type {string} */ k) => { m.delete(k); }, m };
}
/** @param {Uint8Array} b */
const b64url = (b) => Buffer.from(b).toString('base64url');

test('the sign-in address carries a PKCE challenge of the stored verifier, and a state (spec §9.8)', async () => {
  const storage = memoryStorage();
  const url = new URL(await signInUrl({ callback: 'https://annai.guide/', storage, now: 1000 }));
  assert.equal(`${url.origin}${url.pathname}`, AUTH_URL);
  const saved = JSON.parse(/** @type {string} */ (storage.getItem('annai.openrouter')));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saved.verifier)));
  assert.equal(url.searchParams.get('code_challenge'), b64url(digest));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('callback_url'), 'https://annai.guide/');
  assert.equal(url.searchParams.get('state'), saved.state);
  assert.equal(saved.at, 1000);
  const code = new URL(await signInUrl({ callback: null, storage }));
  assert.equal(code.searchParams.get('callback_url'), null, 'without a callback, OpenRouter shows a code to paste');
  assert.equal(code.searchParams.get('state'), null);
});

test('the callback is read from the address', () => {
  assert.deepEqual(callbackFrom('?code=abc&state=xyz'), { code: 'abc', state: 'xyz' });
  assert.equal(callbackFrom(''), null);
});

test('exchange: the code and the verifier buy a key; a strange state, an old sign-in or no key are refused', async () => {
  const storage = memoryStorage();
  await signInUrl({ callback: 'https://annai.guide/', storage, now: 1000 });
  const saved = JSON.parse(/** @type {string} */ (storage.getItem('annai.openrouter')));
  /** @type {any} */
  let sent = null;
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => { sent = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ key: 'sk-or-new' })); };
  await assert.rejects(exchange({ code: 'c', state: 'not-ours', fetch, storage, now: 2000 }), /didn't start in this browser/);
  await assert.rejects(exchange({ code: 'c', state: saved.state, fetch, storage, now: 1000 + 16 * 60_000 }), /expired/);
  assert.equal(await exchange({ code: ' c ', state: saved.state, fetch, storage, now: 2000 }), 'sk-or-new');
  assert.equal(sent.url, KEYS_URL);
  assert.deepEqual(sent.body, { code: 'c', code_verifier: saved.verifier, code_challenge_method: 'S256' });
  assert.equal(storage.getItem('annai.openrouter'), null, 'the verifier is used once');
  await signInUrl({ callback: null, storage, now: 3000 });
  await assert.rejects(exchange({ code: 'c', state: null, fetch: async () => new Response('{}'), storage, now: 3000 }), /didn't send a key/);
  await assert.rejects(exchange({ code: 'c', state: null, fetch: async () => new Response('no', { status: 403 }), storage, now: 3000 }), /HTTP 403/);
});

test('finishing a sign-in: the address is cleaned, the endpoint, key and free models are set up, and the user is told', async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const catalog = JSON.parse(await readFile(new URL('../../catalog/templates.json', import.meta.url), 'utf8'));
  const storage = memoryStorage();
  const url = new URL(await signInUrl({ callback: 'https://annai.guide/', storage }));
  /** @type {string[]} */
  const toasts = [];
  /** @type {string[]} */
  const replaced = [];
  const ctx = {
    ws, store,
    llm: { templates: async () => catalog, ensureType: async () => {} },
    notices: { toast: (/** @type {string} */ t) => toasts.push(t), card: (/** @type {any} */ c) => { throw new Error(c.body); } },
  };
  const was = await finishSignIn(ctx, {
    location: /** @type {any} */ ({ search: `?code=abc&state=${url.searchParams.get('state')}`, pathname: '/' }),
    history: /** @type {any} */ ({ replaceState: (/** @type {any} */ _s, /** @type {any} */ _t, /** @type {string} */ to) => replaced.push(to) }),
    fetch: async () => new Response(JSON.stringify({ key: 'sk-or-signed-in' })),
    storage,
  });
  assert.equal(was, true);
  assert.deepEqual(replaced, ['/#/models']);
  const cfg = await readConfig(ws);
  const [endpoint] = Object.values(cfg.endpoints);
  assert.equal(endpoint.template?.id, 'openrouter');
  assert.equal(await getKey(store, endpoint.id), 'sk-or-signed-in');
  assert.deepEqual(cfg.roles.main.models.map((id) => modelOf(cfg.models[id]).name), ['Google: Gemma 4 31B (free)']);
  assert.match(toasts[0], /Signed in with OpenRouter/);
  assert.equal(await finishSignIn(ctx, { location: /** @type {any} */ ({ search: '', pathname: '/' }) }), false);
});
```

- [ ] **Step 2: Write the failing end-to-end test**

Add to `test/e2e/models.spec.js`:

```js
test('Sign in with OpenRouter: the key arrives and free models fill the roles (OpenRouter stood in for)', async ({ page }) => {
  let authUrl = '';
  await page.route('https://openrouter.ai/auth**', (route) => {
    authUrl = route.request().url();
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>OpenRouter</p>' });
  });
  await page.route('https://openrouter.ai/api/v1/auth/keys', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = route.request().postDataJSON();
    if (body.code !== 'test-code' || body.code_challenge_method !== 'S256' || !body.code_verifier) return route.fulfill({ status: 400, headers: cors, body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ key: 'sk-or-test-key-123' }) });
  });
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  const origin = new URL(page.url()).origin;
  await page.getByRole('button', { name: 'Sign in with OpenRouter' }).click();
  await expect.poll(() => authUrl).toContain('code_challenge_method=S256');
  const sent = new URL(authUrl);
  expect(sent.searchParams.get('callback_url')).toBe(`${origin}/`);
  await page.goto(`/?code=test-code&state=${sent.searchParams.get('state')}`);
  await expect(page.getByText(/Signed in with OpenRouter/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('1. Google: Gemma 4 31B (free)')).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  expect(await page.content()).not.toContain('sk-or-test-key-123');
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test test/unit/openrouter.test.js`
Expected: FAIL. The module can't be found: `Cannot find module …/src/ui/openrouter.js`.

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/models.spec.js -g "OpenRouter"`
Expected: FAIL in both engines, while waiting for the button "Sign in with OpenRouter".

- [ ] **Step 4: Write openrouter.js**

Create `src/ui/openrouter.js`:

```js
import { addFromTemplate } from '../core/llm/templates.js';
import { platform, isStandalone } from './platform.js';

/**
 * Sign in with OpenRouter (spec §9.8): OAuth with PKCE, with no client registration on annai's
 * side. The browser goes to OpenRouter, which sends it back with a code; the code, with a secret
 * only this browser knows (the verifier), buys a key. An iPhone Home Screen app keeps its storage
 * apart from Safari, where OpenRouter would send it back, so there OpenRouter shows the code
 * and the user pastes it instead.
 * @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} KeyValue
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 */
export const AUTH_URL = 'https://openrouter.ai/auth';
export const KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const SLOT = 'annai.openrouter';
const MAX_AGE = 15 * 60_000;

/** Whether sign-in must show a code to paste, rather than come back to annai by itself. */
export function needsCode() {
  return platform() === 'ios' && isStandalone();
}

/** @param {Uint8Array} bytes */
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Where to send the browser to sign in. The verifier and the state wait in storage for the way back.
 * @param {{ callback: string | null, storage?: KeyValue, now?: number }} c callback: annai's address, or null for a code to paste
 */
export async function signInUrl({ callback, storage = localStorage, now = Date.now() }) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  storage.setItem(SLOT, JSON.stringify({ verifier, state, at: now }));
  const params = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256' });
  if (callback) {
    params.set('callback_url', callback);
    params.set('state', state);
  }
  return `${AUTH_URL}?${params}`;
}

/** The code and state OpenRouter sent back, when this page load is its callback. @param {string} search */
export function callbackFrom(search) {
  const p = new URLSearchParams(search);
  const code = p.get('code');
  return code ? { code, state: p.get('state') } : null;
}

/**
 * Trades the code for a key. The verifier is used once.
 * @param {{ code: string, state: string | null, fetch?: Fetch, storage?: KeyValue, now?: number }} c state: null when the user pasted the code
 * @returns {Promise<string>} the key
 */
export async function exchange({ code, state, fetch: get = (url, init) => fetch(url, init), storage = localStorage, now = Date.now() }) {
  /** @type {any} */
  let saved = null;
  try {
    saved = JSON.parse(storage.getItem(SLOT) ?? 'null');
  } catch {
    saved = null;
  }
  if (!saved || now - saved.at > MAX_AGE) throw new Error('This sign-in has expired. Start it again from Settings → Models.');
  if (state !== null && state !== saved.state) throw new Error("This sign-in didn't start in this browser, so annai ignored it.");
  /** @type {Response} */
  let res;
  try {
    res = await get(KEYS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), code_verifier: saved.verifier, code_challenge_method: 'S256' }),
    });
  } catch {
    throw new Error("annai couldn't reach OpenRouter. Check the connection and try again.");
  }
  if (!res.ok) throw new Error(`OpenRouter didn't accept the sign-in (HTTP ${res.status}). Start it again from Settings → Models.`);
  const body = await res.json().catch(() => ({}));
  if (typeof body?.key !== 'string' || !body.key) throw new Error("OpenRouter didn't send a key. Start the sign-in again.");
  storage.removeItem(SLOT);
  return body.key;
}

/**
 * Sets annai up with an OpenRouter key: the OpenRouter endpoint from annai's template, its key,
 * and free models in the roles that are still empty, so trying annai costs nothing.
 * @param {any} ctx llm, ws and store @param {string} key @returns {Promise<string>} the endpoint's id
 */
export async function connectOpenRouter(ctx, key) {
  const catalog = await ctx.llm.templates();
  const tpl = catalog.endpoints.find((/** @type {any} */ t) => t.id === 'openrouter');
  if (!tpl) throw new Error("annai's OpenRouter template isn't available yet. Connect to the internet and try again.");
  await ctx.llm.ensureType(tpl.type);
  return addFromTemplate(ctx, tpl, { key, roles: 'free' });
}

/**
 * Finishes a sign-in when this page load is OpenRouter's callback: takes the code out of the
 * address, trades it for a key, sets up the endpoint, and says how it went.
 * @param {any} ctx llm, ws, store and notices
 * @param {{ fetch?: Fetch, storage?: KeyValue, location?: { search: string, pathname: string }, history?: { replaceState: History['replaceState'] } }} [env]
 * @returns {Promise<boolean>} whether this page load was a callback
 */
export async function finishSignIn(ctx, env = {}) {
  const loc = env.location ?? location;
  const cb = callbackFrom(loc.search);
  if (!cb) return false;
  (env.history ?? history).replaceState(null, '', `${loc.pathname}#/models`);
  try {
    const key = await exchange({ code: cb.code, state: cb.state, fetch: env.fetch, storage: env.storage });
    await connectOpenRouter(ctx, key);
    ctx.notices.toast('Signed in with OpenRouter. annai picked free models to start; you can change them under Roles.');
  } catch (e) {
    ctx.notices.card({ tone: 'warn', title: "Signing in with OpenRouter didn't finish", body: String(/** @type {any} */ (e)?.message ?? e) });
  }
  return true;
}
```

In `sw.js`, add `'/src/ui/openrouter.js',` to `SHELL`, after `'/src/ui/open-file.js',`:

```js
  '/src/ui/openrouter.js',
```

- [ ] **Step 5: Add the sign-in to the Models screen, the suggestions to the endpoint page, and the callback to start-up**

In `src/ui/screens/models.js`, add the import:

```js
import { needsCode, signInUrl, exchange, connectOpenRouter } from '../openrouter.js';
```

In `renderModels`, add `signInSection(ctx, cfg),` right before `endpointsSection(ctx, cfg, catalog),`. Then add these functions:

```js
/** The quickest start: Sign in with OpenRouter (spec §9.8), offered until an OpenRouter endpoint exists. @param {any} ctx @param {import('../../core/llm/config.js').ModelConfig} cfg */
function signInSection(ctx, cfg) {
  if (Object.values(cfg.endpoints).some((e) => e.template?.id === 'openrouter')) return null;
  const status = h('p', { class: 'sub', role: 'status' });
  const codeSlot = h('div', {});
  const btn = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      try {
        if (needsCode()) {
          window.open(await signInUrl({ callback: null }), '_blank', 'noopener');
          codeSlot.replaceChildren(pasteCode(ctx, status));
        } else {
          location.assign(await signInUrl({ callback: `${location.origin}/` }));
        }
      } catch (e) {
        status.textContent = messageOf(e);
      }
    },
  }, 'Sign in with OpenRouter');
  return h('section', { class: 'panel', 'aria-label': 'Sign in' },
    h('h2', { class: 'section', text: 'The quickest start' }),
    h('p', { text: 'Sign in with OpenRouter to get one key for many models. annai starts you on free models (50 requests a day), so trying it costs nothing.' }),
    h('div', { class: 'acts' }, btn),
    codeSlot,
    status);
}

/** On an iPhone Home Screen app: paste the code OpenRouter showed. @param {any} ctx @param {HTMLElement} status */
function pasteCode(ctx, status) {
  const code = h('input', { id: 'openrouter-code', autocomplete: 'off', autocapitalize: 'off' });
  const go = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      go.disabled = true;
      try {
        await connectOpenRouter(ctx, await exchange({ code: code.value, state: null }));
        ctx.notices.toast('Signed in with OpenRouter.');
        ctx.render();
      } catch (e) {
        status.textContent = messageOf(e);
        go.disabled = false;
      }
    },
  }, 'Connect');
  return h('div', { class: 'row' }, field('Paste the code OpenRouter showed you', code), h('div', { class: 'acts' }, go));
}
```

In `src/ui/screens/endpoint.js`, add `useSuggestion` to the templates import:

```js
import { templateUpdates, applyTemplate, addListedModel, useSuggestion } from '../../core/llm/templates.js';
```

In `renderEndpoint`, add `from?.roles ? suggestionsPanel(ctx, id, from) : null,` right before `modelsSection(ctx, id, models),`. Then add:

```js
/** Buttons that put a template's suggested models in the roles ("free", "recommended"). @param {any} ctx @param {string} id @param {import('../../core/llm/templates.js').EndpointTemplate} tpl */
function suggestionsPanel(ctx, id, tpl) {
  /** @type {Record<string, string>} */
  const labels = { free: 'Use the free models', recommended: 'Use the recommended models' };
  return h('section', { class: 'panel', 'aria-label': 'Suggested models' },
    h('p', { class: 'sub', text: `annai's ${tpl.name} template suggests a model for each role.` }),
    h('div', { class: 'acts' }, ...Object.keys(tpl.roles ?? {}).map((which) => h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        await useSuggestion(ctx, id, tpl, which);
        ctx.notices.toast('Roles updated');
        ctx.render();
      },
    }, labels[which] ?? `Use the ${which} models`))));
}
```

In `src/app/main.js`, add the import:

```js
import { finishSignIn } from '../ui/openrouter.js';
```

At the end of `boot()`, after `startPlugins(…)`, add:

```js
  // OpenRouter's sign-in comes back to annai's address with a code (spec §9.8).
  finishSignIn({ llm, ws, store, notices: shell.notices }).then((was) => { if (was) shell.render(); });
```

- [ ] **Step 6: Add the opt-in live suite**

Create `test/live/providers.test.js`:

```js
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
const model = (/** @type {any} */ over) => ({ id: 'live', endpoint: 'live', name: 'live', input: ['text', 'image'], tools: true, contextWindow: null, maxOutput: null, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, ...over });
const orType = load(chat);
const anType = load(anthropic);
const cases = [
  {
    env: 'ANNAI_LIVE_OPENROUTER_KEY', type: orType,
    endpoint: { id: 'live-or', type: 'chat-completions', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: { 'X-Title': 'annai tests' }, tunables: { ...orType.tunables, reasoningField: 'reasoning' }, extraBody: {} },
    model: model({ providerId: 'anthropic/claude-haiku-5.5', reasoning: { low: { reasoning: { effort: 'low' } } } }),
  },
  {
    env: 'ANNAI_LIVE_ANTHROPIC_KEY', type: anType,
    endpoint: { id: 'live-an', type: 'anthropic-messages', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', headers: {}, tunables: { ...anType.tunables }, extraBody: {} },
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
```

In `package.json`, add the script:

```json
    "test:live": "node --test test/live/",
```

- [ ] **Step 7: Document providers for plugin authors, update the README, and write the device checklist**

In `docs/plugins.md`, add these rows to the table in "What `annai` gives you", after the `annai.files` row:

```markdown
| `annai.providers.register(type)` | an endpoint type (spec §9.1): `build()` and `read()` for an HTTP protocol, or `run()` for one that needs no network; see "Endpoint types" below |
| `annai.helpers` | `sse` (server-sent events from a response body), `parsePartialJSON`, `ProviderError`, `errorFromResponse`, `retry` |
```

Then add this section before "## Rules":

````markdown
## Endpoint types

An endpoint type teaches annai one model protocol. The core contains none (spec §9.1).
annai's own Chat Completions and Anthropic Messages types are plugins too: see `plugins-official/`.

```js
export function activate(annai) {
  const { sse, ProviderError } = annai.helpers;
  return annai.providers.register({
    type: 'my-protocol',                 // lowercase letters, digits and dashes
    name: 'My protocol',
    tunables: { path: '/v1/chat' },      // defaults the user can change per endpoint and model
    build({ endpoint, model, key, tunables, request }) {
      return { url: endpoint.baseUrl + tunables.path, headers: { authorization: `Bearer ${key}` }, body: { model: model.providerId } };
    },
    async *read(res) {
      for await (const { data } of sse(res.body)) {
        // yield { type: 'text', text }, { type: 'tool_call', id, name, input }, { type: 'usage', usage }, …
      }
      yield { type: 'stop', reason: 'end' };
    },
  });
}
```

- **What annai does around it:**
  - It merges the endpoint's and the model's extra fields, and the reasoning level's patch, into the body `build()` returns.
  - It sends the request and reads it until the first output arrives in time.
  - It assembles the reply, and works out its cost.
  - It falls back to the next model of the role when this one fails.
  - It records every attempt in the trace, without keys.
- **Errors:** throw a `ProviderError` with a kind (`auth`, `credit`, `rate`, `overloaded`, `context`, `network`, …) and the fallback will know what to do. Anything else you throw counts as a bug in your plugin.
- **Optional parts:**
  - `classify(status, body)` can give a sharper kind for an error response.
  - `listRequest()` and `readList()` make "Fetch model list" work.
````

In `README.md`, replace the status block with:

```markdown
> **Status:** milestones 1, 1b and 1c are built, and the first part of milestone 2: trips with
> versioned files, export and import (optionally encrypted), plugins, offline use and the trace;
> photos; removing trips; and models (endpoints from templates or Sign in with OpenRouter, roles
> with fallback, the Test button, and every request in the trace). Shiori herself comes in the
> second part of milestone 2.
```

Create `docs/testing/device-checklist-m2a.md`:

```markdown
# Milestone 2a: device checklist (talking to models)

Run on a real iPhone (Safari, iOS 26+) and a real Android phone (Chrome), with annai installed to the Home Screen.
It must be served over HTTPS: a deployed preview, or the dev server through `tailscale serve`. A plain `http://100.x.x.x` address won't do, because browsers allow service workers and annai's encryption only over HTTPS.

## Sign in with OpenRouter
- [ ] Android, installed app: Settings → Models → Sign in with OpenRouter. OpenRouter opens. After you approve, annai shows "Signed in with OpenRouter", and the main role lists a free model.
- [ ] iPhone, installed app: the same button opens OpenRouter, and annai asks you to paste the code OpenRouter shows. Copy it, paste it, tap Connect: you're signed in.
- [ ] iPhone, in a Safari tab (not installed): the sign-in comes back to annai by itself.

## Test, and talk
- [ ] On the OpenRouter endpoint, Test. Access and the key get ✓. A free model may fail tool calls or photos; the test says so in plain words.
- [ ] Add an Anthropic endpoint with a key. Test passes. Test reasoning levels lists each level with ✓ or ✗.
- [ ] Talk to your models: the reply streams in. The line under it says which model answered, the tokens, and the cost.
- [ ] Put a model with a wrong key first in the main role: the next model answers, and the line says "after 1 failed attempt (…: key rejected)".
- [ ] Turn on airplane mode in the middle of a reply: what was said stays. With no connection, the talk says no model answered (couldn't connect).
- [ ] Trace: model.turn and net.request entries are there. Open them and "Show what was stored": no key appears anywhere.

## Finish line
- [ ] Milestone 2a is done: a plain text conversation works with fallback across two providers, and the trace shows every request.
```

- [ ] **Step 8: Run everything**

Run: `node --test test/unit/openrouter.test.js`
Expected: PASS, 4 tests.

Run: `npm run test:live`
Expected: every test is skipped ("… is not set"), unless you set keys.

Run: `npm run stamp && npm run check`
Expected: all green, and shipped JS + CSS under 400 KiB.

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test`
Expected: every test passes in both engines.

If WebKit or Chromium doesn't hand the cross-origin preflight (`OPTIONS`) of the key exchange to `page.route`, the sign-in test fails at the exchange with "annai couldn't reach OpenRouter". In that case, route it at the context instead with `context.route('https://openrouter.ai/api/v1/auth/keys', …)`. Record a ruling.

- [ ] **Step 9: Commit**

```bash
git add src/ui/openrouter.js src/ui/screens/models.js src/ui/screens/endpoint.js src/app/main.js sw.js test/unit/openrouter.test.js test/live/providers.test.js test/e2e/models.spec.js package.json docs/plugins.md README.md docs/testing/device-checklist-m2a.md
git commit -m "Sign in with OpenRouter (code to paste on an iPhone Home Screen app), live suite, docs"
```
