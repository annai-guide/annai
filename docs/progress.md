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
| **Stage 7: opening rule, `me` read-only, no-trip paths out.** annai opens by the new rule; the old no-trip conversation becomes a read-only row (talking starts a new chat); the files waiting with Shiori move into one chat; the no-trip code goes. | not started; planning | Plan `docs/superpowers/plans/2026-11-06-timeline-stage-7-opening-and-no-trip.md` (written before stage 6 was redesigned as the card). Being re-planned against main 5e2c6565 (2026-11-14): what is done, what the card made moot, the order beside the turn-end record. | "Last chat if recent, else timeline (Recommended)"; "Read-only row (Recommended)" (2026-11-05) |
| **The spec's "Also removable":** `start_trip` in chats, the `/waiting` branches (files plugin, `file.js`, `names.js`), hand-over's back-to-waiting Undo, `swipeTabs`. | not started | The re-plan says which stage removes each and which still exist. | the spec's Stages section |
| **Stage 8: the top bar goes**, gear and Trace move, with the e2e rewrite as its own stage (the spec's counts need a recount). | paused on the phone look below | Plan `docs/superpowers/plans/2026-11-06-timeline-stage-8-top-bar-goes.md`. | "Release in stages; tabs go last (Recommended)" |
| **The user's phone look of stage 4** (gates stage 8). | waiting for the user since 2026-11-09 | The 11-09 list: the half-screen box, More/Less in place, buttons at the edge, the Start a trip field with the keyboard up, Safari's bars. To be refreshed after the re-plan, as stages 5 and 6 changed the screens. "Release in stages; tabs go last (Recommended)"; the spec records with it: "The user tries the timeline on a phone at stage 4, and the tabs go only after they've said it's right." |

### Nearby places online (Build D)

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **`nearby` waits for Overpass, says "busy" at once; VK's server behind a switch, off.** Closes the deferred entry "Online, `nearby` rarely gets OpenStreetMap's places". | built; paused on the Overpass probe | Branch nearby-wait 1a74715f. The probe of the public Overpass servers (24 hourly runs) ends about 16:53 PST 2026-11-14. Next: set `OVERPASS_MS` (src/plugins/places/index.js:39) and `OVERPASS` (src/core/pack/osm.js:15) from all 24 runs; its new ja and zh lines to the style guides; review with second opinions; merge; release. | "Allow light probes (Recommended)"; "VK behind a switch, off" |

### An answered question card always gets a reply

Design check: route A (2026-11-14). The visible fix (an answer to her card always gets a reply) first, then the loop
records when a turn ends, so the reader stops guessing from her words.

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **Route A, step 1:** take out the two faulted parts (the wake give-back, the cut-ask exemption); the rare Undo shape (F2) recorded as deferred. | under review | Branch ask-owed: e17900f5 (the removal), cd354d02 (main merged in); check 5119 of 5119, e2e 234 passed. Next: the re-review with a second opinion (running), merge, full gate, release. | "A: remove 2 parts, then record (Recommended)" (2026-11-14) |
| **Route A, step 2: the loop records a turn's end** (one event type, one key); the reader reads it instead of words; `#settled` and the guessing rules go; F2 closes. | planning | Plan being written (2026-11-14), then a spec check, build, review, and a real check of a reload and an open in the middle of a turn. Writes the approved limitation below when it lands. | "A: remove 2 parts, then record (Recommended)"; old logs: "Treat as finished (Recommended)" (2026-11-14): once per update, a turn the old version left paused and not yet reopened isn't picked up |

### Shiori answers in the traveller's language

| Part | State | Where it stands | The user's words or pick |
|---|---|---|---|
| **An edited profile's "- Language: English" line is removed at start** when the traveller's languages don't include English (only that exact line). Also: the lessons entry marks the wait word settled; the glossary's Now note records the pick. | building | Branch profile-lang from 5e2c6565. Next: review with second opinions, merge, release (with route A step 1 if both are ready). | "Drop it when it contradicts (Recommended)" (2026-11-14) |

### Standing

| Part | State | Where it stands |
|---|---|---|
| **Deferred work** | open | `docs/limitations.md`, every entry with "Kind: deferred" (12 on 2026-11-14). Each is planned for the next version; none is repeated here. |

## Waiting for the user

- The phone look of stage 4 (gates stage 8): see its row.

## Closed

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
