# Keep Reasoning Implementation Plan

> **For agentic workers:** built task by task, test-first, in this worktree (branch `keep-reasoning`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** within one turn, every request to Claude (Anthropic Messages, and Claude through OpenRouter's Chat Completions) carries the thinking of that turn's earlier steps exactly as Claude returned it, and no request is refused for it (design goals 1–5).

**Architecture:** the core makes each turn's requests append-only (the loop freezes the instructions, tools, provider tools, level, Koe's photo rule and `cacheAt` at the turn's first step; the transcript keeps each step's now block where it was sent). An endpoint type yields its reply as it came (`native` event); `callOnce` keeps it beside the reply's parts (`Reply.native`), fingerprints what it was made after, and sends it back only to its own endpoint and only while that fingerprint still matches. One per-turn flag in the loop stops thinking for the rest of a turn on a change, a refusal or 64 KB. The two plugins own the wire form, the refusal's words and the cache marks.

**Tech stack:** native ES modules with JSDoc checked by tsc; node:test; Playwright 1.63 e2e in Docker.

**Design:** `docs/superpowers/specs/2026-10-29-keep-reasoning-design.md` (the user's answers of 2026-10-29 are in it and win over anything else). Main spec sections it changes: §6.2, §6.3 item 4, §6.5, §9.1, §9.6.

## Global constraints

- The user's words: "Make each turn's requests append-only (keep each step's now block, and freeze the instructions and tools within a turn), then send Claude's thinking back again." Answers 1–7 as the design lists them.
- Anti-goals, verbatim: a refusal that sends Kokoro or Koe to a weaker model; a thinking block sent to an endpoint (address and key) other than the one that returned it; thinking in the log, the Trace, backups, or an `annai.llm` result; a request in a turn that rewrites anything an earlier request of that turn sent; bigger requests for models that gain nothing from them.
- Every other model sends exactly what it sends today (goal 5): existing request-body tests stay green unchanged.
- No real model calls; synthetic data only (the repo is public). `scripts/reasoning-check.mjs` runs here only against the stand-ins; it never opens `/root/annai-test-keys/*`.
- Memory caps on every run: `NODE_OPTIONS=--max-old-space-size=2048`, an outer `timeout`, Docker `--memory=6g`, `--workers=4`.
- Plugins: anthropic-messages 0.4.3 → 0.5.0, chat-completions 0.10.1 → 0.11.0, provider-openrouter 2.3.2 → 2.4.0, all keeping their `api`. `npm run strings`, `npm run catalog`, `npm run stamp` after shipped-file changes.
- New screen words get ja, zh-Hans and zh-Hant rows (zh-Hant in Taiwan wording), state `ok` with a `Note:`.

## Interfaces (named exactly; later tasks use these)

**Contract (`src/core/llm/contract.js`), additions only:**
- `Part` gains `{ type: 'native', endpoint: string, content: any, covers: number, prefix: string }` and `text` parts gain `now?: true`.
- `StreamEvent` gains `{ type: 'native', content: any }`.
- `Request` gains `cacheAt?: number` (a message index: the last message before the previous turn began).
- `ErrorKind` gains `'reasoning'`: PLAIN "The provider refused the reasoning annai sent back."; `shown('reasoning')` the same through `t`.
- `portable()` keeps `native` parts, and leaves the `covers` parts after a native as they are (ids made safe only), so the count stays true.

**Call (`src/core/llm/call.js`):**
- `callOnce({ …, keepNative?: boolean })`.
- `Reply` gains `native?: { endpoint, content, covers, prefix }` and `natives?: 'changed' | 'refused'`.
- `nativeKey(endpoint, key)` → `"<endpoint.id>|<keyPrint>"`, the native's `endpoint`.
- `forEndpoint(messages, here)` → messages without other endpoints' natives, and without `now` parts whose next assistant message doesn't begin with a native of `here`.
- `withoutNatives(messages)` → messages without any native or `now` part.
- `nativePrints(request, patches)` → `string[]`, where `[i]` fingerprints the system text, tools, provider-tool patches and the first `i` "units" (see Task 2), used both to make a native's `prefix` and to check it.
- The trace's `net.request` gains `natives: { sent: number, changed: boolean }` when the request had natives of this endpoint.

**Fallback (`src/core/llm/fallback.js`):** `callRole({ …, keepNative?: boolean })`; `levelOf(config, role)` exported; on `reasoning` the same model once more with `withoutNatives`, reply marked `natives: 'refused'`; `nextStep` returns `{}` for `reasoning`; a `prefixed()` reply has no native.

**Service (`src/core/llm/service.js`) and the test kit's `llm.call`:** pass `keepNative` and `level` through.

**Transcript (`src/core/agent/transcript.js`):**
- `carry(keep: { now: string, native: Native } | null)`: given before this half's own `model.turn` is applied; `apply()` consumes it: the now block (`{ type: 'text', text, now: true }`) at the end of the user message before the reply, after `#unadd`, only when the last message is the user's; the native first among the reply's parts.
- `dropKept()`: removes every `native` part and `now` part.
- `keptBytes()`: the natives' content and now blocks, in UTF-16 length of their JSON/text.
- `turnStart: number` (-1 none): the last message's index before the first `model.turn` of each new wake (`data.wake`) of this half; shifted by Koe's window.
- `#unadd` for every half; `#window()` ignores `now` parts.

**Loop (`src/core/agent/loop.js`):** a per-turn `frozen` record `{ system, snapshot, tools, via, providerTools, shows, level, send, cacheAt }` built at the first step; `thinking` flag; `KEPT_MAX = 64 * 1024`; `Half.sendable` becomes `sendRule?: () => Promise<(messages) => messages>`; `#warmSummary(marker, settings, language, frozen?)`.

**Plugins:** anthropic-messages `read` yields `native` (the content array) and `wire` renders natives, `now` parts and `cacheAt`; classify `reasoning`. chat-completions reads/joins `reasoning_details`, yields `native` for Claude's format, writes it back, renders `now` parts as `addTail` did, and gains the tunable `cacheMarkers: string[]` (model-id prefixes; default `[]`).

## File map

| File | What changes |
|---|---|
| `src/core/llm/contract.js` | types, `reasoning` kind, `portable` and natives |
| `src/core/llm/call.js` | natives: make, strip, check, trace; `cacheAt` kept through `portable` |
| `src/core/llm/kept.js` | `hash` exported for the fingerprints |
| `src/core/llm/fallback.js`, `service.js` | `keepNative`, `levelOf`, the retry on `reasoning` |
| `src/core/agent/transcript.js` | `carry`, `dropKept`, `keptBytes`, `turnStart`, `#unadd`, `#window` |
| `src/core/agent/loop.js`, `halves.js` | frozen per turn, the flag, 64 KB, tidy-up's system, `sendRule`, switched-off tools |
| `plugins-official/anthropic-messages/` | 0.5.0 |
| `plugins-official/chat-completions/` | 0.11.0 |
| `plugins-official/provider-openrouter/annai-plugin.json` | 2.4.0: `cacheMarkers`, Claude's `cacheTtls` |
| `src/ui/screens/trace.js` | natives sent or changed on a request's line |
| `test/fakes/anthropic-binding.js`, `test/fakes/openrouter-claude.js` (new) | stand-ins |
| `scripts/reasoning-check.mjs` (new), `docs/testing/reasoning-check.md` (new) | the real check |
| `docs/…` | spec, `limitations.md`, `plugins.md` |

---

## Task 1: the contract's additions and the `reasoning` kind

- [ ] Test (`test/unit/llm-natives.test.js`, new): `explainPlain(new ProviderError('reasoning', 'x'))` is the English words; `explain` is the same `t` words; `KINDS.has('reasoning')`; `portable()` keeps a native and the parts it covers (a `provider` part of another model covered by a native stays), and still drops what it drops outside a native.
- [ ] Test (`test/unit/llm-fallback*.test.js` or the new file): a `reasoning` error from a scripted type doesn't bench the model.
- [ ] Implement: typedefs; PLAIN and `shown`; `portable` with a covers counter; `nextStep` case.
- [ ] `npm run strings`, fill ja/zh-Hans/zh-Hant rows.

## Task 2: `callOnce` makes, strips and checks natives

Units of the fingerprint: the system text, the tools, the provider-tool patches, then each message cut at each native (a native's prefix is everything before it, its own message's earlier parts included). Parts print as: text by its words (`now` or not), image by `hash` (else a hash of its data), document and audio by media type and data hash, tool_call by id/name/input, tool_result by id/error/content, provider by its block's JSON, native by its content's JSON, reasoning not at all. The tail counts as a text at the end of the last message when that message is the user's.

- [ ] Tests (fake endpoint type with `build`/`read` and a recording fetch):
  1. `keepNative` + a `native` event: `reply.native` has `endpoint` = `nativeKey`, `content`, `covers` = parts count, `prefix`; without `keepNative`, none.
  2. A native of another endpoint (other id, or same id another key) is not in what the plugin gets; nor a `now` part before it; Gemini-like requests are byte-identical to before.
  3. The check: a request whose earlier message changed after the native was made sends no native and no `now` part, `reply.natives === 'changed'`, and its `net.request` has `natives: { sent: 0, changed: true }`; unchanged: `{ sent: n, changed: false }`.
  4. A `reasoning` error from a request with no native becomes `bad-request`.
  5. `cacheAt` is moved with messages `portable` drops.
- [ ] Implement in `call.js` (export `nativeKey`, `forEndpoint`, `withoutNatives`, `nativePrints`); export `hash` from `kept.js`.

## Task 3: `callRole` passes `keepNative`, retries a refused reasoning once

- [ ] Tests: a type that refuses with `reasoning` when a native is sent: the same model is asked again without any native and no other model is asked; the Trace has a `reasoning` attempt then `ok`; `reply.natives === 'refused'`. A reply continued after a cut-off (`prefixed`) has no native. `levelOf` gives the role's level.
- [ ] Implement in `fallback.js`; `service.js` passes `keepNative`; the kit too.

## Task 4: anthropic-messages 0.5.0

- [ ] Tests (`test/unit/llm-anthropic.test.js`):
  1. `read` yields one `native` at the end with the content array as Claude sent it: thinking with its signature (an empty `thinking` kept), redacted thinking, two text blocks with their citations, tool_use with the parsed input, server_tool_use and its result; for `end_turn`, `tool_use`, `stop_sequence`, `pause_turn`.
  2. No `native` for `max_tokens`, `refusal`, an unparsable tool input, an unknown delta, or a reply with no thinking block.
  3. `build`: a native's content in place of its `covers` parts; two natives in one message (a paused turn); a `now` part rendered as the tail was (a text block after the end mark); `cacheAt`'s message marked on its last block before any `now` part; three marks at most with the system.
  4. `classify`: "Invalid `signature` in `thinking` block" and "… cannot be modified" are `reasoning`.
  5. The existing "never sent back" expectations change only where a native is present.
- [ ] Implement; version 0.5.0; header comment.

## Task 5: the Anthropic stand-in

- [ ] Extend `test/fakes/anthropic-binding.js`: signatures bind the non-thinking prefix, the previous thinking block's signature (a gap or a block put back is refused), and the block's own words ("cannot be modified"); options for empty thinking, cited text blocks before a second thinking block, a `pause_turn` reply with `server_tool_use` and `web_search_tool_result`, `refuseOnce()`; cache reads counted by Anthropic's rule (entries at marked blocks, found within 20 blocks of a later mark) as `cache_read_input_tokens`.
- [ ] Test the stand-in itself in a few lines (gap refused, oldest removed accepted, cache read found).

## Task 6: the transcript keeps a turn's now blocks and natives

- [ ] Tests (`test/unit/agent-transcript.test.js`): `carry` then the half's `model.turn`: the now block ends the user message before the reply, the native leads the reply; a line logged during the call goes after the reply with one half too; a paused continuation keeps no now block and its native sits in the same assistant message; `dropKept` removes them all; `keptBytes`; `turnStart` live and from the log; Koe: the now block is not escaped, and the window ignores now parts and shifts `turnStart`.
- [ ] Implement.

## Task 7: the loop freezes the turn and keeps Claude's thinking

- [ ] Tests (through `agentKit` against the stand-in, as the design's list 1–12 and 14):
  1. three-step Kokoro turn: requests 2 and 3 carry the earlier content arrays exactly, now blocks in place, nothing refused, nothing fell back;
  2. Shiori as one half with a line logged during a call;
  3. the next turn has no thinking or now block from before, and `cache_control` at `cacheAt`, also after a six-step turn (the stand-in reads from the cache there);
  4. Koe with `wait`, an answer, `speak`;
  5. two halves, Summarize now: tidy-up's `system` equals Kokoro's;
  6. a photo past the limit mid-turn (`maxCount: 1`): no thinking from there, `changed` on the `net.request`;
  7. the stand-in refuses once: the same model again, the Trace has the attempt, the rest of the turn sends no thinking;
  8. a paused turn with server tools;
  9. a fallback mid-turn to a scripted model and back; a second Claude model on the same endpoint gets the natives;
  10. a tool switched off between steps; a role's level changed between steps;
  11. a reload mid-turn;
  12. past 64 KB, no more thinking, once;
  14. no native, signature or `reasoning_details` in `model.turn`, its texts, `trace.turn`/`net.request`, a backup archive, or an `annai.llm` reply.
- [ ] Implement in `loop.js` and `halves.js` (`sendRule`); replace the "never sent back" test in `halves.test.js` with the new expectation.

## Task 8: chat-completions 0.11.0

- [ ] Tests (`test/unit/llm-chat-completions.test.js`): `reasoning_details` pieces of one `index` joined (text, summary and data concatenated; type, id, format, signature kept); `native` for `stop`/`tool_calls` when every detail is `anthropic-claude-v1`, one has a signature or data, none is `[REDACTED]`; none otherwise; the `reasoning` event still carries the words. `build`: a native's details as `reasoning_details` on its assistant message; a `now` part as `addTail` writes it (its own user message after tool results, or `"\n\n"` before it in string content); `cacheMarkers`: every content an array of blocks, marks on the system, the end and `cacheAt`, with the hour's `ttl`; a model outside it unchanged. `classify`: OpenRouter's error with Anthropic's words in `message` or `metadata.raw` is `reasoning`.
- [ ] Implement; version 0.11.0.

## Task 9: Claude through OpenRouter

- [ ] New `test/fakes/openrouter-claude.js` (design "Stand-ins"); agentKit registers chat-completions.
- [ ] Tests 13 and 13b through `agentKit`.
- [ ] provider-openrouter 2.4.0: `cacheMarkers: ["anthropic/"]` on the chat ability's tunables; `cacheTtls: ["5m", "1h"]` on its three Claude models.
- [ ] `npm run strings && npm run catalog && npm run stamp`.

## Task 10: the Trace says what went back

- [ ] Test (`test/unit/trace*.test.js`): a `net.request` with `natives` shows "thinking of N steps sent back" or "thinking not sent: the request changed".
- [ ] Implement; strings with ja, zh-Hans, zh-Hant.

## Task 11: the real check script

- [ ] `scripts/reasoning-check.mjs run --anthropic-key <path> --openrouter-key <path>` / `run --stand-ins` / `report <folder>`; `scripts/reasoning/*.mjs` hold the run and the checks. Keys through `scripts/realtime/keys.mjs` (`Keys.fromPath(path, '1')`), every output through `scrub()` and `assertClean()`.
- [ ] Test (`test/unit/reasoning-check.test.js`): the run against the stand-ins passes its four checks and writes a summary with no request bodies and no key.
- [ ] `docs/testing/reasoning-check.md`.

## Task 12: docs

- [ ] Spec §6.2, §6.3 item 4, §6.5, §9.1, §9.6 as the design lists; `docs/plugins.md` (the `native` event, `now` parts, `cacheAt`, `reasoning`, `cacheMarkers`); `docs/limitations.md`: the two approved entries in, the deferred one out.

## Gates

- `npm run stamp && npm run check` green; full e2e `--workers=4` 0 failed; `node scripts/catalog-versions.mjs /mnt/klein/deploy/annai/current/catalog/plugins.json catalog/plugins.json` prints nothing; size budget raised by the least that fits, if at all.
