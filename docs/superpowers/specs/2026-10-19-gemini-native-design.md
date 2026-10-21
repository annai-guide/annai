# Gemini, natively: design

Date: 2026-10-19. Status: approved by the user on 2026-10-19 ("specs looks good"); their decisions are under "Decided with the user". Built in milestones G1–G4 (docs/superpowers/plans/2026-10-19-gemini-native.md); the main spec's §9.1, §9.5 and §15 say what was built.

## Why

annai reaches Gemini through Google's OpenAI-compatible endpoint, with the Chat Completions plugin. That works, but it costs us:

- **Audio:** that endpoint takes only WAV and MP3, so the iPhone (which records AAC) sends WAV. That's about ten times the data of Opus or AAC (spec §10.6; the user: "let's try to use the most efficient codec each provider supports … to cut down data usage and increase reliability on trips").
- **Thinking:** Gemini 3 models sign their thoughts, and a tool call's signature must come back with the next request. Through the compatible endpoint we can't carry them, so provider-gemini sends a "skip the check" stand-in (`thought_signature: skip_thought_signature_validator`). It works, but it's a workaround Google could stop accepting.
- **What we don't see:** cached tokens, thinking tokens and each model's context window and output limit all exist in Gemini's own API.
- **Speech:** AI Studio's free tier has transcription and voices (text to speech) too, with per-minute and per-day limits. The user: "on the aistudio google does also provide traditional tts and trascribe for free … if we are using the aistudio endpoints directly we can already support that right?" Today provider-gemini has neither.

The user, 2026-10-19: "a native gemini plugin also seems like something we should build."

## Goals
- A protocol plugin that speaks Gemini's own API, for chat, transcription and voice.
- provider-gemini uses it for those three; Gemini Live stays as it is.
- Every audio format Gemini takes is offered, so each phone sends its smallest (Opus on Android, AAC on the iPhone).
- Thought signatures carried exactly, with no stand-in.
- Context windows, output limits and thinking support read from Gemini's model list.
- Usage (cached and thinking tokens) reported, so cost is right.

## Non-goals
- **Explicit context caching** (paid storage per hour). The Interactions API doesn't have it yet anyway. Implicit caching is automatic and free, and annai's stable prefixes already suit it.
- **Vertex AI.** Only AI Studio's API (generativelanguage.googleapis.com) with an API key.
- **Changing Gemini Live** (the gemini-live plugin): it already speaks the native Live API.

