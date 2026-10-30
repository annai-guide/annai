# The reasoning check: Claude's thinking sent back within a turn, against the real providers

The unit tests send Claude's thinking back to stand-ins that check it the way Claude 5.5's documentation says it is checked: each
thinking block bound to everything before it. They show that annai keeps a turn's requests append-only and sends each reply back as it
came. They cannot show that Anthropic, and OpenRouter in front of Anthropic, accept what annai sends, that the cache is read where annai
marks it, or how big a real signature is. This check can (the keep-reasoning design §12; the user, 2026-10-29: "Key here, before release").

It is **opt-in, never part of `npm run check` or CI, and costs money**: a few tenths of a dollar a run for both providers, on the keys you give it. The run sets its own caps (8 steps per wake, $1.00 a day), so a model that loops cannot run up more; a turn the cap stops fails the run. Run it before a
release that touches the providers' plugins or the loop, with the user's OK each time.

## What it does

- **annai in Node:** annai's own Halves (Koe and Kokoro), the loop, `callRole` and the real endpoint types (anthropic-messages and
  chat-completions), in memory. The providers are set up from their descriptions in `plugins-official/` (provider-anthropic,
  provider-openrouter), as an install makes them. Kokoro runs on Claude Sonnet 5.5 (main, level high in this run, since adaptive thinking may skip thinking on easy steps at medium), Koe · Classic on Claude
  Haiku 5.5 (level low). Voice is off.
