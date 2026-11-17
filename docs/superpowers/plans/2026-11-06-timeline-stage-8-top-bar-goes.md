# Timeline stage 8: the top bar goes (the plan to build, 2026-11-16)

> Written 2026-11-16 in place of the 2026-11-06 sketch at this path, against main e36ae0d2 (line numbers are that commit's, checked by
> reading). Nothing here is built. The build waits on the user's phone look of stages 4 and 7; the e2e task's first half does not (Task 2A).
>
> Fix pass 1, 2026-11-16: the corrections of the plan's spec check, each verified against the code first. Main's src, test, sw.js and
> index.html are still e36ae0d2's, so the line numbers hold; the booking-say-r4 branch (9233f9c4, not on main yet) edits base.css, booking.js
> (3 lines out above :120), file.js (a comment) and plan.js (near :156) as well as two e2e specs: find each place by what it says if a line
> has moved. Paths without a directory are in src/ui/, src/ui/screens/ or test/e2e/ as the step says; `live.js` is src/core/live/live.js and
> `main.js` is src/app/main.js.

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

The standing decision (2026-10-19): "Scope is never cut or reordered for the trip." The date shapes the schedule below, never what is in or out
of the stage: nothing in this plan defers a part for it, and if the schedule slips, what to do is chief's question then (Schedule), not
the plan's.

## What it does

- The top bar goes: the annai mark, the six tabs (Now, Trips, Itinerary, Conversation, Trace, Settings), plugins' tabs, and swiping between tabs.
- Home's top row holds the gear (Settings) and Trace; plugins' `tab: true` screens are a quiet row of links under it.
- Every screen the bar reached has its own way back: Settings, Trace and a plugin's screen get "← Trips". An installed iPhone app has no Back
  button of its own (whether iOS gives it an edge swipe was not checked; the crumbs make it not matter).
- Now goes. `#/now` (an old bookmark, a history entry, `ui.go('#/now')`) opens today's Itinerary of the trip in play, else home. "Where are
  you?" stays in Driving, which today's Itinerary links to, and the GPS-refused card gets a "Say where you are" button that goes there.
  Now's offline-pack line moves to the Itinerary.
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
| Route `#/now` | Today's Itinerary of the trip in play (`#/trip/<play>/plan`, which opens on today's tab; it opens that trip's conversation, as every trip address does: Review Focus 1), else home, by the shell's replace | An old bookmark or history entry follows; Back never lands on it again |
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
`#/experimental` (its other panels stay: Remote trace, and Unfinished translations while a language is marked experimental, which none is
today: `EXPERIMENTAL` is `[]`, src/core/l10n-list.js:4), every trip address, sw.js's notification target.

## Review Focus

1. **`#/now`, `ui.go('#/now')`, old bookmarks and history entries:** today's Itinerary of the trip in play, else home, by replace; Back never
   bounces on `#/now`. A file opened `?from=#/now` goes back to Details. **Not a new finding:** `#/trip/<play>/plan` runs `openTrip`
   (src/ui/open-trip.js:21-27), so with another conversation open, `#/now` stops that conversation's turn and closes a live session. It
   happens for a plugin's `ui.go('#/now')` and for Back onto a `#/now` entry from before the update. The spec chose "the trip in play", and
   docs/lessons.md:36 allows it ("only when the user moved there"); the lessons entry (Step 7) says so. At a cold start it can also land
   on the draft's empty Itinerary (Task 1, builder question 2): chosen, harmless.
