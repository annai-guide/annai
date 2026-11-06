# Timeline stage 2, Trip in play: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live mode follows the trip in play instead of the open conversation, so a quick chat during a trip neither silences "leave soon" nor takes its GPS points.

**Architecture:** `phaseOf` lives once in new `src/core/timeline.js`. Each trip's `start`, `end` and last-talked time are mirrored on its scope record, so live mode can choose in memory. `#trip` in `live.js` becomes the trip in play; the open conversation keeps its meaning everywhere else. This must land before stage 4.

**Tech Stack:** Native ES modules, no build step, JSDoc checked by `tsc`, `node:test`, Playwright e2e in Docker.

**Spec:** `docs/superpowers/specs/2026-11-04-timeline-home-design.md`: sections GPS voice and watches, The model (Scale), Decided by the user ("Only the one in play"). Read it first.

## Global Constraints

- Work in `/mnt/optane/work/annai-timeline`, branch `timeline`. No push, no merge. Never `git stash`. Stage files by name. Delete with `/bin/rm -f`, move with `command mv -f`.
- Never read `/var/lib/private/annai-trace/`, `/root/annai-test-keys/` or any secret file. The repo is public: fixtures use the test names in `test/unit/live-kit.js`.
- **The drive logic doesn't change.** `#inPlay` keeps its simulation meaning. `src/core/live/activity.js` isn't touched. Every existing `test/unit/live-*.test.js` passes with no edit to an assertion; an edit you can't avoid goes in Calls to confirm with why.
- `annai.drive` is device-level, unaffected.
- Any released copy's records must still read. An old page reading a new scope record must not break.
- A stored format change gets its lessons entry in the same commit: full entry in `docs/lessons-full.md`, one line in `docs/lessons.md` (kept under 20 KB).
- New user-facing words get `draft` rows (`npm run strings`, fill, `npm run strings`, `npm run strings -- --check`). After a change to a shipped file: `npm run stamp`.
- Size: never print `scripts/size.mjs` line 4. **This stage expects +4 KiB.** Raise `BUDGET` in whole KiB by what the build needs, with the reason appended.
- The handoff ends with Calls to confirm.

**Commands:** as in the stage 1 plan (unit, all, e2e).

**Where the code moved past the spec**
- The mirror is "from day one" in the spec, but this stage needs it, so it lands here and not in stage 4. Records written by released copies have no keys, so it needs a backfill.
- `record()`'s transaction has no `scopes` store. Writing last-talked there means adding it, for user lines only.
- `#changed` has no `/trip.json` branch.
- The spec counts about ten plan readers. Beyond those it names, `#prune`, `#lastSeen`, `#moment().fired` and `listWatches` read `#scope()` too. The table in Task 3 is the whole list.
- `#schedule` can reach `Infinity` with GPS off, and `time.js` has no next-midnight helper (`budgets.js` has a private one for the day before).
- `drive.js` reads `agent.trip`, which from a quick chat is the wrong trip, so `live.play` is public.

**This plan's calls**
- `phaseOf` compares dates only, in the device's zone; live passes its own clock and zone, so a simulation sees its own day. A start with no end is happening on its start day only.
- Field names on the scope record: `start`, `end` (absent when undated) and `talked` (ms, or `null` when nobody has spoken). An absent `talked` key means "not mirrored yet".
- During a simulation, play is `#sim.trip`.
- Ties in "last talked in": the later start, then the id, so the choice is stable.
- `#lastSeen`'s `since` becomes the newer of the open conversation's and the play's last entry: the older alone would make a quick chat's catch-up claim a longer gap. Its `from` is the play's last point, where points now go.

## Review Focus

Routes the tests must hold: every existing `live-play-clock`, `live-one-path`, `live-drive2*`, `live-drive-record`, `live-sim-isolation`, `live-catch-up`, `live-push`, `live-engine`, `live-plan-watches` and `live-fired-backup` test (one trip open and happening, so play equals open), plus the new routes in Task 3.

1. **A quick chat opened mid-drive:** nothing about the drive changes. No false stop, no reset of `#kept` or `stop`, points stay in the trip. Test `open changes, play doesn't`.
2. **A trip that starts at midnight with GPS off and no watches:** its reminders still come. Test `midnight alarm`.
3. **A released copy's record, or an imported archive from one:** no keys, so the backfill fills it once and the trip is in play the same day. Tests in Task 2.
4. **A `/trip.json` a released copy or a plugin wrote with a bad date:** the mirror copies only `YYYY-MM-DD` strings, and an unreadable file leaves the row undated. Test in Task 2.
5. **The trip in play removed or archived while it is in play:** nothing more goes into it and play falls through. Test `play removed`.

