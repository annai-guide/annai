# OpenAI Responses endpoint type — Implementation Plan

**Asked for by the user on 2026-10-18.** Brief: `.superpowers/briefs/openai-responses.md`. The spec (§9.1) lists OpenAI Responses as an official endpoint type; this builds it as `plugins-official/openai-responses/`, in the shape of the Chat Completions and Anthropic Messages plugins.

## Choices this plan makes

1. **No core change.** The provider contract already carries what Responses needs:
   - **Reasoning** is one `reasoning` part per reasoning item. `text` is its summary (or, from servers that send it, its reasoning text). `signature` is the item itself as JSON, without its `status` (`{ id, summary, encrypted_content }`), which is how OpenAI's own examples replay it (fact 6). A signed part goes back only to the model that wrote it (`portable()`), and the plugin sends it back unchanged. So nothing is lost, across tool calls or across turns.
   - **A web search** is a `provider` part: the `web_search_call` item, sent back unchanged to the same model, as OpenAI's `toResponseInputItems` keeps it (fact 6).
   - No core file changes, so the size budget doesn't move.
2. **No server-side state:** every request has `store: false` and the whole conversation. `include: ['reasoning.encrypted_content']` is sent too (tunable `encryptedReasoning`, on), although OpenAI now returns the encrypted reasoning in stateless mode without it (fact 5). It costs nothing there, and other servers that speak the API may still need it. Some non-reasoning models have refused it in the past, so it can be switched off.
3. **A reasoning item is sent back only when something of the same reply follows it.** The API wants a reasoning item followed by the item it led to. A reply cut short could end in reasoning alone; that item stays out. A reasoning item that carries neither encrypted content nor reasoning text stays out too: with `store: false`, the API would look it up by id and fail.
4. **Phase.** OpenAI asks to resend each assistant message's `phase` (fact 7). annai's text parts don't keep it, so the plugin works it out from the reply's shape, using OpenAI's own definition: Shiori's words in a reply that also calls a tool are `commentary`, and words in a reply that calls none are the `final_answer`. Tunable `phase` (on) turns it off for servers that refuse the field.
5. **The now block goes last, in a `developer` message of its own** (tunable `nowRole`, `developer` or `user`). On GPT-5.6 and later, OpenAI's automatic cache breakpoint sits at the end of the latest *eligible* message: a user message or the last of a group of tool results. A developer message after them isn't eligible (fact 9). So the cached prefix ends just before the now block, as Anthropic's marker does (spec §6.3), with no explicit breakpoint field that older models and other servers might refuse. On earlier models, breakpoints fall every 2,048 tokens anyway. A server without developer messages can use `user`.
6. **Reasoning summaries are a tunable, not part of each level's patch.** `reasoningSummary` (`"auto"`) goes into `reasoning.summary` for models that have reasoning levels (a reasoning map), and never for others, which would refuse a `reasoning` field. Summaries are what show as reasoning text, and as they stream they keep a thinking model's reply alive past the time limit between pieces of output (spec §9.6). OpenAI says summaries may need a verified organization (fact 8). Without one, setting `"reasoningSummary": false` on the endpoint fixes every model at once, and the error card shows OpenAI's own words. The level patches carry only `reasoning.effort` (spec §9.3).
7. **Reasoning levels** (spec §9.3) in the templates, for the models' documented efforts (fact 3):
   - GPT-6 Astra: low, medium, high, and `max` for max. It has no `none`, so "off" uses low.
   - GPT-6.1 Sol: low, medium, high, max. It has neither `none` nor `minimal`.
   - GPT-6 Luna: off as `none`, then low, medium, high, max.
   - `xhigh` has no level of its own; a user can put it on "high" or "max".
