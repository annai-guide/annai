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
  when green" (2026-10-23). The release itself (`annai-release <commit>` for a commit on origin/main with green gates, or a
  rollback to an earlier released one) runs under its own allow rule with that standing OK; tell the user after.
- **A push to this public repo needs the chief session's OK** (since 2026-11-16; supersedes "the agent can't push, the user
  runs the command"): run the privacy check with its output in the transcript: the pre-push hook on origin/main..main, which
  since 2026-11-16 (chief's decision) checks the added lines and messages twice, against the hand-kept list of real details
  (private host names added) and with claude-scrub's secret scan (the keys it harvests on this machine and key shapes; values
  never shown; a public string that must go out is named exactly in .superpowers/scan-expected.txt) and refuses when either
  can't run; message chief with the repo, the range and the result in one line, then a plain
  `git push origin main` (no --force, no --no-verify) on chief's OK; each push its own OK. The user (2026-11-16, to chief):
  "maybe let's change to push to public repo needs your ok? and you really only need to make sure the session did made sure
  no secrets are leaked to public repo before asking to push because all other opertions cause relatively low impact for the
  main branch github code" (RULES.md "Ops", agent-rules 373596a). Still the user's own word: a force push, anything posted
  outside, a new public repo. If auto mode denies a push with chief's OK, don't work around it: write the reason here and
  message chief once.
- **Simple and robust first:** "I personally often prefer simplicity and robustness. I often try to achieve the maximum
  functionality and reliability with minimal working parts" (2026-10-15); "what I prefer is simple and robust solutions.
  Again that is #1 in our agent rules" (2026-11-12).
- **No deadline pressure from the user's own trip:** "again everything we have planned so far goes in there is enough time
  why do you have to mention the … trip?" (2026-10-19). Scope is never cut or reordered for the trip. 2026-11-16, the user's
  word (to chief): "so, let resume work for annai. you can switch its account. my trip is this friday so I want the current
  scope to be done and tested asap." It cuts no scope: the current scope is done and tested first (chief's order of work,
  2026-11-16: the release of main, then Koe's "can't be moved" and the lighter nearby query side by side, the old-booking
  round on the user's answer, one release, then the user's own checks in one list); what is planned "after the redesign"
  stays where it is; stage 8 before the trip, the user's pick "Before the trip" (2026-11-16), its build after their phone look of stages 4 and 7, released early enough to use the new shell a day before Friday (chief's order; no gate dropped for the date).
- **Test keys:** free ones first, paid calls few and short: "you can use any of them but prefer free ones for testing"
  (2026-10-22); "would like to reduce test cost lol" (2026-10-21). A key is never printed, written to a file or committed.
- **The user's phone trace may be read to debug, and never leaked:** "you have my explicit permission to read my trace.
  just do not leak it out" (2026-11-10).
- **No real user details in this public repo** (booking codes, places, names): a local check refuses a push that holds one,
  "Add the guard (Recommended)" (2026-11-01).
