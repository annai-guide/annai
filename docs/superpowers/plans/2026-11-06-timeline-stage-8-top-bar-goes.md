# Timeline stage 8: the top bar goes (the plan to build, 2026-11-16)

> Written 2026-11-16 in place of the 2026-11-06 sketch at this path, against main c765b6a6 (line numbers are that commit's, checked by
> reading). Nothing here is built. The build waits on the user's phone look of stages 4 and 7; the e2e task's first half does not (Task 2A).

> For the builders: superpowers:subagent-driven-development or superpowers:executing-plans, task by task, `- [ ]` steps.

## The goal, in the user's words

2026-11-04, the interface redesign: "a bit messy screens and tabs here and there"; "everything come back to the conversation screen"; "all
conversation belongs to a trip. and trip showsup nicely on a timeline." The redesign is the timeline home
(docs/superpowers/specs/2026-11-04-timeline-home-design.md); stages 1 to 7 are released. This is stage 8: "The top bar goes, gear and Trace,
with the e2e rewrite as its own stage."

The user's picks for it:
- How it ships (2026-11-05): "Release in stages; tabs go last (Recommended)". The spec records with it: "The user tries the timeline on a phone
  at stage 4, and the tabs go only after they've said it's right." The look covers stages 4 and 7 together ("After stage 7 ships
  (Recommended)", 2026-11-14).
- 2026-11-16 (to the chief session): "my trip is this friday so I want the current scope to be done and tested asap"; then, picked from chief's
  question, "Before the trip": stage 8 starts once the user has done the phone look, which gates it. Chief's order (2026-11-16, not the user's
  words): the build starts the hour the look is done, and is released early enough that the user can use the new shell for a day before Friday
  2026-11-20; no gate is dropped for the date.
- The spec's :75: `start_trip` stays for a dated trip; "whether it goes is the user's question at stage 8" (Questions, Q1).

The standing rule (2026-11-12): "what I prefer is simple and robust solutions. Again that is #1 in our agent rules. DO NOT miss that. Clever
design sometimes also means accept known limitations early in design phase to avoid scope creeps and bring in more vectors".

## What it does

- The top bar goes: the annai mark, the six tabs (Now, Trips, Itinerary, Conversation, Trace, Settings), plugins' tabs, and swiping between tabs.
- Home's top row holds the gear (Settings) and Trace; plugins' `tab: true` screens are a quiet row of links under it.
- Every screen the bar reached has its own way back: Settings, Trace and a plugin's screen get "← Trips". An installed iPhone app has no Back
  button of its own (whether iOS gives it an edge swipe was not checked; the crumbs make it not matter).
- Now goes. `#/now` (an old bookmark, a history entry, `ui.go('#/now')`) opens today's Itinerary of the trip in play, else home. "Where are
  you?" stays in Driving, which today's Itinerary links to. Now's offline-pack line moves to the Itinerary.
- The Start a trip form goes. Its home-only helpers go with it (nothing is typed on home any more).
- The conversation's name becomes its heading (stage 3's hidden "Conversation" h1 goes). What stuck under the bar sticks at the top.
- The e2e suite stops leaning on the bar, the tabs, Now and the form.

## House rules

- Browser-only, local-first PWA; iPhone Safari is the main target; no new dependency.
- Worktrees inside the project (`annai/.claude/worktrees/`): branch `stage8-e2e` for Task 2A, branch `stage8` for Task 1 (and 2B, 3). No push,
  merge or release by a builder. Never `git stash`. Stage files by name; delete with `/bin/rm -f`, move with `command mv -f`. Commits end with
  your own model's Co-Authored-By line.
