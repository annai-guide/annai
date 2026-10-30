# keep-reasoning: Claude's thinking between tool steps, design

Date: 2026-10-29. Status: revised after a spec check and the user's answers of 2026-10-29. No question is open. Main at dd7465ce; line numbers are main's.

## Why

Claude 5.5 (Opus, Sonnet, Haiku) thinks before its tool calls. Since anthropic-messages 0.4.1, annai never sends that thinking back. So inside one turn, Claude plans every step again from what it can see, and Anthropic calls sending it back "Required" inside a tool loop. Claude through OpenRouter never had it sent back.

It was switched off for a reason. annai changes each request between the steps of a turn: the now block moves, and tidy-up uses its own instructions. Claude 5.5 refuses a thinking block when anything before it has changed. On the user's phone (2026-10-28), every Anthropic request after the first in a turn got a 400 ("Invalid `signature` in `thinking` block … bound to a different conversation"). Kokoro then fell back to weaker models, and Koe repeated advice. Those 400s ended with 0.4.1. This change must not bring them back.

The user's words:
- "Defer, do it next" (2026-10-28), on: "Make each turn's requests append-only (keep each step's now block, and freeze the instructions and tools within a turn), then send Claude's thinking back again."
- Standing: save data on the go, by taking every data-saving optimization, on by default.
- Standing: keep the released copy bug free.
- 2026-10-29, on this design (wording as the coordinator relayed it):
  1. Claude to Claude fallback: "Send it across Claude (Recommended)".
  2. Mid-turn changes: "Wait for next turn (Recommended)".
  3. Rare mid-turn edits: "Accept (Recommended)".
  4. Claude through OpenRouter: "Include it (Recommended)".
  5. A real check: "Key here, before release".
  6. Long turns: "Stop past 64 KB (Recommended)".
  7. Cache markers for Claude through OpenRouter: "Add them now (Recommended)".

## Goals

1. Within a turn, every request to Claude carries the thinking of that turn's earlier steps, exactly as Claude returned it. That holds on Anthropic's API and through OpenRouter, for Kokoro, Koe, and Shiori as one half.
2. No request is refused because of its thinking.
3. If one is refused anyway, the same model answers without the thinking. annai never falls back for this, and the Trace says what happened.
4. No thinking content is stored anywhere: not in the log, the Trace, backups or a plugin's result. The Trace gains only counts.
5. Every other model sends exactly what it sends today. Every provider gains the fixes that help all of them: instructions, tools and level frozen for the turn, and tidy-up's own instructions.

## Non-goals

- Carrying thinking from one turn to the next. The user's words are "within a turn".
- Showing the thinking. Anthropic's `display` stays at its default, "omitted"; OpenRouter's stays at its default, "summarized" (§9).
- Reasoning for other models through OpenRouter, such as GPT or Gemini (§9).
- Anthropic's betas: `drop_block`, turn-scoped system messages (`clear_at`), `tool_addition`, on-demand compaction. None is needed.

## Anti-goals (a failure even if it works)

- A refusal that sends Kokoro or Koe to a weaker model.
- A thinking block sent to an endpoint (address and key) other than the one that returned it.
- Thinking in the log, the Trace, backups, or an `annai.llm` result.
- A request in a turn that rewrites anything an earlier request of that turn sent.
- Bigger requests for models that gain nothing from them.

## What the docs say

Fetched on 2026-10-29: Anthropic's from platform.claude.com, OpenRouter's from openrouter.ai, in the `.md` form of each page.

