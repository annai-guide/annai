# Koe and Kokoro: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shiori becomes two halves when the user opts in: Koe talks with the user at once (a fast text model, or a realtime voice model such as Gemini Live), and Kokoro, the main model, thinks and works behind it. The halves pass notes that never stall either one, and every recording travels in the smallest format both the phone and the provider can handle.

**Architecture:**
- **One loop class, two instances.** `Agent` (src/core/agent/loop.js) becomes configurable as a *half*. Kokoro is the main-role instance, and Koe's text pathway is a second instance with its own role, tools, compact context and conversation window. With no Koe model, Kokoro is the one half and behaves exactly as today.
- **A coordinator, `Halves`** (src/core/agent/halves.js), is the object the app and the screens hold, with Agent's public surface. It routes what is heard, typed and triggered. It wakes Kokoro on cue, delivers notes through a `Channel`, keeps the code gate on Kokoro's output tools, and writes the instruction blocks Kokoro reads as messages.
- **Realtime models** are a new ability kind, `realtime`, with protocol plugins: `gemini-live` first, then `openai-realtime`. Each speaks one wire format behind a small contract: `open` builds the address, and `attach` drives a WebSocket that annai opens, checks and traces. Koe's live pathway (`LiveKoe`) runs a session from the phone with the user's own key. It streams audio only while someone speaks, using annai's own end-of-sentence detector and the API's manual activity signals.
- **Audio formats** are declared per ability as tunables (`audioIn`, `audioOut`). The device encodes Opus, AAC, MP3 or FLAC with WebCodecs' `AudioEncoder` and annai's own small muxers, with MediaRecorder next and WAV last.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3 (`npm run typecheck`).
- Tests: `node:test` (Node 26), and Playwright 1.63.0 in Docker (Chromium as Pixel 7, WebKit as iPhone 15).
- Node's built-in `WebSocket` client in unit tests, and a stand-in realtime server of annai's own (`test/fakes/realtime-server.js`, no dependencies).

**Spec:** `docs/superpowers/specs/2026-10-19-koe-kokoro-design.md` is the design to build from (approved by the user, 2026-10-19). Its rules sit inside the main spec, `docs/superpowers/specs/2026-10-15-annai-design.md`, and it builds on the provider redesign, `docs/superpowers/specs/2026-10-18-provider-plugins-design.md` and its plan `docs/superpowers/plans/2026-10-19-provider-plugins.md` ("Shapes"). Executors read all three.

**Starts from:** main at 0f837b9, where provider milestones 1 and 2 are merged. Provider milestones 3–6 are being built in parallel; "Running in parallel" below says where their files meet these.

---

## The spike: what was measured (2026-10-19)

The design's "A spike first" asked four questions. The desktop half of the spike was run while this plan was written. The code was throwaway, in the planner's scratch folder, never in the repository. The iPhone half is device checks (below, and in each milestone).

**How it was run:**
- **Gemini Live:** Node 26.12's `WebSocket` on this machine, sending `Origin: https://annai.guide` as a browser would. The model was `gemini-3.8-live`, with the user's free AI Studio key (line 1 of the key file), passed only through an environment variable.
- **Speech:** clips synthesized with ffmpeg's flite voice at 16 kHz.
- **Browsers:** Playwright 1.63 in its Docker image (Chromium 153 as Pixel 7, WebKit 26.6 as iPhone 15), with a page under annai's security policy.
- **Paid key:** line 2 was never used. Line 1 was refused once, by gemini-3.8-flash's per-minute limit (5 requests a minute on the free tier, `429 RESOURCE_EXHAUSTED` with `retryDelay`). Waiting between calls solved it.
- **Volume:** about 40 Live sessions and 45 other calls. Every other request was accepted, and 4 sessions at once were too.

**Sources (read 2026-10-19):**
- ai.google.dev/gemini-api/docs: `live-api`, `live-guide`, `live-tools`, `live-session`, `pricing`, `rate-limits`; and ai.google.dev/api/live.
- developers.openai.com/api/docs/guides: `realtime-websocket`, `realtime-conversations` and `speech-to-text`; developers.openai.com/api/reference/resources/realtime; developers.openai.com/api/docs/pricing.
- console.groq.com/docs/speech-to-text, and openrouter.ai/docs/guides/overview/multimodal/audio.

### 1. Gemini Live (question 1, desktop half)

| What | Measured | What the plan does with it |
|---|---|---|
| Opening | The WebSocket opens in 150–350 ms, and `setupComplete` follows 100–200 ms later (280–550 ms in all). Resuming with a handle took 440 ms. | A session opens in under a second, so the tap that opens it can carry speech right away (K5). |
| Time to first audio (spoken questions) | 683–968 ms after `activityEnd` in 5 of 8 runs, with outliers of 1.9, 2.1 and 2.6 s. | "I'm checking…" is heard about a second after the user stops speaking. |
| Time to first audio (typed questions) | 505–680 ms in 5 of 7, with outliers of 3.3 and 7.7 s. | |
| How audio arrives | In a burst: 6.8 s of speech arrived in 1.0 s. The server's `turnComplete` comes when real-time playback *would* end. | The client plays from a buffer and tracks what was actually played. "Koe said aloud" is cut at the played point, and an append note waits for the local playback to end (K5). |
| Audio formats | 16-bit PCM in at 16 kHz (`audio/pcm;rate=16000`), and 24 kHz PCM out. A `TEXT` response modality is refused (1007). | The only saving is to stream no silence. A realtime Koe in a typing conversation shows its transcript and drops the audio (K5). |
| Automatic activity detection | Streaming speech only, then `audioStreamEnd`, never ended the turn (4 of 4 got no reply). | **Manual activity signals** (`activityStart` and `activityEnd`, automatic detection off), driven by annai's own detector (decision 9). |
| Barge-in | `activityStart` while Koe talks gives `interrupted` in 75 ms. | The user can cut in by voice; buffered audio is dropped on `interrupted` (K5). |
| Tools (question 3) | `tell_kokoro` declared blocking (the default), answered at once with `{ result: "sent" }` and `scheduling: "SILENT"`: no extra speech in 3 of 3 runs and 4 of 4 typed calls. Without `SILENT`, a filler turn came in 4 of 4 runs, and one was transcribed as `<!-- Waiting for information from Kokoro -->`. `NON_BLOCKING` was erratic: the call came 18 s late once, plus filler. | Blocking declarations, answered at once with `SILENT` (decision 10). |
| Tool schemas | `parameters` refused JSON Schema's `additionalProperties`. `parametersJsonSchema` took annai's schemas as they are. | gemini-live sends `parametersJsonSchema`. |
| Notes (question 2) | An **append** note, sent as a `clientContent` text turn after the turn ended, was said in Koe's own words, never naming notes or Kokoro, in 3 of 3 runs with blocking tools (the `NON_BLOCKING` run said it a turn late). An **immediate** note interrupted Koe mid-sentence in 76 ms (`interrupted`) in 4 of 4, and Koe corrected itself in 3 of 4, apologising in 2. `realtimeInput.text` interrupted too. | Notes are `clientContent` turns wrapped in `<from_kokoro>…</from_kokoro>` (K5). |
| Honesty and deferral | Live facts (hours, prices, drive times, weather, fees) were never stated: Koe said "I'm checking…" and called `tell_kokoro` in 14 of 14, spoken and typed. Stable facts (a bridge, a dish, a writer, why trees lean) were answered directly in 9 of 9. | The rule works as written; the Koe instructions below start from the spike's text. |
| Chatter (in-car talk not meant for Shiori) | With `proactivity.proactiveAudio` (only on `v1alpha`; `v1beta` refuses the field with 1007, though the docs say v1beta), Koe never spoke words to chatter (0 of 7), but 3 of 7 times sent 0.7–1.8 s of non-speech audio whose transcript was empty or markup. Without proactive audio, it spoke to chatter 1 time in 4. | `v1alpha` with proactive audio, falling back to `v1beta` on that 1007. Playback of a response starts only at its first real word (decision 11). |
| Transcript markup | Output transcripts sometimes held `<!-- … -->` or `<no speech>{pause}`. | Transcript hygiene before anything is logged (K5). |
| Photos | A JPEG in a `clientContent` turn (`inlineData`) was read correctly, and so was one sent as `realtimeInput.video`. | Photos go as `clientContent` turns, in order with text. |
| Resumption | A new connection with the handle remembered the conversation ("You asked about the restaurant Nepenthe."). | Handles are kept in memory, for the next open (K5). |
| Errors | Errors are close codes with reasons: 1007 for a bad field *and* for "API key not valid", 1008 for a model not found. | The plugin classifies by code *and* reason (K4). |
| Usage and cost | The first turn was about 950 prompt tokens (580 of them instructions and tools; audio at 25 tokens a second, as documented). The whole context is billed every turn: 2,105 prompt tokens after 8 turns. On the paid tier, gemini-3.8-live costs $0.75 / $3.00 per million input tokens (text / audio) and $4.50 / $12.00 output; the free tier on AI Studio is free. | Context-window compression on; realtime usage priced per turn and counted in Spend per day (K4, K5). |

### 2. A text Koe, and Kokoro behind it (question 4)

| What | Measured |
|---|---|
| Koe on gemini-3.5-flash-lite (Gemini's OpenAI-compatible endpoint, which is annai's provider-gemini path), tools `speak`, `tell_kokoro` and `sleep` | First spoken words in **478–756 ms** (7 of 7). Live facts deferred 4 of 4, and stable facts answered 3 of 3. |
| gemini-3.1-flash-lite with `reasoning_effort: none` | 2.3–6.9 s, one 24.5 s: too slow for Koe. |
| Streaming | Gemini's compatible endpoint sends a tool call's arguments in one piece, so `speak` doesn't stream sentence by sentence there. The replies are short anyway. |
| Kokoro on gemini-3.8-flash, with the heard words, what Koe said and Koe's question | 2–3 steps of 3.8–7.0 s each, so its note reaches Koe **about 10–13 s** after the question (model time, with a stubbed search). It caught Koe's wrong claim (a "1950s steel suspension bridge") with an **immediate** note. |
| The code gate | In 1 of 3 cases, Kokoro reached for `show` beside `tell_koe`. Instructions alone leak, as the design says. |
| An existing bug, found here | **Gemini 3 models with tools fail at their second step through Chat Completions.** Gemini requires each tool call's `extra_content.google.thought_signature` back, and annai's chat-completions plugin drops it: `400 Function call is missing a thought_signature`. Any Koe or Kokoro on Gemini 3 needs the fix first: **K1 Task 1**. |

### 3. Audio formats