## Anti-goals
- **Google keeping the conversation without the user knowing it, without a way to turn it off, or after the user removed it in annai.** See "Kept on Google's side" below.
- **The key in a URL.** It goes in a header. (Live sessions are WebSocket and still carry it in the URL; that's unchanged.)

## Which of Google's APIs: Interactions (my call)

Google now has two native APIs for this:
- **The Interactions API** (`POST /v1beta/interactions`): generally available since June 2026, and the one Google recommends for new work. New models and features launch there.
- **`generateContent`:** older. Google's docs call it "legacy" but say it "remains fully supported", with no end date.

**I chose Interactions,** because that's where Gemini is going: a plugin written now on `generateContent` would need rewriting the first time a new model or feature appears only on Interactions. It also carries voices (`response_format` audio and `speech_config`), and Google keeping the conversation between turns, which saves data (below).

## Kept on Google's side (on by default; the user's decision)

The user, 2026-10-19: "is it possible we also support letting google store part of the conversations if this saves on data? we shall make this configurable and default on (do not send full conversation each time). ( able to be turned off because privacy concerns maybe?) because we are an agent on the go possibly with spotty internet. thus we shall make these optimizations when possible."

**What it saves.**
- Interactions can store each turn on Google's servers (`store: true`, its default). The next turn then points to it (`previous_interaction_id`) and sends only what's new.
- Every turn still sends Shiori's instructions, her tool list and the settings: Google treats those as per-turn. What's no longer re-sent is everything said before: the words, the photos and voice messages sent inline, and Shiori's own replies, thoughts and tool calls.
- In a long conversation, that turns a request that grows every turn into one that stays about the same size. On a weak connection, a smaller request is more likely to go through, and sooner.
- Google says it also makes its caching work better across turns, which lowers cost.

**The setting.** The Gemini provider's page has a switch, on by default:
- **Words like:** "Let Google keep the conversation between turns: sends less each time."
- **Below it, in plain words:**
  - what Google keeps: the conversation with Shiori, including photos, voice messages and where you are as she knows it;
  - for how long: 1 day on the free tier, up to 55 days on a paid project, which the user can shorten in AI Studio;
  - that annai deletes it when the user removes it here (below).
- **Off:** nothing is kept (`store: false`), and each turn sends the whole conversation.

**How a turn continues a stored one.** The plugin remembers, for each stored turn, its interaction id and a fingerprint of the conversation it covered (annai's messages, not the now block, which travels separately).
- When a new request carries on exactly from a remembered turn plus that turn's reply, it sends `previous_interaction_id` and only what follows: tool results, Shiori's next steps, the user's new message, the now block last.
- Anything else sends the whole conversation and starts a new stored chain. That includes a changed history (compaction, a removed message), a request no stored turn covers (a one-off utility call), or the setting turned off.
- The fingerprints are content-based, so Koe, Kokoro and each trip's conversation chain on their own, with no ids passed around.
- **Turns another model answered** (a fallback in between) are sent as plain history after the stored turn, if Google accepts that in a chained request. The builder checks with a real call; if Google refuses, that case starts a new chain.
- **A different Gemini model** in the same role continues the chain if Google allows it (its docs allow mixing models). The builder checks with a real call too.
- What the plugin remembers is kept on the phone, named as everything stored is (spec §4.9), and dropped after the retention period.

**When Google has forgotten it.** Google deletes stored turns after 1 day (free tier) or up to 55 days (paid), and its docs don't name the error for a turn that's gone. The plugin classifies that error with a new kind meaning "send it again whole", and annai retries the same model once with the whole conversation, as it re-uploads an expired photo (`upload`). It doesn't fall back to another model. This is the one core addition for chaining.

**Removing means removing (spec §4.9).** When the user removes something in annai, what Google kept of it is deleted too, with Google's delete call for each stored interaction:
- removing a trip deletes its conversations' stored turns;
- Erase, removing the Gemini provider, and turning the switch off delete all of them.

Deletions wait for a connection and are retried until done. Until then, the provider page says how many are waiting.

**Removing the provider and Erase delete first** (corrected while planning, 2026-10-19). Nothing on the phone outlives either of them, the key included, so a deletion can't wait for later.
- annai sends the deletions at once, up to 10 seconds, while the key is still there.
- Anything it couldn't delete (offline) is named before the tap: "Google keeps N turns until they expire, up to D days."

Each stored turn is tagged with the trip it belongs to (calls already carry their scope).

**Only conversation turns are kept** (added while planning). Main's and Koe's turns are kept when the switch is on. One-off calls (utility, quick decisions, Test, "Try this model") are never stored on Google's side.

**The Trace** shows, per call, whether it continued a stored turn and how much it sent.

## What's built

### 1. The protocol plugin `gemini-api` ("Gemini API")
An official protocol plugin, like chat-completions or openai-responses, registering three types. All requests go to `{baseUrl}/v1beta/…` with the key in `x-goog-api-key`.

**`gemini` (chat)** builds an Interactions request:
- `model`, `system_instruction`, `tools` (`{ type: "function", name, description, parameters }`), `generation_config` (`max_output_tokens`, `thinking_level`, `thinking_summaries: "auto"`, `tool_choice`), `store` (the switch below: `true` by default), `stream: true`.
- **`input`** is the whole conversation as steps (or, continuing a stored turn, only what's new after it, with `previous_interaction_id`):
  - `user_input` with content parts (`text`, `image`, `audio`, `document`, as `data` + `mime_type`, or `uri` for an uploaded file);
  - the model's own steps (`thought`, `model_output`, `function_call`) **exactly as they came back**, signatures included;
  - `function_result` for each tool result (`call_id`, `name`, `result`, `is_error`).
- **annai's request parts map onto these.** The `tail` (now block) goes last in the final user input, declared `tail: true`. `toolChoice` → `tool_choice` allowed_tools `mode: "any"`.
- **Reading the stream** (`event:` / `data:` SSE, ending `[DONE]`):
  - `step.delta` `text` → text;
  - `thought_summary` → `reasoning_delta` (progress shows, so a thinking model never looks stalled);
  - `thought_signature` → kept with its step;
  - `function_call` steps with their `arguments_delta` pieces joined → tool calls;
  - `interaction.completed` → usage and stop (`requires_action` = tool calls);
  - `error` → a ProviderError.
  - A whole JSON reply (a server that ignores `stream`) is read as the same events, as the other protocols do.
- **Keeping the model's steps.** The model's steps (thought with signature, output, calls) are stored in the reply as annai stores Anthropic's signed thinking, so the next request sends them back unchanged. When the history was made by another provider (fallback, or a model change), there are no Gemini steps to send. annai sends plain text and calls; the builder checks what Gemini 3 accepts for calls without a signature, and uses Google's documented answer.
- **Prices** (my call, from the builder check):
  - provider-gemini 2.0 lists its recommended models with Google's published paid prices, as the official providers list theirs: chat (gemini-3.5-flash-lite, gemini-3.8-flash), transcription (flash-lite) and voice (gemini-3.8-flash-lite-tts). Fetch model list adds the rest, unpriced, as today.
  - **A free-tier key costs nothing.** The provider page has "This key is on the free tier (Google doesn't charge)". With it on, the provider's calls cost $0 in Spend per day and the Trace. AI Studio's free and paid keys look the same, so the user says which.
  - **Speech in tokens:** Gemini bills transcription and voices in tokens; core prices transcription per minute and voices per million characters. The plugin's data gives approximate per-minute and per-character prices from Google's token rates (25 audio tokens a second, in and out: Google's pricing page, and a 0.85 s clip counted 22 tokens and 3.6 s of speech 90, measured 2026-10-20), noted as approximate. No contract change.
- **`store` and `previous_interaction_id`:** see "Kept on Google's side".
- **Usage:**
  - `total_input_tokens` → input;
  - `total_cached_tokens` → cache reads;
  - `total_output_tokens` + `total_thought_tokens` → output (thinking is billed as output);
  - `input_tokens_by_modality` → audio and image input, priced as provider-gemini's `audioIn` / `image` prices say.
- **Thinking levels:** annai's off / low / medium / high / max → `minimal` / `low` / `medium` / `high` / `high`.
  - A model without `minimal` has no "off" in its map, so annai's nearest-level rule gives it "low", as today.
  - Fetch model list gives a thinking model the map for its family from Google's documented levels. "Test reasoning levels" corrects it on the phone.
- **Audio in:** `audioIn` is `["ogg", "webm", "mp4", "aac", "mp3", "flac", "wav"]`. Gemini takes all of these.
- **Photos:** inline, or uploaded to Gemini's Files API (`uploadRequest` / `readUpload`). Gemini deletes its files after 48 hours, which is annai's own expiry for uploads (§4.8); an expired file is classified `upload`, so annai uploads again.
- **Errors (`classify`):**

  | Gemini says | annai's kind |
  |---|---|
  | 400 "API key not valid", 401, 403 | `auth` |
  | 429 / RESOURCE_EXHAUSTED | `rate`, and when Google says the daily free limit is used up, the reply says so in words ("until tomorrow") |
  | 503 / UNAVAILABLE | `overloaded` |
  | a prompt over the window | `context` |
  | a 400 naming the audio format | left as a format refusal, so annai's WAV retry works (§10.6) |
  | a safety block | the stop reason `refusal`, with Google's reason in words: the turn ends and no other model is tried, as with other providers' refusals (my call, from the builder check) |

- **The model list:** `GET /v1beta/models`, paged.
  - Chat models: those that generate content, excluding TTS, Live, embedding and image models.
  - Each one's `inputTokenLimit` → context window, `outputTokenLimit` → max output, `thinking` → the reasoning map above.
  - TTS models go to voice, and transcription-suitable models (flash and flash-lite) to transcription. Live models stay with the live ability.

**`gemini-transcription`:** a transcription type that sends the audio with a fixed instruction ("Transcribe this speech exactly, in its own language; output only the words") to a flash-lite model, with thinking at minimal and a temperature of 0 if the API takes one. It returns the text. If `generation_config.transcription_config` turns out to be the documented way to do plain speech-to-text, the builder uses that instead. `audioIn` is as for chat.

**`gemini-speech` (voice):** an Interactions request to a TTS model:
- `response_format: { type: "audio", mime_type, sample_rate }`;
- `generation_config.speech_config` with the voice (Google's 30 voices; Kore by default, or the builder's pick for Shiori).
- **Streamed, sentence by sentence** (the user asked; measured 2026-10-19 on the free key with gemini-3.8-flash-lite-tts):

  | Sentence | Streamed: first audio | Whole: ready to play |
  |---|---|---|
  | short (4 s of speech) | 0.6 s | 2.0 s |
  | long (12 s of speech) | 0.4 s | 3.0 s |

  - Waiting for the whole clip adds 1.4–2.6 s before Shiori starts talking. The later sentences are fetched while one plays, so the gap is mostly at the start of each reply.
  - **Core addition:** an optional streaming method in the speech contract. It yields PCM chunks with their rate; the speaker plays them through the player's `stream` (K4's, which plays Gemini Live's PCM today). A voice type without it works as today.
  - **Never stutters (the user asked about downsides).** Full quality takes about 540 kbps on the wire. On a weaker connection the audio arrives slower than it plays, and the stream player, which schedules each piece as it arrives with nothing held back, would leave gaps mid-word.
    - So playback starts once the rest of the clip will, at the rate it's arriving, be in before playback reaches it. On a good connection that's about half a second. On a weak one it waits, up to nearly the whole clip, as a whole clip does today, and then plays smoothly.
    - The rule lives in the speaker or the stream player, not the plugin, so other streamed voices get it too.
  - **A switch to turn it off,** per voice ability (a tunable, on by default): with it off, the plugin reads the stream and hands back the whole clip as WAV.
    - Streaming moves Shiori's everyday voice from the browser's audio element to Web Audio, the path Gemini Live uses. That path isn't yet checked on a real iPhone: the silent switch, Bluetooth, the car, the screen locking mid-sentence.
    - The device checklist covers those. If one fails, the switch is the way back while it's fixed.
  - **A clip that fails partway** stops where it got to, and the sentence goes to the next voice in the role, as a failed clip does today. The Trace and cost count the sentence once.
  - Other providers' streamed voices (OpenAI's chunked MP3 or PCM) can use the same method later. Not in this build.
- **Each sentence is one request.** The free tier counts requests per minute and per day. The builder finds the TTS models' free limits (the rate-limits page, or a real call) and reports them. If they're too small to speak a day's replies, the provider page says so in words.
- **Format:** Google sends voices only in two ways.
  - Uncompressed 16-bit PCM at 24 kHz: about 384 kbps, about a third more as base64 inside JSON.
  - Phone-quality G.711 μ-law / A-law at 8 kHz: about 64 kbps. Asked for μ-law at 16 kHz, Google sends 8 kHz, streamed and whole (and asked for PCM at 16 kHz, it sends 24 kHz): measured 2026-10-20, so phone quality is 8 kHz only.

  annai's format list (`src/core/voice/formats.js`) has no μ-law, and MP3 doesn't exist here. So the plugin carries its own `format` tunable, decodes μ-law to WAV for playback (the decoder is in openai-realtime today: the builder moves it where both can use it), and core's "refused format → MP3, then WAV" retry ends at WAV. Which format is the default: the user's decision (see "Decided with the user").

### Google Search, built in (the user asked: "let's make it built into the gemini plugin")
- **How:** the chat request adds `{ "type": "google_search" }` to `tools`, beside Shiori's own tools. Gemini 3 takes both in one request and searches on its own when it needs to.
  - Checked on the paid key: a request with search and a function tool → `google_search_call` (2 queries) → `google_search_result` (with `search_suggestions`) → `thought` → `model_output` with `url_citation` annotations. Usage counts searches in `grounding_tool_count`.
- **Not on the free tier.** On the user's free key, the same request with the search tool is refused at once (429, "exceeded your current quota"), while without it the call works. So the tool goes in only when the provider isn't marked free tier. With "This key is on the free tier" on, the search switch is off and says why: "Google doesn't offer search on the free tier."
- **The switch** on the provider page: "Let Gemini search Google", on by default for a key not marked free tier.
  - Under it: Google gives 5,000 searches a month free on paid projects, then $14 per 1,000. Google keeps searched prompts for 30 days, which annai can't delete.
- **Cost:** each search query counts. annai counts this phone's searches per calendar month: the first 5,000 cost $0, then $0.014 each, in Spend per day and the Trace. That's an estimate, since other devices on the same project share Google's 5,000.
- **What the stream shows:** `google_search_call` → a progress line ("Searching Google: …") as `reasoning_delta`, so the turn never looks stalled; `google_search_result` → kept with the reply (below).
  - Measured with a paid key (2026-10-21, gemini-3.5-flash-lite): each search step streams as a `step.start` with an empty signature, then one `step.delta` holding the whole step (the call's `arguments.queries`, the result's `search_suggestions` and a signature of about 35 KB); the words' sources come as a `text_annotation_delta` of `url_citation`s (Google's grounding redirect addresses, titled by site). A whole send carrying the steps back, signatures and all, is taken.
- **Display: Google's terms** (Gemini API terms, Grounding with Google Search):
  - Grounded results are shown to the user who asked, with their Search Suggestions (up to 5).
  - They aren't modified or interspersed with other content.
  - Links aren't redirected or click-tracked.
  - The text may be stored up to two years to show chat history.

  annai shows a grounded reply's sources (its `url_citation` links, unchanged) and Google's suggestion chips under it. The chips are Google's HTML snippet, drawn in a sandboxed frame with no scripts, so it can't reach annai.

  **How this fits Koe (the user's decision, 2026-10-19: "Show it as-is, Koe retells"):**
  - When a reply used Google Search, the conversation shows a **"From Google Search" card**: the grounded answer exactly as Google returned it, with its source links and Google's suggestion chips. It's always shown, even when Kokoro's notes are hidden, because Google's terms ask for it.
  - With Koe on, Kokoro's grounded answer reaches Koe as a note, and Koe still says it in her own words.
  - With Shiori as one half, her grounded reply is the card's text, shown as it is.
- **Removing:** a grounded reply is part of its conversation and goes with it.

### 2. provider-gemini 2.0.0
- **chat:** type `gemini`, base `https://generativelanguage.googleapis.com`. The `standInCallExtra` workaround and the WAV/MP3 limit go away.
- **New abilities:**
  - **transcription** (`gemini-transcription`, suggested model gemini-3.5-flash-lite);
  - **voice** (`gemini-speech`, suggested model gemini-3.8-flash-lite-tts).
- **live:** unchanged as a protocol. Its recommended Koe is now a list: **gemini-3.8-live, then gemini-3.5-flash-lite** (the user asked why Live wasn't suggested for Koe).
  - It was recommended already, but the Live ability is off by default, so the suggestion did nothing.
  - Now the tap on "Use the recommended models" switches the Live ability on (installing gemini-live, as switching it on does) and fills Koe with both.
  - Adding the provider still doesn't turn on the two halves by itself (the split stays opt-in).
  - With the one Koe list (koe-one), voice on uses Live; voice off uses flash-lite, so a typed conversation doesn't download Live's audio.
- **Requirements:** `gemini-api` (all or nothing, as `requires` works) and, for live, `gemini-live`. It no longer requires chat-completions.
- **Major version 2,** because its requirements and ability types change. A phone with 1.x gets it through Settings → Updates.
- An existing Gemini provider keeps its key and models; its chat ability's type changes with the update. The user said a moving-over needn't be perfect. If a model needs re-adding, the provider's page says so in words.
- **Using it on a phone with a Chat Completions Gemini today:** the update is the switch. Someone who wants the old route can use "Another address" with the OpenAI-compatible URL.

### 3. Docs and tests
- **Docs:** docs/plugins.md (the Audio formats list: Gemini takes all of them now), spec §9 / §10.6 where they name Gemini, the catalog (`npm run catalog`), and a device checklist (`docs/testing/device-checklist-gemini.md`): the iPhone sends AAC, and a voice reply and a transcription go through Gemini. The streamed voice on the iPhone: with the silent switch on, over Bluetooth, in the car, the screen locking mid-sentence, and on a weak connection (it waits, then plays without gaps).
- **Unit tests:** the request built from annai's request (each part type, the history with signatures, tool results), the stream reader on recorded event sequences (text, thought summaries and signatures, a split `arguments_delta`, `requires_action`, an `error` event, a whole JSON reply), `classify`, the list reader, and transcription and speech.
- **e2e:** a stand-in Gemini server in the existing helpers' style, covering Add Gemini from the catalog, Fetch model list, Test (with the tool and the photo), Try this model, a voice reply and a transcription.
- **Opt-in live tests** (`test/live/`, never in CI) with the user's free key: chat with a tool call over two turns, both stored (chained) and whole (signatures carried back); a chain after a fallback turn; a chained request to a deleted interaction (the "send it again whole" path); a delete; an Opus clip transcribed; a voice reply; and a context window read.
- **Unit tests for chaining:** the fingerprint match (continues, a changed history, a one-off call), the retry when Google has forgotten, the deletions on each kind of removal, waiting for a connection. Per the key rules: line 1 only, read inside the command, never printed.

## Builder's calls
- Exact names in copy, the voice for Shiori, the transcription instruction's wording.
- How a stored reply keeps Gemini's steps (follow how Anthropic's signed thinking is kept).
- Anything the docs leave open, decided from Google's current docs and a real call with the free key, and noted in the report.

## Decided with the user
- **The voice's default format: full quality** (24 kHz PCM), the user's choice on 2026-10-19 ("Full quality"). Phone quality at 8 kHz (μ-law) stays selectable in the voice ability's format on the provider page, named by quality and data in plain words. (16 kHz was planned, but asked for it, Google sends 8 kHz μ-law or 24 kHz PCM, measured 2026-10-19, so there's no 16 kHz choice.)

- **Google keeps the conversation between turns, on by default, with a switch to turn it off** (the user, 2026-10-19; see "Kept on Google's side").

- **Streamed voice in this build,** for Gemini (the user's question, with the measurement above).
- **Google Search built into the Gemini plugin** (the user, 2026-10-19), off on the free tier. A grounded answer is shown as Google returned it, in a "From Google Search" card with its sources and chips, while Koe retells it (the user's choice).

## Later (not in this build)
- **The same saving for OpenAI Responses** (`store` and `previous_response_id`), in the spirit of the user's "we shall make these optimizations when possible". It's queued next, after this build, with the same switch and deletions. Routers that speak Responses but don't keep state need detecting there.
- **Streamed voice for other providers** (OpenAI's and others'), on the streaming method this build adds.
- **Google Search grounding** as a tool Shiori can use (a free web search on AI Studio within its limits).
- **Ephemeral tokens for Gemini Live,** so the key isn't in the WebSocket URL. It needs something to mint them, which annai doesn't have.

## Build order
After koe-one (the one Koe list) merges, because both touch provider-gemini. One builder, then a review, a fix pass, merge, release.
