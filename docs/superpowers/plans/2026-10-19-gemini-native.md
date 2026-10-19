# Gemini, natively: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** annai talks to Gemini through Google's own Interactions API for chat, transcription and voice:
- Google keeps the conversation between turns, so each turn sends only what's new (on by default, with a switch, and deleted when the user removes it);
- every audio format goes in;
- the voice streams at full quality and starts only once it won't stutter;
- Google Search on paid keys, with Google's answer shown as it came;
- a free-tier switch that makes a free key cost nothing.

**Architecture:**
- **A new official protocol plugin, `gemini-api`,** registers three endpoint types: `gemini` (chat), `gemini-transcription` and `gemini-speech`. provider-gemini 2.x uses them in place of Chat Completions; Gemini Live is unchanged.
- **Four small core additions, each generic so the next protocol (OpenAI Responses) reuses it:**
  - **kept turns:** a store of server-kept turns, a match that continues one, a retry when the provider forgot, and deletions on removal;
  - **free tier:** a provider-level switch, plus provider tools that are paid-only or have a monthly free allowance;
  - **streamed voice:** an optional streaming speech read, and a start rule so a stream never stutters;
  - **attribution:** a display-only reply part, for "From Google Search".

**Tech Stack:** native ES modules, no build step, no runtime dependencies; JSDoc checked by TypeScript (`npm run typecheck`); `node:test` (Node 26); Playwright 1.63.0 in Docker (Chromium as Pixel 7, WebKit as iPhone 15).

**Spec:** `docs/superpowers/specs/2026-10-19-gemini-native-design.md` (approved by the user, 2026-10-19), inside the main spec `docs/superpowers/specs/2026-10-15-annai-design.md`. Read both. The plugin contract is `src/core/llm/contract.js` and `docs/plugins.md` ("Protocols", "Audio formats", "Model providers").

**Starts from:** main after koe-one merges (one Koe list `koe`; Koe's default level "low"; provider-gemini 1.5.0).

---

## What was measured (2026-10-19, the user's free key, line 1)

Recordings, with no key in them, are in `.superpowers/fixtures/gemini/` (git-ignored). Copy the ones a test needs into `test/fixtures/gemini/`, without the first line ("HTTP 200"). The probe scripts are beside them.

| What | Measured | What the plan does |
|---|---|---|
| Stream shape | `event:`/`data:` SSE, ending `data: [DONE]`. `interaction.created` (id) → `step.start`/`step.delta`/`step.stop` per step index → `interaction.completed` (status, usage). | Task 2's reader. |
| Thinking | A `thought` step whose `step.delta` is `{ type: "thought_signature", signature }`. No summary text at low on flash-lite or flash. | `reasoning` with its signature, sent back as a thought step (Task 1). |
| Tool calls | A `function_call` step whose **step.start carries `id`, `name`, `arguments: {}` and its own `signature`**; arguments come as `arguments_delta` pieces. Status `requires_action`. | Two signatures to carry: the thought's, and the call's (`tool_call.extra.signature`). |
| Usage | `total_input_tokens`, `input_tokens_by_modality`, `total_cached_tokens`, `total_output_tokens`, `total_tool_use_tokens`, `total_thought_tokens`; Search adds `grounding_tool_count: [{ type: "google_search", count }]`. | Task 2's usage map; Task 13's search count. |
| Model aliases | Asking for `gemini-3.5-flash` is answered by, and limited as, `gemini-3.6-flash`. | The description lists only models Google answers as themselves (Task 5). |
| Chaining | `store: true` plus `previous_interaction_id` and only a `function_result` works. A chained input holding a `model_output` Google didn't write is accepted. A different model continuing a chain is accepted. | Task 7: a fallback's turn and a model change continue the chain. |
| Deleting | `DELETE /v1beta/interactions/{id}` → 200 `{}`, and 200 again on a deleted one. | A deletion is done on 200 or 404. |
| A forgotten turn | Continuing a deleted id → **404** `{"error":{"message":"Requested entity was not found.","code":"not_found"}}`. A malformed id → 400 `invalid_request`. | 404 `not_found` on a chained call → `forgotten` (Task 7). |
| Limits | gemini-3.6-flash on the free tier: 5 a minute, 20 a day. The 429 says which, and when: "limit: 5 requests per minute on Free Tier). Please retry in 44s" / "limit: 20 requests per day on Free Tier). Please retry in 7h40m31s". The user: flash-lite has higher limits; Live has no request limit. | `retryAfter` from "retry in …" (Task 3). The recommended Main list falls through several flash models (Task 5). |
| Search | On the free key, any request with `{ type: "google_search" }` → 429 at once; without it, 200. On the paid key (one request): `google_search_call` → `google_search_result` (with `search_suggestions`) → `thought` → `model_output` with `annotations` of `url_citation`, alongside a function tool. | Search only off the free tier (Tasks 12–13). |
| Voice | gemini-3.8-flash-lite-tts, voice Kore. Streamed: first audio 0.6 s (4 s sentence), 0.4 s (12 s); whole: 2.0 s, 3.0 s. About 67 KB a second of speech on the wire. | Streamed voice (Tasks 9–10). |

---

## Global Constraints

- No runtime dependencies. Native ES modules. JSDoc types pass `npm run typecheck`.
- The key goes only in the `x-goog-api-key` header, never in a URL (the existing Live plugin excepted). It never goes in a file, an event or the trace. `/llm/kept.json` holds no key.
- Every request a protocol builds goes through `sameOrigin` and `redirect: 'manual'`, including deletions and uploads.
- Removing means removing (spec §4.9): what Google keeps is deleted when the user removes it in annai. Every stored file is named.
- Copy is plain words in the style of the surrounding page. Strings the spec fixes are used exactly:
  - "Let Google keep the conversation between turns: sends less each time."
  - "This key is on the free tier (Google doesn't charge)"
  - "Let Gemini search Google"
  - "Google doesn't offer search on the free tier."
  - "From Google Search"
- No machine names or tailnet addresses in repo files.
- Versions:
  - gemini-api starts at 0.1.0;
  - provider-gemini goes 2.0.0 (G1) → 2.1.0 (G3) → 2.2.0 (G4);
  - openai-realtime gets a minor bump in G3 (its μ-law code moves).
  - Whoever merges after another release bumps again, and runs `npm run catalog`.
- The size budget (scripts/size.mjs): raise it only by the least, with the reason.
- Live tests use the key file's line 1 only, read inside the command (`GEMINI_KEY="$(sed -n 1p /root/annai-test-keys/gemini)"`), never printed. Line 2 is used only when line 1 refuses (Search: one call), and the report says so.

## Review Focus

1. **A fallback turn between Gemini turns** (Gemini rate-limited, another provider answered): the next Gemini call continues the chain, sending the other model's reply as a `model_output` step, and nothing is sent twice. Test in Task 7.
2. **The saving is real:** a photo or voice message sent in turn 1 isn't in turn 2's body when chained. Test in Task 7 asserts turn 2's body has no `data` of turn 1's image.
3. **The free daily limit is used up mid-conversation:** the model rests until Google's "retry in" time, the role falls to the next flash, and the words say "until" a time. Test in Task 3 (classify and retryAfter from the recorded 429s).
4. **A connection slower than real time:** a streamed sentence doesn't start until `readyToStart` says so, then plays without a gap. Test in Task 10 with a fake stream arriving at half real time.
5. **Removing a trip while offline:** its kept turns' deletions wait, and run when a connection comes back; nothing else of the trip is left. Test in Task 8.

---

## The milestones

| | What | Depends on | Release |
|---|---|---|---|
| **G1** | gemini-api's chat type (stateless), model list, errors, uploads; provider-gemini 2.0.0 with priced models, the free-tier switch and the recommended roles. | koe-one merged | yes |
| **G2** | Kept turns: core store, match, forgotten retry, deletions (trip, provider, switch, Erase), and the switch on the provider page. | G1 | yes |
| **G3** | Transcription and voice types; the shared G.711 helper; streamed voice in core and the speaker; provider-gemini 2.1.0. | G1 (in parallel with G2) | yes |
| **G4** | Google Search: provider tool with free allowance and paid-only; the attribution part and "From Google Search" card; provider-gemini 2.2.0. | G2 (both touch call.js) | yes |

Each milestone: one builder in its own worktree, a fresh review, one fix pass, merge, full check and e2e, release, as for earlier milestones. G2 and G3 run at once; their shared files are contract.js (both add typedef lines: merge by hand) and provider-gemini's manifest (G3 owns it in that window; G2 doesn't touch it).

