# One entry per file, one details screen

This design changes the trip's Files section and the booking details of the bookings-and-trips design (`2026-10-28-bookings-and-trips-design.md`), goals 6, 7 and 8. Where they differ, this one wins.

## Why

The user, 2026-11-01, after using the Files section on their phone:

> "the sections are not very clear in the trips screen for files And when I clicked the .json for details, the back button is back to plan instead of the trips screen. I mean... should we unify the two screens? the file detail and the item ( stay / car /flight ) detail. [...] Maybe we just have one entry per file in trips, and when clicked, it shows the details of it, and the preview. with buttons for change / open / download / ask shiori below it? do you think this make more sense and more streamlined and make more sense?"

What they saw:
- Each file the user gave shows twice in Files:
  - the file itself, as a card under its name;
  - beneath it, a link to Shiori's record of it ("A stay: …"). The link is named by the record's file name when the booking has no title, something like `name-1234.json`, which means nothing to a person.
- An **Ask Shiori about this** button sits under each pair, outside both, so it's hard to tell what belongs to what.
- **There are two screens for one thing:**
  - tapping the file opens the file screen (a PDF frame, the raw editor, its history, Delete);
  - tapping the record opens the booking details, whose Back goes to the Plan, not the trip it was opened from.

## The user's decisions (2026-11-01)

- **The direction:** "one entry per file in trips, and when clicked, it shows the details of it, and the preview. with buttons for change / open / download / ask shiori below it".
- **One file holding several bookings** (for example, a flight itinerary with the outbound and return legs): "One entry, both inside (Recommended)". The option read: "One row per file, as you said. Its details show each flight as its own block; tapping a flight on the Plan opens this screen at that flight."
- **What Delete on the details screen removes:** "File and its bookings (Recommended)". The option read: "The file and what Shiori read from it go together, so the Plan no longer shows them. Asks once before deleting; the file's earlier versions stay restorable from All files."
  - **Correction, told to the user:** the last clause was wrong. All files lists only files that exist, so a deleted file can't be reached there. See Questions.
- **Restoring after Delete** (after the correction): "No way back (Recommended)". The option read: "Delete asks once (\"Tap again to delete\"), as today, and that's final on screen. Simplest; nothing extra to build."

## Goals

1. **Files lists one row per file the user gave**, and nothing else.
   - That means the files under `/files/`, as today.
   - Photos follow today's rule: a photo that became a booking, or waits to be read, is in Files. Any other photo is among the trip's photos (spec check F2).
   - **The row's name** is Shiori's short name for the file. Without one, it is the booking's title when the file became one booking that has a title. Otherwise it is the file's real name.
   - **Beneath the name, what the file is:**
     - one booking: its kind and day ("Stay · Nov 23");
     - several of one kind: their count and days ("2 flights · Nov 20, Nov 27");
     - several of different kinds: the kinds;
     - plan items from a calendar: "Plan items from a calendar";
     - otherwise "Waiting for Shiori to read it" or "Nothing yet", as today.
   - **No record file names, no links to records, no Ask button on the row.** The whole row is one tap target.
2. **One details screen for a file and what Shiori read from it.** The Plan, Now and Shiori's cards open the same screen for a booking that came from a file. It shows:
   - **The heading:** the row's name.
   - **Each booking the file became,** in its own block, in time order. A block has:
     - its kind and day;
     - what Shiori read, with the "check" marks on details she's unsure of;
     - the old "Check this" banner, where it applies;
     - **the plan items that stand for it,** each with its title and day, its notes beneath, and a tap opening its details. Delete removes them (goal 4), so the screen shows them all, not only those with notes (spec check b).
     - With one booking, the screen reads as the booking details do today. When the booking's title differs from the heading, the block shows the title, with its check mark if Shiori is unsure of it.
     - With several, each block has its own heading: its title, else its kind and day.
   - **Plan items made from the file** (a calendar), listed with their days, each opening its plan item's details.
   - **The preview of the file** (a PDF's first page, a photo or a file card, as `filePreview` gives today), and "From <real file name>".
   - **The buttons, below:**
     - **Open:** shows the whole file, as Open the original does today.
     - **Download.**
     - **Ask Shiori about this:** the file and its bookings attached.
     - **Change:** what Shiori read, in the raw form, as "Change it" today.
       - With one booking, it sits at the foot with the other buttons.
       - With several, each block has its own.
       - A file that became no booking has none. A text file's editor is reached by Open (the plan's review, 2026-11-01).
     - **Open in Maps:** per booking, when it has a place.
     - **Delete,** last (goal 4).
