# Progress

The open work on annai, one row per part of every agreed design that isn't finished. Edited in place, and read whole
after every compaction, clear or restart, before saying how far anything is (agent rules, "Long work: the progress
file"). A row leaves the open list only as done, with its commit or release, or as dropped, with the user's words and
the date. History and reasoning live in the project's notes, not here.

## The goal, in the user's words

- The original brief (organized, not verbatim): `docs/vision.md`. A web-page tour-guide agent on the user's phone,
  local-first, open source, bring your own model.
- 2026-11-04, the interface redesign (timeline home): "a bit messy screens and tabs here and there"; "everything come
  back to the conversation screen"; "all conversation belongs to a trip. and trip showsup nicely on a timeline."
- 2026-11-14, the words: "the japanese words seems bit 不自然 feels like english translated to japanese not native
  japanese from feedback. Can you help make it more natual and how people will actually say?"; then "yeah proof read
  two chinese ones they also show similar translated vibes".
- Standing (2026-11-12 on): "what I prefer is simple and robust solutions. Again that is #1 in our agent rules. DO NOT
  miss that. Clever design sometimes also means accept known limitations early in design phase to avoid scope creeps
  and bring in more vectors".

## Standing decisions

How the project is worked (not what gets built): the user's rulings, one line each with their words and the date (as the
transcripts date them). A line changes only on the user's word.

- **Releases ship when green**, without asking each time: "yes release as you go" (2026-10-19); "ok, keep going and release
  when green" (2026-10-23). When the deploy is blocked for the agent, the user runs the one release command it gives.
- **Simple and robust first:** "I personally often prefer simplicity and robustness. I often try to achieve the maximum
  functionality and reliability with minimal working parts" (2026-10-15); "what I prefer is simple and robust solutions.
  Again that is #1 in our agent rules" (2026-11-12).
- **No deadline pressure from the user's own trip:** "again everything we have planned so far goes in there is enough time
  why do you have to mention the … trip?" (2026-10-19). Scope is never cut or reordered for the trip.
- **Test keys:** free ones first, paid calls few and short: "you can use any of them but prefer free ones for testing"
  (2026-10-22); "would like to reduce test cost lol" (2026-10-21). A key is never printed, written to a file or committed.
- **The user's phone trace may be read to debug, and never leaked:** "you have my explicit permission to read my trace.
  just do not leak it out" (2026-11-10).
- **No real user details in this public repo** (booking codes, places, names): a local check refuses a push that holds one,
  "Add the guard (Recommended)" (2026-11-01).
- **Worktrees live inside the project and are cleaned after merge:** "maybe let's try to clean after them or keep them
  inside the annai project folder?" (2026-11-11).

## Open

States: not started, planning, building, under review, merged, paused (on what).

### Timeline home (the interface redesign)

