# Timeline home

annai's new structure, after the second-drive branches land. Examples are made up.

## Intent

The user: "a bit messy screens and tabs here and there"; "everything come back to the conversation screen"; "all conversation belongs to a trip. and trip showsup nicely on a timeline." So annai becomes two places, a timeline and a conversation. Everything else opens from one and comes back.

**Goals:** you always know which conversation you're in; one way in, the +, with no naming step; reminders, GPS and voice work on any screen; nothing stored is lost; plugin slots keep working.

**Non-goals:** search across conversations, a calendar view, conversations running side by side.

**Anti-goals:** a new kind of scope, a stored end for a chat, a naming model, a rename tool, "trip" on small chats, drawing for overlaps.

## The model

- **A chat is a trip scope** (`createTrip`, `scopes.js`): files, watches, camera, walls and exports need no new path. **Dated** means trip.json has `start`, from Shiori's patch or Details; nothing to convert. **Belongs:** its lines, files and watches are its scope's.
- **Draft.** The + makes the chat at once, with `draft: true` on the scope record. Forced: the agent, a voice session and the camera need a real scope before the first word. One at most: + reuses it. `listTrips`, exports and `changedSince` skip drafts. Drafts go at start and when another conversation opens, only if the log shows no user line. New `src/core/chats.js`.
- **Name.** The first user line (typed, or heard and not dismissed) clears the flag and names it: first sentence, up to 40 characters, patched as `system`. No words: the first file's name, or "Photo · 12:10". Shiori's patch improves it; the user renames in Details.

**Existing data:**
- `trip-*` scopes: untouched.
- `me`: keeps profile, memory, personalities, instructions. Its old lines become a read-only row, "Shiori, no trip" (`#/talk/me`); it takes no more turns (Q1). `agent.open(null)` stays as "nothing open": `send` and `tap` then make a chat first, in `Halves`, so `ui.shiori.send` works too.
- `sys:waiting`: at each start its files move into one chat, "Waiting with Shiori", with a `file` wake so she reads them on opening. `moveFile` writes before it drops; a cut-off run resumes. A restored backup's waiting files, and an Undo whose chat is gone, go the same way.

## The timeline

`#/trips`. `phaseOf(trip, now)` lives once in new `src/core/timeline.js`; home, the opening rule and live mode share it.

| Row | Sits at | Looks |
|---|---|---|
| Undated | last user line, else created | one line: name, time |
| Past | its end, else start | card: dates, stamps |
| Happening | the now line, by start | tinted card: "Day 3 of 8", Next |
| Future | its start, below now | card: "In 2 weeks", her last line |