3. **Back goes where the screen was opened from:**
   - the trip, the Plan, Now, the Conversation, or a plan item's details.
   - The Plan's links start passing `from`. Today only Now does (spec check F1).
   - With no `from` (an old link), Back goes to the trip.
   - The crumb on a screen opened from the trip names the trip.
   - The screens this one opens, Open and Change, come back to it, as today.
   - After Delete, Back goes to the trip when the screen it would go back to showed something just deleted.
   - The Conversation's chip for a file the user gave opens this screen, not the raw file screen.
4. **Delete removes the file and what Shiori read from it:**
   - the file;
   - each booking whose `source` is the file;
   - the plan items that stand for those bookings, or were made from the file. All of them are on the screen (goal 2).
   - It asks once: Delete, then "Tap again to delete", as today.
   - A toast then says what went, for example "Deleted Hotel stay, 1 booking and 2 plan items". The screen goes back.
   - **The raw file screen's Delete means the same for a file under `/files/`** (spec check a). That covers Open's screen and All files. A file the user gave has one meaning of Delete everywhere.
5. **A booking with no file** (Shiori wrote it from what the user said) still opens the same screen: its block alone, without the preview, Open or Download. Its Delete removes the booking and the plan items that stand for it.
6. **A tap on one booking of a file with several** (from the Plan, Now or a card) opens the file's screen at that booking's block. The screen scrolls the block into view and focuses its heading.

## Non-goals

- **A form for changing a booking.** Change stays the raw form for now.
- **The plan item details** (`item.js`) stay as they are, except that their "Booked: …" link and Open the original lead to the new screen.
- **The folded "All files" list stays** as the raw view of every file by folder, with the file screen (editor, history, restore). It is where Shiori's records can be seen and changed by hand. Its region's label becomes "All files", so the trip screen no longer has two regions called "Files".
- **Photos:** what Files shows of them doesn't change (goal 1).

## Anti-goals (a failure even if it works)

- A booking or file shown twice in Files, or any row named by a record's file name.
- A Back that goes somewhere other than where the user came from.
- Losing what the booking details show today: the check marks, the "Check this" banner, the notes, Open in Maps, Ask, and Change.
- A link that worked before no longer working: the booking addresses in Shiori's cards, in the Plan and in Now (`bookingHref`), and the `from=` crumbs.
- Deleting something the user didn't see on the screen they deleted from.

## Constraints

- The bookings-and-trips design's constraints hold:
  - a browser-only, local-first PWA, with the iPhone's Safari as the main target;
  - store data, not words;
  - accessible as built;
  - no new dependency.
- **Every new or changed user-facing string** gets its rows in ja, zh-Hans and zh-Hant (`npm run strings`, the l10n catalogs). A string no longer used goes from the catalogs.
- **The shipped-size budget** (`npm run size`) stood at 2811.2 of 2812 KiB on 2026-11-01. This change will likely go over it: both old screens stay, and the new screen adds code.
  - Raise it by what the build needs, in whole KiB, as the project's standing practice allows.
  - List the raise in the handoff's Calls to confirm.
  - Don't pad it.
- **The stored formats don't change.** A booking's `source` already names its file, and the screen is worked out from what is stored.
- The public repo's rule: no real booking details, names or file names in tests, docs or commits. Fixtures are synthetic.

## My calls (for the user to check)

1. **The list order:** rows by the first day of what the file became (bookings and plan items alike), then by name. A file with no day goes after those with one. Today the order is by name only.
2. **The real file name** shows on the details screen ("From …"), not under the row's name in the list. The list stays at two lines a row.
3. **Change sits at the foot with one booking, and in each block with several.** A file with two bookings has two records to change.
4. **The All files fold keeps the old file screen** for the raw view. So "Change" for a record and "All files" still reach the editor and history.
5. **Delete also removes the plan items that stand for the deleted bookings.** The user's choice says "so the Plan no longer shows them". A plan item left standing for a booking that's gone shows a "Booking missing" chip. The screen lists these items, so Delete removes only what is shown.
6. **The raw file screen's Delete, for a file under `/files/`, removes its bookings and plan items too.** The user's choice then holds on every path.
7. **A booking with no file gets a Delete** on this screen. Today's booking details has none. It removes the booking and its plan items, so a booking Shiori wrote from what the user said can go the same way as one from a file.
8. **Change means the raw form,** as the 2026-10-28 design has it. It doesn't mean "replace the file".

## Questions (answered)