---

### Task 1: phaseOf and the next day

**Files:**
- Create: `src/core/timeline.js`
- Modify: `src/core/time.js`
- Test: `test/unit/timeline.test.js`, `test/unit/time.test.js` (or the file that holds `dayIn`'s tests)

**Interfaces:**
- Produces: `phaseOf(trip: { start?: string, end?: string } | null, now: number, zone = deviceZone()) -> 'undated' | 'past' | 'happening' | 'future'`; `nextDay(at: number, tz: string) -> number`, the first instant of the day after `at` in `tz`.

- [ ] **Step 1: Write the failing tests**

```js
const noon = Date.parse('2026-11-27T12:00:00-08:00'), LA = 'America/Los_Angeles';
test('phaseOf by dates in the zone', () => {
  assert.equal(phaseOf({}, noon, LA), 'undated');
  assert.equal(phaseOf(null, noon, LA), 'undated');
  assert.equal(phaseOf({ end: '2026-11-27' }, noon, LA), 'undated');
  assert.equal(phaseOf({ start: '2026-11-28' }, noon, LA), 'future');
  assert.equal(phaseOf({ start: '2026-11-26', end: '2026-11-27' }, noon, LA), 'happening');
  assert.equal(phaseOf({ start: '2026-11-25', end: '2026-11-26' }, noon, LA), 'past');
  assert.equal(phaseOf({ start: '2026-11-27' }, noon, LA), 'happening');
  assert.equal(phaseOf({ start: '2026-11-26' }, noon, LA), 'past');
});
test('the last evening of a trip is still the trip, by the zone given', () => {
  assert.equal(phaseOf({ start: '2026-11-26', end: '2026-11-27' }, Date.parse('2026-11-28T07:00:00Z'), LA), 'happening');
  assert.equal(phaseOf({ start: '2026-11-26', end: '2026-11-27' }, Date.parse('2026-11-28T07:00:00Z'), 'Asia/Tokyo'), 'past');
});
test('nextDay is the next midnight, through a day with no midnight', () => {
  assert.equal(nextDay(noon, LA), Date.parse('2026-11-28T00:00:00-08:00'));
  const t = nextDay(Date.parse('2026-03-07T12:00:00-05:00'), 'America/Havana');
  assert.ok(t > Date.parse('2026-03-07T12:00:00-05:00'));
  assert.equal(dayIn(t, 'America/Havana'), '2026-03-08');
});
```

- [ ] **Step 2: Run them.** Expected: FAIL, modules or exports missing.

- [ ] **Step 3: Implement** both, with `dayIn`, `wallClock` and `instantOf`. No new date library.

- [ ] **Step 4: Run them.** Expected: PASS. Commit: `git commit -m "Timeline: phaseOf, and the next day's start"`.

### Task 2: The mirror on the scope record

**Files:**
- Modify: `src/core/scopes.js` (`createTrip`, `syncTripTitles`, new `backfillTrips`), `src/core/agent/log.js` (`record`), `src/core/archive.js` (end of `importArchive`), `src/app/main.js`, `src/types.js:15`, `docs/lessons-full.md`, `docs/lessons.md`
- Test: `test/unit/trip-mirror.test.js`, `test/unit/scopes.test.js`, `test/unit/archive.test.js`

**Interfaces:**
- Produces: scope record `{ …, start?: string, end?: string, talked?: number | null }`; `tripMirror(trip: unknown) -> { start?: string, end?: string }`; `backfillTrips(ws) -> Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```js
test('a new trip carries its dates and talked: null', async () => {
  const id = await createTrip(ws, { title: 'Testville', start: '2026-11-20', end: '2026-11-22' });
  const r = await scope(id);
  assert.deepEqual([r.start, r.end, r.talked], ['2026-11-20', '2026-11-22', null]);
});
test("a patch, a restore and a clear of trip.json all reach the record, with no title too", async () => {
  // patch start and end; ws.restore the first version; merge-patch { start: null, end: null }
});
test('a date that is no date is not copied', () => {
  assert.deepEqual(tripMirror({ start: 'soon', end: 7 }), {});
});
test('the first user line and a heard line stamp talked; dismissed lines, wakes and her words do not', async () => {
  await record(store, id, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: 100 });
  assert.equal((await scope(id)).talked, 100);
  await record(store, id, { type: 'heard', actor: 'user', data: { id: 'h1', dismissed: true }, now: 200 });
  await record(store, id, { type: 'model.turn', actor: 'shiori', data: {}, now: 300 });
  assert.equal((await scope(id)).talked, 100);
  await record(store, id, { type: 'heard', actor: 'user', data: { id: 'h2', text: 'hi' }, now: 400 });
  assert.equal((await scope(id)).talked, 400);
});
test("a line in me or a sys scope writes no talked", async () => { /* record into ME: the record is unchanged */ });
test('a record from a released copy is filled once, archived ones too, and a second run writes nothing', async () => {
  // delete start, end, talked by putScope; backfillTrips; the mirror matches trip.json and the last user line
  // past a page of dismissed heard lines; count putScope in a second run: 0
});
test('an archive from a released copy lands mirrored', async () => { /* import a manifest with no keys */ });
```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement**

- `tripMirror` copies `start` and `end` only when they match `^\d{4}-\d{2}-\d{2}$`.
- `createTrip` puts them and `talked: null` on the record.
- `syncTripTitles` keeps its name and its hook. Build the new record from `{ ...rec }` with `start` and `end` deleted, then `tripMirror`, and `title` when it isn't blank; the `!title` return must no longer skip the dates. Write only on a difference.
- `record()`: `const talks = type === 'msg.user' || (type === 'heard' && !data?.dismissed)`. Add `'scopes'` to the transaction only then, and in it `if (rec?.kind === 'trip') t.putScope({ ...rec, talked: now })`. Every `msg.user` and `heard` goes through `record` (`loop.js`'s `#log`; check `koe/live.js`'s log and say so in the test).
- `backfillTrips(ws)`: for each trip record with no `talked` key, read `/trip.json`, read the log back in pages for the last non-dismissed user line, write once. `main.js` awaits it before `live.start()`; `importArchive` calls it at its end.
- `grep -n "putScope(" src` first: a call that rebuilds a record by hand would drop the keys, and released copies' spreads keep them. `archive.js`'s record schema has no `additionalProperties: false`, so an old page opens a new archive (checked 2026-11-06).