2. **No dead ends:** every screen has a way home or back without the browser's Back (list every screen of `SCREENS` and its crumb or ←).
3. **A plugin's `tab: true` screen** is in home's row, opens, and its crumb goes home; turned off, its link goes at the redraw.
4. **A plugin's `homeFor`:** the take-over still runs from home, the conversation and the Itinerary, and its crumb goes home.
5. **Gear and Trace:** reachable from home's body, with a plugin's dock too.
6. **What stuck under the bar** (the conversation's head, home's box with its half cap) sticks at the top, inside the safe area, and nothing
   scrolls under the status bar's words. This holds by construction only where the top inset is 0 (expected in standalone with
   status-bar style `default`, and in Safari portrait; not measured: Playwright has no inset). It is the first thing checked on the phone at
   release (Step 2 says what to do if it isn't 0).
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
- src/ui/screens/experimental.js:14-17 and :26-28 (the swipe panel). Experimental is then left with Remote trace, an install link for
  developers and no switch: its Unfinished translations panel is hidden, because `EXPERIMENTAL` is `[]` (src/core/l10n-list.js:4,
  experimental.js:29) and shows again only if a language is marked experimental.
- src/ui/screens/settings.js:92 ("Features still being tried, such as swiping between tabs. Each is off until you turn it on."): say only
  what is true after this step, for example "Features still being tried, and developer tools such as Remote trace." (no "each is off until
  you turn it on": Remote trace is an install link; nothing is a switch). Changed English: three translations (Step 7).
- docs/plugins.md:177 (the swipes paragraph: annai takes no sideways swipes; `no-swipe` is no longer needed).

- [ ] Failing e2e first (home-shell.spec.js): no `navigation` named Main and no `.topbar` on home, a conversation, Settings; a sideways swipe on
  a screen leaves it where it is; Settings → Experimental has no swipe switch.
- [ ] Remove. `npm run check`; the new spec; commit.

**Size:** about -8.5 KiB (shell.js about 6.8 KB, CSS 1.5 KB, the panel 0.5 KB).

### Step 2: What took the bar's room

The bar held the top safe area (`env(safe-area-inset-top)`, base.css:24) and set `--topbar-h`, under which two things stick.

**Files:**
- src/ui/base.css:162 (home's box: `top` and the half cap `--lifted`), src/ui/shiori.css:223-224 (the conversation's head): `var(--topbar-h, 0px)`
  becomes one value, `--top: env(safe-area-inset-top, 0px)` on `:root`. The top padding goes on `body` (`padding-top: var(--top)`, beside its
  `padding-bottom: env(safe-area-inset-bottom, 0px)`, base.css:5-9): body holds the notices box, the install banner and `main`, so all three
  sit below the inset, as they sat below the bar's own padding. annai's status bar style is `default` (index.html:8), under which iOS puts
  the page below the status bar, so the inset is expected to be 0 there and in Safari's portrait (not measured; Playwright has no inset).
  The bar's own padding came with the first shell (dc35e21b), not from a measured need, so nothing more guards it.
  **Decided:** no paper strip is built now. The bar also painted paper over the status bar's strip while the page scrolled; with an inset of 0
  there is no strip. At release the main session scrolls a long screen on the phone and looks at the status bar (Review Focus 6). If the
  inset isn't 0, one fixed paper strip, `--top` tall, takes the bar's old job (it replaces what the bar did, so it is not a new guard), as a
  fix before the release.
- src/ui/keep-rows.js:4-5: `covered()` reads `.notices` alone: `Math.max(0, document.querySelector('.notices')?.getBoundingClientRect().bottom
  ?? 0)`. A stuck box's bottom already includes the inset (it sticks at `top: var(--top)`), and an empty box scrolled out of view has a negative
  bottom, so 0 is the floor. It does not read `--top` from JS: whether WebKit's `getComputedStyle` resolves `env()` in a custom property is
  not checked, and nothing needs it. It stops being exported (trips.js:305, its other user, goes in Step 5).
- src/ui/screens/booking.js:120-123: no bar to scroll clear of; keep the 8 px.
- Comments that name the bar: notices.js:9-11, :20, :41; base.css:146, :156-161; shiori.css:223 and :297 ("above the top bar"); keep-rows.js:9;
  talk.js:648-650, :938; shell.js:138.
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
  ⚙ with the accessible name "Settings"), at the row's end (Q2's option 1, until chief or the user says otherwise). Under it, only when a
  plugin has one, a quiet row of links to plugins' `tab: true`
  screens (`slotEntries(ctx, 'ui:screen').filter((e) => e.item?.tab)`, as shell.js:89-90 built them, each `lang` as ext.js:39 sets a plugin's
  title). Not sticky: home's box sticks at the top.
