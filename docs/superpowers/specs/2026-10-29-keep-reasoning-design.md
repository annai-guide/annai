# keep-reasoning: Claude's thinking between tool steps, design

Date: 2026-10-29. Status: proposed. One choice waits for the user: how far Claude's thinking is carried (§1, "The line"). The rest of this design holds for either answer, and the last section says what the other answer changes. Main at dd7465ce; line numbers are main's.

## Why

Claude 5.5 (Opus, Sonnet, Haiku) thinks before each tool call. Since anthropic-messages 0.4.1, annai never sends that thinking back, so inside one turn Claude plans every step again from what it can see. Anthropic calls sending it back "Required" inside a tool loop (quotes in "What Anthropic's docs say").

It was switched off for a reason. annai changes each request between the steps of a turn: the now block moves, and tidy-up uses its own instructions. Claude 5.5 refuses a thinking block when anything before it has changed. On the user's phone (2026-10-28), every Anthropic request after the first in a turn got a 400 ("Invalid `signature` in `thinking` block … bound to a different conversation"). Kokoro then fell back to weaker models, and Koe repeated advice. Since 0.4.2 the plugin keeps only the thinking's words, and under Claude 5.5's default display those words are empty, so nothing of the reasoning is left.

The user's words:
- "Defer, do it next" (2026-10-28), on: "Make each turn's requests append-only (keep each step's now block, and freeze the instructions and tools within a turn), then send Claude's thinking back again."
- Standing: annai saves data on the go. It takes every data-saving optimization, on by default.
- Standing: keep the released copy bug free.

## Goals

1. Within a turn, every request to a Claude model carries the thinking of that turn's earlier steps, exactly as Claude returned it. This holds for Kokoro, Koe, Shiori as one half, and tidy-up.
2. In normal use, no request is refused because of its thinking.
3. If a request is refused anyway, the same model answers without the thinking. annai never falls back to another model for this, and the Trace says what happened.
4. A request carries no more than its turn needs. Nothing new goes into the log, the Trace or backups.
5. Other providers (Gemini, OpenAI, Chat Completions, local servers) send exactly what they send today. They also gain the fixes that help every provider: instructions and tools frozen for the turn, and tidy-up's own instructions.

## Non-goals

- Carrying Claude's thinking from one turn to the next. That is the alternative in §1 and the last section.
- Claude reached through OpenRouter or another Chat Completions server. That path returns the reasoning's words without signatures, so there is nothing to send back. It stays as it is.
- Showing Claude's thinking. `display` stays at Claude 5.5's default, "omitted", so the Trace's reasoning words stay empty for those models, as they are today.
- One Claude model reading another's thinking after a fallback, even where Anthropic allows it (Opus 5.5 can read Sonnet 5.5's). See §7.
- Anthropic's betas: `drop_block`, turn-scoped system messages (`clear_at`), `tool_addition`, on-demand compaction. None is needed (§8, §2).

## Anti-goals (a failure even if it works)

- A refused request that sends Kokoro or Koe to a weaker model.
- A thinking block sent to a model other than the one that wrote it.
- Thinking in the log, the Trace, backups, or a plugin's `annai.llm` result.
- A request in a turn that rewrites anything an earlier request of that turn sent.
- Bigger requests for providers that gain nothing from them.

## What Anthropic's docs say

All fetched on 2026-10-29 from platform.claude.com (the `.md` form of each page).