- [ ] **Step 4: Lessons, in this commit**

`## 2026-11-06 Trip dates and last talked on the scope record`: Changed, Why we had to change (live mode and the timeline can't read 500 trip.json files at each change), Original design was wrong because (a scope record named only what the list screen needed, so anything asking "which trips matter now" had to open every trip), Lesson. One line in `docs/lessons.md`.

- [ ] **Step 5: Run and commit.** Run: the three test files. Expected: PASS. `git commit -m "Trips: dates and last talked mirrored on the scope record, backfilled once"`.

### Task 3: live.js follows the trip in play

**Files:**
- Modify: `src/core/live/live.js`
- Test: `test/unit/live-play.test.js`, `test/unit/live-kit.js` (add `chat(title, { start?, end? })`: a second scope for a test to open)

**Interfaces:**
- Consumes: `phaseOf`, `nextDay`, the mirror.
- Produces: `get play(): string | null`, public, synchronous, always current. `#play()` private: `#sim?.trip`; else the open conversation if happening; else the happening trip last talked in, out of `#still`; else the open conversation.

**The list.** `#scope()` still means the open conversation. `#trip` now means the trip in play.

| Place | Today | Becomes |
|---|---|---|
| `#follow` | `agent.target`, `#loadAll` on a change | `#play()`; `#loadAll` dropped; `#kept`, `stop`, `#loadPlan` as they are |
| `#rows` (new) | none | `Map<id, { start, end, talked }>` of active trips, by `#loadRows()`, one `listTrips`, called in `#loadAll` and in the `agent.on('open')` handler before `#check` |
| `#changed` | no `/trip.json` branch | reads that file for `c.scope`, updates its row with `tripMirror` (the hook writing the record may not have finished), then `#loadPlan` if it is `#trip`, `#check`, `#tellReminders('prompt')` |
| `forget` | watches only | drops the row too; `#follow` then moves on |
| `listWatches` | `scope === #scope()` | `scope === (#trip ?? ME)` for the plan's rows |
| `reminders` | `open` | play, for the plan's rows and `held` |
| `#prune` | `#scope()` | play |
| `#moment().fired` | `#scope()` | play |
| `#lastSeen` | `#scope()` | as this plan's calls say |
| `#looked` | `scope === open` | `scope === open \|\| scope === play`, or time |
| `#check`, `#look` | `open` for `#plan` | play for `#plan`; `open` for the rest |
| `#schedule` | `open` for `#plan` | play for `#plan`, and `consider(nextDay(m.now, this.timeZone()))` |
| `#onFix` point write | `#trip` | as it is: `#trip` is now play |

`#fire`, `#deliver`, `#deliverOpened`, `setLive`'s log, the held wake and `#elsewhere` stay on the open conversation: that is how a reminder for another scope is already said and its wake written there.

- [ ] **Step 1: Write the failing tests, on `liveKit`, in `live-play.test.js`**

```js
test("quick chat during the trip: open changes, play doesn't", async () => {
  // plan: an item with a place, a leave-soon due at 10:00; moving-fast fixes under way
  const chat = await k.chat('Ramen');
  k.agent.opened(chat); await k.settle();
  assert.equal(k.live.play, k.trip);
  // more fixes: location entries land in k.trip, none in chat; live.stop unchanged, no stop told
  // 10:00: k.agent.reminders has it with scope k.trip, its wake has scope k.trip, nothing is written to chat
});
test("a quick chat's own GPS and time watches still fire there", async () => {});
test('another open trip that is not happening: play stays', async () => {});
test('two happening: the open one; opened elsewhere, the one last talked in, whose plan reminds alone; time watches fire for both', async () => {});
test('nothing open, nothing happening: no point is kept, a time watch fires', async () => {});
test('nothing open, a trip happening: it is in play', async () => {});
test('midnight alarm: GPS off, no watches, a trip starting tomorrow: its first reminder comes with nothing else happening', async () => {});
test('dates patched into the open chat make it the trip in play, with no reopening; cleared, play goes back', async () => {});
test('play removed: forget, and nothing more is written there', async () => {});
test('play archived: tripsChanged moves play on; unarchived, it returns', async () => {});
test("a simulation: play is its trip, and the user's happening trip stays quiet; afterwards it is back", async () => {});
test("a simulation's trip outside its run is never chosen", async () => {});
test('a restart with a quick chat open: the catch-up reads the trip in play, late reminders once', async () => {});
test('a watch written in a conversation that is not open, with #loadAll gone from #follow, is looked at', async () => {});
test('the plan and the mirrored reminders follow play: reminders() lists its leave-soon, held names the other', async () => {});
```

- [ ] **Step 2: Run them.** Expected: FAIL, `live.play` is undefined.

- [ ] **Step 3: Implement the table.** Keep `#still` as it is; `#rows` is filtered by it inside `#play()`.

- [ ] **Step 4: Run every live test.** Run: `live-play.test.js`, then all `test/unit/live-*.test.js`. Expected: PASS, no assertion edited.

- [ ] **Step 5: Commit.** `git commit -m "Live mode follows the trip in play: plan, points and GPS watches"`.

### Task 4: Driving and the limitation

**Files:**
- Modify: `src/ui/screens/drive.js`, `src/ui/shell.js` (the `trip` given to `takeover`), `src/ui/today.js` if needed, `docs/limitations.md`
- Test: `test/e2e/drive.spec.js`

- [ ] **Step 1: Write the failing e2e test**

With a happening trip in play and a second, undated trip open: moving fast takes over and Driving shows the happening trip's road. A quick ask opens that trip first, then the question is in its log. With a live session running (the fake realtime server), a quick ask goes to the open conversation and the session stays open.

- [ ] **Step 2: Implement**

`renderDrive`: `const id = ctx.live?.play ?? ctx.agent?.trip`. A quick ask: `if (id !== ctx.agent.target && ctx.agent.koeState !== 'live') { await updateAppSettings(ctx.ws, { activeTrip: id }); await ctx.agent.open(id); }`, then `send`, since `Halves.open` closes a live session. The shell passes `trip: core.live?.play ?? core.agent?.trip ?? null`. In `plan.js`, Driving shows when `id === (ctx.live?.play ?? ctx.agent?.trip)`.

- [ ] **Step 3: Write the approved limitation**

`docs/limitations.md`, `### Only the trip in play reminds`: kind known limitation. What the operator sees: with two trips happening at once, the other's itinerary reminders wait until it's opened; time watches fire for both. Why: one plan is followed at a time. Revisit when someone misses one. Approved 2026-11-05: "Only the one in play (Recommended)". One line in the README's limits if it has such a list.

- [ ] **Step 4: Run all, then e2e whole.** Raise the budget. Expected: PASS. `git commit -m "Driving shows the trip in play; a quick ask opens it first, not over a live session"`.
