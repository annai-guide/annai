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

## Open

States: not started, planning, building, under review, merged, paused (on what).

### Timeline home (the interface redesign)

Spec: `docs/superpowers/specs/2026-11-04-timeline-home-design.md`. The user's pick on shipping (2026-11-05): "Release in
stages; tabs go last (Recommended)": each stage is reviewed and released when green, with the tabs still there; the
tabs go only after the user has said, on a phone, that the timeline is right. Stages 1 to 6 are released (Closed).

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **Stage 7: opening rule, `me` read-only, no-trip paths out.** annai opens by the new rule; the old no-trip conversation becomes a read-only row (talking starts a new chat); the files waiting with Shiori move into one chat; the no-trip code goes. | not started; planning | Plan `docs/superpowers/plans/2026-11-06-timeline-stage-7-opening-and-no-trip.md` (written before stage 6 was redesigned as the card). Re-planned against main 5e2c6565 (2026-11-14): none of its four tasks is built, none made moot by the card; it adds the removal of `openWhenDone` (the last move that opens a trip by itself). Spec check done (2026-11-14): a simpler route (with nothing open, open the standing draft, as + does), unlisted changes to put right, three questions, answered 2026-11-14: with nothing open, the new conversation (the standing draft) is open, "Open the new conversation (Recommended)"; a line typed when no conversation can be made goes back into the type box, "Put it back in the type box (Recommended)". Next: the re-plan revised with them (running), then the build in its own worktree, side by side with the turn-end record. | "Last chat if recent, else timeline (Recommended)"; "Read-only row (Recommended)" (2026-11-05) |
| **The spec's "Also removable":** `start_trip` in chats, the `/waiting` branches (files plugin, `file.js`, `names.js`), hand-over's back-to-waiting Undo, `swipeTabs`. | not started | From the re-plan: the `/waiting` branches go in stage 7; `start_trip`'s no-trip branch goes in stage 7 (it is already refused in a chat); `swipeTabs` goes with the tabs in stage 8; hand-over's back-to-waiting Undo is proposed to stay for hand-overs made before the update (a call for the spec check). | the spec's Stages section |
| **The hand-over with no trip open, as it is live today** (the "Waiting with Shiori" panel, the "Shiori, no trip" way back, the Start a trip form in the foot: src/ui/screens/trips.js:248-290). Stage 7 removes them. | not started (part of stage 7) | The re-plan must keep what the user picked for this flow, or ask again. | "Add a way back (Recommended)"; "Show progress (Recommended)" (2026-10-28/29) |
| **"Where are you?" (Now → Driving) needs a new home** when Now goes in stage 8; the GPS help (src/ui/live-help.js:24) points to it. | not started (part of stage 8) | Found by the scope audit, 2026-11-14. | the spec's stage 8 |
| **Stage 8: the top bar goes**, gear and Trace move, with the e2e rewrite as its own stage (the spec's counts need a recount). | paused on the phone look below | Plan `docs/superpowers/plans/2026-11-06-timeline-stage-8-top-bar-goes.md`. The e2e recount on main 5e2c6565: 230 lines name `#/trips`, 88 `#/talk`, 25 `#/now`, 304 h1 lines, 54 top-bar clicks, 153 `startTrip` calls. | "Release in stages; tabs go last (Recommended)" |
| **The user's phone look of stage 4** (gates stage 8). | after stage 7 ships (the user's pick 2026-11-14, "After stage 7 ships (Recommended)") | The 11-09 list: the half-screen box, More/Less in place, buttons at the edge, the Start a trip field with the keyboard up, Safari's bars. And the stage 4 plan's own list (Task 8 step 3), in no note since: the + gesture with Voice on (the microphone opens at once on an iPhone); whether a new chat knowing only profile and memory feels wrong; 500 chats (`scripts/chats-fixture.mjs`); whether she dates or names a chat badly; the dock at rest. To be refreshed before it is sent, as stages 5 and 6 changed the screens. "Release in stages; tabs go last (Recommended)"; the spec records with it: "The user tries the timeline on a phone at stage 4, and the tabs go only after they've said it's right." |

### Nearby places online (Build D)

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **`nearby` waits for Overpass, says "busy" at once; VK's server behind a switch, off.** Closes the deferred entry "Online, `nearby` rarely gets OpenStreetMap's places". | built; paused on the Overpass probe | Branch nearby-wait 1a74715f. The probe of the public Overpass servers (24 hourly runs) ends about 16:53 PST 2026-11-14. Next: set `OVERPASS_MS` (src/plugins/places/index.js:39) and `OVERPASS` (src/core/pack/osm.js:15) from all 24 runs; its new ja and zh lines to the style guides; review with second opinions; merge; release. | "Allow light probes (Recommended)"; "VK behind a switch, off" |