- src/ui/screens/settings.js:98 and src/ui/screens/trace.js:98-99: a crumb "← Trips" (`crumb('#/trips', t\`Trips\`)`, the house's crumb) above
  the h1. It is fixed, not "back to where you came from": Settings and Trace are also reached from a card inside a conversation (the
  storage-full card's "Export a backup", storage-full.js:16; the error card's "Open Trace", main.js:438), and from there the way back is
  now Trips, then the conversation's row, where the Conversation tab was one tap (Calls 5). The usual way in is home's gear, and a crumb
  that remembers its entry (as Driving's `drivingFrom` does) would add state for a rare path.
- src/ui/screens/ext.js:44: `renderExt`'s crumb goes home: `'#/trips'`, "Trips" (a `tab` screen and a `homeFor` take-over alike).
- src/ui/screens/sees.js:38 keeps its crumb to the conversation: it opens from the conversation's ⋯ (talk.js:1031), and `#/talk` is still the
  open conversation. (The sketch said it goes home; Calls 4.)
- docs/plugins.md:193 (`tab: true` adds it to a row on home; `homeFor` hands over from Trips, the Conversation and the Itinerary).
- The words exist ("Trips", "Trace", "Settings"); no new string unless the row needs a label.

Where on home is a main-session call (Calls 5; Q2 if chief puts it to the user): the top row. Moving it to the foot (beside Open a file) is the
same function with its row placed after `openFileButton`.

- [ ] Failing e2e first: the gear opens Settings and its crumb comes back home; Trace the same; a plugin with a `tab: true` screen
  (test/fixtures/extensions/trail-ui, whose Hike screen is also `homeFor: 'walking'`) has its link on home, its page's crumb goes home, and turned off the link goes; a `homeFor: 'walking'` screen takes
  over from home and its crumb goes home; with a plugin's dock (test/fixtures/extensions/trail-look, whose `annai.ui.component('dock', …)` replaces
  the real one and has no gear of its own; trail-ui has only a `dock-action`) the gear and Trace are on home.
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
  conversation", the unused draft left out once live mode has loaded its trips; before that, see builder question 2). The Itinerary at a
  trip's address opens that trip's conversation (open-trip.js:21-27), as a tap on its Next line does (Review Focus 1).
- src/ui/today.js:43 (`'now'` out of `TAKEN_FROM`); :104-105 (`driveBack`'s default `'#/trips'`, labelled "Trips", else "Back"); :107-108's comment.
- src/ui/screens/file.js:22-23 (`now` out of `BACK`) and :26-28's comment: an old `?from=#/now` falls back to Details.
- src/ui/offline-pack.js:122-123: Now's pack line ("No offline pack yet.", the m5c plan's nudge for a pack never downloaded) moves to the
  Itinerary, under its sub line (plan.js:95), on every day, so it is seen before the trip too (Calls 7).
- "Where are you?": it stays in Driving (drive.js:97-106), which today's Itinerary of the trip in play links to (plan.js:54-60). The GPS card
  (src/ui/live-help.js:24, shown by `tellGps`, main.js:301) gets a button instead of words that describe a path: `tellGps` adds `actions: [{
  label: t\`Say where you are\`, run: () => { location.hash = '#/drive'; } }]` to the card it shows (as main.js:260's push card does; the card
  dismisses itself on the tap, notices.js:268), and `again` loses "Now → Driving → Where are you?": "Then turn GPS off and on again. Or tell
  annai where you are." (it keeps the first sentence the unit test reads, sensors.test.js:98). Why a button: one tap, with no path to
  describe in four languages; it works whatever today's Itinerary shows (an undated chat in play has no today tab, so no Driving link);
  Driving already answers having no trip (drive.js:49-52: "Open a trip to see the road ahead."). today.js:22 ("Open Driving to say where you
  are") already shows on today's Itinerary, above its link. Changed English: the sentence, and one new label: three translations each.
  test/unit/sensors.test.js:106 (`/Now → Driving → Where are you/`) becomes a check of the new sentence, and the `tellGps` tests check the
  card carries the action.
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
  fields). The user's pick "Unstick while typing" (2026-11-10) no longer applies, because its case, a text field on home, is gone with the
  form (Calls 8; Step 7 notes it in the spec, quoting the pick).
- src/core/agent/context.js:40, :74 comments ("Start a trip").
- The spec's What goes (:133-138): the form marked done in stage 8.

- [ ] Failing e2e first: home has no "Trip name" field and no Start trip button; a trip still begins with + (the existing timeline tests).
- [ ] Remove, commit.

**Size:** about -5.5 KiB.

### Step 6: The conversation's heading

**Files:** src/ui/screens/talk.js:648-655. The hidden h1 ("Conversation", or `me`'s title) goes; the name in the head (`name`, :638) is wrapped
in the h1: the link to Details inside it for a trip, the plain title for `me` ("Shiori, no trip"). It keeps the name's look, so nothing on
screen moves:
- `name` itself stays what it is (the `a`, or `me`'s `span`, class `talk-name`), and `h('h1', { class: 'talk-title' }, name)` takes its place in
  the head. So the inner link keeps its rules and the rename (talk.js:642, `name.textContent = …`) is untouched: making the h1 the `name` would
  have it write over the link inside. About 35 e2e locators read `.talk-head .talk-name` (text, a click, details-menu.spec.js:100's `href`):
  they stay valid.
- CSS (shiori.css:227): the flex pair (`flex: 1 1 0; min-width: 0`) moves to the new `.talk-title`, with `font: inherit` (an h1's 2em is the
  link's own 20px/600 inside); `.talk-name` keeps its other rules and gains `display: block`, so its ellipsis still cuts the line (an inline
  `a` doesn't clip) and its whole width is still the tap target to Details. base.css:14 already gives h1 no margin.

- [ ] Failing e2e first: on a conversation the one level-1 heading is its name; on `#/talk/me` it is "Shiori, no trip"; the name still opens
  Details. Commit.

**Size:** about 0.

### Step 7: Words, docs, lessons and the budget

- [ ] `node scripts/strings.mjs`, the changed and new rows in ja, zh-Hans and zh-Hant (Steps 1, 3 and 4: Settings' Experimental line, the GPS
  card's sentence and button, the pack line's place), `--check`.
- [ ] The glossary: `Now` (l10n/glossary.tsv:19, "The top bar's first tab") is one of the names Shiori is told in a language that isn't English
  (`TOLD`, scripts/strings.mjs:481; docs/translating.md:83), and no screen is called Now any more (the word stays as home's now line, trips.js:82).
  Take it out of `TOLD` and say in its row that it is the now line's word; read docs/translating.md's "Changing a glossary word" first. That
  changes the line Shiori is told, so every non-English user's cached prompt once: expected. The rows of the other tab names (Conversation,
  Itinerary, Settings, Trace, Trips) cite shell.js:72 or :63 as their source: give each the screen or string that still names it.
- [ ] A last sweep, by `grep -rniE "top bar|topbar|swip|\btabs?\b|\bNow\b"` over src, sw.js, README.md and docs/*.md, each hit true to what is built
  (docs/lessons-full.md and docs/progress.md are history: left; "tab" also means a browser tab or a day tab in places, which stay). Known so far, besides docs/plugins.md read whole (:145, :169,
  :177, :183, :190, :192, :193): README.md:25 ("the Now and Driving screens"), README.md:77 ("Now sections"), docs/limitations.md:568 ("The same
  rows feed Now, Drive's strip and the timeline card's Next": the Itinerary's today).
- [ ] Lessons: one entry in docs/lessons-full.md and its line in docs/lessons.md for the route and plugin-API changes (the table above). The
  lesson I'd expect: when a way between screens goes, every screen it reached gets its own way back, and every address it had is sent to its new
  meaning. The entry also says what `#/now` costs and why it is allowed: it opens the trip in play, which stops another open conversation's
  turn (Review Focus 1; docs/lessons.md:36, "only when the user moved there"; the final review must not raise it as new). If it would change a
  design in an unrelated repo, propose its LESSONS.md line in the report (the main session adds it).
- [ ] The timeline spec: What goes and Stages marked done in stage 8, and a "Changed by the stage 8 plan" note for the calls below (Settings and
  Trace crumbs, the pack line, the typing parts, sees' crumb, the GPS card's button). The user's answer to Q1 as a "Decided by the user" line, in
  their words. On the spec's "While a field on home is typed in (the user, 2026-11-10, "Unstick while typing")" paragraph (:43), a note that
  the pick no longer applies because its case, a text field on home, is gone with the Start a trip form (nothing else on home takes typing:
  notices cards hold text and buttons only, `#/talk/me` has no type box, the dock's own box never counts, dock-hides.js:66, and Open a file is
  `type=file`, which `isField` leaves out); never "dropped". If a field ever comes back to home, the pick applies again.
- [ ] `BUDGET` lowered (house rules), `npm run stamp`, `npm run -s catalog`, check. Commit.

### Step 8: The suite meets the shell (Task 2B)

Merge main (with Task 2A in it, and whatever else has merged since this plan) into `stage8`. The recount and the 2B table are of main
e36ae0d2; branches merged after it add lines (booking-say-r4 already edits plan.spec.js and phone-fixes.spec.js, both on 2A's list).

- [ ] Rerun the recount's greps (below, "How the recount was made") on the merged main. Every hit the recount didn't have goes into the
  2B list or, if it only reads the bar's clicks, is converted as 2A converts them; write the additions in the report.
- [ ] Run the whole e2e. What fails should be the 2B list (with those additions) and nothing else; anything else is a regression of Steps 1 to 7,
  fixed in src.
- [ ] Work the 2B list. Commit the e2e changes apart from src. Run the whole e2e again. Hand back.

---

## Task 2: The e2e rewrite

### The recount (main e36ae0d2, 2026-11-16; 791 tests in 92 files of test/e2e)

Measured with `grep` on test/e2e/*.js; the commands are under "How the recount was made", below the table, for Step 8's rerun.
"Keeps working" means the shell still answers that address.

| What | Lines | Files | After stage 8 |
|---|---|---|---|
| `#/trips` | 245 | 46 | keeps working: home keeps its address |
| bare `#/talk` (and `#/talk/me`) | 82 (3) | 30 | keeps working: the redirect stays |
| bare `#/plan` | 10 | 8 | keeps working |
| `#/now` | 25 | 11 | breaks: redirects to an Itinerary |
| level-1 headings | 320 | | only the hidden "Conversation" goes: 38 lines in 18 files name it (any level) |
| the top bar (`navigation` "Main", `.topnav`) | 69 (57 name the navigation, 12 the class), and 11 more through locals (`tab()`, `bar`, `main`) | 26 | breaks |
| the bar's geometry (`.topbar`, `--topbar-h`) | 27 | 7 | breaks: 13 measure the bar (to `stuckTop`), 6 place a test notices box after it (re-placed, 2A group 4), 4 are inside the form's tests and 2 in the test that grows the bar (2B), 2 are comments |
| swipes (`turnOnSwipes`, the switch, the tab swipe) | 14 | 4 | goes |
| `startTrip(` calls | 160, and 6 definitions (helpers.js and 5 local copies) | 36 | the form goes |
| the form used inline ("Start trip" clicked) | 32 | 20 | the form goes |

Against the earlier counts (progress, main 0e567c5c: 230 `#/trips`, 88 `#/talk`, 25 `#/now`, 304 h1 lines, 54 top-bar clicks, 153 `startTrip`
calls; the spec's 2026-11-06: 133, 68, 22, 98 h1 assertions, 43 clicks, 130): `#/trips`, `#/talk` and h1 lines need no rewrite, since the
addresses stay and one h1 goes; the work is the bar, the form, Now and the hidden heading.

**How the recount was made** (in test/e2e; Step 8 runs these again on the merged main):

```
grep -h '#/trips' *.js | wc -l; grep -l '#/trips' *.js | wc -l                           # 245 lines, 46 files
grep -E "#/talk(['\`\"?]|\)|$)" *.js | wc -l                                               # 82
grep -E '#/now\b' *.js | wc -l; grep -lE '#/now\b' *.js | wc -l                            # 25, 11
grep -E 'level: 1' *.js | wc -l                                                            # 320
grep -E "heading', \{ (level: 1, )?name: 'Conversation'" *.js | wc -l                      # 38 in 18 files
grep -E "name: 'Main'|topnav" *.js | wc -l                                                 # 69 in 26 files (57 + 12)
grep -E 'topbar|--topbar-h' *.js | wc -l                                                   # 27 in 7 files
grep -o 'startTrip(' *.js | wc -l; grep -c 'function startTrip' *.js                       # 166 - 6 definitions = 160 calls, 36 files
grep -E "name: 'Start trip'|accented\('Start trip'\)" *.js | wc -l                         # 32 in 20 files
```

The plan's spec check reproduced these figures on main (`#/now` 25 lines in 11 files, "Start trip" 32 in 20, `.topbar` 27 in 7, the "Conversation" heading
38 in 18, the bar 69 in 26, `startTrip(` 166 in 36).

### The helpers (test/e2e/helpers.js)

Each passes on main as it is and after Task 1, so 2A can land first.

- **`startTrip(page, title, dates?)`**, same signature, same landing: the trip is made in the page with annai's own `createTrip`, through a
  second IndexedDB connection as `happeningTrip` (helpers.js:532-548) does, then `goToHash(page, '#/trip/<id>')` (Details, which opens it, as the
  form's `ctx.go` did) and waits for its level-1 heading. It works from any screen. The 160 calls don't change; the 5 local copies and the 32
  inline uses become calls of it. Live mode doesn't hear of a trip made this way until a reload (its own Workspace's onChange isn't fired); the
  6 dated calls are all in the future, and an undated trip is never the happening one, so the trip in play is the open conversation either way.
  A test that turns out to need live mode to know the trip reloads after it, as `happeningTrip` does. Live mode is not the only listener that
  doesn't hear a second connection's writes: the page's own `ws.onChange` listeners (the draft's chats.js:164, the pack keeper, live mode's)
  and the `appended` followers that home's "changed since" relies on don't either (`syncTripTitles` isn't needed: `createTrip` writes the mirror
  itself). 2A's run on main is the proof that no test needs them; one that does reloads. `startTrip` returns the id as the form's did (read from
  the address it lands on): live.spec.js:130 drops the result today and the switch to Details (group 5) needs it, so it becomes
  `const trip = await startTrip(…)`.
- **`atConversation(page)`**: waits for `main .talk-head` and returns it; it replaces the 38 lines that wait on the "Conversation" heading. The
  3 that use that heading's box as a place to tap (dock-text.spec.js:160, conversation-menu.spec.js:152 and the like) pick a point on the
  conversation that is no control.
- **`goHome(page)`**: `goToHash(page, '#/trips')` and the level-1 "Trips". It replaces the "Trips" tab and `pastWelcome`'s click.
- **`openTalk(page)`**: `goToHash(page, '#/talk')`, then `atConversation`. The tab went to the open conversation's address with one new entry;
  `#/talk` gets there by the shell's replace, with one new entry too.
- **`openItinerary(page)`**: `goToHash(page, '#/plan')` and the level-1 "Itinerary". `#/settings` and `#/trace` by `goToHash` as they are. The two
  in-page clicks of `nav.topnav a[href="#/settings"]` (hand-over.spec.js:87, trips.spec.js:1361) become `location.hash = '#/settings'` in the same
  `evaluate`, the same moment.
- **`stuckTop(page)`**: where stuck things stick: the bar's bottom while there is a bar, else 0 (the safe area is 0 in Playwright). The 13
  lines that measure against the bar (group 4) use it; the ones inside a `page.evaluate` take its value as an argument. 2B inlines 0 and
  removes it.

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
  4. The 27 `.topbar` lines (timeline, details-menu, phone-fixes, phone-ui, conversation-menu, file-details, phone-fit), by what each does:
     - **13 measure the bar,** to `stuckTop`: conversation-menu.spec.js:222; details-menu.spec.js:87; file-details.spec.js:67;
       phone-fit.spec.js:291, :373, :628; phone-fixes.spec.js:167, :483; timeline.spec.js:465, :468, :517, :648, :2151.
     - **6 place a test notices box,** `document.querySelector('header.topbar')?.after(…)`: details-menu.spec.js:450; phone-ui.spec.js:229, :388;
       phone-fixes.spec.js:36, :327, :375. Once the bar is gone `?.after` does nothing and the box never reaches the page, so the test would
       measure nothing and `stuckTop` doesn't cover it. 2A places the box by something that stays, `document.querySelector('main.view').before(…)`
       (the same parent and, on main, the same place in the cascade after the bar, the real `.notices` and the install banner), and shows by
       the run on main that each such test still measures what it did.
     - **4 are in the form's tests** (timeline.spec.js:1035, :1045, :1067, :1150: a field of Start a trip focused under the box): left for 2B,
       which removes them with the tests.
     - **2 are the test that grows the bar** (details-menu.spec.js:426, :429, the bar 48 px taller): about the bar, 2B. The last 2 hits are
       comments (details-menu.spec.js:389, :412, the second with that test): 2B corrects them.
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
| The bar's own geometry | details-menu.spec.js:412-430 (and the comment at :389) | Goes (Step 2's new test covers the head at the top) |
| `stuckTop` | the 13 lines 2A moved | 0, inlined; the helper goes |
| Now | now.spec.js (3 tests), drive.spec.js:6, :111-123 (the dock's box as moving fast begins; it reads `.now .chips`) and :126-135, ui-extension.spec.js:38-40, :69-70, :296-301, pack.spec.js:62-63, l10n.spec.js:220, :236, :343, live.spec.js:159, file-details.spec.js:178, phone-fixes.spec.js:288, phone-fit.spec.js:26, no-null.spec.js:71 | Onto today's Itinerary of a trip dated today (`happeningTrip`) or Driving: where you are, the chips, the sun, a plugin's now-card and sections, plan rows. Now's Latest card and its four Next rows go with it (Driving's latest card and the conversation's Next line have their own tests). `#/now` stays in no-null's list as a redirect |
| A plugin's tab | ui-extension.spec.js:34-35, :54 | The Hike link on home's row |
| The form | trips.spec.js (a blank name, "needs only a name"), timeline.spec.js (11 tests: the box letting go while typing on home, the clock's redraw waiting on the form, the form's error and fold; three of them hold four `.topbar` lines, group 4), l10n.spec.js:20-35 (the form's words), shell.spec.js:102-118 (a field's height in a column: onto Details' name and dates) | Go, except shell.spec.js's, which moves to Details |
| The heading | `atConversation` | May tighten to the level-1 name |
| Units | now.test.js, ui-pure.test.js | Done in Step 4 |

#### 2B additions from 2A's review (2026-11-16; `.superpowers` notes: stage8-2a-review.md and the stage8-2a-review-haiku-* files)

2A merged with these left for 2B; Step 8 takes them with the table above:
- **timeline.spec.js:454** ("a card that arrives sticks under the top bar"): `under()` is main's text again, so it fails visibly once the
  bar is gone (it reads `.topbar` with no guard); 2B drops `onBar` and the two expects that read it (:474, :485); the card checks
  (:481-482) and `hitCard` (:484) keep the subject; reword the title and comments.
- **Literal bar heights,** which the recount's greps don't catch: her-instructions.spec.js:81 (`size.height - 56 - 64 - dock`, predicted to
  fail once the ⋯ rises 56 px) and phone-fixes.spec.js:142 (`700 - 56 - 64 - dock`, 56 px too tight after): use `stuckTop`; and
  timeline.spec.js:1149-1150 and :1470 (a literal 60 px "under the top bar").
- **plan.spec.js:309**'s `place()` reads `.topnav.scrollLeft` with no guard; the row-and-Back test (:334-347) calls it at :340 and :345
  and would throw: drop `bar` from `place()` (with :324 and :328).
- **ui-extension.spec.js:54** (`main.getByRole('link', { name: 'Hike' })` count 0) passes vacuously once the bar is gone: assert on home's
  quiet row instead.
- **file-details.spec.js:175-186** ("Back from Now and from the Conversation") depends on `#/now` at :178, :179 and :181: retarget or drop
  as a Now test; the comment at :66 names the bar.
- **The timeline form tests are 13 by name,** not 11: :1026, :1052, :1090, :1110, :1139, :1382, :1478, :1500, :1517, :1528, :1538, :1563,
  :1671.
- **Step 8's recount greps** add what 2A found the plan's greps missed: unscoped `getByRole('link', { name: 'Settings' | 'Trips' | 'Trace' |
  'Itinerary' })` with or without `.first()`; `querySelector('main h1')`; the Japanese form labels `旅の名前` and `旅を始める`; literal
  bar heights (56, 60) in geometry.
- **Titles and comments that name the bar or a tab** (wording; Step 7's sweep covers src and docs, not e2e titles): the builder's Call 7
  titles; no-trip.spec.js:144; details-menu.spec.js:68, :80, :389, :413; hand-over.spec.js:48, :52; phone-fixes.spec.js:139-140, :150,
  :152, :162, :166-170; phone-ui.spec.js:382; her-instructions.spec.js:79; file-details.spec.js:66; phone-fit.spec.js:370; trips.spec.js:642,
  :1059, :1671; timeline's `under` and `boxOf` notes.
- **Keep, or change with them:** home's level-1 "Trips" (goHome, pastWelcome), the Itinerary's level-1 "Itinerary" (openItinerary), and
  `main .talk-head` in the conversation (atConversation); `.notices`.before(…) is the test boxes' anchor (2A used it, not this plan's
  `main.view`.before(…), which would put the box after the real notices box).
- **From dock-box (merged after 2A):** dock-text.spec.js:118 reads `document.querySelector('header, .topbar, nav[aria-label="Main"]')` for the short-screen check: re-derive it with the bar gone.
- Low, optional: shell.spec.js:49-54 now proves the router, not a tap on the bar after the error card (click the card's "Open Trace", then
  goHome); details-menu.spec.js:83, :89 read the bar's bottom once before `expect.poll` (2B's 0 makes it moot).

### How the two tasks meet

1. 2A starts first (before the look if chief agrees, else beside Task 1), and merges into main once reviewed. Task 1 never edits a spec 2A
   edits before Step 8: its new tests are in home-shell.spec.js.
2. Until 2A is on main, Task 1 runs its unit tests, `npm run check`, home-shell.spec.js, and the specs 2A doesn't touch and that name nothing
   that goes (their list: the spec files minus 2A's list minus the 2B table's files), so a regression shows before the merge.
3. Step 8 merges main into `stage8`; the whole suite's failures are the 2B list, plus what Step 8's rerun of the recount finds. Both browsers,
   `--retries=2`.
4. **2A's merge order against other branches.** 2A touches about 48 spec files, so any branch that edits one of them conflicts with it, and
   whichever merges second resolves it. Known now (`git diff --stat main...<branch> -- test/e2e`): booking-say-r4 (9233f9c4, not on main yet)
   edits plan.spec.js (58 lines) and phone-fixes.spec.js (4 lines); model-provider, nearby-lighter and dock-box have no e2e change. As this
   is written round 4 has its commit and 2A has none, so the cheaper order is round 4 first and 2A taking main in before its own review,
   rerunning plan.spec.js and phone-fixes.spec.js in both browsers; in the other order round 4 does the same. The order is chief's call (the main session asks
   when 2A is ready); recheck the list of branches then.

---

## Task 3: Also removable

- **`start_trip` in a dated trip:** the user's question (Q1). Recommended: keep it; nothing to build. If the user picks removal, it is its own
  small change after stage 8, in the order chief sets, not part of stage 8: trip-tools.js:453-475 (the tool), context.js:74's comment, its 31 test references
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
chat; the "Shiori, no trip" row; then "is the timeline right?" (item 8, which also says what stage 8 removes: the top bar, the tabs, Now and
the Start a trip form, after which a trip starts with +).

| Part | Depends on the look? | If the user says otherwise |
|---|---|---|
| Task 2A | No | Nothing: it removes no test and changes no shipped file |
| Step 1 (bar, tabs, swipes) | Yes, the gate itself | "Not right" or "keep the tabs": stage 8 does not start; what they want fixed comes first as its own change, and the gate is asked again |
| Step 2 (the room) | Only the box's cap | If the half is wrong (item 2), the new cap goes in the same CSS line, here |
| Step 3 (gear, Trace, row) | Loosely | If the dock at rest changes (item 3), place the gear with it in mind; Q2 decides top or foot |
| Step 4 (Now) | Yes | "Keep Now": the step drops; Now gets a link in home's row, `#/now` stays a screen, and 2B's Now rows stay as they are |
| Step 5 (the form) | No (the spec decided it; the look's item 8 names it: "Stage 8 removes the top bar, the tabs, Now and the Start a trip form after it: a trip then starts with +", so the user's "is the timeline right?" covers it) | Only if the user asks for it back |
| Steps 6, 7, 8 | No | |
| Task 3 | No (Q1 decides it) | |
| Items 1, 4, 5, 6, 7 | Not stage 8's | A fix is its own change, before or after stage 8 as chief orders |

## Questions for the user (askable now, before the look)

**Q1. `start_trip` in a dated trip: keep it or remove it?** (The spec's :75: "whether it goes is the user's question at stage 8".)
Inside a dated trip, when you hand Shiori a booking for a trip that doesn't exist yet (a flight to Anchorage while you're in Kyoto), she can start
that trip for you: a new card on the timeline, dated from the booking, with the file in it, and you stay in Kyoto. Since stage 4 that is the only
place she can start a trip; in an undated chat she gives the chat itself its dates.
1. **Keep it (Recommended).** Nothing changes. It is the one way a booking for a new trip gets its own card without you handing it over again;
   removing it takes out about 25 lines but none of the Undo code older hand-overs need, and it would cost you a second hand-over each time.
2. **Remove it, as its own change after stage 8** (in the order chief sets). She keeps such a file in the trip you're in, or moves it to a trip
   you already have, and tells you to tap + and hand it over there for a new one. About 25 lines and 31 test references go; a short
   real-model run (about $0.30) checks she says it right.

What waits on it: Task 3 only; stage 8 ships the same either way. It drops none of your words.

The merits, from the code (for the main session; the user's question above stays in plain words): `move_file` (trip-tools.js:516) already moves
a file you handed her into another trip without a tap, so starting a trip beside it is no outlier. Removing `start_trip` saves about 25 lines
(trip-tools.js:453-475) and keeps all the Undo code (handover.js:103, :152, :290, :323, for older logs). It costs the user a second hand-over and
a + for every booking for a trip that doesn't exist yet.

**Q2. Where do the gear (Settings) and Trace sit on home?** (Chief may decide it: the spec says only "in the home screen's body".)
1. **At the top, beside "Trips" (Recommended).** Where apps keep their settings. Home opens at the now line, so on a long timeline it is above
   what you see; the way up is a scroll (whether a tap on the iPhone's status bar scrolls an installed web app to its top was not
   checked).
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

**If it doesn't hold** (the look Wednesday afternoon or later): this plan does not cut the stage. The user's pick "Before the trip" is for stage 8
as a whole, and "Scope is never cut or reordered for the trip" stands, so whether to split it is a question for chief at that point, put by the
main session with the look's date and what is left. For that question, the one seam in the work (for information, not a default): Step 5 (the
form and home's typing parts, with their 14 or so tests) and Task 3 can be built apart from Steps 1 to 4, 6 and 7, and 2B for them. The form
works without the bar, so nothing breaks while it waits; it would save about 1.5 hours. No gate (review, fix round, whole e2e) is dropped
either way.

## The builder's questions, answered from the code

1. **Is any screen a dead end without the bar?** Settings (settings.js:98) and Trace (trace.js:98-99) have no crumb; every other screen has one,
   or a ← (the conversation), or buttons home (the welcome), or "Back to Trips" (the error page, shell.js:436). Step 3 adds the two.
2. **Does `#/now` need the trip in play at a cold start?** live mode's start (src/app/main.js:223) isn't awaited before the shell starts (:251).
   Until `#loadRows` has run (src/core/live/live.js:1206), `#draft` is null, so `#play()` (live.js:729-733) returns `agent.target` (:732), the
   unused draft too when it is the open one. Whether the rows load before the shell's first render is a race. So a cold `#/now` lands on the
   open trip's Itinerary, or on the draft's empty Itinerary ("No itinerary yet…") when the draft is open and the rows aren't in yet, or home
   once they are. **Decided: no guard.** The draft's Itinerary is harmless, and it is what `#/plan` already shows with the draft open; a guard
   (`play === core.chats?.ready ? null : play`, `ready` being the draft's id) would teach the shell a second time what an unused draft is, which
   live.js's `#play()` already answers, for an old bookmark at a cold start. If the final review wants it, it is that one line in shell.js:319.
3. **Where do Now's parts go?** Where you are, the chips and Driving: today's Itinerary (plan.js:54-60, already). Next: home's happening card
   and the conversation's Next line. Latest: Driving and the conversation. The pack line: the Itinerary (Step 4). The four-row timetable and
   "The whole itinerary": the Itinerary itself.
4. **Is there still a field on home?** No: the form was the only one (followClock's `typing`, trips.js:119, looks inside home's screen only).
   `#/talk/me` has no type box. So the typing parts of Step 5 have no case.
5. **Does Settings → Experimental stay?** Yes, with Remote trace on it (an install link for developers, not a switch). Its Unfinished translations
   panel is hidden while no language is experimental (`EXPERIMENTAL` is `[]`, src/core/l10n-list.js:4) and returns with the first one. After
   Step 1 the screen has no switch at all; settings.js:92's line says so (Step 1).
6. **What about `#/talk` and `#/plan` with the draft open?** Unchanged since stage 7: the draft's own address.

## Calls to confirm

For the main session and chief:
1. **2A starts before the look and merges into main when reviewed.** It changes no shipped file and removes no test, so the app and its
   coverage are what they were whatever the look says; it takes about 4 hours off the path after the look. Chief's order said the e2e rewrite's
   design starts now; this goes one step further.
2. **2B is the shell builder's Step 8,** not a third agent: it knows what it removed, and the 2B table is its list.
3. **`startTrip` makes the trip through a second IndexedDB connection,** as `happeningTrip` already does, so the 160 calls don't change; live
   mode, the page's other `ws.onChange` listeners and home's `appended` followers hear of it only at a reload, which no current call needs
   (checked by 2A's run on main).

The plan's own calls:
4. **sees.js keeps its crumb to the conversation** (the sketch said it goes home): it opens from the conversation's ⋯.
5. **Settings and Trace get a fixed "← Trips"**, which the spec doesn't name: without the bar they would have no way out in an installed app.
   Cost: Settings and Trace are also reached from a card inside a conversation (storage-full.js:16's "Export a backup", main.js:438's "Open
   Trace"), and from there the way back is Trips, then the conversation's row, where the Conversation tab was one tap. A crumb back to where
   the screen was entered would add state for a rare path; the usual way in is home's gear. The user can't see this at the look (the tabs
   are still there then); the main session puts it on the user's checks after the release (progress, "Your checks"). The gear and Trace sit in home's top row (Q2's option 1) until chief or the
   user picks the foot.
6. **"Where are you?" stays in Driving,** reached by a "Say where you are" button on the GPS-refused card (one tap to `#/drive`, in place of
   words that describe a path in four languages) and by the Driving link on today's Itinerary of the trip in play. With no trip in play
   (nothing happening, no trip open) Driving says "Open a trip to see the road ahead", and a manual place has nothing to remind about.
7. **Now's offline-pack line moves to the Itinerary**, on every day, so a trip with no pack still says so (the m5c plan: "Now says 'No offline
   pack for this trip yet'"); the first download is a tap, so this nudge matters before a trip. Now's Latest card and its four Next rows go
   with Now; Driving, home's happening card and the conversation's Next line show them.
8. **Home's typing parts go with the form:** the user's pick "Unstick while typing" (2026-11-10) no longer applies, because its case, a text
   field on home, is gone with the form. The spec's note says so, quoting the pick, not "dropped"; if a field ever comes back to home the pick
   applies again. Its code (about 1.5 KB) and its tests go with the form's; the dock stepping aside while typing stays everywhere.
9. **The conversation's name is its h1** (the spec's header: "the name (to Details)"): the h1 wraps the name, which keeps its class and its
   rename code, so about 35 e2e locators stay valid (Step 6).
10. **`#/now` with nothing in play goes home**; a file opened `?from=#/now` crumbs to Details; Driving's ← with nowhere it came from goes home.
11. **`experimental.swipeTabs` is left in stored settings,** read by nothing, as `annai.resume` was.
12. **The limitations entry on the landscape stack box** gets new figures (half the screen, not half the room under the bar); its approval
    stands.
13. **No Itinerary item in the conversation's ⋯:** a trip's Next line and its Details reach it. If the user misses the tab, it is one line. The
    user can't judge it at the look (the Itinerary tab is still there then), so the main session puts it on their checks after the release:
    during a trip, with nothing upcoming, the way in is the name, then Details, then Itinerary.
14. **Size:** about -15 KiB in all (the sketch said -25 KiB, against older code).
15. **Q1's removal, if picked, is its own change after stage 8,** in the order chief sets; Task 3 builds nothing if the user keeps `start_trip`.
16. **Changed APIs** (lessons entries): `#/now`; `redirectOf`'s options; `tab: true`'s place; a plugin screen's crumb; `ui.go('#/now')`;
    `no-swipe`; `now-card` and `now-section` on the Itinerary only; `experimental.swipeTabs`.
17. **No paper strip for the status bar's inset (Step 2),** and the top padding on `body`: the inset is expected to be 0 under `default`; if
    the phone at release shows it isn't, the strip is a fix before release. Not measured here (Playwright has no inset).
18. **A cold `#/now` has no guard against the draft** (builder question 2): it may land on the draft's empty Itinerary, as `#/plan` does.
19. **Shiori's list of screen names loses `Now`** (`TOLD`, Step 7), which changes the line she is told in ja, zh-Hans and zh-Hant, and so those
    users' cached prompt once.
20. **Settings' Experimental line** (settings.js:92) is reworded, because the swipe switch was its only switch and `EXPERIMENTAL` is `[]`.