- **Questions RULES.md sends to the user go into "Waiting for the user" below, in full** (the question, the options with the recommendation first, what waits on it, any words of the user's it would drop); the chief session reads this file and answers (`~/.claude/CLAUDE.md`, "The chief session"): "agents shall ask you if they cannot decide first. And if you think I will 90% go with an option you are free to decide on that route"; "each session shall still make their own calls and reduce the amount they need to wake you up ... only inform when something urgent need to be dealt with" (2026-11-15). A chief's decision is recorded as chief's, never as the user's words.
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
| **Trip cards' own colour**: each trip its own colour or pattern, lighting up the more it was used (its days, its size, how much was said and done in it), past trips faded to a pastel or one uniform filter, so a long, busy trip stands out from a short or quiet one. | not started; a design first (after stage 8; "do not have to be done by friday") | The lighter tint for upcoming trips ships with stage 8. | the user, 2026-11-16 ~20:50 PST: "I am actaully thinking maybe we calculate some random pattern / tint / whatever based on the trip active day / size / amount of activity? sorta like the apple card idea but for trips. so that an trip will "light up" more the more we interacted with it? and for past trips we can faint it to a more pastel color? or just apply a more uniform filter? so a long trip before that have a lot of activity will stand out from a shorter one and also from a inactive one. maybe they also should have their own unique color scheme / pattern? just an improvement idea do not have to be done by friday" |

### An answered question card always gets a reply

Design check: route A (2026-11-14). The visible fix (an answer to her card always gets a reply) first, then the loop
records when a turn ends, so the reader stops guessing from her words.

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **Route A, step 2: the loop records a turn's end** (one event type, one key); the reader reads it instead of words; `#settled` and the guessing rules go; the Deferred entries of step 1 close, each shape a passing test. | released 78006090 (BUILD a389d389686f, 2026-11-15; smoke 10 of 10, CI run 43693098540 green); the user's phone check next | Plan revised after its spec check (2026-11-14) with the user's answers; branch turn-end from main ef833e39, beside stage 7. Built: cc3615ae (the record), 2bdd1d32 (tests), fbf3576d (the real-browser check), 8d149fe4; check 5149/5149; full e2e 1807 passed, 56 flaky, 11 failed (all 11 pass alone, none in touched code). Final review (`.superpowers` notes: turn-end-review.md, two -haiku files): merge as is; merged into main 7fd64a2b (2026-11-14). A small follow-up on branch turn-end-f1 (turn-end-f1-brief.md) built (bb4ca7d3, 6ccddabe; check 5164/5164), under re-review: a cut right after a silent reply no longer recorded as an end (the review's fix B, no approved entry changed), two rules pinned by tests, a comment, F2 (older than the branch) written as a Deferred entry, and the Call 3 clause the user approved, "Widen the entry (Recommended)" (2026-11-14). Gate on main d903f411 green (check 5168/5168; e2e 1873 passed, 7 flaky). The follow-up merged and both released in 78006090 with the approved old-log limitation. Next: the user's phone check (an answered card always gets a reply; a cut turn taken up when it should be). | "A: remove 2 parts, then record (Recommended)"; old logs: "Treat as finished (Recommended)", then "Approve the wider entry (Recommended)" (the entry names each effect, once per update); Koe: "Accept, widen the entry (Recommended)" (2026-11-14) |

### Found by the scope audit (2026-11-14)

Parts the user asked for or picked that were in no note: not done, and not dropped with the user's OK. Each was checked
against the code before its row was written. The ones with a question are listed under "Waiting for the user".

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **Photo encoder plugins** for formats the browser can't make (WebP on Safari, AVIF, JPEG XL), and a side task that suggests one when a model refuses a format. | deferred to the build after the interface redesign; the card's fix released 78006090 | Pushed out of the photo plans (m1b, m2c). The card at src/core/agent/loop.js:2686 promised "A plugin that adds … would fix it"; on the branch it says "Try another model in Settings → Models", a Deferred entry is written, and the spec's promises say "later". | the user's asks, 2026-10-15 and 10-16; "Later build; fix the card now (Recommended)" (2026-11-14) |
| **Nickname**: what Shiori calls the user, and "From <name>" on a shared trip. | not started; after the redesign ("After the redesign (Recommended)", 2026-11-14) | No plan, no entry; the timeline spec says only "Stage 9 goes" (:177). | "Later, as its own change (Recommended)" (2026-11-05) |
| **The device check lists on real phones**: the real-Android, iPhone-in-hand and outing items of `docs/testing/device-checklist-*.md` (the emulator pass is done). | waiting for the user (the page to tick is up) | Sorted 2026-11-14 into 38 lines (33 kept, 37 merged in, 2 dropped, 5 added), most important first, and published as a private page the user ticks on the phone (Pass, Fail, Skip, a note per line; Claude reads the results). Line 11 (a reminder set 8 days ahead) runs on the user's second iPhone ("Another iPhone (Recommended)"). | "Emulator first, then my phone" (2026-10-17); "Yes, a short pre-trip list (Recommended)" (2026-11-14) |
| **Share a trip to a public GitHub repo.** | planned, after the redesign (order picked then) | Spec §12.2 ("Later: Share to GitHub"); nothing built. | "Later, after the trip" (2026-10-17) |
| **The parked-phone "walking" drift test.** | not run | The second-drive spec says "not decided" (:217-218); the instrumentation (a state entry per activity change, a 5-minute heartbeat) is built; no result read. | the user's offer to test, 2026-11-05 |
| **Places tools and the offline pack read the traveller's language** (Wikipedia and Wikivoyage, English when that has no article); today English only (src/core/pack/download.js:42-43, src/plugins/web/free.js:144). | not started; after the redesign | — | the brief: broad global access; "Your language, after the redesign (Recommended)" (2026-11-14) |
| **Streamed voice for providers other than Gemini** (play a clip while it is still being made). | planned, after the redesign (order picked then) | Built for Gemini only (`readSpeechStream` in plugins-official/gemini-api/speech.js); the Gemini spec says "Later: Other providers' streamed voices". | the user's ask, 2026-10-19 |
| **OpenAI Realtime run against the real service.** | its plugin page says it is untested (openai-realtime 0.6.1, released 78006090); the live run waits for a key | plugins-official/openai-realtime ships; test/live/openai-realtime.test.js needs a key and was never run. | "Mark it untested (Recommended)" (2026-11-14) |
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
| **Retiring a booking's `status`** (it no longer means anything on new bookings; Kokoro must read it as stored, so she is told never to say it): a stored-format change with old files to read; the "never tell them a booking's status" clause goes with it. | proposed, not agreed (a design question) | From booking-check's Deferred entry and booking-say's review (2026-11-15). | — |
| **The Languages section's example names a mark the view no longer shows** (src/core/languages.js:91, "a plan item marked fixed is one that can't be moved"; plan rows now say "can't be moved" themselves): replace or drop it, with real runs (it was measured to move Opus). | not started | From the 固定 re-review's second opinion (2026-11-14). | — |
| **Koe (Sonnet) takes back a correct booking answer** at the next line (「…確認が取れていません」), on main too, not from the booking's fields. | not started (look into) | From the 固定 re-review (2026-11-14), one run of the builder's; main's control run did the same. | — |