| Provider path | Accepts (measured ✓, or documented) |
|---|---|
| Gemini, native `generateContent` | ogg (Opus) ✓, webm (Opus) ✓, m4a (AAC) ✓, aac (ADTS) ✓, mp3 ✓, flac ✓, wav ✓ |
| Gemini through Chat Completions (annai's provider-gemini) | **wav ✓ and mp3 ✓ only.** The rest get 400 "Valid formats are: [wav, mp3]". |
| OpenAI transcription (guide) | mp3, mp4, mpeg, mpga, m4a, wav, webm (no ogg or flac in the guide) |
| OpenAI chat `input_audio` | wav, mp3 |
| Groq transcription | flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm (bills at least 10 s) |
| OpenRouter `input_audio` | wav, mp3, aiff, aac, ogg, flac, m4a ("varies by provider") |
| Gemini Live | PCM16 at 16 kHz in; PCM16 at 24 kHz out |
| OpenAI Realtime | `audio/pcm` (24 kHz only), `audio/pcmu`, `audio/pcma` |

**Sizes**, from the same 3.3 s clip (per minute):

| Format | Per minute |
|---|---|
| Opus 24 kbps in Ogg | 175 KiB |
| Opus 24 kbps in WebM | 195 KiB |
| MP3 32 kbps | 243 KiB |
| AAC 32 kbps | 250–261 KiB |
| G.711 μ-law | 468 KiB |
| FLAC | 1209 KiB |
| WAV 16 kHz (today) | 1876 KiB |

**What the browsers make:**

| | Chromium 153 | WebKit 26.6 (Linux build) |
|---|---|---|
| MediaRecorder | `audio/webm;codecs=opus`, and `audio/mp4` (Opus inside), but not AAC. A real 1.2 s recording worked. | None at all |
| `AudioEncoder` | Opus only | Opus, AAC, MP3, FLAC, μ-law and A-law, all reported supported |
| Plays Ogg and WebM Opus | "probably" | "probably" |
| `AudioContext` at 16 and 24 kHz | Yes | Yes |
| `navigator.audioSession` | No | No (Safari on an iPhone has it) |

**The security policy:** today's `connect-src https: http://localhost:* http://127.0.0.1:*` **blocks `wss:`** in both browsers: Chromium reports a CSP violation, and WebKit throws `SecurityError`. With `wss: ws://localhost:* ws://127.0.0.1:*` added, both connect, to Gemini and to a stand-in on 127.0.0.1 (K4).

**OpenAI Realtime (documented only: no OpenAI key was available):**
- The address is `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1`. A browser authenticates with the subprotocols `["realtime", "openai-insecure-api-key.<key>"]`. The docs show an ephemeral key there and steer browsers to ephemeral tokens, which need a server annai doesn't have.
- Sessions last at most 60 minutes.
- gpt-realtime-2.1 costs $4 / $32 per million input tokens (text / audio) and $24 / $64 output; gpt-realtime-2.1-mini costs $0.60 / $10 and $2.40 / $20.
- OpenAI also documents a "GPT-Live API" (`wss://api.openai.com/v1/live/sessions`, `gpt-live-1`, $0.05 a minute) with a Responses model behind it, which resembles Koe and Kokoro. The user chose OpenAI Realtime, so K6 builds that. GPT-Live can be a later protocol plugin without changing this design.

### 4. What only an iPhone can show (device checks)

Each is in a milestone's iPhone list, and in docs/testing/device-checklist-koe.md:
- **Gemini Live from the Home Screen app:**
  - the WebSocket over cellular;
  - audio in and out after the unlock tap;
  - time to first audio on the road;
  - what a locked screen does to an open session, and whether the handle resumes it after unlocking.
- **What Safari 26 makes:** `AudioEncoder` codecs (expected Opus, AAC and FLAC; MP3 is unlikely on Apple), MediaRecorder types (`audio/mp4`), and whether Ogg Opus plays.
- **Bluetooth in the car:**
  - a session needs `play-and-record`, which is hands-free (low-quality) audio;
  - full-quality playback must return after the session closes;
  - echo: whether Koe's own voice through the car's speakers triggers the barge-in.
- **The silent switch and `navigator.audioSession` types** during a session.

---

## Global Constraints

- **Platform:** "annai stays browser-only and local-first. A realtime session connects straight from the phone with the user's own key, kept in secrets. There's no server to mint ephemeral tokens."
- **iPhone audio:** "sound starts only after a tap (the unlock), and the Home Screen app's background limits stay."
- **Spec rules that hold:**
  - §4.9: removing means removing, and everything stored is named;
  - §6.3: the context order for caching;
  - §7.1: Shiori talks to the user only through output tools, and her plain text is internal;
  - §15: keys and security;
  - §17: updates never land mid-trip.
- **The provider redesign is the base.** "Realtime models arrive as protocol plugins with a 'realtime voice' ability on their provider. The provider-security rules apply to their connections: the same origin, no redirects, the key only to the provider."
- **Anti-goals.** Each is a failure even if it works:
  - Koe stating facts, times, prices or directions it doesn't concretely know;
  - the inner debate leaking into the conversation;
  - a stall: silence while one half waits on the other;
  - breaking the prompt cache by changing tool definitions or the system instructions when modes change;
  - losing words: anything the user said, or Koe said aloud, missing from the conversation, the trip record or the recap;
  - costs that grow without the user seeing why.
- **The split is opt-in.** With no model in either Koe list, Shiori works exactly as today, at one call per message.
- **No imports across plugins** (provider plan): protocol plugins reach annai only through what they register and the helpers they're given.
- **Security policy:** `_headers` keeps `script-src 'self'`, no `innerHTML`, no `style` attributes. K4 adds `wss: ws://localhost:* ws://127.0.0.1:*` to `connect-src`, and nothing else.
- **Writes:** every write is one transaction (§4.2), with fingerprints computed before the transaction opens.
- **Shipped files:**
  - Every file under `src/` and `assets/` is in `sw.js` `SHELL` (a unit test checks).
  - Run `npm run stamp` after any shipped file changes, and `npm run catalog` after any `plugins-official/` change.
  - `plugins-official/` and `catalog/` are not in the shell.
- **Settings save as they change** (§16.1).
- **Copy:** plain words, and every error says what happened and what to do next. System cards are never in Shiori's voice.
- **Public repo:** no machine or tailnet addresses, and no keys, in code, tests, fixtures, plans, notes or commit messages.
- **Ports and the user's machines:**
  - Stand-ins listen on `127.0.0.1` port 0.
  - Never bind 8765, 8790–8799, 18010–18014, 3000, 3300, 8470–8473, 8481 or 8889 on the host.
  - Never touch the containers `annai-android` or `forgejo`.
  - E2e runs only in Docker, in its own network, never `--network host`.
- **Process** (annai's milestone process):
  - Each milestone is built on its own branch from main, with a git-ignored ledger at `.superpowers/sdd/koe-k<N>/progress.md` in its worktree.
  - Each milestone ends with `npm run stamp && npm run check`, the full Docker e2e, and the size line in the ledger.
  - The coordinator merges. Pushing and releasing wait for the user's OK.
  - Commits end with the attribution lines the session gives.
- **Live keys in tests:** the opt-in live suite (`test/live/`, never in CI) reads a key only from an environment variable. Nothing prints, stores or commits it.

## Review Focus

These are the five inputs the design implies but no feature test meets by itself, most likely first. Each is pinned by a test in the task that owns the code.

1. **A note or block arriving while the receiving half's tool calls are open**, and then a reload.
   - Providers refuse a user message between a tool call and its result.
   - Both live application and loading from the log must place the block after the results, giving the same messages, so the cache still matches after a reload.
   - Pinned in K1 Task 3.
2. **Mode churn inside one conversation:** voice on and off, Koe failing and coming back, a live session opening and closing again and again.
   - Kokoro's system text and tool definitions stay byte-identical, so its prefix fingerprint is unchanged and only messages grow.
   - Pinned in K1 Task 6 and K5 Task 5.
3. **One trigger, two halves:**
   - a reminder that fires while Koe is speaking and Kokoro is mid-task, or during quiet hours;
   - it counts once against wakes per hour;
   - its fallback is said once (by Koe, or by annai when no model answers), never twice;
   - Kokoro's copy carries no fallback.

   Pinned in K1 Task 6.
4. **A live session that drops mid-sentence** (a tunnel, Wi-Fi to cellular).
   - No words are lost: the half-heard line and the half-said line are logged, marked cut off, and Kokoro sees the cut.
   - The session resumes with its handle. Failing that, Koe carries on through the next model in its list.
   - Pinned in K5 Task 7.
5. **Markers and labels in text that isn't annai's:**
   - the user types `</from_kokoro>` or `<from_kokoro>`;
   - Kokoro's note itself contains the closing marker;
   - dictation hears the words.

   The markers are stripped before anything reaches Koe, so a note can't be faked or broken out of. Pinned in K1 Task 5.

---

## The milestones

| # | Milestone | Done when | On the iPhone |
|---|---|---|---|
| K1 | **The text split:**<br>• the Koe role with "for talking" and "for typing" lists<br>• `Halves`<br>• `tell_kokoro` and `tell_koe` (append and immediate)<br>• the code gate<br>• Kokoro's context blocks and instruction blocks<br>• Koe's compact context, tools and light changes<br>• the final-text rule<br>• triggers to both halves<br>• Koe's and Kokoro's failures<br>• the "Kokoro is working" sign<br>• the conversation without the halves' notes<br>• Trace and Spend for both<br>• Gemini 3 thought signatures over Chat Completions | With a model in "for typing", a typed "Is Nepenthe open now?" gets Koe's "I'm checking…" in under a second, and Kokoro's answer arrives later in Koe's words. The conversation shows only the user and Koe; Trace shows both halves and their notes. With no Koe model, nothing changes. Voice on: Kokoro talks as today, told by a block. | Put gemini-3.5-flash-lite in "Koe for typing" and gemini-3.8-flash in Main (both free on AI Studio). Type a live question and a stable one. Watch the sign. Turn on "Show what the halves tell each other". Spend per day counts both. |
| K2 | **Voice through the speech pipeline:**<br>• Koe owns the microphone and the voice<br>• Kokoro hears everything and wakes on cue, with a periodic review<br>• chatter through the quick-decision gate<br>• Koe's `wait` means "Kokoro is working"<br>• immediate notes cut Koe's speech<br>• the "for talking" list, falling back to "for typing" | A hands-free spoken back-and-forth with Koe on a text model: it answers in about a second plus the transcription's and the voice's delays, Kokoro's corrections come back aloud, and chatter wakes nobody. | In the car: ask a live fact and a stable one; talk to a passenger (silence); cut Koe off; wait for a correction. Bluetooth returns to music quality after she sleeps. |
| K3 | **Audio in the smallest format:**<br>• formats declared per ability (`audioIn`, `audioOut`)<br>• `AudioEncoder` with annai's Ogg, WebM, ADTS and FLAC muxers<br>• MediaRecorder next, WAV last<br>• lazy per-receiver encoding, the same bytes on a retry<br>• kept clips compressed<br>• speech out in the smallest format the device plays<br>• format and size in Trace | A heard segment goes to Groq as Opus (about a tenth of today's WAV), to Gemini through Chat Completions as WAV (or MP3 where the device makes it), and a voice comes back as Opus where the device plays it. A failed upload retries with identical bytes. | Trace shows which format each provider got from the iPhone, and how big. Settings → Voice's mic test works. Kept clips play back. |
| K4 | **The realtime contract and Gemini Live:**<br>• the `realtime` ability kind and protocol contract<br>• core session opening, guarded and traced<br>• the `gemini-live` plugin<br>• provider-gemini's Live ability<br>• the stand-in realtime server<br>• a streaming player and a live microphone<br>• `wss:` in the security policy<br>• Test for realtime models | Gemini's Live ability can be switched on, and its model passes Test (a session opens, says "OK" in audio with a transcript, and closes). The stand-in server proves the contract in both browsers. Keys appear in no trace. | Add Gemini Live with the free key, Test it: audio plays after the tap. Trace shows the session's opening and closing without the key. |
| K5 | **Koe live:**<br>• a realtime model as Koe, in voice and in typing<br>• sessions opened by voice, a tap, a trigger or a note; closed by voice off or a quiet spell<br>• resumption and GoAway; fallback when a session drops<br>• audio both ways with no silence streamed, barge-in, playback from the first real word<br>• tool calls answered at once<br>• notes as marked text turns<br>• both transcripts<br>• "Listening live"<br>• realtime cost in Spend | With Gemini Live as "Koe for talking", a drive's conversation runs in live sessions: Koe answers in about a second, defers live facts, says Kokoro's answers, corrects itself when told immediately, stays quiet to chatter, and the session closes after 30 s of quiet. | The car: the whole K5 list in the checklist, including a tunnel (the drop), a locked screen, a reminder that opens a session, and music quality after it closes. |
| K6 | **OpenAI Realtime:**<br>• the `openai-realtime` plugin (subprotocol key, manual turns)<br>• G.711 μ-law in, PCM out<br>• provider-openai's realtime ability<br>• Another address's realtime ability<br>• the stand-in's OpenAI flavour | A realtime OpenAI model works as Koe through the same contract, proven against the stand-in, and against OpenAI with the user's key by hand. | With an OpenAI key: Test, then a short drive's conversation; compare recognition with μ-law against PCM in a noisy car. |

**Why this order:**
- The design's order: the text split first, then voice through the speech pipeline, then Gemini Live, then OpenAI Realtime.
- Audio formats (K3) touch only the recording and speech side, so they run beside K1 and K2.
- The realtime contract (K4) is split from Koe's live pathway (K5), so the protocol, the stand-in and the player can be built beside K2. K5 then joins them to Koe.

### Running in parallel

**By files:**

| Milestone | Can run beside | Must follow | Files it shares (rebase) |
|---|---|---|---|
| K1 | K3, K4; provider M3, M5 | — | M4: `src/app/main.js`, `src/core/llm/fallback.js`, `src/core/llm/call.js`, and `plugins-official/chat-completions` (take the next free version). M6: `src/core/agent/loop.js`, `tools.js`, `contract.js`. M3: `src/ui/screens/models.js` (role names only), `sw.js`. |
| K2 | K3, K4 | K1 | M6: `loop.js` |
| K3 | K1, K2, K4; provider M3, M5, M6 | — | K1 and K2: one line in `loop.js` (`#logHeard`'s clip type), a few lines in `talk.js` and `trace.js`, and `sw.js`. K1: `chat-completions` (Task 1's signature; versions in turn). M4: `plugins-official/chat-completions` (the `audioIn` tunable). All: `catalog/plugins.json` (regenerate). |
| K4 | K1, K2, K3; provider M3, M5 | provider M4 and M6, or rebase onto them | M4 and M6: `src/core/plugins.js` (`providers.register`), `src/core/llm/contract.js`, `src/core/llm/service.js`, `src/ui/screens/provider.js`. K1: `src/core/llm/config.js`, `provider-desc.js` (role kinds), and `fallback.js` (K1's `candidates`, K4's `not-chat` skip). |
| K5 | K6 | K2, K4 | — |
| K6 | — | K4 (K5 for its e2e); provider M5 for Another address | `plugins-official/provider-another-address/annai-plugin.json` (M5's file) |

**Branch by branch:**
- **Provider M3** (the catalog screen: `src/core/search.js`, `src/ui/screens/add.js`, `plugins.js`, `models.js`, `backups.js`, `router.js`, `sw.js`, `test/e2e/helpers.js`): K1 adds role names to `models.js`'s `ROLE_NAMES` and its role order, a few lines away from M3's Add-a-provider changes. Whoever merges second rebases. Neither changes the other's helpers: K1 adds `koeSetUp` to `helpers.js` and leaves `addProvider` alone.
- **Provider M4** changes Chat Completions too: K1 Task 1 rebases onto it, and takes the next free minor version after whatever main has then (main has 0.5.0 today).
- **Provider M6** reserves "the agent loop's own tools". `tell_kokoro` and `tell_koe` are loop tools, so they're reserved without more work. K1 must pass M6's `owners.test.js` after a rebase.

---

## Decisions this plan makes

The design leaves these to the builder. Each line says why.

1. **One `Agent` class runs both halves, as two instances, and a `Halves` coordinator holds them.**
   - Kokoro is the main-role instance, as today.
   - Koe's text pathway is a second instance with `half: 'koe'`: its own role, system text, tools, conversation window and model.turn tag (`koe`).
   - `Halves` routes input, cues, notes, the gate and the blocks, and gives the screens Agent's surface.
   - Why:
     - the loop already holds everything a half needs: fallback, streaming `speak`, listening windows and turn-taking, the quick-decision gate, budgets, stuck detection, photo repair;
     - two instances keep two queues, so neither half ever waits on the other (anti-goal: a stall);
     - one shared lock or a merged queue would serialize them;
     - screens and plugins keep calling one object.
2. **The talking half logs what the user said and typed, and the other half observes it.**
   - Koe writes `msg.user` and `heard` as Shiori does today.
   - `Halves` passes each stored event to the other instance's `observe(e)`, which adds it to that half's transcript by the same rules `Transcript.load` uses.
   - Why: one writer per event, so nothing is logged twice. The same rules live and on load keep the cache identical after a reload.
3. **A block or note that arrives while tool calls are open waits for their results.** `Transcript.apply` holds a user-role block until every tool call of the last assistant message has a result, then adds it.
   - Why: providers refuse anything between a call and its result, and the rule depends only on event order, so loading from the log gives the same messages.
4. **The split is a configuration, not a mode.** Kokoro's Koe-aware instructions (`KOKORO_PART`) and its `tell_koe` tool are present exactly while a Koe list holds a model.
   - Voice on and off, Koe failing or coming back, and live sessions opening or closing change only messages: `halves` events, rendered as `[annai] …` blocks.
   - Why: the design ("Kokoro's tool list never changes"; instruction blocks as messages). Adding the first Koe model costs one cold cache, as changing the personality does.
5. **Koe's conversation is a window.** It holds the last 12 exchanges, and its start moves forward only in jumps of 6.
   - Koe has no housekeeping. Kokoro, which has the whole conversation, still compacts.
   - Why: Koe must stay small and fast ("compact context"), and a start that jumps keeps its cached prefix stable between jumps.
6. **Koe's compact view goes in its tail** (a `<today>` block after the now block), never in its prefix:
   - today's and tomorrow's plan, as TSV;
   - bookings within 48 hours;
   - the place and activity;
   - the time;
   - the next reminder.

   It is capped at 2,000 characters. Why: it changes every call; in the tail it doesn't break Koe's cache.
7. **The line for Koe's light changes:**
   - **Koe may:**
     - write or edit one note under `/trip/notes/` (creating or editing; never deleting);
     - add or cancel a reminder (`watch_set`, `watch_cancel`);
     - change one *flexible* plan item's `start`, `end`, `notes` or `priority` (`patch`);
     - add one new flexible plan item (`write` of a new `/trip/plan/*.json` with `fixed: false`).
   - **Everything else is Kokoro's:** deleting; bookings; `trip.json`; memory and personalities; fixed items; more than one file in a call; importing; fetching; spending.
   - A refused call answers "That's a bigger change: ask Kokoro with tell_kokoro."
   - Why: each allowed change is one file, undoable from its history (§4.2), and never touches a fixed commitment or money.
8. **Kokoro wakes on cue, plus a review every 3 minutes of conversation.**
   - The review is checked when a new line arrives (heard, typed or said by Koe), and only when at least one line came since Kokoro last ran. Silence costs nothing.
   - Why 3 minutes:
     - often enough to catch a request Koe took for chatter while it still matters on a drive;
     - rare enough that a chatty hour costs at most 20 reviews;
     - each review reads a cached prefix (the hour-long cache stays warm).
9. **Realtime input uses manual activity signals from annai's own detector.**
   - The detector already cuts speech at a 700 ms pause.
   - At speech start, annai sends `activityStart` with the detector's pre-roll; during speech, 100 ms chunks; at the cut, `activityEnd`. Silence is never streamed.
   - Why:
     - the design's first choice;
     - measured: the server's own detection needs silence streamed to end a turn;
     - manual signals answered in under a second.
10. **Every tool call from a live session is answered at once.**
    - `tell_kokoro` gets `{ result: "sent" }` with `scheduling: "SILENT"`.
    - Reads (`list`, `read`, offline places, `recall`, `watch_list`) answer with their result, which takes milliseconds.
    - `show` answers "shown"; `ask` answers "shown; their tap comes as their next turn".
    - Declarations stay blocking.
    - Why: measured. Without `SILENT`, the model added a filler turn every time, and once said "Kokoro" in it. `NON_BLOCKING` was erratic.
11. **Gemini Live uses `v1alpha` with proactive audio**, and falls back to `v1beta` without it on a 1007 "Unknown name proactivity".
    - A response's audio starts playing only at its first real word in the output transcript; a turn with none is dropped.
    - Why:
      - the design names Gemini's proactive audio for chatter;
      - measured: no spoken replies to chatter with it (0 of 7), against 1 in 4 without;
      - the non-speech blips it sometimes sent all had empty or markup transcripts, while real speech's first transcript text came with its first audio.
12. **A live session closes after 30 seconds of quiet** (no speech either way and no tool call). It's a setting: Settings → Voice → "Close a live session after", 10 to 300 seconds.
    - Why:
      - 30 s is longer than a pause in conversation (the turn-taking silence is 8 s);
      - short enough that the car's music returns to full Bluetooth quality soon;
      - the free tier isn't spent holding a session open;
      - the microphone isn't left open (privacy).
13. **Barge-in by voice is on, with a tap always cutting in.** While Koe plays, the detector needs a louder start (+6 dB over its floor) before it sends `activityStart`. A setting, "Cut her off by speaking", turns voice barge-in off, leaving the tap.
    - Why: realtime models are chosen for cutting in. A car's echo can trip it, so the margin and the switch are there until the device check settles it.
14. **Notes into a live session are `clientContent` text turns** wrapped in `<from_kokoro>…</from_kokoro>`.
    - An append waits until Koe's turn has ended *and* local playback has drained; an immediate note goes at once.
    - Text Koe sees the same markers.
    - Kokoro's blocks use plain labels: `[heard] …`, `[Koe said aloud] …`, `[Koe said] …`, `[Koe showed] …`, `[Koe asked] … (options)`, `[the user typed] …`, `[the user sent a photo]`, `[Koe asks] …`, `[Koe notes] …`, `[annai] …`.
    - A note from Koe is "asks" when its text ends with "?", and "notes" otherwise.
    - Why: measured to work, and one marker everywhere is one rule to strip.
15. **The code gate covers Kokoro's `speak`, `show`, `ask` and `wait` while Koe works.**
    - `speak`, `show` and `ask` become a `tell_koe` append:
      - `speak`: its text;
      - `show`: "Kokoro wants to show: <title> — <text>";
      - `ask`: "Kokoro wants to ask: <question> (<options>)".
    - The result is "Koe is speaking for you; use tell_koe."
    - `wait` answers "Koe is talking with the user; what they say reaches you. Call sleep when you're done."
    - Why: `wait` opens the microphone, which belongs to Koe.
16. **Fallback reminders go with the wake of the half expected to talk:** Koe, or Kokoro while Koe is down. Quiet hours and wakes-per-hour are checked once, in `Halves.wake`. Why: Review Focus 3.
17. **Kokoro's voice is off while Koe works.** Both instances share the one `Voice`; `Halves` lets only one own the microphone and speaker at a time.
    - Kokoro's `#voiceOn()` asks `half.voice()`, which is true only while Koe is down.
    - Only Kokoro's instance logs voice-mode changes.
    - Why: half-duplex rules hold for the speech pipeline, and the state log isn't doubled.
18. **K1 ships voice as "Koe types only for now".** In K1, a voice turn with a Koe model is Koe's failure path: the block "Koe can't speak aloud yet; talk to the user directly", and Kokoro talks as today. K2 removes it.
    - Why: K1 must ship with the app working. The failure path has to exist anyway, and is tested early.
19. **Koe roles are never filled when a provider is added**, only by "Use the recommended models" on a provider's page.
    - Why: "the split is opt-in". Adding Gemini must not turn it on.
20. **Kokoro's final text is passed to Koe once.**
    - It's passed when Kokoro's turn ends on a reply with text and no tool calls, and *no* call in the turn was `tell_koe` or `sleep`.
    - The note's `why` is `final-text`.
    - Why: the design's rule, made exact.
21. **Kokoro's error turns are told by Koe.**
    - When Kokoro's whole list fails, `Halves` sends Koe an append: "Kokoro couldn't check: <plain reason>. Tell the user you couldn't check, and offer to try again."
    - No system card is shown for it while Koe works.
    - Why: the design ("Koe tells the user it couldn't check, in plain words"); a card would say it twice.
22. **A photo goes to Koe only when Koe's model takes photos.**
    - Otherwise it's a text stub for Koe ("[the user sent a photo; Kokoro sees it]"), and Kokoro gets the photo.
    - Why: a model without image input would otherwise be skipped as a capability gap, which would read as "Koe failed".
23. **Formats are named by file kind:** `ogg`, `webm` (both Opus), `mp4`, `aac` (both AAC), `mp3`, `flac`, `wav`; and, for realtime, `pcm16`, `pcmu`, `pcma`.
    - annai's preference is by codec: Opus, then AAC, MP3, FLAC, WAV.
    - Within a codec, the provider's own order counts.
    - Why: providers name what they take by file kind, and the codec order is the design's.
24. **`AudioEncoder` comes first, MediaRecorder second, WAV last.**
    - Why `AudioEncoder`:
      - it encodes exactly the segment the detector cut, faster than real time;
      - one encoding can go into any container annai muxes;
      - it needs no second recorder on the stream.
    - MediaRecorder is used only where the encoder can't make a format the receiver takes (expected: an iPhone without WebCodecs audio). It then records between cuts, restarted every 2 s while nobody speaks, so a file starts at most 2 s before its speech.
25. **Segments keep 16 kHz 16-bit PCM in memory** (half today's float), and are encoded lazily, once per format.
    - A failed upload resends the cached bytes.
    - A kept clip is stored as the smallest format the device makes.
    - Why: each receiver takes different formats. Retrying the same bytes is the design's rule.
26. **OpenAI Realtime sends μ-law in and takes PCM out.**
    - Input `audio/pcmu` (8 kHz G.711) is 64 kbps against 384 kbps for `audio/pcm`, six times less. It's the telephony format OpenAI's own phone (SIP) integration feeds the same models.
    - Output stays `audio/pcm` at 24 kHz: Koe's voice in the car is what the user listens to, and it flows only while Koe speaks.
    - Both are tunables (`input`, `output`), and a device check compares recognition in a noisy car.
27. **OpenAI Realtime runs without server turn detection** (`turn_detection: null`): annai commits the buffer and asks for a response at its own cut, matching decision 9.
    - At 55 minutes, a fresh session starts with the compact context and the last exchanges, as OpenAI has no resume handle and caps sessions at 60 minutes.
28. **Resume handles live in memory only.** A reload starts a new session with the compact context.
    - Why: a handle resumes a conversation on the server, so it is treated like a credential. Nothing new is stored.
29. **A live Koe has no `speak`, `wait` or `sleep`.**
    - Why: it speaks natively, its turn ends by itself, and the "Kokoro is working" sign follows Kokoro's own state. Fewer tools also keep the session's setup small (the spike's setup was about 580 tokens).

---

## Shapes

### Roles (`/llm/roles.json`, src/core/llm/config.js)

- `KOE_ROLES = ['koe-talk', 'koe-type']`, shown as "Koe for talking" and "Koe for typing", right after Main. They're not `CHAT_ROLES` (which fall back to Main): an empty Koe list uses the other Koe list, and never Main.
- `ROLE_LEVELS['koe-talk'] = ROLE_LEVELS['koe-type'] = 'off'`, and Models suggests 8 s for their "Wait for the first words".
- `ROLE_KINDS` replaces `ROLE_KIND` (K1 with `['chat']` for the Koe roles; K4 widens them to `['chat', 'realtime']`): `{ main: ['chat'], utility: ['chat'], decide: ['chat'], 'koe-talk': [...], 'koe-type': [...], 'speech-in': ['transcription'], 'speech-out': ['voice'] }`.
- `koeList(cfg, voiceOn): string[]` (src/core/koe/path.js): voice on uses `koe-talk`, else `koe-type`; an empty list uses the other.
- `splitOn(cfg): boolean`: either Koe list has a model.

### Events (new types and fields)

| Event | Data | Notes |
|---|---|---|
| `note` | `{ id, from: 'koe' \| 'kokoro', mode: 'append' \| 'immediate', why: 'tool' \| 'gated:speak' \| 'gated:show' \| 'gated:ask' \| 'final-text' \| 'kokoro-failed' \| 'nothing-to-add', wake? }`, texts `[['text', …]]` | The halves' exchanges. In SAID, in Trace; out of the conversation view by default. |
| `halves` | `{ state: 'koe-down' \| 'koe-up' \| 'voice-later' \| 'live-open' \| 'live-closed' \| 'live-dropped', why? }`, texts `[['text', …]]` | Kokoro's instruction blocks. In SAID. |
| `out.speak`, `out.show`, `out.ask` | `+ half: 'koe'` when Koe made them; `+ live: true, cut?: true` for a live session's lines | Koe's lines are blocks in Kokoro's transcript. |
| `heard` | `+ source: 'live'`, `text` from the session's input transcript | |
| `tool.call`, `tool.result`, `wake` | `+ half: 'koe' \| 'kokoro'` while split | `wake` with `half: 'kokoro'` is hidden from the conversation view. |
| `model.turn` | tag `'koe'` for Koe; Kokoro keeps `'conversation'` (TALK_TAG) and adds `half: 'kokoro'` while split | Trace labels Koe, Kokoro or Shiori. |
| `live.session` | `{ state: 'open' \| 'ready' \| 'resumed' \| 'goaway' \| 'closed', model, ms, why?, kind?, bytesIn, bytesOut, turns, cost? }` | K4/K5. |
| `net.request` | `kind: 'realtime'`, `{ model, usage, cost, wake? }`, one per turn's usage report | Priced in Spend (`budgets.js` `priced`). |

### `Agent` as a half (src/core/agent/loop.js)

```js
/** @typedef {{ name: 'one' | 'kokoro' | 'koe', tag: string,
 *   roles(): Promise<{ role: string, models?: string[] }>,   // Kokoro: { role: 'main' }; Koe: { role: 'koe-type', models: [...] } from koeList
 *   system?(snapshot: Snapshot): string,                   // Koe's text; default systemText (+ KOKORO_PART while split)
 *   tail?(base: string): Promise<string>,                    // Koe: now block + <today> compact view
 *   registryTools: boolean,                                  // Koe false: only its loop tools
 *   voice(): boolean,                                        // may it use the mic and speaker now
 *   gate?(call: { id, name, input, wake }): Promise<ToolOutput | null>,   // Kokoro's output tools while Koe works
 *   ended?(t: TurnEnd): void, logVoice: boolean, window?: number }} Half
 * @typedef {{ wakeId: string, ok: boolean, finalText: string, told: boolean, slept: boolean, spoke: boolean, reasons: string[] }} TurnEnd */
```

- **New members:**
  - `observe(e)`: another writer's event, added by this half's rules, once.
  - `cutIn()`: aborts the model call in flight (a per-call `AbortController`, not the turn's) or stops the speech playing, and lets the turn go on with what is queued.
  - `admit(w): Promise<boolean>`: the quiet-hours and wakes-per-hour checks, moved out of `wake()`.
  - A wake may carry `logged: true`, meaning its user lines are in the log already, so `#logWakes` writes only the `wake` event.
- **`#applyTurn`** finds this half's own `model.turn` by tag and wake, never "the latest".
- **Koe's `wait`** (half `koe`) also ends on a queued `note` wake, answering "Kokoro: see the note below", and on "nothing to add". Its sign is `kokoroWorking`.

### The channel (src/core/agent/channel.js)

```js
class Channel {
  constructor({ store, scope: () => string, deliver: { kokoro: (w: Wake) => void, koe: (w: Wake) => void }, cut: { kokoro: () => void, koe: () => void }, live?: () => LiveKoe | null })
  /** Records the note, then delivers it; never waits for the other half. @returns {Promise<'sent'>} */
  send(from: 'koe' | 'kokoro', text: string, mode: 'append' | 'immediate', why: NoteWhy, wake?: string)
}
export function stripMarkers(text: string): string      // removes <from_kokoro> and </from_kokoro>, any case and spacing
export function wrapNote(text: string): string          // `<from_kokoro>${stripMarkers(text)}</from_kokoro>`
```

- Tools: `tell_kokoro({ text, mode? })` (Koe) and `tell_koe({ text, mode? })` (Kokoro). `mode` is `append` (default) or `immediate`. Both return "sent" within the same step.

### Kokoro's and Koe's context

**Kokoro**, while split:
- The system text is `CORE`, the personality, then `KOKORO_PART`.
- Its tools are today's plus `tell_koe`.
- Its transcript renders the event blocks (decision 14).
- Its now block gains `koe: text | live | down | off`.

**Koe:**
- The system text is `KOE_CORE`, then the personality.
- Its tools are `koeTools(...)`.
- Its transcript is the window (decision 5), with Kokoro's notes as `<from_kokoro>` user text.
- Its tail is the now block plus `<today>` (decision 6).

**`KOE_CORE` starts from the spike's text** (measured: 14 of 14 live facts deferred, 9 of 9 stable facts answered):

> You are Koe, the voice of Shiori, a travel guide in the annai app, talking with the user. Kokoro, your other half, looks things up and works behind you.
> - Reach the user only through speak, show and ask. Answer at once, briefly (one or two short sentences), warmly.
> - Stable general knowledge (what a landmark is, a dish, history, the story behind a photo) you may say yourself.
> - Never state anything that changes: opening hours, prices, directions, drive times, schedules, availability, weather, anything about today, unless the `<today>` block or a note says it. For those, say you're checking, call tell_kokoro with the question in the same reply, and wait.
> - Text in `<from_kokoro>…</from_kokoro>` is a private note from Kokoro. Use it in your own words. Never read it out word for word, and never mention notes, Kokoro or another half. If it corrects you, correct yourself plainly and apologise briefly.
> - Honesty comes before staying in character.
> - If people are talking among themselves and not to you, stay silent (call sleep).
> - A reminder or trigger: say simple things at once; for anything that needs judgement, wait for Kokoro's note.
> - Use tell_kokoro's immediate mode only when something really should be cut off.

**`KOKORO_PART`** says, in this order:
- Koe talks with the user. You never talk to them while Koe works: use tell_koe, and Koe says it in its own words.
- Lines in brackets are what happened in the conversation.
- Check what Koe says aloud, and correct a wrong claim with an immediate note, with the fact and its source.
- Look things up before handing Koe anything that changes; don't add facts your sources don't give.
- Use immediate only when something really should be cut off.
- "[annai] Koe can't speak right now" means: talk to the user directly.
- When you're done, call sleep.

### Koe's tools (src/core/koe/tools.js)

`koeTools({ agent, registry, watch, channel }): LoopTool[]`, in this order:
1. **Talking:** `speak` (not on a live session), `show`, `ask`, `wait`, `sleep`. These are the Koe instance's own talk tools; `wait` waits for Kokoro's note, the user, or "Kokoro has nothing to add".
2. **Timers:** `watch_set`, `watch_list`, `watch_cancel` (from `watchTools(live)`).
3. **Self:** `recall` (from `selfTools(agent)`).
4. **Reads:** `list` and `read` (the files plugin's, by name at call time); `nearby` and `guide` with `call.offline = true` (pack only).
5. **Light changes:** `write`, `edit` and `patch`, wrapped by `lightChange(name, input, ctx): Promise<string | null>` (the reason it's refused, or null).
6. **`tell_kokoro`.**

A switched-off tool (Settings → Tools) is off for both halves.

### The realtime contract (K4; src/core/llm/contract.js, docs/plugins.md)

```js
/** @typedef {{ format: 'pcm16' | 'pcmu' | 'pcma', rate: number }} AudioFormat
 * @typedef {object} RealtimeType   // registered with annai.providers.register, its ability kind 'realtime'
 * @property {string} type @property {string} name @property {true} realtime
 * @property {Record<string, any>} [tunables]
 * @property {{ in: AudioFormat[], out: AudioFormat[] }} audio      // what it sends and takes, preferred first
 * @property {(c: { endpoint: Endpoint, model: Model, key: string | null, tunables: Record<string, any> }) => { url: string, protocols?: string[] }} open
 * @property {(socket: WebSocket, c: { endpoint, model, tunables, setup: LiveSetup, emit: (e: LiveEvent) => void, helpers }) => LiveDriver} attach
 * @property {(code: number, reason: string) => ErrorKind | null} [classifyClose]
 * @typedef {{ instructions: string, context: string, tools: ToolDef[], resume?: string, audioIn: AudioFormat, audioOut: AudioFormat }} LiveSetup
 * @typedef {{ ready: Promise<void>, audio(chunk: Uint8Array): void, activity(edge: 'start' | 'end'): void,
 *   text(t: string, o: { interrupt: boolean }): void, image(i: { mediaType: string, data: string }): void,
 *   answer(id: string, name: string, output: string, o: { silent: boolean }): void, cancel(): void, close(): void }} LiveDriver
 * @typedef {{ type: 'audio', data: Uint8Array } | { type: 'heard' | 'said', text: string, final: boolean }
 *   | { type: 'tool', id: string, name: string, input: any } | { type: 'turn', end: 'complete' | 'interrupted' }
 *   | { type: 'usage', usage: Partial<Usage> } | { type: 'resume', handle: string } | { type: 'goaway', ms: number }} LiveEvent */
```

- **annai opens the socket.** `openLive()` checks that `open()`'s URL has the origin of the ability's address (`https` maps to `wss`, and `http` on localhost to `ws`), then opens it.
  - A WebSocket can't follow a redirect, so "no redirects" holds by itself.
  - Close codes are read with `classifyClose`, then annai's defaults (1008 and "not found" are `not-found`; "quota" and RESOURCE_EXHAUSTED are `rate`; 1011 is `server`; any other close is `network`).
  - The key is added to the trace's secrets, and the URL and subprotocols are never traced.
- **Usage gains `audioIn` and `audioOut`** (tokens). **Prices gain `audioIn` and `audioOut`** (USD per million tokens), and `costOf` counts them.

### Audio formats (K3; tunables)

| Tunable | On | Default (protocol plugin) | Overridden in |
|---|---|---|---|
| `audioIn: string[]` | Chat types (for "Send audio to the model") and transcription types | chat-completions `['wav', 'mp3']`; openai-transcription `['webm', 'mp4', 'mp3', 'wav']` | OpenRouter chat `['ogg', 'aac', 'mp4', 'mp3', 'flac', 'wav']`; Groq transcription `['webm', 'ogg', 'mp4', 'mp3', 'flac', 'wav']`; local speech `['webm', 'ogg', 'mp4', 'mp3', 'flac', 'wav']`; Gemini (compatible) keeps `['wav', 'mp3']` |
| `audioOut: string[]` | Voice types | openai-speech `['opus', 'aac', 'mp3', 'flac', 'wav']` (OpenAI's `response_format`) | OpenRouter voice `['mp3', 'opus', 'wav', 'flac']` |
| `format` | openai-speech | `'auto'`: the first of `audioOut` the device plays, in annai's order | the user, per ability or model |

- **Platform:** `platform.encoder = { makes(): Promise<string[]>, encode(pcm: Int16Array, rate: number, format: string): Promise<Uint8Array> }`, and `platform.player.plays(): string[]`.
- **Choosing:** `pickFormat(accepts: string[], makes: string[]): string | null`, and `pickOut(offers: string[], plays: string[]): string | null` (src/core/voice/formats.js).

---

## Testing

### Stand-ins (automated)

- **Two scripted providers** (provider-scripted, added twice) are Koe and Kokoro in unit and e2e tests. Each uses `rules` that match its own "woke for:" line ("the user wrote", "Koe asks: …", "a note from Kokoro").
- **`test/fakes/realtime-server.js`** (K4) is a WebSocket server of annai's own (handshake, framing, masking, close codes) on `127.0.0.1` port 0.
  - Flavours are `gemini` (K4) and `openai` (K6).
  - It answers a scripted turn when an activity or a text turn ends. A turn can hold input and output transcripts, 24 kHz PCM from a fixture, a tool call, `interrupted`, a `goAway`, a resume handle and usage.
  - It records every message it receives, and can close with a code and reason.
  - Unit tests reach it with Node's `WebSocket`. E2e tests reach it from the page at `ws://127.0.0.1:<port>`: WebKit can't route a service-worker-controlled page's requests, so stand-ins run on their own ports.
- **The fake microphone** (`fakeMicrophone` in helpers.js) feeds K2's and K5's e2e. A realtime session's input is asserted on the stand-in's received messages: `activityStart`, audio, `activityEnd`, and never audio during silence.
- **Browser suites** (`test/browser/suites/`) check `AudioEncoder` and the muxers' output by decoding it back (K3), and the streaming player (K4), in both browsers.

### The real services (by hand, never in CI)

- `test/live/gemini-live.test.js` (K4) and `test/live/openai-realtime.test.js` (K6) run only with `GEMINI_KEY` or `OPENAI_KEY` in the environment. They open a session, send a synthesized clip, and check audio, transcripts and a tool call.
- A spike result that a provider changes (proactive audio's endpoint, `scheduling`) shows up here first.

### Commands

- Unit: `node --test test/unit/<file>.test.js`; all: `npm test`. Types: `npm run typecheck`. Everything: `npm run stamp && npm run check`.
- E2e, from the worktree:

  ```bash
  docker run --rm --ipc=host -v "$PWD":/work -v "$(readlink -f node_modules)":"$(readlink -f node_modules)":ro -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test --workers=4 [spec]
  ```

---

## Risks

1. **The size budget.**
   - It is 1673 KiB, with 0 room. Provider M3 adds 10–14, M4 saves 8–12, M5 adds 1 and M6 adds 5–8.
   - Each milestone reads `npm run size` first, and raises `BUDGET` once at its end by what it added, with the reason appended to the comment, as the project does.

   | Milestone | KiB | What |
   |---|---|---|
   | K1 | +30 to +38 | halves.js, channel.js, blocks, koe/ (instructions, context, tools, path), loop.js and transcript.js changes, the sign, the conversation toggle, Trace labels |
   | K2 | +6 to +10 | voice ownership, cues and review in halves.js, `cutIn` while speaking |
   | K3 | +10 to +14 | formats.js, Ogg/WebM/ADTS/FLAC muxers, the encoder and MediaRecorder segmenter in voice-browser, lazy encoding |
   | K4 | +8 to +12 | the realtime session in core, the streaming player and stream resampler, the live input; the protocol plugins aren't in the shell |
   | K5 | +14 to +20 | LiveKoe (sessions, notes, tools, transcripts, the quiet spell), the chip, Trace lines |
   | K6 | +1 to +2 | G.711; the plugin isn't in the shell |

   - About +70 to +95 KiB in all, honestly raised in six steps.
   - **If a raise is refused:** LiveKoe and the realtime session core (about 25 KiB) can move into an official on-demand plugin, installed when a realtime model is first put in a Koe list (a setup action, so nothing downloads at call time). The plan doesn't do this by default, because it adds an install path to the voice code.
2. **Cache stability.**
   - Kokoro's prefix must not change with modes (decision 4). K1 Task 6 asserts byte-identical system text and tools, and an equal `prefixFingerprint`, across voice on and off, Koe down and up, and K5's live open and close.
   - Koe's own cache is helped by the window jumping (decision 5) and the compact view in the tail (decision 6).
   - Gemini Live bills the whole context every turn (measured), so context-window compression is on.
3. **The code gate.**
   - It's enforced where tools run (`#runCall` asks `half.gate`), never in instructions alone. Measured: Kokoro reached for `show` 1 time in 3.
   - The gate decides by whether Koe works *now*, read at run time. A reply that spans Koe going down runs the rest of its calls ungated, which is right.
   - The gate's notes are `note` events, so nothing is lost.
4. **WebKit in e2e.**
   - `page.route` can't intercept a service-worker-controlled page's requests, so every stand-in (model servers and the realtime server) runs on a port of its own. The CSP change (K4) is what lets the page reach `ws://127.0.0.1:*`.
   - Playwright's WebKit has no MediaRecorder: the MediaRecorder path is tested in Chromium and as unit tests with a fake recorder.
   - WebKit's Linux `AudioEncoder` reports codecs a real iPhone may not have. The device check decides what ships first on iPhone; the code always probes at run time.
5. **iPhone audio rules.**
   - Sound starts only after a tap. A session opened by a trigger or a note can speak only if this page has been unlocked since it loaded. Otherwise annai shows the reminder card and Koe's words as a bubble, and the next tap speaks them.
   - A session needs `play-and-record`: hands-free audio over Bluetooth for its whole life. Hence the quiet spell (decision 12), and `playback` restored at close.
   - A locked screen freezes the page. The session is expected to die, to be resumed with its handle at the next tap within 2 hours (device check).
   - Echo in a car can trip voice barge-in (decision 13).
6. **Spike results that may shift.**
   - Proactive audio needs `v1alpha` today (decision 11's fallback).
   - `scheduling: SILENT` is honoured today: it's in the live suite.
   - The free tier's limits aren't documented: 4 concurrent sessions and about 40 in a day were fine.
   - gemini-3.8-flash allows 5 requests a minute on the free tier: Kokoro on it will hit 429 on busy minutes, and its fallback list should hold a second model.
7. **OpenAI Realtime is unverified against the real service** (no key here). K6 is built against the docs and the stand-in, and its device check needs the user's OpenAI key. Whether a standard key is accepted as a browser subprotocol is the first thing to check.
8. **Data on the road.**
   - A live session sends about 340 kbps while the user speaks (base64 PCM at 16 kHz), and receives about 510 kbps while Koe speaks (24 kHz). That's roughly 3.8 MB for a minute of Koe's speech.
   - Trace shows each session's bytes, so the cost in data is visible.
   - Whether the browser and Google negotiate WebSocket compression wasn't measurable from Node (none was negotiated there): a device check reads the bytes on the phone.
9. **Rebases with provider M4 and M6** (see "Running in parallel").

### Questions only the user can answer

None block the build; each has a stated choice.
1. **An OpenAI key for K6's device check.** Without one, OpenAI Realtime ships tested only against the stand-in (risk 7). The plan goes ahead and lists the check.

---

# Milestone K1: The text split

## File structure

```
src/core/agent/halves.js            new: Halves, the coordinator and the app's agent object
src/core/agent/channel.js           new: Channel, stripMarkers, wrapNote
src/core/agent/blocks.js            new: Kokoro's block for an event; labels; asks-or-notes
src/core/agent/loop.js              Half options; observe, cutIn, admit; logged wakes; #applyTurn by tag; gate hook; TurnEnd
src/core/agent/transcript.js        per-half rules; held blocks; the Koe window; SAID gains note, halves, out.*
src/core/agent/context.js           nowBlock's koe line; buildRequest takes a system text and an extra tail
src/core/agent/log.js               KOE_TAG
src/core/agent/self-tools.js        task never offers tell_kokoro or tell_koe
src/core/agent/tools.js             ALWAYS_ON gains the tell tools
src/core/koe/instructions.js        new: KOE_CORE, KOKORO_PART
src/core/koe/context.js             new: compactView
src/core/koe/tools.js               new: koeTools, lightChange
src/core/koe/path.js                new: koeList, splitOn
src/core/llm/config.js              KOE_ROLES in roles.json; ROLE_LEVELS
src/core/llm/reasoning.js           Koe roles' level off
src/core/llm/fallback.js            candidates: Koe roles use the other Koe list, never Main
src/core/llm/provider-desc.js       ROLE_KINDS (arrays)
src/core/llm/providers.js           Koe roles filled only on the recommended tap
src/core/llm/contract.js, call.js   tool_call parts keep `extra` and the model that wrote it
plugins-official/chat-completions/  Gemini's thought signature back with its call
src/plugins/places/index.js         call.offline: the pack only
src/app/main.js                     Kokoro, Koe and Halves
src/ui/screens/models.js            the Koe lists after Main
src/ui/dock.js, src/ui/shiori.css   the "Kokoro is working" sign, with Stop
src/ui/screens/talk.js              notes hidden by default; "Show what the halves tell each other"
src/ui/screens/trace.js             Koe, Kokoro or Shiori on turns; note and halves lines
sw.js, scripts/size.mjs, catalog/plugins.json
test/unit/…                         llm-chat-completions, llm-contract, koe-roles, halves-transcript, agent-half, channel, halves, halves-kit, koe-tools, koe-context, after-recap
test/e2e/koe.spec.js, helpers.js (koeSetUp)
docs: the main spec, docs/plugins.md, docs/testing/device-checklist-koe.md
```

### Task 1: Gemini 3 tool calls through Chat Completions

**Files:**
- Modify: `src/core/llm/contract.js` (Part `tool_call` gains `extra?: any` and `model?: string`; `portable()` drops `extra` unless `model` matches the receiver)
- Modify: `src/core/llm/call.js` (a `tool_call` stream event's `extra` goes into the reply's part, stamped with `model.providerId`)
- Modify: `plugins-official/chat-completions/index.js` (reads `tool_calls[].extra_content` from deltas and whole replies; `wire()` sends it back on that call)
- Modify: its manifest (next free minor version), and `catalog/plugins.json` (`npm run catalog`)
- Test: `test/unit/llm-chat-completions.test.js`, `test/unit/llm-contract.test.js`

**Interfaces:**
- Produces: `{ type: 'tool_call', id, name, input, extra?, model? }`. The protocol event is `{ type: 'tool_call', id, name, input, extra? }`.

- [ ] **Step 1: Write the failing tests**

```js
test("a tool call's extra_content (Gemini's thought signature) comes back on that call in the next request", async () => {
  // stream: delta tool_calls[0] = { id: 'c1', function: { name: 'read', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig' } } }
  // next request's assistant message: tool_calls[0].extra_content deep-equals { google: { thought_signature: 'sig' } }
});
test('a whole JSON reply keeps extra_content too', async () => { … });
test('portable() drops a tool call\'s extra for another model, keeps it for the one that wrote it', () => {
  const m = [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'a', name: 'x', input: {}, extra: { s: 1 }, model: 'gemini-3.8-flash' }] }];
  assert.deepEqual(portable(m, 'gpt-6-luna')[0].parts[0].extra, undefined);
  assert.deepEqual(portable(m, 'gemini-3.8-flash')[0].parts[0].extra, { s: 1 });
});
```

- [ ] **Step 2: Run** `node --test test/unit/llm-chat-completions.test.js test/unit/llm-contract.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** as above. The transcript stores the parts as they are, so a reload sends the signature again.
- [ ] **Step 4: Run them**, and `npm run catalog`. Expected: PASS.
- [ ] **Step 5: Commit.** "Chat Completions sends a tool call's extra_content back with it, so Gemini 3 models can take a second step with tools (the spike found every one failing at its second step)".

### Task 2: The Koe role and its two lists

**Files:**
- Create: `src/core/koe/path.js`
- Modify: `src/core/llm/config.js` (`KOE_ROLES`; `rolesFrom` keeps them), `src/core/llm/reasoning.js`, `src/core/llm/fallback.js` (`candidates`), `src/core/llm/provider-desc.js` (`ROLE_KINDS`; `checkProviderDesc` accepts Koe roles in `roles`), `src/core/llm/providers.js` (`suggested` skips Koe roles unless `o.koe`; `useSuggestion` passes `koe: true`), `src/ui/screens/models.js` (`ROLE_NAMES`, the order `main, koe-talk, koe-type, utility, decide, speech-in, speech-out`, the filter by `ROLE_KINDS`)
- Test: `test/unit/koe-roles.test.js` (new), `test/unit/llm-providers.test.js`, `test/e2e/koe.spec.js` (new)

**Interfaces:**
- Produces: `KOE_ROLES`, `ROLE_KINDS`, `koeList(cfg, voiceOn): string[]`, `splitOn(cfg): boolean`.
  - `candidates(cfg, 'koe-talk')` is its own list, else `koe-type`'s, else `[]`. It never falls back to Main.
- Words:
  - Koe for talking: "Koe for talking: answers you at once when voice is on".
  - Koe for typing: "Koe for typing: answers you at once when you type".
  - The empty line under both: "Empty: Shiori is one half, the main model. Add a fast model here to give her a quick voice in front."

- [ ] **Step 1: Write the failing tests**

```js
test('an empty Koe list uses the other Koe list, never Main; both empty: no split', () => {
  // roles: main [m1], koe-talk [], koe-type [k1] → candidates koe-talk = [k1]; koe-type [] and koe-talk [] → [], splitOn false
});
test('koeList follows voice: on → koe-talk, off → koe-type, each falling back to the other', () => { … });
test('roles.json keeps the Koe roles at level off; a saved file without them reads them as empty', async () => { … });
test('adding a provider whose description recommends Koe models fills Main but no Koe list; "Use the recommended models" fills them', async () => { … });
// koe.spec.js (both browsers)
test('Models shows Koe for talking and Koe for typing right after Main, each taking chat models', async ({ page }) => { … });
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them**, with `llm-config`, `llm-providers` and `models.spec.js`. Expected: PASS.
- [ ] **Step 5: Commit.** "The Koe role: lists for talking and for typing, each falling back to the other and never to Main; never filled when a provider is added".

### Task 3: Two transcripts from one log

**Files:**
- Create: `src/core/agent/blocks.js`
- Modify: `src/core/agent/transcript.js`, `src/core/agent/log.js` (`KOE_TAG = 'koe'`)
- Test: `test/unit/halves-transcript.test.js` (new), `test/unit/agent-transcript.test.js`

**Interfaces:**
- Produces:
  - `new Transcript({ half: 'one' | 'kokoro' | 'koe' })`, and `Transcript.load(store, scope, { half, window? })`.
  - **Rules by half:**
    - `one`: today's.
    - `kokoro`:
      - its own `model.turn` (TALK_TAG) and the tool results of its calls;
      - `msg.user` as `[the user typed] …` when `data.split`, plain otherwise, and photos as `[the user sent a photo]` plus the image;
      - `heard` as today;
      - Koe's `out.*` as blocks;
      - `note` from Koe as "[Koe asks]" or "[Koe notes]";
      - `halves` as `[annai] <text>`;
      - wakes with `half: 'koe'` ignored.
    - `koe`:
      - its own `model.turn` (KOE_TAG) and tool results with `half: 'koe'`;
      - `msg.user`, `heard`, `heard.text`;
      - `note` from Kokoro as `<from_kokoro>…</from_kokoro>`;
      - live lines (`out.speak` with `live`) as `[you said aloud] …`;
      - wakes with `half: 'kokoro'` ignored;
      - the window (decision 5).
  - **Held blocks** (decision 3).
  - `blockFor(e, texts): string | null`, `asksOrNotes(text): 'asks' | 'notes'`.

- [ ] **Step 1: Write the failing tests**

```js
test("Kokoro's transcript: the user typed, heard, Koe said aloud, Koe showed, Koe asked, and Koe's questions, as labelled blocks", async () => {
  // log: msg.user {split} "Is Nepenthe open?"; out.speak {half:'koe', voice:true} "I'm checking."; note {from:'koe'} "Is Nepenthe open now?"
  // kokoro.messages user text includes "[the user typed] Is Nepenthe open?", "[Koe said aloud] I'm checking.", "[Koe asks] Is Nepenthe open now?"
});
test("Koe's model turns and tool results never enter Kokoro's transcript; Kokoro's never enter Koe's", async () => { … });
test("Koe's transcript has Kokoro's notes wrapped in <from_kokoro>, and only its last 12 exchanges, its start moving in jumps of 6", async () => { … });
test('a note that arrives while tool calls are open waits for their results, live and when loaded from the log alike (Review Focus 1)', async () => {
  // model.turn with tool_call x; note; tool.result x → messages: assistant[call], user[result, note]; Transcript.load gives deepEqual messages
});
test("a conversation from before the split reads exactly as it did ('one' and 'kokoro' alike, with no split events)", async () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/halves-transcript.test.js test/unit/agent-transcript.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `SAID` gains `note`, `halves`, `out.speak`, `out.show` and `out.ask`. `one` ignores `out.*` as today, since they live inside its own model turns.
  - Kokoro's housekeeping (`compact()` in loop.js) counts exchanges by its own wakes only, never Koe's (`half: 'koe'`).
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** "One log, two transcripts: Kokoro reads the conversation as labelled blocks, Koe a window with Kokoro's notes; a block never lands between a tool call and its result".

### Task 4: Agent as a half

**Files:**
- Modify: `src/core/agent/loop.js`, `src/core/agent/context.js` (`buildRequest({ system?, … })`, and `nowBlock({ koe })`)
- Test: `test/unit/agent-half.test.js` (new); `test/unit/agent-loop.test.js` and every `agent-*.test.js` stay green unchanged

**Interfaces:**
- Consumes: Task 3's `Transcript` by half.
- Produces: the `Half` option and the new members in "Shapes". The default half is `{ name: 'one', tag: TALK_TAG, roles: async () => ({ role: 'main' }), registryTools: true, voice: () => true, logVoice: true }`.

- [ ] **Step 1: Write the failing tests**

```js
test("a half with registryTools false offers only its own loop tools, and calls the models roles() gives", async () => { … });
test('cutIn during a model call cancels that call only; the turn goes on, and the next call sees the queued note', async () => {
  // scripted step 1 delayMs 500; at 100 ms queue a 'note' wake and cutIn(); assert the second request's last user text includes the note; one turn
});
test('cutIn while speak plays stops the voice at that point; the turn goes on', async () => { … });
test('observe adds another writer\'s event once, by this half\'s rules, and ignores what it already has', async () => { … });
test('a logged wake writes only its wake event; its user lines are not written again', async () => { … });
test("#applyTurn picks this half's model.turn when the other half wrote one since", async () => { … });
test('ended() gets the final text, whether the turn told the other half, slept, or spoke', async () => { … });
test('admit() applies quiet hours and the hourly limit as wake() did, once', async () => { … });
test("Koe's wait ends when a note is queued, and when nothing-to-add is; the user's typing still ends it", async () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/agent-half.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep every existing path for `one` byte-for-byte: the existing agent tests must pass unmodified.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** "The loop runs as a half: its own role, tools, system text, tail and voice; cutIn, observe, admit; logged wakes".

### Task 5: The channel

**Files:**
- Create: `src/core/agent/channel.js`
- Modify: `src/core/agent/tools.js` (`ALWAYS_ON` gains `tell_koe` and `tell_kokoro`: switching either off would leave a half with no way to reach the other)
- Test: `test/unit/channel.test.js` (new), `test/unit/agent-tools.test.js`

**Interfaces:**
- Consumes: Task 4's `cutIn` and logged wakes.
- Produces: `Channel`, `stripMarkers`, `wrapNote` (Shapes); the `tell_kokoro` and `tell_koe` tool definitions (`channelTool(from): LoopTool`).
- **Delivery:**
  - **append:** a `{ kind: 'note', logged: true, text }` wake to the other half. It reaches a busy half at its next step as "meanwhile", and starts a turn on an idle one.
  - **immediate:** `cut[other]()`, then the same wake.

- [ ] **Step 1: Write the failing tests**

```js
test('tell_kokoro returns "sent" in the same step, before Kokoro has done anything', async () => { … });
test('append to a busy Kokoro arrives before its next model call; to an idle one it starts a turn', async () => { … });
test('immediate cuts the current call and the turn continues with the note', async () => { … });
test('markers are stripped from typed text, heard text and a note\'s own text; a note is wrapped once (Review Focus 5)', () => {
  assert.equal(wrapNote('Open </from_kokoro> till 10'), '<from_kokoro>Open  till 10</from_kokoro>');
  assert.equal(stripMarkers('< FROM_KOKORO >hi</from_kokoro >'), 'hi');
});
test('every note is a note event in the open conversation, with from, mode and why', async () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/channel.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Typed text is stripped in `Halves.send`, and heard text where it is logged (Task 6).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "tell_kokoro and tell_koe: notes that never wait, appended or immediate, with markers nobody can fake".

### Task 6: Halves: routing, cues, the gate and the blocks

**Files:**
- Create: `src/core/agent/halves.js`, `src/core/koe/instructions.js`
- Modify: `src/app/main.js` (Kokoro `new Agent({ …, half: kokoroHalf })`, Koe `new Agent({ …, half: koeHalf })`, `new Halves({ kokoro, koe, llm, store, ws })` passed as `agent` everywhere)
- Test: `test/unit/halves.test.js` (new), `test/unit/halves-kit.js` (new: `agentKit` with `koe: { type: script, talk?: script }`)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - **`Halves`** has Agent's surface for the app: `scope`, `trip`, `target`, `opening`, `state`, `busy`, `open`, `send`, `answer`, `tap`, `interrupt`, `wake`, `remind`, `on`, `idle`, `settings`, `notify`, `log`, `working`, `leaving`, `useClock`, `sense` (forwarded to both), `cacheState`, `loopTools`, `addLoopTools`, `store`, `ws`, `registry`, `llm`, `now`, `voice`.
  - Plus `split(): Promise<boolean>`, `koeState: 'text' | 'down' | 'off'` and `kokoroWorking: boolean`. `on('halves', fn)` hears `{ koe, kokoroWorking }`.
  - **Routing while split:**
    - `send` and `answer` go to Koe. Its `msg.user` is logged with `split: true`, and Kokoro observes it and wakes ("the user wrote", "the user sent a photo").
    - `wake(w)`: `kokoro.admit(w)`, then both halves get it, the fallbacks going with the talking half (decision 16).
    - `tap` and `interrupt` go to Koe.
    - Kokoro's turn ends: if `!told` and Koe waits, Koe gets `why: 'nothing-to-add'`. With a `finalText` (decision 20), a `final-text` note goes to Koe.
    - Koe's tell_kokoro wakes Kokoro ("Koe asks").
    - Koe's turn ends with `spoke` after typed input: Kokoro wakes ("Koe answered the user"), if not already awake for it.
  - **`gate`** (decision 15), active while `koeState === 'text'`.
  - **Koe's failures:** Koe's `AllFailedError` gives `koe-down` (a `halves` event, "Koe can't speak right now; talk to the user directly"); its next answer gives `koe-up` ("Koe is speaking again; use tell_koe"). Voice on, in K1, gives `voice-later` (decision 18).
  - **Kokoro's failures:** decision 21.
  - With no Koe model, every call goes to Kokoro unchanged.

- [ ] **Step 1: Write the failing tests**

```js
test('no Koe model: one call per message, Kokoro speaks, exactly as before', async () => { … });
test('a typed question: Koe answers at once and asks Kokoro; Kokoro\'s context has "[the user typed]" and "[Koe said]"; its tell_koe reaches Koe, who says it', async () => { … });
test("the code gate: Kokoro's speak, show and ask while Koe works aren't run; each is a tell_koe append; the result says use tell_koe; no out.* from Kokoro", async () => { … });
test('Koe\'s whole list fails: a "Koe can\'t speak" block, and Kokoro\'s speak runs; Koe answers again: a "speaking again" block', async () => { … });
test("Kokoro's list fails: Koe gets a note and tells the user it couldn't check; no card", async () => { … });
test('final text: passed to Koe when the turn told no one and never slept; text beside tool calls is not', async () => { … });
test("Kokoro sleeps without telling while Koe waits: Koe's wait ends with nothing to add", async () => { … });
test('one trigger, two halves: admitted once, counted once against the hour, its fallback said once and only by the talking half (Review Focus 3)', async () => { … });
test("Kokoro's system text and tool definitions are byte-identical across voice on/off and Koe down/up; only messages grow (Review Focus 2)", async () => {
  // capture request.system, request.tools and prefixFingerprint before and after each change: deepEqual
});
test("typed text with <from_kokoro> reaches Koe stripped (Review Focus 5)", async () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/halves.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**, with `KOE_CORE` and `KOKORO_PART` (Shapes).
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** "Halves: Koe talks and Kokoro thinks; input to both, Kokoro woken on cue, its output tools gated in code, and its instructions changed only by messages".

### Task 7: Koe's compact context and tools

**Files:**
- Create: `src/core/koe/context.js`, `src/core/koe/tools.js`
- Modify: `src/plugins/places/index.js` (`call.offline`: the pack only, else "Not in the offline pack; ask Kokoro."), `src/core/agent/self-tools.js` (`task` leaves out `tell_*`), `src/app/main.js` (`koe.addLoopTools(koeTools(…))`)
- Test: `test/unit/koe-tools.test.js` (new), `test/unit/koe-context.test.js` (new), `test/unit/plugin-places.test.js`

**Interfaces:**
- Produces:
  - `compactView({ ws, trip, now, timeZone, place, activity, nextReminder }): Promise<string>`, giving `<today>…</today>` of at most 2,000 characters.
  - `koeTools(…)` and `lightChange(…)` (Shapes, decision 7).

- [ ] **Step 1: Write the failing tests**

```js
test("Koe's tools are exactly: speak, show, ask, wait, sleep, watch_set, watch_list, watch_cancel, recall, list, read, nearby, guide, write, edit, patch, tell_kokoro", async () => { … });
test('light changes: a note, a reminder, a flexible item moved, one new flexible item: done; a fixed item, a booking, trip.json, memory, a delete: refused with "ask Kokoro"', async () => { … });
test("Koe's places tools never fetch (a fetch spy sees nothing); off the pack they say so", async () => { … });
test('the compact view: today\'s plan, bookings within 48 hours, the place, the time and the next reminder, under 2,000 characters, in the tail', async () => { … });
test("a photo reaches Koe only when its model takes photos; otherwise a stub, and Kokoro gets the photo", async () => { … });
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** "Koe's compact view and quick tools: device reads, offline places and light changes; everything bigger is Kokoro's".

### Task 8: The screens, Trace and Spend

**Files:**
- Modify: `src/ui/dock.js`, `src/ui/shiori.css` (a small chip beside the dock's label: "Kokoro is working", and a **Stop** button that stops only Kokoro's turn, shown while `kokoroWorking`)
- Modify: `src/ui/screens/talk.js` (Kokoro's `wake`, `note` and `halves` events and errors are hidden; a toggle at the foot, "Show what the halves tell each other", remembered on this device, shows notes as quiet lines)
- Modify: `src/ui/screens/trace.js` (turns labelled Koe, Kokoro or Shiori; lines for `note` and `halves`; a Kind filter "Halves")
- Modify: `sw.js`
- Test: `test/e2e/koe.spec.js`, `test/e2e/helpers.js` (`koeSetUp(page, origin)`: two scripted providers, Koe and Kokoro), `test/unit/after-recap.test.js`, `test/unit/agent-budgets.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// koe.spec.js, both browsers
test('a typed question: Koe\'s bubble at once, the "Kokoro is working" sign, then Koe\'s answer from Kokoro; the conversation shows only you and Koe', async ({ page }) => { … });
test('Trace shows both halves\' turns and their notes; the toggle shows the notes in the conversation', async ({ page }) => { … });
test("the sign's Stop ends Kokoro's turn and leaves Koe", async ({ page }) => { … });
// unit
test('the recap reads what the user and Koe said, never the notes (anti-goal: losing words)', async () => { … });
test("Spend per day counts both halves' turns, and stops either at the budget", async () => { … });
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec in both browsers, with `shiori.spec.js` and `trace.spec.js`. Expected: PASS.
- [ ] **Step 5: Commit.** "The conversation shows you and Koe; Trace shows both halves and their notes; a sign says Kokoro is working, and stops it".

### Task 9: Spec, docs, checklist, finish

- [ ] **Spec:**
  - §6: wakes to both halves, Kokoro's work log, the notes, the final-text rule.
  - §6.3: each half's context, and instruction blocks as messages.
  - §7.1–7.2: output tools by half, the code gate, `tell_koe` and `tell_kokoro`, the tool split.
  - §9.6: the Koe role with its two lists.
  - §11: triggers to both halves.
  - §16: the sign, and the conversation without the halves' exchanges.
- [ ] **docs/plugins.md, "Tools Shiori uses":** a plugin's tools are Kokoro's while Shiori is two halves. Koe has annai's own set, and reaches Kokoro for the rest.
- [ ] **Device checklist:** create `docs/testing/device-checklist-koe.md` with its "K1" section (the milestone table's iPhone column).
- [ ] **Finish:** `npm run size`, raise `BUDGET` by what K1 added (the reason in the comment), `npm run stamp && npm run check`, the full Docker e2e, commit.

---

# Milestone K2: Voice through the speech pipeline

## File structure

```
src/core/agent/halves.js            voice ownership; heard to Kokoro; cues; the review timer; voice-later goes
src/core/agent/loop.js              cutIn mid-speech continues; Koe's wait resolves on a note, the user, or nothing-to-add
src/core/koe/path.js                koeList by the voice mode now
test/unit/halves-voice.test.js, test/e2e/koe-voice.spec.js
docs: the main spec §6.1, §10; the checklist's K2
```

### Task 1: Koe owns the voice

**Files:**
- Modify: `src/core/agent/halves.js`, `src/core/agent/loop.js`
- Test: `test/unit/halves-voice.test.js` (new)

**Interfaces:**
- `koeHalf.voice()` is true while split, and Koe works. `kokoroHalf.voice()` is true only while Koe is down (decision 17).
- `tap()` goes to Koe. Koe's roles are `koeList(cfg, voice.on)` at each turn.

- [ ] **Step 1: Write the failing tests**

```js
test('voice on: Koe speaks and listens with the speech pipeline; Kokoro never opens the microphone', async () => { … });
test("only the 'for typing' list set and voice on: that model talks, through the speech pipeline", async () => { … });
test('Koe down with voice on: Kokoro speaks aloud as Shiori does today', async () => { … });
test('voice mode changes are logged once', async () => { … });
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Remove decision 18's `voice-later` path.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** "Koe talks and listens through the speech pipeline; Kokoro's voice only when Koe can't".

### Task 2: Kokoro hears everything and wakes on cue

**Files:**
- Modify: `src/core/agent/halves.js`
- Test: `test/unit/halves-voice.test.js`

**Interfaces:**
- **Heard lines,** dismissed ones too, reach Kokoro's transcript as Koe logs them.
- **Cues:**
  - Koe asks;
  - Koe answered heard speech (its turn after a non-dismissed `heard` had an output tool);
  - the user typed or sent a photo;
  - a trigger;
  - the review (decision 8, `REVIEW_MS = 180_000`).
- Chatter alone wakes nobody.

- [ ] **Step 1: Write the failing tests**

```js
test("chatter (the gate says not for Shiori) goes into both transcripts and wakes neither", async () => { … });
test('a heard question Koe answers wakes Kokoro once, with "[heard]" and "[Koe said aloud]" in its context', async () => { … });
test('the review: after 3 minutes of conversation Kokoro hasn\'t seen, the next line wakes it; silence never does', async () => { … });
test('the words of what was heard are written down once, after Koe\'s turn, and Kokoro\'s transcript gets them', async () => { … });
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** "Kokoro hears all and wakes on cue, with a review every 3 minutes of talk; chatter costs nothing".

### Task 3: Waiting for Kokoro, and notes while Koe speaks

**Files:**
- Modify: `src/core/agent/loop.js` (Koe's `wait`), `src/core/agent/halves.js`
- Test: `test/unit/halves-voice.test.js`, `test/e2e/koe-voice.spec.js` (new)

**Interfaces:**
- **With voice on, Koe's `wait`** (K1 Task 4) also listens. It ends on whichever comes first:
  - Kokoro's note;
  - the user speaking or typing;
  - nothing to add;
  - the time limit.
- Meanwhile the sign shows, and the user can keep talking.
- **An immediate note while Koe speaks:** `cutIn()` stops the utterance at the sentence playing, then Koe's next call has the note.
- **An append:** goes before Koe's next call, or starts a Koe turn that speaks, then listens, while voice is on.

- [ ] **Step 1: Write the failing tests**

```js
test("with voice on, Koe's wait listens: Kokoro's note ends it and Koe says it aloud; the user speaking first ends it too", async () => { … });
test('an immediate correction cuts Koe mid-sentence; Koe corrects itself; the cut point is in its speak result', async () => { … });
// koe-voice.spec.js, both browsers, fake microphone with two clips
test('spoken: a live question gets "checking" aloud, then the answer aloud; a passenger\'s chatter gets silence; the conversation shows heard lines and Koe\'s', async ({ page }) => { … });
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them**, with `voice-talk.spec.js` and `voice-modes.spec.js`. Expected: PASS.
- [ ] **Step 5: Commit.** "Koe waits for Kokoro without stalling the user, and Kokoro can cut Koe off mid-sentence to correct it".

### Task 4: Spec, checklist, finish

- [ ] **Spec:** §6.1 (wakes: Kokoro on cue and the review); §10 (the pathways: Koe through the speech pipeline; Kokoro's voice only when Koe can't).
- [ ] **Device checklist:** "K2" (the milestone table's iPhone column, in the car).
- [ ] **Finish:** size and budget, check, the full Docker e2e, commit.

---

# Milestone K3: Audio in the smallest format

## File structure

```
src/core/voice/formats.js           new: FORMATS, CODEC_ORDER, pickFormat, pickOut, mediaTypeOf
src/core/voice/mux.js               new: oggOpus, webmOpus, adts, flacFile (pure)
src/core/voice/recorder.js          segments keep Int16 PCM at 16 kHz; WAV made only on demand
src/core/voice/resolve.js           per receiver: the format its ability takes, encoded once, cached; same bytes on retry
src/core/voice/voice.js             encode(kept, accepts); kept clip in the smallest format
src/core/voice/platform.js          Encoder and plays() in the VoicePlatform type
src/core/llm/speech.js              the trace's format and bytes
src/core/agent/loop.js              #logHeard keeps the compressed clip
src/plugins/voice-browser/index.js  encoder (AudioEncoder + mux), MediaRecorder segments, player.plays()
plugins-official/speech-openai/     audioIn and audioOut tunables; format 'auto'
plugins-official/chat-completions/  audioIn tunable (input_audio formats)
plugins-official/provider-openrouter, -groq, -local-speech, -vllm, -gemini, -openai   audioIn and audioOut, as data
src/ui/screens/talk.js, trace.js    a clip's type; format and size
test/unit/audio-formats.test.js, audio-mux.test.js, voice-resolve.test.js, voice-recorder.test.js, speech-openai.test.js
test/browser/suites/audio-codecs.js, test/e2e/voice-parts.spec.js
```

### Task 1: Formats and the choice

**Files:**
- Create: `src/core/voice/formats.js`
- Test: `test/unit/audio-formats.test.js` (new)

**Interfaces:**
- `CODEC_ORDER = [['ogg', 'webm'], ['mp4', 'aac'], ['mp3'], ['flac'], ['wav']]`.
- `pickFormat(accepts, makes): string | null`: the first codec group, in annai's order, with a format in both lists, choosing within a group by the provider's order.
- `pickOut(offers, plays)`: the same, for what a voice returns and the device plays.
- `mediaTypeOf(format)`: `ogg` → `audio/ogg`, `webm` → `audio/webm`, `mp4` → `audio/mp4`, `aac` → `audio/aac`, `mp3` → `audio/mpeg`, `flac` → `audio/flac`, `wav` → `audio/wav`.

- [ ] **Step 1: Write the failing tests**

```js
test('Groq on a phone that makes Opus: ogg or webm by Groq\'s order; Gemini through Chat Completions: wav, or mp3 where the phone makes it', () => {
  assert.equal(pickFormat(['webm', 'ogg', 'mp4', 'mp3', 'flac', 'wav'], ['ogg', 'webm', 'wav']), 'webm');
  assert.equal(pickFormat(['wav', 'mp3'], ['ogg', 'webm', 'wav']), 'wav');
  assert.equal(pickFormat(['wav', 'mp3'], ['ogg', 'webm', 'aac', 'mp3', 'flac', 'wav']), 'mp3');
});
test('nothing in common gives wav when the receiver takes it, else null', () => { … });
test('speech out: opus where the device plays it, else aac, else mp3', () => { … });
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "Audio formats by file kind, chosen in annai's codec order: Opus, AAC, MP3, FLAC, WAV".

### Task 2: annai's muxers, and the browser's encoders

**Files:**
- Create: `src/core/voice/mux.js`
- Modify: `src/plugins/voice-browser/index.js` (`encoder.makes()`: what `AudioEncoder.isConfigSupported` says for Opus, `mp4a.40.2`, MP3 and FLAC at 16 kHz mono, plus MediaRecorder's types; `encoder.encode(pcm, rate, format)`; `mic.open({ record })`: a MediaRecorder on the same stream, cut at each segment (decision 24); `player.plays()` from `canPlayType`)
- Modify: `src/core/voice/platform.js` (types)
- Test: `test/unit/audio-mux.test.js` (new), `test/browser/suites/audio-codecs.js` (new)

**Interfaces:**
- `oggOpus(packets: Uint8Array[], { rate, preSkip, channels }): Uint8Array`, with RFC 7845 pages, granule positions, and Ogg's own CRC (polynomial 0x04C11DB7, not the zip CRC).
- `webmOpus(packets, { rate, frameMs }): Uint8Array`: EBML, one track, SimpleBlocks in one cluster.
- `adts(frames, { rate, channels }): Uint8Array`.
- `flacFile(description, frames): Uint8Array`: `fLaC` plus STREAMINFO from the encoder's description.

- [ ] **Step 1: Write the failing tests**

```js
test('an Ogg Opus file: OggS pages with valid CRCs, OpusHead then OpusTags, granule positions at 48 kHz, the last page marked end', () => { … });
test('a WebM Opus file: EBML header, DocType webm, one audio track A_OPUS, blocks in time order', () => { … });
test('ADTS frames carry the right length and sample-rate index; FLAC starts fLaC with STREAMINFO', () => { … });
// browser suite, both browsers
test('each format the encoder says it makes decodes back with decodeAudioData to about the same length', async () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/audio-mux.test.js` and the browser suite (`browser-suites.spec.js`). Expected: FAIL.
- [ ] **Step 3: Implement.** Before committing, check a muxed file with `ffprobe` by hand, and note the result in the ledger.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** "The phone encodes speech itself: AudioEncoder into annai's own Ogg, WebM, ADTS and FLAC files; MediaRecorder where it can't".

### Task 3: Each receiver gets its smallest format, once

**Files:**
- Modify: `src/core/voice/recorder.js`, `src/core/voice/resolve.js`, `src/core/voice/voice.js`, `src/core/llm/speech.js`, `src/core/agent/loop.js` (`#logHeard`), `src/ui/screens/talk.js`, `src/ui/screens/trace.js`
- Test: `test/unit/voice-resolve.test.js`, `test/unit/voice-recorder.test.js`, `test/unit/agent-voice.test.js`

**Interfaces:**
- A segment's `audio` is `{ data, mediaType, seconds }` in the smallest format the device makes, so a kept clip and the default sending use it.
- `kept.pcm` (an `Int16Array` at 16 kHz) is kept for other formats. `kept.encoded: Map<string, Uint8Array>` is filled once per format.
- `Resolve` gains `accepts(modelOrAsr): string[]` (the ability's `audioIn`) and `encode(kept, format): Promise<{ data, mediaType }>`.
- Speech-in trace entries gain `format` and `bytes`.

- [ ] **Step 1: Write the failing tests**

```js
test('a segment goes to Groq as webm and to a Gemini chat model as wav, each encoded once however many attempts', async () => { … });
test('a failed transcription retries with the identical bytes', async () => { … });
test('a kept clip is stored as the smallest format the device makes, named by its heard event (§4.9)', async () => { … });
test("the trace says each clip's format and size", async () => { … });
```

- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** "Speech goes to each provider in the smallest format both sides handle, encoded once; retries send the same bytes; kept clips stay compressed".

### Task 4: Speech out, and the providers' declarations

**Files:**
- Modify: `plugins-official/speech-openai/index.js` (`audioIn` on openai-transcription; `audioOut` and `format: 'auto'` on openai-speech; `speechRequest` gets the chosen format through `tunables.format`, resolved by annai from `pickOut(audioOut, plays)`)
- Modify: `plugins-official/chat-completions/index.js` (`audioIn: ['wav', 'mp3']`; `AUDIO` gains `audio/webm` → `webm`, `audio/mp4` → `m4a`)
- Modify: `src/core/llm/speech.js` (resolves `format: 'auto'`)
- Modify: provider descriptions (Shapes table)
- Modify: `catalog/plugins.json`
- Test: `test/unit/speech-openai.test.js`, `test/unit/official-providers.test.js`, `test/e2e/voice-parts.spec.js`

- [ ] **Step 1: Write the failing tests**

```js
test("format auto asks OpenAI for opus when the device plays Ogg Opus, mp3 when it plays only mp3", () => { … });
test('every official transcription and chat ability declares audioIn; every voice declares audioOut', () => { … });
// voice-parts.spec.js: Trace shows a test clip's format (webm in Chromium; what WebKit makes in WebKit)
```

- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** "Voices answer in the smallest format the phone plays; every provider says what audio it takes and gives".

### Task 5: Spec, docs, checklist, finish

- [ ] **Spec:**
  - §10: formats, the choice, the encoders, retries;
  - §10.2: clips kept compressed;
  - §4.9: clips are named as before.
- [ ] **docs/plugins.md:** "Audio formats": `audioIn` and `audioOut` on abilities and protocols, the format names, and how annai chooses.
- [ ] **Device checklist:** "K3": on the iPhone,
  - what `AudioEncoder` makes (Trace → Diagnostics shows `encoder.makes()`);
  - MediaRecorder's types;
  - which format each provider got, and how big;
  - whether a kept clip plays;
  - whether OpenAI's Opus voice plays.
- [ ] **Finish:** size and budget, check, the full Docker e2e, commit.

---

# Milestone K4: The realtime contract and Gemini Live

## File structure

```
src/core/llm/provider-desc.js, config.js   ABILITY_KINDS + 'realtime'; ROLE_KINDS for Koe: chat and realtime
src/core/llm/contract.js            RealtimeType, LiveSetup, LiveDriver, LiveEvent (types); default close kinds
src/core/llm/cost.js                Usage audioIn/audioOut; Prices audioIn/audioOut
src/core/plugins.js                 providers.register accepts realtime types (open + attach)
src/core/realtime/open.js           new: openLive(…) → LiveSession (origin check, socket, trace, usage, bytes)
src/core/realtime/input.js          new: StreamResampler; LiveInput (detector → activity + chunks; no silence)
src/core/llm/service.js             live(modelId, setup, o); test() for realtime models
src/plugins/voice-browser/index.js  player.stream(); mic frames for live input
src/ui/screens/provider.js          a realtime ability's panel ("Live voice"), its models and Test
_headers                            connect-src gains wss: ws://localhost:* ws://127.0.0.1:*
plugins-official/gemini-live/       new protocol plugin
plugins-official/provider-gemini/   a 'live' ability (off), gemini-3.8-live and -extended-thinking, recommended koe-talk
test/fakes/realtime-server.js       new
test/unit/fake-realtime-server.test.js, realtime-open.test.js, gemini-live.test.js, live-input.test.js, llm-cost.test.js
test/browser/suites/live-player.js, test/e2e/realtime-test.spec.js, test/live/gemini-live.test.js
```

### Task 1: The stand-in realtime server

**Files:**
- Create: `test/fakes/realtime-server.js`
- Test: `test/unit/fake-realtime-server.test.js` (new)

**Interfaces:**
- `startRealtimeServer({ flavour: 'gemini' | 'openai', turns: Turn[], key?: string, closeWith?: { code, reason }, cors?: … })` gives `{ origin: 'http://127.0.0.1:<port>', ws: 'ws://127.0.0.1:<port>', received: () => any[], stop() }`.
- `Turn = { heard?, said?, audio?: Uint8Array (24 kHz PCM), tool?: { name, args }, goAway?: number, handle?: string, usage?, interruptOn?: 'text' | 'activity' }`.
- In the `gemini` flavour:
  - `setupComplete` comes after a valid `setup`;
  - a wrong key gets 1007 "API key not valid";
  - an unknown model gets 1008;
  - a `clientContent` text, or `activityEnd`, plays the next turn;
  - an `activityStart` or a `clientContent` during a turn gives `interrupted`.

- [ ] **Step 1: Write the failing tests:** "it speaks the Gemini Live flavour: setup, a turn on activityEnd, interrupted on activityStart, 1007 for a wrong key, and it records what it got".
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** (no dependencies: the handshake's `Sec-WebSocket-Accept`, masked client frames, text frames, close frames). **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "A stand-in realtime server of annai's own, for Gemini Live's protocol".

### Task 2: The realtime ability and opening a session

**Files:**
- Create: `src/core/realtime/open.js`
- Modify: `src/core/llm/provider-desc.js`, `src/core/llm/config.js` (the `kind` enum), `src/core/llm/contract.js`, `src/core/llm/cost.js`, `src/core/plugins.js` (`providers.register`: `realtime: true` with `open` and `attach` is a valid type), `src/core/llm/service.js` (`live(modelId, setup, { scope, wake })`: resolve, key, trace, `openLive`; benches the model on `auth`, `rate` and `server`), `src/core/llm/fallback.js` (`callRole` skips realtime types as `not-chat`)
- Test: `test/unit/realtime-open.test.js` (new), `test/unit/llm-cost.test.js`, `test/unit/provider-desc.test.js`

**Interfaces:**
- `openLive({ type, endpoint, model, key, tunables, setup, trace, socket = (url, protocols) => new WebSocket(url, protocols), now }): LiveSession`.
  - `LiveSession` = `LiveDriver` plus `on(fn)`, `bytes: { in, out }`, and `closed: Promise<{ code, reason, kind }>`.
  - It writes `live.session` open, ready and closed events, and a priced `net.request` of kind `realtime` per usage report.

- [ ] **Step 1: Write the failing tests**

```js
test('a session opens only at its ability\'s origin (https → wss, http localhost → ws); another origin is refused, never opened', async () => { … });
test('the key is in no live.session or net.request entry, nor the URL or subprotocols traced', async () => { … });
test('close codes become kinds: 1007 "API key not valid" auth, 1008 not-found, quota rate, 1011 server, anything else network', async () => { … });
test('realtime usage is priced by audioIn and audioOut and counted in Spend per day', async () => { … });
test('callRole skips a realtime model as not-chat; a chat role never sends it a request', async () => { … });
```

- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** "Realtime voice is an ability kind; annai opens its sessions itself: the provider's origin only, the key never traced, costs counted".

### Task 3: The gemini-live protocol plugin

**Files:**
- Create: `plugins-official/gemini-live/annai-plugin.json` (`provides: { "endpoint-type": ["gemini-live"] }`, version 0.1.0), `plugins-official/gemini-live/index.js`
- Test: `test/unit/gemini-live.test.js` (new), `test/live/gemini-live.test.js` (new, opt-in)

**Interfaces:**
- Tunables: `{ apiVersion: 'v1alpha', proactive: true, voice: '', compression: true }`.
- `audio: { in: [{ format: 'pcm16', rate: 16000 }], out: [{ format: 'pcm16', rate: 24000 }] }`.
- `open()` builds `wss://<host>/ws/google.ai.generativelanguage.<apiVersion>.GenerativeService.BidiGenerateContent?key=<key>`.
- **`attach()` sends `setup`:**
  - `model: models/<id>`, `generationConfig.responseModalities: ['AUDIO']` (and `speechConfig` when a voice is set);
  - `systemInstruction`: the instructions plus the context;
  - `tools: [{ functionDeclarations }]`, each with `parametersJsonSchema`;
  - `realtimeInputConfig.automaticActivityDetection.disabled: true`;
  - `inputAudioTranscription: {}` and `outputAudioTranscription: {}`;
  - `sessionResumption: { handle? }`;
  - `contextWindowCompression: { slidingWindow: {} }`;
  - `proactivity: { proactiveAudio: true }` on v1alpha.
- **It maps:**
  - `serverContent.modelTurn` `inlineData` to `audio`;
  - `inputTranscription` to `heard`, and `outputTranscription` to `said`;
  - `turnComplete` and `interrupted` to `turn`;
  - `toolCall` to `tool`, and `goAway` to `goaway`;
  - `sessionResumptionUpdate` to `resume`, when resumable;
  - `usageMetadata` to `usage` (prompt and response details by modality into `input`/`audioIn` and `output`/`audioOut`).
- **Driver methods:**
  - `audio`: `realtimeInput.audio` (`audio/pcm;rate=16000`, base64);
  - `activity`: `activityStart` and `activityEnd`;
  - `text`: a `clientContent` turn with `turnComplete: true`;
  - `image`: `clientContent` `inlineData`;
  - `answer`: `toolResponse.functionResponses[{ id, name, response: { result }, scheduling: silent ? 'SILENT' : undefined }]`.
- **The fallback:** a 1007 naming `proactivity` reconnects once on `v1beta` without it (decision 11).

- [ ] **Step 1: Write the failing tests** (against the stand-in)

```js
test('setup: instructions, tools as parametersJsonSchema, manual activity, both transcripts, resumption, compression, proactive audio on v1alpha', async () => { … });
test('a tool answer carries scheduling SILENT; a text turn is clientContent with turnComplete', async () => { … });
test('usage by modality becomes input, output, audioIn and audioOut', async () => { … });
test('a 1007 about proactivity reconnects once on v1beta without it', async () => { … });
```

- [ ] **Step 2: Run** `node --test test/unit/gemini-live.test.js`. Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS. Then, with a key in the environment only: `GEMINI_KEY=… node --test test/live/gemini-live.test.js`.
- [ ] **Step 5: Commit.** "Gemini Live as a protocol plugin: manual turns, both transcripts, silent tool answers, resumption and compression".

### Task 4: The streaming player and the live microphone

**Files:**
- Create: `src/core/realtime/input.js`
- Modify: `src/plugins/voice-browser/index.js` (`player.stream({ rate, onLevel }): { push(pcm: Int16Array): void, end(): void, stop(): { playedMs: number }, done: Promise<{ playedMs }> }`: Web Audio buffers scheduled back to back on the one unlocked context)
- Modify: `src/core/voice/platform.js`
- Test: `test/unit/live-input.test.js` (new), `test/browser/suites/live-player.js` (new)

**Interfaces:**
- `new StreamResampler(from, to).push(pcm: Float32Array): Int16Array`, with filter state kept across chunks.
- `new LiveInput({ mic, detector options, send: { activity(edge), audio(bytes) }, preRollMs: 300, chunkMs: 100, bargeInDb: 6, speaking: () => boolean })`: `start(): Promise<void>`, `stop(): void`.

- [ ] **Step 1: Write the failing tests**

```js
test('2 s of speech in 30 s of quiet: activityStart, the pre-roll and 100 ms chunks, activityEnd at the cut, and nothing in the silence', async () => { … });
test('the resampler gives the same samples chunk by chunk as all at once (within 1e-3)', () => { … });
test('while Koe plays, a start needs 6 dB more over the floor', async () => { … });
// browser suite: pushed chunks play gaplessly; stop() reports what was played
```

- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** "A live microphone that streams only speech, and a player for audio that arrives in bursts".

### Task 5: Gemini's Live ability, Test, the security policy

**Files:**
- Modify: `plugins-official/provider-gemini/annai-plugin.json` (2.0.0):
  - ability `live`: `{ kind: 'realtime', type: 'gemini-live', name: 'Live voice', on: false, baseUrl: 'https://generativelanguage.googleapis.com', note }`;
  - models `gemini-3.8-live` (`contextWindow: 128000`; prices `input: 0.75`, `audioIn: 3`, `output: 4.5`, `audioOut: 12`) and `gemini-3.8-live-extended-thinking`;
  - `roles.recommended['koe-talk'] = ['gemini-3.8-live']`;
  - `requires` unchanged (the ability starts off: it brings gemini-live when switched on).
- Modify: `src/core/llm/service.js` (`test(modelId)` for realtime: open, the text turn "Say OK.", expect `said` and `audio` within 10 s, close; records `verified.live`)
- Modify: `src/ui/screens/provider.js` (a realtime ability's panel is the standard one; its model rows show "Live voice")
- Modify: `_headers`
- Modify: `catalog/plugins.json`
- Test: `test/unit/headers.test.js`, `test/unit/official-providers.test.js`, `test/e2e/realtime-test.spec.js` (new)

- [ ] **Step 1: Write the failing tests**

```js
test("the security policy allows wss: and ws: to localhost and 127.0.0.1, nothing more", () => { … });
// realtime-test.spec.js, both browsers: Gemini with its address set to the stand-in, Live voice switched on (gemini-live installs), Test passes: "It answered aloud: OK."
```

- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** "Gemini's Live voice ability, its Test, and a security policy that lets sessions connect".

### Task 6: Spec, docs, checklist, finish

- [ ] **Spec:**
  - §9.1 and §9.2: the `realtime` ability kind;
  - §15: realtime connections (the same origin, the key in the address or subprotocol only to the provider), and `connect-src` with `wss:`;
  - §18: the stand-in realtime server.
- [ ] **docs/plugins.md:** "Realtime voice protocols": the contract (Shapes), a minimal example, what annai does around it (opening, origin, trace, cost), and the stand-in.
- [ ] **Device checklist:** "K4", with the spike's iPhone questions (section 4 of this plan):
  - the WebSocket to Gemini Live from the Home Screen app, over cellular;
  - audio in and out after the unlock tap, and the time to first audio;
  - what a locked screen does to an open session.
- [ ] **Finish:** size and budget, check, the full Docker e2e, commit.

---

# Milestone K5: Koe live

## File structure

```
src/core/koe/live.js                new: LiveKoe (sessions, input, output, notes, tools, transcripts, the quiet spell, resumption, fallback)
src/core/koe/hygiene.js             new: cleanSaid(text), realWord(text)
src/core/koe/path.js                koePath(cfg, o): the first usable entry: live or text
src/core/agent/halves.js            Koe's pathway per turn or session; live blocks; notes to LiveKoe
src/core/agent/budgets.js           realtime priced
src/core/voice/settings.js          closeAfterSeconds (30), bargeIn (true)
src/ui/voice-chip.js, src/ui/screens/voice.js   "Listening live"; the two settings
src/ui/screens/trace.js             live.session lines
test/unit/live-koe.test.js, halves-live.test.js, test/e2e/live-koe.spec.js
```

### Task 1: Choosing the pathway

**Files:**
- Modify: `src/core/koe/path.js`, `src/core/agent/halves.js`
- Test: `test/unit/halves-live.test.js` (new)

**Interfaces:**
- `koePath(cfg, { voiceOn, types, until, now }): { kind: 'live', modelId } | { kind: 'text', models: string[] } | null`. It walks `koeList`, skipping benched models and types not running.
  - A realtime entry first gives `live`.
  - A chat entry first gives `text` with the chat models from there on.
- `Halves.koeState` gains `'live'`, and Kokoro's now block says `koe: live`.

- [ ] **Step 1: Write the failing tests:**
  - "a realtime model first in Koe for talking: live; benched: the text model after it";
  - "voice off with only a realtime model: live, muted".
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "Koe's pathway comes from its model: a realtime one runs a live session, a text one the loop".

### Task 2: A session's life

**Files:**
- Create: `src/core/koe/live.js`
- Modify: `src/core/voice/settings.js`
- Test: `test/unit/live-koe.test.js` (new)

**Interfaces:**
- `new LiveKoe({ llm, voice, store, ws, halves, tools, now, timers })`:
  - `open(reason: 'voice' | 'tap' | 'trigger' | 'note' | 'typed'): Promise<void>`;
  - `close(why)`;
  - `send(text, photos)`, `note(text, mode)`, `wake(w)`;
  - `state: 'closed' | 'opening' | 'open'`.
- **Setup:**
  - `KOE_CORE` plus the personality, with the live rules: no `speak`, `wait` or `sleep`;
  - `compactView` plus the last exchanges as text;
  - its tools, without `speak`, `wait` and `sleep`;
  - the handle, if any.
- **Opening:**
  - when voice turns on with a realtime model, at the user's tap (the unlock);
  - on a tap;
  - on a trigger or a note Koe should say: it opens, speaks, then listens;
  - on a typed message (muted).
- **Closing:** on voice off, or after `closeAfterSeconds` of quiet (decision 12). The microphone closes and `playback` is restored.
- **GoAway:** reconnects with the handle without a gap in the conversation.

- [ ] **Step 1: Write the failing tests** (against the stand-in)

```js
test('voice on with a realtime Koe: a tap opens a session with Koe\'s instructions, compact view and tools', async () => { … });
test('30 s of quiet closes it, the microphone closes, and playback is restored', async () => { … });
test('a trigger opens a session, says the reminder, then listens', async () => { … });
test('GoAway: a new connection with the handle, and the conversation carries on', async () => { … });
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "Live sessions open with the voice or a tap, a reminder or a note, and close after a quiet spell; GoAway carries on".

### Task 3: Audio both ways, and both transcripts

**Files:**
- Create: `src/core/koe/hygiene.js`
- Modify: `src/core/koe/live.js`
- Test: `test/unit/live-koe.test.js`

**Interfaces:**
- **Input** is `LiveInput` (K4), with the barge-in setting (decision 13).
- **Output** plays from `player.stream()`, starting at the first `realWord` of the turn's `said` (decision 11). `interrupted` stops the stream and drops what is buffered.
- **Lines are logged per turn:**
  - `heard` (`source: 'live'`, its text, `split: true`);
  - `out.speak` (`half: 'koe'`, `live: true`, `voice: true`), the text `cleanSaid`, cut at the played fraction with "✂" and `cut: true` when interrupted.
- **Typed text** is logged as `msg.user` and sent as a text turn. **Photos** are sent as image turns, with the request copies Kokoro gets too.
- **The keep-clips setting** keeps the user's streamed speech as a clip in the smallest format (K3).

- [ ] **Step 1: Write the failing tests**

```js
test('what was heard and what Koe said are logged per turn, and Kokoro\'s transcript has "[heard]" and "[Koe said aloud]"', async () => { … });
test('markup in the output transcript (<!-- -->, <no speech>, {pause}) never reaches the log; a turn with no real word plays nothing', async () => { … });
test('cut off by voice: buffered audio is dropped, and the line is cut where playback was, marked ✂', async () => { … });
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "Live sessions hear only speech, play only words, and log every line for both halves".

### Task 4: Tool calls answered at once

**Files:**
- Modify: `src/core/koe/live.js`
- Test: `test/unit/live-koe.test.js`

**Interfaces:** decision 10. Each call is a `tool.call` and `tool.result` with `half: 'koe'`, and `tell_kokoro` goes through the `Channel`.

- [ ] **Step 1: Write the failing tests:**
  - "tell_kokoro is answered 'sent' with scheduling SILENT before Kokoro starts";
  - "a read answers with its result";
  - "ask shows buttons and the tap comes back as a text turn".
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "A live Koe's tools answer at once; Kokoro's work never holds up the session".

### Task 5: Notes, and Kokoro's blocks

**Files:**
- Modify: `src/core/koe/live.js`, `src/core/agent/halves.js`
- Test: `test/unit/halves-live.test.js`

**Interfaces:**
- `note(text, mode)`:
  - **append:** queued until the turn is complete *and* `player.stream().done`, then `text(wrapNote(text), { interrupt: false })`;
  - **immediate:** at once, with `{ interrupt: true }`;
  - **closed:** a note Koe should say opens the session first.
- **Halves writes `halves` events:**
  - `live-open`: "A live voice session opened: Koe speaks natively, and its words reach you as [Koe said aloud]";
  - `live-closed`;
  - `live-dropped`: Task 7.

- [ ] **Step 1: Write the failing tests**

```js
test('an append note waits for Koe\'s turn to end and its audio to finish playing, then goes as <from_kokoro> text', async () => { … });
test('an immediate note goes at once and interrupts Koe', async () => { … });
test("opening and closing sessions again and again: Kokoro's system text and tools stay identical; only blocks are added (Review Focus 2)", async () => { … });
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "Kokoro's notes reach a live Koe as marked text turns, appended after it speaks or at once to correct it".

### Task 6: A realtime model in a typing conversation

**Files:**
- Modify: `src/core/koe/live.js`, `src/core/agent/halves.js`
- Test: `test/unit/live-koe.test.js`

**Interfaces:**
- **Voice off, with only a realtime model:** the first typed message opens a session with no microphone. Its reply is shown from its transcript as Koe's bubble (`out.speak` without `voice`), and its audio is dropped.
- It closes after the quiet spell. When voice turns on, the same session gets the microphone.

- [ ] **Step 1: Write the failing test:** "typing to a realtime Koe: the transcript is the reply, nothing plays, no microphone".
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "A muted realtime Koe answers typing with its transcript".

### Task 7: When the session drops

**Files:**
- Modify: `src/core/koe/live.js`, `src/core/agent/halves.js`
- Test: `test/unit/live-koe.test.js`

**Interfaces:**
- **A close that isn't asked for:**
  - the half-done lines are logged, cut (✂);
  - it resumes with the handle, once, at once;
  - failing that, `live-dropped`, the realtime model is benched, and Koe's next entry takes the turn (text plus the speech pipeline).
- **If a reply was cut mid-sentence,** Koe's next call gets "[annai] the live session dropped while you were answering; finish briefly". Otherwise nothing is said about it.
- **No entry left:** `koe-down`.

- [ ] **Step 1: Write the failing tests**

```js
test('a drop mid-sentence: both half-lines are logged as cut, the handle resumes, and nothing is lost (Review Focus 4)', async () => { … });
test("a drop that can't resume: the text model after it finishes the answer through the speech pipeline", async () => { … });
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "A dropped live session resumes, or Koe carries on through its next model, and no word is lost".

### Task 8: Privacy and cost on screen

**Files:**
- Modify: `src/ui/voice-chip.js` ("Listening live" while a session's microphone is open; "Live" while open for typing), `src/ui/screens/voice.js` (Close a live session after; Cut her off by speaking; the words: "While a live session is open, what you say goes straight to <provider> as audio."), `src/ui/screens/trace.js` (`live.session` lines: opened, ready in N ms, closed why, minutes, data in and out, cost), `src/core/agent/budgets.js` (`priced` covers `realtime`; Spend per day reached closes the session with the budget card)
- Test: `test/e2e/live-koe.spec.js` (new), `test/unit/agent-budgets.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// live-koe.spec.js, both browsers: a fake microphone and the stand-in Gemini Live server
test('voice on, tap: "Listening live"; a live question: heard and said lines in the conversation, a tell_kokoro, Kokoro\'s tell_koe arrives at the stand-in as <from_kokoro> text; voice off closes it', async ({ page }) => { … });
test('the stand-in got activityStart, audio and activityEnd per sentence, and no audio while nobody spoke', async ({ page }) => { … });
test('Trace shows the session with its data and cost, and no key', async ({ page }) => { … });
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run** the spec in both browsers. Expected: PASS.
- [ ] **Step 5: Commit.** "A live session says it is listening live; Trace and Spend per day show what it cost, in money and data".

### Task 9: Spec, checklist, finish

- [ ] **Spec:**
  - §10 and §10.5: realtime sessions within voice mode: opening, closing, the quiet spell, reopening, resumption, the drop;
  - §15: the "listening live" disclosure;
  - §16: the chip.
- [ ] **Device checklist:** "K5", in the car:
  - the conversation, a live fact, a correction, chatter;
  - a tunnel (the drop);
  - a locked screen, then a tap (resume);
  - a reminder that opens a session after an earlier tap;
  - music quality after the quiet spell;
  - echo and barge-in;
  - data per minute in Trace.
- [ ] **Finish:** size and budget, check, the full Docker e2e, commit.

---

# Milestone K6: OpenAI Realtime

## File structure

```
src/core/realtime/g711.js           new: muLaw/aLaw encode and decode; 8 kHz through StreamResampler
plugins-official/openai-realtime/   new protocol plugin
plugins-official/provider-openai/   a 'realtime' ability (off), gpt-realtime-2.1 and -mini
plugins-official/provider-another-address/   a 'realtime' ability (off), type openai-realtime
test/fakes/realtime-server.js       the openai flavour
test/unit/g711.test.js, openai-realtime.test.js, test/e2e/live-koe.spec.js (OpenAI flavour), test/live/openai-realtime.test.js
```

### Task 1: G.711

**Files:**
- Create: `src/core/realtime/g711.js`
- Modify: `src/core/realtime/input.js` (the input format from `LiveSetup.audioIn`)
- Test: `test/unit/g711.test.js` (new)

**Interfaces:** `muLaw(pcm: Int16Array): Uint8Array`, `fromMuLaw(bytes): Int16Array`, and the same for A-law.

- [ ] **Step 1: Write the failing tests:** "μ-law and A-law round-trip within G.711's error; the reference values for 0, ±1, ±32767 match ITU-T G.711".
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "G.711 for realtime models that take telephone audio".

### Task 2: The openai-realtime plugin

**Files:**
- Create: `plugins-official/openai-realtime/{annai-plugin.json,index.js}`
- Modify: `test/fakes/realtime-server.js` (the `openai` flavour)
- Test: `test/unit/openai-realtime.test.js` (new)

**Interfaces:**
- Tunables: `{ input: 'pcmu', output: 'pcm', voice: 'marin', transcription: 'gpt-transcribe', noiseReduction: 'far_field' }`.
- `open()` gives `wss://…/v1/realtime?model=<id>` with `protocols ['realtime', 'openai-insecure-api-key.<key>']`.
- **`attach()` sends `session.update`:**
  - `type: 'realtime'`, `instructions`, `tools`;
  - `audio.input`: `{ format: { type: 'audio/pcmu' }, turn_detection: null, transcription: { model }, noise_reduction: { type } }`;
  - `audio.output`: `{ format: { type: 'audio/pcm', rate: 24000 }, voice }`.
- **Driver methods:**
  - `activity('end')`: `input_audio_buffer.commit` plus `response.create`;
  - `audio`: `input_audio_buffer.append`;
  - `text` and `image`: `conversation.item.create`, then `response.create`. With `interrupt`, it sends `response.cancel` and a `conversation.item.truncate` at the played point first;
  - `answer`: a `function_call_output` item; with `silent`, no `response.create`.
- **It maps:**
  - `response.output_audio.delta` to `audio`;
  - `response.output_audio_transcript.delta` and `.done` to `said`;
  - `conversation.item.input_audio_transcription.completed` to `heard`;
  - `response.done` to tools, `turn` and `usage` (by modality, cached input included);
  - `error` to a kind.
- **At 55 minutes,** it asks annai for a fresh session (decision 27).

- [ ] **Step 1: Write the failing tests** (against the stand-in's `openai` flavour)

```js
test('session.update: μ-law in, PCM 24 kHz out, no turn detection, transcription on; the key only as a subprotocol, never traced', async () => { … });
test('a turn: commit and response.create at the cut; a function call answered silently creates no response', async () => { … });
test('an immediate note: response.cancel, truncate at the played point, then the text item and a response', async () => { … });
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS. Then, with a key in the environment only: `OPENAI_KEY=… node --test test/live/openai-realtime.test.js`.
- [ ] **Step 5: Commit.** "OpenAI Realtime as a second protocol behind the same contract: μ-law in, PCM out, turns at annai's cut".

### Task 3: The providers, and Koe live on OpenAI

**Files:**
- Modify: `plugins-official/provider-openai/annai-plugin.json`:
  - ability `realtime`: `{ kind: 'realtime', type: 'openai-realtime', name: 'Realtime voice', on: false }`;
  - models `gpt-realtime-2.1` (prices: `input` 4, `cacheRead` 0.4, `audioIn` 32, `output` 24, `audioOut` 64) and `gpt-realtime-2.1-mini` (0.6 / 0.06 / 10 / 2.4 / 20).
- Modify: `plugins-official/provider-another-address/annai-plugin.json` (after provider M5 merges): a `realtime` ability, off, type `openai-realtime`.
- Modify: `catalog/plugins.json`
- Test: `test/unit/official-providers.test.js`, `test/e2e/live-koe.spec.js` (the OpenAI flavour: the same conversation test)

- [ ] **Step 1: Write the failing tests:**
  - "OpenAI's realtime ability is off until switched on, and installs openai-realtime then";
  - "live-koe.spec runs the same conversation through the OpenAI flavour".
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** "OpenAI's realtime voice as Koe, and any OpenAI-compatible realtime server through Another address".

### Task 4: Spec, docs, checklist, finish

- [ ] **Spec:** §9.1 (the protocols: gemini-live and openai-realtime).
- [ ] **docs/plugins.md:** OpenAI Realtime as the second example: what differs (subprotocol key, manual commit, no resume handle).
- [ ] **Device checklist:** "K6": with an OpenAI key, Test, then a short drive; μ-law against PCM in a noisy car (the `input` tunable).
- [ ] **Finish:** size and budget, check, the full Docker e2e, commit.