Spec: `docs/superpowers/specs/2026-11-04-timeline-home-design.md`. The user's pick on shipping (2026-11-05): "Release in
stages; tabs go last (Recommended)": each stage is reviewed and released when green, with the tabs still there; the
tabs go only after the user has said, on a phone, that the timeline is right. Stages 1 to 6 are released (Closed).

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **Stage 7: opening rule, `me` read-only, no-trip paths out.** annai opens by the new rule; the old no-trip conversation becomes a read-only row (talking there is the +); the files waiting with Shiori move into a "Waiting with Shiori" chat; with nothing open, the new conversation (the standing draft) is open; the no-trip code and `openWhenDone` go. | building | Branch stage7 from main d84b9e39 (2026-11-14). Plan `.superpowers` notes: timeline-stage7-plan.md (re-planned against main, spec-checked, the user's answers in). Task 1 committed (7aeba807, the opening rule); the later tasks in progress. Next: the build's report, review with second opinions, merge, release, then the user's phone look. | "Last chat if recent, else timeline (Recommended)"; "Read-only row (Recommended)" (2026-11-05); "Open the new conversation (Recommended)", "Put it back in the type box (Recommended)", "A new chat each run (Recommended)" (2026-11-14) |
| **The spec's "Also removable":** `start_trip` in chats, the `/waiting` branches (files plugin, `file.js`, `names.js`), hand-over's back-to-waiting Undo, `swipeTabs`. | not started | From the re-plan: the `/waiting` branches go in stage 7; `start_trip`'s no-trip branch goes in stage 7 (it is already refused in a chat); `swipeTabs` goes with the tabs in stage 8; hand-over's back-to-waiting Undo is proposed to stay for hand-overs made before the update (a call for the spec check). | the spec's Stages section |
| **The hand-over with no trip open, as it is live today** (the "Waiting with Shiori" panel and the "Shiori, no trip" way back: src/ui/screens/trips.js:248-290). Stage 7 replaces them: the way back becomes the "Shiori, no trip" row plus the "Waiting with Shiori" chat; the progress shown on a large hand-over is untouched. (The Start a trip form in the foot stays until stage 8.) | building (part of stage 7) | As the stage 7 row. | "Add a way back (Recommended)"; "Show progress (Recommended)" (2026-10-28/29) |
| **"Where are you?" (Now → Driving) needs a new home** when Now goes in stage 8; the GPS help (src/ui/live-help.js:24) points to it. | not started (part of stage 8) | Found by the scope audit, 2026-11-14. | the spec's stage 8 |
| **Stage 8: the top bar goes**, gear and Trace move, with the e2e rewrite as its own stage (the spec's counts need a recount). | paused on the phone look below | Plan `docs/superpowers/plans/2026-11-06-timeline-stage-8-top-bar-goes.md`. The e2e recount on main 5e2c6565: 230 lines name `#/trips`, 88 `#/talk`, 25 `#/now`, 304 h1 lines, 54 top-bar clicks, 153 `startTrip` calls. | "Release in stages; tabs go last (Recommended)" |
| **The user's phone look of stage 4 and stage 7** (gates stage 8). | after stage 7 ships ("After stage 7 ships (Recommended)", 2026-11-14) | The 11-09 list: the half-screen box, More/Less in place, buttons at the edge, Safari's bars. The stage 4 plan's own list (Task 8 step 3), in no note until 2026-11-14: the + gesture with Voice on (the microphone opens at once on an iPhone); whether a new chat knowing only profile and memory feels wrong; 500 chats (`scripts/chats-fixture.mjs`); whether she dates or names a chat badly; the dock at rest. Stage 7's: opening from the Home Screen icon; the "Shiori, no trip" row. (The Start a trip field goes in stage 8, so it is off this list.) The stage 7 build writes the short checklist sent with the release. | "Release in stages; tabs go last (Recommended)"; the spec records with it: "The user tries the timeline on a phone at stage 4, and the tabs go only after they've said it's right." |

### Nearby places online (Build D)

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **`nearby` waits for Overpass, says "busy" at once; falls back to overpass-api.de's own backends; VK's server behind a switch, off.** Closes the deferred entry "Online, `nearby` rarely gets OpenStreetMap's places". | building (fix round 1, values) | Branch nearby-wait: 1a74715f, main merged in (f5bd49e4). The 24 hourly probe runs (2026-11-14): overpass-api.de alone answered 13 of 24 (it refuses for hours at a time, in half a second); its backends z. and lz4. answered in 10 of those 11 refusals, so asking them one after another after a refusal gives places in 23 of 24; the wait stays 50 s. Next: the fallback order and the reasons written, review with second opinions, merge, release. | "Allow light probes (Recommended)"; "VK behind a switch, off"; "Fall back to its backends (Recommended)" (2026-11-14) |

### An answered question card always gets a reply

Design check: route A (2026-11-14). The visible fix (an answer to her card always gets a reply) first, then the loop
records when a turn ends, so the reader stops guessing from her words.

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **Route A, step 1:** take out the two faulted parts (the wake give-back, the cut-ask exemption); the rare shapes left (F2 and its typed-line sibling; a cut turn past the two-wake cap) recorded as deferred to step 2. | merged; release gate green | Main d84b9e39 (2026-11-14): e17900f5, the docs rounds a1eb1be9 and 0d6ed7a5. Gate on main 04cfade0: check exit 0; full e2e 1862 passed, 21 skipped, 1 flaky (the known details-menu WebKit test), 0 failed; privacy check 0 of 23 commits. Next: the release (the user's command), smoke, CI. | "A: remove 2 parts, then record (Recommended)" (2026-11-14) |
| **Route A, step 2: the loop records a turn's end** (one event type, one key); the reader reads it instead of words; `#settled` and the guessing rules go; the Deferred entries of step 1 close, each shape a passing test. | building | Plan revised after its spec check (2026-11-14) with the user's answers; branch turn-end from main d84b9e39, beside stage 7. Built: 0f344793 (the record), a2a071d8 (tests), d2b51469 (the real-browser check); report written, its full e2e running. Next: the e2e numbers, review with second opinions, merge, release; the user's phone check after. Writes the approved old-log limitation and closes step 1's Deferred entries when it lands. | "A: remove 2 parts, then record (Recommended)"; old logs: "Treat as finished (Recommended)", then "Approve the wider entry (Recommended)" (the entry names each effect, once per update); Koe: "Accept, widen the entry (Recommended)" (2026-11-14) |

### Shiori answers in the traveller's language

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **An edited profile's "- Language: English" line is removed at start** when the languages Shiori is told (the traveller's pick, else the phone's language) hold no English (only that exact line). Also: the lessons entry marks the wait word settled; the glossary's Now note records the pick. | ready to merge | Branch profile-lang: a3328743, fix round 1 60f4738a, 190c88c5 and 70fe1777 (comments). Re-review: merge; the second opinion's case (English and Japanese listed, answer Japanese) kept as built by the user's pick. Next: merge after the release gate, release. | "Drop it when it contradicts (Recommended)"; "Keep as built" (2026-11-14) |

### Found by the scope audit (2026-11-14)

Parts the user asked for or picked that were in no note: not done, and not dropped with the user's OK. Each was checked
against the code before its row was written. The ones with a question are listed under "Waiting for the user".

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **Photo encoder plugins** for formats the browser can't make (WebP on Safari, AVIF, JPEG XL), and a side task that suggests one when a model refuses a format. | deferred to the build after the interface redesign; the card's fix is ready to merge (branch encoder-card) | Pushed out of the photo plans (m1b, m2c). The card at src/core/agent/loop.js:2686 promised "A plugin that adds … would fix it"; on the branch it says "Try another model in Settings → Models", a Deferred entry is written, and the spec's promises say "later". | the user's asks, 2026-10-15 and 10-16; "Later build; fix the card now (Recommended)" (2026-11-14) |
| **Nickname**: what Shiori calls the user, and "From <name>" on a shared trip. | not started; after the redesign ("After the redesign (Recommended)", 2026-11-14) | No plan, no entry; the timeline spec says only "Stage 9 goes" (:177). | "Later, as its own change (Recommended)" (2026-11-05) |
| **The device check lists on real phones**: the real-Android, iPhone-in-hand and outing items of `docs/testing/device-checklist-*.md` (the emulator pass is done). | waiting for the user (the page to tick is up) | Sorted 2026-11-14 into 38 lines (33 kept, 37 merged in, 2 dropped, 5 added), most important first, and published as a private page the user ticks on the phone (Pass, Fail, Skip, a note per line; Claude reads the results). Line 11 (a reminder set 8 days ahead) runs on the user's second iPhone ("Another iPhone (Recommended)"). | "Emulator first, then my phone" (2026-10-17); "Yes, a short pre-trip list (Recommended)" (2026-11-14) |
| **Share a trip to a public GitHub repo.** | planned, after the redesign (order picked then) | Spec §12.2 ("Later: Share to GitHub"); nothing built. | "Later, after the trip" (2026-10-17) |
| **The parked-phone "walking" drift test.** | not run | The second-drive spec says "not decided" (:217-218); the instrumentation (a state entry per activity change, a 5-minute heartbeat) is built; no result read. | the user's offer to test, 2026-11-05 |
| **Places tools and the offline pack read the traveller's language** (Wikipedia and Wikivoyage, English when that has no article); today English only (src/core/pack/download.js:42-43, src/plugins/web/free.js:144). | not started; after the redesign | — | the brief: broad global access; "Your language, after the redesign (Recommended)" (2026-11-14) |
| **Streamed voice for providers other than Gemini** (play a clip while it is still being made). | planned, after the redesign (order picked then) | Built for Gemini only (`readSpeechStream` in plugins-official/gemini-api/speech.js); the Gemini spec says "Later: Other providers' streamed voices". | the user's ask, 2026-10-19 |
| **OpenAI Realtime run against the real service.** | its plugin page says it is untested (openai-realtime 0.6.1, branch encoder-card, ready to merge); the live run waits for a key | plugins-official/openai-realtime ships; test/live/openai-realtime.test.js needs a key and was never run. | "Mark it untested (Recommended)" (2026-11-14) |
| **"3b": remove the spoken-yes listening code**, unused since the card is answered by tap only (`askSaid` in src/core/agent/loop.js). | not started; after the turn-end record and stage 7 (all three change loop.js) | A build with a review; nothing the user sees changes; its limitations entry ("until the user decides") closes. | "Keep tap only (Recommended)" (2026-11-13); "Remove it (Recommended)" (2026-11-14) |
| **On-device dictation.** | planned, after the redesign (order picked then) | Off because Web Speech's on-device check crashed Chrome 153 (src/plugins/voice-browser/index.js:720-722). | "on-device dictation can wait" (2026-10-17) |
| **Right-to-left languages.** | planned, after the redesign (order picked then) | Groundwork only; spec §14.3: "comes with the first such language". | agreed "last, when a reader is there" (2026-10-23) |
| **Hosting on Cloudflare Pages.** | planned, after the redesign (order picked then) | The stamp is ready for a Pages build (`node scripts/stamp.mjs`). | the user, 2026-10-17: once most things are ironed out |
| **The storage-full card's other ways to free space** (delete trace bodies, cached photo copies). | planned, after the redesign (order picked then) | In the spec only; src/ui/storage-full.js offers neither. | the spec |
| **An automatic backup before a stored-format migration.** | planned, after the redesign (order picked then) | In the spec only. | the spec |
| **Reading `.eml` mail files.** | planned, after the redesign (order picked then) | A plan's choice, never built. | a plan |
| **Submitting plugins to the official catalog** (approval of third-party plugins). | planned, after the redesign (order picked then) | — | "if there is interest maybe … later" (2026-10-19) |
| **On-device AI plugins.** | planned, after the redesign (order picked then) | — | the user, 2026-10-15 ("not now") |
| **More backup places**: Google Drive, Dropbox, GitLab, a plain git server. | planned, after the redesign (order picked then) | Spec §12.4. | the spec |
| **OAuth for MCP servers.** | planned, after the redesign (order picked then) | — | the spec ("later") |
| **A quick decision model** (a "Jev"-style model that returns choice probabilities) beside the utility model. | planned, after the redesign (order picked then) | — | the user's idea, "we do not have to have that" |
| **A keep-warm plugin.** | planned, after the redesign (order picked then) | — | the user's idea |
| **G8 of the 2026-11-07 Calls-to-confirm page: a reminder (K2) can fire a day late once.** | waiting for a plain account, then the user's OK as a known limitation | The page's other rows stand as built (the user's pick). | "Let them stand (Recommended)" (2026-11-14) |
| **The plugin form's redraw can lose a typed address on a slow phone.** | not started | From the 2026-11-09 notes; no entry. | — |
| **A Korean greeting is answered in Korean in about half of Gemini runs.** | not started | From the 2026-11-09 notes; "Languages you speak" covers part of it; no entry. | the user's mishearing report, 2026-10-23 |
| **`#follow()` inside `reminders()` is pinned by no test.** | not started | From the 2026-11-09 notes. | — |
| **Remove `item.says ??= hash` in the push mirror** (src/core/push/mirror.js:520) on or after 2026-12-07. | dated, not due | Its Deferred entry is in docs/limitations.md. | — |
| **「固定」 and 「未確認」 at their source:** a plan item's `fixed` and a booking's `status` are shown to Shiori as what they mean ("can't be moved"; "not checked against the booking yet"), not as the field's word; real-model checks that the words go. | under review (the later commits) | Branch kotei: 8a8e8019, 3d1c0e5e (reviewed: merge), then bc2710aa, 876edb57, 3f0c8712 (only what can't move), d4249ca9 (lessons). Final real round, 9 runs: 「固定」 0, 「未確認」 0, a flexible item's "can be moved" 0, a blank read as "no time" 0; bracket tags on fixed items in 3 of 9. The replanning check passed: with rain on an outdoor walk she moved it in 6 of 6 runs. Next: the re-review of bc2710aa..d4249ca9 (with a second opinion, running), merge, release. | "Fix at the source (Recommended)"; for bookings "Yes, same fix (Recommended)"; "Only say what can't move (Recommended)" (2026-11-14) |
| **The strings tool and a plugin manifest's changed English** (scripts/strings.mjs ~340-348; nothing stale ships today): such a row follows a code message's rule (a small edit becomes a draft with "English was: …", a rewrite becomes `new`), and a draft carried from changed English now fails the check until it is rewritten; a provider's `providerTools` words become translatable. | under review (fix round 2) | Branch strings-stale: f16ff2f0 (review: fix first, F1; second opinion: Gemini's search tool note shows in English on every screen); round 2 20e70f55 (F1, carried drafts block the check, the provider tools' words translated). Next: the re-review (with a second opinion, running), merge, release. | "Block until rewritten (Recommended)" (2026-11-14) |
| **OpenRouter photo uploads** (an uploaded photo referred to by id instead of resent in every request). | building | A real test (2026-11-14) passed on the route annai uses. Plan spec-checked; branch openrouter-uploads from main 5ce948f6 (beside the redesign), nothing committed yet. Uploads on by default with a switch on OpenRouter's page only; annai deletes its own files after 48 hours from OpenRouter's own file list (no new record); the leftovers limitation is approved and written with the build. Next: the build with its real checks, review, release; the user taps Test on the Sign-in key after release. | the user's ask, 2026-10-16 ("they also have file api"); "Check if it can work", "Run the test", "Now, beside the redesign", leftovers "Accept it", "OpenRouter's page only", "After release, you tap Test" (all "(Recommended)", 2026-11-14) |

### Standing

| Part | State | Where it stands |
|---|---|---|
| **Deferred work** | open | `docs/limitations.md`, every entry with "Kind: deferred" (12 on 2026-11-14). Each is planned for the next version; none is repeated here. |

## Waiting for the user

- The release command for main 5ce948f6 (route A step 1 and the progress work): see route A step 1's row.
- The phone look of stage 4 and stage 7, after stage 7 ships: see its row.
- The pre-trip check list's 8-day reminder line, and the page to tick: see its row.
- G8, once it has a plain account: see its row.

## Closed

- 2026-11-14: the shared lesson on quoting words sharpened to fields shown by name, "Sharpen it (Recommended)" (agent-rules affe346).
- 2026-11-14: Gemini Live's key in the WebSocket address: a known limitation, "Known limitation (Recommended)" (9600cc67).
- 2026-11-14: the 2026-11-07 Calls-to-confirm page's rows stand as built, "Let them stand (Recommended)" (G8 stays open above).
- 2026-11-14: the voice modes keep the names "Live / Chat" (renamed 2026-11-05 without a pick), "Keep Live / Chat (Recommended)".
- 2026-11-14: the later and "not now" items stay as planned rows, "Keep as planned rows (Recommended)".
- 2026-11-14: Remote trace's page "does not open" (reported 2026-11-08): the user says it opens now, "It opens now".
- 2026-11-14: the iPhone volume limitation approved 2026-11-11 ("Yes, with a help line (Recommended)") written into docs/limitations.md (be19f773).
- 2026-11-14: Japanese and Chinese rewritten to read native (both Chinese scripts; Traditional written for Taiwan); Shiori's answers in the traveller's language; an answered card is always read (ask-sleep); ~40 English lines made true. Released 5e2c6565.
- 2026-11-14: Koe's 「少々お待ちください」: accepted, "Accept it (Recommended)".
- 2026-11-14: the zh Now tab stays 现在 / 現在, "现在 / 現在 (Recommended)".
- 2026-11-13: the spoken yes to annai's card: the card is answered by tap only (46b21d3d); branches empty-heard and card-20s dropped with it, "Keep tap only (Recommended)".
- 2026-11-13: spec §4.8 uploads: the spec corrected to what is built, "Fix the spec (Recommended)".
- 2026-11-11: timeline stage 6, moving, redesigned as annai's card (b233a39d, released 2026-11-11), "She asks, I tap or say yes (Recommended)"; branch stage6's rounds 2 to 7 dropped with that pick.
- 2026-11-10: timeline stage 5, reading another trip (merged e5f146c6, released).
- 2026-11-09: timeline stage 4, chats, +, the timeline (a379a5f7, released 2026-11-09); its sticky box opens a stuck card in place (2614b37a); the timeline branch's sticky-box commit 51f20987 dropped with that option.
- 2026-11-08: timeline stage 3, conversation address, header, Next, Details (released 5ada211d).
- Before 2026-11-08: timeline stages 1 and 2, itinerary and trip in play (released).