### From chief's audit and notes (2026-11-16)

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **A design check of the Undo line's placement** (every round of undo-card and undo-f1 landed in the partway end and `turn.node`): whether one record the loop writes at the take-up (loop.js `#handover`) can let `turn.node`, its reset and the partway branch go and cover the Deferred entry's shapes. | not started; before any further change to that part, by a fresh agent (RULES, "Step back when findings repeat") | undo-f1-rereview.md (the step back); docs/limitations.md, "The Undo line misses what a turn writes…". | undo-card and undo-f1, 2026-11-14 to 17 |
| **When annai wakes Shiori by itself, and not on app resume**: the user sees her woken and going straight back to sleep. | investigated (wakes-audit-report.md, counts only): nothing wakes her on resume (a catch-up wakes only when a watch fired or a notification was opened while away; 0 in 26 days); the last 7 days: 99 turns, $7.55, 43 not the user's own line, 11 of them only slept ($0.62); the sleeping shape the user sees is mostly Kokoro's cue after Koe answers, shown only in Trace; 98% of spend is Kokoro, and cold caches are 43% of hers (the wrong leave reminder alone woke her cold for $1.42). Proposals: defer Kokoro's wakes nobody waits on while her cache is cold; a restart wake only for the user's words or a cut turn. The main session's recommendation: change nothing now, fix the leave reminder (the leave-far row), and decide with a week of the trip's trace | — | the user, 2026-11-16 ~20:55 PST: "also, maybe let's not auto wake on app resume? when will we auto wake shiori? currently it looks like everytime auto wake shiori just choose to sleep again?" |
| **Shiori compacting her own context** (Kokoro has no tool for it today; compaction runs by itself at 70% of the context window, and from the conversation's menu: Summarize now, Start fresh). | not started; a design question first (what she would gain, what a compaction mid-task loses, the prompt cache) | src/core/agent/loop.js (`compaction.threshold` 0.7). | the user, 2026-11-16 ~20:55 PST: "also for compact, does kokoro have way to call the compact tool? should we let shiori able to optimize her own context?" |
| **A cost display with ranges** (a day, 7 days, a month, all time), across trips: today the cost shows per trip ("This trip so far", in Details and the conversation's menu) and per call in Trace, and a daily budget can be set in Settings → Models. | not started; design (where it lives on the new home, which ranges) | src/core/agent/budgets.js already sums model.turn costs per day. | the user, 2026-11-16 ~20:55 PST: "also seems like a good idea to have a cost display available to be checked somewhere? like 1d 7d 1m total or similar ranges" |

### The next version: the Deferred entries, in builds

The current scope is released (b6db88d4), so the next version starts (RULES: a deferral is planned work, built in the next version).
The entries are grouped into builds by the code they share; each build's entries are named in docs/limitations.md by their headings.

| Part | State | Where it stands | Entries |
|---|---|---|---|
| **Screens after stage 8** | under review (branch screens-next, a4f5b936: all five built, check 5325/5325, e2e 986 with the 34 load timeouts passing on rerun; a Fable final review and four Haiku slices, 2026-11-17). The builder's call: the whole top (where you are, chips, Driving) heads every tab of an Itinerary with no today tab; the user's phone check decides | brief and report in the `.superpowers` notes (screens-next-*) | a cold load at `#/now`; Driving only from today's tab; a share's add failing after leaving; the share add twice; Driving missing a card |
| **Leave, running late and carriers** | building (branch leave-next, an Opus xhigh builder, 2026-11-17): the design check's option 1 | the design check (`.superpowers` notes, leave-design-check.md): keep the design, no stored arrival place. Built now: a stop a flight away from where a carrier leaves isn't wiped by it (A1: the stay sorted before the flight in); a flight's or train's running late ends when it departs (A2); one table of kind words (an item's own known word decides, ferries, buses and coaches are carriers); a flight item with no end takes its booking's; a stay's arrival until check-out; a flight item with no coordinates; the leave line beside the arrival in one catch-up. Next: the skill line timing a check-in item when the traveller gets there, after a real-model run. After the trip, with the trace's speeds in flight: a position in the air (the delayed flight, the cap crossing, the Driving strip's two flight entries). R2 is question 5 below. | the leave reminder beside the arrival; a delayed flight; ferries, buses, coaches; the kinds `lodging`, `flight`, `rail`; a non-flight linked to a flight; a check-in 3 hours late; a flight item with no coordinates; "Leave soon" before the flight there; the Driving strip's two flight entries |
| **The Undo line** | waiting on its design check (row above) | — | the Undo line misses what a partway turn writes |
| **Turn records in the loop** | not started | — | a line typed into her `wait`; tool results' `end` and `awake`; the restart carrying an older hand-over (it reads the hand-over the Undo check looks at: after that check); her reply to the "you haven't answered" cue |
| **Languages** | not started; live runs in Japanese | — | the real-voice check in English; the recap's native-speaker sentence; summaries' two ways; Koe's line before a tool; Kokoro's notes to Koe in English |
| **Words and names** | not started | — | the testing docs' "Realtime"/"Classic"; plugin errors in lower case; the translation pass's second look; an old flight's place and six details; OpenAI's and Groq's speech names |
| **Small fixes** | not started | — | the search order's two rare ways; a 408; Test's two upload readings |
| **The gate under extreme load** | building (branch gate-load from main, an Opus xhigh builder, 2026-11-17) | brief and report in the `.superpowers` notes (gate-load-*) | the scaled-clock unit tests |

### Standing

| Part | State | Where it stands |
|---|---|---|
| **Deferred work** | open | `docs/limitations.md`, every entry with "Kind: deferred". The ones planned for the next version are grouped in the section above; the rest (photo encoders, `item.says`) have their own rows. |

## Waiting for the user

- **Your checks, in this order** (chief's order of work, 2026-11-16; the list grows as the current scope ships):
  1. **Test on OpenRouter's key** (the one from "Sign in with OpenRouter"; live since c5cdc623): tap its Test. It should pass every step, the photo's upload included.
  2. **The answered-card check** (live since 78006090): an answer to her question card always gets a reply; a turn cut short is taken up when the conversation is opened again.
  3. **After the release of 2026-11-17 (b6db88d4)**, on your iPhone (the phone look of stages 4 and 7 is done: "yes timeline looks fine", 2026-11-16):
     1. The new top: no top bar; home's head holds Trace and the gear; Settings and Trace have "← Trips"; the top sits right under the status bar (the installed app and Safari; a long conversation; home with a card stuck in its box).
     2. Trips ahead have a lighter tint than a trip happening now: look outdoors, in light and dark.
     3. A conversation's name is its heading; + starts a trip (the Start a trip form is gone).
     4. Driving: on a trip happening today, its Itinerary's today tab has the Driving button at the top (Driving also opens by itself when you move fast with GPS on).
     5. The text box's caret: (a) open the app, don't scroll, tap +, type: the caret blinks in the box; (b) scroll home to its middle, tap +, type; (c) keep typing until the box wraps to a third line: the caret stays in the box; (d) in a long conversation, the keyboard button, type three lines; (e) on a booking, "Ask Shiori about this".
     6. Leave reminders on the trip: none for a hotel; a flight's leave reminder aims to have you at the airport 2 hours before it departs, and "Running late" only when you'd reach it under an hour before; long drives counted at 50 km/h for the first 30 km, then 80. Tell Shiori or me of any reminder at a wrong time.
     7. Shiori's off-plan nudge (you are away from what the plan has now) comes only in an item's first hour.
     8. After you hand files to Shiori, the Undo line sits under her lines; Undo tapped while she works shows no "can't reach her model" card.
  4. **The pre-trip page** (38 lines to tick on the phone), with its 8-day reminder line on your second iPhone: see its row.
  5. **After the release with the old-booking round:** open your real trip's bookings: every booking saved before 2026-10-29 and never confirmed now shows "Check N details" (5 for a hotel, more for a flight with many details) with a light check by each detail, and Shiori may say a detail may not have been read right until you tell her; tell her which are right ("it's all correct" clears a booking's checks: run 2026-11-16, English and Japanese, one each).
  6. **After the release with the provider names:** on your iPhone, open Settings → Models → Main's picker, closed and open: do "OpenRouter / Anthropic: Claude Opus 5.5" and "Anthropic / Claude Opus 5.5" stay apart in the list iOS draws (the review couldn't check the iOS list)? And type a few lines in the new text box with the keyboard up: does five lines leave enough of the conversation in view? And the small label under her lines: with Koe and an OpenRouter model it now takes two lines (a fallback's, three); checked at 375 and 393 px in a test browser, nothing clipped or overlapping (`.superpowers` notes: label-wrap-report.md): fine to you?
  7. **After the release with Koe's "can't be moved":** a booking's own times (a hotel's check-in and check-out, a flight's arrival, when no plan item of Shiori's stands for them) show no ● or ○ on the Itinerary, where they showed ● "Fixed"; a plan item Shiori saved as fixed keeps ●, its check-out or arrival too. Koe no longer says "can't be moved" about them. If you want ● back on bookings' own rows, say so (the main session's reading of your pick "Only what was said fixed", 2026-11-15; the option you saw spoke of Koe's view only).
- **Your real trip's data, from the plan check** (your OK, 2026-11-16): a few things to fix with Shiori before Friday; the list is on this machine (`.superpowers` notes, plan-check-report.md), given to you in chat.
- **The request to GitHub Support to purge the old history** (your answer "Yes, draft it (Recommended)", relayed by chief 2026-11-17 00:09 PST): drafted on this machine (`.superpowers` notes, github-support-purge-draft.md); you read it and send it from your own account; chief gives you the text.
- **A LESSONS.md line from stage 8's final review?** (LESSONS.md changes only with the user's OK.) The review proposed "when a shared way out goes, check every drawn state of every screen, not every route" (the shared-files screen lost its only way out with the top bar). Options: Leave it out (Recommended: it is a review habit, not a design lesson, and the fix and its test are in); Add it to LESSONS.md. Nothing waits on it.
- **Four proposed known limitations from the leave reminders' re-review** (each its own question; the merge doesn't wait on them; until answered they stay open findings):
  1. **A stay reached later than its check-in, with no position near the trip** (live mode off, or the phone a flight away): a short flight to the stay, or a stop elsewhere first, makes the next item's leave reminder come hours early, naming a long drive ("… About 455 min by car"); never late. Fixing it means storing a check-in time as an earliest time, not an appointment (a design change). Options: Accept as a known limitation (Recommended: early, never late, only with no position near the trip); Fix it now.
  2. **A train into a city station, or a change between two airports, under 2 hours, is read as a connection**, so the second flight gets no leave or running late. A plan item stores one place, so annai can't tell an airport station from a city one. Options: Accept as a known limitation (Recommended: rare, and the data has no arrival place today); Fix it now (needs an arrival place on items).
  3. **Crossing into the 1000 km cap**: a position more than 1000 km out, mid-air on a flight missing from the plan, or on a road trip over 1000 km, gets no leave reminder until it comes within 1000 km; then "Leave soon" with no minutes. Options: Accept as a known limitation (Recommended: the cap is what stops the reminder you got about the hotel); Fix it now.
  4. **A flight after a flight, with the phone closed, gets "Leave soon" when the first lands** (half an hour before the 2-hour aim, floored at the landing): a false alarm at a same-airport layover, useful if you left the airport. A connection too short for the 2-hour aim gets nothing, by design. How each lands on your own trip: the main session tells you in chat (the plan check stays on this machine). Options: Keep as built (Recommended); No leave reminder for a flight that follows a flight without a position (a miss if you left the airport).
  5. **An item at your destination timed before the flight that gets you there** (the Deferred entry "A closed annai can say 'Leave soon' for an item at the destination…"; the re-review's R2): with the phone closed, annai can say "Leave soon" for it before you have flown. The design check (2026-11-17) recommends no look-ahead: it adds rules to the part that took four rounds, and for a real appointment the push is true (you will miss it). Options: Accept as a known limitation (Recommended); Build the look-ahead (the next fixed flight or train after the item, held until it lands).
  The design check also recommends accepting 1 to 4 as worded (route option 1), and adds to 3: "Running late … About 1053 min away" comes with the "Leave soon" on crossing in.
- G8, once it has a plain account: see its row.

## Closed

- 2026-11-17: nearby says when OpenStreetMap's answer was cut at 400, and names the circle to ask again (half the circle cut, which came whole; half the radius asked would repeat an inner cut), and says when Wikipedia didn't answer with no pack to fill in (nearby-cut: a Fable final review, two fix rounds of words and tests, re-read; merged d08af8ea), chief's decision "Accept, and nearby says when its answer was cut (Recommended)" (2026-11-16); the next release. Wikipedia's 30-article cap ruled Not an issue for the line (it speaks of OpenStreetMap's places; geosearch returns the nearest first).
- 2026-11-17: the design check of how leave and running late stand in for the traveller's position (a fresh Fable high agent, read-only): the part is needed, piece by piece; a stored arrival place adds state and a new miss, so the main session took its option 1 (keep the design, fix A1 and A2, a kind table; the rest accepted or after the trip), building as the "Leave, running late and carriers" row; options 2 (store where a carrier arrives) and 3 (drop the stand-in) not taken: say so to reverse.
- 2026-11-17: the spec's "Also removable": the `/waiting` branches and `start_trip`'s no-trip branch (stage 7), `swipeTabs` with the tabs (stage 8, released b6db88d4); hand-over's back-to-waiting Undo kept for hand-overs made before the update (the re-plan's proposal; nothing removed it).
- 2026-11-17: "Where are you?" got its new home with Now gone: the GPS problem card's "Say where you are" opens Driving (stage 8, released b6db88d4).
- 2026-11-17: timeline stage 8, the top bar, its tabs, Now and the Start a trip form gone, gear and Trace at home's top, "← Trips" ways back, the conversation's name its heading, trips ahead a lighter tint, the e2e rewrite (2A, 2B), with its follow-ups (merged aff3a025, bb576711), the user's pick "Before the trip" and their "yes it is fine removing the now" (2026-11-16); released b6db88d4 (BUILD 92505a23bf28; smoke 10/10; whole e2e 1934 passed, 0 failed; check 5323/5323). The phone checks are in "Waiting for the user".
- 2026-11-16: the phone look of stages 4 and 7, "yes timeline looks fine" (~20:20 PST); their idea for trip colours is its own row.
- 2026-11-17: the Undo line after a hand-over follows the turns that carry it (undo-card, merged cbf0ab13), with its follow-ups (undo-f1, merged 749f2c90); released b6db88d4. The older partway shapes are one Deferred entry, behind the design check row.
- 2026-11-17: the off-plan wake's time range (no end invented, a next-day end names both days, the wake only in an item's first hour, the reminders' own words when they fire) (offplan-range, merged 2026-11-16); released b6db88d4. The first-hour rule is on the user's checks list.
- 2026-11-17: leave and running late timed only for a trip driven or walked: none for a stay, none past a flight or train before it lands, none from farther than 1000 km, a flight's leave at the airport 2 hours before and running late under 1 hour, 50 then 80 km/h on long drives (leave-far: four fix rounds, merged 341a73c5), the user's report and picks of 2026-11-16; released b6db88d4. Its design check is its own row; four proposed known limitations wait for the user.
- 2026-11-17: the dock text box's caret below the text after + on the iPhone (dock-caret, merged 33f21f84; the cause inferred, not proven on a device); released b6db88d4. The user's phone check (five steps) decides.
- 2026-11-17: the gate green with the clock inside the trip days and after (trip-clock, merged 9bb10613); released b6db88d4.
- 2026-11-17: released b6db88d4 (BUILD 92505a23bf28): pushed 087220fe..b6db88d4 (71 commits) on chief's OK after the pre-push hook passed; smoke 10/10, errors 0; gate: check 5323/5323, whole e2e on fa49056b 1934 passed / 2 flaky / 0 failed, voice and live e2e on the final tree 92/92; CI 44076283818.
- 2026-11-16: the push check reads added paths, gzip text and non-text files (machine-only hook; chief's direction).
- 2026-11-16: the public history rewritten and force-pushed on the user's word, the CI runs on rewritten commits deleted on their word; the GitHub Support purge request drafted (waiting for the user).
- 2026-11-17: the old commit ids in the docs mapped to the rewritten history (97 ids, 7 files, 9724bd97); pushed with b6db88d4.
- 2026-11-17: the Undo line's follow-ups (move records carry her turn's wake; one Shiori's Stop tells Koe nothing; the reload test waits for turn.end; a partway end no longer lifts the line) (undo-f1, merged 749f2c90); released b6db88d4.
- 2026-11-17: the live-mic flake was a real bug: Koe's second urgent reply lost to the music when the provider cut her first; the mark now waits 8 s from the cut, never past the note's 20 s (live-mic-flake, merged 311e1c6f); released b6db88d4. The scaled-clock tests that fail only far past the host's CPUs are one Deferred entry.
- 2026-11-16: the model label under her lines with the provider's name, checked at 320 to 412 px in WebKit and Chromium (chief's direction, from a side agent's note): it wraps to two lines with Koe and an OpenRouter model, cleanly, nothing clipped, no fix proposed (label-wrap-report.md); whether two lines suit is on the user's checks list (item 6).
- 2026-11-16: nearby online (Build D): it waits for Overpass and says "busy" at once, falls back to overpass-api.de's own backends, VK's server behind a switch, off (released 78006090), then the lighter nearest-first query, a chain of circles half the radius apart with a 64 MiB maxsize (merged 196d15e7, released ad9e22b4; BUILD 054a7d26b06d). The user's picks "Allow light probes (Recommended)", "VK behind a switch, off", "Fall back to its backends (Recommended)", "Plan the lighter query (Recommended)" (2026-11-14). Its two questions answered by chief's decisions (2026-11-16; the user may reverse them): the wait (about 35 s) and the cut at 400 are known limitations, the cut with the follow-up row above. The history is in the `.superpowers` notes (nearby-*).
- 2026-11-16: what Shiori tells about a booking's check (booking-say, rounds 1 to 4: the screens' own check in what she reads, an old booking read as one with every part marked, the chip counting what the details draw), the user's picks "Fix at the source", "Keep as built" (2026-11-14) and "Build the route as one round (Recommended)" (2026-11-16); rounds 2 and 3 released c5cdc623, round 4 released ad9e22b4 (BUILD 054a7d26b06d; smoke 10 of 10; CI run 44000555372 green). Its follow-ups: the Deferred entry on an old flight's place and six labelled keys.
- 2026-11-16: Koe says "can't be moved" only for a plan item Shiori stored as fixed, and a booking's own rows show no mark (koe-fixed), the user's answer "Only what was said fixed (Recommended)" (2026-11-15); released ad9e22b4 (BUILD 054a7d26b06d; smoke 10 of 10; CI run 44000555372 green). The user's look at the Itinerary's marks is on their checks list.
- 2026-11-16: the provider's name before a model's name, "OpenRouter / Anthropic: Claude Opus 5.5" (model-provider), the user's ask of 2026-11-16 ("for the models, maybe put the provider also before the model name?"); released ad9e22b4 (BUILD 054a7d26b06d; smoke 10 of 10; CI run 44000555372 green). The OpenAI and Groq names and two same-named providers are Deferred; the iPhone picker look is on the user's checks list.
- 2026-11-16: the dock's text box takes several lines (return adds a line on a touch screen; Enter still sends on a desktop), and "Thinking" while Kokoro works (dock-box), the user's asks of 2026-11-16; released ad9e22b4 (BUILD 054a7d26b06d; smoke 10 of 10; CI run 44000555372 green). The five lines with the keyboard up are on the user's checks list.
- 2026-11-16: OpenRouter photo uploads (a photo uploaded once and referred to by id; annai deletes its files after 48 hours), with its follow-up (the chat upload's 120 s limit, Test's upload read as the first step reads it), the user's ask (2026-10-16, "they also have file api") and picks (2026-11-14, 2026-11-15); merged 0e673169, released c5cdc623 (BUILD 1636cae43086, 2026-11-16; smoke 10 of 10; CI run 43945719291 green). The user's Test on the Sign-in key is in "Waiting for the user". The history is in the `.superpowers` notes (openrouter-uploads-*, openrouter-f1-*).
- 2026-11-15: timeline stage 7, the opening rule, `me` read-only, the no-trip paths out, with the hand-over's "Waiting with Shiori" chat (branch stage7, merged edd5da9f), "Last chat if recent, else timeline (Recommended)", "Read-only row (Recommended)", the waiting chat "Ask you first (Recommended)"; released c1ad0381 (BUILD ba1737ce08ae, 2026-11-15; smoke 10 of 10, CI run 43711857560 green). The phone look stays open above.
- 2026-11-15: a booking's check words name the part Shiori is unsure of, and an unsure booking time in a plan row says so (branch booking-check, merged 0aeb2cd1); released c1ad0381 (smoke 10 of 10, CI run 43711857560 green). Its two Deferred entries are the booking-say row.
- 2026-11-15: provider words, part 2: the model tools' names in the traveller's language (branch words-names, merged 70bc00d2), the goal "how people will actually say"; released c1ad0381 (smoke 10 of 10, CI run 43711857560 green); step 1 released 78006090.
- 2026-11-15: an edited profile's "- Language: English" line removed at start when the languages Shiori is told hold no English (branch profile-lang), "Drop it when it contradicts (Recommended)", "Keep as built"; released 78006090 (BUILD a389d389686f, 2026-11-15; smoke 10 of 10, CI run 43693098540 green).
- 2026-11-15: 「固定」 and 「未確認」 at their source (branch kotei: what a plan item's `fixed` and a booking's check mean, not the field's word), "Fix at the source (Recommended)", "Only say what can't move (Recommended)", "Keep as built (Recommended)"; released 78006090 (BUILD a389d389686f, 2026-11-15; smoke 10 of 10, CI run 43693098540 green).
- 2026-11-15: the strings tool and a plugin manifest's changed English (branch strings-stale: a carried draft blocks the check; providers' tool words translated), "Block until rewritten (Recommended)", "Release as is (Recommended)"; released 78006090 (BUILD a389d389686f, 2026-11-15; smoke 10 of 10, CI run 43693098540 green).
- 2026-11-15: the shared lesson on a newer file's unknown fields (a reader left installed skips them, from the first version), "Add it (Recommended)" (agent-rules ec210ea).
- 2026-11-14: the shared lesson on marking your own records gained "where what you leave never expires, a listing by that mark is the record of what to delete", "Add the clause (Recommended)" (agent-rules 9c2f441).

- 2026-11-14: the shared lesson on fields sharpened again, a field's meaning only where its value is news, "Sharpen it (Recommended)" (agent-rules 910c37e).
- 2026-11-14: an answered question card always gets a reply, route A step 1 (the two faulted parts taken out; 1fc7cba3, docs e54d1326 and 1732caad), "A: remove 2 parts, then record (Recommended)". Released 0bf607d7 (BUILD ebb452279fa3), smoke 10 of 10, CI green (run 43662020214).
- 2026-11-14: the shared lesson on quoting words sharpened to fields shown by name, "Sharpen it (Recommended)" (agent-rules affe346).
- 2026-11-14: Gemini Live's key in the WebSocket address: a known limitation, "Known limitation (Recommended)" (c5121795).
- 2026-11-14: the 2026-11-07 Calls-to-confirm page's rows stand as built, "Let them stand (Recommended)" (G8 stays open above).
- 2026-11-14: the voice modes keep the names "Live / Chat" (renamed 2026-11-05 without a pick), "Keep Live / Chat (Recommended)".
- 2026-11-14: the later and "not now" items stay as planned rows, "Keep as planned rows (Recommended)".
- 2026-11-14: Remote trace's page "does not open" (reported 2026-11-08): the user says it opens now, "It opens now".
- 2026-11-14: the iPhone volume limitation approved 2026-11-11 ("Yes, with a help line (Recommended)") written into docs/limitations.md (861d2204).
- 2026-11-14: Japanese and Chinese rewritten to read native (both Chinese scripts; Traditional written for Taiwan); Shiori's answers in the traveller's language; an answered card is always read (ask-sleep); ~40 English lines made true. Released 0e567c5c.
- 2026-11-14: Koe's 「少々お待ちください」: accepted, "Accept it (Recommended)".
- 2026-11-14: the zh Now tab stays 现在 / 現在, "现在 / 現在 (Recommended)".
- 2026-11-13: the spoken yes to annai's card: the card is answered by tap only (46b21d3d); branches empty-heard and card-20s dropped with it, "Keep tap only (Recommended)".
- 2026-11-13: spec §4.8 uploads: the spec corrected to what is built, "Fix the spec (Recommended)".
- 2026-11-11: timeline stage 6, moving, redesigned as annai's card (b233a39d, released 2026-11-11), "She asks, I tap or say yes (Recommended)"; branch stage6's rounds 2 to 7 dropped with that pick.
- 2026-11-10: timeline stage 5, reading another trip (merged e5f146c6, released).
- 2026-11-09: timeline stage 4, chats, +, the timeline (a379a5f7, released 2026-11-09); its sticky box opens a stuck card in place (2614b37a); the timeline branch's sticky-box commit 51f20987 dropped with that option.
- 2026-11-08: timeline stage 3, conversation address, header, Next, Details (released 5ada211d).
- Before 2026-11-08: timeline stages 1 and 2, itinerary and trip in play (released).