### An answered question card always gets a reply

Design check: route A (2026-11-14). The visible fix (an answer to her card always gets a reply) first, then the loop
records when a turn ends, so the reader stops guessing from her words.

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **Route A, step 1:** take out the two faulted parts (the wake give-back, the cut-ask exemption); the rare Undo shape (F2) recorded as deferred. | under review | Branch ask-owed: e17900f5 (the removal), cd354d02 (main merged in), a1eb1be9 (the re-review's doc clause); check 5119 of 5119, e2e 234 passed. Re-review (2026-11-14): merge as is. Second opinion: two more rare shapes the removal leaves (a cut turn past the two-wake cap not taken up; the typed-line sibling of F2), both covered by step 2, so deferred to it; three doc lines claim more than the code past the cap. Next: a docs round that reproduces both and writes them (running), merge, full gate, release. | "A: remove 2 parts, then record (Recommended)" (2026-11-14) |
| **Route A, step 2: the loop records a turn's end** (one event type, one key); the reader reads it instead of words; `#settled` and the guessing rules go; F2 closes. | planning | Plan written (2026-11-14; its trial applies to the ask-owed branch, unit suite 5114 of 5122 with the 8 rewrites it names). Next: its spec check (running), then the build after route A step 1 merges, review, and a real-browser check of a reload and an open in the middle of a turn. Writes the approved limitation below when it lands. | "A: remove 2 parts, then record (Recommended)"; old logs: "Treat as finished (Recommended)" (2026-11-14): once per update, a turn the old version left paused and not yet reopened isn't picked up |

### Shiori answers in the traveller's language

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **An edited profile's "- Language: English" line is removed at start** when the traveller's languages don't include English (only that exact line). Also: the lessons entry marks the wait word settled; the glossary's Now note records the pick. | building (fix round 1) | Branch profile-lang a3328743 (from 5e2c6565); check 5085 of 5085, e2e 650 passed. Review (2026-11-14): fix first: with nothing picked, a Japanese or Chinese phone kept the line; "the person's languages" become the ones Shiori is told (their pick, else the phone's); tests with real locales; one rule in code, spec and lessons. Next: the fix round's report, a re-review, merge, release. | "Drop it when it contradicts (Recommended)" (2026-11-14) |

### Found by the scope audit (2026-11-14)

Parts the user asked for or picked that were in no note: not done, and not dropped with the user's OK. Each was checked
against the code before its row was written. The ones with a question are listed under "Waiting for the user".

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **Photo encoder plugins** for formats the browser can't make (WebP on Safari, AVIF, JPEG XL), and a side task that suggests one when a model refuses a format. | deferred to the build after the interface redesign; the card is being fixed now (branch encoder-card) | Pushed out of the photo plans (m1b, m2c); spec §4.8, §9.9, §15 promise it. Today a refused format gets a card saying "A plugin that adds … would fix it (Settings → Plugins)" (src/core/agent/loop.js:2686), and no plugin kind exists to write one. The fix: the card says what is true, a Deferred entry, the spec says "later". | the user's asks, 2026-10-15 and 10-16; "Later build; fix the card now (Recommended)" (2026-11-14) |
| **Nickname**: what Shiori calls the user, and "From <name>" on a shared trip. | not started; after the redesign ("After the redesign (Recommended)", 2026-11-14) | No plan, no entry; the timeline spec says only "Stage 9 goes" (:177). | "Later, as its own change (Recommended)" (2026-11-05) |
| **The device check lists on real phones**: the real-Android, iPhone-in-hand and outing items of `docs/testing/device-checklist-*.md` (the emulator pass is done). | sorting | No box in any list is ticked. Being sorted (2026-11-14) into one short pre-trip list the user can tick on the phone: what still applies, most important first. | "Emulator first, then my phone" (2026-10-17); "Yes, a short pre-trip list (Recommended)" (2026-11-14) |
| **Share a trip to a public GitHub repo.** | not started | Spec §12.2 ("Later: Share to GitHub"); nothing built. | "Later, after the trip" (2026-10-17) |
| **The parked-phone "walking" drift test.** | not run | The second-drive spec says "not decided" (:217-218); the instrumentation (a state entry per activity change, a 5-minute heartbeat) is built; no result read. | the user's offer to test, 2026-11-05 |
| **Places tools and the offline pack read English Wikipedia and Wikivoyage only** (src/core/pack/download.js:42-43, src/plugins/web/free.js:144). | waiting for the user | The m5c plan says "English today"; ja and zh screens are live. | the brief: broad global access |
| **Streamed voice for providers other than Gemini** (play a clip while it is still being made). | not started | Built for Gemini only (`readSpeechStream` in plugins-official/gemini-api/speech.js); the Gemini spec says "Later: Other providers' streamed voices". | the user's ask, 2026-10-19 |
| **OpenAI Realtime run against the real service.** | not run; waiting for the user | plugins-official/openai-realtime ships; test/live/openai-realtime.test.js needs a key and was never run; whether OpenAI takes a key from a browser this way is unknown. | — |
| **The 39-row Calls-to-confirm page** (2026-11-12) has no recorded answer; its row G8 ("K2 can fire a day late once") has no limitation entry. | waiting for the user | The page's answers aren't in the repo. | — |
| **"3b": remove the spoken-yes listening code**, unused since the card is answered by tap only (`askSaid` in src/core/agent/loop.js). | not started; after the turn-end record and stage 7 (all three change loop.js) | A build with a review; nothing the user sees changes; its limitations entry ("until the user decides") closes. | "Keep tap only (Recommended)" (2026-11-13); "Remove it (Recommended)" (2026-11-14) |
| **On-device dictation.** | not started | Off because Web Speech's on-device check crashed Chrome 153 (src/plugins/voice-browser/index.js:720-722). | "on-device dictation can wait" (2026-10-17) |
| **Right-to-left languages.** | not started | Groundwork only; spec §14.3: "comes with the first such language". | agreed "last, when a reader is there" (2026-10-23) |
| **Hosting on Cloudflare Pages.** | not started | The stamp is ready for a Pages build (`node scripts/stamp.mjs`). | the user, 2026-10-17: once most things are ironed out |
| **The storage-full card's other ways to free space** (delete trace bodies, cached photo copies). | not started | In the spec only; src/ui/storage-full.js offers neither. | the spec |
| **An automatic backup before a stored-format migration.** | not started | In the spec only. | the spec |
| **Reading `.eml` mail files.** | not started | A plan's choice, never built. | a plan |
| **Submitting plugins to the official catalog** (approval of third-party plugins). | not started | — | "if there is interest maybe … later" (2026-10-19) |
| **On-device AI plugins.** | not started | — | the user, 2026-10-15 ("not now") |
| **More backup places**: Google Drive, Dropbox, GitLab, a plain git server. | not started | Spec §12.4. | the spec |
| **OAuth for MCP servers.** | not started | — | the spec ("later") |
| **A quick decision model** (a "Jev"-style model that returns choice probabilities) beside the utility model. | not started | — | the user's idea, "we do not have to have that" |
| **A keep-warm plugin.** | not started | — | the user's idea |
| **Gemini Live's key in the WebSocket address** (plugins-official/gemini-live/index.js:4, :71): ephemeral tokens would keep it out. | waiting for the user | No limitation entry. | — |
| **The plugin form's redraw can lose a typed address on a slow phone.** | not started | From the 2026-11-09 notes; no entry. | — |
| **A Korean greeting is answered in Korean in about half of Gemini runs.** | not started | From the 2026-11-09 notes; "Languages you speak" covers part of it; no entry. | the user's mishearing report, 2026-10-23 |
| **`#follow()` inside `reminders()` is pinned by no test.** | not started | From the 2026-11-09 notes. | — |
| **Remove `item.says ??= hash` in the push mirror** (src/core/push/mirror.js:520) on or after 2026-12-07. | dated, not due | Its Deferred entry is in docs/limitations.md. | — |

### Standing

| Part | State | Where it stands |
|---|---|---|
| **Deferred work** | open | `docs/limitations.md`, every entry with "Kind: deferred" (12 on 2026-11-14). Each is planned for the next version; none is repeated here. |

## Waiting for the user

- The phone look of stage 4 and stage 7, after stage 7 ships (picked 2026-11-14): see its row.
- From the scope audit: English-only Wikipedia for Places and the pack; OpenAI Realtime unverified; the 39-row page; the later and "not now" rows (Deferred, known limitation, or dropped); Gemini Live's key in the
  address (known limitation?); the "Live / Chat" names, which no pick chose (the user picked "Realtime / Classic",
  2026-10-22); the proposal to fix 「固定」 at its source, never put to the user.

## Closed

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