1. **Restoring after Delete.** The Delete option told the user that "the file's earlier versions stay restorable from All files". That is wrong:
   - All files lists only files that exist.
   - A deleted file's screen still offers "Restore this version", but only by its address. It brings back the file alone: its bookings and plan items stay deleted, and Shiori's short name for it is dropped.
   - Delete keeps the bytes on the device ("its blob is kept forever", `workspace.js`). So no option gives space back, and an Undo costs none.
   - **The choices:**
     - Delete with no way back on screen, one confirm only. This matches the engineering rules ("a destructive click confirms once").
     - The toast after Delete offers **Undo** for a few seconds. It brings back the file, its bookings and its plan items together.
     - All files lists recently deleted files. Restoring one brings back the file alone, and Shiori reads it again.
   - **Recommendation:** the first. Tell the user the claim was wrong.
   - **Answered 2026-11-01** (the user was told the claim was wrong): "No way back (Recommended)". Delete asks once, as today, and that is final on screen.
   - **This now holds only for a file Delete frees.** A file it keeps is listed under Deleted, with Restore (the next section).

## Delete frees, or keeps under Deleted (2026-11-01, after Tasks 1–6)

The user's words, verbatim:
- Asked "Deleting a file doesn't free its space today (only removing the whole trip does). What should Delete in Files do?": "Free it at once (Recommended)". The option read: "The file, its bookings, plan items and old versions go, and the toast says how much was freed. Matches 'No way back'; reuses code annai already has."
- Then: "if we are not freeing bytes anyway, I would prefer we can see / recover them. because this is extra feature that come free."
  - The coordinator's reading, told to the user: Delete frees the space when it can. When the trip's Conversation still names the bytes, the deleted file is listed as deleted, with Open and Restore. Nothing extra is kept for recovery.