- **The trip is synthetic:** a `trip.json` and two notes (a hotel and a dinner), no real data.
- **The conversation, on each provider given:**
  1. The user asks where they stay. Koe answers at once and asks Kokoro; Kokoro lists the notes, reads one and tells Koe (a turn of
     three steps or more); Koe says it.
  2. The user thanks her and asks about dinner: the same again, as the next turn of each half.
  3. **The negative control:** a third turn in which the first request that carries thinking has an earlier message changed by a few words, in the check's fetch wrapper (so annai's own check, which would hold the thinking back, never sees it).
  4. **Claude to Claude:** a fourth turn in which the check answers Sonnet's first request that carries thinking with a stubbed 529, again and again until annai's fallback asks the next Claude model (Opus 5.5, added to Kokoro's list for this run only), which then receives Sonnet's thinking on the same endpoint (the user, 2026-10-29: "Send it across Claude").
- **On Anthropic, in this run only** (never production code): every request carries the `thinking-binding-controls-2026-08-01` beta, and a request whose thinking is adaptive (or unset, which Claude 5.5 reads as adaptive) carries `thinking.block_binding.prefix_mismatch_behavior: "error"`, so a broken binding fails on an account of any age (before 2026-08-31 a failing block is otherwise let through). The replies' `input_transformations` are recorded.
- **What it records:** for each request, never its body: the half, the step, the model, the bytes sent, how much thinking went back
  in it, the natives sent or changed (as the Trace has them), the outcome, the cache reads and writes, the cost, and, through OpenRouter,
  the upstream provider its stream names.

## What it checks

Of the conversation (steps 1 and 2 above), on each provider:

0. **A native was sent on a step 2 or later, Kokoro's own among them.** Kokoro is the half whose requests Anthropic refused on the phone (2026-10-28), so Koe's thinking going back is not enough. A run in which Claude never thought passes nothing (and says "no reply thought before another step: inconclusive, rerun"); one in which only Koe's did says "Kokoro never thought before another step: inconclusive for Kokoro, rerun".
1. Every step after a reply for which annai kept a native sends it back (a signed reply cut at `max_tokens` has none, correctly).
2. No attempt was refused for its reasoning (outcome `reasoning`), and no request got a 400.
3. Every call was answered by the role's first model: nothing fell back.
4. **The cache, with real limits:** within a turn, step k reads at least what step k-1 read plus wrote; each half's next turn's first
   request reads at least what the turn before it had read plus written at its first step (where it began, `cacheAt`). Any read above
   zero is not enough.
5. **Growth:** from a turn's second step on, every request writes its new part (the step before's reply and results) to the cache. A run that caches only the system prompt would otherwise pass 0 plus 0. (Reads alone can't show it: a step 1 already cached whole, as on a rerun within the hour, writes nothing, and the step after it reads no more than it did.)

Of the control and the Claude-to-Claude turn:

6. **The negative control on Anthropic** is refused (400), asked again once without thinking on the same model, and answered, with no
   model left resting or fallen back to. A run in which no request carried thinking to change fails. On OpenRouter the outcome (refused,
   or answered with the thinking dropped) is reported, not checked.
7. **Claude to Claude:** the stubbed step is answered by the next Claude model, and no step of that turn is refused for its reasoning or
   gets a 400. If the two models' provider tools differ and annai correctly stops the turn's thinking, the table says `changed` and the
   report says so; that is a note, not a failure.

The report also notes, besides the checks: how many steps carried the binding controls and `input_transformations` (reported, not checked: with an error set on a mismatch a dropped block is a 400; or that
`input_transformations` never appeared in a stream), the upstream provider of each OpenRouter turn (and when a turn's steps changed provider),
and the natives sent after the Claude-to-Claude step.

It also reports each turn's thinking kept, in KB, and about how much one step's thinking weighs, so the limit
(`KEPT_MAX` in `src/core/agent/loop.js`, the design §6) can be set again from measured signatures.

## Running it

From the repository root:

```
node scripts/reasoning-check.mjs run --anthropic-key /root/annai-test-keys/anthropic --openrouter-key /root/annai-test-keys/openrouter
```

Either key may be left out; at least one is needed. Each key file's first line is the key. It is read inside the run only
(`scripts/realtime/keys.mjs`), held in private fields, and goes only into the request header the endpoint type builds; the trace
blanks it, and every text printed or written is checked for it first. `--out <dir>` writes the summary elsewhere.

- `node scripts/reasoning-check.mjs run --stand-ins` runs the same against the stand-ins (no network, no key, no cost; about 12 s):
  `test/unit/reasoning-check.test.js` does this in `npm run check`. The run clears its answer timer, so a finished run exits at once.
- `node scripts/reasoning-check.mjs report <folder>` reads a run's summary again and checks it anew, with no network.

**Output:** the table and each check, passed or not, then PASS or FAIL. Exit 0 when every check passed, 1 when one failed, 2 when the
run itself failed. The summary goes to `.superpowers/evidence/reasoning-check/<time>/` (`summary.json`, `summary.txt`), without request
or reply bodies.

## When a check fails

- **1 or 2 (thinking not sent back, or refused):** the request changed before a reply's thinking (the design §5's check would say
  `changed` in the natives column), or the provider binds something annai doesn't keep. A refusal's words are in the Trace's attempt.
- **3 (fell back):** read the attempts' outcomes in the table.
- **0 (no native sent):** Claude did not think (adaptive thinking chose none), or every request after its first changed something before the thinking (the table's natives column says `changed`). "No Kokoro request … (Koe's did)" with the Kokoro note means Sonnet didn't think before another step: rerun. Without the note, Kokoro thought and nothing went back: a fault.
- **4 and 5 (cache):** a step read less than the step before it had cached, or no more than it had read: the prefix annai sent changed, the provider's entry was not found within its lookback (20 blocks) of a mark, or only the system prompt is cached. When only these fail, the report names the likely cause.
- **6 (control):** an Anthropic that answers a changed prefix without a refusal is not enforcing the binding for this account; the controls above should make it enforce. Read `input_transformations` in the report.
- **4 through OpenRouter only:** OpenRouter may not pass a mark on a `tool` message's content on to Anthropic (the design §9's caveat).
  Then put the end mark on the request's own now block instead (chat-completions' `build`): inside a turn that still hits, because the
  now block is kept.