8. **Function tools are sent with `strict: false`.** If `strict` is left out, Responses rewrites a schema into strict mode where it can, and that makes every optional property required (fact 4). annai's tools keep their meaning, as with the other types.
9. **Photos** go as `input_image` data URLs, or by file id when the endpoint uploads them (spec §4.8). The upload is `POST /files` with `purpose=vision` and `expires_after` set to 48 hours (fact 10); the Test button's upload uses one hour, the shortest OpenAI allows. Tunable `uploads` (on) is the switch Settings shows. `imageDetail` (unset, which means `auto`) is the same tunable as Chat Completions'. PDFs go as `input_file` data URLs. Audio has no Responses input type, so it is left out (no template model takes audio).
10. **Provider tool:** OpenAI web search, as `{ "tools+": [{ "type": "web_search" }] }`, $0.01 a call (fact 11). The Responses usage doesn't count searches, so the plugin counts the `web_search_call` items whose action is a search, as `serverTools.web_search_requests`. Pages it opens or searches within aren't charged. Sources come back as `url_citation` annotations, given as citations.
11. **Usage:** `input_tokens` includes cached tokens and cache writes, so annai's `input` is what's left: `input_tokens − cached_tokens − cache_write_tokens`. GPT-5.6 and later charge for cache writes at 1.25× input (fact 9), and annai's `cacheWrite` price carries it. `output` includes reasoning tokens, which are counted on their own too.
12. **Stop reasons:** `response.completed` stops with `tool` when the reply called a function and with `end` otherwise. `response.incomplete` maps `max_output_tokens` to `length` and `content_filter` to `refusal`, and anything else to `other`. A refusal content part is kept as text, and the reply stops with `refusal`. `response.failed` and `error` events are ProviderErrors of the kind their code says. A stream with no terminal event is a network error, as with the other types.
13. **Errors** (`classify`), by OpenAI's codes (fact 12):
    - `context_length_exceeded` is context.
    - The quota, credit and spend-limit codes are credit.
    - `rate_limit_exceeded` and `slow_down` are rate.
    - `server_is_overloaded` is overloaded.
    - `invalid_api_key` is auth.
    - `model_not_found` is not-found.
    - The image codes are image.
    - An unknown or expired file is upload, so annai uploads the photo again.
    - The policy blocks (`invalid_prompt`, `bio_policy`, `misalignment_policy_violation`, which comes as a 403) are bad-request, not a bad key.