- Old to new, top to bottom, with day or month headings. Overlaps are just rows.
- Opens with the now line 40% down; Back restores your place (shell.js's `talk` exception extends to `trips`).
- Only dated trips sit below now, so one being planned stays right under the line, however many chats exist.
- Before the last 30 days, a month with over three chats folds to "October: 14 chats". Cards never fold.
- The foot: Archived (a fold, as today), Open a file, last backup.
- Empty: the now line, "Tap + to talk to Shiori", Open a file. Welcome ends here; its "bottom of every screen" line changes.
- Chat to trip: once dated it moves, becomes a card and gains Next. The conversation shows "Shiori set the dates" with Undo: a new `trip.changed` log entry holding the old hash, undone by `ws.restore`.

## The conversation

- **Address:** `#/trip/<id>/talk`. Forced: `#/talk` has no id, so phone Back would show the wrong conversation. `#/talk` stays accepted: the open one, else home. One rule in shell.js: any address under `#/trip/<id>` opens it.
- **Header,** sticky: ← (always home; a notification has no history), the name (to Details), ⋯.
- **Next line,** when rows exist: "Next: 13:00 Lunch" (`upcoming`, `core/now.js`). It opens the Itinerary.
- **Itinerary:** `#/trip/<id>/plan`, drawn as a sheet, dock still there. Forced: phone Back must close it, so it needs a history entry, and shell.js has one `main`; the conversation doesn't show behind it. Today's tab starts with where you are, sun chips and Driving.
- **Details:** `#/trip/<id>`: name and dates, files, Share, Archive, Remove, plugins' tabs, cost; Recap and Replay once dated.
- **The dock on home:** at rest, the chips row and a floating +, as sketched. While she speaks, listens or works, the whole dock with "In Kyoto ›": an open mic must be stoppable. Elsewhere, as today.
- **Home is a screen, not a state:** ← never calls `open`, which stops a turn and closes a live session (`loop.js`, `halves.js`).

## Moving into a trip

An undated chat's snapshot says: if this is about one of their trips, `open_trip`; if it becomes a trip, patch `/trip/trip.json`.

1. `open_trip`'s guard (`trip-tools.js`) now refuses only in a dated trip.
2. `filesOf`: those named, else the hand-over's fresh `/trip/files/…`.
3. `writeInto` carries the user's lines since her last turn, or all of them if tiny, as `msg.user` and `heard` wakes. Today it carries only hand-overs.
4. `openWhenDone` opens the trip once both halves are done, unless the user opened another. The log ends unanswered, so `#open` owes a turn and she answers there.
5. Tiny means undated, at most three user lines, no files left, no plan, bookings, notes or watches. It is removed as Remove does (`removeTripNow` moves to core). Anything else stays, ending "Shiori moved this to Kyoto".
6. `went`: the shell replaces the address if you're on home or that chat.

`list_trips` gives dated trips and the 30 newest chats, so "what was that ramen place?" moves you to that chat. `recall` stays inside its conversation; the walls stand.

## Opening

`resume.js`, plain start only: `activeTrip`'s conversation if its last user line is under 12 hours old or it's happening; else home. The localStorage note goes. `main.js` still opens `activeTrip` whichever screen shows.

## GPS, voice and watches

Forced: `live.js` follows only the open conversation for plan watches (`#loadPlan`), GPS watches (`#looked`) and points. A quick chat during Kyoto would silence "leave soon" and put its points in the chat. So it follows the **trip in play**: the open conversation if happening; else the happening trip last talked in; else the open conversation. `#follow` reads it at each open, trip.json change and new day. Its reminders while elsewhere use the existing path (`#deliver`): annai says them, and the wake waits there.

- **Home showing:** nothing changes; a voice session goes on.
- **Nothing open:** GPS keeps no points; time watches fire.
- **Driving:** `handover()` moves to shell.js and runs from home, conversation and Itinerary as moving fast begins, not while typing (Q3). Quick asks open the trip in play first.

## Notifications, imports, exports

- `sw.js` `openReminder` goes to `#/trip/<scope>/talk`, from the payload's `scope` under the strict rule `^trip-[0-9a-z]+$`; anything else, `me`'s included, opens home.
- Imports are rows by their dates. The Share target (`import.js`) offers dated trips and "New conversation", replacing "Start a trip first". Backups keep their format.

## Plugins

Additive, so `api` stays; `docs/plugins.md` and LESSONS.md change.

| Slot | Now |
|---|---|
| `now-card`, `ui:now-section` | top of the Itinerary's today, same arguments |
| `ui:trip-tab` | a button in Details, same address |
| `ui:screen` `tab: true` | a quiet row of links on home |
| `ui:screen` `homeFor` | shell's take-over; its crumb goes home |
| `ui.go('#/now')` | today's Itinerary of the trip in play, else home |

## Nickname and sharing

"What should Shiori call you?" (Settings → Shiori) edits the `- What to call me:` line of `/me/profile.md`. Forced: she must still change it when told, and a second store would disagree. Share mode in `export-panel.js` adds an unticked "Show who made it"; `exportArchive` writes `madeBy` into the shared copy's trip.json only. Rows and Details show "From Mia".

## Words

Display only: files and tools keep `plan`. `l10n/glossary.tsv` changes Plan to Itinerary. Details, now (いま, 此刻) and Next (次の予定, 接下来, 接下來) are already translated.

| en | ja | zh-Hans | zh-Hant |
|---|---|---|---|
| Itinerary | 旅程 | 行程 | 行程 |
| New conversation (the +'s name) | 新しい会話 | 新对话 | 新對話 |
| What should Shiori call you? | Shiori に呼んでほしい名前 | 希望 Shiori 怎么称呼你 | 希望 Shiori 怎麼稱呼你 |
| From Mia | Mia さんから | 来自 Mia | 來自 Mia |

## What goes

- Now (`renderNow`, `nowRow`); its helpers move to plan.js and drive.js.
- The top bar, tabs, swipes, `SECTION`, `lastIn`: about 95 lines of shell.js.
- Trips' Start a trip form, no-trip card and Waiting panel; `waiting-file`, `waitingHref`.
- The no-trip conversation: the `/waiting` root (`tools.js`), `waitingMedia` (`loop.js`), `reach.js`'s clause, handover.js's waiting text, composer's branches, the dock's "Open a trip first".

Estimated 300 lines out, 450 in, about +8 KiB: fewer places and concepts, not fewer lines.

## Risks

- **Scale:** per-scope reads (`#loadAll`, `spentToday`, `changedSince`, the timeline). Test with 500 chats; if slow, keep dates and last-talked on the scope record.
- **Forgetting:** a new chat knows only profile and memory, and starts a cold prompt cache.
- **Judgement:** wrong moves or early dates. Check on a real model.
- **Voice:** `open` closes a live session mid-move. Test on the fake realtime server.

## Stages

Each passes `npm run check` and e2e. Old routes stay, so e2e's 128 `#/trips`, 45 `#/talk` and 20 `#/now` keep landing.

1. Itinerary: the word, today's top, slots, `#/now`, Driving in the shell.
2. Trip in play (live.js). Must precede 4.
3. Conversation address, header, Next, Details, notification target.
4. Chats: draft, names, `trip.changed`, + on Trips, `list_trips`.
5. Moving into a trip.
6. Timeline, opening rule, gear, Trace (Settings and a dock chip). Top bar goes; `test/e2e/helpers.js` follows.
7. `me` read-only, the waiting move, no-trip paths out.
8. Nickname and sharing.

## Decided by the user (2026-11-05)

- **The old no-trip conversation:** "Read-only row (Recommended)". You can read it; talking starts a new chat.
- **Two trips happening at once:** "Only the one in play (Recommended)". The other's itinerary reminders wait until it's opened; time watches fire for both. A known limitation, written to docs/limitations.md when this ships; revisit if someone misses one.
- **Moving fast while in the conversation:** "Driving takes over, once (Recommended)". ← returns.
- **Tapping another conversation while Kokoro works:** "Stop until you come back (Recommended)". A known limitation, written when this ships; revisit if drives show it.
- **Voice:** "On/off, plus on while driving (Recommended)". See section 6 of the second-drive design; the dock's chips follow it.

## The main session's additions

- A new chat's snapshot lists the names of the last few conversations, quoted, so she can move the user to the right one. "Separate chats forget" is the design's main risk; check it on a real model.
- With Voice on, + starts listening at once, so voice from home is one tap. The tap is the gesture the mic needs.
- The waiting files' move: one chat, written before they're dropped. Told to the user.

## Calls

- With Voice off, voice from home is + then Shiori.
- The Itinerary is a screen drawn as a sheet, not a true overlay.
- Card means dated, so an old undated trip with files is a line.
- "Used" for the 12 hours means the last user line.
- Tiny's limit, the fold's limit, the 30 in `list_trips`, the Share box unticked.

**Calls to confirm (changed APIs):** routes `#/trip/<id>/talk`, `#/talk/me`, `#/now`; `tab`, `homeFor`; `open_trip` in chats; `draft`, `trip.changed`, `madeBy`.
