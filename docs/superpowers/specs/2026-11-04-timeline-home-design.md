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
- **Where it opens (the user, 2026-11-09, "Open home at top"):** while annai isn't installed (the data-safety banner shows), a fresh home opens at its top, the banner first: a long past would otherwise put the banner far above the screen, unseen. Installed (no banner), it opens with the now line 40% down as above. Back's and ←'s own place restore is unchanged: this is only where a fresh home opens.
- **Where cards go on home (the user, 2026-11-08, "Stick under top bar"):** on home only, the notices box sticks under the top bar while it holds a card, so a card that arrives while home is scrolled (it opens at the now line) is in view, over the rows, which don't move. Empty, it takes no room and covers nothing. A card that lands over the rows ignores taps for a moment, so a tap meant for a row doesn't land on its button. Other screens keep the main spec's rule (§16.1): cards in the page, scrolling away with it.
- **How tall a stuck box may be (the user, 2026-11-09, "Cap every box at half", "Opens in place", "Keep buttons at edge"):** the box sticks whenever it holds a card, and is at most half the room under the top bar (half of 100svh, the page's height with a browser's bars shown); what needs more scrolls inside it, and a swipe on a box that scrolls stays in it. A box never goes into the page above. A card the user opens (More, Show) opens inside the box, and Less joins its buttons. The buttons of an opened card, or of one taller than the box (the newer-backup card in landscape, or in Japanese on a small phone), stay at the box's bottom edge, its text scrolling above them. The page never moves on an open or a close (a jump the user didn't ask for is never wanted). The half is to be confirmed on the user's phone.
- **While a field on home is typed in (the user, 2026-11-10, "Unstick while typing"):** on a touch screen, while a text field on home has focus and the keyboard is up (the same moment the dock steps aside, §16.2 of the main spec), the box stops sticking and stays at the page's top, so neither it nor the keyboard's scrolling can cover the field; it sticks again as typing ends (at a tap's click, never at its press), its cards ignoring taps a moment as when one lands (with the page scrolled down, where it lands over rows in view; at the page's top it sticks where it was and takes taps at once). The box keeps its place in the page either way, so nothing on the page moves at either moment. A mouse and keyboard keep it stuck, and a field focused under it is scrolled clear of it.
- Only dated trips sit below now, so one being planned stays right under the line, however many chats exist.
- Before the last 30 days, a month with over three chats folds to "October: 14 chats". Cards never fold.
- The foot: Archived (a fold, as today), Open a file, last backup.
- Empty: the now line, "Tap + to talk to Shiori", Open a file. Welcome ends here; its "bottom of every screen" line changes.
- Chat to trip: once dated it moves, becomes a card and gains Next. The conversation shows "Shiori set the dates" with Undo, from the `file.write` entry, which already holds `old`. Undo takes back only the dates (`undoDating`: the version before's `start` and `end`, written as the user's update of trip.json, so a name given since stays). The line stays in the conversation at that write, under her lines after it until the user's next line, as the hand-over's Undo line does, and a reload keeps it (the user, 2026-11-08, "Stay, next version"; built in stage 5). Its Undo shows while the dates are the ones that write set (it set the dates trip.json has now), so a late Undo takes back only what it set: once she or the user changed the dates since, it has nothing of its own left, and a later change is never overwritten. The line itself stays, whatever came after (the user, 2026-11-10, "Stay, without Undo": "The line stays where it was as a record of what happened, but its Undo button goes, since there is nothing of hers left to take back. The conversation never loses a line."). Each of her writes that gave the chat its dates has its line (`herDatings`), and only the newest, while its dates stand, has Undo; her later change of dates she set is not one. After its Undo the line says "Undone" in its place, as the hand-over's line does (the user, 2026-11-10, "Show 'Undone' (Recommended)", over the line alone). It is worked out from the log, so a reload reads the same: "Undone" when the first write after it that changed the dates was the user's and put back the dates from before it (a write that only renames changes nothing). So the same write by hand, taking both dates out in Details or restoring that version, reads "Undone" too: nothing stores whether the button was tapped. Once the dates were changed otherwise, it is the line alone. The line keeps one height, the Undo button's 44 px, with its Undo, with "Undone" and alone, so the lines above it never move when it changes (a jump the user didn't ask for is never wanted); the hand-over's Undo line keeps the same height.

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

An undated chat's snapshot says: if this is about one of their trips, read it first and answer here; only if they want to carry on there, call `open_trip`, and annai asks them itself; if it becomes a trip, patch `/trip/trip.json`. In an undated chat `start_trip` is refused with "patch /trip/trip.json": today `call.trip` makes it start a second trip without opening it.

The move is annai's own card, answered by the user (decided 2026-11-11, below): nothing moves until they answer, and nothing moves by itself.

