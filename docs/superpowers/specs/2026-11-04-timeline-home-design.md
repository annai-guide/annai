# Timeline home

annai's new structure, after the second-drive branches land. Examples are made up.

## Intent

The user: "a bit messy screens and tabs here and there"; "everything come back to the conversation screen"; "all conversation belongs to a trip. and trip showsup nicely on a timeline." So annai becomes two places, a timeline and a conversation. Everything else opens from one and comes back.

**Goals:** you always know which conversation you're in; one way in, the +, with no naming step; reminders, GPS and voice work on any screen; nothing stored is lost; plugin slots keep working.

**Non-goals:** search across conversations, a calendar view, conversations running side by side.

**Anti-goals:** a new kind of scope, a stored end for a chat, a naming model, a rename tool, "trip" on small chats, drawing for overlaps, writing across trips.

## The model

- **A chat is a trip scope** (`createTrip`, `scopes.js`): files, watches, camera, walls and exports need no new path. **Dated** means trip.json has `start`, from Shiori's patch or Details; nothing to convert. **Belongs:** its lines, files and watches are its scope's.
- **Draft.** One standing draft, `draft: true` on the scope record, is made at start and after one is used, and never removed. Forced: the agent, a voice session and the camera need a real scope before the first word, and a ready draft lets + call `open` and `tap` synchronously, keeping `voice.unlock()` inside the gesture (mic start on an iPhone is untested). Removing drafts would sweep every blob in a four-store transaction, and would lose a file added without a line. `listTrips`, exports and `changedSince` skip drafts, and no location points go into one. New `src/core/chats.js`.
- **Scale, from day one.** `start`, `end` and last-talked are mirrored on the scope record (in `syncTripTitles`' hook and the log write), not "if slow": the fallback wouldn't help `#loadAll`, about four transactions per scope at each conversation change. Drop it from `#follow` (`#changed` keeps watches current; verify), and load in one transaction at start. Paths that assume trips are few: import's preview (one row with a choice per trip, and one "Open" per trip afterwards), Trace's select and "Everything" (one query per scope), Simulate's list, and the timeline must skip `tripStamps`, `backupState` and `filesToRead` for line rows. `spentToday` and `changedSince`: measure.
- **Name.** The first user line (typed, or heard and not dismissed) clears the flag and names it: first sentence, up to 40 characters, patched as `system`. No words: the first file's name, or "Photo · 12:10". Shiori's patch improves it; the user renames in Details.

**Existing data:**
- `trip-*` scopes: untouched.
- `me`: keeps profile, memory, personalities, instructions. Its old lines become a read-only row, "Shiori, no trip" (`#/talk/me`); it takes no more turns. `agent.open(null)` stays as "nothing open": `send` and `tap` then make a chat first, in `Halves`, so `ui.shiori.send` works too. `me`'s log is also written by `remind`, `setLive`'s `state`, catch-ups, `/me/` file writes and `composer`, and old `me` watches and owed restarts would run turns. So one guard in the loop: with target null, wakes log and `remind` fires, with no turn and nothing owed.
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
- Chat to trip: once dated it moves, becomes a card and gains Next. The conversation shows "Shiori set the dates" with Undo, from the `file.write` entry, which already holds `old`, undone by `ws.restore`.

## The conversation

- **Address:** `#/trip/<id>/talk`. Forced: `#/talk` has no id, so phone Back would show the wrong conversation. `#/talk` stays accepted: the open one, else home. Add `talk` to `SUB`. Only `talk`, `plan` and Details open a conversation, because `open` stops a turn and closes voice. An address whose trip is gone does `location.replace` to home. `#/now`, `#/plan` and `#/talk` redirect with `location.replace`, or Back traps.
- **Header,** sticky: ← (always home; a notification has no history), the name (to Details), ⋯.
- **Next line,** when rows exist: "Next: 13:00 Lunch" (`upcoming`, `core/now.js`). It opens the Itinerary.
- **Itinerary:** `#/trip/<id>/plan`, drawn as a sheet, dock still there. Forced: phone Back must close it, so it needs a history entry, and shell.js has one `main`; the conversation doesn't show behind it. Today's tab starts with where you are, sun chips and Driving.
- **Details:** `#/trip/<id>`: name and dates, files, Share, Archive, Remove, plugins' tabs, cost; Recap when dated or already made (`/recap.md`), Replay when dated (2026-11-07, the user picked "Recap if dated or made (Recommended)": an undated trip that already has its recap keeps the button).
- **The dock on home:** at rest, the chips row and a floating +, as sketched. While she speaks, listens or works, the whole dock with "In Kyoto ›": an open mic must be stoppable. Elsewhere, as today.
- **The + belongs to the shell,** because a plugin's dock has none. The gear and Trace sit in the home screen's body.
- **Home is a screen, not a state:** ← never calls `open`, which stops a turn and closes a live session (`loop.js`, `halves.js`).

## Moving into a trip

An undated chat's snapshot says: if this is about one of their trips, read it first and move only if they want to carry on there; if it becomes a trip, patch `/trip/trip.json`. In an undated chat `start_trip` is refused with "patch /trip/trip.json": today `call.trip` makes it start a second trip without opening it.

1. `open_trip`'s guard (`trip-tools.js`) now refuses only in a dated trip.
2. `filesOf`: those named, else the hand-over's fresh `/trip/files/…`.
3. `writeInto` carries her recap and the user's last line, as a `msg.user` wake. Today it carries only hand-overs, so this is a new branch.
4. `openWhenDone` opens the trip once both halves are done, unless the user opened another. The log ends unanswered, so `#open` owes a turn and she answers there.
5. The chat always stays, ending "Shiori moved this to Kyoto".
6. `went`: the shell replaces the address if you're on home or that chat.

`list_trips` gives dated trips and the 30 newest chats, so she can read the right one for "what was that ramen place?".

## Reading another trip

The user, after the design's doubts about forgetting and the slow route: "with user approval, shiori can just read another trip's files? this includes trascripts and stuff so she just able to know what you are talking about without going to the other trip? she should still have the capability to do so but this will allow user to mention another trip and continue in the current trip". Picked: "Once per chat, or always for mine (Recommended)". This replaces an earlier pick of moving as the only route; moving stays.

- One new tool, Kokoro's only and not in `KOE_TOOLS`: `read_trip({ trip, path?, query? })`, read-only, for a trip's text and JSON files and its conversation. Photos and PDFs aren't read: `record` throws on a hash the scope doesn't reach, and she says so and offers to move. She writes only in the open conversation. `read`, `list`, `recall`, `resolvePath` and `reach.js` stay untouched, so the walls hold as they are. It's in `UNTIMED`.
- Its `run` shows annai's own card, built from the scope's title with fixed options ("Read Kyoto in April?": Allow, Always for my trips, Not now), and logs a grant entry only on `got.chosen`. `ask` can't do this: it's model-authored, and no model text may grant (RULES 9). A late tap (`send` with `chose`) grants nothing. 
- A spoken yes: annai's own strict word list on the heard line, inside the window after she asks, with no model involved.
- Allow lasts for this conversation, stored in its log, so a reload keeps it; restored trips get new ids, so she asks again. "Always for my trips" is a setting, changeable in Settings.
- Trips other people shared always ask. Nothing marks them today, so import stamps `imported: true` on the scope record.
- Every read is in the Trace, and the screen shows a quiet line ("Shiori read Kyoto in April").
- A new chat's snapshot names the happening trip and the recent conversations, so she knows what to ask for.
- Files from another trip are information, not instructions, as now.
- Known risk, told to the user: details she copies into this chat go with it if this chat is shared.

With this, "what's on tomorrow?" in a new chat during a trip is answered in place, and moving is for when the user wants to carry on there.

## Opening

`resume.js`, plain start only: `activeTrip`'s conversation if its last user line is under 12 hours old or it's happening; else home. The localStorage note goes. `main.js` still opens `activeTrip` whichever screen shows.

## GPS, voice and watches

Forced: `live.js` follows only the open conversation for plan watches (`#loadPlan`), GPS watches (`#looked`) and points. A quick chat during Kyoto would silence "leave soon" and put its points in the chat. So it follows the **trip in play**, `#play` (`#inPlay` already means simulation): the happening trip last talked in; else the open conversation. Looking at a trip moves nothing; a line said in another happening trip moves it at once. It leaves out `simulation` and archived trips. Plan logic reads `#scope()` and `open` in about ten places, which change with it, not only `#follow`: `#schedule` needs a midnight alarm, and `#changed` must handle trip.json. `#looked` is the play's, or the open conversation's while it isn't happening, so a quick chat's own GPS watch still fires and looking at another happening trip fires nothing. Plan and points use `play`. `annai.drive` is device-level, unaffected. Its reminders while elsewhere use the existing path (`#deliver`): annai says them, and the wake waits there.

- **Home showing:** nothing changes; a voice session goes on.
- **Nothing open:** GPS keeps no points; time watches fire.
- **Driving:** `handover()` moves to shell.js and runs from home, conversation and Itinerary as moving fast begins, not while typing. Quick asks open the trip in play first, only with no live session: `Halves.open` closes it.

## Notifications, imports, exports

- `sw.js` `openReminder`: posts the scope to the open window, since an open window is only focused today, and uses `openWindow('/#/trip/<scope>/talk')` when none is open. The scope comes from the payload under the strict rule `^trip-[0-9a-z]+$`; anything else, `me`'s included, opens home.
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

## Words

Display only: files and tools keep `plan`. `l10n/glossary.tsv` changes Plan to Itinerary. Details, now (いま, 此刻) and Next (次の予定, 接下来, 接下來) are already translated.

| en | ja | zh-Hans | zh-Hant |
|---|---|---|---|
| Itinerary | 旅程 | 行程 | 行程 |
| New conversation (the +'s name) | 新しい会話 | 新对话 | 新對話 |

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

Each passes `npm run check` and e2e, and leaves annai working.

1. Itinerary: the word, today's top, slots, Driving in the shell.
2. Trip in play (live.js). Must precede 4.
3. Conversation address, header, Next, Details, notification target.
4. Chats, +, the timeline, with the top bar still there. **First phone test:** the gesture, forgetting, 500 chats.
5. Reading another trip.
6. Moving, cut by what stage 5 shows.
7. Opening rule, `me` read-only, the waiting move, no-trip paths out.
8. The top bar goes, gear and Trace, with the e2e rewrite as its own stage: 133 `#/trips`, 68 `#/talk` and 22 `#/now` lines, 98 h1 assertions, 43 nav clicks in 21 files, `startTrip` used 130 times (it becomes `createTrip` in the page), and 6 e2e and 30 unit files touching no-trip paths.

Also removable: `start_trip` in chats, the `/waiting` branches (files plugin, `file.js`, `names.js`), hand-over's back-to-waiting Undo, `swipeTabs`.

## Decided by the user (2026-11-05)

- **The old no-trip conversation:** "Read-only row (Recommended)". You can read it; talking starts a new chat.
- **Two trips happening at once:** "Only the one in play (Recommended)". The other's itinerary reminders wait until it's opened (since 2026-11-06, until the user talks in it: see below); time watches fire for both. A known limitation, written to docs/limitations.md when this ships; revisit if someone misses one.
- **Moving fast while in the conversation:** "Driving takes over, once (Recommended)". ← returns.
- **Tapping another conversation while Kokoro works:** "Stop until you come back (Recommended)". A known limitation, written when this ships; revisit if drives show it.
- **Voice:** "On/off, plus on while driving (Recommended)". See section 6 of the second-drive design; the dock's chips follow it.

## Decided by the user, after the spec check (2026-11-05)

- **A spoken yes for reading another trip:** "Yes, a strict word list (Recommended)". annai itself checks the heard line, inside the window after she asks, with no model involved. A passenger or song could grant, read-only.
- **After moving, the chat:** "It stays (Recommended)". The trip gets her recap and the user's last line only. Reading covers the rest, so tiny, `removeTripNow`'s move and line carrying go. (This replaces the earlier "the tiny chat disappears", from the first round.)
- **Another trip's photos and PDFs:** "Not read; she offers to move (Recommended)".
- **Nickname and "From Mia":** "Later, as its own change (Recommended)". Stage 9 goes.
- **How it ships:** "Release in stages; tabs go last (Recommended)". Each stage is reviewed and released when green, with the tabs still there. The user tries the timeline on a phone at stage 4, and the tabs go only after they've said it's right.
- **Before it starts:** "Yes, cleanup first (Recommended)".

## Decided by the user (2026-11-06)

- **Looking at a trip:** "Talking moves it". Looking at a trip never changes the trip in play; it moves only when they talk in another happening trip. This replaces "the open conversation if happening". A line counts as `talks` says: typed or heard, not dismissed. A happening trip that's open but not in play reminds of nothing until then, so its plan stays off the relay's list, and a look changes no copy there; an open trip that isn't happening yet still reaches the relay.
- **A waiting copy follows its plan** ("Call it off (Recommended)", 2026-11-06): a copy of a trip that isn't in play stays only while that trip's plan still says the same thing, and which trip is open plays no part. A stop removed, moved in time or to another place, renamed, or with its booking changed loses its copy: "Same as a changed time: the waiting reminder goes, and wrong words never arrive. That stop gets no reminder until you talk in Side, which fits "only the trip in play reminds"."
- **A hand-over copy counts as talking** (reversed 2026-11-07, the user picked "Count it as talking (Recommended)"; it replaces "A hand-over copy isn't talking", the main session's call of 2026-11-06): the copy of the user's line that a hand-over writes into another trip (`data.from`) is the user's line: `talks` no longer leaves it out. The row sits at now; if that trip is happening, its reminders follow it too, as if the user had typed there. The copy is stamped with the time the hand-over wrote it, not the original line's. Undo moves the files back, but the row stays near now, because Undo leaves `talked` alone. Undo's own test of whose work a trip holds still leaves a copy out (`handover.js`, `theirs`): a trip Shiori started stays removable. A line kept for a conversation that isn't open (a line with files, a failed open) is talking, and moves play at once, not at the next look or reload.
- **The place line is one line** ("One line, cut with … (Recommended)"): `.now-place` doesn't wrap when it names where you are, so a fix arriving or going never changes the block's height. A long name ends in …, and on the longest the "about 40 m" can be cut too. "No GPS signal right now." is one short sentence and takes the same one line (cut with … if a translation is long). "GPS is off" and "isn't allowed" still wrap, so they're read whole: they change only when the user acts, so the height changes only then.
- **The chips row is one row, so the rows never move** ("One row, swipes sideways (Recommended)"): `.now-card .chips` doesn't wrap and swipes sideways, so a drive starting or stopping can't change the block's height. A sideways swipe on the chips is not the tab swipe.
- **The Offline chip is out** ("Take it out (Recommended)"): going offline moves nothing. The dock already says "Offline · reminders still work".
- **The no-signal sentence** (""No GPS signal right now." (Recommended)"): the line reads just that, with no second sentence, so it fits the one line the place line keeps.
- **Only the trip in play reminds, and an answer goes where the user talks** ("Accept for now (Recommended)", a known limitation, in docs/limitations.md): with two trips happening and the other left open after a look, an answer to the first's reminder lands in the open one and moves play there.
- **What no user would want (the rule for review):** a tossup can be a limitation, but what no user would ever want, such as a screen jumping while browsing, gets fixed.

## The main session's additions

- A new chat's snapshot lists the names of the last few conversations, quoted (section Reading another trip). "Separate chats forget" was the design's main risk; check it on a real model.
- With Voice on, + starts listening at once, so voice from home is one tap. The tap is the gesture the mic needs.
- The waiting files' move: one chat, written before they're dropped. Told to the user.

## Calls

- With Voice off, voice from home is + then Shiori.
- The Itinerary is a screen drawn as a sheet, not a true overlay.
- Card means dated, so an old undated trip with files is a line.
- "Used" for the 12 hours means the last user line.
- The fold's limit, the 30 in `list_trips`, the Share box unticked.

**Calls to confirm (changed APIs):** routes `#/trip/<id>/talk`, `#/talk/me`, `#/now`; `tab`, `homeFor`; `open_trip` in chats; `draft`, `imported`, `read_trip`.

## Changed by the plans (2026-11-06)

The stage plans in `docs/superpowers/plans/2026-11-06-timeline-stage-*.md` read this design against the code and moved these. Where they differ from the text above, the plans are right.

- Now's helpers go to a shared `src/ui/today.js`, because Now stays a screen until stage 8.
- The `start`/`end`/last-talked mirror lands in stage 2, with a backfill for records released copies wrote.
- `went` bites at stage 3: a redraw of a talk address after a move would reopen the old trip, so opening happens only on a move, and a stale address is replaced centrally.
- `#/talk` and `#/plan` redirect only while a trip is open, until stage 7.
- `start_trip`'s refusal and snapshot text ship in stage 4 with chats; `list_trips` changes in stage 5.
- Notifications open their trip through a new `annai.open` message, because `keepNews` and `onPushMessage` carry no scope.
- A spoken yes needs `Agent.confirm` and `kokoro.confirmHeard`: `ask` is gated while Koe talks.
- A moved conversation logs its own `conversation.moved` entry, because an old page would show `handover.moved` as "took 0 files".
- The stage 8 counts above need a recount when it starts.