- Public repo: no real user details. Fixtures use the test names (Testville, Hotel Aurora Test, ANNAI AIR AN 123). No real-model calls (Task 3's
  run, if the user picks removal, is the main session's). Never read a secret file.
- Read first: the agent rules (RULES.md) in full, for the Builder role and the ladder. Before the route and plugin-API changes, read the shared
  LESSONS.md and docs/lessons.md in full. Each API change gets its entry in docs/lessons-full.md and docs/lessons.md in the same commit.
- New or changed words: `node scripts/strings.mjs`, fill each `new` row in l10n/{ja,zh-Hans,zh-Hant}.tsv and mark it `draft`, rewrite every
  carried draft ("English was: …") to the new English and mark it `ok`, run it again, then `node scripts/strings.mjs --check`. Read
  docs/translating.md first. Rows of words that are gone go by the tool.
- After any change to src/, index.html or sw.js: `npm run stamp`, then `npm run -s catalog`.
- Size: never print scripts/size.mjs line 4 (a 58 KB line). Main stands at 3315.1 of 3316 KiB. Removals come before the one step that adds
  (Step 3), so every commit passes `npm run check` with the budget as it is; Step 7 lowers `BUDGET` to what `npm run size` measures, rounded up
  to the whole KiB, with the reason in the comment. Expected: about -15 KiB in all (each step says its share; measured, not guessed).
- Commands:
  - One unit file: `NODE_OPTIONS=--max-old-space-size=2048 timeout 600 systemd-run --scope --collect -q -p MemoryMax=4G -p MemorySwapMax=4G -- node --test --test-timeout=120000 --import ./test/unit/pin-phone.js test/unit/<file>.test.js`
  - All: `systemd-run --scope --collect -q -p MemoryMax=16G -p MemorySwapMax=16G -- npm run check`
  - E2e: read /proc/pressure/memory first (hold back only when `full avg60` is over 5), then `docker run --rm --memory=8g --ipc=host -v "$PWD":"$PWD" -v <repo>/node_modules:<repo>/node_modules:ro -w "$PWD" mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test <specs…> --workers=16 --retries=2`.
    Then delete test-results/, playwright-report/ and core.[0-9]*, unread. If another build's e2e runs at the same time, rerun any Chromium
    failure on "Opening annai…" alone before calling it real. The full suite is about an hour.
- Hand back a report (`stage8-<task>-report.md` in the working notes), with the src-only diff beside it for Task 1. End it with Calls to
  confirm: the size, each changed behaviour and API, each call of your own, and the calls at the end of this plan.

## Stored and API changes

| What | Change | Old data |
|---|---|---|
| Route `#/now` | Today's Itinerary of the trip in play (`#/trip/<play>/plan`, which opens on today's tab), else home, by the shell's replace | An old bookmark or history entry follows; Back never lands on it again |
| `?from=#/now` on a file, booking or item address | Its crumb goes to the trip's Details (`now` leaves file.js's BACK) | Old history entries |
| `redirectOf(route, target, { play })` (router.js) | Takes the trip in play in an options object, for `#/now` | none |
| Plugin `ui:screen` with `tab: true` | A link in home's quiet row (was a top-bar tab) | none |
| Plugin `ui:screen` page | Its crumb is "← Trips" (was "← Now"); `homeFor`'s take-over is unchanged and comes from home, the conversation and the Itinerary | none |
| `ui.go('#/now')` | As the route | none |
| Class `no-swipe` | No longer needed: annai takes no sideways swipes; harmless where a plugin still sets it | none |
| `now-card`, `now-section` | Drawn at the top of the Itinerary's today only (Now was the other place); same arguments | none |
| `plan-row` | The Itinerary's timetable only | none |
| `experimental.swipeTabs` (app settings) | No longer read or offered; the key is left where it is stored, as `annai.resume` was | Stale key, read by nothing |
| `start_trip` (Kokoro's tool) | Only if the user picks removal (Q1, Task 3) | Undo of a hand-over that started a trip stays, for old logs |

Unchanged: `#/trips` (home), `#/talk` and `#/plan` (the open conversation's, else home), `#/talk/me`, `#/drive`, `#/trace`, `#/settings`,
`#/experimental` (its two other panels stay), every trip address, sw.js's notification target.

## Review Focus

1. **`#/now`, `ui.go('#/now')`, old bookmarks and history entries:** today's Itinerary of the trip in play, else home, by replace; Back never
   bounces on `#/now`. A file opened `?from=#/now` goes back to Details.
2. **No dead ends:** every screen has a way home or back without the browser's Back (list every screen of `SCREENS` and its crumb or ←).
3. **A plugin's `tab: true` screen** is in home's row, opens, and its crumb goes home; turned off, its link goes at the redraw.
4. **A plugin's `homeFor`:** the take-over still runs from home, the conversation and the Itinerary, and its crumb goes home.
5. **Gear and Trace:** reachable from home's body, with a plugin's dock too.
6. **What stuck under the bar** (the conversation's head, home's box with its half cap) sticks at the top, inside the safe area, and nothing
   scrolls under the status bar's words.
7. **Nothing is lost with Now:** the pack line on the Itinerary; where you are, the chips and Driving on today's Itinerary; Driving's ← home.

---

## Task 1: The shell

One builder (Opus xhigh), branch `stage8` from main, after the look. Steps 1 to 7 change src with their tests; Step 8 is the e2e half that can
only pass after them (Task 2B). Steps 4 and 5 are separable: an answer at the look that keeps Now or the form drops that step whole ("What depends
on the phone look").

New behaviour is tested in one new e2e file, `test/e2e/home-shell.spec.js`, so nothing here edits a spec Task 2A edits until Step 8.

### Step 1: The top bar, its tabs and swipes go

**Files:**
- src/ui/shell.js:
  - :52-59 (`SECTION`, and the stray `@type` line above it);
  - :73-99 (`builtIn`, `links`, `nav` and its click handler, `header`, `drawTabs`, `showMore` and its three listeners); :102 (`drawTabs()`);
  - :104-111 (`swipes`, `setSwipes`, the `readAppSettings` read) and `setSwipes` in ctx (:113);
  - :141 (`header` out of `root.replaceChildren`); :148-151 (the bar's ResizeObserver, `--topbar-h`);
  - :188-196 (`lastIn`, `shown.tab`, `PASSING`, `swipedTo`); :281-283 (`arrive` returns 0 for a new entry); :328 (`lastIn.set`);
  - :386-396 (`from`, `at`, `section`, `current`, the links' `aria-current`, `on`) and `tab` out of `shown` (:399); :404-405 (the bar's scroll);
  - :453-482 (the swipe handlers); :509 (`drawTabs()` in the registry's change: the `redraw()` after it draws home's row again);
  - :526's comment ("their top bar the trip"); imports `cameFrom` (:11) and `readAppSettings` (:49), used only by what goes.
- src/ui/base.css:21-32 (`.topbar`, `.brand`, `.topnav`), :35-36 (`.view.swipes`), :236-240 (`.topnav` scroll and fade).
- src/ui/screens/experimental.js:14-17 and :26-28 (the swipe panel); src/ui/screens/settings.js:92 ("such as swiping between tabs": name the
  unfinished translations instead).
- docs/plugins.md:177 (the swipes paragraph: annai takes no sideways swipes; `no-swipe` is no longer needed).

- [ ] Failing e2e first (home-shell.spec.js): no `navigation` named Main and no `.topbar` on home, a conversation, Settings; a sideways swipe on
  a screen leaves it where it is; Settings → Experimental has no swipe switch.
- [ ] Remove. `npm run check`; the new spec; commit.

**Size:** about -8.5 KiB (shell.js about 6.8 KB, CSS 1.5 KB, the panel 0.5 KB).

### Step 2: What took the bar's room

The bar held the top safe area (`env(safe-area-inset-top)`, base.css:24) and set `--topbar-h`, under which two things stick.

**Files:**
- src/ui/base.css:162 (home's box: `top` and the half cap `--lifted`), src/ui/shiori.css:223-224 (the conversation's head): `var(--topbar-h, 0px)`
  becomes one value, `--top: env(safe-area-inset-top, 0px)` on `:root`, and the page's top padding takes it too, as the bar's did. annai's
  status bar style is `default` (index.html:8), under which iOS puts the page below the status bar, so the inset is expected to be 0 there and in
  Safari's portrait (not measured; the user's phone shows it at release). The bar's own padding came with the first shell (dc35e21b), not from a
  measured need, so nothing more guards it.
- src/ui/keep-rows.js:4-5: `covered()` reads `.notices` alone, at least `--top`; it stops being exported (trips.js:305, its other user, goes in
  Step 5).
- src/ui/screens/booking.js:120-123: no bar to scroll clear of; keep the 8 px.
- Comments that name the bar: notices.js:9-11, :20, :41; base.css:156-161; talk.js:648-650, :938; shell.js:138.
- docs/limitations.md:379 ("In landscape, an opened stack…"): the box is now half the screen, not half the room under the bar; measure the
  figures again (740 x 360) and correct them. The entry's approval stands: it is the same limitation with other numbers.

- [ ] Failing e2e first: on a long conversation the head sticks at the top of the screen, opaque, and its ⋯ menu opens below it, inside the
  screen; on home a card in the box sticks at the top and the box is at most half the screen (100svh); a booking opened at one of several blocks
  lands with that block's top in view.
- [ ] Change, run home-shell.spec.js, commit. The older specs that measure stuck things (timeline, details-menu, phone-fixes) pass with 2A's
  `stuckTop` once main is merged in (Step 8).

**Size:** about 0.

### Step 3: Home's body: the gear, Trace and plugins' screens; a way home from each

**Files:**
- src/ui/screens/trips.js:78-79 (`drawTrips`' first child): the h1 "Trips" sits in a head row with "Trace" (`#/trace`) and the gear (`#/settings`,
  ⚙ with the accessible name "Settings"), at the row's end. Under it, only when a plugin has one, a quiet row of links to plugins' `tab: true`
  screens (`slotEntries(ctx, 'ui:screen').filter((e) => e.item?.tab)`, as shell.js:89-90 built them, each `lang` as ext.js:39 sets a plugin's
  title). Not sticky: home's box sticks at the top.
- src/ui/screens/settings.js:98 and src/ui/screens/trace.js:98-99: a crumb "← Trips" (`crumb('#/trips', t\`Trips\`)`, the house's crumb) above
  the h1.
- src/ui/screens/ext.js:44: `renderExt`'s crumb goes home: `'#/trips'`, "Trips" (a `tab` screen and a `homeFor` take-over alike).
- src/ui/screens/sees.js:38 keeps its crumb to the conversation: it opens from the conversation's ⋯ (talk.js:1031), and `#/talk` is still the
  open conversation. (The sketch said it goes home; Calls 4.)
- docs/plugins.md:193 (`tab: true` adds it to a row on home; `homeFor` hands over from Trips, the Conversation and the Itinerary).
- The words exist ("Trips", "Trace", "Settings"); no new string unless the row needs a label.

Where on home is a main-session call (Calls 5; Q2 if chief puts it to the user): the top row. Moving it to the foot (beside Open a file) is the
same function with its row placed after `openFileButton`.

- [ ] Failing e2e first: the gear opens Settings and its crumb comes back home; Trace the same; a plugin with a `tab: true` screen
  (test/fixtures/extensions/trail-ui, whose Hike screen is also `homeFor: 'walking'`) has its link on home, its page's crumb goes home, and turned off the link goes; a `homeFor: 'walking'` screen takes
  over from home and its crumb goes home; with the trail-ui dock (a plugin's dock, which has no gear of its own) the gear and Trace are on home.
- [ ] Every `SCREENS` entry (shell.js:60) checked for a way out without Back: Settings and Trace now have one; the rest had one (their crumbs,
  the conversation's ←, the welcome's buttons, the error page's "Back to Trips"). Write the list in the report.
- [ ] Commit.

**Size:** about +1 KiB.

### Step 4: Now goes (drops whole if the user keeps Now)

**Files:**
- src/ui/screens/now.js: `renderNow` (:14-42) and `nowRow` (:67-78) go. `planRowOf` (:44-65) moves to src/ui/screens/plan.js (plan.js:2 imports
  it from now.js today); `latestCard` and `eventCard` (:80-101) move to src/ui/screens/drive.js (drive.js:10, their other user). now.js is then
  empty: delete it, and its line in sw.js's `SHELL` (:275).
- src/ui/shell.js:27 (import) and :60 (`now: renderNow`).
- src/ui/router.js:31-42: `redirectOf(route, target, { play } = {})`; `#/now` (one part) goes to `#/trip/<play>/plan`, or `#/trips` with no
  play. shell.js:319 passes `{ play: drivingTrip(core) }` (today.js:73: `live.play`, "the happening trip last talked in; else the open
  conversation", never the unused draft). The Itinerary at a trip's address opens that trip's conversation (open-trip.js:21-27), as a tap on its
  Next line does.
- src/ui/today.js:43 (`'now'` out of `TAKEN_FROM`); :104-105 (`driveBack`'s default `'#/trips'`, labelled "Trips", else "Back"); :107-108's comment.
- src/ui/screens/file.js:22-23 (`now` out of `BACK`) and :26-28's comment: an old `?from=#/now` falls back to Details.
- src/ui/offline-pack.js:122-123: Now's pack line ("No offline pack yet.", the m5c plan's nudge for a pack never downloaded) moves to the
  Itinerary, under its sub line (plan.js:95), on every day, so it is seen before the trip too (Calls 7).
- "Where are you?": it stays in Driving (drive.js:97-106), which today's Itinerary of the trip in play links to (plan.js:54-60). The GPS card's
  words (src/ui/live-help.js:24) change from "Now → Driving → Where are you?" to name today's Itinerary, then Driving. today.js:22 ("Open
  Driving to say where you are") already shows on today's Itinerary, above that link. Changed English: three translations.
- Words that name Now: src/ui/screens/simulate.js:88-89 (its text and the Now button: the Itinerary, `#/plan`); src/ui/credits.js:47 ("the Now
  screen's golden hour": the Itinerary's); src/ui/screens/plugin-install.js:209 (`now-card` is "the top of today's itinerary"); src/core/now.js:5's
  comment.
- docs/plugins.md:145, :169 (`ui.go`'s example), :183, :190, :192 (now-section, now-card, plan-row: the Itinerary's today and timetable).
- test/unit/now.test.js:86 (`'#/now'` out of the take-over list; a test that `#/now` no longer hands over), :107-109 (`driveBack`);
  test/unit/ui-pure.test.js:69-77 (`redirectOf`: `#/now` with a play, with none, and the options object absent).

- [ ] Failing unit tests first (router, today), then failing e2e: `#/now` with a happening trip lands on its today's tab (where you are, the
  chips, Driving), and Back from there doesn't return to `#/now`; with nothing in play it lands home; a plugin's `ui.go('#/now')` does the same;
  a file opened `?from=#/now` crumbs to Details; the pack line shows on the Itinerary of a trip with places and no pack.
- [ ] Move, remove, stamp, commit.

**Size:** about -2.5 KiB.

### Step 5: The Start a trip form goes (and what only it needed)

**Files:**
- src/ui/screens/trips.js: :25-29's comment; :32-34 (the form's resets); :85 (`newTripForm(ctx)`); :251-308 (`tripError`, `tripTyped`,
  `newTripForm`, `clearOfBox`); `followClock`'s wait for a typed field (:110-112's comment, :117-119, :125-127): home has no field now; the
  `'dates'` fold class (:181). Imports used only by those (`field`, `createTrip`, `explainStorageFull`, `requestPersist`, `covered`, `isField`):
  check each. `explainTrip` (:310-316) stays for Details (trip.js:21); its comment drops "Start a trip".
- Home's typing parts lose their only case, a field on home (`#/talk/me`, the other `body.home`, has none either): base.css:164-168
  (`html.typing-elsewhere body.home .notices`), shiori.css:107 (the + hidden while typing on home), notices.js:285-289 (`hold`) and shell.js:101's
  `ended: () => notices.hold()`, dock-hides.js:45's `ended` option. The dock stepping aside while typing elsewhere stays (every other screen has
  fields). The user's pick "Unstick while typing" (2026-11-10) has no case left (Calls 8).
- src/core/agent/context.js:40, :74 comments ("Start a trip").
- The spec's What goes (:133-138): the form marked done in stage 8.

- [ ] Failing e2e first: home has no "Trip name" field and no Start trip button; a trip still begins with + (the existing timeline tests).
- [ ] Remove, commit.

**Size:** about -5.5 KiB.

### Step 6: The conversation's heading

**Files:** src/ui/screens/talk.js:648-655. The hidden h1 ("Conversation", or `me`'s title) goes; the name in the head (`name`, :639) becomes the
h1, the link to Details inside it for a trip, the plain title for `me` ("Shiori, no trip"). It keeps the name's look (shiori.css:227: no margin,
the same size), so nothing on screen moves.

- [ ] Failing e2e first: on a conversation the one level-1 heading is its name; on `#/talk/me` it is "Shiori, no trip"; the name still opens
  Details. Commit.

**Size:** about 0.

### Step 7: Words, docs, lessons and the budget

- [ ] `node scripts/strings.mjs`, the changed and new rows in ja, zh-Hans and zh-Hant (Steps 3 and 4), `--check`.
- [ ] docs/plugins.md read whole for "top bar", "tab", "Now", "swipe": each line true to what is built.
- [ ] Lessons: one entry in docs/lessons-full.md and its line in docs/lessons.md for the route and plugin-API changes (the table above). The
  lesson I'd expect: when a way between screens goes, every screen it reached gets its own way back, and every address it had is sent to its new
  meaning. If it would change a design in an unrelated repo, propose its LESSONS.md line in the report (the main session adds it).
- [ ] The timeline spec: What goes and Stages marked done in stage 8, and a "Changed by the stage 8 plan" note for the calls below (Settings and
  Trace crumbs, the pack line, the typing parts, sees' crumb). The user's answer to Q1 as a "Decided by the user" line, in their words.
- [ ] `BUDGET` lowered (house rules), `npm run stamp`, `npm run -s catalog`, check. Commit.

### Step 8: The suite meets the shell (Task 2B)

Merge main (with Task 2A in it) into `stage8`, then run the whole e2e. What fails should be the 2B list below and nothing else; anything else
is a regression of Steps 1 to 7, fixed in src.

- [ ] Work the 2B list. Commit the e2e changes apart from src. Run the whole e2e. Hand back.

---

## Task 2: The e2e rewrite

### The recount (main c765b6a6, 2026-11-16; 791 tests in 92 files of test/e2e)

Measured with `grep` on test/e2e/*.js; the commands are in this plan's report. "Keeps working" means the shell still answers that address.

| What | Lines | Files | After stage 8 |
|---|---|---|---|
| `#/trips` | 245 | 46 | keeps working: home keeps its address |
| bare `#/talk` (and `#/talk/me`) | 82 (3) | 30 | keeps working: the redirect stays |
| bare `#/plan` | 10 | 8 | keeps working |
| `#/now` | 25 | 11 | breaks: redirects to an Itinerary |
| level-1 headings | 320 | | only the hidden "Conversation" goes: 38 lines in 18 files name it (any level) |
| the top bar (`navigation` "Main", `.topnav`) | 69 (57 name the navigation, 12 the class), and 11 more through locals (`tab()`, `bar`, `main`) | 26 | breaks |
| the bar's geometry (`.topbar`, `--topbar-h`) | 27 | 7 | breaks |
| swipes (`turnOnSwipes`, the switch, the tab swipe) | 14 | 4 | goes |
| `startTrip(` calls | 160, and 6 definitions (helpers.js and 5 local copies) | 36 | the form goes |
| the form used inline ("Start trip" clicked) | 32 | 20 | the form goes |

Against the earlier counts (progress, main 5e2c6565: 230 `#/trips`, 88 `#/talk`, 25 `#/now`, 304 h1 lines, 54 top-bar clicks, 153 `startTrip`
calls; the spec's 2026-11-06: 133, 68, 22, 98 h1 assertions, 43 clicks, 130): `#/trips`, `#/talk` and h1 lines need no rewrite, since the
addresses stay and one h1 goes; the work is the bar, the form, Now and the hidden heading.

### The helpers (test/e2e/helpers.js)

Each passes on main as it is and after Task 1, so 2A can land first.

- **`startTrip(page, title, dates?)`**, same signature, same landing: the trip is made in the page with annai's own `createTrip`, through a
  second IndexedDB connection as `happeningTrip` (helpers.js:532-548) does, then `goToHash(page, '#/trip/<id>')` (Details, which opens it, as the
  form's `ctx.go` did) and waits for its level-1 heading. It works from any screen. The 160 calls don't change; the 5 local copies and the 32
  inline uses become calls of it. Live mode doesn't hear of a trip made this way until a reload (its own Workspace's onChange isn't fired); the
  6 dated calls are all in the future, and an undated trip is never the happening one, so the trip in play is the open conversation either way.
  A test that turns out to need live mode to know the trip reloads after it, as `happeningTrip` does.
- **`atConversation(page)`**: waits for `main .talk-head` and returns it; it replaces the 38 lines that wait on the "Conversation" heading. The
  3 that use that heading's box as a place to tap (dock-text.spec.js:160, conversation-menu.spec.js:152 and the like) pick a point on the
  conversation that is no control.
- **`goHome(page)`**: `goToHash(page, '#/trips')` and the level-1 "Trips". It replaces the "Trips" tab and `pastWelcome`'s click.
- **`openTalk(page)`**: `goToHash(page, '#/talk')`, then `atConversation`. The tab went to the open conversation's address with one new entry;
  `#/talk` gets there by the shell's replace, with one new entry too.
- **`openItinerary(page)`**: `goToHash(page, '#/plan')` and the level-1 "Itinerary". `#/settings` and `#/trace` by `goToHash` as they are. The two
  in-page clicks of `nav.topnav a[href="#/settings"]` (hand-over.spec.js:87, trips.spec.js:1361) become `location.hash = '#/settings'` in the same
  `evaluate`, the same moment.
- **`stuckTop(page)`**: where stuck things stick: the bar's bottom while there is a bar, else 0 (the safe area is 0 in Playwright). The 27
  geometry lines measure against it. 2B inlines 0 and removes it.

### 2A: the rewrite that passes on main (no shipped code)

One builder (Opus xhigh), branch `stage8-e2e` from main, in its own worktree. It may start before the look (Calls 1): it removes no test and
changes no shipped file, so the app and its coverage are as they were, whatever the look says.

- [ ] The helpers above, then the files, a group at a time:
  1. The form: helpers.js:516-529 and the five local copies (bring-in.spec.js:7, photos.spec.js:15, plan.spec.js:8, roundtrip.spec.js:12,
     trips.spec.js:8) become the shared `startTrip`; the inline uses in conversation-menu, live-koe, backups-files, koe-voice, koe-modes,
     her-instructions, shiori (3), models, plugins (2), trace (3), whole-replies, updates, and helpers.js's `koeSetUp` (:672-673). Leave the
     tests whose subject is the form (2B).
  2. The bar's clicks (of 20 on Trips, 15 on Conversation, 11 on Itinerary and 2 on Settings in all, those outside the 2B table) and the two
     in-page clicks, to the helpers above, in
     gemini-kept, live-koe, hand-over, evening, file-details, details-menu, koe-voice, reading-files, shell, no-trip, backups-peek, backups,
     plan, gemini, roundtrip, l10n, shiori, trips, helpers (`pastWelcome`). restore.spec.js:32 waits for `main.view > *`.
     Leave the tests whose subject is the bar, a tab or a swipe (2B).
  3. The heading: the 38 "Conversation" heading lines to `atConversation`.
  4. Geometry: the 27 `.topbar` lines (timeline, details-menu, phone-fixes, phone-ui, conversation-menu, file-details, phone-fit) to `stuckTop`.
     The tests that grow the bar itself (details-menu.spec.js:412-430, the bar 48 px taller) are about the bar: 2B.
  5. `#/now` used only as a screen with the dock: live.spec.js:46, :105, :130, :150, :228 (Details, whose h1 is the trip's name, as Now's was),
     push.spec.js:19, :76 and push-sw.spec.js:24 (`#/trips`). Leave every line that reads Now's own parts (`.now-place`, its chips, Next, Latest,
     `.pack-line`, its h1 as a check of Now) to 2B: live.spec.js:159, now.spec.js, drive.spec.js, ui-extension.spec.js, pack.spec.js, l10n.spec.js,
     file-details.spec.js:178, phone-fixes.spec.js:288, phone-fit.spec.js:26, no-null.spec.js:71.
- [ ] Each changed spec passes on main in Docker, both browsers: about 48 of the 92 files, about 40 minutes a run. A test that only passes
  with a change of meaning is left as it was and listed.
- [ ] Hand back with the list of files changed and of tests left for 2B. Review (Opus xhigh with Haiku second opinions on 15 KB slices), one
  fix round if needed, then the main session merges it into main: tests only, nothing to release.

### 2B: what passes only after Task 1 (the shell builder's Step 8)

| Kind | Where | What becomes of it |
|---|---|---|
| The bar and tabs | phone-fit.spec.js:120 (the bar shows there is more); trips.spec.js:647 (tab lit), :968-972 (the tabs' Back); phone-fixes.spec.js:67-99 (the tab says Plan), :290; languages.spec.js:272; plan.spec.js:318 and :333 (the bar's scroll, in a test of the day strip), :362-365 | The tab-lit checks go; a test of Back or a strip keeps its subject, moved by address |
| Swipes | phone-fit.spec.js:162, :173, :231, :248, :263; plan.spec.js:501-517; settings.spec.js:25-35; helpers.js:87-96 (`turnOnSwipes`) | Go |
| The bar's own geometry | details-menu.spec.js:412-430 | Goes (Step 2's new test covers the head at the top) |
| `stuckTop` | the 27 lines 2A moved | 0, inlined; the helper goes |
| Now | now.spec.js (3 tests), drive.spec.js:6 and :126-135, ui-extension.spec.js:38-40, :69-70, :296-301, pack.spec.js:62-63, l10n.spec.js:220, :236, :343, live.spec.js:159, file-details.spec.js:178, phone-fixes.spec.js:288, phone-fit.spec.js:26, no-null.spec.js:71 | Onto today's Itinerary of a trip dated today (`happeningTrip`) or Driving: where you are, the chips, the sun, a plugin's now-card and sections, plan rows. Now's Latest card and its four Next rows go with it (Driving's latest card and the conversation's Next line have their own tests). `#/now` stays in no-null's list as a redirect |
| A plugin's tab | ui-extension.spec.js:34-35, :54 | The Hike link on home's row |
| The form | trips.spec.js (a blank name, "needs only a name"), timeline.spec.js (11 tests: the box letting go while typing on home, the clock's redraw waiting on the form, the form's error and fold), l10n.spec.js:20-35 (the form's words), shell.spec.js:102-118 (a field's height in a column: onto Details' name and dates) | Go, except shell.spec.js's, which moves to Details |
| The heading | `atConversation` | May tighten to the level-1 name |
| Units | now.test.js, ui-pure.test.js | Done in Step 4 |

### How the two tasks meet

1. 2A starts first (before the look if chief agrees, else beside Task 1), and merges into main once reviewed. Task 1 never edits a spec 2A
   edits before Step 8: its new tests are in home-shell.spec.js.
2. Until 2A is on main, Task 1 runs its unit tests, `npm run check`, home-shell.spec.js, and the specs 2A doesn't touch and that name nothing
   that goes (their list: the spec files minus 2A's list minus the 2B table's files), so a regression shows before the merge.
3. Step 8 merges main into `stage8`; the whole suite's failures are the 2B list. Both browsers, `--retries=2`.

---

## Task 3: Also removable

- **`start_trip` in a dated trip:** the user's question (Q1). Recommended: keep it; nothing to build. If the user picks removal, it ships after
  the trip as its own small change, not with stage 8: trip-tools.js:453-475 (the tool), context.js:74's comment, its 31 test references
  (trip-tools.test.js 25, agent-handover.test.js 2, handover-undo.test.js 1, hand-over.spec.js 3); a hand-over's Undo of a trip she started
  (handover.js:103, :152, :290, :323) stays for older logs, its tests moved to fixtures of such a log; and a short real-model run (about $0.30)
  of a booking for a new trip handed inside a dated trip, since she then keeps it there or moves it to an existing trip and tells the user to
  tap + for a new one.
- **Hand-over's back-to-waiting Undo:** stays, nothing to build. It serves current hand-overs (a trip she started, emptied by Undo, sends its
  leftover files back to wait, handover.js:424) and older ones (files back to where they waited); stage 7 moves the waiting files into a
  "Waiting with Shiori" chat after each Undo. The spec's Stages line already says it stays.
- **`swipeTabs`:** goes in Step 1 with the tabs. Its stored key is left, read by nothing.

## What depends on the phone look

The look's list (progress, "Your checks", 3): opening from the icon; the stuck box (half the screen, More and Less, buttons at the edge,
Safari's bars); the dock at rest; + with Voice on; a new chat knowing only profile and memory, its name and dates; the "Waiting with Shiori"
chat; the "Shiori, no trip" row; then "is the timeline right?".

| Part | Depends on the look? | If the user says otherwise |
|---|---|---|
| Task 2A | No | Nothing: it removes no test and changes no shipped file |
| Step 1 (bar, tabs, swipes) | Yes, the gate itself | "Not right" or "keep the tabs": stage 8 does not start; what they want fixed comes first as its own change, and the gate is asked again |
| Step 2 (the room) | Only the box's cap | If the half is wrong (item 2), the new cap goes in the same CSS line, here |
| Step 3 (gear, Trace, row) | Loosely | If the dock at rest changes (item 3), place the gear with it in mind; Q2 decides top or foot |
| Step 4 (Now) | Yes | "Keep Now": the step drops; Now gets a link in home's row, `#/now` stays a screen, and 2B's Now rows stay as they are |
| Step 5 (the form) | No (the spec decided it; the look's list dropped the form) | Only if the user asks for it back |
| Steps 6, 7, 8 | No | |
| Task 3 | No (Q1 decides it) | |
| Items 1, 4, 5, 6, 7 | Not stage 8's | A fix is its own change, before or after stage 8 as chief orders |

## Questions for the user (askable now, before the look)

**Q1. `start_trip` in a dated trip: keep it or remove it?** (The spec's :75: "whether it goes is the user's question at stage 8".)
Inside a dated trip, when you hand Shiori a booking for a trip that doesn't exist yet (a flight to Anchorage while you're in Kyoto), she can start
that trip for you: a new card on the timeline, dated from the booking, with the file in it, and you stay in Kyoto. Since stage 4 that is the only
place she can start a trip; in an undated chat she gives the chat itself its dates.
1. **Keep it (Recommended).** Nothing changes. It is the one way a booking for a new trip gets its own card without you handing it over again.
   Removing it takes out about 25 lines of the tool, but none of the Undo code, which older hand-overs still need, and it changes what Shiori
   does days before your trip.
2. **Remove it, after the trip.** She keeps such a file in the trip you're in, or moves it to a trip you already have, and tells you to tap +
   and hand it over there for a new one. About 25 lines and 31 test references go; a short real-model run (about $0.30) checks she says it right.

What waits on it: Task 3 only; stage 8 ships the same either way. It drops none of your words.

**Q2. Where do the gear (Settings) and Trace sit on home?** (Chief may decide it: the spec says only "in the home screen's body".)
1. **At the top, beside "Trips" (Recommended).** Where apps keep their settings; a tap on the iPhone's status bar takes you there. Home opens at
   the now line, so on a long timeline it is above what you see.
2. **At the foot, with Open a file and the last backup.** Near where home opens, since few rows sit below now; it moves down as trips are added.

What waits on it: Step 3's placement (the same work either way, and easy to move later).

## Schedule

Hours are wall-clock estimates from stage 7 (2026-11-14 to 15: build about 5 h, review 40 min, each fix round 1 to 1.5 h, each re-review about
25 min, gate and release about 2 h). PST. The look done by Tuesday 2026-11-17, 09:00.

| Step | Who | Hours | Done by |
|---|---|---|---|
| Spec check of this plan, and its fixes | a fresh agent (Opus xhigh), then the main session | 1 | Mon evening |
| 2A build (if chief agrees to start before the look) | Opus xhigh | 4 | Tue early |
| 2A review, fix, merge into main (tests only) | Opus xhigh + Haiku slices; Sonnet xhigh fixer | 1.75 | Tue morning |
| The look, and Q1 and Q2 answered | the user | | Tue 09:00 |
| Task 1, Steps 1 to 7 | Opus xhigh | 4 | Tue 13:00 |
| Step 8 (2B) and the whole e2e | the same builder | 2.5 | Tue 15:30 |
| Final review | Fable high, Haiku on 15 KB slices of the branch (about 6) | 1 | Tue 16:30 |
| One fix round, and its re-review | Sonnet xhigh; Opus xhigh + Haiku | 2 | Tue 18:30 |
| The full gate: check, the whole e2e in Docker | main session | 1.25 | Tue 19:45 |
| Release (`annai-release`, standing OK) | main session | 0.5 | Tue about 20:15 |

**Does a release by Wednesday 2026-11-18 night hold, with the look done Tuesday morning?** Yes, with about a day to spare. A second fix round
(2 h), the design check RULES.md asks for after it (1 h) and a third round (2 h) still land Wednesday morning. Without 2A started early, 2A runs
beside Task 1 from 09:00 and Step 8 waits for its merge: release about Tuesday 22:00. What could still push it: the usage limits pausing agents,
or a look that comes Wednesday.

**If it doesn't hold** (the look Wednesday afternoon or later), a smaller first cut, with no gate dropped (review, fix round, whole e2e):
- **8a, before the trip:** Steps 1 to 4, 6 and 7, and 2B for them: the bar, tabs, swipes and Now go; gear, Trace and the crumbs; the room; the
  heading; `#/now`.
- **8b, after the trip:** Step 5 (the form and home's typing parts, with their 14 or so tests) and Task 3 if the user picks removal. The form works
  without the bar, so nothing breaks while it waits. It saves about 1.5 hours.

## The builder's questions, answered from the code

1. **Is any screen a dead end without the bar?** Settings (settings.js:98) and Trace (trace.js:98-99) have no crumb; every other screen has one,
   or a ← (the conversation), or buttons home (the welcome), or "Back to Trips" (the error page, shell.js:436). Step 3 adds the two.
2. **Does `#/now` need the trip in play at a cold start?** live mode's start (main.js:223) isn't awaited before the shell starts (:251); until it has read the trips,
   `play` is the open conversation (live.js:729-733), never the draft. So a cold `#/now` lands on the open trip's Itinerary, or home with the draft
   open. Good enough for an old bookmark.
3. **Where do Now's parts go?** Where you are, the chips and Driving: today's Itinerary (plan.js:54-60, already). Next: home's happening card
   and the conversation's Next line. Latest: Driving and the conversation. The pack line: the Itinerary (Step 4). The four-row timetable and
   "The whole itinerary": the Itinerary itself.
4. **Is there still a field on home?** No: the form was the only one (followClock's `typing`, trips.js:119, looks inside home's screen only).
   `#/talk/me` has no type box. So the typing parts of Step 5 have no case.
5. **Does Settings → Experimental stay?** Yes: unfinished translations and Remote trace remain on it.
6. **What about `#/talk` and `#/plan` with the draft open?** Unchanged since stage 7: the draft's own address.

## Calls to confirm

For the main session and chief:
1. **2A starts before the look and merges into main when reviewed.** It changes no shipped file and removes no test, so the app and its
   coverage are what they were whatever the look says; it takes about 4 hours off the path after the look. Chief's order said the e2e rewrite's
   design starts now; this goes one step further.
2. **2B is the shell builder's Step 8,** not a third agent: it knows what it removed, and the 2B table is its list.
3. **`startTrip` makes the trip through a second IndexedDB connection,** as `happeningTrip` already does, so the 160 calls don't change; live
   mode hears of it only at a reload, which no current call needs (checked by 2A's run on main).

The plan's own calls:
4. **sees.js keeps its crumb to the conversation** (the sketch said it goes home): it opens from the conversation's ⋯.
5. **Settings and Trace get "← Trips"**, which the spec doesn't name: without the bar they would have no way out in an installed app. The gear
   and Trace sit in home's top row (Q2's option 1) unless the user or chief picks the foot.
6. **"Where are you?" stays in Driving,** reached from today's Itinerary of the trip in play; the GPS card's words say so. With no trip in play
   (nothing happening, no trip open) there is no Driving to reach, and a manual place has nothing to remind about.
7. **Now's offline-pack line moves to the Itinerary**, on every day, so a trip with no pack still says so (the m5c plan: "Now says 'No offline
   pack for this trip yet'"); the first download is a tap, so this nudge matters before a trip. Now's Latest card and its four Next rows go
   with Now; Driving, home's happening card and the conversation's Next line show them.
8. **Home's typing parts go with the form:** the user's "Unstick while typing" (2026-11-10) has no case left on home. Its code (about 1.5 KB)
   and its tests go with the form's; the dock stepping aside while typing stays everywhere.
9. **The conversation's name becomes its h1** (the spec's header: "the name (to Details)").
10. **`#/now` with nothing in play goes home**; a file opened `?from=#/now` crumbs to Details; Driving's ← with nowhere it came from goes home.
11. **`experimental.swipeTabs` is left in stored settings,** read by nothing, as `annai.resume` was.
12. **The limitations entry on the landscape stack box** gets new figures (half the screen, not half the room under the bar); its approval
    stands.
13. **No Itinerary item in the conversation's ⋯:** a trip's Next line and its Details reach it. If the user misses the tab, it is one line.
14. **Size:** about -15 KiB in all (the sketch said -25 KiB, against older code).
15. **Q1's removal ships after the trip** if picked; Task 3 builds nothing if the user keeps `start_trip`.
16. **Changed APIs** (lessons entries): `#/now`; `redirectOf`'s options; `tab: true`'s place; a plugin screen's crumb; `ui.go('#/now')`;
    `no-swipe`; `now-card` and `now-section` on the Itinerary only; `experimental.swipeTabs`.
