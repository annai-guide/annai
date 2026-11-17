# Timeline stage 7: the plan to build (2026-11-14)

> Copied into the repo on 2026-11-14 from the project's working notes, as the builder started stage 7. Line numbers are main 0e567c5c's.

This is the builder's plan. It replaces docs/superpowers/plans/2026-11-06-timeline-stage-7-opening-and-no-trip.md and section 4 of
the re-plan of 2026-11-14 (the project's working notes, outside the repo). It is built from the re-plan, its spec check and the user's three answers of
2026-11-14. Code references are main 0e567c5c, checked by reading. Nothing here is built.

> For the builder: superpowers:subagent-driven-development or superpowers:executing-plans, task by task, `- [ ]` steps.

## The goal, in the user's words

"what? I thought we are doing the interface redesign? is that scope completely lost? or did you consider it done?" The redesign is the
timeline home (docs/superpowers/specs/2026-11-04-timeline-home-design.md). Stages 1 to 6 are on main. This is stage 7: "Opening rule, `me`
read-only, the waiting move, no-trip paths out."

The user's picks for it:
- "Last chat if recent, else timeline (Recommended)".
- "Read-only row (Recommended)": "You can read it; talking starts a new chat." (2026-11-05)
- How it ships: "Release in stages; tabs go last (Recommended)". This stage is reviewed and released when green, with the tabs still
  there.
- **2026-11-14, the phone look:** "After stage 7 ships (Recommended)". One look covers stage 4's list and stage 7's opening.
- **2026-11-14, what is open when nothing is:** "Open the new conversation (Recommended)". At start with no `activeTrip`, and when the
  open trip is removed, annai opens the standing draft, as + does. Until stage 8 the Conversation and Itinerary tabs show that empty
  conversation instead of home. `openChat` and its "no draft yet" ordering go. The loop's guard stays only for a draft that can't be
  made.
- **2026-11-14, a typed line when no conversation can be made** (storage full, store failing): "Put it back in the type box
  (Recommended)". The words stay in the box, and a card says Shiori couldn't start a conversation, as + does. The `me`-log fallback
  goes, and there is no known limitation.
- For the hand-over with no trip open (2026-10-29), stage 7 keeps what these gave:
  - "Add a way back (Recommended)". The way back to her old lines is the "Shiori, no trip" row, and their files are in the "Waiting
    with Shiori" chat.
  - "Show progress (Recommended)". The box's "Keeping 3 of 20…" (dock.js:102-110) is untouched; the files now go into the open
    conversation.

The standing rule: "what I prefer is simple and robust solutions. Again that is #1 in our agent rules. DO NOT miss that. Clever design
sometimes also means accept known limitations early in design phase to avoid scope creeps and bring in more vectors".

## What it does

- A plain start opens the conversation last talked in if that was under 12 hours ago, or if it is happening; else home.
- `me`, the old conversation outside any trip, becomes a read-only row on home. Nothing runs a turn in it again.
- When nothing else is open, the standing draft is open, as after a tap on +.
- The files waiting with Shiori move into a chat named "Waiting with Shiori".
- The no-trip code goes: the `/waiting/` view, the Waiting panel, the no-trip card and screens, and `openWhenDone`.
- The tabs and the Start a trip form stay until stage 8.

## House rules

- Browser-only, local-first PWA; iPhone Safari is the main target; no new dependency.
- Work in a worktree of its own, branch `stage7`, from main. No push, merge or release.
  Never `git stash`. Stage files by name; delete with `/bin/rm -f`, move with `command mv -f`. Commits end with your own model's
  Co-Authored-By line.
- Public repo: no real user details. Fixtures use the test names (Testville, Hotel Aurora Test, ANNAI AIR AN 123). No real-model calls.
  Never read a secret file.
- Read first: the agent rules (RULES.md) in full, for the Builder role and the ladder. Before the route and tool
  changes, read the shared LESSONS.md and docs/lessons.md in full. Each API change gets its entry in
  docs/lessons-full.md and docs/lessons.md in the same commit; lessons.md stays under its cap (24 KB).
- New words: `node scripts/strings.mjs`, fill each `new` row in l10n/{ja,zh-Hans,zh-Hant}.tsv and mark it `draft`, run it again, then
  `node scripts/strings.mjs --check`. Read docs/translating.md first.
- After any change to src/, index.html or sw.js: `npm run stamp`, then `npm run -s catalog`.
- Size: never print scripts/size.mjs line 4 (a 58 KB line). Main stands at 3268.1 of 3269 KiB. Each commit passes `npm run check`,
  so raise `BUDGET` in a commit that adds (Task 2) by what `npm run size` measures, and lower it in the commit that removes (Task 4) by
  what it measures, in whole KiB, with the reason in the comment. I estimate the stage at 4 to 7 KiB net out; not built.
- Commands:
  - One unit file: `NODE_OPTIONS=--max-old-space-size=2048 timeout 600 systemd-run --scope --collect -q -p MemoryMax=4G -p MemorySwapMax=4G -- node --test --test-timeout=120000 --import ./test/unit/pin-phone.js test/unit/<file>.test.js`
  - All: `systemd-run --scope --collect -q -p MemoryMax=16G -p MemorySwapMax=16G -- npm run check`
  - E2e: read /proc/pressure/memory first (hold back only when `full avg60` is over 5), then `docker run --rm --memory=8g --ipc=host -v "$PWD":"$PWD" -v <repo>/node_modules:<repo>/node_modules:ro -w "$PWD" mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test <specs…> --workers=16 --retries=2`.
    Then delete test-results/, playwright-report/ and core.[0-9]*, unread. If another build's e2e runs at the same time, rerun any
    Chromium failure on "Opening annai…" alone before calling it real.
- Hand back a report (`stage7-build-report.md`, in the working notes), with the src-only diff beside it (`stage7-srconly.diff`). End
  the report with Calls to confirm: the size, each changed behaviour and API, each call of your own, and the calls at the end of this
  plan.

## Stored and API changes

| What | Change | Old data |
|---|---|---|
| `me`'s log | No turns run in it. Old `me` watches still fire: annai says the reminder and the wake is logged, no turn, as for any conversation that isn't open (live.js:1663-1666). | Read as it is, at `#/talk/me` |
| What is open | When nothing else is: the standing draft, at start with no `activeTrip` (or one that's gone) and after the open trip is removed. `null` only when no draft can be made. | none |
| `sys:waiting` | The scope stays. The waiting files' move empties it at start, after an import and after an Undo. | Moved at the next start |
| A conversation annai makes | "Waiting with Shiori", written by `system`, so her snapshot reads the name as a guess she may improve (context.js:43) | none |
| Routes | `#/talk/me` new (read-only). `#/talk` and `#/plan` with nothing open go home (`location.replace`), only for the no-draft case. `#/waiting/file?path=…` goes home. | Old bookmarks go home |
| Shiori's tools | The `/waiting/` root goes, with the no-trip words of `start_trip`, `open_trip` and the files tools | none |
| Halves | `openWhenDone` and `#going` go | none |

`annai.resume` (localStorage) is no longer written or read; the stale key is left. Removing it is one line plus a lessons entry for a
value no one reads.

## Review Focus

1. **A run cut off in the middle of the waiting files' move, twice.** Every file ends up once in a "Waiting with Shiori" chat, whole,
   with its short name. Each such chat has its wake. Nothing is left in `sys:waiting` after the next start.
2. **Old `me` watches and a turn left owed in `me`.** At start and while another conversation is open: the reminder is said and the
   wake logged, with no request and no restart wake.
3. **Nothing open.** At a fresh start and after removing the open trip, the draft is open:
   - typing, a tap on Shiori, the camera, files in the box and `ui.shiori.send` land in it, and its first line makes it a chat;
   - the Conversation and Itinerary tabs show it.
   With no draft possible (a store that throws): the typed words and picked files stay in the box, the + card shows, and nothing is
   written into `me`.
4. **A plain start with `activeTrip` removed, archived or a draft, or talked in 12 h and a minute ago.** It goes home. A link, a share
   or a notification is never redirected.
5. **Undo with files that have nowhere to go back to.** This covers a pre-update hand-over filed from the waiting space, and a started
   trip whose files' origin is gone. The files land in a new "Waiting with Shiori" chat before home is drawn: never nowhere, never in
   two places.
6. **`#/talk/me`.** No button on an old line does anything: her questions' options, annai's cards, Try again, Undo, the dates line. A
   tap there never sends a bare "Yes" anywhere.

---

### Task 1: The opening rule

**Files:** src/ui/resume.js (rewrite); src/ui/shell.js (:41, :399: `noteScreen` goes); src/app/main.js (:232-236);
test/unit/resume.test.js (rewrite); test/e2e/trips.spec.js (its resume tests).

**Interface:** `screenToResume({ ws, store }, at, { now = Date.now(), zone = deviceZone() } = {}) -> Promise<string | null>`. It acts on a
plain start only (welcome.js:16). It returns `talkHref(activeTrip)` when that record is an active trip, not a draft, and its `talked`
is within 12 hours of `now` or `phaseOf` says happening. Otherwise it returns null, which is home. The 12 hours are the spec's ("Used for
the 12 hours means the last user line"); write that beside the number.

- [ ] Write failing tests first:
  - at 11 h 59 and at 12 h 01;
  - happening with an old `talked`;
  - `talked` null;
  - Review Focus 4;
  - the welcome still comes first at the first start.

  Then implement, and delete `noteScreen`, `KEY` and `OF_TRIP`. Run the unit file, then e2e trips.spec.js. Commit.

**Done when:** a plain start lands only on home or on that conversation, never on Details, a file or Settings.

### Task 2: `me` read-only; the draft open when nothing else is

**Files:**
- src/app/main.js (:206-210, the open at start);
- src/ui/screens/trip.js (`removeTripNow`, :199-213);
- src/ui/plus.js (`openDraft`);
- src/ui/dock.js (submit :83-112, camera :149-168, tap :174);
- src/core/agent/loop.js (`#drain` :1554, `#open`'s owed :760);
- src/ui/router.js (`redirectOf` :38-41);
- src/ui/shell.js (:402, body `home`);
- src/ui/screens/talk.js (`#/talk/me`; the no-trip header :636-639 goes);
- src/ui/screens/trips.js (the row replaces `noTrip` :251-260);
- tests below.

**The changes:**
- **`openDraft(ctx) -> Promise<string>`** in plus.js. It is the part of `newConversation` that waits for the draft: `chats.whenReady()`,
  then `activeTrip` set (not awaited, as plus.js:16) and `openOrTell`. `newConversation` uses it, so + is unchanged.
- **At start** (main.js:208): with no `activeTrip`, or one whose record is gone, open `await chats.whenReady()` instead of `null`, and set
  `activeTrip` to it. If the draft can't be made, open `null`. The open stays before the shell starts, as now, so the first screen
  already has its target.
- **After the open trip is removed** (`removeTripNow`): it still leaves first (`open(null, { quiet: true })`, :201-202), so nothing
  writes into a trip being removed. Once `chats.used(id)` is done (:207), it opens the draft if `agent.target` is still null, so it
  never undoes a conversation the user opened meanwhile.
- **The dock with nothing open** (only when no draft could be made). Its submit, camera and tap first try `openDraft(ctx)`, then go on.
  If that fails: the + card (`explainStorageFull(ctx, e) || tellNotOpen(ctx, e)`, as plus.js:15), and the typed words and picked
  files stay in the box: `done()` (dock.js:89-94) isn't called. The camera's "Open a trip first" card (:153-155) goes.
- **The loop's guard**, for a draft that can't be made. `#drain` runs no turn while `this.trip === null`: it writes the queued wakes into
  `me`'s log and says their reminders (`remind`), as `#keepElsewhere` (loop.js:798-812) does. `#open(null)` owes nothing (:760), so a
  removal or a failing start never queues a restart wake in `me`. It is one guard for both halves.
- **`redirectOf(route, target)`:** `#/talk` and `#/plan` with `target` null go to `#/trips`. With the draft open they go to its address,
  as for any open conversation. `#/talk/me` has two parts, so it is never redirected.
- **`#/talk/me`:** `renderTalk` reads `ME`'s log (the `SHOWN` types, as talk.js:557) and never calls `open`.
  - The header is ← home plus "Shiori, no trip". There is no ⋯ menu, no dates line and no Undo line.
  - Each entry is drawn as the conversation draws it, with every button left out: her questions' options, annai's cards' actions, Try
    again, a tuning card's Undo.
  - `/waiting/…` chips show as words.
  - The dock rests as on home (body `home` at shell.js:402 for this route too), so talking there is the +: a new chat.
- **The row "Shiori, no trip":** drawn through `timelineRows` as an undated row (so it folds as a chat line does), only when `me` has a
  user line. It is placed by that line's time, read once per page load (`lastTalked(store, ME)`, scopes.js:291, exported; cached in
  memory, since `me` takes no new lines), and links `#/talk/me`. No stored change.

- [ ] Write failing unit tests:
  - Review Focus 2;
  - Review Focus 3's no-draft case (the box keeps the words; `me`'s log gets nothing);
  - the guard (an `open(null)` with an owed turn in `me`: no restart wake; a queued wake logged and its reminder said, `requests` 0);
  - `redirectOf`'s two cases.

  Implement. Then run the files that use `open(null)` or `open: false` with turns (agent-loop, halves, halves-live, trip-tools,
  agent-handover, live-agent, live-drive2-fix, pack-keeper). A test of a behaviour that still matters moves to a chat or trip; a test of
  a removed path goes.
- [ ] e2e:
  - `#/talk/me` shows the old lines and no type box, its old buttons do nothing, and + from there starts a new chat;
  - the row shows only if `me` has a user line, sits by it, opens `#/talk/me`, and Back from it goes home;
  - after the open trip is removed, the Conversation tab shows the empty new conversation;
  - `me` in a notification opens home (stage 3 holds).

  Then run the 25 specs that name the conversation screen:
  `grep -rlE "openApp\([a-zA-Z]+, '#/talk'\)|name: 'Conversation'|location.hash = '#/talk'|goToHash\(page, '#/talk'\)" test/e2e`.
  With the draft open, a test that types at `#/talk` with nothing open lands in the draft's conversation, so most keep working. Fix
  only what fails: assertions about the no-trip screen ("No trip is open…", its visible "Conversation" title row) and a `#/talk` URL
  that is now `#/trip/<draft>/talk`. Each fix is test-only, and an assertion changes only in the screen it lands on.
- [ ] Lessons entry: "`me` takes no more turns; the draft is open when nothing else is" (routes, the guard). Commit the src with its
  unit tests; commit the e2e fixes separately.

**Done when:**
- no turn runs in `me`;
- with nothing else open, the draft is open;
- with no draft possible, nothing typed is lost;
- check and the touched e2e pass.

### Task 3: The waiting files' move

**Files:**
- src/core/waiting.js (`moveWaitingToChat`);
- src/app/main.js (the run, made once and passed in the shell's core);
- src/ui/screens/import.js (after :213's import, before the results are drawn);
- src/ui/screens/talk.js (after an Undo with `outcome.waiting`, :819, before `ctx.go('#/trips')` at :834);
- test/unit/waiting.test.js.

**Interface:** `moveWaitingToChat(ws, wake) -> Promise<string | null>`.
- With no waiting files it returns null and makes nothing.
- Otherwise it creates a chat with `createTrip(ws, { title }, { author: 'system' })`. `title` is a new string key for a conversation's
  name, "Waiting with Shiori"; the old key's ja heads a list of files (「Shioriが預かっているファイル」).
- It then awaits `wake({ kind: 'file', scope: id, text })`, and only then moves each file with `moveFile` (one transaction each). The
  chat is new and not open, so no turn starts before the moves end.
- The text names no paths. It says the user handed these files while no trip was open and they were moved into this conversation,
  then gives the words a hand-over in a chat already gets (handover.js:57, the `inTrip` branch): look in list_trips, `move_file` what
  belongs to another trip, file the rest here.
- It returns the chat's id. No setting is stored.

**When it runs** (the spec check's 1.5: a row appearing at now must not move what is on screen):
- at start, awaited, before the first screen. With no waiting files it is one list read;
- after an import, before its results are drawn;
- after an Undo, before it goes home.

- [ ] Write failing tests:
  - no files: nothing made;
  - files move with their short names, the chat is named by `system`, and at its first open she gets one request with the wake's
    words;
  - Review Focus 1, by making the store throw after the wake and after the first file, twice;
  - an old backup's `system/waiting` files go into a new chat after the import;
  - Review Focus 5.

  Implement. Commit.

**Done when:** after any start, import or Undo, `waitingFiles(ws)` is empty and each file is in a chat once.

### Task 4: The no-trip paths and `openWhenDone` go

Work a group at a time, each group with its tests.

**Shiori's view:**
- tools.js:138-157 (the `/waiting` root);
- instructions.js:17;
- context.js:128;
- koe/context.js:31;
- loop.js:161-162 and :2883-2888 (`waitingMedia`, the side-task read);
- reach.js:21 (`me`'s clause);
- the files plugin (src/plugins/files/index.js:5-6, 31, 49, 102, 286, 294-301);
- handover.js:45, 56, 61;
- trip-tools.js:33, 50, 92-97, 134-138, 165-172, and the no-trip words at :460, :477-479 and :484.

**Halves:** `openWhenDone` (halves.js:1132-1148) and `#going` (:162-163, :1117-1118), with shell.js:523-526's comment (`went` now
comes only from `carryOn`).

**The screens:**
- trips.js:2-4, 77, 88, 262-288 (the Waiting panel);
- file.js:17-18, 45, 136-160;
- format.js:62-63;
- router.js:2, 28;
- shell.js:57, 61 (`waiting-file`);
- composer.js:39-40, 56, 88-89, 151, 205-212. `handOver`'s scope is the open conversation, never null here, because the dock checks
  first;
- talk.js:14, 20, 371-381.

**Also:** waiting.js's `dropWaiting` (:76-86, whose three callers go) and names.js:47's `sys:waiting` clause.

**Stays, for data and for Undo:**
- `SYS_WAITING` (scopes.js:15, 73, 83);
- `waitingFiles`, and `moveFile`'s waiting branch with `forgetWaiting`;
- archive.js:94, 627-631, 828-850 (an old backup's `system/waiting`);
- Undo's way into the waiting space. handover.js:426-428 sends an emptied trip's leftover files there for any hand-over, new ones
  included (`start_trip` stays in dated trips), and moveBack's waiting origin serves pre-update hand-overs. Task 3 empties the space
  after each.

- [ ] Remove each group with its tests (`grep -rln "SYS_WAITING\|waitingMedia\|No trip is open\|open(null)\|/waiting/\|openWhenDone" test`).
  Two kinds of test stay, because their paths stay: an old backup's `system/waiting` (archive.test.js), and an Undo into or out of the
  waiting space (handover-undo.test.js). e2e specs to fix:
  - hand-over.spec.js;
  - evening.spec.js;
  - trips.spec.js (:738-746 is `openWhenDone`);
  - phone-ui.spec.js and phone-fit.spec.js ("Open a trip first" becomes a photo in the open draft);
  - timeline.spec.js.
- [ ] Docs:
  - The main spec's no-trip lines, to what is built: docs/superpowers/specs/2026-10-15-annai-design.md:70, 74, 82, 98, 103, 105, 118,
    490, 524, 534-539 and 1192. At :493, keep the user's pick "Fix: read it in a side task" and say that its case (a file read with no
    trip open) is gone, not dropped.
  - The timeline spec: The model's Existing data paragraph to the user's 2026-11-14 picks; a "Decided by the user (2026-11-14)" block
    with their three answers as quoted above; and Moving into a trip's last paragraph and What goes, marked done.
  - A lessons entry for the tool and route changes.
- [ ] `npm run check` (capped) and the whole e2e. Lower the budget by what it measures, then `npm run stamp`. Commit.

**Done when:**
- `grep -rn "openWhenDone\|waitingHref\|waiting-file\|No trip is open\|/waiting/" src` finds only what "Stays" lists;
- check and the full e2e pass.

---

## The builder's questions (spec check, section 3), answered from the code

1. **Where does Halves get `whenReady()`?** It doesn't need it. With the draft open when nothing else is, `openChat` and `chatFor` go.
   The draft is opened by the UI and main.js, which have `chats`: main.js:169, the shell's core at main.js:239, and `ctx.chats` in
   trip.js:207 and plus.js.
2. **A tap with no draft ready.** The case narrows to a draft that can't be made. The dock's tap tries `openDraft` first. Opened, the
   tap goes on, as + already does when it taps late in the first moments (plus.js:15). Not opened: the + card.
3. **`activeTrip`:** fired, not awaited, as plus.js:16. The open is what matters.
4. **Which wakes count as `me`'s during an open.** A wake takes its scope when it is pushed (`#push`, loop.js:876: `this.#target ??
   ME`), and `#drain` doesn't run while an open is in flight (:1555). So only wakes pushed while the target was null are `me`'s, and the
   guard keys on `this.trip === null` at the drain.
5. **`#/talk/me`'s entries and controls.** The `SHOWN` types draw as lines, with no buttons at all (Task 2). A pre-update hand-over made
   in `me` gets no Undo there. Its Undo stays reachable from the trip its files went to, as long as it is that conversation's newest
   hand-over: the copy written there carries the hand-over's id (trip-tools.js:231). Calls 6.
6. **The row.** It is an undated row through `timelineRows`, so it can fold into a month like any chat line; cards never fold. It shows
   only when `me` has a user line. With only her lines and logged wakes there is nothing of the user's to read back, and a row for it
   would show on every device that ever had a reminder.
7. **The merge card with nothing open.** With the draft open, its wake (main.js:368) runs in the draft like any wake in the open
   conversation. No change to main.js:368.
8. **The waiting chat's author and string.** The author is `system` (createTrip's `o.author`, scopes.js:136), so the name is a guess
   to her (context.js:43). The string is a new key for a conversation's name; the old one heads a list of files.
9. **The wake's words.** It names no paths, then gives the words a hand-over in a chat gets today (handover.js:57): `move_file` what
   belongs to another trip, file the rest here, and a chat becomes a trip by its own dates (patch /trip/trip.json). `start_trip` is
   refused in a chat (trip-tools.js:465), so the words don't name it. No new instruction wording to tune. A short real-model run of
   the chat's first open is the main session's call (Calls 9).
10. **When the run happens.** At start: awaited, before the first screen. After an Undo: before `ctx.go('#/trips')` (talk.js:834). That
    line stays, since the new chat's row sits at now on home.
11. **`me`'s watches.** They stay loaded (live.js:1222). They are the user's reminders, and annai still says them (live.js:1663-1666).
    The logged wake has no reader by design: no turn runs in `me`. Stopping them would drop reminders the user set.
12. **`annai.wake` with nothing open.** The draft is open, so it wakes her there, as in any open conversation. docs/plugins.md:89
    ("wakes Shiori") stays true, so no lessons entry is needed. Only when no draft can be made is it logged in `me`; the same failing
    store would most likely refuse that write too.
13. **Size.** Raise `BUDGET` in Task 2's commit by what it measures and lower it in Task 4's (house rules). Each commit passes check.
14. **e2e "talked with nothing open".** With the draft open at start, such a test lands in the draft's conversation and keeps working.
    What breaks is asserting the no-trip screen or the bare `#/talk` URL. The run after Task 2 gives the list. No `newChat` helper
    unless the run shows a need.

## The spec check's corrections

Agreed and applied:
- **The Undo reason.** Undo's way into the waiting space serves current code too, not only old logs (handover.js:426-428, :165-166).
  Applied in Task 4's "Stays" and in Calls 4.
- **`me`'s row** is placed by one read per page load, not a `talked` mirror. `me` is `kind: 'me'`, `backfillTrips` reads only trips
  (scopes.js:304), and archive.js strips `talked`. No stored change.
- **The waiting chat** is made by `system` (context.js:43).
- **`#/talk/me`:** every old button goes, not only the menu (Review Focus 6). Talking there is the +, listed as a call.
- **The `me`-log fallback** goes, by the user's answer 3.
- **The phone look** drops "Start a trip with the keyboard up", since the form goes in stage 8. progress.md's 11-09 list should drop it
  too: that file is the main session's.
- **Going back on "one chat".** Calls 2 now says the new chat per run goes back on what the user was told ("one chat, written before
  they're dropped"; "a cut-off run resumes").
- **The run's timing:** before the first screen, before an import's results, and before an Undo goes home (Task 3).
- **The side-task read's pick** is kept in the main spec with its case marked gone (Task 4 docs).
- **The quote:** "the next build is the loop's record" is a brief's paraphrase of the picked option "A: remove 2 parts, then record
  (Recommended)". It weighs least, and running side by side still keeps the record as the next build.
- **A chat with the wake and no files** (a cut in the milliseconds after the chat is made) is bucketed Not an issue.
- **`start_trip`** stays for dated trips in stage 7, and becomes the user's question at stage 8.
- **The API list:** added the `#/talk/me` route with its dock and inert buttons, the tool descriptions, and the conversation annai
  makes.
- **`annai.resume`:** the stale key is left (the spec: "The localStorage note goes"; nothing reads it).
- **"Nothing open" means the draft is open,** by the user's answer 2. It removes `openChat`, `chatFor`, the "no draft ready yet"
  ordering, and the box's and camera's special cases.

Partly rejected:
- **`annai.wake` needs a lessons entry and a plugins.md line.** With the draft open, a plugin's wake still wakes her in the open
  conversation, so plugins.md:89 stays true and the plugin API doesn't change. The rest of that finding is applied above.
- **The real-model run.** I agree that RULES 12 applies, and that a model decides how well she files. But the wake reuses the words
  chats already get for a hand-over, so I leave the run to the main session's cost call (Calls 9) rather than making it a gate.

## Calls to confirm

The main session's calls:
1. **Order:** stage 7 beside the turn-end record build, in separate worktrees, each merged when green. The second merges main and
   reruns its gates. The expected conflicts are in the re-plan's section 2: one line in loop.js `#open`, adjacent
   tests, docs, BUDGET and BUILD.
2. **A new "Waiting with Shiori" chat each run, no `waitingChat` setting.** This goes back on what the user was told ("one chat";
   "a cut-off run resumes"). Each run is one chat; a cut run's rest goes to a second chat at the next start. Why: a later batch (an
   old backup, an Undo with nowhere to go back to) then sits at now, where the user looks, not far up the past. It is also one fewer
   stored key.
3. **The wake before the moves, naming no paths,** so a cut never leaves files no one tells her about.
4. **Undo's way into the waiting space stays.** It serves current hand-overs (an emptied trip's leftovers) and pre-update ones (files
   back to where they waited). The spec lists it as "removable", which allows keeping it.
5. **`#/talk/me`:** read-only with every button inert, and the dock as on home, so talking there is the +. This reads the user's "talking
   starts a new chat" as the +; the old plan read it as typing there.
6. **No Undo in `me`'s read-only view.** A pre-update hand-over's Undo stays reachable from the trip its files went to, while it is
   that conversation's newest (trip-tools.js:231).
7. **The Start a trip form stays until stage 8.** progress.md's row 35 says stage 7 removes it: correct that row.
8. **`start_trip` stays for dated trips.** Its removal is the user's question at stage 8.
9. **A short real-model run of the waiting chat's first open** (does she file the moved files well), before release. It is optional
   because the words are the ones chats already get.
10. **The draft open when nothing else is** changes the spec's "`agent.open(null)` stays as nothing open", by the user's answer 2. The
    builder writes the answer into the spec.
11. **Old `me` watches keep firing.** annai says their reminders; their wakes are logged in `me` with no turn.
12. **The import's results don't name the new waiting chat.** Its row is at now on home.

The builder's calls, for review:
13. **`openDraft`** is extracted from `newConversation`. It is the dock's only new path, and only for a draft that can't be made.
14. **Changed APIs** (lessons entries):
    - the routes `#/talk/me`, `#/talk` and `#/plan` with nothing open, and `#/waiting/file` going home;
    - the tools' `/waiting/` root and no-trip words;
    - Halves' `openWhenDone`;
    - `me` taking no turns;
    - the draft open when nothing is;
    - a conversation annai makes.