1. `open_trip`'s guard (`trip-tools.js`) refuses only in a dated trip, where the user opens the other trip from Trips, and for the conversation it is in.
2. `filesOf`: those named, else the hand-over's fresh `/trip/files/…`, all found before the card, so a call it can't do is refused before anyone is asked.
3. annai's card, through `confirm` as `read_trip`'s is: "Carry on in Kyoto, Apr 1–8?" (the trip named as read_trip's card names it: its dates, else when last talked if another shows its name), Open and Not now, said aloud with voice on, judged by the same strict spoken yes and no. She announces nothing and asks nothing first: the tool's description says annai asks.
4. At Open, and only then: the files move, the user's last line (typed, or heard and not set aside; never an answer to annai's card, which a typed yes or no is too, and nothing older than the last move out of this conversation, which carried it) and her recap are made the trip's wakes, the chat gets `conversation.moved`, written last, after the halves have written what they still held of the chat (a line Koe heard, a yes a live session heard, a cue) so that it settles them and the chat owes nothing, and the trip opens at once, as a tap on its row does (`Halves.carryOn`). The turn that asked is let go, settled, with nothing owed in the chat (`open`'s `moved`); the open ends the `open_trip` call, and its result says they chose Open, a success and no cut, as the Trace shows it (decided 2026-11-11); the line and the recap wake her once in the trip, the recap shown below their line, and she answers there. If the user opened something else in the moment before (a Stop or another conversation), nothing opens, and the lines are written into the trip in that order and wait there. The card's buttons end at the first tap.
5. Anything else ends the card by stage 5's rules: Not now, a line of their own (typed or said), a Stop, another conversation opened. Nothing is written anywhere, nothing moves, and her result says what they chose or said. A trip removed or archived while the card waits is said to be gone after Open. A reminder's turn may call it too: the card shows, and nothing moves unless they answer it.
6. The chat always stays, ending "Shiori moved this to Kyoto", which her later turns there read; it settles what the chat owed.
7. `went` (with `chose: true` from the user's own choice, `carryOn`): from home the address follows into the trip as a new entry, so Back returns home (a replace would leave the chat's address under it, and Back would open the chat, stopping her answer in the trip); the chat left goes to the open one at its redraw; Details and Settings stay where they are.

`start_trip` from the no-trip conversation still opens what it started once both halves are done (`openWhenDone`), as released, until stage 7 makes that conversation read-only; its `went` has no `chose`, so a screen on home stays on home, as released. With no trip open `open_trip` asks with the card too: on Not now the files wait, and her hand-over words say she starts no trip for them unless the user asks.

`list_trips` gives dated trips and the 30 newest chats, so she can read the right one for "what was that ramen place?".

## Reading another trip

The user, after the design's doubts about forgetting and the slow route: "with user approval, shiori can just read another trip's files? this includes trascripts and stuff so she just able to know what you are talking about without going to the other trip? she should still have the capability to do so but this will allow user to mention another trip and continue in the current trip". Picked: "Once per chat, or always for mine (Recommended)". This replaces an earlier pick of moving as the only route; moving stays.