## Decisions this plan makes

1. **Thought steps travel as `reasoning` parts with a signature.** Server-tool steps (search) travel as `provider` parts. Both go back only to the model that wrote them, as core already does for Anthropic's signed thinking (contract.js Part docs). No new part type for them.
2. **A function call's own signature is `tool_call.extra = { signature }`.** Core already sends `extra` back only to the writing model.
3. **Kept turns live in core** (`src/core/llm/kept.js`), not in the plugin, because only core sees scopes, removals, Erase and the provider's key. The protocol only says it can (`keeps: true`), builds the chained body from `c.kept`, emits `{ type: 'kept', id }`, classifies a forgotten turn, and builds deletions (`forgetRequest`).
4. **The match is by per-message fingerprints** of the messages as sent (after `portable` and speech resolution), plus the reply's fingerprint. A turn continues when its fingerprints are a prefix of the new request's messages and the next message is its reply. Otherwise the whole conversation goes, and a new chain starts. Scopes and roles need no ids: content decides.
5. **Retention:** 1 day on a provider marked free tier, else the ability's `keepDays` tunable (default 55, the user may lower it to match AI Studio). Expired records are dropped without a deletion call: Google deleted them.
6. **Deletions** are a queue in the same file, run at start, on `online`, after recording a turn, and on removal. A deletion is done on 200 or 404. On 401/403 it stays, but provider removal drops them with the key (below).
7. **Provider removal and Erase** try their deletions at once (up to 10 s), with the key still present. What's left is named in the confirmation before the tap ("Google keeps N turns until they expire, up to D days"). Nothing outlives Erase or the key, because a key can't be kept after removal.
8. **The free tier is provider-level** (`ProviderValues.free`), offered when the description says `"freeTier": true`. A free endpoint's calls cost 0, and its `paidOnly` provider tools are left out.
9. **Only conversation turns are kept.** Core sets `CallSpec.keep` for the roles `main` and `koe` when the ability's `keep` tunable is on. Utility, quick decisions, Test and "Try this model" send `store: false`, so nothing one-off is left on Google's side.
10. **Search is a provider tool** (`kind: 'search'`, patch `tools+`), `paidOnly`, `freePerMonth: 5000`, `pricePerCall: 0.014`, `usageKey: 'google_search'`. This phone's monthly count is in `/llm/tool-calls.json`.
11. **"From Google Search" is an `attribution` part**, display-only: `portable()` drops it, so no protocol ever sees it. Google's suggestion HTML is drawn in `src/ui/grounding.html`: same origin, sandboxed without `allow-same-origin`, with its own CSP allowing inline styles. annai's own CSP is unchanged.
12. **Streamed voice:** `readSpeechStream` yields PCM; the speaker plays it through `player.stream`. The start rule is `readyToStart`, a pure function: speech length estimated from text at 15 characters a second, × 1.2.
13. **Transcription is a generation request** with a fixed instruction, unless `transcription_config` turns out to be Google's documented plain speech-to-text (the builder checks with one call and records which).
14. **Uploads (Files API):** only if a single multipart request works with `FormData` (the contract's body). If Google needs `multipart/related`, leave `uploadRequest` out: chaining already sends each photo once. Say which in the report.

---

## Shapes

### Contract additions (src/core/llm/contract.js, docs/plugins.md)
```js
// Part: display-only, dropped by portable()
| { type: 'attribution', source: string, text: string, links: { url: string, title?: string }[], html?: string, model?: string }
// StreamEvent
| { type: 'kept', id: string }                       // the provider kept this turn under id (G2)
| { type: 'attribution', source: string, text: string, links: { url: string, title?: string }[], html?: string }   // (G4)
// ErrorKind: 'forgotten' — PLAIN: "The provider no longer has the earlier turns; annai sends the conversation whole."
// CallSpec: kept?: { id: string, from: number }   — continue turn id; send only request.messages.slice(from)
//           keep?: boolean                            — keep this turn on the provider's side (conversation roles, switch on)
// EndpointType:
//   keeps?: true                                    — can keep turns (G2)
//   forgetRequest?: (c: { endpoint: Endpoint, key: string | null, id: string }) => { url: string, headers: Record<string, string>, method: 'DELETE' }
//   readSpeechStream?: (res: Response, c: SpeechSpec) => AsyncIterable<{ pcm: Int16Array, rate: number }>   (G3)
//   retryAfter?: (body: string) => number | undefined   — ms a 429's body asks to wait, when no header says (G1)
// ListedModel: reasoning?: Record<string, any>      — a listed model's level map (G1)
```

### Config additions (src/core/llm/config.js)
- `ProviderValues.free?: boolean`, `Provider.free: boolean`, `Endpoint.free: boolean` (G1).
- `ProviderTool.paidOnly?: boolean`, `ProviderTool.freePerMonth?: number` (G4).
- A description's `provider.freeTier?: true` (provider-desc.js validates it) (G1).
- Ability tunables of `gemini`: `keep` (true), `keepDays` (55), `uploads` (as today). Of `gemini-speech`: `voice` ('Kore'), `format` ('pcm24' | 'mulaw16' | 'mulaw8'), `stream` (true).

### Files annai keeps (SYS_SETTINGS)
- `/llm/kept.json`: `{ turns: KeptTurn[], forget: { id: string, endpoint: string, at: number }[] }` (G2).
- `/llm/tool-calls.json`: `{ month: 'YYYY-MM', counts: Record<string, number> }` (G4).

```js
/** @typedef {{ id: string, endpoint: string, model: string, scope: string, hashes: string[], reply: string, at: number }} KeptTurn
 *  hashes: each sent message's fingerprint; reply: the reply message's fingerprint; at: when it was kept (ms) */
```

### The plugin's request (gemini type)
```js
{ model, store, stream: true, system_instruction, tools: [{ type: 'function', name, description, parameters }, ...search],
  generation_config: { max_output_tokens, thinking_level?, thinking_summaries: 'auto', tool_choice? },
  previous_interaction_id?, input: Step[] }
// Step: { type: 'user_input', content: Content[] } | { type: 'thought', signature, summary?: [{ type: 'text', text }] }
//   | { type: 'model_output', content: [{ type: 'text', text }] } | { type: 'function_call', id, name, arguments, signature? }
//   | { type: 'function_result', call_id, name, result: [{ type: 'text', text }], is_error? } | a provider part's block as it came
// Content: { type: 'text', text } | { type: 'image' | 'audio' | 'document', data, mime_type } | { type: 'image', uri, mime_type }
```

---

## File structure

**New**
- `plugins-official/gemini-api/annai-plugin.json`: the manifest (`files`: index.js, steps.js, chat.js, levels.js, speech.js).
- `plugins-official/gemini-api/index.js`: `activate(annai)` registers the three types.
- `plugins-official/gemini-api/steps.js`: annai messages ↔ Interactions steps. Pure.
- `plugins-official/gemini-api/chat.js`: the `gemini` type (build, read, classify, list, uploads, forgetRequest).
- `plugins-official/gemini-api/levels.js`: reasoning maps by model family.
- `plugins-official/gemini-api/speech.js` (G3): `gemini-transcription` and `gemini-speech`.
- `src/core/llm/kept.js` (G2): `Kept`, `fingerprint`.
- `src/core/llm/tool-month.js` (G4): `ToolMonth`.
- `src/core/voice/g711.js` (G3): moved from openai-realtime.
- `src/core/voice/stream-start.js` (G3): `readyToStart`, `estimateSeconds`.
- `src/ui/grounding.html`, `src/ui/grounding.js` (G4): the sandboxed suggestions frame.
- `test/fakes/gemini-server.js`: a stand-in Interactions server for e2e and unit tests.
- Tests:
  - unit: `test/unit/gemini-steps.test.js`, `gemini-read.test.js`, `gemini-chat.test.js`, `gemini-speech.test.js`, `kept.test.js`, `tool-month.test.js`, `stream-start.test.js`, `speech-stream.test.js`;
  - e2e: `test/e2e/gemini.spec.js`;
  - live: `test/live/gemini-api.test.js`;
  - fixtures: `test/fixtures/gemini/*`.
- `docs/testing/device-checklist-gemini.md`.

**Changed**
- `src/core/llm/contract.js`, `call.js` (kept, free, attribution, the tool month), `fallback.js` (the forgotten retry), `speech.js` (streams), `config.js`, `provider-desc.js`, `providers.js` / `service.js` (useSuggestion switching abilities on; forgetScope and forgetAll; removal deletions), `cost.js` (free).
- `src/core/voice/speaker.js` (streams), `src/plugins/voice-browser/index.js` (only if `stream()` needs `level`).
- `src/ui/screens/provider.js` (the switches), `trip.js` and `settings.js` (deletions on removal and Erase), `talk.js` (the card).
- `plugins-official/provider-gemini/annai-plugin.json`, `plugins-official/openai-realtime/index.js` (G.711 from the helper).
- `src/core/plugins` (wherever `annai.helpers` is built), adding `g711`.
- `_headers` (grounding.html's CSP), `scripts/serve.mjs` (if it sets headers per file), the shipped-files list for the service worker.
- Docs: `docs/plugins.md`, the spec (§9.1, §9.5, §10.6, §4.9, §16), `docs/superpowers/specs/2026-10-19-gemini-native-design.md` (status: built).

---

# G1: Gemini chat, natively

### Task 1: Steps: annai's messages as Interactions input

**Files:** Create `plugins-official/gemini-api/steps.js`, `test/unit/gemini-steps.test.js`.

**Interfaces:**
- Produces:
  - `toInput(messages: Message[], o: { model: string, tail?: string }) => Step[]`;
  - `toContent(part: Part) => Content | null`;
  - `toolSchema(t: ToolDef) => { type: 'function', name, description, parameters }`.

- [ ] **Step 1: Write the failing tests**
  - `a user message becomes one user_input step, text, image, audio and document parts in order`: base64 `data` with `mime_type`; an image with `fileId` → `{ type: 'image', uri: fileId, mime_type }`; a `missing` image is left out.
  - `the tail goes last in the final user_input`.
  - `an assistant message's parts become steps in their order`:
    - reasoning with signature and this model → `{ type: 'thought', signature, summary: [{ type: 'text', text }] }` (no summary when text is empty);
    - text → model_output (adjacent texts joined);
    - tool_call → function_call with `arguments` and `signature` from `extra.signature`;
    - a provider part → its block unchanged.
  - `another model's signed reasoning and tool_call extra are not sent`: a reasoning part with `model: 'other'` is dropped; a tool_call keeps id, name and arguments, without signature.
  - `tool results become function_result steps named after their call`: name looked up from the earlier tool_call, `is_error` when `isError`, `result: [{ type: 'text', text: content }]`.
  - `a tool result whose call isn't in the messages uses the name 'tool'` (a trimmed conversation).
- [ ] **Step 2:** `node --test test/unit/gemini-steps.test.js` → FAIL (module not found).
- [ ] **Step 3:** Implement the three functions in `steps.js`. A user message's `tool_result` parts become `function_result` steps before its other content, which then forms one `user_input` step if any is left.
- [ ] **Step 4:** Run again → PASS.
- [ ] **Step 5:** Commit.

### Task 2: The `gemini` chat type: request and stream

**Files:** Create `plugins-official/gemini-api/chat.js`, `index.js`, `annai-plugin.json`, `test/unit/gemini-read.test.js`, `test/unit/gemini-chat.test.js`, and `test/fixtures/gemini/` (from the recordings).

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `chatType(annai) => EndpointType` with `type: 'gemini'`, `name: 'Gemini API'`, `tail: true`, `tunables: { uploads: true, audioIn: ['ogg', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav'] }` (G2 adds `keep: true, keepDays: 55`);
  - `readStream(body: ReadableStream, c) => AsyncIterable<StreamEvent>`;
  - `readWhole(json) => StreamEvent[]`.

- [ ] **Step 1: Write the failing tests**
  - `build: the URL, the key header and the body`:
    - url `${baseUrl}/v1beta/interactions` (baseUrl without a trailing slash);
    - headers `{ 'x-goog-api-key': key, 'content-type': 'application/json' }`, and the key appears nowhere else in the built request;
    - body `{ model: providerId, store: false, stream: true, system_instruction, tools, generation_config: { max_output_tokens, thinking_summaries: 'auto' }, input }`;
    - `toolChoice` → `generation_config.tool_choice = { allowed_tools: { mode: 'any', tools: [name] } }`.

    (`store` becomes the tunable in G2; in G1 it's always false.)
  - `read: the recorded call` (`flash-call-with-signatures.sse`) yields:
    - `{ type: 'reasoning', text: '', signature: <thought's> }`;
    - `{ type: 'tool_call', id: 'call_41070', name: 'get_weather', input: { city: 'Kyoto' }, extra: { signature: <call's> } }`;
    - usage `{ input: 57, … }`;
    - `{ type: 'stop', reason: 'tool' }`.
  - `read: the recorded answer` (`lite-result-chained.sse`) yields text "The current weather in Kyoto is 18°C with light rain.", then `stop: 'end'`.
  - `read: thought_summary deltas are reasoning_delta, and the whole summary is the reasoning text`: a synthetic stream.
  - `read: an error event throws a ProviderError`: synthetic `event: error` with `code: 'gateway_timeout'` → kind 'server'.
  - `read: a whole JSON reply` (`lite-foreign-output-chained.json`) gives the same events as a stream would.
  - `usage: thinking counts as output, cached tokens as cache reads, audio and image apart`: map `total_input_tokens - cached - audio - image` → input; `total_cached_tokens` → cacheRead; `total_output_tokens + total_thought_tokens` → output; `total_thought_tokens` → reasoning; the `input_tokens_by_modality` audio and image entries → audioIn and image.
  - `stop: status completed → end, requires_action → tool, incomplete → length`.
  - `a safety block ends the turn as a refusal with Google's reason in words`: `stop: 'refusal'` plus a text event with Google's reason, never a thrown error, so no other model is tried (the design). The builder finds the block's real shape (an `error` code, a `failed` status, or a field on the interaction) from Google's docs or a deliberately blocked request, and records it as a fixture.
- [ ] **Step 2:** Run both files → FAIL.
- [ ] **Step 3:** Implement `chatType`. `read` uses `annai.helpers.sse`, keyed by step `index`:
  - each `function_call` collects its `arguments_delta` pieces and is parsed at `step.stop` (an empty string → `{}`);
  - each `thought` collects its signature and summary;
  - the response's `content-type` decides stream or whole JSON.

  `index.js` registers it with `annai.providers.register`.
- [ ] **Step 4:** Run → PASS. Also `npm run typecheck`.
- [ ] **Step 5:** Commit.

### Task 3: Errors, model list, levels and uploads

**Files:** Create `plugins-official/gemini-api/levels.js`. Modify `chat.js`, `src/core/llm/contract.js` (`ListedModel.reasoning`), `src/core/llm/providers.js` (addListedModel keeps `reasoning`, if it doesn't already). Test `test/unit/gemini-chat.test.js`.

**Interfaces:**
- Produces:
  - `classify(status: number, body: string) => ErrorKind | null`;
  - `retryAfterMs(body: string) => number | undefined` (exported for the test);
  - `listRequest`, `readList(json) => ListedModel[]`;
  - `levelsFor(providerId: string) => Record<string, any> | undefined`;
  - `uploadRequest` / `readUpload`, per Decision 14.

- [ ] **Step 1: Write the failing tests**
  - `classify`:

    | Response | Kind |
    |---|---|
    | 400 "API key not valid", 401, 403 | `auth` |
    | 429 (both recordings) | `rate` |
    | 503 | `overloaded` |
    | 400 naming the token limit | `context` |
    | 400 naming the audio format or mime type | `null` (so core's WAV retry works) |
    | 404 `not_found` | `not-found` (G2 refines this) |
  - `retryAfterMs`:
    - "Please retry in 44s" → 44000;
    - "retry in 7h40m31s" → 27631000;
    - none → undefined.

    The error thrown for a 429 carries it as `retryAfter`. Wire it through `classify`'s caller if core's `errorFromResponse` doesn't read the body: the plugin's `read` never sees error responses, so do it in core by asking an optional `type.retryAfter?(body)`, documented in contract.js.
  - `the per-day 429 says when, in words`: the message names the time Google gave.
  - `readList`:
    - from a recorded-shape JSON, chat models are those with `generateContent`, excluding ids matching `/tts|live|embedding|image|native-audio|transcribe|translate|robotics/`;
    - `inputTokenLimit` → contextWindow, `outputTokenLimit` → maxOutput;
    - `thinking: true` → `reasoning: levelsFor(id)`;
    - input `['text', 'image', 'audio', 'document']`;
    - `listRequest` is `${baseUrl}/v1beta/models?pageSize=1000` with the key header.
  - `levelsFor`:
    - 'gemini-3.5-flash-lite' and 'gemini-3.6-flash' include off → `{ generation_config: { thinking_level: 'minimal' } }`;
    - 'gemini-3.8-flash' has no off;
    - max maps to high.

    Families from the measured table and Google's thinking page: minimal for 3.6-flash, 3.5-flash-lite, 3-flash-preview; low/medium/high only for 3.8-flash, 3.7-flash, 3.1-pro, 3-pro, 2.5.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. For uploads, try one real multipart `FormData` upload with the free key (the probe scripts show the pattern). Implement per Decision 14, and note the outcome in the plugin's top comment.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

### Task 4: The free-tier switch (core)

**Files:** Modify `src/core/llm/config.js`, `provider-desc.js`, `call.js`, `speech.js`, `cost.js` (if cleaner there), `src/ui/screens/provider.js`. Test `test/unit/llm-cost.test.js`, `test/unit/provider-desc.test.js`.

**Interfaces:** Produces `Endpoint.free: boolean`, `Provider.free: boolean`, and `service.setFree(providerId: string, on: boolean)`.

- [ ] **Step 1: Write the failing tests**
  - `a provider marked free tier costs nothing`: callOnce with `endpoint.free` and priced usage → `cost: 0` in the reply and the trace. Likewise speechCall.
  - `freeTier in a description is a boolean or absent`.
  - `the free-tier switch shows only for a description with freeTier`: a provider page unit or e2e step.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. On the provider page, under the key: a `savedCheck` with "This key is on the free tier (Google doesn't charge)" in the provider's own words, `${desc.name}` where the copy names Google. Under it, a sub line: "AI Studio shows each key's tier."
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

### Task 5: provider-gemini 2.0.0, its recommended roles, and the stand-in server

**Files:**
- Modify `plugins-official/provider-gemini/annai-plugin.json`, `src/core/llm/service.js` (`useSuggestion` switching abilities on), `src/ui/screens/provider.js` (the button calls it).
- Create `test/fakes/gemini-server.js` and `test/e2e/gemini.spec.js`.
- Test `test/unit/official-providers.test.js`.

**Interfaces:**
- Produces `service.useSuggestion(providerId: string, which: string): Promise<void>`: it switches on, through `setAbility`, every ability whose models the suggestion names, then fills the roles.
- `startGeminiServer({ replies }) => { url, bodies(), deleted(), close() }`: serves `/v1beta/models`, `POST /v1beta/interactions` (SSE or JSON per `stream`) and `DELETE /v1beta/interactions/:id`.

- [ ] **Step 1: Write the failing tests**
  - official-providers: provider-gemini is 2.0.0 and its manifest says:
    - `requires` gemini-api `^0` and gemini-live `^0`, not chat-completions;
    - chat ability `type: 'gemini'`, baseUrl `https://generativelanguage.googleapis.com`;
    - `freeTier: true`;
    - no `standInCallExtra`;
    - priced chat models gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash-lite, each with its `reasoning` map from `levelsFor`;
    - the live models declare `input: ['text', 'image']`.
  - Recommended roles:
    - `main: [gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash-lite]` (different quotas, so a used-up day falls to the next; 3.5-flash is left out because Google answers it as 3.6-flash);
    - `utility` and `decide: [gemini-3.5-flash-lite]`;
    - `koe: [gemini-3.8-live, gemini-3.5-flash-lite]`.

    Before writing the list, the builder checks with one call each that Google answers 3.7-flash as itself.
  - `useSuggestion switches on the live ability the recommended Koe names`: with Live off, after the tap Live is on, gemini-live is installed, and Koe is `[live, flash-lite]`. Adding the provider alone leaves Koe empty.
  - e2e `gemini.spec.js`, against the stand-in:
    - Add Gemini from the catalog;
    - the key;
    - Fetch model list shows chat models with their windows;
    - Test passes with the tool and the photo;
    - Try this model streams;
    - the request carried the key only in `x-goog-api-key` (the stand-in records headers and URL);
    - the free-tier switch makes Spend show $0.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
  - **Prices:** from Google's pricing page on the day, with the date in a manifest comment field if the schema allows one, else in the commit message.
  - **The provider's note:** that it uses Gemini's own API.
  - **Ability notes:** Live's stays as it is.
  - **The move-over:** an existing 1.x provider's chat ability gets the new type with its models kept. If a model can't be kept, the provider page says to fetch the list again.
  - **Then:** `npm run catalog`, `npm run stamp`.
- [ ] **Step 4:** `npm run check` and the e2e file in Docker → PASS.
- [ ] **Step 5:** Commit.

### Task 6: G1 live test and docs

**Files:** Create `test/live/gemini-api.test.js`. Modify `docs/plugins.md` (the Audio formats list: Gemini takes all of them; `ListedModel.reasoning`; `freeTier`), the spec (§9.1 Gemini's protocol), and the device checklist (create it with the G1 items).

- [ ] **Step 1: Write the live tests** (skip without `GEMINI_KEY`):
  - two turns with a tool call on gemini-3.5-flash-lite, through annai's `callOnce`: turn 2 carries both signatures back, and the answer uses the tool result;
  - an Opus clip as an audio part, answered;
  - Fetch model list gives a context window for gemini-3.5-flash-lite.
- [ ] **Step 2:** Run with the key (Global Constraints) → PASS, with pauses for 5 a minute.
- [ ] **Step 3:** Docs.
- [ ] **Step 4:** Commit.

---

# G2: Google keeps the conversation

### Task 7: Kept turns in core

**Files:** Create `src/core/llm/kept.js`, `test/unit/kept.test.js`. Modify `contract.js` (Shapes), `call.js`, `fallback.js` (the retry), `service.js` (wiring a `Kept` like `uploads`), and `plugins-official/gemini-api/chat.js` (`keeps`, `store`, `previous_interaction_id`, the `kept` event, `forgetRequest`, `forgotten`).

**Interfaces:**
- Produces:
  - `fingerprint(m: Message) => string`: stable; base64 data hashed, not kept;
  - `class Kept`:
    - `constructor({ ws, now })`;
    - `match(endpointId: string, messages: Message[], o: { free: boolean, keepDays: number }) => Promise<{ id: string, from: number } | null>`;
    - `record(t: { id, endpoint, model, scope, messages, reply: Message }) => Promise<void>`;
    - `forget(id: string) => Promise<void>`: drops it, no call;
    - `queueScope(scope)` and `queueEndpoint(endpointId) => Promise<number>`: how many are queued;
    - `drain({ types, config, keyFor, fetch, signal }) => Promise<{ done: number, left: number }>`;
    - `count(o?: { endpoint?: string, scope?: string }) => Promise<number>`.
- Core:
  - in `callOnce`, when `type.keeps && endpoint.tunables.keep !== false` and the call is a conversation role (`main`, `koe`; Decision 9), `spec.keep = true` and `spec.kept = await kept.match(...)`. Other roles get `spec.keep = false`;
  - a `kept` event → after success, `kept.record` with `scope` (the call's);
  - `forgotten` with `spec.kept` → `kept.forget(id)` and rethrow; without it → `not-found`;
  - in `callRole`, `forgotten` retries the same model once, as `upload` does.
  - The trace's request info gains `kept: { from }` when chained, and `bytes`: the body's length.
- Plugin:
  - `keeps: true`;
  - body `store: c.keep === true`;
  - with `c.kept`: `previous_interaction_id: c.kept.id` and `input: toInput(messages.slice(c.kept.from), …)`;
  - emits `{ type: 'kept', id }` from `interaction.created` when `store` is true;
  - classify: 404 with `"code":"not_found"` and "Requested entity was not found" → `forgotten`;
  - `forgetRequest` → `DELETE ${baseUrl}/v1beta/interactions/${encodeURIComponent(id)}` with the key header.

- [ ] **Step 1: Write the failing tests**
  - `a request that continues a kept turn sends only what follows`: record turn 1 (messages m1, reply r1); match `[m1, r1, toolResult]` → `{ id, from: 2 }`.
  - `a changed history, a one-off call, another endpoint: no match`.
  - `the longest kept turn wins`: two turns in a chain → the later one.
  - `free tier keeps for a day, else keepDays`: at 25 h a free match is null and its record dropped; at 25 h paid matches.
  - `a fallback turn in between continues the chain` (Review Focus 1): kept [m1] → r1 (Gemini); then r2 from another model, recorded nowhere. Request `[m1, r1, m2, r2, m3]` matches `{ from: 2 }`, and the built body's input is `[user_input m2, model_output r2, user_input m3]` (gemini-chat.test.js, using the plugin).
  - `turn 2 doesn't carry turn 1's photo` (Review Focus 2): the built body for the chained turn has no `data` equal to turn 1's image base64.
  - `forgotten`, with the stand-in answering the recorded 404:
    - the same model is called once more, whole;
    - the record is gone;
    - the reply arrives;
    - the trace shows both attempts.
  - `nothing kept holds a key`: kept.json after a call contains neither the key nor the base64 of a photo.
  - `a utility call isn't kept`: callRole with role 'utility' builds `store: false`, emits no record, and matches nothing.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Keep `kept.json` small: drop expired turns on every write, and keep at most 200 turns (oldest first out, queued for deletion).
- [ ] **Step 4:** Run → PASS. Also `npm run typecheck`.
- [ ] **Step 5:** Commit.

### Task 8: Deletions, the switch, and removing

**Files:** Modify `src/core/llm/service.js` (`forgetScope`, `forgetAll`; `removeProvider` drains first), `src/ui/screens/trip.js` (after `removeTrip`), `src/core/live/sim-run.js` (after its `removeTrip`), `src/ui/screens/settings.js` (Erase), `src/ui/screens/provider.js` (the switch and the waiting count), and the app start (a drain at start and on `online`). Tests: `test/unit/kept.test.js`, `test/e2e/gemini.spec.js`.

**Interfaces:**
- Produces:
  - `service.forgetScope(scope: string) => Promise<{ queued: number }>`;
  - `service.forgetAll({ timeoutMs }) => Promise<{ left: number }>`;
  - `service.keptCount(o?) => Promise<number>`.

- [ ] **Step 1: Write the failing tests**
  - `removing a trip queues its kept turns' deletions and runs them`: the stand-in sees one DELETE per turn of that scope, none of another trip's.
  - `offline, deletions wait and run when online` (Review Focus 5): fetch rejects → `left` > 0, the queue persists across a new `Kept`; then online → done.
  - `switching keep off queues all of that ability's turns`; switching it back on starts fresh chains.
  - `removing the provider deletes first`: with the stand-in, every DELETE happens before the key is removed. Offline: the confirmation text names the count and the days ("Google keeps 3 turns until they expire, up to 55 days"), and after removal `kept.json` has none of that provider's.
  - e2e:
    - the provider page shows the switch with the spec's words and the plain-words note (what's kept, how long, deleted when removed here), and "N deletions waiting" while offline;
    - Erase with kept turns: the Erase section says Google's copy is deleted first. With the stand-in, its DELETEs arrive before the reload.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Erase calls `ctx.llm.forgetAll({ timeoutMs: 10_000 })` before `ctx.store.close()`. When `left` is above 0, the section's text above the button says so before the tap (count from `keptCount`). Bump gemini-api to 0.2.0.
- [ ] **Step 4:** Run → PASS. Then the full check, and e2e in Docker.
- [ ] **Step 5:** Commit. Docs: spec §4.9 (what a provider keeps), docs/plugins.md ("Kept turns" under Protocols), and the device checklist (switch, removal, offline).

---

# G3: Transcription, voice, and streaming

### Task 9: The shared G.711 helper, and the two speech types

**Files:**
- Create `src/core/voice/g711.js`, `plugins-official/gemini-api/speech.js`, `test/unit/gemini-speech.test.js`.
- Modify `plugins-official/openai-realtime/index.js` (use the helper; bump its minor), wherever `annai.helpers` is built (add `g711`), `plugins-official/gemini-api/index.js` and its manifest `files`.

**Interfaces:**
- Produces:
  - `g711 = { ulawToPcm(bytes: Uint8Array): Int16Array, pcmToUlaw(pcm: Int16Array): Uint8Array, alawToPcm, pcmToAlaw }`;
  - `transcriptionType(annai)`: `speech: 'in'`, `tunables: { audioIn: ['ogg','webm','mp4','aac','mp3','flac','wav'] }`;
  - `speechType(annai)`: `speech: 'out'`, `tunables: { voice: 'Kore', format: 'pcm24', stream: true }`, with `readSpeech` always giving a WAV clip.

- [ ] **Step 1: Write the failing tests**
  - g711 round-trips the openai-realtime tests' vectors, moved here.
  - `transcribeRequest`:
    - body `{ model, store: false, input: [{ type: 'user_input', content: [{ type: 'text', text: INSTRUCTION }, { type: 'audio', data, mime_type }] }], generation_config }` (a JSON string), with the key only in the header;
    - `readTranscript` gives the model_output text, trimmed.
  - `speechRequest`:
    - `response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 }` for pcm24, and `audio/mulaw` at 16000 or 8000 for the others;
    - `generation_config.speech_config: [{ voice }]`;
    - `stream` per the tunable.
  - `readSpeech: a whole clip`: from a non-streamed WAV reply → the same WAV; from μ-law → WAV at its rate, decoded.
  - `readSpeech of a stream`: SSE audio deltas joined → one WAV.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement, with the transcription instruction: "Transcribe this speech exactly, in its own language. Output only the words." Check Decision 13 with one real call and use what works.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

### Task 10: Streamed voice: contract, speechCall, speaker

**Files:** Create `src/core/voice/stream-start.js`, `test/unit/stream-start.test.js`, `test/unit/speech-stream.test.js`. Modify `contract.js` (`readSpeechStream`), `src/core/llm/speech.js`, `src/core/voice/speaker.js`, and `plugins-official/gemini-api/speech.js` (`readSpeechStream`).

**Interfaces:**
- Produces:
  - `estimateSeconds(text: string) => number`: `text.length / 15`;
  - `readyToStart(o: { bufferedS: number, receivedS: number, elapsedS: number, estimatedS: number, ended: boolean, cushionS?: number }) => boolean`;
  - `speechCall(c & { stream?: true })`: resolves `{ stream: SpeechStream, cost, ms }` when the type has `readSpeechStream` and the tunable `stream !== false`, else `{ clip }`;
  - `SpeechStream = { rate: number, chunks: AsyncIterable<Int16Array> }`.
- Speaker: `deps.synthesize` may resolve a `SpeechStream`. `#say` plays one through `platform.player.stream({ rate, onLevel })`, holding chunks until `readyToStart`. Prefetching a stream keeps reading it into a buffer.

- [ ] **Step 1: Write the failing tests**
  - `readyToStart`:
    - with ended → true;
    - at 6× real time with 0.3 s buffered → true (`cushionS` 0.3);
    - at half real time with an estimated 10 s → false until 6 s are buffered (`(1 - 0.5) × 10 × 1.2`);
    - nothing received → false.
  - `speech-stream: a stream at half real time starts late and leaves no gap` (Review Focus 4): a fake player records each push time and its scheduled start. A fake stream of 4 s of audio arriving at 0.5× gives no chunk scheduled after the previous one ended.
  - `a stream that fails after 1 s of audio`:
    - the player stream is stopped;
    - the entry is benched;
    - the same sentence goes to the next voice;
    - the trace counts the sentence once.
  - `stream off`: with `stream: false` the type's `readSpeech` gives a whole clip, played with `player.play`.
  - `the first chunk must come in 15 s, then no gap over 15 s`: a time limit like the whole clip's.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. The speaker keeps its prefetch, so sentence i+1's stream reads ahead while i plays.
- [ ] **Step 4:** Run → PASS, then the full check.
- [ ] **Step 5:** Commit.

### Task 11 (G3): provider-gemini 2.1.0 with transcription and voice, and the e2e

**Files:** Modify `plugins-official/provider-gemini/annai-plugin.json`, `test/e2e/gemini.spec.js`, `test/live/gemini-api.test.js`, `docs/plugins.md`, the device checklist.

- [ ] **Step 1: Write the failing tests**
  - official-providers: abilities `transcription` (gemini-transcription; gemini-3.5-flash-lite, priced per minute from its audio token rate) and `voice` (gemini-speech; gemini-3.8-flash-lite-tts and gemini-3.8-flash-tts, priced per character from their output rate). Recommended `speech-in: [flash-lite]` and `speech-out: [gemini-3.8-flash-lite-tts]`.
  - e2e:
    - a voice reply through the stand-in streams PCM and is played through `player.stream` (the page's audio events);
    - a transcription of an Opus clip sends `audio/ogg`;
    - the voice ability shows the format choice in plain words: "Full quality (the most data)", "Phone quality, 16 kHz", "Phone quality, 8 kHz". Full quality is the default.
  - live: a 2-sentence voice reply streamed (first audio under 1.5 s), and an Opus clip transcribed (both on the free key).
- [ ] **Step 2–4:** Fail → implement (bump to 2.1.0, `npm run catalog`) → pass. Find the TTS models' free-tier limits (AI Studio's rate-limit page if reachable, else what a 429 says) and put them in the report and the voice ability's note. If a day's limit is too small to speak a day's replies, the note says so in words.
- [ ] **Step 5:** Commit. Device checklist: the iPhone streamed voice with the silent switch, Bluetooth, the car, the screen locking mid-sentence, a weak connection, and the switch back to whole clips.

---

# G4: Google Search

### Task 12: Paid-only provider tools with a monthly allowance (core)

**Files:** Create `src/core/llm/tool-month.js`, `test/unit/tool-month.test.js`. Modify `config.js` (ProviderTool), `call.js` (`enabledProviderTools(model, request, endpoint)`; cost with the month), `service.js` (wire `ToolMonth`).

**Interfaces:**
- Produces `class ToolMonth { constructor({ ws, now }); bill(toolId: string, count: number, freePerMonth: number) => Promise<number> }`: the calls over the allowance.

- [ ] **Step 1: Write the failing tests**
  - `the first 5000 searches of a month cost nothing, then 0.014 each`: bill 4999 then 3 → 2 billable.
  - `a new month starts over`.
  - `a free-tier endpoint leaves paidOnly tools out of the body`: the patch isn't applied.
  - `the count is per phone, in /llm/tool-calls.json`.
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5:** Commit.

### Task 13: Search in the Gemini plugin, and the "From Google Search" card

**Files:**
- Modify `plugins-official/gemini-api/chat.js` (search steps; `url_citation` → `citation`; the attribution event), `contract.js` (`attribution`), `call.js` (take `attribution` into parts), `contract.js`'s `portable` (drop `attribution`), and `src/ui/screens/talk.js` (the card).
- Create `src/ui/grounding.html` and `src/ui/grounding.js`.
- Modify `_headers`, `plugins-official/provider-gemini/annai-plugin.json` (2.2.0: a `providerTools` entry on Gemini 3 models), `test/e2e/gemini.spec.js`.

**Interfaces:**
- The search provider tool: `{ id: 'gemini-google-search', name: 'Google Search', kind: 'search', patch: { 'tools+': [{ type: 'google_search' }] }, pricePerCall: 0.014, usageKey: 'google_search', paidOnly: true, freePerMonth: 5000 }`.
- Usage: `grounding_tool_count` → `serverTools.google_search`.
- Stream:
  - `google_search_call` → `reasoning_delta` "Searching Google: q1, q2", plus a `provider` part;
  - `google_search_result` → a `provider` part;
  - at the end of a grounded reply, one `attribution` event: `source: 'Google Search'`, the model_output text as it came, its `url_citation` links, and the result's `search_suggestions` HTML.

- [ ] **Step 1: Write the failing tests**
  - read: a recorded-shape grounded reply (built from the measured step list) yields:
    - the progress line;
    - two provider parts;
    - the text;
    - citations;
    - one attribution;
    - usage `serverTools.google_search: 2`.
  - `portable drops attribution parts`, so no protocol sees them.
  - e2e:
    - a grounded reply shows a card titled "From Google Search" with the text exactly as the stand-in sent it, its links as plain links (`rel="noopener noreferrer"`, no tracking), and the suggestions in an `iframe[sandbox]` whose `sandbox` lacks `allow-same-origin`;
    - with Koe on and notes hidden, the card still shows;
    - the provider page's "Let Gemini search Google" switch is on by default, and off and disabled with "Google doesn't offer search on the free tier." when the free-tier switch is on.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
  - **grounding.html:** gets the HTML by `postMessage` from its parent (checking `event.origin === location.origin` of the parent: the frame's own origin is opaque, so check `event.source === parent`) and sets it with `innerHTML`.
  - **_headers for `/src/ui/grounding.html`:** `default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; script-src 'self'; frame-ancestors 'self'`.
  - **Bookkeeping:** add both files to the shipped files, then `npm run stamp`.
- [ ] **Step 4:** Run → PASS. Live: one grounded call with line 2 (Search needs a paid key), noted in the report.
- [ ] **Step 5:** Commit. Docs: spec §9.5 (Google Search), docs/plugins.md (`attribution`, `paidOnly`, `freePerMonth`), and the device checklist.

---

## Testing

- **Stand-ins (automated):** `test/fakes/gemini-server.js` serves the recorded shapes. Each e2e test drives annai against it in Docker, never against Google.
- **The real service (by hand, never in CI):** `test/live/gemini-api.test.js` with line 1, with pauses (5 a minute on flash). It names its model per test and skips politely on a per-day 429.
- **Commands:**
  - unit: `node --test test/unit/<file>`;
  - all: `npm run stamp && npm run check`;
  - e2e: `docker run --rm --ipc=host -v "$PWD":/work -v /mnt/optane/work/annai/node_modules:/mnt/optane/work/annai/node_modules:ro -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test --workers=4`;
  - live: `GEMINI_KEY="$(sed -n 1p /root/annai-test-keys/gemini)" node --test test/live/gemini-api.test.js`.

## Risks

- **The Interactions API is new.** A field may change. The stand-in follows the recordings; the live test is the early warning.
- **Fingerprints can miss:** speech resolved differently between turns, or a part core rewrites. A miss costs one whole send, never a wrong answer. The trace's `kept`/`bytes` show how often it happens.
- **Web Audio on the iPhone** (Task 10) is the path Gemini Live uses, unchecked on a real iPhone. The stream switch is the way back.
- **Google's suggestion HTML** may change shape. It's drawn as given, in a frame that can't reach annai.
- **Free-tier limits change without notice.** The 429's own words drive the rest time.
