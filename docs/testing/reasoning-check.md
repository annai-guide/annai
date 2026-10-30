# The reasoning check: Claude's thinking sent back within a turn, against the real providers

The unit tests send Claude's thinking back to stand-ins that check it the way Claude 5.5's documentation says it is checked: each
thinking block bound to everything before it. They show that annai keeps a turn's requests append-only and sends each reply back as it
came. They cannot show that Anthropic, and OpenRouter in front of Anthropic, accept what annai sends, that the cache is read where annai
marks it, or how big a real signature is. This check can (the keep-reasoning design §12; the user, 2026-10-29: "Key here, before release").

It is **opt-in, never part of `npm run check` or CI, and costs money**: a few cents a run, on the keys you give it. Run it before a
release that touches the providers' plugins or the loop, with the user's OK each time.

## What it does

- **annai in Node:** annai's own Halves (Koe and Kokoro), the loop, `callRole` and the real endpoint types (anthropic-messages and
  chat-completions), in memory. The providers are set up from their descriptions in `plugins-official/` (provider-anthropic,
  provider-openrouter), as an install makes them. Kokoro runs on Claude Sonnet 5.5 (main, level medium), Koe · Classic on Claude
  Haiku 5.5 (level low). Voice is off.
- **The trip is synthetic:** a `trip.json` and two notes (a hotel and a dinner), no real data.
- **The conversation, on each provider given:**
  1. The user asks where they stay. Koe answers at once and asks Kokoro; Kokoro lists the notes, reads one and tells Koe (a turn of
     three steps or more); Koe says it.
  2. The user thanks her and asks about dinner: the same again, as the next turn of each half.
- **What it records:** for each request, never its body: the half, the step, the model, the bytes sent, how much thinking went back
  in it, the natives sent or changed (as the Trace has them), the outcome, the cache reads and writes, and the cost.

## What it checks

1. Every step after one whose reply had thinking sends it back.
2. No attempt was refused for its reasoning (outcome `reasoning`), and no request got a 400.
3. Every call was answered by the role's first model: nothing fell back.
4. From a turn's second step on, every request reads from the cache, on Anthropic and through OpenRouter alike; so does each half's
   next turn's first request (where the previous turn began, `cacheAt`).

It also reports each turn's thinking kept, in KB, and about how much one step's thinking weighs, so the 64 KB limit
(`KEPT_MAX` in `src/core/agent/loop.js`, the design §6) can be set again from measured signatures.

## Running it

From the repository root:

```
node scripts/reasoning-check.mjs run --anthropic-key /root/annai-test-keys/anthropic --openrouter-key /root/annai-test-keys/openrouter
```

Either key may be left out; at least one is needed. Each key file's first line is the key. It is read inside the run only
(`scripts/realtime/keys.mjs`), held in private fields, and goes only into the request header the endpoint type builds; the trace
blanks it, and every text printed or written is checked for it first. `--out <dir>` writes the summary elsewhere.

- `node scripts/reasoning-check.mjs run --stand-ins` runs the same against the stand-ins (no network, no key, no cost):
  `test/unit/reasoning-check.test.js` does this in `npm run check`.
- `node scripts/reasoning-check.mjs report <folder>` reads a run's summary again and checks it anew, with no network.

**Output:** the table and each check, passed or not, then PASS or FAIL. Exit 0 when every check passed, 1 when one failed, 2 when the
run itself failed. The summary goes to `.superpowers/evidence/reasoning-check/<time>/` (`summary.json`, `summary.txt`), without request
or reply bodies.

## When a check fails

- **1 or 2 (thinking not sent back, or refused):** the request changed before a reply's thinking (the design §5's check would say
  `changed` in the natives column), or the provider binds something annai doesn't keep. A refusal's words are in the Trace's attempt.
- **3 (fell back):** read the attempts' outcomes in the table.
- **4 through OpenRouter only:** OpenRouter may not pass a mark on a `tool` message's content on to Anthropic (the design §9's caveat).
  Then put the end mark on the request's own now block instead (chat-completions' `build`): inside a turn that still hits, because the
  now block is kept.