- One new tool, Kokoro's only and not in `KOE_TOOLS`: `read_trip({ trip, path?, query? })`, read-only, for a trip's text and JSON files and its conversation. Photos and PDFs aren't read: `record` throws on a hash the scope doesn't reach, and she says so; from a chat she calls `open_trip`, whose card asks them. She writes only in the open conversation. `read`, `list`, `recall`, `resolvePath` and `reach.js` stay untouched, so the walls hold as they are. It's in `UNTIMED`.
- Its `run` shows annai's own card, built from the scope's title with fixed options ("Read Kyoto in April?": Allow, Always for my trips, Not now), and logs a grant entry only on `got.chosen`. `ask` can't do this: it's model-authored, and no model text may grant (RULES 9). A late tap (`send` with `chose`) grants nothing. 
- A spoken answer: annai's own strict word lists judge a heard line when its words are written down (a live session's transcript as it arrives; classic voice's write-down; a chat Koe's line, which the card hears before Koe routes it, written down once for the card through the speech-in list as for Kokoro's model (a transcription model, or Kokoro's model itself when it takes the sound), since a Koe model that takes the sound writes nothing down until its turn ends; with neither, the line goes on to Koe, and its words come when Koe's turn ends), with no model involved, and no model's kept or set-aside verdict either. A line is a yes (or a no) when every clause of it, as punctuation sets them apart, is a word of that list, or two run together as a transcript writes "yes, go ahead" with no comma ("yes go ahead"); a line written as a question is never a yes, any clause that is no word of the list makes it neither ("yes but no", "okay, wait"), and three words run together are a chant (decided 2026-11-11 from the real-model run, where a live "Yes, go ahead." left the card open). A line is placed by when its speech began, on every path, and the newest line by when it was heard decides: once a newer line has words, an older line's words that come late, or are written down again in other words, arm and drop nothing. A yes begun inside the window after she asks (20 s from her question's end; with voice off, or its sound failed (blocked, no voice), the question unsaid, from a tap on Shiori, each tap starting it again while the card is the last thing put to the user, never when it is only shown: the user's picks, 2026-11-12, "A tap starts the 20 s", "Only while the card is last"), or a no at any time ("No thanks.", "No, wait.", "Not now"), arms its option, and the newest decides 3 s after its words: a yes grants Allow, a no declines as Not now. The window lasts only while her question is the last thing put to the user: her voice beginning anything else in it (a line of annai's or of Koe's, a reminder or an alert said on time, a live session's turn, or one still sounding as the question ends), or anything shown after it (a reminder, a line or a question of Koe's), ends it there, and no tap starts it again (one Shiori's microphone for it closes; the other half's and a live session's hear on), so a yes heard after it arms nothing, and a kept line ends the card unanswered as below, with words that tell her what to do if they meant yes (the user's pick, 2026-11-12, "Anything else ends it"). A yes armed before that still settles, and a line begun after her voice inside its 3 s drops it as any other line does. A yes waits while anyone speaks and has its 3 s again once they stop, and it waits for the words of every line heard after it (a segment as its microphone hears it, a live session's turn as it begins), however long they take: either may take it back, and those words drop it or arm their own. A line after it whose words never come leaves it waiting, and the card with it, for a tap or another spoken answer. A no doesn't wait. Any other line drops an armed yes; the card listens on. A line begun over her own voice or annai's arms nothing and doesn't end the card, on every path (classic voice's microphone is closed then and a live session deaf; a chat Koe's microphone stays open, so its line is marked). Where annai hears while she speaks, a run begun within 360 ms after her voice (half-duplex's tail) is hers too, tap or no tap: her last words before a tap may still be coming back as a run of their own, which nothing tells from an answer begun at once, and her words never answer the card. So on headphones or in a car an answer begun within 360 ms of a tap arms nothing, and the card stays for a repeat or a tap. A kept line that arms nothing ends the card unanswered, as typing does, 3 s after the last line said (a segment or a turn's end, not a click), so the words of a yes said meanwhile come first; it doesn't wait while someone speaks, so music can't hold the card. One set aside leaves it. A tap wins at any time. A line that arms the card is the card's alone, whichever microphone heard it, by one rule for one Shiori and for a chat Koe: no quick-decision gate, no answer to another call, no queue, no turn, so with Koe on a chat model Koe never gets a line the card has taken, and a call of Koe's that was listening listens on; every other line goes on as before, and so does one that reaches Koe's routing after the card has ended (a tap ended it first, or a slow line before it let the card's 3 s pass). The words said to the card are written with its answer, with the card's words, never as a newer line, in the order the half routes them: a chat Koe's as the card takes them, so behind the lines Koe has written by then and ahead of one it still holds in its queue, one Shiori's with the card's result; a heard line written as a call's answer is settled by that call's result, in either half's reading (decided 2026-11-11: the user picked "The card keeps it; Koe never gets it"). Koe reads a line the card took as the card's own answer, as it reads a tap on the card (the question, then "[the user chose]" with the words said), never as "[heard]", which marks a line it owes an answer; when the card ends unanswered, her result lists the lines the card took, so she reads them after it, and then the line that ended the card. A live session hears the sound before any words exist, so it hears every line, and the card reads its transcript as before. (Rebuilt from the real-voice check, 2026-11-10; the holds and begin times from the final review, the order heard and the unanswered end's restart from its re-review, and the wait for a later line's words from the last review, which also took out the re-review's 690 ms tap exception, the same day.)
- Allow lasts for this conversation, stored in its log, so a reload keeps it; a grant an imported or restored log brought counts for nothing, so she asks again. "Always for my trips" is a setting, changeable in Settings.
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

## Decided by the user (2026-11-11)

- **How Shiori takes you into another trip:** "She asks, I tap or say yes", as it was put to them: "She shows a card, "Carry on in Kyoto?". Your tap on Open, or a spoken yes, opens Kyoto at once with your last line and her recap. Nothing moves by itself, so the races go away. Costs one tap or yes per move; by voice about 4 s after the yes." Asked after the user, seeing stage 6's seventh fix round, wrote "maybe reconsider design?". It replaces the first build's move, in which her call opened the trip by itself once both halves were done (`openWhenDone`, the old step 4 of "Moving into a trip"); reading in place stays the common route, and this keeps "she should still have the capability to do so".

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
- A spoken yes needs `Agent.confirm` and `kokoro.confirmHeard`: `ask` is gated while Koe talks. Halves feeds `confirmHeard` from Koe's entries (the verdict, and a chat Koe's words) and from where each line first exists, with when it began (live: the session's transcript as it arrives, `LiveHost.heard`; a chat Koe: its microphone's segment, `Half.speech`, and then the line itself, before Koe routes it, `Half.card`, which takes one that arms the card, `Agent.cardTakes`), and `confirmSpeech` from who is speaking and whether a line was just said (`LiveHost.speech`: a turn's start and end; `Half.speech`: speech starting, and a segment with its begin time and whether annai's voice was playing then).
- A moved conversation logs its own `conversation.moved` entry, because an old page would show `handover.moved` as "took 0 files".
- The stage 8 counts above need a recount when it starts.