What it does:
- **Delete** still deletes the file, its bookings and their plan items in one `ws.writeMany`, so the workspace's listeners hear of each (Shiori's short name goes, live mode drops the reminders, the offline pack and the push mirror follow). Each `file.delete` carries `data.with`: the file it went with.
- **Then it frees the group** (`forget`, with the file's path as `mustFree`): its history and every content nothing else names. **Freeable** means no version that the file's own history names is named by anything else: no current file in any scope, and no log entry outside the group's own history. Only the file's versions decide; the bookings' JSON and derived content (copies, crops, page pictures) never block it, and derived content the conversation names stays.
  - Freed: "Deleted Hotel stay, 1 booking, and 2 plan items. 2.4 MB freed."
  - Kept, as the conversation names it: "… The conversation still has it, so it's under Deleted, where you can restore it." Kept as another trip or file has the same bytes: "… Another trip or file has the same content, so …". Kept means nothing is forgotten at all, history included.
  - A booking with no file is deleted with its history kept, as before, and isn't listed (the list is for files the user gave).
  - If the page goes between the two steps, the file is simply kept, listed and restorable.
- **Deleted (n)** folds at the foot of the trip's Files, only when there are any: the newest delete of each `/files/` path with no file there now, moves left out. Each row is the real file name and "Deleted by you 3 hours ago" (or by Shiori, whose own deletes keep history and so show here), and opens the deleted file's screen.
- **The deleted file's screen** (the raw screen) shows its last version as a waiting file's screen does (a photo, a PDF, or Download) and **Restore**, above its history with "Restore this version".
- **Delete for good** (2026-11-01, added after the user's answer below) sits beside Restore on the deleted screen of a `/files/` path, only when it would free space. Shiori's own deletes, and deletes from before this change, never went through the freeable check, and her files tool keeps history, so they sat under Deleted keeping their space even when nothing else needed them.
  - The user's words, verbatim. Asked "Files Shiori deleted, and files deleted before the update, sit under Deleted keeping their space even when nothing else needs them. What should free them?": "Delete for good button (Recommended)". The option read: "On a deleted file's screen, shown only when it would free space: one tap (asks once) frees it and says how much. You stay in control of Shiori's deletes, which you may want to restore."
  - **Shown** when a dry run of `forget` (`dryRun: true`: everything runs in one transaction, then it is rolled back; it reads no blob bytes, only whether each content is stored, so it reports `blobs` and leaves `bytes` 0) says `kept === null` and `blobs > 0`. A kept file (the conversation, a current file, or another scope names its content) shows no button and Restore stays as it is. The dry run is one transaction with typed reads, no log walk.
  - **Identical deleted copies** (the user's answer, 2026-11-01, verbatim). Asked "Two deleted copies of the same file in one trip keep each other, so neither gets the new Delete for good button. Now that the button exists, should it free them together?": "Free them together (Recommended)". The option read: "On either copy, Delete for good frees both (when nothing else needs them) and says "2 copies". The known-limitation entry goes away." A **copy** is exactly that: another `/files/` path whose set of stored versions (the hashes its file.write and file.delete entries name) *equals* this file's. The copies are added, each with its whole history and its own group, in one `forget` call, so one transaction, and one dry run proves it first. A deleted file that shares only some versions is no copy (a duplicate, then an updated file saved under the same name): freeing it would take part of the other's history, so `forget` keeps both and neither shows a button (a known limitation in docs/limitations.md; the first version of this rule took the transitive closure over any shared version and freed such a newer file, its booking and its history: the data loss the review caught). Anything else naming a version of any of them (a current file, the conversation, another scope) keeps them all, and shows no button. **What the tap frees is named on the screen before the tap**, beside the button, each copy by the name it is shown by: "Also deletes hotel-2.pdf, a copy of this file." ("…, copies of this file." for several), and, when the file or a copy went with bookings or plan items, "…, and the 1 booking and 1 plan item Shiori read from them." (a file with no copies: "Also deletes the 1 booking Shiori read from it."). **The tap frees only what the screen named**: it passes the paths the screen named, and if the paths recomputed at the tap are not the same set (another copy appeared or went, a group changed, in another tab), it frees nothing, says "What goes with a.pdf has changed, so nothing was deleted." and the screen is drawn again, with the new line. The toast: "Deleted a.pdf and 1 other copy for good. 24 kB freed." ("# other copies" for more). A content of no bytes frees no space: a file whose only content is empty has no button.
  - **What it frees:** the file with its whole history, plus, when its newest Delete took a group (`data.with`), the group's booking and plan paths, each only in its current life (`ownLife`, the rule Delete uses). A path in the group that has a file again, or was deleted again on its own since, is someone's now and is left alone. Shiori's deletes and old deletes carry no `with`, so the file alone goes.
  - **It asks once** (Delete for good, then "Tap again to delete for good"), then toasts "Deleted Hotel stay for good. 2.4 MB freed." and goes back (to the trip, when back is a screen of what was freed). If something has come to name the content between the screen and the tap, nothing is freed and the toast says it stays under Deleted; if the file has come back (restored in another tab), nothing is freed, the toast says "is already back", and the screen shows the live file.
  - **Guarded in the transaction.** The group's booking and plan paths go to `forget` with `onlyDeleted`: a path that has a file by the time the transaction runs (another tab wrote it) keeps its whole history, and Delete in Files passes the same guard. The file's own path is guarded by `mustFree`.
  - The Deleted fold lists what is left; a freed file has no history, so its raw screen says "This file was deleted for good."
- **Restore** brings back the file at its last version, then each delete marked `with` the file at the same moment, each only where nothing is at its path now, and opens the file's details. The toast names what came back and what couldn't ("Restored booking.pdf, 1 booking, and 1 plan item"). Shiori's short name doesn't come back. A file deleted before this change comes back alone. A delete now keeps the file entry's `source` and photo metadata on its log entry, and a restore of a deleted path gives them back, so a calendar's plan items stay its own.
- A file freed at its Delete has no history left: its raw screen says "This file was deleted for good."
- **Every forget leaves a `forget` entry** numbered after every entry it removed, so a trip's last entry number never falls and a backup made before the Delete reads the trip as changed (main spec §4.9).

Left out (the coordinator's call, listed for the user):
- ~~**"Delete for good" on a deleted file.** Delete already frees whenever it can, and Remove trip frees the rest.~~ Reversed by the user on 2026-11-01 (Shiori's deletes and old deletes sat under Deleted keeping their space): it is built, see Delete for good above.
- **Freeing content that the log names.** That would mean rewriting conversation entries and re-reading the agent's in-memory transcript.

## Left to the builder

- The route: a new one, or the booking route reworked. `#/trip/<id>/booking?path=…` must keep opening the screen for that booking, at its block. Whatever the route, `BACK` and `cameFrom` in `file.js` must know it, so the screens it opens come back to it.
- How the screen finds a file's bookings and plan items (the same reading `fileRows` does today), and its tests.
- The exact words of the row's second line for mixed kinds, within goal 1.
- The layout of several booking blocks, within the existing details styles.

## Done looks like

- **E2e (WebKit and Chromium, at phone width):**
  - Files shows one row per file;
  - a two-flight file opens one screen with two blocks;
  - a Plan tap on its second flight lands on that block;
  - Back returns to the trip, the Plan or Now, by where the screen was opened from;
  - Delete removes the file, its bookings and their plan items;
  - old booking links still open.
- **Screenshots** of the list and the screen, in English and Japanese, light and dark, at 390 px wide, judged by a reviewer.
- `npm run check` green, within the size budget. E2e green.