**What must go back, and when.** "Thinking with tool use" (https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-with-tool-use): "when you return tool results, you must pass the thinking blocks from the assistant message back to the API, complete and unmodified." "Preserving thinking blocks" (https://platform.claude.com/docs/en/build-with-claude/thinking#preserving-thinking-blocks): "**Required:** within a tool-use turn, pass thinking blocks back. **Recommended:** across turns, pass everything back. **Allowed:** outside tool use, omit prior turns' thinking." Also: "Within the latest assistant message, the sequence of consecutive `thinking` blocks must match what the model generated in the original request: you can't rearrange, edit, or partially drop them."

**Send the reply back as it came.** "Send assistant turns back exactly as returned" (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#append-assistant-turns-exactly-as-returned): "Store the `content` array from each response and send it back unchanged as the assistant turn: every block type, in the order received, including `thinking` blocks whose `thinking` field is empty. A serializer that drops unknown block types, drops empty fields, or reorders blocks edits the prefix for every later turn." And: "On the models that run the prefix check, the `thinking` field is empty by default and the `signature` carries the reasoning … A block sent back with an empty `signature` fails." "Thinking encryption" (https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-encryption): "Full thinking content is encrypted and returned in the `signature` field on each thinking block."

**What "bound to a different conversation" checks.** "Keeping the prefix unchanged" (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#prefix-check): "a thinking block stays valid only while everything you sent before it is unchanged on later requests. The checked prefix has three parts: The top-level `system` prompt; The set of `tools`; Every `message` before the block." The page's introduction: "If the prefix differs from what you sent when the block was produced, that block and every later thinking block fail the prefix check." On the chain between blocks: "each thinking block records which thinking block came before it, across turns. You can remove the oldest thinking blocks (from the start of the history), the newest (from the end), or all of them. What fails is a gap … Once you remove a block, leave it out. Putting it back invalidates the thinking blocks produced while it was gone."

**Who gets a 400.** "When `prefix_mismatch_behavior` is unset" (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#enforcement): for Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5, an account created on or after August 31, 2026 gets a "400 error". An older account gets "No error (failing blocks reach the model)". The user's phone got the 400, so their account is enforced. The error starts "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block"." (#prefix-mismatch-error).

**What may change without breaking them.** The same section: "Request parameters outside those three fields, such as `effort`, `max_tokens`, `output_config`, `tool_choice`, and `metadata`, aren't part of the prefix check, and neither are `cache_control` markers." "What counts as an edit" (#what-counts-as-an-edit) lists these as valid: "Append messages at the end"; "Remove `thinking` blocks from the start of the history, from the end, or all of them" ("the model loses that reasoning"); "Change `model`" ("Valid for blocks that the new model can read; the API drops the others without an error"); "Add, move, or remove `cache_control` markers". It lists these as invalid: "Change the top-level `system` string or blocks"; "Add, remove, rename, or edit a tool in `tools`"; "Add a text block to an earlier user turn, or remove one you added last time"; "Clear or shorten an earlier `tool_result`, re-encode an earlier image, or change an earlier `tool_use` input" ("Invalid for every later thinking block").

**Where changing context goes.** "Put changing context in the newest turn" (#changing-context): "When a value changes, say so in the newest turn: add a text block to the user message you are about to send … Once sent, that text block is part of the prefix for later thinking: leave it in place on later requests." This is what the user's "keep each step's now block" asks for.

**Another model's turns.** From the page's FAQ: "My harness can route a turn to a non-Claude model. Do those turns invalidate Claude's earlier thinking? No, provided they're appended after the existing history and nothing earlier changes: an assistant message without thinking blocks is an appended message like any other." On switching between Claude models ("Switching models mid-conversation", #switching-models): "If the current model can't read a block, the API drops it from that request without an error." Also: "Claude Opus 5.5 reads thinking blocks from … and, on the Claude API …, from Claude Sonnet 5.5 and Claude Haiku 5.5". And: "Thinking blocks that Claude Sonnet 5.5 or Claude Haiku 5.5 produces work only in the account that produced them or in an account linked to it" (#account-bound-thinking).

**Thinking across a user turn.** "Thinking block preservation by model" (https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-block-preservation-by-model): Opus 4.5 and later, Sonnet 4.6 and later, and Haiku 5.5 "Keep all prior turns". Also: "retained thinking blocks count as input like any other conversation history." "Thinking encryption": "It is only strictly necessary to send back thinking blocks when using tools with thinking. Otherwise you can omit thinking blocks from previous turns." On what dropping costs ("Output-token cost of `"drop_block"`", #drop-block-cost): "When Claude can't read reasoning from earlier turns, it re-creates that reasoning, so requests that drop thinking blocks generate more output tokens and can take longer to respond." The live page gives no figure. An older copy of Anthropic's guidance, bundled with Claude Code, gave +4.6% at low effort, +9.7% at medium and +10.3% at high, on a coding benchmark, when thinking is dropped on every turn. Treat those figures as indicative.

**Prompt caching and thinking.** "Thinking and prompt caching" (https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-and-prompt-caching): "A thinking block the API drops … changes the cached prefix from that block's position onward. Blocks passed back unchanged keep the cache intact." The same section: "Thinking blocks are cached with tool results … those cached thinking blocks count as input tokens". On effort: "Switching between `adaptive`, `enabled`, and `disabled`, changing `budget_tokens`, and changing the effort value all invalidate cache breakpoints". "Prompt caching", under "How automatic prefix checking works" (https://platform.claude.com/docs/en/build-with-claude/prompt-caching): "Cache writes occur only at your breakpoint." Also: "The lookback window is 20 blocks … a run of consecutive `tool_use` blocks counts as one position, and so does a run of consecutive `tool_result` blocks." Under "Pricing", for Opus 5.5 and Sonnet 5.5: cache hits are "0.05x the base input price", 1-hour writes are 2x and 5-minute writes 1.25x.

**System messages instead of user text.** "Placement after tool results" (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#placement-after-tool-results): "On Claude Sonnet 5.5 and Claude Haiku 5.5 … they can treat a system message placed right after a tool result as untrusted text and ignore it." That is one reason the now block stays a text block in the user message (§2).

## What changes between the steps of a turn today

From the code. Each row says what the design does with it.

| What | Where | Changes between steps | Design |
|---|---|---|---|
| The now block (time, place, voice, Koe's state, reasons, the plan) | loop.js:1765, context.js:110; Koe's adds `<today>` and the nonce line, halves.js:905 | Every step. The tail goes after the cache marker (anthropic-messages index.js:72–82), and the next request leaves it out | **Kept where it was sent** for the model whose thinking follows it (§2). The new one still goes last |
| System text: core, personality, Kokoro's part, the snapshot, `shows` | loop.js:1770; the snapshot is taken per wake (loop.js:1650) | `shows` and Kokoro's part are recomputed each step (`#toolsNow`, `#rules`). The snapshot changes only after a forced tidy-up mid-turn | **Frozen for the turn** |
| Tools | `#toolsNow`, loop.js:1153: switches, "search via", registry tools (plugins, MCP, skills), `show`'s description (its card types are a getter), Kokoro's hidden `tell_koe` | Recomputed each step | **Frozen for the turn.** A call to a tool the user switched off since gets words back instead of running (§2) |
| Provider tools (Anthropic web search and fetch) | `via.kinds/off` → `providerTools` | Recomputed each step | **Frozen for the turn** |
| Lines that join mid-turn: wakes ("meanwhile"), Koe's notes, heard speech, `[annai]` blocks | transcript.js `#line`, `#held`, `#unadd` | Appended after the results, or after the reply that was being made | **Kept as is.** Already append-only, and the same from the log as live |
| A refused photo's copy | transcript.js:170 (`photo.replace`) | Rewrites an earlier image | **Kept.** It is rare, and the check catches it (§4) |
| A heard segment's words written down later | transcript.js:230 (`heard.text`) | Rewrites an earlier speech part | **Kept**; the check catches it |
| Koe's window | transcript.js:322; it starts 6 exchanges later each time the window reaches 18 | Drops the leading messages | **Kept**; the check catches it. Koe's turns are short |
| The photo limit (each model's newest `maxCount` pictures) | refusals.js:47, applied per model in fallback.js:544 | Past the limit, each new picture turns the oldest into a stub | **Kept**; the check catches it. The cache already misses there today (an approved limitation) |
| Files as words for a model that can't take them (readings, notes) | fallback.js:537 | A reading kept mid-turn changes how an earlier file reads | **Kept as is.** Claude takes photos and PDFs, so this never touches Claude's requests |
| Photo uploads (`fileId` instead of base64) | call.js `withUploads` | An upload that expires or fails switches the photo's form | **Kept.** The bytes stay the same. If Anthropic disagrees, §8 handles it |
| Effort, `toolRequired`, `newestPhoto`, `maxOutput`, `cacheTtl` | request fields | Per step or per role | **Kept.** Anthropic doesn't check them, and effort is the same all through a role's turn |
| The cache marker | index.js:72–76 | Moves to the newest message | **Kept**, plus one more marker where the last turn began (§5) |
| Claude's thinking | index.js read/wire | Never sent since 0.4.1 | **Sent back within the turn, as returned** (§3) |
| Tidy-up (warm housekeeping) | loop.js:1380 | Uses `systemText(snapshot)` without Kokoro's part, and the housekeeping instruction as its tail | **Uses the half's own system text.** Between turns it carries no thinking (§2) |

## The design

### 1. The line: one turn

Claude's thinking and the kept now blocks last for **one turn of one half**, from the turn's first request to its last. When the turn ends, both leave the conversation. The next turn is built from the transcript as today: no earlier now blocks, no earlier thinking.

The boundaries the brief asks about:
- **A wake** is a turn, together with the wakes that join it. The line is the same.
- **Koe and Kokoro** each have their own turns, transcripts and thinking. Neither ever sees the other's.
- **Warm tidy-up** runs between turns. It carries no thinking. A forced tidy-up inside a turn carries the turn's thinking, then the compaction ends it (§2).
- **Compaction and Start fresh** rebuild the transcript. Any thinking the turn had goes with it.
- **A fallback inside a turn** keeps the turn's line (§7).
- **A retry after a repair**, a photo past the limit, a reading kept mid-turn, Koe's window moving: each edits something earlier, and the check in §4 drops the thinking from that point on.

Why the turn, and not the time the cache stays warm. Anthropic requires thinking within a tool turn and only recommends it across turns. Carrying it across turns would put every step's thinking into every later request for as long as the cache stays warm. A drive with Kokoro waking every few minutes keeps an hour's cache warm all day, so requests would keep growing until housekeeping, against "save data on the go". Within a turn, the growth stops when the turn does. The cost is one re-write of a multi-step turn's tool steps into the cache at the next turn (§5). The last section describes the other choice. **This is the open question for the user.**

### 2. A turn's requests only append

**The now block stays where it was sent.** Step k's now block went as the request's tail: the last text of the last user message. From step k+1 on, it stays there in the conversation, as a text part with `now: true`, and the new now block goes last as before. Earlier copies are never rewritten. This is Anthropic's "Put changing context in the newest turn". The now block stays user text, not a mid-conversation system message: user text works on every model and every provider with no beta, and Sonnet and Haiku 5.5 may ignore a system message right after tool results. **My call.**

**Only the model whose thinking follows gets an old now block.** A kept now block goes to a model only when the reply right after it carries that model's own reply-as-returned (§3). In practice: Claude, within the turn. Every other model gets the conversation exactly as today, so Gemini's and OpenAI's kept turns, OpenAI's automatic cache and local servers' prefix caches see no change.

Why not keep now blocks for every provider? A model with no bound thinking gains little within a turn: the previous now block, plus the reply on servers that cache what they generated (llama.cpp). At the next turn, those blocks would leave, and the server would re-read the whole previous turn. Today it re-reads only the last reply. Keeping them for good, across turns, would help every provider's cache, but it would add 200 to 600 bytes to every later request for every step until housekeeping. **My call.** The rule is local and stable: whether a now block goes depends only on the reply right after it, so it never changes from one step to the next.

**Instructions, tools and provider tools are frozen for the turn.** The loop computes system text (with `shows` and Kokoro's part), tool definitions and provider tools once, at the turn's first step. Every step of the turn reuses them. A change made meanwhile applies from the next turn. That covers a tool switched on, a plugin or MCP server that connects, a card type, "search via", and the Koe list splitting Shiori or joining her. Today these apply from the next step. One exception: a call to a tool the user has switched off since the turn began is not run. Its result says, in English for the model, that the tool was switched off, so off means off at once. The live switches are read each step, which is cheap. A forced tidy-up inside a turn rebuilds the snapshot, so the turn's frozen system is computed again after it. That compaction drops the turn's thinking in any case.

**Tidy-up uses the half's own instructions.** `#warmSummary` (loop.js:1380) builds the system text as a turn does: `(half.system?.(snapshot) ?? systemText(snapshot)) + shows`. Today it uses `systemText(snapshot)`, which, with two halves, lacks Kokoro's part. So every warm tidy-up of Kokoro misses the whole cache (numbers in §5). Inside a turn, it uses the turn's frozen system and tools.

**The core owns this; the plugin owns the reply's form.** annai's own edits are made in the core: the now block, the system text, the tools, the transcript, the photo limit and readings for each model. Only the core can stop making them, and only the core sees every provider's requests. The plugin owns what only it knows: the reply's wire form, how to send it back, how to read the refusal, and where cache markers go. **My call.**

### 3. Claude's reply, kept as it came: the provider contract

The contract (src/core/llm/contract.js) is an API, so these are additions only. Nothing that plugins rely on today changes meaning. I read LESSONS.md first. The relevant entries: "an error's optional parts go in one options object" (`ProviderError(kind, message, more)` already has one); "a plugin's `api` is the oldest host it needs" (anthropic-messages stays at `api: 1`, below); "keep derived content with its owner, named by what it was made from" (the `prefix` below).

1. **A `native` part.** It holds the reply as its provider returned it, for the model that wrote it:
   `{ type: 'native', model: string, content: any, covers: number, prefix: string }`.
   - It comes first among its reply's parts. It stands in for the `covers` parts after it, which are annai's reading of the same reply: its text, tool calls, provider blocks and reasoning words.
   - `content` belongs to the plugin and is opaque to the core. For Anthropic it is the response's `content` array: every block, in order, thinking blocks with their signatures (empty `thinking` included), text blocks with their citations, tool use, server tool use and results.
   - `prefix` belongs to the core: a fingerprint of everything the request sent before this reply (§4).
   - `portable()` gives a native only to its `model` and drops it for every other model, which gets the covered parts as today. That is the rule signed reasoning follows now.
   - A plugin that renders messages, on meeting a native of its model, sends `content` and skips the next `covers` parts.
   - Why: Anthropic binds each thinking block to everything before it, earlier blocks of its own reply included. annai's parts can't reproduce a reply exactly. The core joins text across blocks (call.js:229–232), and the plugin dropped citations and empty thinking blocks (0.4.2). A signed `reasoning` part per thinking block would therefore still send back a reply Claude never wrote. This is "fix at source": keep the provider's own form beside annai's reading of it.
2. **A `native` stream event**, `{ type: 'native', content }`. A plugin yields it once, at the end of a reply that finished. `callOnce` turns it into the part, with `model`, `covers` (the reply's parts so far) and `prefix`, and puts it first. A reply that was cut off, stopped or failed has none. An older host ignores the event, because `take` in call.js skips unknown types. That is why anthropic-messages 0.5.0 can stay at `api: 1`: on an older annai it behaves as 0.4.3.
3. **A `reasoning` error kind**: the provider refused the reasoning annai sent back. It gets English words for the model and the log ("The provider refused the reasoning annai sent back."), and the same in the screens' words. §8 says what annai does with it.
4. **`now: true` on a text part**: an earlier step's now block, kept where it was sent. A type that returns natives must render it exactly as it rendered the request's `tail`. For Anthropic both are a text block at the end of the user message.
5. **`cacheAt` on a request** (a message index): where this conversation's latest turn began. A type that places cache markers adds one there (§5).

The reply's parts in the log, the Trace and `annai.llm` results never include the native. It lives in memory for the turn (§6).

**anthropic-messages 0.5.0:**
- **read** builds the content array as the stream arrives, as Anthropic's SDK does:
  - each `content_block_start` gives the block;
  - `thinking_delta`, `signature_delta`, `text_delta`, `citations_delta` and `input_json_delta` fill it;
  - `content_block_stop` closes it;
  - at `message_stop` it yields `native` with the blocks in index order.
  A delta it doesn't know makes the reply go without a native, which is safe. It still yields `reasoning` with the words, when there are any, for the Trace.
- **wire** sends a native of its model in place of the parts it covers. Everything else is as today: one message per role, tool results first in a user message.
- **build** adds the `cacheAt` marker (§5).
- **classify** reads a 400 `invalid_request_error` whose message says ``Invalid `signature` in `thinking` block`` or that thinking blocks "cannot be modified" as `reasoning`.
- The rest of its comment at the top, and the spec's Anthropic Messages paragraph (§9.1), change to say this.

Proposed LESSONS.md entry. I haven't added it: agent-rules changes only with the user's OK, so it is listed in Calls to confirm.

```markdown
## 2026-10-29 annai: a provider's reply is kept as it came, beside annai's reading of it
- Changed: annai's provider contract gained a `native` part: the reply as its provider returned it (Anthropic's content array), sent back in place of annai's parts to the model that wrote it. Before, a signed `reasoning` part per thinking block was meant to carry what the provider needed.
- Why we had to change: Claude 5.5 binds each thinking block to everything sent before it, the earlier blocks of its own reply included. annai rebuilt replies from its own parts (text joined across blocks, citations and empty thinking blocks dropped), so a block sent back could not match what Claude wrote.
- Original design was wrong because: it modelled a provider's reply as annai's parts and expected the provider to take those parts back, when the provider checks what it gets back against what it sent.
- Lesson: when a provider checks what is sent back, keep its reply exactly as it came, beside annai's own reading of it, and send that copy back to the same model; annai's parts are for annai and for other models.
```

### 4. annai checks before sending

Some edits are hard to avoid inside a turn. They are listed as "the check catches it" in the table above. annai looks for them itself, so they never cost a 400 and a second upload.

- **When a native is made**, `callOnce` fingerprints what the request sent before the reply, as the plugin was given it:
  - system text, tool definitions, provider tools;
  - every message after this model's own changes (portable, readings, photo limit, speech resolved, uploads), with the tail as the last text of the last user message;
  - each image by its hash, not its data or `fileId`;
  - each earlier native kept by its own content, and each one not sent by the parts it covers;
  - no reasoning parts, since Anthropic leaves earlier thinking out of the prefix.

  That fingerprint is the native's `prefix`. It works the way kept.js `prints()` does, with one difference: here `now` parts count.
- **Before each send**, `callOnce` walks the request the same way. At each native of this model whose `prefix` no longer matches, it drops that native and every later one. That is a cut from the end, which Anthropic allows. The plugin then gets their covered parts instead.
- Once dropped, a native stays dropped, because its prefix stays changed. New natives are fingerprinted with the dropped ones absent, so they keep matching.
- The `net.request` in the Trace records `natives: { sent, dropped }`. Something annai edits will then show up, and can be fixed at its cause.

**My call:** this check, in place of Anthropic's `drop_block` beta. It needs no beta header. It works with every thinking mode, including Sonnet 5.5's `between_tools` and Haiku 5.5's `disabled`, which take no `block_binding`. And it never uploads a request just to be told no. Its cost is one fingerprint pass per Claude request, the same work kept.js already does per kept-turn call.

### 5. The cache

**Within a turn.** Today, step k+1 already reads from Anthropic's cache everything step k sent except its now block, because the marker sits before the tail. So the append-only part gains little there. The previous now block stays in the request instead of being dropped: step k+1 sends it as new input, and the steps after read it from cache. It is 60 to 170 tokens: 190 to 215 characters in the test kit, without place or plan, and up to about 600 characters with them.

The thinking itself becomes input on the turn's later steps. It is written to the cache once, at 2x for an hour's cache (1.25x for five minutes), then read at 0.05x on Opus and Sonnet 5.5. In return Claude doesn't re-create its reasoning: by the figures above, about 5 to 10% fewer output tokens per step, at medium effort. In money, the two roughly cancel. What the change buys is the reasoning Anthropic calls required, and the end of the 400s and the fallbacks they caused.

**Across turns.** Today the next turn reads from cache everything the last turn sent except its last now block. Under the one-turn line, the last turn's now blocks and thinking leave the request, so the next turn shares the last turn's requests only up to where that turn began. The turn's own tool calls and results are then written to the cache once more:

| Model | Hour's cache: write instead of read, per million tokens | 10,000 tokens of tool steps, once |
|---|---|---|
| Sonnet 5.5 | $4.00 instead of $0.10 | about $0.04 |
| Opus 5.5 | $8.00 instead of $0.20 | about $0.08 |
| Haiku 5.5 | $0.20 instead of $0.01 | about $0.002 |

A turn whose first reply ends it costs nothing extra. Most of Kokoro's turns are like that: sleep, or `tell_koe` and sleep. So are Koe's short turns.

**The marker where the last turn began.** Anthropic finds an earlier cache entry only within 20 blocks of a marker. Each step of a turn adds two to four blocks, so after a turn of more than about five steps, the next turn's only usable entry, at the start of that turn, would be out of reach. The next turn would then write the whole conversation to the cache again, at the write price, each time a long turn ends. So:
- The transcript keeps `turnStart`: the index of the message the latest turn's first request ended with. On load it is derived from the log: the message before the first `model.turn` of the half's latest wake.
- Each request carries `turnStart` as `cacheAt`.
- anthropic-messages marks that message's last block, as the turn's first request sent it, before any now block kept after it.

The marks are then the system text, `cacheAt` and the newest message: three of Anthropic's four. **My call.**

**Tidy-up with two halves.** Today it misses the whole cache (§2). Housekeeping is due at 70% of the context window: 700,000 tokens on a 1M Claude. Writing that again costs about $2.80 on Sonnet 5.5, against $0.07 to read it, and about $5.60 on Opus 5.5, against $0.14. With the half's own system text it is a read. "Summarize now" works the same way, at any size. This fix helps every provider: OpenAI sends `instructions` every time, too.

**Other providers.** Their requests don't change. They gain only the frozen system text and tools, which no longer restart the cache mid-turn when a plugin or setting changes, and the tidy-up fix.

### 6. Storage, data and the Trace

- **Nothing new is stored.** A native lives in memory for its turn. It is not in the `model.turn`'s stored parts (`trace.turn` leaves it out), not in the Trace, not in backups, and not in what `annai.llm` gives a plugin. The kept now blocks are in memory too.
- **A reload during a turn ends that turn** (spec §6.7: calls without a result are answered, then a catch-up wake runs). The next turn starts without them in any case, so nothing needs to be kept on the device.
- **What the Trace keeps:** the reasoning's words, as today (empty for Claude 5.5 under "omitted"). A refused attempt, with its words (§8). The `natives` counts on each `net.request`. Optionally, the step's now block: the builder may store it as a text of the `model.turn`, which helps when reading a trace, and costs a few hundred bytes per step.
- **What goes over the network.** Step j of a turn carries the thinking of steps 1 to j-1 and their now blocks. The size of a thinking block's signature isn't documented; it holds the encrypted reasoning. Unmeasured, it is likely 1 to 8 KB per step at medium effort. At about 5 KB a step, a three-step turn's second and third requests carry roughly 5 and 10 KB more. Nothing carries over to the next turn.
- **The transcript in memory.** Live, the loop gives the transcript the step's sent now block and the reply's native, with its own `model.turn`, as it applies it. The transcript places the now block at the end of the user message before the reply. It does this after taking out the lines that came while the reply was being made, as `#unadd` already does, so the order is the request's. It places the native first in the reply. When the turn ends (`#turn`'s `finally`), it drops both. After a refusal (§8), it drops the turn's natives. Koe's escaping of user parts (transcript.js `#unmarked`) must leave a kept now block exactly as it was sent: the tail was sent unescaped.

### 7. Fallbacks, other models, and Koe

- **A native stays with its model.** A native goes only to the model that wrote it: the same provider model id, as `portable()` checks for signed reasoning today. A non-Claude model that answers a step gets the turn as today, with no natives and no kept now blocks. Its reply is appended as ordinary parts. Anthropic says that doesn't invalidate Claude's earlier thinking. If the turn's next step goes back to the first Claude model, that model gets its own natives again, still valid.
- **Another Claude model after a fallback** (Sonnet 5.5 to Opus 5.5, say) doesn't get the first one's thinking, even though Opus 5.5 can read Sonnet 5.5's. It plans that step afresh, as every fallback does today. **My call:** one rule for every provider, and fewer bytes. The API would read some of those blocks (Opus 5.5 reads Sonnet and Haiku 5.5's) and drop the rest. It is proposed as a known limitation.
- **The same model on two accounts** (two Anthropic providers): Sonnet and Haiku 5.5 blocks from the other account are dropped by the API without an error. That wastes some bytes and is harmless. A turn rarely crosses accounts.
- **Koe** follows the same rules. Its tail (now block, `<today>`, the nonce line) stays in place within its turn and leaves when the turn ends. Its turns are short, so the cost in §5 is small. The nonce staying in the turn's history is harmless: it changes only when annai restarts, and a restart ends the turn. Koe's window still moves at its 18-exchange mark, mid-turn too; the check in §4 then drops Koe's earlier thinking for the rest of that turn. **My call:** that is simpler than moving the window only between turns, which would need live and reloaded transcripts to agree on where it moved.

### 8. When Claude refuses anyway

A 400 can still come: from an edit annai doesn't fingerprint, from a plugin update that renders parts differently in the middle of a turn, or from something Anthropic checks that its docs don't mention. When it does:

1. The plugin classifies it as `reasoning`.
2. `callRole` (fallback.js) asks the **same model** again, once, with every native of that model left out. The kept now blocks go with them, since none has a native after it any more. Removing every thinking block is valid. The model isn't benched, and no other model is tried for this.
3. The Trace shows the refused attempt: outcome `reasoning`, Anthropic's words, then the retry's outcome. On screen, the attempt's line reads in plain words, something like "Claude refused its earlier reasoning; asked again without it".
4. The loop sees the refused attempt in the result. It drops the turn's natives from the transcript, so the turn's later steps match the retried request. The retried reply's own native is kept: it was made without the dropped ones.
5. If the retry is refused the same way, or the request carried no native at all, it is an ordinary `bad-request`, and the list goes on as today.

**My call:** no `drop_block` retry and no beta header. Stripping is Anthropic's own documented recovery without the beta, and with §4 in place this path should almost never run.

## What the user sees

Nothing new on screen. Kokoro and Koe on Claude plan each step from what they reasoned at the step before. The fallbacks to weaker models that the 400s caused stop. The Trace shows any refused attempt, and on each request how many thinking blocks were sent or dropped. A tool switched off during Shiori's turn stops working at once. Other changes made during a turn (a tool switched on, a plugin added, "search via", the Koe list) apply from her next turn instead of her next step.

## Tests

The stand-in `test/fakes/anthropic-binding.js` already refuses a thinking block whose system, tools or earlier messages changed, in Anthropic's words. It already silently drops another model's block. Extend it to match the docs:
- Thinking blocks come back with **empty** `thinking`, the default "omitted" display, and a signature that also binds the previous block's signature, so a gap or a block put back is refused.
- A changed thinking text is refused with "cannot be modified".
- A reply can carry **two cited text blocks** before its second thinking block. Without a verbatim replay, that block's prefix fails.
- A switch makes it refuse once, in Anthropic's words, whatever was sent. That tests the path in §8.

Through `agentKit` with `{ ability: anthropic }` scripts, as halves.test.js does at line 758:

1. A Kokoro turn of three steps on Claude: requests 2 and 3 carry the earlier steps' content arrays exactly, and the earlier now blocks in place. Nothing is refused. Nothing falls back.
2. The next turn sends no thinking or now blocks from the turn before. Its body has a `cache_control` on the block where that turn began. After a six-step turn, that marker is still there.
3. Two halves, both on Claude, then Summarize now: nothing is refused. Tidy-up's `system` equals Kokoro's turn's `system`, byte for byte.
4. Koe on Claude, a turn with `wait`, then an answer, then `speak`: Koe's second request carries its first step's thinking. Its tail is unescaped.
5. A photo past the limit mid-turn (`maxCount: 1`, a tool result with a picture): annai sends no thinking from before it. The stand-in refuses nothing. The `net.request` says `dropped`.
6. The stand-in refuses once: the same model is asked again without thinking. No other model is asked. The Trace has the refused attempt. The next step carries the retried step's thinking and none from before.
7. A fallback mid-turn to a scripted model, then back to Claude: the scripted model's request has no natives and no kept now blocks. Claude's next request has its own natives, and nothing is refused.
8. A tool switched off between two steps: the second request's tools are unchanged. A call to that tool returns the switched-off words. The next turn's tools leave it out.
9. A reply cut off part-way, by an immediate note: no native, and the next step goes through.
10. Every request body that the Gemini, OpenAI and Chat Completions tests record today stays as it is. Those tests pass unchanged, kept-turn chaining included.

Unit tests:
- `portable()`'s now rule.
- anthropic-messages `read` (content reconstruction, with citations, empty thinking, a redacted block, an unknown delta) and `wire` (a native replacing its covered parts, two natives in one assistant message for a paused turn, `cacheAt`).
- `classify` of the 400s.
- `callOnce`'s prefix check, including a native kept after an earlier one was dropped.

The test kit needs no real model. Memory caps as usual on any run.

## The spec, the limitations file and lessons

- Spec §6.3, item 4: the now block "sent last, never cached" becomes: it is sent last, and within a turn each earlier step's stays where it was sent, for the model whose thinking follows it. Freezing the instructions and tools for the turn goes in §6.2 or §6.3. The tidy-up fix goes in §6.5.
- Spec §9.1, Anthropic Messages: thinking is sent back within a turn, as Claude returned it; it is never stored; a refusal is retried once without it. §9.6, "The transcript stays portable": add natives next to "reasoning blocks signed for another model are dropped".
- `docs/limitations.md`: the entry "Claude's reasoning isn't carried between tool steps within a turn" goes when this ships. Proposed new entries, each only with the user's OK, are in the report's questions.
- LESSONS.md: the entry in §3, with the user's OK.

## Left to the builder

- Field and function names: `native`, `covers`, `prefix`, `now`, `cacheAt`, `turnStart`, and the transcript's methods for giving it a step's now block and native and dropping them.
- Where the frozen system text and tools live in `#steps`, and how the live switches are read for the switched-off check.
- The fingerprint's exact form. The rule is that it covers what the plugin is given, as listed in §4.
- `prefixed()` in fallback.js (a cut-off reply continued by another model) keeps the native first and `covers` right, or drops the native.
- Words for the `reasoning` kind and the refused attempt, in `l10n` (ja, zh-Hans, zh-Hant: `npm run strings`). New plugin version: catalog, `npm run stamp`, anthropic-messages 0.5.0 at `api: 1`.
- Whether to store each step's now block with its `model.turn` for the Trace (§6).

## The other line: while the cache stays warm

If the user prefers thinking to carry from turn to turn, here is what changes.

- **A frame lasts while the cache stays warm.** A frame is a run of a half's turns sharing one prefix. Every `model.turn` records its frame's id. A turn continues the frame when it starts within its model's cache lifetime of the frame's last request, with the same system text, tools and provider tools. Otherwise it starts a new one. It also starts a new one after housekeeping, after Start fresh, and after a refusal. The decision is read from the log, so a reload in a warm stretch continues the frame.
- **Storage.** Each step's now block and Claude's reply-as-returned are stored with the `model.turn`, so a reload sends them again. They go into backups that include history, which run on Wi-Fi. The transcript sends only the current frame's now blocks and natives. Koe still starts a new frame each turn, because its tail is over 2 KB.
- **Gains:** caching across turns as today, so no re-write and no `cacheAt` marker. Claude keeps its earlier turns' reasoning: Anthropic's "Recommended".
- **Costs:** every request carries all of the frame's thinking and now blocks. In continuous use (a drive, Koe chatting, Kokoro waking every few minutes), the cache never goes cold, so requests grow by every Claude step's thinking, perhaps 1 to 8 KB each, until housekeeping, which on a 1M-token model is far off. The reasoning is also stored on the device and in backups.
- §2 to §8 stay as written, except that "the turn" becomes "the frame".