14. **`max_output_tokens`** is the request's maximum, else the model's, and never below 16. Responses has refused smaller values (remembered from earlier use; the current reference doesn't say). The decide role's one-token answer then asks for 16.
15. **Logprobs** work as with Chat Completions: `top_logprobs` plus `include: ['message.output_text.logprobs']`, read from the first text delta. OpenAI allows them only at reasoning effort `none` (fact 3), so no template model turns `logprobs` on.
16. **The model list** is `GET /models`. OpenAI's gives ids only, so each listed model is an id; capabilities and prices come from the template or the user.
17. **Templates** (`catalog/templates.json`):
    - **"OpenAI (Responses)"** (`openai-responses`): base URL `https://api.openai.com/v1` and three current models (fact 2).
      - Each has prices with the long-prompt tier, `contextWindow: 922000` (the most input OpenAI takes of the 1,050,000-token window; annai uses the window as an input limit), `maxOutput: 128000`, text and image input, tools, photo limits and OpenAI web search.
      - Suggested roles: main is GPT-6.1 Sol; utility and quick decision are GPT-6 Luna.
    - **"Other: OpenAI Responses"** (`custom-openai-responses`): no base URL, for servers that speak the API, with a note on the tunables to try when one refuses a request.
    - **The Chat Completions OpenAI template stays.** It is renamed "OpenAI (Chat Completions)" (version 2), so the two read apart in the list. Its note says to prefer the Responses template: GPT-6 Astra and GPT-6.1 Sol call tools only through Responses (fact 2).
18. **`cacheTtls`** stays empty for these models: the field takes only 5m and 1h, and OpenAI's lifetime is at least 30 minutes, so annai counts a cache cold after 5 minutes, which errs on the safe side (spec §6.4).
19. **The e2e test** uses a stand-in Responses server on a port of its own (port 0), as the existing tests do. It runs in both browsers: add "Other: OpenAI Responses", fetch its model list, add a model, mark it as taking photos, run Test (access, tools, photos, upload), then a conversation in which Shiori calls `show` once.
20. **Ledger:** `.superpowers/sdd/openai-responses/progress.md` in the worktree, git-ignored.

## API facts relied on (looked up 2026-10-18)

Sources are developers.openai.com pages, read as Markdown (append `.md`):
- A: `/api/reference/resources/responses/methods/create`
- B: `/api/reference/resources/responses/streaming-events`
- C: `/api/docs/guides/reasoning`
- D: `/api/docs/guides/prompt-caching`
- E: `/api/docs/guides/function-calling`
- F: `/api/docs/guides/tools-web-search`
- G: `/api/docs/pricing`
- H: `/api/docs/guides/images-vision`
- I: `/api/docs/guides/file-inputs`
- J: `/api/reference/resources/files` and context7's copy of `files/methods/create`
- K: `/api/reference/resources/models/methods/list`
- L: `/api/docs/guides/error-codes`
- M: `/api/docs/guides/deployment-checklist`
- N: `/api/docs/guides/conversation-state`
- O: the model pages `/api/docs/models/gpt-6-astra`, `gpt-6.1-sol` and `gpt-6-luna`
- P: openai-node's `src/lib/responses/ResponseInputItems.ts` (`toResponseInputItems`)

1. **Request** (A): `POST /responses` takes these fields:
   - `input`, a list of items:
     - messages with role `user`, `assistant`, `system` or `developer`, whose content is a string or `input_text` / `input_image` (`image_url` as a data URL, or `file_id`, and `detail`) / `input_file` (`filename`, `file_data`);
     - `function_call` (`call_id`, `name`, `arguments` as a JSON string);
     - `function_call_output` (`call_id`, `output`);
     - `reasoning` (`id`, `summary`, `encrypted_content`, `content`);
     - `web_search_call`.
   - `instructions`: a system or developer message put first.
   - `tools`: functions are `{ type: 'function', name, description, parameters, strict }`; web search is `{ type: 'web_search' }`.
   - `tool_choice`: `{ type: 'function', name }` forces one.
   - `max_output_tokens`: includes reasoning tokens.
   - `reasoning`: `{ effort, summary, context }`.
   - `store`: true when left out.
   - `include`.
   - `stream`.
   - `top_logprobs`: 0 to 20.
2. **Models** (O, M, C): there are three flagships.
   - `gpt-6-astra`: $10 input, $1 cached, $12.50 cache writes, $50 output per million tokens.
   - `gpt-6.1-sol`: $2, $0.10, $2.50 and $10.
   - `gpt-6-luna`: $0.10, $0.01, $0.125 and $0.50.
   - Each has a 1,050,000-token window with at most 922,000 input tokens, 128,000 output, and text and image input.
   - Prompts over 272K input tokens cost 2× input and cache, and 1.5× output, for the whole request (G).
   - GPT-6 Astra and GPT-6.1 Sol call tools only through Responses; Chat Completions has no tool calling for them.
3. **Reasoning effort** (C, O): the values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`, and models support subsets.
   - Astra takes low through max. `none` returns HTTP 400.
   - 6.1 Sol takes low through max, with `medium` its default.
   - Luna takes `none` through max, with `medium` its default.
   - At efforts other than `none`, drop `top_logprobs` and `message.output_text.logprobs` (M).
4. **Strict mode** (E): "If you omit `strict` … Responses requests will attempt to normalize your schema into strict mode when possible … To opt out … explicitly set `strict: false`."
5. **Stateless reasoning** (C, A): "When you create a response in stateless mode, reasoning items in the response's `output` array include an `encrypted_content` property by default. Stateless mode applies when `store` is `false` … The API still accepts the legacy `reasoning.encrypted_content` value in `include` for compatibility, but doesn't require it."
   - "When streaming, use the completed reasoning item and its `encrypted_content` from the `response.output_item.done` event … The `encrypted_content` in `response.output_item.added` may be incomplete."
   - Pass back reasoning items with function calls, all of them since the last user message (C, "Keeping reasoning items in context").
   - `reasoning.context` defaults to `all_turns` on GPT-5.6 and later, which renders earlier turns' reasoning too.
   - "Persisted reasoning can be reused only within the same model family."
6. **Replaying output** (C, N, P): OpenAI's examples replay each output item as it came, ids included (Python: `item.model_dump(exclude={"status"})`). `toResponseInputItems` keeps `reasoning` and `web_search_call` items unchanged.
7. **Phase** (C, M, A): an assistant message's `phase` is `commentary` or `final_answer`. "For models like `gpt-5.3-codex` and beyond, when sending follow-up requests, preserve and resend phase on all assistant messages — dropping it can degrade performance." Use `commentary` "for intermediate assistant updates, such as preambles before tool calls", and `final_answer` "for the completed answer".
8. **Summaries** (C): `summary: 'auto'` gives "the most detailed summarizer available". "Before using summarizers with our latest reasoning models, you may need to complete organization verification."
9. **Caching** (D):
   - On GPT-5.6 and later, implicit mode "places a breakpoint at the end of the latest eligible message. Eligible messages are: user messages; the last tool response in a consecutive group of tool responses; the last developer message in the initial consecutive group of developer messages."
   - Lookups also try "up to 20 earlier eligible message endings".
   - Writes cost 1.25× input, and the cache lasts at least 30 minutes.
   - Earlier models place breakpoints every 2,048 tokens.
   - "Cache-write pricing is not an additive fee: input tokens use the uncached-input, cached-input, or cache-write rate."
   - Ordinary input is `input_tokens - cached_tokens - cache_write_tokens`.
10. **Files** (J, H):
    - The upload is `POST /files` as multipart, with `file`, `purpose` and `expires_after[anchor]=created_at` and `expires_after[seconds]` (3600 to 2592000). The reply has `id` and `expires_at` in Unix seconds.
    - The vision guide uploads with `purpose: "vision"` and sends `{ type: 'input_image', file_id }`.
    - Images can be PNG, JPEG, WEBP or non-animated GIF, up to 1,500 a request and 512 MB a request.
    - An image over 30,000 patches of 32 px is refused (H). A 5,000 px square is 24,649 patches, hence `maxEdge: 5000`.
    - A PDF goes as `input_file` with `file_data: 'data:application/pdf;base64,…'` (I).
11. **Web search** (F, G):
    - Results come as a `web_search_call` item (an `action` of `search`, `open_page` or `find_in_page`) and a message whose text has `url_citation` annotations.
    - "Search actions incur a tool call cost": $10.00 per 1,000 calls, plus content tokens at model rates.
12. **Streaming events** (B):
    - `response.created`, `response.in_progress`.
    - `response.output_item.added` and `.done`, with `output_index` and `item`.
    - `response.output_text.delta` (`delta`, `logprobs`).
    - `response.output_text.annotation.added`.
    - `response.refusal.delta`.
    - `response.function_call_arguments.delta` and `.done` (`item_id`, `output_index`).
    - `response.reasoning_summary_text.delta`, and `response.reasoning_text.delta`.
    - `response.web_search_call.*`.
    - `response.completed`, `response.incomplete` (`incomplete_details.reason`: `max_output_tokens`, `content_filter`, …) and `response.failed` (`response.error.code`). Each has `response.usage`: `input_tokens`, `input_tokens_details.cached_tokens` and `cache_write_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`.
    - `error` (`code`, `message`, `param`).
    - The reference lists no `[DONE]` line; the stream ends after the terminal event. The plugin accepts one anyway.
13. **Error codes** (L, M, B):
    - 401 is a bad key.
    - 429 `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded` and `organization_usage_limit_exceeded` need billing action.
    - 429 `slow_down` and rate limits follow `Retry-After`.
    - 503 `server_is_overloaded`.
    - 403 `misalignment_policy_violation`: don't retry.
    - The image codes of `response.failed` (`invalid_image`, `image_too_large`, `image_file_not_found`, …).
14. **Model list** (K): `GET /models` returns `{ data: [{ id, created, owned_by, shutdown_date }] }`.

## Tasks (test-first)

1. **Fixtures** in `test/fixtures/llm/openai-responses/`, recorded SSE streams in OpenAI's event shapes:
   - text with usage;
   - a tool call whose arguments arrive in pieces;
   - two tool calls;
   - reasoning summary deltas and an encrypted reasoning item;
   - usage with cached, cache-write and reasoning tokens;
   - a stream cut short;
   - `response.incomplete` for max tokens;
   - `response.failed`;
   - a web search with a citation;
   - the model list.
2. **Unit tests** in `test/unit/llm-openai-responses.test.js`:
   - build:
     - a conversation with photos (bytes and a file id), a PDF, tool calls and results, reasoning signed by this model and by another, phases, and the now block as the last developer message;
     - tunables (no key, `nowRole` set to `user`, `phase` and `encryptedReasoning` off, `imageDetail`);
     - reasoning summary only for models with reasoning levels;
     - a forced tool, logprobs, a minimum of 16 output tokens;
     - a cut-short call's arguments;
     - a lone reasoning item left out;
     - web search items back in place;
     - a reasoning level's patch merged by `applyPatches`;
   - read: every fixture above;
   - classify: 401, 429 credit and rate, 400 context, overloaded, image, an expired file, policy;
   - list;
   - uploads;
   - the Test button through `testModel` with a stand-in fetch (access, tools, photos, upload);
   - catalog checks: template types and roles (the existing test), Responses models listing web search.
3. **The plugin** `plugins-official/openai-responses/` (`annai-plugin.json`, `index.js`), then `node scripts/catalog.mjs`.
4. **Templates:** "OpenAI (Responses)", "Other: OpenAI Responses", and the Chat Completions OpenAI template's name and note.
5. **E2E** in `test/e2e/models.spec.js`, in both browsers, as in choice 19.
6. **Docs:**
   - spec: §9.1 (what exists), §9.3 (where reasoning text comes back), §6.3 (how Responses keeps the now block out of the cached prefix), §4.8 (OpenAI uploads), §20 (remaining plugins);
   - `docs/plugins.md` and README (the types annai ships).
7. `npm run stamp && npm run check`, the full Docker e2e, size.