**What must go back, and when.** "Thinking with tool use" (https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-with-tool-use) says: "when you return tool results, you must pass the thinking blocks from the assistant message back to the API, complete and unmodified." "Preserving thinking blocks" (https://platform.claude.com/docs/en/build-with-claude/thinking#preserving-thinking-blocks) says: "**Required:** within a tool-use turn, pass thinking blocks back. **Recommended:** across turns, pass everything back. **Allowed:** outside tool use, omit prior turns' thinking." The same section: "Within the latest assistant message, the sequence of consecutive `thinking` blocks must match what the model generated in the original request: you can't rearrange, edit, or partially drop them."

**Send the reply back as it came.** "Send assistant turns back exactly as returned" (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#append-assistant-turns-exactly-as-returned) says: "Store the `content` array from each response and send it back unchanged as the assistant turn: every block type, in the order received, including `thinking` blocks whose `thinking` field is empty. A serializer that drops unknown block types, drops empty fields, or reorders blocks edits the prefix for every later turn." It goes on: "the `thinking` field is empty by default and the `signature` carries the reasoning … A block sent back with an empty `signature` fails." "Thinking encryption" (#thinking-encryption on the thinking page) says: "Full thinking content is encrypted and returned in the `signature` field on each thinking block."

**What "bound to a different conversation" checks.** "Keeping the prefix unchanged" (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#prefix-check) says: "a thinking block stays valid only while everything you sent before it is unchanged on later requests. The checked prefix has three parts: The top-level `system` prompt; The set of `tools`; Every `message` before the block." On the chain between blocks: "You can remove the oldest thinking blocks (from the start of the history), the newest (from the end), or all of them. What fails is a gap … Once you remove a block, leave it out. Putting it back invalidates the thinking blocks produced while it was gone."

**Who gets a 400.** In "When `prefix_mismatch_behavior` is unset" (#enforcement), an account created on or after August 31, 2026 gets a "400 error" from Opus 5.5, Sonnet 5.5 and Haiku 5.5. An older account gets "No error (failing blocks reach the model)". The user's phone got the 400, so their account is enforced. The error starts: "Invalid `signature` in `thinking` block. The block is bound to a different conversation."

**What may change without breaking them.** The same section: "Request parameters outside those three fields, such as `effort`, `max_tokens`, `output_config`, `tool_choice`, and `metadata`, aren't part of the prefix check, and neither are `cache_control` markers." The table in "What counts as an edit" (#what-counts-as-an-edit) has these rows:
- Valid: "Append messages at the end".
- Valid: "Remove `thinking` blocks from the start of the history, from the end, or all of them", marked "(the model loses that reasoning)".
- Valid: "Change `model`", marked "Valid for blocks that the new model can read; the API drops the others without an error".
- Invalid: "Change the top-level `system` string or blocks".
- Invalid: "Add, remove, rename, or edit a tool in `tools`".
- Invalid: "Add a text block to an earlier user turn, or remove one you added last time".
- Invalid: "Clear or shorten an earlier `tool_result`, re-encode an earlier image, or change an earlier `tool_use` input".

**Where changing context goes.** "Put changing context in the newest turn" (#changing-context) says: "When a value changes, say so in the newest turn: add a text block to the user message you are about to send … Once sent, that text block is part of the prefix for later thinking: leave it in place on later requests." The limitations of mid-conversation system messages (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations) say: "**Not a place for untrusted content.** … Do not place text from outside the conversation, such as raw tool output, retrieved documents, or web content, directly in a system message; doing so gives that text operator-level authority."

**Other models.** The page's FAQ (non-Claude turns): "No, provided they're appended after the existing history and nothing earlier changes: an assistant message without thinking blocks is an appended message like any other." On model switches (#switching-models): "If the current model can't read a block, the API drops it from that request without an error." On accounts (#account-bound-thinking): "Thinking blocks that Claude Sonnet 5.5 or Claude Haiku 5.5 produces work only in the account that produced them or in an account linked to it."

**Thinking modes.** "Thinking with tool use" says: "The entire turn runs in a single thinking mode: you can't toggle thinking in the middle of a turn". So the reasoning level is frozen for the turn (§3). Sonnet 5.5's "off" level, `between_tools`, returns its progress notes as thinking blocks with words, so the Trace has words there. Under adaptive thinking the words are empty.

**Thinking across turns.** "Thinking block preservation by model" (#thinking-block-preservation-by-model): Opus 4.5 and later, Sonnet 4.6 and later, and Haiku 5.5 "Keep all prior turns". The section adds: "retained thinking blocks count as input like any other conversation history". "Output-token cost of `"drop_block"`" (#drop-block-cost) says: "When Claude can't read reasoning from earlier turns, it re-creates that reasoning, so requests that drop thinking blocks generate more output tokens". The live page gives no figure. An older copy bundled with Claude Code gave +4.6% (low effort), +9.7% (medium) and +10.3% (high) for drops on every turn, on a coding benchmark. Those are used below as indicative only.

**Prompt caching.** "Thinking and prompt caching" (#thinking-and-prompt-caching): "Blocks passed back unchanged keep the cache intact." It also says that changing "the effort value" invalidates cache breakpoints. "Prompt caching" (https://platform.claude.com/docs/en/build-with-claude/prompt-caching), under "How automatic prefix checking works", says: "Cache writes occur only at your breakpoint" and "The lookback window is 20 blocks". On Opus 5.5 and Sonnet 5.5, cache hits cost "0.05x the base input price". One-hour writes cost 2x and five-minute writes 1.25x.

**OpenRouter.** "Preserving Reasoning" (https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) lists `message.reasoning_details` as a way to pass reasoning back: "Pass the full reasoning_details block". It adds: "Use `reasoning_details` when working with models that return special reasoning types (such as encrypted or summarized)". And: "the entire sequence of consecutive reasoning blocks must match the outputs generated by the model during the original request; you cannot rearrange or modify the sequence of these blocks." On streaming: "`reasoning_details` appears in `choices[].delta.reasoning_details` for each chunk", "The complete reasoning sequence is built by concatenating all chunks in order", and "For encrypted reasoning, the content may appear as `[REDACTED]` in streaming responses". Each detail carries a `format`, `"anthropic-claude-v1"` for Claude, and a type: `reasoning.text` (with `signature`), `reasoning.encrypted` (with `data`) or `reasoning.summary`. Under "Summarized Thinking", OpenRouter "defaults to **summarized thinking**" for Claude. "Prompt Caching" (https://openrouter.ai/docs/guides/best-practices/prompt-caching), under "Anthropic Claude", gives two ways to enable caching: a top-level `cache_control`, or `cache_control` on content blocks. Under "Provider Sticky Routing": "After a request that uses prompt caching, OpenRouter remembers which provider served your request."

## What changes between the steps of a turn today

From the code. The last column is what this design does with each.

| What | Where | Between steps today | Design |
|---|---|---|---|
| The now block | loop.js:1765, context.js:110; Koe's adds `<today>` and the nonce line (halves.js:905) | Changes every step; goes after the cache marker (anthropic-messages index.js:72–82); the next request leaves it out | Stays where it was sent (§2) |
| System text (with `shows` and Kokoro's part) | loop.js:1770 | `shows` and Kokoro's part are recomputed every step | Frozen for the turn (§3) |
| Tools | `#toolsNow`, loop.js:1153 | Recomputed every step | Frozen for the turn (§3) |
| Provider tools | the same | Recomputed every step | Frozen for the turn (§3) |
| Reasoning level | fallback.js:476 reads the role's level on each call | Changes if the user edits it mid-turn | Frozen for the turn (§3) |
| Koe's photo rule | `#koeSendable`, halves.js:913, reads the Koe list on each call | Changes with the list | Frozen for the turn (§3) |
| Lines that join mid-turn | transcript.js `#line`, `#held` | Appended | Kept as is |
| Lines logged while a reply is being made | `#unadd` (transcript.js:141) moves them after the reply, for two halves only | With one half, they land before the reply, which is an edit | `#unadd` for one half too (§3) |
| A refused photo's copy | `photo.replace`, transcript.js:170 | Rewrites an earlier image | Rare: §5 stops thinking for the turn |
| Words for heard speech written later | `heard.text`, transcript.js:230 | Rewrites an earlier speech part | Rare: §5 |
| Koe's window | transcript.js:322 | Drops leading messages when it reaches 18 exchanges | Rare: §5. The window must ignore kept now blocks (§10) |
| The photo limit | refusals.js:47, fallback.js:544 | Past the limit, the oldest picture becomes a stub | Rare: §5 |
| Files given as words to models that can't take them | fallback.js:537 | A reading kept mid-turn changes an earlier file's words | Kept: Claude takes photos and PDFs |
| `fileId` instead of base64 | call.js `withUploads` | Switches if an upload expires | Kept: the bytes stay the same; §8 if the provider disagrees |
| `toolRequired`, `newestPhoto`, `maxOutput`, `cacheTtl` | request fields | Per step | Kept: not part of the check |
| Cache marker | index.js:72–76 | Moves to the end | Kept, plus one at `cacheAt` (§7) |
| Claude's thinking | anthropic-messages since 0.4.1; chat-completions never | Not sent | Sent within the turn, as returned (§4) |
| Tidy-up | loop.js:1380 | Leaves Kokoro's part out of the system text | Uses the half's own system text (§3) |

## The design

### 1. The line: within a turn

Claude's thinking and the kept now blocks last for one turn of one half, from the turn's first request to its last. When the turn ends, both go. The next turn is built from the transcript as today. Koe and Kokoro each have their own turns and thinking, and neither ever sees the other's. A wake and the wakes that join it are one turn. Compaction or Start fresh during a turn rebuilds the transcript, and the turn's thinking goes with it.

**What crossing a turn costs.** Today the next turn reads from the cache everything the last turn sent except its last now block. Now the last turn's now blocks and thinking leave the request. So the next turn shares the last turn's requests only up to where that turn began. The turn's tool calls and results are then written to the cache once more, at the write price instead of the read price. With an hour's cache, that is $4.00 instead of $0.10 per million tokens on Sonnet 5.5, and $8.00 instead of $0.20 on Opus 5.5.

A turn whose first reply ends it costs nothing extra. Most of Kokoro's and Koe's turns are like that. Big tool results are where it shows: a 20-page PDF read in a turn is about 30,000 tokens, so about $0.12 more on Sonnet 5.5 and $0.24 on Opus 5.5, once. Claude through OpenRouter has no prompt caching today; with §9's markers it caches the same way, so the same note applies there.

### 2. The now block stays where it was sent

Step k's now block went as the request's tail, the last text of the last user message. From step k+1 on, it stays there, as a text part with `now: true`, and the new now block goes last as before. Earlier copies are never rewritten. A paused continuation (a request that ends with Shiori's own message) has no tail, so it keeps no now block.

It stays user text, not a mid-conversation system message, for three reasons:
- The now block holds text from outside annai's own instructions: place names from the map service, plan titles, plugins' wake reasons, and, in Koe's, booking text. Anthropic says not to put such text in a system message.
- User text works on every model and provider. Mid-conversation system messages exist only on some Claude models; Sonnet 5 lacks them.
- It is what annai sends today. **My call.**

A kept now block goes only where thinking follows it. It goes to a model only when the reply right after it carries a native of that model's endpoint (§4). That means Claude, within the turn. Every other model gets the conversation exactly as today, so Gemini's and OpenAI's kept turns and local servers' prefix caches see no change. Keeping now blocks for those models would gain little within a turn and would make the next turn re-read the whole last turn. **My call.**

### 3. Frozen for the turn, and three fixes

At the turn's first step, the loop fixes:
- the system text (with `shows` and Kokoro's part),
- the tool definitions,
- the provider tools,
- the reasoning level, passed as `level` on every call of the turn,
- Koe's photo rule,
- `cacheAt` (§7).

Every step uses these. A change made meanwhile applies from the next turn (the user's answer 2). That covers a tool switched on, a plugin or MCP server connecting, a card type, "search via", the Koe list (splitting Shiori into halves or joining them), and a role's level.

Two things about switched-off tools:
- A call to one of annai's own tools that the user switched off since the turn began is not run. Its result says, in English for the model, that the tool was switched off. The live switches are read each step. **My call.**
- Provider tools (Anthropic's web search and fetch, OpenRouter's web search) run on the provider's side. annai can't refuse them, so a provider tool switched off during a turn keeps running until the turn ends.

A forced tidy-up inside a turn uses the turn's frozen tools, provider tools and level, so its request reads the turn's cache. After the compaction, the turn's system text is rebuilt from the new snapshot, which it must be. Tools, provider tools and level stay frozen to the end of the turn.

The three fixes:
- **Tidy-up uses the half's own system text.** `#warmSummary` (loop.js:1380) builds it as a turn does: `(half.system?.(snapshot) ?? systemText(snapshot)) + shows`. Today, with two halves, every warm tidy-up of Kokoro misses the whole cache. Housekeeping is due at 70% of the window, about 700,000 tokens on a 1M-token Claude. Writing that again costs about $2.80 on Sonnet 5.5, against $0.07 to read it.
- **Lines logged while a reply is being made follow that reply, with one half too.** transcript.js:141 limits this to two halves (`this.half !== 'one'`). With one half, a line logged during a call lands before the reply (chatter set aside, Undo of a hand-over). The request never had it, so it is an edit. The rule becomes the same for every half. The model then reads the lines in the order it met them. A conversation saved before this change puts such lines in their new place once, at the first reload, which costs one cache miss. **My call.**
- **`nextStep` (fallback.js:403) never rests a model for `reasoning`.** It falls under the group that returns `{}`.

The core owns all this, because annai's edits are made there and only the core sees every provider's requests. The plugins own the reply's wire form, how to send it back, how to read a refusal, and where cache markers go. **My call.**

### 4. Claude's reply, kept as it came: the provider contract

The contract (src/core/llm/contract.js) is an API, and these are additions only. Of the LESSONS entries I read, three apply. "An error's optional parts go in one options object": `ProviderError` already has one. "A plugin's `api` is the oldest host it needs": the changed plugins stay at `api: 1`. "Keep derived content with its owner, named by what it was made from": the native's `prefix`.

1. **A `native` stream event**, `{ type: 'native', content }`. A plugin yields it once, at the end of a reply that finished. `content` belongs to the plugin and is opaque to the core:
   - Anthropic Messages: the response's `content` array.
   - Chat Completions: the reply's `reasoning_details` (§9).
2. **`Reply.native`**, beside `reply.parts` and never inside them: `{ endpoint, content, covers, prefix }`. `callOnce` makes it from the event, and only when its caller asks for one (`keepNative: true`). The loop asks on Shiori's own turns: Kokoro, Koe and one half. Utility calls, readers, quick decisions, tidy-up and plugins' `annai.llm` calls never get one, so nothing has to filter it out of them.
   - `endpoint` is the endpoint id and key fingerprint, made the way kept turns make them (kept.js `keyPrint`).
   - `covers` is the reply's part count.
   - `prefix` is §5's fingerprint.
3. **A `native` part in messages.** Only the transcript inserts it, first among its reply's parts (§10). On sending:
   - A native goes to any model on its endpoint that its type's `nativeScope` puts in the scope of the model that made it (the user's answer 1). The API drops what a model can't read. *(Fix pass 1, F3: the scope is new. One OpenRouter endpoint serves every maker's models, so a fallback from Claude to GPT would have been sent Claude's reasoning. An optional endpoint-type function `nativeScope({ model, tunables })` gives a string, added to the endpoint and key a native is kept for and compared against the model sent to. Anthropic Messages has none: every model there shares. Chat Completions gives the `cacheMarkers` prefix a model's id starts with, else the id itself. A model outside the scope gets exactly what it got before natives.)*
   - A different key is a different endpoint, so a native made with one Anthropic key never goes out with another. Sonnet and Haiku 5.5 blocks wouldn't work across accounts anyway.
   - Two endpoint types serving the same model id never share natives. Anthropic Messages and OpenRouter's Chat Completions use different addresses and different native shapes.
   - `portable()` leaves natives in. `callOnce`, which knows the endpoint, takes out the natives of other endpoints, and the now blocks that no longer have a native after them. It does this first, before a kept turn is matched (kept.js) and before anything is uploaded, so Gemini's and OpenAI's chains see what they see today.
4. **Rendering.**
   - Anthropic Messages sends a native's `content` in place of the `covers` parts after it.
   - Chat Completions puts a native's `reasoning_details` on the assistant message of its reply and renders the parts as today.
5. **A `reasoning` error kind:** the provider refused the reasoning annai sent back. English words for the model and the log: "The provider refused the reasoning annai sent back." The same in the screens' words. *(Fix pass 1, F5: callOnce makes it, never a plugin: any `bad-request` on a request that sent natives becomes `reasoning`, whatever the error says. A plugin cannot give it, and the plugins no longer read the error's words.)*
6. **`now: true` on a text part:** an earlier step's now block. A type that returns natives must render it exactly as it rendered the request's `tail`.
7. **`cacheAt` on a request:** a message index (§7). A type that places cache markers adds one there: Anthropic Messages always, and Chat Completions for the models named by its new `cacheMarkers` tunable (§9). Both already take `cacheTtl`.

Which finished replies keep a native:
- Anthropic: a reply that stopped with `end_turn`, `stop_sequence`, `tool_use` or `pause_turn`, with every tool input parsed.
- Chat Completions: `stop` or `tool_calls`.
- None for `max_tokens` or `length`, a refusal or content filter, a reply cut off by the user or a note, an unparsable tool call, or a delta the plugin doesn't know.

A reply continued after another model was cut off (`prefixed()`, fallback.js:423) always loses its native.

Why a native rather than signed `reasoning` parts: Anthropic binds each block to everything before it, earlier blocks of its own reply included. annai's parts can't rebuild a reply exactly. The core joins text across blocks (call.js:229–232), and the plugin dropped citations and empty thinking blocks (0.4.2). OpenRouter needs a reply's whole `reasoning_details` back as they came.

Proposed LESSONS.md entry (to be added when this ships):

```markdown
## 2026-10-29 annai: a provider's reply is kept as it came, beside annai's reading of it
- Changed: annai's provider contract gained a native reply: what the provider returned (Anthropic's content array, OpenRouter's reasoning_details), kept beside annai's parts and sent back to the endpoint that returned it. Before, a signed `reasoning` part per thinking block was meant to carry what the provider needed.
- Why we had to change: Claude 5.5 binds each thinking block to everything sent before it, the earlier blocks of its own reply included. annai rebuilt replies from its own parts (text joined across blocks, citations and empty thinking blocks dropped), so a block sent back could not match what Claude wrote.
- Original design was wrong because: it modelled a provider's reply as annai's parts and expected the provider to take those parts back, when the provider checks what it gets back against what it sent.
- Lesson: when a provider checks what is sent back, keep its reply exactly as it came, beside annai's own reading of it, and send that copy back to the same endpoint; annai's parts are for annai and for other models.
```

### 5. annai checks before sending, and one flag stops the turn's thinking

**The check.** When `callOnce` makes a native, it fingerprints what the request sent before the reply, as the plugin was given it:
- the system text, tool definitions and provider tools;
- every message after this model's own changes (portable, readings, photo limit, resolved speech, uploads), with the tail as the last text of the last user message;
- images by hash;
- each earlier native that was sent, by its content;
- no reasoning parts.

That fingerprint is the native's `prefix`. It works like kept.js `prints()`, except that here `now` parts count.

Before each send, `callOnce` walks the request the same way. If any native this request would carry no longer matches, it sends none. It reports `natives: 'changed'` in the reply, and the Trace's `net.request` records `natives: { sent, changed }`.

**Why keep the check:** to save data. Without it, an edit costs a refused request, and the refused upload is the whole conversation, often hundreds of KB on mobile, before the retry. It also saves the refusal's round trip. **My call.**

**The flag.** "No more thinking this turn" is one per-turn flag. The loop sets it on any of three things:
- the check finding a change,
- a refusal (§8),
- the size limit (§6).

Once it is set, the transcript drops the turn's natives and takes none from later replies of the turn. The now blocks go with the natives, because none has a native after it any more. Removing all thinking blocks is valid. The next request leaves the cache once, at the turn's first now block, and is stable after that. There are no partial drops.

**Known limitation**, approved by the user's answer 3. It goes into docs/limitations.md when this ships:

```markdown
### Claude stops getting its earlier thinking for the rest of a turn after a rare mid-turn change
- **Kind:** known limitation.
- **What the user sees:** nothing on screen. A few rare things change part of a request after Claude has thought about it: a photo past the model's photo limit (the oldest becomes a stub), a refused photo replaced by a smaller copy, a heard line whose words are written down after it was sent, or Koe's window moving on in the middle of its turn. Claude would refuse its earlier thinking then, so annai sends none for the rest of that turn, and Claude plans each remaining step from what it can see, as it did before. The Trace counts it on the request.
- **Why:** making each of these append-only too means more code in several places, for something that happens a few times a trip at most.
- **Revisit when:** the Trace shows thinking stopped this way often.
- **Approved:** 2026-10-29, the user: "Accept (Recommended)".
```

### 6. Long turns

Shiori as one half can keep a whole voice exchange in one turn with `ask` and `wait`. A watched turn has no step limit (budgets.js:99–100). Each step's request carries every earlier step's thinking, so the extra upload grows with the square of the step count.

The size of a signature isn't documented; it holds the encrypted reasoning. Unmeasured, assume about 5 KB of native per step at medium effort, plus about 0.4 KB of now block.

| Steps in the turn | Extra upload, whole turn | The last request carries |
|---|---|---|
| 5 | about 54 KB | about 22 KB |
| 20 | about 1.0 MB | about 103 KB |
| 50 | about 6.6 MB | about 265 KB |

A limit is needed. The simplest one that keeps Anthropic's rules (no gaps) is the §5 flag. Once a turn's kept now blocks and natives pass 64 KB (a native counted for what it adds beyond the parts it stands for: its size less theirs, at least 0, so a long tool input or a server tool's result inside it doesn't count as thinking; fix pass 1, F2), about a dozen steps, the turn sends no more thinking. That caps a turn's extra upload near 360 KB. After it, Claude plans each step as it does today. The 64 KB figure is set again after the real check (§12) measures signature sizes.

**Known limitation**, approved by the user's answer 6. It goes into docs/limitations.md when this ships:

```markdown
### A very long turn stops carrying Claude's thinking after about a dozen steps
- **Kind:** known limitation.
- **What the user sees:** nothing on screen. Once a turn's kept thinking passes 64 KB (as in a long voice exchange with Shiori as one half), annai stops sending Claude's earlier thinking for the rest of that turn, and Claude plans each remaining step from what it can see, as before.
- **Why:** each step's request carries all the turn's earlier thinking, so the upload grows with the square of the steps: a 50-step turn would add about 6.6 MB. The limit keeps a turn's extra near 360 KB.
- **Revisit when:** the real check shows signatures much smaller than the 5 KB a step assumed, or long turns lose quality the user notices.
- **Approved:** 2026-10-29, the user: "Stop past 64 KB (Recommended)".
```

### 7. The marker where the previous turn began (`cacheAt`)

Anthropic finds an earlier cache entry only within 20 blocks of a marker, and each step adds two to four blocks. After a turn of more than about five steps, the next turn's only usable entry, the one where the last turn began, would be out of reach. Every long turn would then cost a write of the whole conversation. So:

- `Transcript.apply()` keeps `turnStart`: the index of the last message before the first `model.turn` of each new wake of the half. It is the same live and from the log.
- At the turn's first step, before any reply of the turn, the loop reads `turnStart`, which is where the previous turn began. It sends it as `cacheAt` on every request of the turn.
- anthropic-messages marks the last block of that message, as the earlier request sent it. (It holds no kept now block: it is from the turn before, whose kept blocks went when it ended.) That makes three marks with the system and the newest message.
- Tidy-up between turns sends the latest turn's start. A forced tidy-up in a turn sends the turn's `cacheAt`. Koe carries it too: same code, and harmless for its short turns.
- Chat Completions marks it the same way for the models its `cacheMarkers` names (§9).

**My call.**

### 8. When Claude refuses anyway

From an edit the check doesn't see, a plugin update mid-turn, or a rule the docs don't mention:

1. `callOnce` reads a `bad-request` (a 400) on a request that sent natives as `reasoning`, whatever its words, so a refusal in words nobody planned for is still caught. A size error (`context`) or any other kind goes its own way. *(Fix pass 1, F5. The first design had each plugin match Anthropic's words, "Invalid `signature` in `thinking` block" and "cannot be modified", which a rewording would have broken.)*
2. `callRole` asks the same model again, once, without any native. It doesn't rest the model and tries no other.
3. The Trace shows the refused attempt (outcome `reasoning`, the provider's words), then the retry's outcome.
4. The loop sets the turn's flag (§5).
5. A 400 on a request that carried no native is an ordinary bad request, and so is the retry's, if it fails too.

No `drop_block` beta and no beta header: stripping is Anthropic's documented recovery without the beta. **My call.**

### 9. Claude through OpenRouter (the user's answer 4)

**chat-completions reads** `choices[].delta.reasoning_details`. It joins pieces of the same `index`: text, summary and data are concatenated, and type, id, format and signature are kept as they arrive. At the end of a finished reply, it yields `native` with the details, when every one has `format: "anthropic-claude-v1"`, at least one has a `signature` or `data`, and none reads `[REDACTED]`. It still yields `reasoning` with the words, for the Trace. Those words aren't empty here, because OpenRouter summarizes Claude's thinking by default.

**chat-completions writes** a native's details as `reasoning_details` on its reply's assistant message. A kept now block is rendered exactly as `addTail` rendered it: its own user message after tool results, or a text block of its own (for the models `cacheMarkers` names, below, every content is an array of blocks). Where a server takes string content, `"\n\n"` goes before it, as `addTail` writes, where `wire()` joins other texts with `"\n"`.

**classify** needs no case for the binding 400: callOnce reads it (§8).

Natives are kept only for Claude's format. GPT and Gemini through OpenRouter return details too, but they send exactly what they send today. **My call:** only what the user asked for and what is tested. Other formats can follow later.

**What OpenRouter's shape loses.** Chat Completions keeps a reply's text apart from its reasoning. A Claude reply that puts text between two thinking blocks may not come back as Claude wrote it. Claude 5.5 mostly puts notes between tool calls in thinking blocks, so this should be rare. If it happens, §8 handles it, and the real check (§12) shows whether it does.

**Cache markers (the user's answer 7).** Today annai's chat-completions sends no `cache_control`, so Claude through OpenRouter pays full input price on every request: about $0.20 a request on Sonnet 5.5 for a 100,000-token conversation, where a cache read would cost about $0.01. And OpenRouter's sticky routing, which keeps a conversation on one provider, starts only after a cached request. Without it, the steps of a turn can go to different Claude providers. Sonnet and Haiku 5.5 thinking is tied to the account that made it, so OpenRouter may then drop it silently. So:

- **The models.** A new Chat Completions tunable, `cacheMarkers`, lists model-id prefixes. Off by default. provider-openrouter sets `["anthropic/"]` on its chat ability, so every Claude model through OpenRouter gets markers, including one added from the list or by id. **My call:** data in the description, not OpenRouter's name in the plugin.
- **The marks**, as anthropic-messages places them, with `cacheTtl`'s lifetime (`{ "type": "ephemeral" }`, plus `"ttl": "1h"` for the hour). This is OpenRouter's "Explicit cache breakpoints" form:
  - the system message, as an array of one text block;
  - the last block before the tail;
  - `cacheAt`'s message, its last block (§7).
  - A top-level `session_id`, OpenRouter's sticky routing key (its prompt-caching guide: sticky sessions expire after 10 minutes of inactivity, and a `session_id` is used directly as the routing key): a hash of the model id and the system text, so it is the same for a turn's steps and as long as the cache could hit, personal to no one, and stored nowhere. Without it, a turn's steps could land on different upstream accounts after 10 minutes idle, and Claude's thinking is dropped silently across accounts (fix pass 1, F4).

  That makes three of four.
- **Every content as an array.** For those models, every message's content goes as an array of blocks, the `tool` messages' too, even where there is no mark. So a mark never changes how a message is written from one request to the next. **My call.**
- **Caveat.** OpenRouter documents per-block `cache_control` on message content. It doesn't say that a mark on a `tool` message's content reaches Anthropic. The real check (§12) shows it: later steps must read from the cache. If they don't, the builder puts the end mark on the request's own now block instead. Inside a turn that still hits, because the now block is kept. A turn's first request ends with the wake's user text, so `cacheAt`'s mark always sits on a user text block.
- **Usage.** It needs no change: `usageOf` already reads `prompt_tokens_details.cached_tokens` and `cache_write_tokens`.
- **Other servers.** No other Chat Completions server gets marks or array content; they send exactly what they send today.

Versions: chat-completions and provider-openrouter get version bumps and stay at `api: 1`. Other Chat Completions servers send exactly what they send today.

### 10. Storage, data and the transcript

**Nothing about thinking is stored.**
- `Reply.native` lives in memory for the turn. It is not in the `model.turn`'s parts, the Trace, backups, or an `annai.llm` result.
- The kept now blocks are in memory too.
- A reload during a turn ends that turn: calls without a result are answered, then a catch-up wake runs (spec §6.7). The next turn starts without them in any case.

**The Trace** keeps the reasoning's words, as today:
- empty for Claude 5.5 under adaptive thinking;
- words for Sonnet 5.5 at `between_tools`;
- summaries through OpenRouter.

It also keeps a refused attempt, and `natives: { sent, changed }` on each `net.request`.

**The transcript, live:**
- The loop gives the transcript the step's sent now block and `reply.native` with its own `model.turn`, as it applies it.
- The transcript puts the now block at the end of the user message before the reply, after `#unadd` has taken out the late lines, so the order is the request's. It puts the native first in the reply's parts.
- When the turn ends, or the flag is set, it drops both.
- Koe's escaping of user parts (`#unmarked`) leaves a kept now block exactly as it was sent.
- Koe's `#window()` (transcript.js:322) ignores `now` parts. It counts exchanges by user messages holding a text part, so a kept now block would otherwise count as one.

**Estimates.** `estimateTokens` and `requestBytes` count natives and now blocks, since they are in the request. For a model on another endpoint that is a small overcount.

### 11. Money

**Within a turn.** Today step k+1 already reads from the cache everything step k sent except its now block. So the append-only part changes little: the previous now block (60 to 170 tokens) stays in the request instead of going.

The thinking becomes new input on the step after it is made. It is written to the cache there, at 2x input for an hour's cache (1.25x for five minutes), and read at 0.05x after that. Output costs 5x input on all three Claude 5.5 models. So writing one thinking token costs as much as 0.4 output tokens, or 0.25 with five minutes.

Replaying pays only if it saves Claude at least that much re-thinking. Take a three-step turn, each step with 1,500 output tokens of which 1,000 are thinking. Replay writes 2,000 thinking tokens, worth 800 output tokens. By the indicative 10%, it saves about 300 output tokens on the two later steps. Net, about 500 output tokens' worth more: about $0.005 on Sonnet 5.5 for that turn.

So replay costs a little more than it saves, unless thinking is a small share of the output. What it buys is the reasoning Anthropic calls required, without the 400s coming back.

### 12. The real check before release (the user's answer 5)

`scripts/reasoning-check.mjs`, in the manner of `scripts/realtime-check.mjs`:

- **Usage:** `node scripts/reasoning-check.mjs run --anthropic-key /root/annai-test-keys/anthropic --openrouter-key /root/annai-test-keys/openrouter`. Either option may be left out; at least one is needed. `report <folder>` reads a run again with no network.
- **Keys:** each key file is read only inside the run, through `scripts/realtime/keys.mjs`, as `Keys.fromPath(path, '1')`. The key sits in private fields. It goes only into the request header the endpoint type builds, and the trace's `secret()` blanks it. Everything printed or written goes through `scrub()` and `assertClean()`. The script writes nothing with the key and never prints or logs it.
- **What it runs:** annai's own Agent and Halves in Node. The store is in memory. The endpoint types are the real ones (anthropic-messages, chat-completions), and the provider descriptions come from plugins-official. Kokoro runs on Sonnet 5.5, Koe · Classic on Haiku 5.5, and voice is off. The trip is synthetic: a `trip.json` and two notes, no real data.
  1. A message that needs `list`, `read`, then `tell_koe`: a Kokoro turn of three steps or more.
  2. Koe's turns around it.
  3. The same through OpenRouter's Claude, with cache markers (§9).
  4. A negative control: one request with an earlier message changed under the thinking sent with it, and a turn in which Sonnet fails at one step with a stubbed 529 so the next Claude model answers it (the user's answer 1). *(Fix pass 1, F1.)*
  5. It also reports each turn's natives in KB, so §6's 64 KB can be set again from measured signature sizes.
- **What it shows:** for each request, the half, step, model, bytes sent, natives sent or changed, outcome, cache reads and writes, and cost.
- **What it checks:**
  0. At least one native was sent on a step 2 or later. A run in which Claude never thought is no pass.
  1. Every step after one whose reply had a native sends it back.
  2. No attempt was refused (outcome `reasoning`), and no 400 came.
  3. Every call was answered by the role's first model (nothing fell back).
  4. Within a turn, step k reads at least what step k-1 read and wrote; each half's next turn's first request reads at least what the turn before had read and written at its first step (at `cacheAt`). Any read above zero is not enough.
  5. On Anthropic, the check's own requests carry the `thinking-binding-controls-2026-08-01` beta and `block_binding.prefix_mismatch_behavior: "error"` (never production's), so a broken binding fails on an account of any age; no `thinking_dropped` entry with the reason `prefix_binding_mismatch` may appear in the replies' `input_transformations`.
  6. The negative control on Anthropic is refused, asked again once without natives on the same model, and answered, with nothing resting or falling back. On OpenRouter it is reported.
  7. Claude to Claude: the stubbed step is answered by the next Claude model, and the rest of that turn is accepted with no `reasoning` outcome. Thinking stopped on purpose because the two models' provider tools differ is reported, not failed.
- **Upstream provider** of every OpenRouter step is in the table and the summary, with a note when a turn's steps changed provider.
- **Caps:** the run sets `stepsPerWake` 8 and `spendPerDay` 1.00, so a model that loops cannot run up the bill.
- **Output:** exit 0 on pass, 1 on fail, 2 on error. A scrubbed summary goes to `.superpowers/evidence/reasoning-check/<time>/`, without request bodies.
- **Cost:** a few tenths of a dollar for both providers (the control and the Claude-to-Claude turn are two turns more). It runs before release, with the user's OK each time, since it spends money. docs/testing/reasoning-check.md describes it.

## What the user sees

- Nothing new on screen.
- Claude, on Anthropic or through OpenRouter, plans each step of a turn from what it reasoned at the step before.
- The 400s stay gone.
- A tool switched off during Shiori's turn stops at once. Other changes made during a turn apply from her next turn, and provider tools keep running until it ends.
- The Trace shows any refused attempt, and natives sent or changed on each request.

## Tests

**Stand-ins.**
- `test/fakes/anthropic-binding.js` gains: empty `thinking` with signatures that also bind the previous block's (so a gap or a block put back is refused); "cannot be modified"; two cited text blocks before a second thinking block; a `pause_turn` reply with `server_tool_use` and `web_search_tool_result`; and a switch that refuses once.
- New `test/fakes/openrouter-claude.js`: a Chat Completions stand-in that streams `reasoning_details` in OpenRouter's documented shape. Its signature binds the system message, the tools and the messages before the assistant message. It refuses a changed prefix with OpenRouter's error shape, carrying Anthropic's words. It reports cache reads (`prompt_tokens_details.cached_tokens`) the way Anthropic counts them: entries written at the marked blocks, found within 20 blocks of a later mark. The Anthropic stand-in reports `cache_read_input_tokens` by the same rule.

**Through `agentKit`**, as halves.test.js does at line 758:
1. A three-step Kokoro turn on Claude: requests 2 and 3 carry the earlier content arrays exactly, and the now blocks in place. Nothing is refused. Nothing falls back.
2. The same with Shiori as one half, including a line logged during a call: it goes after the reply, and nothing is refused.
3. The next turn carries no thinking or now block from the turn before, and has `cache_control` at `cacheAt`. After a six-step turn, still.
4. Koe on Claude, a turn with `wait`, then an answer, then `speak`: its second request carries its first step's thinking, and the tail is unescaped. Nothing is refused. Nothing falls back.
5. Two halves on Claude, then Summarize now: tidy-up's `system` equals Kokoro's, byte for byte. Nothing is refused.
6. A photo past the limit mid-turn (`maxCount: 1`): no thinking is sent from there to the turn's end. Nothing is refused, and the `net.request` says `changed`.
7. The stand-in refuses once: the same model is asked again without thinking, and no other model is asked. The Trace has the refused attempt. The rest of the turn sends no thinking.
8. A paused turn with server tools: the continuation ends with Shiori's message, has no tail, and carries the native. Both replies' content sits in one assistant message, and the next step goes through.
9. A fallback mid-turn to a scripted model, then back to Claude: the scripted model's request has no natives and no kept now blocks. Claude's next request has its own natives. A second Claude model on the same endpoint gets them too.
10. A tool switched off between steps: the tools are unchanged, the call returns the switched-off words, and the next turn leaves the tool out. A role's level changed between steps: the turn keeps its level.
11. A reload mid-turn, after step 1's results: the catch-up turn's first request carries no natives or now blocks, and nothing is refused.
12. A long turn past 64 KB of kept thinking: from there, no thinking, once.
13. A three-step Kokoro turn through OpenRouter's Claude: requests 2 and 3 carry `reasoning_details` exactly. The kept now block renders exactly as the tail did.
13b. Cache markers through OpenRouter's Claude:
    - The system, the end and `cacheAt` are marked, with the hour's `ttl`.
    - Every message keeps the same bytes from one request to the next.
    - The stand-in reports cache reads on steps 2 and 3, and on the next turn's first request.
    - A model outside `cacheMarkers` (a scripted Chat Completions server) gets no marks and string content, as today.
14. **Anti-goals:** after a Claude turn, no native, signature or `reasoning_details` is in:
    - the `model.turn` event or its stored texts;
    - `trace.turn` or `net.request`;
    - a trip backup (export, then search the archive for the stand-in's signature marker);
    - a plugin's `annai.llm` reply.
15. Every request body the Gemini, OpenAI and other Chat Completions tests record today stays the same, kept turns included.

**Unit tests:**
- `callOnce`: natives taken out for other endpoints, the `now` rule, the check.
- anthropic-messages `read` (content rebuilt with citations, empty thinking, a redacted block, an unknown delta, `max_tokens`) and `wire` (a native in place of its parts; two natives in one message; `cacheAt`).
- chat-completions joining `reasoning_details`, and the `[REDACTED]` case.
- `classify` in both plugins.
- `nextStep` with `reasoning`.
- Koe's window with `now` parts.

No real model is needed. Use memory caps as usual on test runs.

## The spec, the limitations file and lessons

- **Spec:** §6.3 item 4 ("sent last, never cached") becomes: sent last, and within a turn each earlier step's stays where it was sent, for an endpoint whose thinking follows it. §6.2 freezes the instructions, tools, provider tools and level for the turn. §6.5 says tidy-up uses the half's own instructions. §9.1 describes Anthropic Messages and Chat Completions as above, Chat Completions' `cacheMarkers` included. §9.6 says natives go only to their endpoint.
- **docs/limitations.md:** the entry "Claude's reasoning isn't carried between tool steps within a turn" goes entirely, OpenRouter included. The entries in §5 and §6 come in.
- **LESSONS.md:** the entry in §4.

## Left to the builder

- Names: `keepNative`, `turnStart`, and the transcript's methods for giving it a now block and a native, and for dropping them.
- Where the turn's frozen values live in `#steps`.
- The fingerprint's exact form (§5 lists what it covers).
- Words for the `reasoning` kind and the refused attempt in `l10n` (`npm run strings` for ja, zh-Hans, zh-Hant).
- Plugin versions, the catalog, `npm run stamp`.

## Calls to confirm

The user's answers of 2026-10-29, as built:
1. A native goes to the models on its endpoint (address and key fingerprint, as kept turns use) that its type's `nativeScope` puts in the maker's scope. Other keys, other endpoint types and other makers' models never get it (§4).
2. Instructions, tools, provider tools, level, Koe's photo rule and `cacheAt` are frozen for the turn. Changes apply from the next turn. Provider tools switched off keep running until the turn ends (§3).
3. Rare mid-turn edits stop the turn's thinking: a known limitation, with its entry in §5.
4. Claude through OpenRouter gets its `reasoning_details` back within a turn (§9).
5. A real check script runs before release with the named key files (§12). It shows natives, refusals, fallbacks, bytes, and cache reads on both providers.
6. Long turns stop carrying thinking past 64 KB: a known limitation, with its entry in §6. The figure is set again from the real check's measurements.
7. Claude through OpenRouter gets Anthropic-style cache markers (§9).

My calls:
8. The line is within a turn (§1). The now block stays user text (§2).
9. Kept now blocks go only where a native of the same endpoint follows (§2).
10. A tool of annai's own switched off mid-turn is refused in words (§3).
11. A forced tidy-up keeps the turn's tools, provider tools and level, and rebuilds only the system text (§3).
12. Tidy-up uses the half's own system text. `#unadd` applies to one half too. `nextStep` doesn't rest a model for `reasoning` (§3).
13. The core and plugin split (§3).
14. The contract additions (§4): the `native` event, `Reply.native` beside `parts` (made only for Shiori's own turns), the `native` part, the `reasoning` kind, `now` text parts, `cacheAt`. The LESSONS entry text.
15. Which replies keep a native. A `prefixed()` reply never does (§4).
16. The check before sending, kept to save data. One per-turn flag stops thinking on a change, a refusal or the size limit (§5).
17. `cacheAt` is where the previous turn began, the same for every request of the turn. Tidy-up and Koe carry it too (§7).
18. One retry without thinking on a refusal, no beta (§8).
19. Natives are kept only for OpenRouter's `anthropic-claude-v1` format (§9).
20. `cacheMarkers` is a Chat Completions tunable of model-id prefixes, set to `["anthropic/"]` by provider-openrouter. Those models get every content as an array of blocks (§9).
21. Nothing about thinking is stored. Estimates count natives (§10).
22. Display stays at each provider's default.
23. anthropic-messages 0.5.0, chat-completions and provider-openrouter get version bumps, all at `api: 1`.
