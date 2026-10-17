# Milestone 5a: Live Core (Watches, Triggers, Catch-up, Reminders, a Simulated Big Sur Drive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shiori wakes when time passes or the user moves, and reminders work without her:
- **Watches** (spec §4.4, §7.2 Time, §11.3): Shiori sets them with `watch_set`, lists them with `watch_list`, cancels them with `watch_cancel`. Types: `time`, `every`, `enter`, `leave`, `dwell`, `arrived`, `moved`, `activity`; plugins add types. Each has a fallback message.
- **The plan's own watches** (§11.3): leave in X minutes, arrived, running late, coming up; and off plan (§11.5), all worked out from the plan, with fallbacks filled in from the plan data.
- **The live engine** (§11.1, §11.2, §4.5): GPS fixes in, the activity (still, walking, moving fast) with hysteresis, kept location points, one clock timer for the next due watch, simultaneous firings merged into one wake (§6.1).
- **Catch-up** (§11.4): coming back on screen (or starting again), time watches that came due fire late, labelled "late by N min"; entering and leaving places is inferred; everything goes into one catch-up wake with the elapsed time and distance.
- **Reminders without a model** (§11.3, §17 rule 2): when the model can't be reached, or there is no connection, the fallback is shown and, with voice on, said; wakes queue up until the connection is back.
- **The now block** gets the place and the activity (§6.3); voice Auto hears "moving fast" (§10.5).
- **The driving-companion and replanning skills** (§11.5).
- **Trip simulation** (§13, §18): a GPS track and a fake clock through the same machinery. **Done when** (§20 row 5, first half): a simulated Big Sur drive (Monterey → Big Sur → Cambria on Highway 1) produces the expected wakes, and Shiori does what she should, in a unit test.

**Architecture:**
- **Pure core modules** in `src/core/live/`, unit-tested in Node:
  - `geo.js`: distances, fixes, which points are kept (§4.5), the rough travel estimate (§11.3).
  - `activity.js`: still / walking / moving fast with hysteresis (§11.2).
  - `triggers.js`: the built-in trigger types.
  - `watches.js`: watch records, `/watches/<id>.json`.
  - `plan-watches.js`: the plan's own watches, and the `plan` trigger type.
  - `skills.js`: the driving-companion and replanning skills.
  - `clock.js`: the real clock, a manual clock for tests, a clock 10× faster for simulations.
  - `simulate.js`: a track from an itinerary, and a simulation that plays it through sensors of its own.
- **`live.js`**, the engine. It reads sensors from the registry (kind `sensor`: `location`, `visibility`, `connectivity`), so the browser's sensors (milestone 5b) and a simulation are interchangeable. It registers the `activity` item voice Auto reads, and the two skills.
- **`watch-tools.js`**: the Time tools, loop tools like the Self tools.
- **The Agent** gains wakes of kind `trigger`, `catch-up` and `live` with fallbacks, `remind()`, and `sense` for the now block.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26).

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`. Milestone 5 is §20 row 5. This plan covers:
- §11.1 live mode (the switch and what runs while it is on; the screens are 5b)
- §11.2 sensors: the clock, location (thinned as §4.5), activity; visibility and connectivity as inputs
- §11.3 triggers and watches, fallbacks, the plan's own watches, the travel estimate
- §11.4 catch-up
- §11.5 off-plan detection, replanning (a skill; every replan is patches), narration (the driving-companion skill)
- §6.1 wakes (merging, the catch-up source), §6.3 the now block (place, activity), §6.6 budgets for trigger wakes
- §7.2 Time tools
- §13 and §18 trip simulation (the machinery; milestone 7 adds its screen)
- §17 rule 2: reminders with their fallbacks when a connection or every model is missing

**Not in this plan (milestone 5b and 5c):**
- **5b, on the phone:** the browser's sensors (`watchPosition`, visibility, connectivity, the wake lock), the live switch and the manual place on screen, the Now and Driving screens, sunrise and golden hour, the trace's Live view, end-to-end tests with Playwright's geolocation override, the device checklist.
- **5c, the offline pack** (§11.5): Wikivoyage, Wikipedia and OpenStreetMap data along the route; the Places tools read it first.
- **Push** (§11.6) is milestone 6; the watches here are shaped so time watches can be mirrored there.

## Choices this plan makes (please check them)

1. **The Time tools are named `watch_set`, `watch_list` and `watch_cancel`.** Providers accept only letters, digits, `_` and `-` in tool names (annai's `TOOL_NAME` rule), so §7.2's `watch.set` can't be sent as it is. *Cost if wrong:* a rename.
2. **Time and every watches, and the plan's leave and coming-up reminders, run whenever annai is on screen; location, distance and activity watches need live mode.** §11.1 says triggers are evaluated while live mode is on; a "remind me at six" that silently waits for live mode would surprise. *Cost if wrong:* clock reminders the user didn't ask live mode for (still only while annai is on screen).
3. **A time watch of a conversation that isn't open** (another trip, or no trip) still reminds: its fallback is shown and said at once, and the wake is written into that conversation for when it opens (as files added to another trip are, milestone 4). Other kinds of watch wait for their conversation.
4. **Watches are files**, `/watches/<id>.json` in the conversation's own scope (a trip, or `me`): §4.4's record, visible in Files and to Shiori's file tools, removed with the trip (§4.9).
5. **The plan's own watches are worked out from the plan, not stored**; the log's `trigger.fired` entries say which have fired. Which items get which:
   - fixed with a place: **leave** (15 minutes before the estimated departure), **running late**, **arrived**;
   - fixed with no coordinates: **coming up**, 15 minutes before;
   - flexible with a place: **arrived**, and **off plan** when, 10 minutes into its time, the user is more than 3 km away and hasn't been there;
   - a trip with places: **off plan** when the user has stopped for 20 minutes more than 500 m from every plan place (not where live mode first found them, and not twice at one spot).
   *Cost if wrong:* too many or too few wakes; each threshold is one constant.
6. **The travel estimate** (§11.3): straight line × 1.4 ÷ 50 km/h by car; × 1.3 ÷ 4.5 km/h on foot, for 2 km or less when not moving fast. It starts from where the user is (live mode), else from the previous plan stop. A reminder whose departure keeps moving later as the user drives toward the place never fires: they have left.
7. **The activity:** still below 0.5 m/s, walking below 3 m/s, moving fast from 5 m/s (18 km/h); between 3 and 5 m/s nothing changes. A new activity must hold 30 seconds; leaving moving fast must hold 60 (traffic lights). The speed is the GPS's own when it gives one, else over the last 15 to 60 seconds of positions, less what their accuracy could explain.
8. **With no connection,** annai shows and says each reminder at once; Shiori hears of them all in one wake when the connection is back (§17: "wakes queue up").
9. **Reminders also when a budget drops a trigger wake** (wakes per hour), **when quiet hours hold it**, **and when every model fails or none is set** (§17 rule 2). *Cost if wrong:* a reminder card (and voice) during quiet hours.
10. **Turning live mode on wakes Shiori once,** so the driving-companion skill can set its watches. It is the user's tap, so budgets don't hold it.
11. **Live mode stays on across restarts** until it is turned off.
12. **A catch-up wake happens only when something fired or was inferred** during the gap; coming back after a minute with nothing due wakes no one.
13. **`moved` counts the kept points (§4.5) since her last wake of any kind,** so GPS jitter under the accuracy adds nothing.
14. **The now block names the nearest plan place within 2 km,** with the coordinates and accuracy; nothing is sent anywhere to name a place (§11.7). Shiori can call `reverse` herself.
15. **Off screen nothing is evaluated** (no GPS, no timer) on every phone, Android included: §11.1's "while it's on and annai is on screen"; catch-up covers the gap.
16. **Each kept location point is written at once** (about one a second at highway speed), for replay (milestone 7); no batching to lose at a lock.
17. **The driving and replanning instructions are built-in skills** (`driving-companion`, `replanning`), like milestone 4's `plan-a-trip`.
18. **Reminders go into Shiori's transcript** ("shown by annai itself, since you couldn't be reached: …") so she doesn't repeat them; location points and `trigger.fired` entries don't (the wake says what fired).
19. **The size budget** goes from 880 KiB to 960 KiB in Task 1. You said to raise it as needed and list each raise; this is that list's entry.

## Global Constraints

- All of milestone 2b's, 3's and 4's Global Constraints hold (`docs/superpowers/plans/2026-10-16-m2b-shiori.md`, `2026-10-16-m3a-voice-parts.md`, `2026-10-16-m4-planning.md`). In particular:
  - Model output never goes into `innerHTML`; no `style` attribute is set.
  - Every write is one transaction; everything stored is named by a file or a log entry (§4.9).
  - Every file under `src/` and `assets/` is listed in `sw.js` `SHELL` (a unit test checks this). Run `npm run stamp` after any shipped file changes, and `npm run catalog` after changing `plugins-official/`.
  - Keys never appear in context, files, events or the trace.
- **"While it's on and annai is on screen: GPS tracking runs. Triggers are evaluated" (§11.1).** **"When the phone locks, the app freezes, and catch-up (§11.4) covers the gap."**
- **"Location points are thinned. A point is kept only after moving about 20 m (or the GPS accuracy, if worse), or after 1 minute while moving" (§4.5).**
- **"Activity | still / walking / moving fast, from GPS speed, with 30–60 s hysteresis" (§11.2).**
- **"Clock | One timer, set for the next due watch. Re-checked whenever the app becomes visible" (§11.2).**
- **"Every watch has a fallback message. When the watch fires and the model can't be reached, the fallback is shown or spoken directly" (§11.3).**
- **"The travel-time estimate is deliberately rough (straight-line distance × a detour factor ÷ a typical speed for the mode of travel), so reminders err early. The fallbacks are filled in from the plan data, for example 'Flight UA123 departs 14:05, SFO T3'" (§11.3).**
- **"Simultaneous triggers merge into one wake" (§6.1).**
- **"Location triggers never leave the phone" (§11.6); "Location otherwise goes only to the user's own model provider" (§11.7).** Nothing in this plan sends a position anywhere but the model, through the now block and tool results.
- **"Every replan is a set of patches to the plan files, so it can be undone" (§11.5).**
- **"Narration is a built-in skill, not code" (§11.5).**
- **"Trip simulation: a GPS track plus a fake clock at 10× speed, with assertions on which triggers fired and what Shiori did" (§18).**
- **Budgets (§6.6):** trigger wakes go through the existing per-hour limit and quiet hours.
- **Copy:** plain words; every error says what happened and what to do next; system cards and reminders are never in Shiori's voice (§16.1).
- **Size:** Task 1 raises the shipped JS + CSS budget from 880 KiB to 960 KiB, on purpose (choice 19).
- **Work in the worktree** `.claude/worktrees/m5-live`, branch `m5-live`. Before every commit, `npm run stamp && npm run check` must pass, chained with `&&`.

## Review Focus

1. **GPS jitter** at a stop and at a circle's edge (accuracy 20–65 m, points wandering 30 m): no enter or leave fires twice, no phantom kilometres for `moved`, no "moving fast", no second off-plan wake for one stop. Pinned in Tasks 1, 2 and 4.
2. **The plan changing while live:** an item moved by a replan, deleted, or with a broken file: the plan's watches follow; nothing fires for a deleted item; nothing stops. Pinned in Task 4.
3. **A long gap:** locked overnight, or annai closed for days with live mode on: each overdue watch fires once, labelled late; an `every` watch fires once, not twenty times; nothing fires for plan items long past. Pinned in Task 5.
4. **A broken watch:** one Shiori wrote by hand (unknown type, missing fields, a time that has passed, a bad `expires`) or a plugin's trigger that throws: skipped or refused with plain words, never stopping the others. Pinned in Tasks 2 and 4.
5. **A trip removed or switched while live:** nothing is written into a removed trip; the new trip's plan and watches take over, and its points go to its own log. Pinned in Tasks 4 and 5.
6. **Thousands of location points** in a trip's log don't reach Shiori's context and don't slow her conversation or housekeeping. Pinned in Task 6.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/live/geo.js` | 1 | `meters`, `fixOf`, `keep`, `travelMinutes`, `modeFor`, `kmText`, `span` |
| `src/core/live/activity.js` | 1 | `ActivityTracker` |
| `scripts/size.mjs` | 1 | the budget |
| `src/core/live/triggers.js` | 2 | the built-in trigger types, `TRIGGERS` |
| `src/core/live/watches.js` | 2 | `WATCH_SCHEMA`, `readWatches`, `saveWatch`, `removeWatch`, `expired`, `newWatchId` |
| `src/plugins/core-schemas/schemas.js` | 2 | `/watches/*.json` in trips and `me` |
| `src/core/live/plan-watches.js` | 3 | `planWatches`, `PLAN` |
| `src/core/live/clock.js` | 4 | `realClock`, `ManualClock`, `scaledClock` |
| `src/core/live/skills.js` | 4 | `DRIVING`, `REPLANNING` |
| `src/core/live/live.js` | 4, 5 | `Live`: sensors, fixes, watches, firing, catch-up, offline, the now block's place and activity |
| `test/unit/live-kit.js` | 4 | a memory annai with a Live engine, a manual clock, sensors and a fake agent |
| `src/core/agent/loop.js`, `src/core/agent/transcript.js`, `src/core/voice/voice.js` | 6 | wakes with fallbacks, `remind`, `sense`; reminders in the transcript, location points left out; voice follows an activity sensor that comes late |
| `src/core/live/watch-tools.js` | 6 | `watchTools(live)`: `watch_set`, `watch_list`, `watch_cancel` |
| `src/app/main.js`, `src/ui/screens/tools.js` | 6 | the engine in the app; the Time and Go groups |
| `src/core/live/simulate.js` | 7 | `trackFrom`, `Simulation` |
| `plugins-official/scripted-model/index.js` | 7 | `rules`: replies chosen by what woke her |
| `test/fixtures/live/big-sur.json`, `test/unit/live-big-sur.test.js` | 7 | the drive, and its expected wakes |

---
### Task 1: Where the user is: distances, kept points, travel time, and the activity

**Files:**
- Create: `src/core/live/geo.js`, `src/core/live/activity.js`
- Modify: `scripts/size.mjs` (the budget), `sw.js` (`SHELL`)
- Test: `test/unit/live-geo.test.js`, and `test/unit/live-kit.js` (places and a helper the live tests share; Task 4 adds to it)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `geo.js`: `Fix = { lat, lng, accuracy, at, speed: number | null, heading: number | null, source: 'gps' | 'manual' | 'sim' }`; `meters(a, b): number`; `fixOf(raw, now): Fix | null`; `KEEP_M = 20`, `KEEP_MS = 60_000`; `keep(last: Fix | null, fix: Fix, moving: boolean): boolean`; `TRAVEL`; `travelMinutes(km, mode: 'drive' | 'walk'): number`; `modeFor(km, activity): 'drive' | 'walk'`; `kmText(m): string` ("850 m", "12.3 km"); `span(ms): string` ("42 min", "2 h 5 min").
  - `activity.js`: `Activity = 'still' | 'walking' | 'moving-fast' | 'unknown'`; `STILL_BELOW`, `WALK_BELOW`, `FAST_FROM`, `SETTLE_MS`, `LEAVE_FAST_MS`; `class ActivityTracker { activity; speed; feed(fix): { from, to, at } | null; reset() }`.

- [ ] **Step 1: Write the failing test**

`test/unit/live-kit.js`:

```js
/** Places on the Big Sur drive, and a point some meters away from one. Tests of live mode share these. */
export const MONTEREY = { lat: 36.6036, lng: -121.8916 };
export const BIXBY = { lat: 36.3715, lng: -121.9017 };
export const RIVER_INN = { lat: 36.27, lng: -121.807 };
export const NEPENTHE = { lat: 36.2213, lng: -121.7567 };
export const MCWAY = { lat: 36.158, lng: -121.672 };
export const HEARST = { lat: 35.6852, lng: -121.166 };
export const CAMBRIA = { lat: 35.5641, lng: -121.0807 };
/** Meters in a degree of latitude, as meters() counts them. */
const DEG = (6_371_000 * Math.PI) / 180;
/** A point dx meters east and dy meters north of p. @param {{ lat: number, lng: number }} p @param {number} dx @param {number} dy */
export const off = (p, dx, dy) => ({ lat: p.lat + dy / DEG, lng: p.lng + dx / (DEG * Math.cos((p.lat * Math.PI) / 180)) });
export const LA = 'America/Los_Angeles';
/** A moment on the day of the drive, Pacific time. @param {string} hhmm "09:30" or "09:30:15" */
export const at = (hhmm, day = '2026-11-27') => Date.parse(`${day}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}-08:00`);
```

`test/unit/live-geo.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meters, fixOf, keep, travelMinutes, modeFor, kmText, span, KEEP_MS } from '../../src/core/live/geo.js';
import { ActivityTracker } from '../../src/core/live/activity.js';

import { off, BIXBY, NEPENTHE } from './live-kit.js';

const T0 = Date.parse('2026-11-27T09:00:00-08:00');
/** @param {{ lat: number, lng: number }} p @param {number} s seconds after T0 @param {Partial<import('../../src/core/live/geo.js').Fix>} [o] */
const at = (p, s, o = {}) => /** @type {import('../../src/core/live/geo.js').Fix} */ ({ ...p, accuracy: 8, at: T0 + s * 1000, speed: null, heading: null, source: 'gps', ...o });

test('meters between two points', () => {
  assert.equal(meters(BIXBY, BIXBY), 0);
  assert.equal(Math.round(meters(BIXBY, NEPENTHE) / 10), 2116);
  assert.ok(Math.abs(meters(BIXBY, off(BIXBY, 0, 100)) - 100) < 0.5);
  assert.ok(Math.abs(meters(BIXBY, off(BIXBY, 100, 0)) - 100) < 0.5);
});

test("a sensor's position becomes a fix; anything else is nothing", () => {
  assert.deepEqual(fixOf({ lat: 36.37, lng: -121.9, accuracy: 12, speed: 14.2, heading: 170 }, T0), { lat: 36.37, lng: -121.9, accuracy: 12, at: T0, speed: 14.2, heading: 170, source: 'gps' });
  assert.deepEqual(fixOf({ lat: 36.37, lng: -121.9, at: T0 - 5000, source: 'manual' }, T0), { lat: 36.37, lng: -121.9, accuracy: 50, at: T0 - 5000, speed: null, heading: null, source: 'manual' });
  assert.equal(fixOf({ lat: 36.37, lng: -121.9, speed: NaN }, T0)?.speed, null);
  assert.equal(fixOf({ lat: 36.37, lng: -121.9, speed: -1 }, T0)?.speed, null);
  for (const bad of [null, {}, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: '36', lng: -121 }, { lat: NaN, lng: 0 }]) assert.equal(fixOf(bad, T0), null);
});

test('kept points (spec §4.5): after about 20 m, or the accuracy if worse, or a minute while moving', () => {
  const a = at(BIXBY, 0);
  assert.equal(keep(null, a, false), true);
  assert.equal(keep(a, at(off(BIXBY, 15, 0), 5), true), false);
  assert.equal(keep(a, at(off(BIXBY, 21, 0), 5), false), true);
  assert.equal(keep(a, at(off(BIXBY, 30, 0), 5, { accuracy: 40 }), false), false); // within what the GPS can tell
  assert.equal(keep(a, at(off(BIXBY, 45, 0), 5, { accuracy: 40 }), false), true);
  assert.equal(keep(a, at(off(BIXBY, 5, 0), KEEP_MS / 1000), true), true); // a minute while moving
  assert.equal(keep(a, at(off(BIXBY, 5, 0), KEEP_MS / 1000), false), false); // standing still: no
});

test('the rough travel estimate (spec §11.3) errs early', () => {
  assert.equal(travelMinutes(7.05, 'drive'), 12); // River Inn to Nepenthe: 7.05 km × 1.4 ÷ 50 km/h
  assert.equal(travelMinutes(1, 'walk'), 18); // 1 km × 1.3 ÷ 4.5 km/h
  assert.equal(modeFor(1.5, 'walking'), 'walk');
  assert.equal(modeFor(1.5, 'moving-fast'), 'drive');
  assert.equal(modeFor(2.5, 'still'), 'drive');
  assert.equal(kmText(850.4), '850 m');
  assert.equal(kmText(12_340), '12.3 km');
  assert.equal(span(42 * 60_000), '42 min');
  assert.equal(span(125 * 60_000), '2 h 5 min');
  assert.equal(span(30_000), 'less than a minute');
});

test('activity: moving fast after 30 s of GPS speed; a red light of 40 s stays moving fast; 70 s still is still', () => {
  const t = new ActivityTracker();
  /** @type {any[]} */
  const changes = [];
  let p = BIXBY;
  for (let s = 0; s <= 40; s += 5) {
    p = off(p, 0, -100);
    const c = t.feed(at(p, s, { speed: 20 }));
    if (c) changes.push([s, c.from, c.to]);
  }
  assert.deepEqual(changes, [[30, 'unknown', 'moving-fast']]);
  assert.equal(t.activity, 'moving-fast');
  for (let s = 45; s <= 85; s += 5) assert.equal(t.feed(at(p, s, { speed: 0 })), null); // stopped 40 s
  for (let s = 90; s <= 100; s += 5) t.feed(at((p = off(p, 0, -100)), s, { speed: 20 }));
  assert.equal(t.activity, 'moving-fast');
  for (let s = 105; s <= 175; s += 5) {
    const c = t.feed(at(p, s, { speed: 0 }));
    if (c) changes.push([s, c.from, c.to]);
  }
  assert.deepEqual(changes.at(-1), [165, 'moving-fast', 'still']); // 60 s after the stop began at 105
});

test('activity without GPS speed: from positions; parked GPS jitter is still, never walking', () => {
  const walk = new ActivityTracker();
  let p = BIXBY;
  for (let s = 0; s <= 60; s += 5) walk.feed(at((p = off(p, 7, 0)), s)); // 1.4 m/s
  assert.equal(walk.activity, 'walking');
  const parked = new ActivityTracker();
  for (let s = 0; s <= 300; s += 5) {
    // wandering up to 10 m around the car with 20 m accuracy
    const seen = parked.feed(at(off(BIXBY, Math.sin(s * 7.3) * 10, Math.cos(s * 3.1) * 10), s, { accuracy: 20 }));
    assert.notEqual(seen?.to, 'walking');
    assert.notEqual(seen?.to, 'moving-fast');
  }
  assert.equal(parked.activity, 'still');
  const drive = new ActivityTracker();
  p = BIXBY;
  for (let s = 0; s <= 60; s += 5) drive.feed(at((p = off(p, 0, -125)), s)); // 25 m/s
  assert.equal(drive.activity, 'moving-fast');
  assert.ok(Math.abs(/** @type {number} */ (drive.speed) - 25) < 2);
});

test('activity: between walking and moving fast, nothing changes; reset forgets', () => {
  const t = new ActivityTracker();
  let p = BIXBY;
  for (let s = 0; s <= 20; s += 5) t.feed(at((p = off(p, 0, -100)), s, { speed: 20 }));
  for (let s = 25; s <= 30; s += 5) t.feed(at((p = off(p, 0, -20)), s, { speed: 4 })); // 4 m/s: neither
  t.feed(at((p = off(p, 0, -100)), 35, { speed: 20 }));
  assert.equal(t.activity, 'moving-fast'); // the 30 s since 0 still counted
  t.reset();
  assert.equal(t.activity, 'unknown');
  assert.equal(t.speed, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/live-geo.test.js`
Expected: FAIL with `Cannot find module '…/src/core/live/geo.js'`.

- [ ] **Step 3: Write the implementation**

`src/core/live/geo.js`:

```js
/**
 * Where the user is, worked out on the phone (spec §11): distances, which GPS points are kept
 * (§4.5), and the rough travel-time estimate the plan's reminders use (§11.3).
 * @typedef {'gps' | 'manual' | 'sim'} FixSource  manual: the user said where they are (spec §17); sim: a simulation (§13)
 * @typedef {{ lat: number, lng: number, accuracy: number, at: number, speed: number | null, heading: number | null, source: FixSource }} Fix
 *   accuracy: meters; at: ms; speed: m/s, from the GPS, when it gives one
 * @typedef {{ lat: number, lng: number }} Point
 */

const EARTH_M = 6_371_000;
const rad = (/** @type {number} */ d) => (d * Math.PI) / 180;

/** Meters between two points (haversine). @param {Point} a @param {Point} b */
export function meters(a, b) {
  const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return EARTH_M * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** A number that is finite and not negative, else null. @param {unknown} v */
const plain = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** A sensor's position as a Fix, or null when it isn't one. @param {any} raw @param {number} now @returns {Fix | null} */
export function fixOf(raw, now) {
  const lat = raw?.lat;
  const lng = raw?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const source = raw.source === 'manual' || raw.source === 'sim' ? raw.source : 'gps';
  return { lat, lng, accuracy: plain(raw.accuracy) ?? 50, at: plain(raw.at) ?? now, speed: plain(raw.speed), heading: plain(raw.heading), source };
}

/** A point is kept after moving about this far (spec §4.5)… */
export const KEEP_M = 20;
/** …or after this long while moving. */
export const KEEP_MS = 60_000;

/**
 * Whether a fix is kept as a location point (spec §4.5): after moving about 20 m, or the GPS
 * accuracy if worse, or after a minute while moving.
 * @param {Fix | null} last the last point kept @param {Fix} fix @param {boolean} moving
 */
export function keep(last, fix, moving) {
  if (!last) return true;
  if (meters(last, fix) >= Math.max(KEEP_M, fix.accuracy)) return true;
  return moving && fix.at - last.at >= KEEP_MS;
}

/** The rough travel estimate (spec §11.3): straight-line distance × a detour factor ÷ a typical speed, so reminders err early. */
export const TRAVEL = Object.freeze({ drive: { detour: 1.4, kmh: 50, words: 'by car' }, walk: { detour: 1.3, kmh: 4.5, words: 'on foot' } });

/** Minutes to travel km in a straight line, by mode, rounded up. @param {number} km @param {'drive' | 'walk'} mode */
export function travelMinutes(km, mode) {
  const t = TRAVEL[mode];
  return Math.ceil(((km * t.detour) / t.kmh) * 60);
}

/** On foot for 2 km or less unless moving fast; anything else by car. @param {number} km @param {string} activity @returns {'drive' | 'walk'} */
export function modeFor(km, activity) {
  return km <= 2 && activity !== 'moving-fast' ? 'walk' : 'drive';
}

/** "850 m", "12.3 km": for Shiori, who gives the user their own units (§14.3). @param {number} m meters */
export function kmText(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** "42 min", "2 h 5 min". @param {number} ms */
export function span(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'less than a minute';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}
```

`src/core/live/activity.js`:

```js
import { meters } from './geo.js';

/**
 * The activity sensor's reasoning (spec §11.2): still, walking or moving fast, from GPS speed,
 * with 30–60 s hysteresis. GPS can't tell driving from riding a bus; both are moving fast, and
 * voice Auto treats them the same (§10.5).
 * @typedef {'still' | 'walking' | 'moving-fast' | 'unknown'} Activity
 * @typedef {import('./geo.js').Fix} Fix
 */

/** m/s: below this, still. */
export const STILL_BELOW = 0.5;
/** m/s: below this, walking (a run included). */
export const WALK_BELOW = 3;
/** m/s: from this, moving fast (18 km/h). Between WALK_BELOW and this, nothing changes. */
export const FAST_FROM = 5;
/** A new activity must hold this long… */
export const SETTLE_MS = 30_000;
/** …and leaving moving fast this long (a red light isn't the end of a drive). */
export const LEAVE_FAST_MS = 60_000;
/** Without the GPS's own speed, it is worked out from the oldest point at least this far back… */
const SPAN_MS = 15_000;
/** …and at most this far: the longer the span, the less GPS jitter looks like walking. */
const RECENT_MS = 60_000;

export class ActivityTracker {
  /** @type {Activity} */
  activity = 'unknown';
  /** The speed last worked out, m/s. @type {number | null} */
  speed = null;
  /** @type {{ activity: Activity, since: number } | null} what the speed has said lately, and since when */
  #candidate = null;
  /** @type {Fix[]} */
  #recent = [];

  /** @param {Fix} fix @returns {{ from: Activity, to: Activity, at: number } | null} the change, when there is one */
  feed(fix) {
    this.#recent = [...this.#recent.filter((f) => f.at < fix.at && fix.at - f.at <= RECENT_MS), fix];
    const speed = this.#speedAt(fix);
    if (speed === null) return null;
    this.speed = speed;
    /** @type {Activity | null} */
    const seen = speed < STILL_BELOW ? 'still' : speed < WALK_BELOW ? 'walking' : speed >= FAST_FROM ? 'moving-fast' : null;
    if (seen === null) return null; // between walking and moving fast: it says neither
    if (seen === this.activity) {
      this.#candidate = null;
      return null;
    }
    if (this.#candidate?.activity !== seen) this.#candidate = { activity: seen, since: fix.at };
    const hold = this.activity === 'moving-fast' ? LEAVE_FAST_MS : SETTLE_MS;
    if (fix.at - this.#candidate.since < hold) return null;
    const change = { from: this.activity, to: seen, at: fix.at };
    this.activity = seen;
    this.#candidate = null;
    return change;
  }

  /** Forgets everything: live mode went off. */
  reset() {
    this.activity = 'unknown';
    this.speed = null;
    this.#candidate = null;
    this.#recent = [];
  }

  /** m/s: the GPS's own, when it gives one with a usable fix; else over the last 15 to 60 s, less what the accuracy could explain. @param {Fix} fix */
  #speedAt(fix) {
    if (fix.speed !== null && fix.accuracy <= 50) return fix.speed;
    const old = this.#recent.find((f) => fix.at - f.at >= SPAN_MS); // the oldest kept, at most RECENT_MS back
    if (!old) return null;
    const d = Math.max(0, meters(old, fix) - (old.accuracy + fix.accuracy) / 2);
    return d / ((fix.at - old.at) / 1000);
  }
}
```

In `scripts/size.mjs`, the budget line becomes:

```js
const BUDGET = 960 * 1024; // bytes, uncompressed; raised from 740 KiB for milestone 3 (voice): 820, then 880 when Shiori learned to talk and listen; 960 for milestone 5 (live mode)
```

In `sw.js` `SHELL`, after `'/src/core/llm/…'` entries, in alphabetical order with the other `src/core` files, add:

```js
  '/src/core/live/activity.js',
  '/src/core/live/geo.js',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/live-geo.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/live/geo.js src/core/live/activity.js test/unit/live-geo.test.js test/unit/live-kit.js scripts/size.mjs sw.js && git commit -m "Live mode's arithmetic: distances, kept location points, the rough travel estimate, and still, walking or moving fast with hysteresis (spec §4.5, §11.2, §11.3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 2: Trigger types and watch records

**Files:**
- Create: `src/core/live/triggers.js`, `src/core/live/watches.js`
- Modify: `src/plugins/core-schemas/schemas.js` (watches have a format), `sw.js` (`SHELL`)
- Test: `test/unit/live-triggers.test.js`

**Interfaces:**
- Consumes: Task 1's `meters`, `kmText`, `Fix`.
- Produces:
  - `triggers.js`:
    - `Moment = { now, fix: Fix | null, newFix, past, live, activity, change: { from, to } | null, odometer, stop: { lat, lng, since } | null, gap: { since, from } | null, fired(id): boolean }`.
    - `Firing = { text, at?, place?: { name?, lat, lng }, fallback? }`.
    - `TriggerType = { type, gps, summary, validate(when): string | null, describe(when): string, start?(when, m, mem), check(when, m, mem): Firing | null, next?(when, m, mem): number | null }`.
    - `TRIGGERS`: `time`, `every`, `enter`, `leave`, `dwell`, `arrived`, `moved`, `activity`. `margin(radius)`, `NEW_PLACE_M = 500`.
    - mem, kept by the engine per watch: `set` (when it was set), `lastAt` and `lastPlace` (its last firing), `km0` (the odometer at her last wake); types keep `inside`, `since`, `done`, `from` there.
  - `watches.js`: `Watch = { id, owner, when: { type, … }, repeat?, fallback, expires?, created?, path? }`; `WATCH_DIR`, `WATCH_FILE`, `WATCH_SCHEMA`, `newWatchId()`, `watchPath(id)`, `readWatches(ws, scope): Promise<{ watches, broken }>`, `saveWatch(ws, scope, w, author)`, `removeWatch(ws, scope, w, author?)`, `expired(w, now)`.
  - `/watches/*.json` is checked against `WATCH_SCHEMA` in trips and in `me`.

- [ ] **Step 1: Write the failing test**

`test/unit/live-triggers.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIGGERS, margin } from '../../src/core/live/triggers.js';
import { readWatches, saveWatch, removeWatch, expired, newWatchId, watchPath } from '../../src/core/live/watches.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, ME } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { off } from './live-kit.js';

const T = /** @type {Record<string, import('../../src/core/live/triggers.js').TriggerType>} */ (Object.fromEntries(TRIGGERS.map((t) => [t.type, t])));
const T0 = Date.parse('2026-11-27T10:00:00-08:00');
const BIXBY = { lat: 36.3715, lng: -121.9017 };
const MIN = 60_000;
/** @param {Partial<import('../../src/core/live/triggers.js').Moment>} o @returns {import('../../src/core/live/triggers.js').Moment} */
const moment = (o = {}) => ({ now: T0, fix: null, newFix: false, past: false, live: true, activity: 'unknown', change: null, odometer: 0, stop: null, gap: null, fired: () => false, ...o });
/** A moment with a new fix at p, at now. @param {{ lat: number, lng: number }} p @param {number} now @param {Partial<import('../../src/core/live/geo.js').Fix>} [f] @param {Partial<import('../../src/core/live/triggers.js').Moment>} [o] */
const at = (p, now, f = {}, o = {}) => moment({ now, fix: { lat: p.lat, lng: p.lng, accuracy: 10, at: now, speed: null, heading: null, source: 'gps', ...f }, newFix: true, ...o });

test('each type checks what it is given, in plain words', () => {
  assert.deepEqual(TRIGGERS.map((t) => t.type), ['time', 'every', 'enter', 'leave', 'dwell', 'arrived', 'moved', 'activity']);
  assert.equal(T.time.validate({ at: '2026-11-27T18:00:00-08:00' }), null);
  assert.match(String(T.time.validate({ at: '2026-11-27 18:00' })), /ISO date-time with an offset/);
  assert.match(String(T.every.validate({ minutes: 0 })), /minutes must be a number from 1 to 1440/);
  assert.match(String(T.enter.validate({ lat: 36 })), /lat and lng/);
  assert.match(String(T.enter.validate({ lat: 36, lng: -121, radius: 5 })), /radius is in meters/);
  assert.match(String(T.dwell.validate({ lat: 36, lng: -121 })), /minutes/);
  assert.equal(T.arrived.validate({}), null);
  assert.match(String(T.moved.validate({ km: 0 })), /km must be a number from 0.1 to 1000/);
  assert.match(String(T.activity.validate({ activity: 'running' })), /still, walking or moving-fast/);
  assert.match(String(T.activity.validate({ activity: 'still', edge: 'middle' })), /edge is start or stop/);
  assert.equal(T.enter.describe({ lat: 36.3715, lng: -121.9017, name: 'Bixby Bridge' }), 'on entering Bixby Bridge (200 m)');
  assert.equal(T.moved.describe({ km: 15 }), 'after 15 km travelled');
  assert.equal(T.activity.describe({ activity: 'moving-fast' }), 'when moving fast starts');
  assert.equal(T.time.gps, false);
  assert.equal(T.every.gps, false);
  assert.ok(['enter', 'leave', 'dwell', 'arrived', 'moved', 'activity'].every((k) => T[k].gps));
});

test('time fires at its moment and says when it came due; every counts from when it was set, then from its last firing', () => {
  const w = { at: '2026-11-27T10:00:00-08:00' };
  assert.equal(T.time.check(w, moment({ now: T0 - 1 }), {}), null);
  assert.deepEqual(T.time.check(w, moment({ now: T0 + 5 * MIN }), {}), { text: 'the time came: 2026-11-27T10:00:00-08:00', at: T0 });
  assert.equal(T.time.next?.(w, moment(), {}), T0);
  const mem = { set: T0, lastAt: null };
  assert.equal(T.every.check({ minutes: 30 }, moment({ now: T0 + 29 * MIN }), mem), null);
  assert.deepEqual(T.every.check({ minutes: 30 }, moment({ now: T0 + 30 * MIN }), mem), { text: '30 min since you set it', at: T0 + 30 * MIN });
  const later = { set: T0, lastAt: T0 + 30 * MIN };
  assert.equal(T.every.next?.({ minutes: 30 }, moment(), later), T0 + 60 * MIN);
  assert.equal(T.every.check({ minutes: 30 }, moment({ now: T0 + 61 * MIN }), later)?.text, '30 min since it last fired');
});

test('enter and leave: the first fix only says where it is; a crossing fires; jitter in the margin does not', () => {
  const w = { ...BIXBY, radius: 200, name: 'Bixby Bridge' };
  assert.equal(margin(200), 50);
  const mem = {};
  assert.equal(T.enter.check(w, at(off(BIXBY, 0, 1000), T0), mem), null); // first: outside
  assert.equal(T.enter.check(w, at(off(BIXBY, 0, 240), T0 + 5000), mem), null); // in the margin: can't tell
  assert.deepEqual(T.enter.check(w, at(off(BIXBY, 0, 150), T0 + 10_000), mem), { text: 'you entered Bixby Bridge', place: { name: 'Bixby Bridge', lat: 36.3715, lng: -121.9017 } });
  for (const d of [190, 230, 245, 210, 180]) assert.equal(T.enter.check(w, at(off(BIXBY, d, 0), T0 + 20_000), mem), null); // jitter at the edge
  assert.equal(T.enter.check(w, at(off(BIXBY, 0, 600), T0 + 30_000, { accuracy: 500 }), mem), null); // too vague to say
  const out = {};
  T.leave.start?.(w, at(off(BIXBY, 0, 100), T0), out); // set while inside
  assert.equal(T.leave.check(w, at(off(BIXBY, 0, 240), T0 + 5000), out), null);
  assert.deepEqual(T.leave.check(w, at(off(BIXBY, 0, 900), T0 + 10_000), out), { text: 'you left Bixby Bridge, now 900 m away', place: { name: 'Bixby Bridge', lat: 36.3715, lng: -121.9017 } });
  assert.equal(T.leave.check(w, at(off(BIXBY, 0, 950), T0 + 15_000), out), null); // still out: once
  assert.equal(T.enter.check(w, moment({ now: T0 + 40_000, fix: at(BIXBY, T0).fix }), mem), null); // no new fix (a clock check): nothing moves
});

test('dwell fires once per visit after its minutes inside; leaving starts again; a catch-up first look does not fire it', () => {
  const w = { ...BIXBY, radius: 200, minutes: 10, name: 'Bixby Bridge' };
  const mem = {};
  T.dwell.start?.(w, at(off(BIXBY, 0, 1000), T0), mem);
  T.dwell.check(w, at(BIXBY, T0 + MIN), mem); // in
  assert.equal(T.dwell.next?.(w, moment({ now: T0 + 2 * MIN }), mem), T0 + 11 * MIN);
  assert.equal(T.dwell.check(w, moment({ now: T0 + 11 * MIN, past: true }), mem), null);
  assert.deepEqual(T.dwell.check(w, moment({ now: T0 + 11 * MIN }), mem), { text: "you've been at Bixby Bridge for 10 min", at: T0 + 11 * MIN, place: { name: 'Bixby Bridge', lat: 36.3715, lng: -121.9017 } });
  assert.equal(T.dwell.check(w, moment({ now: T0 + 30 * MIN }), mem), null);
  T.dwell.check(w, at(off(BIXBY, 0, 1000), T0 + 31 * MIN), mem); // out
  T.dwell.check(w, at(BIXBY, T0 + 32 * MIN), mem); // in again
  assert.equal(T.dwell.check(w, moment({ now: T0 + 42 * MIN }), mem)?.at, T0 + 42 * MIN);
});

test('arrived: stopped for its minutes somewhere new; not where it was set, and not the same spot twice', () => {
  const w = { minutes: 5 };
  const mem = {};
  T.arrived.start?.(w, at(BIXBY, T0), mem); // set while parked at Bixby
  const here = { ...BIXBY, since: T0 };
  assert.equal(T.arrived.check(w, moment({ now: T0 + 10 * MIN, stop: here }), mem), null);
  const nepenthe = { lat: 36.2213, lng: -121.7567, since: T0 + 30 * MIN };
  assert.equal(T.arrived.next?.(w, moment({ now: T0 + 31 * MIN, stop: nepenthe }), mem), T0 + 35 * MIN);
  assert.equal(T.arrived.check(w, moment({ now: T0 + 34 * MIN, stop: nepenthe }), mem), null);
  const f = T.arrived.check(w, moment({ now: T0 + 35 * MIN, stop: nepenthe }), mem);
  assert.equal(f?.text, "you've stopped for 5 min somewhere new");
  assert.deepEqual(f?.place, { lat: 36.2213, lng: -121.7567 });
  assert.equal(T.arrived.check(w, moment({ now: T0 + 50 * MIN, stop: { ...nepenthe, since: T0 + 40 * MIN } }), mem), null); // the same spot again
});

test('moved counts the odometer from her last wake; activity fires on its edge', () => {
  assert.equal(T.moved.check({ km: 15 }, moment({ odometer: 24.9 }), { km0: 10 }), null);
  assert.deepEqual(T.moved.check({ km: 15 }, moment({ odometer: 25.2 }), { km0: 10 }), { text: 'you have travelled 15.2 km since your last wake' });
  const start = { activity: 'moving-fast' };
  const stop = { activity: 'moving-fast', edge: 'stop' };
  assert.equal(T.activity.check(start, moment(), {}), null);
  assert.deepEqual(T.activity.check(start, moment({ change: { from: 'unknown', to: 'moving-fast' } }), {}), { text: 'the activity is now moving fast (it was not known yet)' });
  assert.equal(T.activity.check(stop, moment({ change: { from: 'unknown', to: 'moving-fast' } }), {}), null);
  assert.deepEqual(T.activity.check(stop, moment({ change: { from: 'moving-fast', to: 'still' } }), {}), { text: 'the activity is now still (it was moving fast)' });
});

test('watch records: kept as /watches/<id>.json with a format check; broken ones are counted, not read', async () => {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  const id = newWatchId();
  assert.match(id, /^w-/);
  const w = { id, owner: 'shiori', when: { type: 'moved', km: 15 }, repeat: true, fallback: 'Look out for Point Sur on the right.', created: '2026-11-27T17:00:00.000Z' };
  await saveWatch(ws, trip, w, 'shiori');
  await saveWatch(ws, ME, { ...w, id: 'w-me' }, 'shiori');
  await assert.rejects(saveWatch(ws, trip, /** @type {any} */ ({ ...w, id: 'w-bad', fallback: '' }), 'shiori'), /fallback/);
  await assert.rejects(saveWatch(ws, trip, /** @type {any} */ ({ ...w, id: 'w-bad', expires: 'tomorrow' }), 'shiori'), /expires/);
  await ws.write(trip, '/watches/broken.json', 'not json', { author: 'shiori', type: 'text/plain' });
  await ws.write(trip, '/watches/sub/x.json', { id: 'x' }, { author: 'shiori' });
  const got = await readWatches(ws, trip);
  assert.deepEqual(got.watches, [{ ...w, path: watchPath(id) }]);
  assert.equal(got.broken, 1);
  assert.equal((await readWatches(ws, ME)).watches[0].id, 'w-me');
  await removeWatch(ws, trip, got.watches[0]);
  assert.deepEqual((await readWatches(ws, trip)).watches, []);
  await removeWatch(ws, trip, got.watches[0]); // already gone: no error
  assert.equal(expired({ ...w, expires: '2026-11-27T10:00:00-08:00' }, T0), true);
  assert.equal(expired({ ...w, expires: '2026-11-27T10:00:00-08:00' }, T0 - 1), false);
  assert.equal(expired(w, T0), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/live-triggers.test.js`
Expected: FAIL with `Cannot find module '…/src/core/live/triggers.js'`.

- [ ] **Step 3: Write the implementation**

`src/core/live/triggers.js`:

```js
import { meters, kmText } from './geo.js';

/**
 * Trigger types (spec §11.3): what makes a watch fire. A type checks a watch's `when` against the
 * moment, and keeps what it must remember between checks in the watch's mem. Plugins add types
 * with register('trigger', type) (spec §5.4).
 * @typedef {import('./geo.js').Fix} Fix
 * @typedef {{ lat: number, lng: number, since: number }} Stop  where the user has stayed, and since when
 * @typedef {{ now: number, fix: Fix | null, newFix: boolean, past: boolean, live: boolean, activity: string,
 *   change: { from: string, to: string } | null, odometer: number, stop: Stop | null,
 *   gap: { since: number | null, from: Fix | null } | null, fired: (id: string) => boolean }} Moment
 *   fix: where the user is, when annai knows (live mode on, and not too old); newFix: this check came with that fix;
 *   past: a catch-up's first look, from where the user was when annai went off screen (spec §11.4): only what the clock makes due fires;
 *   change: the activity just changed; odometer: km travelled while live; stop: where the user has stayed, while live;
 *   gap: annai was off screen, or closed, and is catching up; fired: whether a watch of this conversation has fired
 * @typedef {{ name?: string, lat: number, lng: number }} Place
 * @typedef {{ text: string, at?: number, place?: Place, fallback?: string }} Firing
 *   text: what happened, for Shiori; at: when it came due (for "late by"); fallback: this firing's own words for the user
 * @typedef {{ type: string, gps: boolean, summary: string, validate: (when: any) => string | null, describe: (when: any) => string,
 *   start?: (when: any, m: Moment, mem: Record<string, any>) => void,
 *   check: (when: any, m: Moment, mem: Record<string, any>) => Firing | null,
 *   next?: (when: any, m: Moment, mem: Record<string, any>) => number | null }} TriggerType
 *   gps: it needs live mode; summary: its line in watch_set's description; start: sets mem from the moment the watch is first seen,
 *   without firing; next: when the clock alone could make it fire (spec §11.2: one timer, for the next due watch)
 */

/** A stop this far from the last one is somewhere new (arrived). */
export const NEW_PLACE_M = 500;
const MIN = 60_000;

/** @param {unknown} v @param {number} lo @param {number} hi */
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
/** @param {any} w */
const minutesWrong = (w) => (num(w?.minutes, 1, 1440) ? null : 'minutes must be a number from 1 to 1440');
/** @param {any} w */
function placeWrong(w) {
  if (!num(w?.lat, -90, 90) || !num(w?.lng, -180, 180)) return 'it needs lat and lng';
  if (w.radius !== undefined && !num(w.radius, 25, 50_000)) return 'radius is in meters, from 25 to 50000';
  return null;
}
/** @param {any} w @returns {number} */
const radius = (w) => w.radius ?? 200;
/** GPS jitter at the edge doesn't refire a circle (spec §11.3): inside within the radius, outside only beyond this margin. @param {number} r */
export const margin = (r) => Math.max(25, r / 4);
/** @param {any} w */
const named = (w) => (w.name ? String(w.name) : `the place at ${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}`);
/** @param {any} w @returns {Place} */
const placeOf = (w) => ({ ...(w.name ? { name: String(w.name) } : {}), lat: w.lat, lng: w.lng });
/** @param {string} a */
const words = (a) => (a === 'moving-fast' ? 'moving fast' : a === 'unknown' ? 'not known yet' : a);

/** Inside, outside, or can't tell (in the margin, or the fix too vague for this circle). @param {any} w @param {Fix} fix */
function side(w, fix) {
  const r = radius(w);
  if (fix.accuracy > Math.max(r, 100)) return null;
  const d = meters(w, fix);
  return d <= r ? true : d > r + margin(r) ? false : null;
}

/**
 * Follows inside and outside with each new fix and says which way it crossed. A fix that can't
 * tell changes nothing; the first one only sets where it is.
 * @param {any} w @param {Moment} m @param {Record<string, any>} mem @returns {'in' | 'out' | null}
 */
function crossing(w, m, mem) {
  if (!m.newFix || !m.fix) return null;
  const s = side(w, m.fix);
  if (s === null) return null;
  const was = mem.inside;
  mem.inside = s;
  if (s && was !== true) {
    mem.since = m.fix.at;
    mem.done = false;
  }
  if (!s) mem.since = null;
  if (was === undefined) return null;
  return was === s ? null : s ? 'in' : 'out';
}

/** Inside or outside, from where the user is when the watch is first seen. @param {any} w @param {Moment} m @param {Record<string, any>} mem */
function startSide(w, m, mem) {
  if (!m.fix) return;
  const s = side(w, m.fix);
  if (s === null) return;
  mem.inside = s;
  mem.since = s ? m.now : null;
}

/** @type {TriggerType} */
const TIME = {
  type: 'time', gps: false, summary: 'time {at}: once, at an ISO date-time with an offset',
  validate: (w) => (typeof w?.at === 'string' && /(?:[zZ]|[+-]\d\d:\d\d)$/.test(w.at) && Number.isFinite(Date.parse(w.at))
    ? null : 'at must be an ISO date-time with an offset, like 2026-11-27T18:00:00-08:00'),
  describe: (w) => `at ${w.at}`,
  next: (w) => Date.parse(w.at),
  check: (w, m) => (m.now >= Date.parse(w.at) ? { text: `the time came: ${w.at}`, at: Date.parse(w.at) } : null),
};

/** @type {TriggerType} */
const EVERY = {
  type: 'every', gps: false, summary: 'every {minutes}: at an interval, until cancelled or expired',
  validate: minutesWrong,
  describe: (w) => `every ${w.minutes} min`,
  next: (w, m, mem) => (mem.lastAt ?? mem.set) + w.minutes * MIN,
  check: (w, m, mem) => {
    const due = (mem.lastAt ?? mem.set) + w.minutes * MIN;
    return m.now >= due ? { text: `${w.minutes} min since ${mem.lastAt ? 'it last fired' : 'you set it'}`, at: due } : null;
  },
};

/** @type {TriggerType} */
const ENTER = {
  type: 'enter', gps: true, summary: 'enter {lat, lng, radius?, name?}: on coming inside a circle around a place (radius in meters, 200 if not given)',
  validate: placeWrong,
  describe: (w) => `on entering ${named(w)} (${radius(w)} m)`,
  start: startSide,
  check: (w, m, mem) => (crossing(w, m, mem) === 'in' ? { text: `you entered ${named(w)}`, place: placeOf(w) } : null),
};

/** @type {TriggerType} */
const LEAVE = {
  type: 'leave', gps: true, summary: 'leave {lat, lng, radius?, name?}: on going out of that circle',
  validate: placeWrong,
  describe: (w) => `on leaving ${named(w)} (${radius(w)} m)`,
  start: startSide,
  check: (w, m, mem) => (crossing(w, m, mem) === 'out' && m.fix ? { text: `you left ${named(w)}, now ${kmText(meters(w, m.fix))} away`, place: placeOf(w) } : null),
};

/** @type {TriggerType} */
const DWELL = {
  type: 'dwell', gps: true, summary: 'dwell {lat, lng, radius?, minutes, name?}: after that long inside a place, once a visit',
  validate: (w) => placeWrong(w) ?? minutesWrong(w),
  describe: (w) => `after ${w.minutes} min at ${named(w)}`,
  start: startSide,
  next: (w, m, mem) => (mem.inside && !mem.done && mem.since ? mem.since + w.minutes * MIN : null),
  check: (w, m, mem) => {
    crossing(w, m, mem);
    if (m.past || !mem.inside || mem.done || !mem.since || m.now - mem.since < w.minutes * MIN) return null;
    mem.done = true;
    return { text: `you've been at ${named(w)} for ${w.minutes} min`, at: mem.since + w.minutes * MIN, place: placeOf(w) };
  },
};

/** @type {TriggerType} */
const ARRIVED = {
  type: 'arrived', gps: true, summary: 'arrived {minutes?}: on stopping somewhere new for that long (5 min if not given)',
  validate: (w) => (w?.minutes === undefined || num(w.minutes, 1, 240) ? null : 'minutes must be a number from 1 to 240'),
  describe: (w) => `on stopping somewhere new for ${w.minutes ?? 5} min`,
  start: (w, m, mem) => {
    if (m.fix && !mem.from) mem.from = { lat: m.fix.lat, lng: m.fix.lng }; // where it was set isn't new
  },
  next: (w, m) => (m.stop ? m.stop.since + (w.minutes ?? 5) * MIN : null),
  check: (w, m, mem) => {
    const s = m.stop;
    const need = (w.minutes ?? 5) * MIN;
    if (m.past || !s || m.now - s.since < need) return null;
    const from = mem.from ?? mem.lastPlace;
    if (from && meters(from, s) < NEW_PLACE_M) return null;
    mem.from = { lat: s.lat, lng: s.lng };
    return { text: `you've stopped for ${Math.round((m.now - s.since) / MIN)} min somewhere new`, at: s.since + need, place: { lat: s.lat, lng: s.lng } };
  },
};

/** @type {TriggerType} */
const MOVED = {
  type: 'moved', gps: true, summary: 'moved {km}: after travelling that far since your last wake',
  validate: (w) => (num(w?.km, 0.1, 1000) ? null : 'km must be a number from 0.1 to 1000'),
  describe: (w) => `after ${w.km} km travelled`,
  check: (w, m, mem) => {
    const done = m.odometer - (mem.km0 ?? m.odometer);
    return done >= w.km ? { text: `you have travelled ${done.toFixed(1)} km since your last wake` } : null;
  },
};

/** @type {TriggerType} */
const ACTIVITY = {
  type: 'activity', gps: true, summary: 'activity {activity: still | walking | moving-fast, edge?: start | stop}: when it starts (or, with edge stop, stops)',
  validate: (w) => {
    if (!['still', 'walking', 'moving-fast'].includes(w?.activity)) return 'activity is still, walking or moving-fast';
    return w.edge === undefined || w.edge === 'start' || w.edge === 'stop' ? null : 'edge is start or stop';
  },
  describe: (w) => `when ${words(w.activity)} ${w.edge === 'stop' ? 'stops' : 'starts'}`,
  check: (w, m) => {
    const c = m.change;
    if (!c || (w.edge === 'stop' ? c.from !== w.activity : c.to !== w.activity)) return null;
    return { text: `the activity is now ${words(c.to)} (it was ${words(c.from)})` };
  },
};

/** The built-in types, in the order watch_set lists them. */
export const TRIGGERS = Object.freeze([TIME, EVERY, ENTER, LEAVE, DWELL, ARRIVED, MOVED, ACTIVITY]);
```

`src/core/live/watches.js`:

```js
import { newId } from '../scopes.js';

/**
 * Watches (spec §4.4: "stored as a record so it survives reloads"): /watches/<id>.json in the
 * scope of the conversation they belong to (a trip, or "me"), so removing a trip removes its
 * watches (§4.9). The plan's own watches aren't stored: they come from the plan.
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {{ id: string, owner: string, when: { type: string, [k: string]: any }, repeat?: boolean, fallback: string, expires?: string, created?: string, path?: string }} Watch
 *   owner: shiori, system or plugin:<id>; path: where it is stored (not part of the record)
 */

export const WATCH_DIR = '/watches/';
export const WATCH_FILE = /^\/watches\/[^/]+\.json$/;
export const WATCH_SCHEMA = {
  type: 'object', required: ['id', 'owner', 'when', 'fallback'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 80 },
    owner: { type: 'string', minLength: 1 },
    when: { type: 'object', required: ['type'], properties: { type: { type: 'string', minLength: 1 } } },
    repeat: { type: 'boolean' },
    fallback: { type: 'string', minLength: 1, maxLength: 500 },
    expires: { type: 'string', format: 'date-time' },
    created: { type: 'string', format: 'date-time' },
  },
};

export const newWatchId = () => newId('w');
/** @param {string} id */
export const watchPath = (id) => `${WATCH_DIR}${id}.json`;

/**
 * The watches stored in a scope, and how many files there couldn't be read as one.
 * @param {Workspace} ws @param {string} scope @returns {Promise<{ watches: Watch[], broken: number }>}
 */
export async function readWatches(ws, scope) {
  /** @type {Watch[]} */
  const watches = [];
  let broken = 0;
  for (const f of await ws.list(scope, WATCH_DIR)) {
    if (!WATCH_FILE.test(f.path)) continue;
    try {
      const w = await ws.readJSON(scope, f.path);
      if (w && typeof w === 'object' && typeof w.id === 'string' && typeof w.when?.type === 'string' && typeof w.fallback === 'string' && w.fallback.trim()) {
        watches.push({ ...w, path: f.path });
      } else broken++;
    } catch {
      broken++;
    }
  }
  return { watches, broken };
}

/** @param {Workspace} ws @param {string} scope @param {Watch} w @param {string} author */
export function saveWatch(ws, scope, w, author) {
  const { path, ...record } = w;
  return ws.write(scope, path ?? watchPath(w.id), record, { author });
}

/** Removes a watch; one already gone is fine. @param {Workspace} ws @param {string} scope @param {Watch} w */
export async function removeWatch(ws, scope, w, author = 'system') {
  const path = w.path ?? watchPath(w.id);
  if (await ws.read(scope, path)) await ws.delete(scope, path, { author });
}

/** Whether a watch is past its expiry. @param {Watch} w @param {number} now */
export function expired(w, now) {
  if (!w.expires) return false;
  const t = Date.parse(w.expires);
  return Number.isFinite(t) && now >= t;
}
```

In `src/plugins/core-schemas/schemas.js`, add `import { WATCH_SCHEMA } from '../../core/live/watches.js';` at the top, and to `CORE_SCHEMAS`:

```js
  { scope: 'trip', pattern: '/watches/*.json', schema: WATCH_SCHEMA },
  { scope: 'me', pattern: '/watches/*.json', schema: WATCH_SCHEMA },
```

Its description in `src/plugins/core-schemas/index.js` becomes `'Checks trip.json, plan items, bookings and watches when they are saved.'`.

In `sw.js` `SHELL`, add `'/src/core/live/triggers.js'` and `'/src/core/live/watches.js'` after `'/src/core/live/geo.js'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/live-triggers.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/live/triggers.js src/core/live/watches.js src/plugins/core-schemas test/unit/live-triggers.test.js sw.js && git commit -m "Watches and what makes them fire: at a time, every so often, on entering, leaving or staying at a place, on arriving somewhere new, after so many km, or when an activity starts or stops (spec §4.4, §11.3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 3: The plan's own watches

**Files:**
- Create: `src/core/live/plan-watches.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/live-plan-watches.test.js`

**Interfaces:**
- Consumes: Task 1's `meters`, `travelMinutes`, `modeFor`, `kmText`, `TRAVEL`; Task 2's `Watch`, `Moment`, `Firing`, `TriggerType`; milestone 4's `timeIn`, `validZone` (`src/core/time.js`) and `bookingRef` (`src/core/plan.js`).
- Produces:
  - `planWatches(items: { path, item }[], bookings: Map<string, booking>, { fallbackTz }): Watch[]`. Ids are `plan:<file name>:<event>`, and `plan:linger`; owner `system`; `when.type` is `plan`, with `event` one of `leave`, `coming-up`, `arrived`, `late`, `off-plan`, `linger`, and what that event needs (`title`, `at`, `end`, `tz`, `fixed`, `what`, `place`, `radius`, `from`; for linger `places`, `from`, `to`, `upcoming`).
  - `PLAN`: the `plan` TriggerType. Its firings carry their own `fallback`, filled in from the plan when they fire.
  - Constants: `LEAVE_LEAD_MIN = 15`, `COMING_UP_MIN = 15`, `LATE_GRACE_MIN = 5`, `ARRIVE_M = 300`, `AIRPORT_M = 2000`, `ARRIVE_STOP_MIN = 2`, `ARRIVE_INSIDE_MIN = 5`, `WINDOW_MIN = 180`, `OFF_PLAN_KM = 3`, `OFF_PLAN_AFTER_MIN = 10`, `LINGER_MIN = 20`, `NOT_PLANNED_M = 500`.
  - `PLAN.check` reads `m.fired('plan:<item>:arrived')`: late and off plan don't fire for an item the user has reached.

- [ ] **Step 1: Write the failing test**

`test/unit/live-plan-watches.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWatches, PLAN } from '../../src/core/live/plan-watches.js';
import { MONTEREY, BIXBY, RIVER_INN, NEPENTHE, off, at, LA } from './live-kit.js';

/** @param {Partial<import('../../src/core/live/triggers.js').Moment>} o @returns {import('../../src/core/live/triggers.js').Moment} */
const moment = (o = {}) => ({ now: at('08:00'), fix: null, newFix: false, past: false, live: true, activity: 'still', change: null, odometer: 0, stop: null, gap: null, fired: () => false, ...o });
/** The user at p at now, with a new fix. @param {{ lat: number, lng: number }} p @param {number} now @param {Partial<import('../../src/core/live/triggers.js').Moment>} [o] */
const here = (p, now, o = {}) => moment({ now, fix: { lat: p.lat, lng: p.lng, accuracy: 10, at: now, speed: null, heading: null, source: 'gps' }, newFix: true, ...o });
const ITEMS = [
  { path: '/plan/nepenthe.json', item: { id: 'nepenthe', title: 'Lunch at Nepenthe', fixed: true, start: { at: '2026-11-27T12:00:00-08:00', tz: LA }, end: { at: '2026-11-27T13:15:00-08:00', tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE }, notes: 'Window table if they have one.' } },
  { path: '/plan/bixby.json', item: { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: '2026-11-27T09:45:00-08:00', tz: LA }, end: { at: '2026-11-27T10:05:00-08:00', tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } } },
  { path: '/plan/flight.json', item: { id: 'flight', title: 'UA 123 home', kind: 'flight', fixed: true, start: { at: '2026-11-29T14:05:00-08:00', tz: LA }, place: { name: 'SFO', lat: 37.6213, lng: -122.379 }, booking: '/trip/bookings/flight.json' } },
  { path: '/plan/call.json', item: { id: 'call', title: 'Call Grandma', fixed: true, start: { at: '2026-11-27T18:00:00-08:00', tz: LA } } },
  { path: '/plan/park.json', item: { id: 'park', title: 'Day at the park', kind: 'all-day', fixed: false, start: { at: '2026-11-28T00:00:00-08:00', tz: LA }, place: { name: 'Park', lat: 36.5, lng: -121.9 } } },
  { path: '/plan/skate.json', item: { id: 'skate', title: 'Ice skating', fixed: false } },
  { path: '/plan/odd.json', item: 'not an object' },
];
const BOOKINGS = new Map([['/bookings/flight.json', { id: 'flight', kind: 'flight', status: 'confirmed', source: '/files/f.pdf', title: 'UA 123', fields: { terminal: 'T3' } }]]);
const WATCHES = planWatches(/** @type {any} */ (ITEMS), BOOKINGS, { fallbackTz: LA });
/** @param {string} id */
const find = (id) => /** @type {import('../../src/core/live/watches.js').Watch} */ (WATCHES.find((w) => w.id === id));

test("each timed item gets the plan's own watches; all-day and untimed items get none (spec §11.3)", () => {
  assert.deepEqual(WATCHES.map((w) => w.id), [
    'plan:bixby:off-plan', 'plan:bixby:arrived',
    'plan:nepenthe:leave', 'plan:nepenthe:late', 'plan:nepenthe:arrived',
    'plan:call:coming-up',
    'plan:flight:leave', 'plan:flight:late', 'plan:flight:arrived',
    'plan:linger',
  ]);
  assert.ok(WATCHES.every((w) => w.owner === 'system' && w.when.type === 'plan'));
  assert.deepEqual(WATCHES.map((w) => w.repeat), [false, false, false, false, false, false, false, false, false, true]);
  // Fallbacks filled in from the plan data, as "Flight UA123 departs 14:05, SFO T3".
  assert.equal(find('plan:flight:leave').fallback, 'Leave soon: Flight UA 123 departs 14:05, SFO T3.');
  assert.equal(find('plan:nepenthe:leave').fallback, 'Leave soon: Lunch at Nepenthe at 12:00.');
  assert.equal(find('plan:nepenthe:arrived').fallback, 'Nepenthe: Lunch at Nepenthe. Window table if they have one.');
  assert.equal(find('plan:call:coming-up').fallback, 'In 15 min: Call Grandma at 18:00.');
  assert.equal(find('plan:flight:arrived').when.radius, 2000); // an airport is big
  assert.equal(find('plan:nepenthe:arrived').when.radius, 300);
  assert.deepEqual(find('plan:nepenthe:leave').when.from, { name: 'Bixby Creek Bridge', ...BIXBY }); // the stop before it
  assert.deepEqual(find('plan:linger').when.places.map((/** @type {any} */ p) => p.name), ['Bixby Creek Bridge', 'Nepenthe', 'SFO']);
  assert.equal(PLAN.describe(find('plan:nepenthe:leave').when), '15 min before leaving for "Lunch at Nepenthe" at 12:00');
  assert.deepEqual(planWatches([], new Map(), { fallbackTz: LA }), []);
});

test('leave: 15 min before the estimated departure, from where the user is, else from the stop before; not once there, nor after the start', () => {
  const leave = find('plan:nepenthe:leave').when;
  // From the Big Sur River Inn, 7.0 km: about 12 min by car, so 12:00 − 27 min.
  assert.equal(PLAN.next?.(leave, here(RIVER_INN, at('10:30')), {}), at('11:33'));
  assert.equal(PLAN.check(leave, here(RIVER_INN, at('11:32')), {}), null);
  const f = PLAN.check(leave, here(RIVER_INN, at('11:33')), {});
  assert.equal(f?.text, 'Plan: time to leave soon for "Lunch at Nepenthe" (fixed, 12:00): 7.0 km away in a straight line, about 12 min by car');
  assert.equal(f?.at, at('11:33'));
  assert.equal(f?.fallback, 'Leave in about 15 min: Lunch at Nepenthe at 12:00. About 12 min by car.');
  // Without a position: from Bixby, the plan's stop before (21.2 km, 36 min).
  assert.equal(PLAN.next?.(leave, moment({ now: at('10:00') }), {}), at('11:09'));
  assert.equal(PLAN.check(leave, here(off(NEPENTHE, 100, 0), at('11:50')), {}), null); // already there
  assert.equal(PLAN.check(leave, here(RIVER_INN, at('12:00')), {}), null); // it has started: running late says so
  const call = find('plan:call:coming-up').when;
  assert.equal(PLAN.next?.(call, moment(), {}), at('17:45'));
  assert.equal(PLAN.check(call, moment({ now: at('17:44') }), {}), null);
  assert.deepEqual(PLAN.check(call, moment({ now: at('17:45') }), {}), { text: 'Plan: "Call Grandma" (fixed) starts at 18:00, in 15 min', at: at('17:45') });
});

test('arrived: stopped 2 min there, or 5 min inside; driving past is not arriving; inferred on coming back on screen', () => {
  const arrived = find('plan:nepenthe:arrived').when;
  const mem = {};
  assert.equal(PLAN.check(arrived, here(NEPENTHE, at('11:48'), { stop: { ...NEPENTHE, since: at('11:48') } }), mem), null);
  assert.equal(PLAN.check(arrived, here(NEPENTHE, at('11:49'), { stop: { ...NEPENTHE, since: at('11:48') } }), mem), null);
  assert.deepEqual(PLAN.check(arrived, here(NEPENTHE, at('11:50'), { stop: { ...NEPENTHE, since: at('11:48') } }), mem), {
    text: 'Plan: you arrived at Nepenthe for "Lunch at Nepenthe" (fixed, 12:00)', place: { name: 'Nepenthe', ...NEPENTHE },
  });
  // Walking about inside for 5 minutes (the stop keeps moving).
  const walk = {};
  for (const [t, dx] of /** @type {[string, number][]} */ ([['11:00', 0], ['11:02', 120], ['11:04', -120]])) {
    assert.equal(PLAN.check(arrived, here(off(NEPENTHE, dx, 0), at(t), { stop: { ...off(NEPENTHE, dx, 0), since: at(t) } }), walk), null);
  }
  assert.ok(PLAN.check(arrived, here(NEPENTHE, at('11:05'), { stop: { ...NEPENTHE, since: at('11:05') } }), walk));
  // Driving past at 50 km/h: inside for half a minute.
  const past = {};
  assert.equal(PLAN.check(arrived, here(off(NEPENTHE, -250, 0), at('11:00')), past), null);
  assert.equal(PLAN.check(arrived, here(off(NEPENTHE, 250, 0), at('11:00:36')), past), null);
  assert.equal(PLAN.check(arrived, here(off(NEPENTHE, 1000, 0), at('11:01')), past), null);
  assert.equal(PLAN.check(arrived, here(NEPENTHE, at('08:00'), { stop: { ...NEPENTHE, since: at('07:50') } }), {}), null); // before its window
  const back = PLAN.check(arrived, here(NEPENTHE, at('12:10'), { gap: { since: at('11:40'), from: null } }), {});
  assert.equal(back?.text, 'Plan: you arrived at Nepenthe for "Lunch at Nepenthe" (fixed, 12:00), inferred on coming back on screen');
});

test('running late: when the estimated arrival is more than 5 min past the start; not once arrived, nor inside; not hours early', () => {
  const late = find('plan:nepenthe:late').when;
  assert.equal(PLAN.check(late, here(RIVER_INN, at('11:50')), {}), null); // 12 min: 12:02
  const f = PLAN.check(late, here(BIXBY, at('11:40')), {});
  assert.equal(f?.text, 'Plan: running late for "Lunch at Nepenthe" (fixed, 12:00): 21.2 km away, about 36 min by car, so about 16 min late');
  assert.equal(f?.fallback, 'Running late: Lunch at Nepenthe at 12:00. About 36 min away.');
  assert.equal(PLAN.check(late, here(BIXBY, at('11:40'), { fired: (id) => id === 'plan:nepenthe:arrived' }), {}), null);
  assert.equal(PLAN.check(late, here(off(NEPENTHE, 50, 0), at('12:20')), {}), null);
  assert.equal(PLAN.check(late, here(BIXBY, at('08:30')), {}), null); // more than 3 h before
  assert.equal(PLAN.next?.(late, here(BIXBY, at('08:30')), {}), at('11:29:01'));
  assert.ok(PLAN.check(late, here(BIXBY, at('11:29:01')), {}));
  assert.equal(PLAN.check(late, moment({ now: at('11:40') }), {}), null); // no position: can't tell
});

test('off plan: far from a flexible item 10 min into its time; or stopped 20 min somewhere not on the plan, once a spot', () => {
  const offPlan = find('plan:bixby:off-plan').when;
  assert.equal(PLAN.check(offPlan, here(RIVER_INN, at('09:54')), {}), null);
  assert.equal(PLAN.check(offPlan, here(off(BIXBY, 0, -2000), at('09:56')), {}), null);
  assert.equal(PLAN.check(offPlan, here(RIVER_INN, at('09:56')), {})?.text,
    'Off plan: "Bixby Bridge photo stop" (flexible) is planned for 09:45–10:05 at Bixby Creek Bridge, and the user is 14.1 km away. The replanning skill says what to do');
  assert.equal(PLAN.check(offPlan, here(RIVER_INN, at('09:56'), { fired: (id) => id === 'plan:bixby:arrived' }), {}), null);
  const linger = find('plan:linger').when;
  const mem = /** @type {Record<string, any>} */ ({});
  assert.equal(PLAN.check(linger, here(MONTEREY, at('08:30')), mem), null); // where live mode first found the user
  assert.equal(PLAN.check(linger, here(MONTEREY, at('08:55'), { stop: { ...MONTEREY, since: at('08:30') } }), mem), null);
  const s = { ...RIVER_INN, since: at('10:08') };
  assert.equal(PLAN.next?.(linger, here(RIVER_INN, at('10:10'), { stop: s }), mem), at('10:28'));
  assert.equal(PLAN.check(linger, here(RIVER_INN, at('10:27'), { stop: s }), mem), null);
  const f = PLAN.check(linger, here(RIVER_INN, at('10:28'), { stop: s }), mem);
  assert.equal(f?.text, "Off plan: the user has been stopped for 20 min at a place that isn't on the plan (36.2700, -121.8070); next on the plan: \"Lunch at Nepenthe\" at 12:00. The replanning skill says what to do");
  assert.equal(f?.fallback, 'Next on the plan: Lunch at Nepenthe at 12:00.');
  assert.equal(f?.at, at('10:28'));
  mem.lastPlace = f?.place; // the engine keeps where it last fired
  assert.equal(PLAN.check(linger, here(RIVER_INN, at('11:00'), { stop: s }), mem), null);
  assert.equal(PLAN.check(linger, here(NEPENTHE, at('12:30'), { stop: { ...NEPENTHE, since: at('11:50') } }), { home: MONTEREY }), null); // a plan place
  assert.equal(PLAN.check(linger, moment({ now: at('11:00'), past: true, fix: here(RIVER_INN, at('10:00')).fix, stop: s }), { home: MONTEREY }), null); // a catch-up's first look
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/live-plan-watches.test.js`
Expected: FAIL with `Cannot find module '…/src/core/live/plan-watches.js'`.

- [ ] **Step 3: Write the implementation**

`src/core/live/plan-watches.js`:

```js
import { meters, travelMinutes, modeFor, kmText, TRAVEL } from './geo.js';
import { timeIn, validZone } from '../time.js';
import { bookingRef } from '../plan.js';

/**
 * The plan's own watches (spec §11.3: "Plan items create their own watches. The system sets
 * these, so they don't depend on Shiori remembering"): leave in X minutes, arrived, running late,
 * coming up; and off plan (§11.5). They are worked out from the plan whenever it changes and never
 * stored; the log's trigger.fired entries say which have fired. Their fallbacks come from the plan.
 * @typedef {import('./watches.js').Watch} Watch
 * @typedef {import('./triggers.js').Moment} Moment
 * @typedef {import('./triggers.js').Firing} Firing
 * @typedef {{ name: string, lat: number, lng: number }} Place
 */

/** The leave reminder comes this long before the estimated departure ("leave in X minutes"). */
export const LEAVE_LEAD_MIN = 15;
/** A fixed item without coordinates is announced this long before it starts. */
export const COMING_UP_MIN = 15;
/** Arriving up to this long after the start isn't late. */
export const LATE_GRACE_MIN = 5;
/** Arrived: within this many meters of the place; an airport is bigger. */
export const ARRIVE_M = 300;
export const AIRPORT_M = 2000;
/** Arrived: stopped there this long, or inside this long. */
export const ARRIVE_STOP_MIN = 2;
export const ARRIVE_INSIDE_MIN = 5;
/** Arriving counts from this long before the start until the end (or this long after the start); running late, from then. */
export const WINDOW_MIN = 180;
/** Off plan: this far from a flexible item, this long into its time. */
export const OFF_PLAN_KM = 3;
export const OFF_PLAN_AFTER_MIN = 10;
/** Off plan: stopped this long, this far from every plan place. */
export const LINGER_MIN = 20;
export const NOT_PLANNED_M = 500;

const MIN = 60_000;
/** @param {any} p @returns {p is { lat: number, lng: number }} */
const hasPoint = (p) => Boolean(p) && typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng);
/** "/plan/nepenthe.json" → "nepenthe". @param {string} path */
const slug = (path) => path.replace(/^\/plan\//, '').replace(/\.json$/, '');

/**
 * @param {{ path: string, item: any }[]} items the plan files @param {Map<string, any>} bookings by path, such as "/bookings/hearst.json"
 * @param {{ fallbackTz: string }} o the zone for an item whose own zone annai doesn't know
 * @returns {Watch[]}
 */
export function planWatches(items, bookings, { fallbackTz }) {
  const timed = items
    .filter((x) => x.item && typeof x.item === 'object' && !Array.isArray(x.item) && x.item.kind !== 'all-day')
    .map((x) => ({ ...x, at: Date.parse(x.item.start?.at ?? '') }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  /** @type {Watch[]} */
  const out = [];
  /** @type {Place | null} */
  let prev = null;
  /** @type {Place[]} */
  const places = [];
  const zone = (/** @type {any} */ it) => (validZone(it.start?.tz) ? it.start.tz : fallbackTz);
  for (const x of timed) {
    const it = x.item;
    const tz = zone(it);
    const title = String(it.title ?? slug(x.path));
    const end = Date.parse(it.end?.at ?? '');
    const place = hasPoint(it.place) ? { name: String(it.place.name ?? title), lat: it.place.lat, lng: it.place.lng } : null;
    const booking = bookings.get(bookingRef(it.booking) ?? '') ?? null;
    const flight = it.kind === 'flight' || booking?.kind === 'flight';
    const base = {
      type: 'plan', item: slug(x.path), title, at: x.at, end: Number.isFinite(end) && end > x.at ? end : null, tz, fixed: it.fixed === true,
      what: what(title, booking, flight, x.at, tz, place?.name ?? ''),
    };
    /** @param {string} event @param {string} fallback @param {Record<string, any>} [extra] */
    const add = (event, fallback, extra = {}) => out.push({ id: `plan:${base.item}:${event}`, owner: 'system', repeat: false, fallback, when: { ...base, event, ...extra } });
    if (place) {
      const there = { place, radius: flight ? AIRPORT_M : ARRIVE_M };
      if (base.fixed) {
        add('leave', `Leave soon: ${base.what}.`, { ...there, from: prev });
        add('late', `Running late: ${base.what}.`, there);
      } else {
        add('off-plan', `Planned now: ${title}, at ${place.name}.`, there);
      }
      add('arrived', `${place.name}: ${title}.${typeof it.notes === 'string' && it.notes.trim() ? ` ${it.notes.trim()}` : ''}`, there);
      prev = place;
      places.push(place);
    } else if (base.fixed) {
      add('coming-up', `In ${COMING_UP_MIN} min: ${base.what}.`);
    }
  }
  if (places.length) {
    out.push({
      id: 'plan:linger', owner: 'system', repeat: true, fallback: "You've stopped somewhere that isn't on the plan.",
      when: {
        type: 'plan', event: 'linger', places, from: timed[0].at - 12 * 60 * MIN, to: /** @type {any} */ (timed.at(-1)).at + 12 * 60 * MIN,
        upcoming: timed.map((x) => ({ title: String(x.item.title ?? slug(x.path)), at: x.at, tz: zone(x.item) })),
      },
    });
  }
  return out;
}

/**
 * The item in a few words for a reminder (spec §11.3: "Flight UA123 departs 14:05, SFO T3").
 * @param {string} title @param {any} booking @param {boolean} flight @param {number} at @param {string} tz @param {string} placeName
 */
function what(title, booking, flight, at, tz, placeName) {
  const time = timeIn(at, tz);
  const terminal = typeof booking?.fields?.terminal === 'string' && booking.fields.terminal.trim() ? ` ${booking.fields.terminal.trim()}` : '';
  if (flight) return `Flight ${String(booking?.title ?? title)} departs ${time}${placeName ? `, ${placeName}${terminal}` : ''}`;
  const where = placeName && !title.toLowerCase().includes(placeName.toLowerCase()) ? `, ${placeName}` : '';
  return `${title} at ${time}${where}`;
}

/** @param {any} w @param {number} [t] */
const hhmm = (w, t = w.at) => timeIn(t, w.tz);
/** @param {any} w */
const kind = (w) => (w.fixed ? 'fixed' : 'flexible');
/** Where the user is now (not on a catch-up's first look). @param {Moment} m */
const now = (m) => (m.fix && !m.past ? m.fix : null);
/** @param {number} km @param {string} activity */
const trip = (km, activity) => {
  const mode = modeFor(km, activity);
  return { mode, minutes: travelMinutes(km, mode), words: TRAVEL[mode].words };
};

/**
 * When to leave for an item: from where the user is (or was, on a catch-up's first look), else
 * from the plan's stop before; with neither, half an hour before. Null once the user is there.
 * @param {any} w @param {Moment} m
 */
function leaving(w, m) {
  const from = m.fix ?? w.from ?? null;
  if (!from) return { due: w.at - 30 * MIN, km: null, minutes: null, words: '' };
  const km = meters(from, w.place) / 1000;
  if (km * 1000 <= w.radius) return null;
  const t = trip(km, m.activity);
  return { due: w.at - (t.minutes + LEAVE_LEAD_MIN) * MIN, km, minutes: t.minutes, words: t.words };
}

/** @type {Record<string, (w: any, m: Moment, mem: Record<string, any>) => Firing | null>} */
const CHECK = {
  leave(w, m) {
    const l = leaving(w, m);
    if (!l || m.now < l.due || m.now >= w.at) return null;
    const how = l.km === null ? '' : `: ${kmText(l.km * 1000)} away in a straight line, about ${l.minutes} min ${l.words}`;
    return {
      text: `Plan: time to leave soon for "${w.title}" (${kind(w)}, ${hhmm(w)})${how}`, at: l.due,
      fallback: l.km === null ? `Leave soon: ${w.what}.` : `Leave in about ${LEAVE_LEAD_MIN} min: ${w.what}. About ${l.minutes} min ${l.words}.`,
    };
  },
  'coming-up'(w, m) {
    const due = w.at - COMING_UP_MIN * MIN;
    if (m.now < due || m.now >= w.at) return null;
    return { text: `Plan: "${w.title}" (${kind(w)}) starts at ${hhmm(w)}, in ${Math.max(1, Math.round((w.at - m.now) / MIN))} min`, at: due };
  },
  arrived(w, m, mem) {
    const fix = now(m);
    if (!fix || m.now < w.at - WINDOW_MIN * MIN || m.now > (w.end ?? w.at + WINDOW_MIN * MIN)) return null;
    const inside = fix.accuracy <= Math.max(w.radius, 200) && meters(fix, w.place) <= w.radius;
    if (!inside) {
      if (m.newFix) mem.since = null;
      return null;
    }
    if (m.newFix && !mem.since) mem.since = fix.at;
    const stop = m.stop;
    const stopped = stop !== null && meters(stop, w.place) <= w.radius && m.now - stop.since >= ARRIVE_STOP_MIN * MIN;
    const long = Boolean(mem.since) && m.now - mem.since >= ARRIVE_INSIDE_MIN * MIN;
    // Arriving is inferred from where the user was against where they are now (spec §11.4).
    const gap = m.gap;
    const back = gap !== null && gap.since !== null && m.newFix && m.now - gap.since >= ARRIVE_STOP_MIN * MIN;
    if (!stopped && !long && !back) return null;
    return { text: `Plan: you arrived at ${w.place.name} for "${w.title}" (${kind(w)}, ${hhmm(w)})${back && !stopped && !long ? ', inferred on coming back on screen' : ''}`, place: w.place };
  },
  late(w, m) {
    const fix = now(m);
    if (!fix || m.fired(`plan:${w.item}:arrived`) || m.now < w.at - WINDOW_MIN * MIN || m.now > w.at + 60 * MIN) return null;
    const km = meters(fix, w.place) / 1000;
    if (km * 1000 <= w.radius) return null;
    const t = trip(km, m.activity);
    const eta = m.now + t.minutes * MIN;
    if (eta <= w.at + LATE_GRACE_MIN * MIN) return null;
    return {
      text: `Plan: running late for "${w.title}" (${kind(w)}, ${hhmm(w)}): ${kmText(km * 1000)} away, about ${t.minutes} min ${t.words}, so about ${Math.round((eta - w.at) / MIN)} min late`,
      fallback: `Running late: ${w.what}. About ${t.minutes} min away.`,
    };
  },
  'off-plan'(w, m) {
    const fix = now(m);
    const end = w.end ?? w.at + 60 * MIN;
    if (!fix || m.fired(`plan:${w.item}:arrived`) || m.now < w.at + OFF_PLAN_AFTER_MIN * MIN || m.now > end) return null;
    const km = meters(fix, w.place) / 1000;
    if (km <= OFF_PLAN_KM) return null;
    return { text: `Off plan: "${w.title}" (flexible) is planned for ${hhmm(w)}–${hhmm(w, end)} at ${w.place.name}, and the user is ${kmText(km * 1000)} away. The replanning skill says what to do` };
  },
  linger(w, m, mem) {
    const fix = now(m);
    if (!fix) return null;
    if (!mem.home) mem.home = { lat: fix.lat, lng: fix.lng }; // where live mode first found the user isn't a detour
    const s = m.stop;
    if (!s || m.now < w.from || m.now > w.to || m.now - s.since < LINGER_MIN * MIN) return null;
    const far = (/** @type {any} */ p) => !p || meters(p, s) > NOT_PLANNED_M;
    if (!w.places.every(far) || !far(mem.home) || !far(mem.lastPlace)) return null;
    const next = w.upcoming.find((/** @type {any} */ u) => u.at > m.now);
    const nextText = next ? `"${next.title}" at ${timeIn(next.at, next.tz)}` : '';
    return {
      text: `Off plan: the user has been stopped for ${Math.round((m.now - s.since) / MIN)} min at a place that isn't on the plan (${s.lat.toFixed(4)}, ${s.lng.toFixed(4)})${next ? `; next on the plan: ${nextText}` : ''}. The replanning skill says what to do`,
      at: s.since + LINGER_MIN * MIN, place: { lat: s.lat, lng: s.lng },
      fallback: next ? `Next on the plan: ${next.title} at ${timeIn(next.at, next.tz)}.` : 'Nothing more is on the plan.',
    };
  },
};

/** @type {Record<string, (w: any, m: Moment, mem: Record<string, any>) => number | null>} */
const NEXT = {
  leave: (w, m) => {
    const l = leaving(w, m);
    return l && l.due < w.at ? l.due : null;
  },
  'coming-up': (w) => w.at - COMING_UP_MIN * MIN,
  arrived: (w, m, mem) => {
    const t = [mem.since ? mem.since + ARRIVE_INSIDE_MIN * MIN : Infinity, m.stop ? m.stop.since + ARRIVE_STOP_MIN * MIN : Infinity];
    const first = Math.min(...t);
    return first === Infinity ? null : first;
  },
  late: (w, m) => {
    const fix = now(m);
    if (!fix) return null;
    const t = trip(meters(fix, w.place) / 1000, m.activity);
    return Math.max(w.at - WINDOW_MIN * MIN, w.at + (LATE_GRACE_MIN - t.minutes) * MIN + 1000);
  },
  'off-plan': (w) => w.at + OFF_PLAN_AFTER_MIN * MIN,
  linger: (w, m) => (m.stop ? m.stop.since + LINGER_MIN * MIN : null),
};

/** @type {Record<string, (w: any) => string>} */
const DESCRIBE = {
  leave: (w) => `${LEAVE_LEAD_MIN} min before leaving for "${w.title}" at ${hhmm(w)}`,
  'coming-up': (w) => `${COMING_UP_MIN} min before "${w.title}" at ${hhmm(w)}`,
  arrived: (w) => `on arriving at ${w.place.name} for "${w.title}"`,
  late: (w) => `when running late for "${w.title}" at ${hhmm(w)}`,
  'off-plan': (w) => `when far from "${w.title}" while it is planned`,
  linger: () => `on stopping ${LINGER_MIN} min somewhere not on the plan`,
};

/** The plan's trigger type. It isn't for watch_set: the plan sets these itself. @type {import('./triggers.js').TriggerType} */
export const PLAN = {
  type: 'plan', gps: false, summary: '',
  validate: () => 'the plan sets its own watches',
  describe: (w) => DESCRIBE[w.event]?.(w) ?? String(w.event),
  check: (w, m, mem) => CHECK[w.event]?.(w, m, mem) ?? null,
  next: (w, m, mem) => NEXT[w.event]?.(w, m, mem) ?? null,
};
```

In `sw.js` `SHELL`, add `'/src/core/live/plan-watches.js'` after `'/src/core/live/geo.js'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/live-plan-watches.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/live/plan-watches.js test/unit/live-plan-watches.test.js sw.js && git commit -m "The plan sets its own reminders: leave in time, arrived, running late, coming up, and off plan, with fallbacks from the plan such as \"Flight UA 123 departs 14:05, SFO T3\" (spec §11.3, §11.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 4: The live engine: sensors, fixes, watches firing, one clock timer, the switch

**Files:**
- Create: `src/core/live/clock.js`, `src/core/live/skills.js`, `src/core/live/live.js`
- Modify: `test/unit/live-kit.js` (the kit), `sw.js` (`SHELL`)
- Test: `test/unit/live-engine.test.js`

**Interfaces:**
- Consumes: Tasks 1–3; `readAppSettings`, `updateAppSettings` (`src/core/settings.js`); `logEvent` (`src/core/events.js`); `listTrips`, `ME` (`src/core/scopes.js`); `PLAN_FILE`, `BOOKING_FILE` (`src/core/plan.js`); `validZone`, `deviceZone`, `isoInZone` (`src/core/time.js`); `validate` (`src/core/schema.js`); `tsv`.
- Produces:
  - `clock.js`: `Clock = { now(), set(fn, ms), clear(handle) }`; `realClock()`; `class ManualClock { now; set; clear; pending; advanceTo(t, settle?) }`; `scaledClock(start, speed, base?)`.
  - `skills.js`: `DRIVING` (`driving-companion`) and `REPLANNING` (`replanning`), each `{ name, description, text }`.
  - `live.js`:
    - `class Live` with `new Live({ store, ws, registry, agent, clock?, timeZone? })`, where `agent` is `{ target, wake(w), remind(list, scope?), on('event', fn) }`.
    - State: `on`, `fix`, `activity`, `odometer`, `stop`, `gps` (`'off' | 'waiting' | 'ok' | 'denied' | 'unavailable'`), `gpsMessage`, `shown`, `online`, `namers`.
    - `start()`, `dispose()`, `setLive(on)`, `fixed(raw)`, `visible(v)`, `connected(v)`, `place({ lat, lng, name? })` (a manual place, spec §17), `settled()`, `onChange(fn)`, `types()`.
    - `setWatch(scope, { when, fallback, repeat?, expires? }, owner?)`: `Watch`, or an Error in plain words; `watchText(w)`; `listWatches(scope)`: TSV; `cancelWatch(scope, id)`.
    - `nowInfo(): { place, activity }`; `near(p, within?)`.
    - Constants: `STOP_M = 100`, `FRESH_MS`, `RECHECK_MS = 60_000`.
  - Registry items it adds, as plugin `live`: kind `activity` (`{ now(), onChange(fn) }`, which voice Auto reads, spec §10.5) and kind `skill` (the two skills).
  - Sensors it reads: registry kind `sensor`, `{ kind: 'location' | 'visibility' | 'connectivity', start(emit): stop }`. A location sensor emits `{ lat, lng, accuracy, speed?, heading? }` or `{ error: 'denied' | 'unavailable', message }`.
  - Events it writes: `location` (`{ lat, lng, accuracy, speed?, heading?, source? }`, at the fix's time) into the open trip; `trigger.fired` (`{ watch, type, event?, owner, text, fallback, place? }`) into the watch's scope; `state` (`{ live: 'on' | 'off' }`) into the open conversation.
  - Wakes it sends: `{ kind: 'trigger', text, fallbacks: [{ watch, text }] }` for the open conversation (several firings at once: one wake); `{ kind: 'trigger', text, scope }` with `agent.remind(fallbacks, scope)` for another conversation's time watch; `{ kind: 'live', text }` when live mode is turned on.
  - `test/unit/live-kit.js`: `fakeAgent(target)`, `fakeSensors(registry)`, `liveKit({ plan?, bookings?, live?, start? })` → `{ registry, store, ws, trip, clock, agent, sensors, live, settle, to(t), fix(t, p, o?), drive(a, b, t0, t1, every?), stay(p, t0, t1, every?), events(types?, scope?) }`.

- [ ] **Step 1: Write the failing test**

`test/unit/live-kit.js` becomes:

```js
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { meters } from '../../src/core/live/geo.js';

/** Places on the Big Sur drive, and a point some meters away from one. Tests of live mode share these. */
export const MONTEREY = { lat: 36.6036, lng: -121.8916 };
export const BIXBY = { lat: 36.3715, lng: -121.9017 };
export const RIVER_INN = { lat: 36.27, lng: -121.807 };
export const NEPENTHE = { lat: 36.2213, lng: -121.7567 };
export const MCWAY = { lat: 36.158, lng: -121.672 };
export const HEARST = { lat: 35.6852, lng: -121.166 };
export const CAMBRIA = { lat: 35.5641, lng: -121.0807 };
/** Meters in a degree of latitude, as meters() counts them. */
const DEG = (6_371_000 * Math.PI) / 180;
/** A point dx meters east and dy meters north of p. @param {{ lat: number, lng: number }} p @param {number} dx @param {number} dy */
export const off = (p, dx, dy) => ({ lat: p.lat + dy / DEG, lng: p.lng + dx / (DEG * Math.cos((p.lat * Math.PI) / 180)) });
export const LA = 'America/Los_Angeles';
/** A moment on the day of the drive, Pacific time. @param {string} hhmm "09:30" or "09:30:15" */
export const at = (hhmm, day = '2026-11-27') => Date.parse(`${day}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}-08:00`);
/** The same moment as ISO 8601 with its offset, as plan items and watches write it. @param {string} hhmm */
export const iso = (hhmm, day = '2026-11-27') => `${day}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}-08:00`;

/** The Agent as live mode sees it: it records wakes and reminders, and can say she woke. @param {string | null} target */
export function fakeAgent(target) {
  /** @type {Set<(e: any) => void>} */
  const listeners = new Set();
  return {
    target,
    /** @type {any[]} */
    wakes: [],
    /** @type {{ watch: string, text: string, scope: string }[]} */
    reminders: [],
    /** @param {any} w */
    wake(w) {
      this.wakes.push(w);
      return Promise.resolve();
    },
    /** @param {{ watch: string, text: string }[]} list @param {string} [scope] */
    async remind(list, scope) {
      for (const r of list) this.reminders.push({ ...r, scope: scope ?? this.target ?? 'me' });
    },
    /** @param {'event'} kind @param {(e: any) => void} fn */
    on(kind, fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    /** She woke, as the Agent logs it. @param {string | null} [scope] */
    woke(scope = this.target) {
      for (const fn of listeners) fn({ type: 'wake', scope, data: {} });
    },
  };
}

/** Sensors a test drives by hand (spec §11.2): location, visibility and connectivity. @param {Registry} registry */
export function fakeSensors(registry) {
  /** @type {Record<string, ((x: any) => void) | null>} */
  const emit = { location: null, visibility: null, connectivity: null };
  for (const kind of Object.keys(emit)) {
    registry.add('test', 'sensor', {
      kind,
      start: (/** @type {(x: any) => void} */ fn) => {
        emit[kind] = fn;
        return () => { if (emit[kind] === fn) emit[kind] = null; };
      },
    });
  }
  return {
    gpsOn: () => emit.location !== null,
    /** @param {any} x */
    fix: (x) => emit.location?.(x),
    /** @param {string} error */
    error: (error) => emit.location?.({ error, message: `GPS ${error}` }),
    /** @param {boolean} v */
    visible: (v) => emit.visibility?.(v),
    /** @param {boolean} v */
    online: (v) => emit.connectivity?.(v),
  };
}

/**
 * A memory annai in live mode: a trip with the plan and bookings given, a Live engine on a manual
 * clock (08:30 on the day of the drive), sensors driven by hand, and an agent that records.
 * @param {{ plan?: Record<string, any>, bookings?: Record<string, any>, live?: boolean, start?: number }} [o]
 */
export async function liveKit({ plan = {}, bookings = {}, live = true, start = at('08:30') } = {}) {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Big Sur', start: '2026-11-27', end: '2026-11-28' });
  for (const [name, item] of Object.entries(plan)) await ws.write(trip, `/plan/${name}.json`, { id: name, ...item }, { author: 'user' });
  for (const [name, b] of Object.entries(bookings)) await ws.write(trip, `/bookings/${name}.json`, b, { author: 'user' });
  if (live) await updateAppSettings(ws, { live: { on: true } });
  const clock = new ManualClock(start);
  const agent = fakeAgent(trip);
  const sensors = fakeSensors(registry);
  const engine = new Live({ store, ws, registry, agent, clock, timeZone: () => LA });
  await engine.start();
  await engine.settled();
  const settle = () => engine.settled();
  const k = {
    registry, store, ws, trip, clock, agent, sensors, live: engine, settle,
    /** Moves the clock to t, firing the timers that come due on the way. @param {number} t */
    to: (t) => clock.advanceTo(t, settle),
    /** A GPS fix at p, at t. @param {number} t @param {{ lat: number, lng: number }} p @param {Record<string, any>} [o] */
    async fix(t, p, o = {}) {
      await clock.advanceTo(t, settle);
      sensors.fix({ lat: p.lat, lng: p.lng, accuracy: 8, speed: 0, ...o });
      await settle();
    },
    /** Driving from a to b between t0 and t1, a fix every so many seconds. @param {{ lat: number, lng: number }} a @param {{ lat: number, lng: number }} b @param {number} t0 @param {number} t1 */
    async drive(a, b, t0, t1, every = 5) {
      const speed = meters(a, b) / ((t1 - t0) / 1000);
      for (let t = t0; t <= t1; t += every * 1000) {
        const f = (t - t0) / (t1 - t0);
        await k.fix(t, { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f }, { speed });
      }
    },
    /** Staying at p from t0 to t1, a fix every so many seconds. @param {{ lat: number, lng: number }} p @param {number} t0 @param {number} t1 */
    async stay(p, t0, t1, every = 10) {
      for (let t = t0; t <= t1; t += every * 1000) await k.fix(t, p, { speed: 0 });
    },
    /** @param {string[]} [types] @param {string} [scope] */
    events: (types, scope = trip) => store.tx(['events'], 'readonly', (t) => t.listEvents(scope, types ? { types } : {})),
  };
  return k;
}
```

`test/unit/live-engine.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, at, iso, off, LA, MONTEREY, BIXBY, NEPENTHE, CAMBRIA, HEARST } from './live-kit.js';
import { readAppSettings } from '../../src/core/settings.js';
import { readWatches } from '../../src/core/live/watches.js';
import { createTrip, removeTrip, ME } from '../../src/core/scopes.js';
import { ManualClock, scaledClock } from '../../src/core/live/clock.js';

const NEP = { title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, end: { at: iso('13:15'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };
const BIX = { title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } };
const CASTLE = { title: 'Hearst Castle tour', fixed: true, start: { at: iso('16:30'), tz: LA }, place: { name: 'Hearst Castle', ...HEARST } };

test('clocks: a manual one runs its timers in order as it moves; a scaled one runs ten times faster', async () => {
  const c = new ManualClock(1000);
  /** @type {string[]} */
  const ran = [];
  c.set(() => ran.push('b'), 200);
  const gone = c.set(() => ran.push('x'), 100);
  c.set(() => ran.push('a'), 100);
  c.clear(gone);
  await c.advanceTo(1150);
  assert.deepEqual(ran, ['a']);
  assert.equal(c.now(), 1150);
  await c.advanceTo(5000);
  assert.deepEqual(ran, ['a', 'b']);
  assert.equal(c.pending, 0);
  let t = 0;
  const base = { now: () => t, set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => ({ fn, ms }), clear: () => {} };
  const fast = scaledClock(1_000_000, 10, base);
  t = 500;
  assert.equal(fast.now(), 1_005_000);
  assert.equal(fast.set(() => {}, 10_000).ms, 1000);
});

test('live mode on: GPS runs, the switch is kept, a state entry is logged and Shiori is woken once; off: GPS stops and the activity is unknown', async () => {
  const k = await liveKit({ live: false });
  assert.equal(k.sensors.gpsOn(), false);
  await k.live.setLive(true);
  assert.equal(k.sensors.gpsOn(), true);
  assert.equal((await readAppSettings(k.ws)).live.on, true);
  assert.deepEqual(k.agent.wakes.map((w) => w.kind), ['live']);
  assert.match(k.agent.wakes[0].text, /turned live mode on.*driving-companion/);
  await k.drive(MONTEREY, off(MONTEREY, 0, -3000), at('08:31'), at('08:34'));
  assert.equal(k.registry.list('activity')[0].now(), 'moving-fast');
  await k.live.setLive(false);
  assert.equal(k.sensors.gpsOn(), false);
  assert.equal(k.registry.list('activity')[0].now(), 'unknown');
  assert.equal(k.live.fix, null);
  assert.deepEqual((await k.events(['state'])).map((e) => e.data.live), ['on', 'off']);
  assert.equal(k.agent.wakes.length, 1);
  await k.live.setLive(false);
  assert.equal((await k.events(['state'])).length, 2);
  assert.deepEqual(k.registry.list('skill').map((s) => s.name), ['driving-companion', 'replanning']);
});

test('location points are kept as §4.5 says; GPS jitter at a stop adds no distance; the activity sensor follows (spec §11.2)', async () => {
  const k = await liveKit();
  for (let s = 0; s <= 300; s += 5) await k.fix(at('08:30') + s * 1000, off(MONTEREY, Math.sin(s * 7.3) * 10, Math.cos(s * 3.1) * 10), { accuracy: 20, speed: 0 });
  assert.ok((await k.events(['location'])).length < 20);
  assert.equal(k.live.odometer, 0);
  assert.equal(k.live.activity, 'still');
  let calls = 0;
  k.registry.list('activity')[0].onChange(() => { calls++; });
  await k.drive(MONTEREY, off(MONTEREY, 0, -5000), at('08:36'), at('08:41'));
  const driving = (await k.events(['location'])).filter((e) => e.ts >= at('08:36'));
  assert.equal(driving.length, 61); // every fix, 83 m apart
  assert.ok(Math.abs(k.live.odometer - 5) < 0.1, `odometer ${k.live.odometer}`);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(driving[1].data).sort(), ['accuracy', 'lat', 'lng', 'speed']);
  assert.equal(driving[1].ts, at('08:36:05'));
});

test('a time watch fires by the clock with live mode off, then is gone; a location watch waits for live mode', async () => {
  const k = await liveKit({ live: false });
  const call = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Call Mia about dinner.' });
  const enter = await k.live.setWatch(k.trip, { when: { type: 'enter', lat: BIXBY.lat, lng: BIXBY.lng, name: 'Bixby' }, fallback: 'Bixby Bridge.' });
  await k.to(at('09:59'));
  assert.equal(k.agent.wakes.length, 0);
  await k.to(at('10:00'));
  assert.equal(k.agent.wakes.length, 1);
  const w = k.agent.wakes[0];
  assert.equal(w.kind, 'trigger');
  assert.equal(w.text, `Your watch ${call.id} (at ${iso('10:00')}) fired: the time came: ${iso('10:00')}. Its reminder: "Call Mia about dinner."`);
  assert.deepEqual(w.fallbacks, [{ watch: call.id, text: 'Call Mia about dinner.' }]);
  const [fired] = await k.events(['trigger.fired']);
  assert.deepEqual(fired.data, { watch: call.id, type: 'time', owner: 'shiori', text: `the time came: ${iso('10:00')}`, fallback: 'Call Mia about dinner.' });
  assert.deepEqual((await readWatches(k.ws, k.trip)).watches.map((x) => x.id), [enter.id]);
  await k.to(at('11:00'));
  assert.equal(k.agent.wakes.length, 1);
});

test('watches firing at once merge into one wake (spec §6.1)', async () => {
  const k = await liveKit({ live: false });
  const a = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'A.' });
  const b = await k.live.setWatch(k.trip, { when: { type: 'every', minutes: 90 }, fallback: 'B.' }); // set at 08:30
  await k.to(at('10:00'));
  assert.equal(k.agent.wakes.length, 1);
  assert.deepEqual(k.agent.wakes[0].fallbacks.map((/** @type {any} */ f) => f.watch), [a.id, b.id]);
  await k.to(at('11:30'));
  assert.equal(k.agent.wakes.length, 2); // every keeps going
});

test('enter and leave fire once a crossing; jitter at the edge does not refire them; a vague fix changes nothing', async () => {
  const k = await liveKit();
  await k.fix(at('09:00'), off(BIXBY, 0, 1000));
  const circle = { lat: BIXBY.lat, lng: BIXBY.lng, radius: 200, name: 'Bixby Bridge' };
  await k.live.setWatch(k.trip, { when: { type: 'enter', ...circle }, repeat: true, fallback: 'Bixby Bridge ahead.' });
  await k.live.setWatch(k.trip, { when: { type: 'leave', ...circle }, repeat: true, fallback: 'On to Big Sur.' });
  await k.fix(at('09:01'), off(BIXBY, 0, 150));
  for (const [i, d] of [190, 230, 245, 210, 180, 240].entries()) await k.fix(at('09:02') + i * 5000, off(BIXBY, d, 0), { accuracy: 15 });
  await k.fix(at('09:03'), off(BIXBY, 0, 600), { accuracy: 900 });
  await k.fix(at('09:04'), off(BIXBY, 0, -600));
  await k.fix(at('09:05'), BIXBY);
  assert.deepEqual(k.agent.wakes.map((w) => w.fallbacks[0].text), ['Bixby Bridge ahead.', 'On to Big Sur.', 'Bixby Bridge ahead.']);
});

test('moved fires after its km since her last wake; any wake starts the count again', async () => {
  const k = await liveKit();
  const w = await k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, repeat: true, fallback: 'Narrate.' });
  await k.drive(MONTEREY, off(MONTEREY, 0, -3000), at('09:00'), at('09:03'));
  k.agent.woke(); // she woke for something else
  await k.drive(off(MONTEREY, 0, -3000), off(MONTEREY, 0, -7000), at('09:03:05'), at('09:07'));
  assert.equal(k.agent.wakes.length, 0);
  await k.drive(off(MONTEREY, 0, -7000), off(MONTEREY, 0, -9000), at('09:07:05'), at('09:09'));
  assert.equal(k.agent.wakes.length, 1);
  assert.match(k.agent.wakes[0].text, new RegExp(`^Your watch ${w.id} \\(after 5 km travelled\\) fired: you have travelled 5\\.\\d km since your last wake`));
});

test('a watch that is broken, of an unknown type, expired, or whose plugin trigger throws is skipped; the others still fire', async () => {
  const k = await liveKit({ live: false });
  k.registry.add('tides', 'trigger', { type: 'tide', check() { throw new TypeError('tide tables missing'); } });
  await k.ws.write(k.trip, '/watches/broken.json', 'not json', { author: 'shiori', type: 'text/plain' });
  await k.ws.write(k.trip, '/watches/w-odd.json', { id: 'w-odd', owner: 'shiori', when: { type: 'comet' }, fallback: 'Look up.' }, { author: 'shiori' });
  await k.ws.write(k.trip, '/watches/w-old.json', { id: 'w-old', owner: 'shiori', when: { type: 'time', at: iso('09:30') }, fallback: 'Old.', expires: iso('09:00') }, { author: 'shiori' });
  const tide = await k.live.setWatch(k.trip, { when: { type: 'tide' }, fallback: 'Low tide.' });
  const ok = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Still works.' });
  await k.to(at('10:00'));
  assert.deepEqual(k.agent.wakes.map((w) => w.fallbacks.map((/** @type {any} */ f) => f.watch)), [[ok.id]]);
  assert.deepEqual((await readWatches(k.ws, k.trip)).watches.map((w) => w.id).sort(), ['w-odd', tide.id].sort()); // the expired one went, unfired
  assert.match(await k.live.listWatches(k.trip), /w-odd\tshiori\tcomet \(its trigger type isn't installed\)/);
});

test("the plan's leave reminder comes by the clock with live mode off, from the stop before, in the plan's own words", async () => {
  const k = await liveKit({ live: false, plan: { bixby: BIX, nepenthe: NEP } });
  await k.to(at('11:08'));
  assert.equal(k.agent.wakes.length, 0);
  await k.to(at('11:09'));
  assert.equal(k.agent.wakes.length, 1);
  assert.equal(k.agent.wakes[0].text, 'Plan: time to leave soon for "Lunch at Nepenthe" (fixed, 12:00): 21.2 km away in a straight line, about 36 min by car.');
  assert.deepEqual(k.agent.wakes[0].fallbacks, [{ watch: 'plan:nepenthe:leave', text: 'Leave in about 15 min: Lunch at Nepenthe at 12:00. About 36 min by car.' }]);
  assert.equal((await k.events(['trigger.fired']))[0].data.event, 'leave');
  await k.to(at('12:00'));
  assert.equal(k.agent.wakes.length, 1);
});

test('the plan changing while live: a moved item moves its reminder, a deleted item has none, a broken file stops nothing', async () => {
  const k = await liveKit({ live: false, plan: { bixby: BIX, nepenthe: NEP, castle: CASTLE } });
  await k.ws.patch(k.trip, '/plan/nepenthe.json', { start: { at: iso('13:00') }, end: { at: iso('14:00') } }, { author: 'shiori' });
  await k.ws.delete(k.trip, '/plan/castle.json', { author: 'user' });
  await k.ws.write(k.trip, '/plan/broken.json', 'not json', { author: 'user', type: 'text/plain' });
  await k.to(at('12:08'));
  assert.equal(k.agent.wakes.length, 0);
  await k.to(at('12:09'));
  assert.equal(k.agent.wakes.length, 1);
  await k.to(at('17:00'));
  assert.equal(k.agent.wakes.length, 1);
});

test('arrived at a plan place after a 2 min stop; driving past does not count; the place is logged for stamps (spec §13)', async () => {
  const k = await liveKit({ plan: { bixby: BIX } });
  await k.drive(off(BIXBY, 0, 3000), off(BIXBY, 0, -3000), at('09:00'), at('09:06'));
  assert.equal(k.agent.wakes.length, 0);
  await k.drive(off(BIXBY, 0, -3000), BIXBY, at('09:06:05'), at('09:09'));
  await k.stay(BIXBY, at('09:09:10'), at('09:12'));
  assert.deepEqual(k.agent.wakes.map((w) => w.text), ['Plan: you arrived at Bixby Creek Bridge for "Bixby Bridge photo stop" (flexible, 09:45).']);
  const [fired] = await k.events(['trigger.fired']);
  assert.deepEqual(fired.data.place, { name: 'Bixby Creek Bridge', ...BIXBY });
});

test('running late for a fixed item, from where the user is (spec §11.3)', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  await k.stay(BIXBY, at('11:00'), at('11:30'), 30);
  assert.equal(k.agent.wakes.length, 2);
  assert.match(k.agent.wakes[0].text, /^Plan: time to leave soon for "Lunch at Nepenthe"/);
  assert.equal(k.agent.wakes[1].text, 'Plan: running late for "Lunch at Nepenthe" (fixed, 12:00): 21.2 km away, about 36 min by car, so about 5 min late.');
  assert.deepEqual(k.agent.wakes[1].fallbacks, [{ watch: 'plan:nepenthe:late', text: 'Running late: Lunch at Nepenthe at 12:00. About 36 min away.' }]);
});

test('another trip opened: its watches and its log; a time watch of the first still reminds; nothing goes into a removed trip', async () => {
  const k = await liveKit({ live: false, plan: { nepenthe: NEP } });
  const first = k.trip;
  const w1 = await k.live.setWatch(first, { when: { type: 'time', at: iso('09:00') }, fallback: 'Pack the snacks.' });
  const w2 = await k.live.setWatch(first, { when: { type: 'every', minutes: 10 }, fallback: 'Every ten.' });
  const second = await createTrip(k.ws, { title: 'Cambria' });
  k.agent.target = second;
  await k.live.setLive(true);
  await k.fix(at('08:40'), CAMBRIA);
  assert.equal((await k.events(['location'], second)).length, 1);
  assert.equal((await k.events(['location'], first)).length, 0);
  await k.to(at('09:00'));
  assert.deepEqual(k.agent.reminders, [{ watch: w1.id, text: 'Pack the snacks.', scope: first }]);
  assert.match(k.agent.wakes.find((w) => w.scope === first)?.text, /Pack the snacks/);
  assert.equal(k.agent.wakes.filter((w) => String(w.text).includes(w2.id)).length, 0); // an every watch waits for its own conversation
  assert.equal(k.agent.wakes.filter((w) => String(w.text).includes('Nepenthe')).length, 0); // and so does the first trip's plan
  await k.live.setWatch(first, { when: { type: 'time', at: iso('10:00') }, fallback: 'Gone.' });
  await removeTrip(k.store, first);
  await k.to(at('10:00'));
  assert.equal(k.agent.reminders.length, 1);
  assert.equal((await k.events(undefined, first)).length, 0);
});

test('the now block: where the user is, near which plan place, and what they are doing (spec §6.3)', async () => {
  const k = await liveKit({ live: false, plan: { nepenthe: NEP } });
  assert.deepEqual(k.live.nowInfo(), { place: 'unknown (live mode is off, so annai has no GPS)', activity: 'unknown (live mode is off)' });
  await k.live.setLive(true);
  assert.deepEqual(k.live.nowInfo(), { place: 'unknown (waiting for GPS)', activity: 'unknown' });
  await k.drive(off(NEPENTHE, 0, 3000), off(NEPENTHE, 0, 400), at('11:40'), at('11:43'));
  assert.equal(k.live.nowInfo().place, 'near Nepenthe (400 m) · 36.22490, -121.75670 (±8 m)');
  assert.match(k.live.nowInfo().activity, /^moving fast, about 5\d km\/h$/);
  await k.to(at('11:50'));
  assert.match(k.live.nowInfo().place, /\(±8 m, 7 min ago\)$/);
  await k.live.setLive(false);
  await k.live.setLive(true);
  k.sensors.error('denied');
  await k.settle();
  assert.equal(k.live.gps, 'denied');
  assert.equal(k.live.nowInfo().place, 'unknown (location permission is off)');
  await k.live.place({ lat: NEPENTHE.lat, lng: NEPENTHE.lng, name: 'Nepenthe' }); // spec §17: a manual place
  assert.equal(k.live.nowInfo().place, 'near Nepenthe (0 m) · 36.22130, -121.75670 (±50 m, set by the user)');
});

test("watch_set's checks, in plain words; the list shows hers and the plan's; the plan's can't be cancelled", async () => {
  const k = await liveKit({ live: false, plan: { nepenthe: NEP } });
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'comet' }, fallback: 'x' }), /when\.type must be one of: time, every, enter, leave, dwell, arrived, moved, activity\./);
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'plan' }, fallback: 'x' }), /when\.type must be one of/);
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'moved', km: -1 }, fallback: 'x' }), /A moved watch: km must be a number from 0\.1 to 1000\./);
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, fallback: ' ' }), /needs a fallback/);
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'time', at: iso('08:00') }, fallback: 'x' }), /has already passed/);
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, fallback: 'x', expires: 'soon' }), /expires must be an ISO date-time/);
  const w = await k.live.setWatch(k.trip, { when: { type: 'moved', km: 15 }, repeat: true, fallback: 'Look for Point Sur.', expires: iso('18:00') });
  assert.equal(k.live.watchText(w), `Set ${w.id}: after 15 km travelled, every time, until ${iso('18:00')}. Live mode is off, so it waits until the user turns it on. Now: unknown (live mode is off); unknown (live mode is off, so annai has no GPS).`);
  const list = await k.live.listWatches(k.trip);
  assert.equal(list.split('\n')[0], 'id\towner\twhen\trepeat\treminder\texpires\tlast_fired');
  assert.ok(list.includes(`${w.id}\tshiori\tafter 15 km travelled\tyes\tLook for Point Sur.\t${iso('18:00')}\t`));
  assert.ok(list.includes('plan:nepenthe:leave\tsystem\t15 min before leaving for "Lunch at Nepenthe" at 12:00\tno\tLeave soon: Lunch at Nepenthe at 12:00.\t\t'));
  await assert.rejects(k.live.cancelWatch(k.trip, 'plan:nepenthe:leave'), /follows the plan/);
  await assert.rejects(k.live.cancelWatch(k.trip, 'w-nope'), /There is no watch w-nope/);
  assert.equal(await k.live.cancelWatch(k.trip, w.id), `Cancelled ${w.id}.`);
  assert.deepEqual((await readWatches(k.ws, k.trip)).watches, []);
  assert.equal(await k.live.listWatches(ME), 'No watches.');
});

test('off screen nothing runs: GPS stops and the clock waits; back on screen both start again (spec §11.1)', async () => {
  const k = await liveKit();
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Ten.' });
  assert.equal(k.sensors.gpsOn(), true);
  k.sensors.visible(false);
  await k.settle();
  assert.equal(k.sensors.gpsOn(), false);
  assert.equal(k.clock.pending, 0);
  await k.to(at('10:05'));
  assert.equal(k.agent.wakes.length, 0);
  k.sensors.visible(true);
  await k.settle();
  assert.equal(k.sensors.gpsOn(), true);
  assert.equal(k.agent.wakes.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/live-engine.test.js`
Expected: FAIL with `Cannot find module '…/src/core/live/live.js'` (imported by the kit).

- [ ] **Step 3: Write the implementation**

`src/core/live/clock.js`:

```js
/**
 * Clocks for live mode (spec §11.2: one timer, for the next due watch): the real one; a manual one
 * for tests and for a simulation stepped as fast as it can go; and one running faster than real
 * time, for a simulation watched on screen (§18: 10×).
 * @typedef {{ now: () => number, set: (fn: () => void, ms: number) => any, clear: (handle: any) => void }} Clock
 */

/** @returns {Clock} */
export function realClock() {
  return { now: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) };
}

/** A clock that moves only when told. */
export class ManualClock {
  #now;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  #timers = new Map();
  #seq = 0;
  /** @param {number} start */
  constructor(start) {
    this.#now = start;
  }
  now = () => this.#now;
  /** @param {() => void} fn @param {number} ms */
  set = (fn, ms) => {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn });
    return id;
  };
  /** @param {any} id */
  clear = (id) => {
    this.#timers.delete(id);
  };
  /** How many timers wait. */
  get pending() {
    return this.#timers.size;
  }
  /**
   * Moves to t, running each timer that comes due on the way, in order, and waiting for settle()
   * after each. @param {number} t @param {() => Promise<unknown>} [settle]
   */
  async advanceTo(t, settle = async () => {}) {
    for (;;) {
      /** @type {[number, { at: number, fn: () => void }] | null} */
      let next = null;
      for (const [id, x] of this.#timers) if (x.at <= t && (!next || x.at < next[1].at)) next = [id, x];
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#now = Math.max(this.#now, next[1].at);
      next[1].fn();
      await settle();
    }
    this.#now = Math.max(this.#now, t);
  }
}

/**
 * A clock speed times faster than real time, from start (spec §18: a trip simulation at 10×).
 * @param {number} start @param {number} speed @param {Clock} [base] @returns {Clock}
 */
export function scaledClock(start, speed, base = realClock()) {
  const t0 = base.now();
  return { now: () => start + (base.now() - t0) * speed, set: (fn, ms) => base.set(fn, Math.max(0, ms) / speed), clear: (h) => base.clear(h) };
}
```

`src/core/live/skills.js`:

```js
/**
 * Live mode's built-in skills (spec §11.5: "Narration is a built-in skill, not code"). Only their
 * names and descriptions sit in Shiori's context; she loads a text with the skill tool.
 */

export const DRIVING = Object.freeze({
  name: 'driving-companion',
  description: 'When live mode is on and the user may be driving or riding: which watches to set, and how to narrate the road.',
  text: `# Driving companion

You are a companion in the car: you plan, explain, guide and entertain, and you never distract the driver.

## When live mode turns on
- If you have no activity watch yet, set one so you know when driving starts: watch_set({ when: { type: "activity", activity: "moving-fast" }, repeat: true, fallback: "<what is useful to hear on setting off, such as the next plan stop and its time>" }).
- watch_set's result says what the user is doing now. If they are already moving fast, set up the drive at once (below).

## When driving starts
- Set a moved watch for narration every 10 to 20 km (repeat: true). On a long empty stretch an every watch of 20 to 30 minutes works too. Give each a fallback a passenger would find useful, such as "Next on the plan: lunch at Nepenthe at 12:00."
- Don't add the reminders the plan sets itself: leave, arrived and running late come by themselves.

## When one fires
- Look along the road ahead: nearby({ lat, lng, radius: 5000 to 15000, kinds: ["sights"] }) at the coordinates in the now block; fuel, food and toilets when the drive is long or someone asks.
- Pick at most one thing worth saying: a view coming up, a story about a place, a stop that fits the plan. If nothing is worth it, sleep without speaking.
- Narrate for this party and this mood: who is in the car (trip.json's party: ages, interests, who drives), what the profile and memory say they like, and your personality. Short and spoken: the driver must never need to look at the screen.
- Never ask the driver to read or tap while moving fast. Ask only what anyone in the car can answer aloud.
- Fixed plan items come first: when time is tight, say so plainly, and by how much.

## When the drive ends
- At a long stop (a plan arrival, or the user says so), cancel the moved and every watches you set for the drive with watch_cancel (watch_list shows them). Keep the activity watch: it tells you when the next drive starts.`,
});

export const REPLANNING = Object.freeze({
  name: 'replanning',
  description: 'When annai says the user is off plan or running late: welcoming the detour, and reshuffling the plan around what is fixed.',
  text: `# Replanning

annai wakes you when the user is off plan (far from a flexible item while it is planned, or stopped somewhere that isn't on the plan) and when they are running late for a fixed one.

1. Welcome the detour. The plan is a suggestion; this is their trip, and an unplanned stop is often the best part.
2. Say what it costs, in one sentence: what moves or drops, above all anything fixed (a flight, a reservation, a tour, a check-in).
3. Reshuffle the flexible items so the fixed ones still fit. Patch each item you move, one patch per file, such as patch({ path: "/trip/plan/mcway.json", changes: { start: { at: "2026-11-27T14:00:00-08:00", tz: "America/Los_Angeles" }, end: { at: "2026-11-27T14:30:00-08:00", tz: "America/Los_Angeles" } } }). Keep each time in its place's own zone, with that zone's offset. Never move or delete a fixed item: if one can't be kept, say so and let the user decide.
4. Every change is a patch, so the user can undo it. Tell them what you changed in one sentence, and ask only when there is a real choice.
5. Running late for something fixed: say how late, and whether to call ahead (the booking may have a phone number).`,
});
```

`src/core/live/live.js`:

```js
import { meters, keep, fixOf, kmText, KEEP_M } from './geo.js';
import { ActivityTracker } from './activity.js';
import { TRIGGERS } from './triggers.js';
import { PLAN, planWatches } from './plan-watches.js';
import { readWatches, saveWatch, removeWatch, newWatchId, expired, watchPath, WATCH_FILE } from './watches.js';
import { DRIVING, REPLANNING } from './skills.js';
import { realClock } from './clock.js';
import { readAppSettings, updateAppSettings } from '../settings.js';
import { logEvent } from '../events.js';
import { ME, listTrips } from '../scopes.js';
import { PLAN_FILE, BOOKING_FILE } from '../plan.js';
import { validZone, deviceZone, isoInZone } from '../time.js';
import { validate } from '../schema.js';
import { tsv } from '../tsv.js';

/**
 * Live mode (spec §11): where the user is and what they are doing, the watches and the plan's own
 * reminders, and reminders that work without a model (§11.3, §17). The core never touches the DOM
 * (§3): sensors are registry items of kind "sensor", so the phone's sensors and a simulation
 * (§13, §18) are interchangeable.
 * @typedef {import('./geo.js').Fix} Fix
 * @typedef {import('./triggers.js').TriggerType & { pluginId?: string }} TriggerType
 * @typedef {import('./triggers.js').Moment} Moment
 * @typedef {import('./triggers.js').Firing} Firing
 * @typedef {import('./watches.js').Watch} Watch
 * @typedef {{ scope: string, watch: Watch, type: TriggerType, firing: Firing, late: number, away?: 'start' | 'shown', fallback: string }} Fired
 *   late: minutes after it came due, in a catch-up; away: how annai was away then
 * @typedef {{ watch: string, text: string }} Reminder
 * @typedef {{ target: string | null, wake: (w: any) => Promise<void>, remind: (list: Reminder[], scope?: string) => Promise<void>,
 *   on: (kind: 'event', fn: (e: any) => void) => () => void }} AgentLike  the Agent, as live mode uses it
 * @typedef {{ kind: 'location' | 'visibility' | 'connectivity', start: (emit: (x: any) => void) => (() => void) | void }} Sensor
 *   location emits { lat, lng, accuracy, speed?, heading? }, or { error: 'denied' | 'unavailable', message };
 *   visibility emits true or false; connectivity true (online) or false
 */

/** A stop: staying within this many meters of where it began. */
export const STOP_M = 100;
/** A position this old no longer says where the user is. */
export const FRESH_MS = 10 * 60_000;
/** While live, the clock looks again at least this often (arrival estimates change with time). */
export const RECHECK_MS = 60_000;
const NEAR_M = 2000;
const MIN = 60_000;
/** @param {number} x */
const round6 = (x) => Math.round(x * 1e6) / 1e6;

export class Live {
  /** Live mode is on (spec §11.1). */
  on = false;
  /** @type {Fix | null} the last position */
  fix = null;
  /** @type {import('./activity.js').Activity} */
  activity = 'unknown';
  /** km travelled while walking or moving fast */
  odometer = 0;
  /** @type {import('./triggers.js').Stop | null} where the user has stayed, and since when */
  stop = null;
  /** @type {'off' | 'waiting' | 'ok' | 'denied' | 'unavailable'} */
  gps = 'off';
  /** What the GPS said when it failed. */
  gpsMessage = '';
  /** annai is on screen. */
  shown = true;
  /** The phone has a connection. */
  online = true;
  /** Name a point for the now block, besides the plan's places (the offline pack adds one). @type {((p: { lat: number, lng: number }) => { name: string, m: number } | null)[]} */
  namers = [];
  #tracker = new ActivityTracker();
  /** @type {Fix | null} the last location point kept (spec §4.5) */
  #kept = null;
  /** @type {Fix | null} where the odometer last counted from */
  #odo = null;
  /** @type {string | null | undefined} the trip whose plan is loaded; undefined: none yet */
  #trip = undefined;
  /** @type {Map<string, Watch[]>} by scope */
  #watches = new Map();
  /** @type {Watch[]} the open trip's plan watches */
  #plan = [];
  /** @type {{ name: string, lat: number, lng: number }[]} */
  #places = [];
  /** @type {Map<string, Record<string, any>>} each watch's memory, by scope and id */
  #mem = new Map();
  /** @type {Map<string, { at: number, place: any }>} each watch's last firing, from the log */
  #fired = new Map();
  /** @type {any} */
  #timer = null;
  /** @type {Promise<unknown>} */
  #work = Promise.resolve();
  /** @type {Set<() => void>} */
  #changes = new Set();
  /** @type {Set<() => void>} */
  #activityChanges = new Set();
  /** @type {Set<any>} */
  #sensorsOn = new Set();
  /** @type {Map<any, () => void>} the location sensors running, and how to stop each */
  #gpsOn = new Map();
  /** @type {(() => void)[]} */
  #offs = [];

  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, registry: import('../registry.js').Registry,
   *   agent: AgentLike, clock?: import('./clock.js').Clock, timeZone?: () => string }} c
   */
  constructor({ store, ws, registry, agent, clock = realClock(), timeZone = deviceZone }) {
    this.store = store;
    this.ws = ws;
    this.registry = registry;
    this.agent = agent;
    this.clock = clock;
    this.timeZone = timeZone;
  }

  /** Follows the sensors, the watches and the plan, from the switch as it was left (choice 11). */
  async start() {
    this.on = Boolean((await readAppSettings(this.ws)).live?.on);
    this.#offs.push(
      this.registry.add('live', 'activity', {
        now: () => (this.on ? this.activity : 'unknown'),
        onChange: (/** @type {() => void} */ fn) => {
          this.#activityChanges.add(fn);
          return () => { this.#activityChanges.delete(fn); };
        },
      }),
      this.registry.add('live', 'skill', DRIVING),
      this.registry.add('live', 'skill', REPLANNING),
      this.ws.onChange((c) => this.#changed(c)),
      this.agent.on('event', (e) => this.#heard(e)),
      this.registry.onChange(() => this.#sensors()),
    );
    await this.#run(async () => {
      await this.#loadAll();
      await this.#follow();
      this.#sensors();
      await this.#check();
    });
  }

  /** Stops everything it started. */
  dispose() {
    this.#gpsStop();
    this.#clearTimer();
    for (const off of this.#offs.splice(0)) {
      try {
        off();
      } catch {
        // already gone
      }
    }
  }

  /**
   * The live mode switch (spec §11.1). Turning it on wakes Shiori once, so the driving-companion
   * skill can set its watches (choice 10).
   * @param {boolean} on
   */
  async setLive(on) {
    const changed = await this.#run(async () => {
      if (on === this.on) return false;
      this.on = on;
      await updateAppSettings(this.ws, { live: { on } });
      await logEvent(this.store, this.#scope(), { type: 'state', actor: 'user', data: { live: on ? 'on' : 'off' } }, this.clock.now());
      if (on) {
        if (this.shown) this.#gpsStart();
      } else {
        this.#gpsStop();
        this.#tracker.reset();
        this.activity = 'unknown';
        this.fix = null;
        this.stop = null;
        this.gps = 'off';
        this.gpsMessage = '';
        this.#tellActivity();
      }
      this.#tell();
      await this.#check();
      return true;
    });
    if (changed && on) {
      await this.agent.wake({ kind: 'live', text: 'The user turned live mode on: annai now follows where they are with GPS, and your location watches run. If they may drive or ride, load the driving-companion skill.' });
    }
  }

  /** A position from a location sensor, a simulation, or the user. @param {any} raw */
  fixed(raw) {
    this.#bg(() => this.#onFix(raw));
  }

  /** The app went off screen, or came back (spec §11.1). @param {boolean} v */
  visible(v) {
    this.#bg(() => this.#onVisible(v));
  }

  /** The connection came or went. @param {boolean} v */
  connected(v) {
    this.#bg(() => this.#onConnected(v));
  }

  /** Where the user says they are, when there is no GPS (spec §17: "a manual place"). @param {{ lat: number, lng: number, name?: string }} p */
  place(p) {
    return this.#run(() => this.#onFix({ lat: p.lat, lng: p.lng, accuracy: 50, source: 'manual' }));
  }

  /** Settles once nothing is left to check. */
  async settled() {
    /** @type {Promise<unknown>} */
    let w;
    do {
      w = this.#work;
      await w;
    } while (w !== this.#work);
  }

  /** Hears when the position, the activity, the GPS or the switch change. @param {() => void} fn @returns {() => void} */
  onChange(fn) {
    this.#changes.add(fn);
    return () => { this.#changes.delete(fn); };
  }

  /** The trigger types: the built-in ones, then plugins' (spec §11.3: "Plugins can add types"). @returns {Map<string, TriggerType>} */
  types() {
    /** @type {Map<string, TriggerType>} */
    const out = new Map(TRIGGERS.map((t) => [t.type, t]));
    for (const e of this.registry.entries('trigger')) {
      const t = e.item;
      if (!t || typeof t.type !== 'string' || typeof t.check !== 'function' || out.has(t.type) || t.type === 'plan') continue;
      out.set(t.type, { gps: false, summary: t.type, validate: () => null, describe: () => t.type, ...t, pluginId: e.pluginId });
    }
    return out;
  }

  /**
   * Sets a watch (spec §7.2 watch.set), or throws an Error that says, in plain words, what is wrong.
   * @param {string} scope the conversation's: a trip, or "me" @param {any} i { when, fallback, repeat?, expires? } @param {string} [owner]
   * @returns {Promise<Watch>}
   */
  async setWatch(scope, i, owner = 'shiori') {
    const types = this.types();
    const when = i?.when;
    const type = typeof when?.type === 'string' ? types.get(when.type) : undefined;
    if (!type) throw new Error(`when.type must be one of: ${[...types.keys()].join(', ')}.`);
    const wrong = type.validate(when);
    if (wrong) throw new Error(`A ${type.type} watch: ${wrong}.`);
    const fallback = typeof i.fallback === 'string' ? i.fallback.trim() : '';
    if (!fallback) throw new Error("Every watch needs a fallback: the words annai shows, and says with voice on, by itself when it fires and you can't be reached.");
    const now = this.clock.now();
    if (i.expires !== undefined && validate({ type: 'string', format: 'date-time' }, i.expires).length) throw new Error('expires must be an ISO date-time with an offset, like 2026-11-27T18:00:00-08:00.');
    if (i.expires !== undefined && Date.parse(i.expires) <= now) throw new Error(`expires ${i.expires} has already passed.`);
    if (type.type === 'time' && Date.parse(when.at) <= now) throw new Error(`${when.at} has already passed. Give a time ahead.`);
    /** @type {Watch} */
    const w = {
      id: newWatchId(), owner, when: { ...when }, repeat: type.type === 'every' || (type.type !== 'time' && i.repeat === true),
      fallback: fallback.slice(0, 500), ...(i.expires ? { expires: i.expires } : {}), created: new Date(now).toISOString(),
    };
    return this.#run(async () => {
      await saveWatch(this.ws, scope, w, owner);
      const stored = { ...w, path: watchPath(w.id) };
      this.#watches.set(scope, [...(this.#watches.get(scope) ?? []).filter((x) => x.id !== w.id), stored]);
      const m = this.#moment();
      this.#memFor(type, stored, scope, m); // it starts from where the user is now: set while inside, enter doesn't fire
      this.#schedule(m);
      return w;
    });
  }

  /** watch_set's result: what was set, and how things stand. @param {Watch} w */
  watchText(w) {
    const type = this.types().get(w.when.type);
    const parts = [`Set ${w.id}: ${type ? type.describe(w.when) : w.when.type}${w.repeat ? ', every time' : ''}${w.expires ? `, until ${w.expires}` : ''}.`];
    if (type?.gps && !this.on) parts.push('Live mode is off, so it waits until the user turns it on.');
    const here = this.nowInfo();
    parts.push(`Now: ${here.activity}; ${here.place}.`);
    return parts.join(' ');
  }

  /** The watches of a conversation, hers and (for the open trip) the plan's, as TSV (spec §7.2 watch.list). @param {string} scope */
  async listWatches(scope) {
    await this.settled();
    const types = this.types();
    const rows = [];
    for (const w of this.#watches.get(scope) ?? []) {
      const type = types.get(w.when.type);
      rows.push([w.id, w.owner, type ? type.describe(w.when) : `${w.when.type} (its trigger type isn't installed)`, w.repeat ? 'yes' : 'no', w.fallback, w.expires ?? '', this.#lastFired(scope, w.id)]);
    }
    if (scope === this.#scope()) for (const w of this.#plan) rows.push([w.id, 'system', PLAN.describe(w.when), w.repeat ? 'yes' : 'no', w.fallback, '', this.#lastFired(scope, w.id)]);
    return rows.length ? tsv(['id', 'owner', 'when', 'repeat', 'reminder', 'expires', 'last_fired'], rows) : 'No watches.';
  }

  /** Cancels one of her watches (spec §7.2 watch.cancel). @param {string} scope @param {string} id @returns {Promise<string>} */
  async cancelWatch(scope, id) {
    if (String(id).startsWith('plan:')) throw new Error(`${id} is one of the plan's own reminders: it follows the plan. Change or remove the plan item instead.`);
    return this.#run(async () => {
      const w = (this.#watches.get(scope) ?? []).find((x) => x.id === id);
      if (!w) throw new Error(`There is no watch ${id} here. watch_list shows them.`);
      await this.#drop(scope, w, 'shiori');
      return `Cancelled ${id}.`;
    });
  }

  /** The now block's place and activity (spec §6.3). Nothing is sent anywhere to name a place (choice 14). */
  nowInfo() {
    if (!this.on) return { place: 'unknown (live mode is off, so annai has no GPS)', activity: 'unknown (live mode is off)' };
    const activity = this.#activityText();
    const f = this.fix;
    if (!f) {
      const why = this.gps === 'denied' ? 'location permission is off' : this.gps === 'unavailable' ? 'no GPS signal' : 'waiting for GPS';
      return { place: `unknown (${why})`, activity };
    }
    const near = this.near(f);
    const age = this.clock.now() - f.at;
    const how = [`±${Math.round(f.accuracy)} m`, f.source === 'manual' ? 'set by the user' : age >= 2 * MIN ? `${Math.round(age / MIN)} min ago` : ''].filter(Boolean).join(', ');
    return { place: `${near ? `near ${near.name} (${kmText(near.m)})` : 'no plan place nearby'} · ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)} (${how})`, activity };
  }

  /** The nearest named place within reach of p: the plan's, or a namer's. @param {{ lat: number, lng: number }} p */
  near(p, within = NEAR_M) {
    /** @type {{ name: string, m: number } | null} */
    let best = null;
    for (const q of this.#places) {
      const d = meters(p, q);
      if (d <= within && (!best || d < best.m)) best = { name: q.name, m: d };
    }
    for (const n of this.namers) {
      try {
        const r = n(p);
        if (r && r.m <= within && (!best || r.m < best.m)) best = r;
      } catch {
        // a namer that fails names nothing
      }
    }
    return best;
  }

  /** @returns {string} */
  #activityText() {
    const a = this.activity === 'moving-fast' ? 'moving fast' : this.activity;
    const v = this.#tracker.speed;
    return (this.activity === 'walking' || this.activity === 'moving-fast') && v !== null ? `${a}, about ${Math.round(v * 3.6)} km/h` : a;
  }

  /** The conversation open now: the trip's, or "me". */
  #scope() {
    return this.agent.target ?? ME;
  }

  /** @param {string} scope @param {string} id */
  #key(scope, id) {
    return `${scope}\n${id}`;
  }

  /** @param {string} scope @param {string} id */
  #lastFired(scope, id) {
    const f = this.#fired.get(this.#key(scope, id));
    return f ? isoInZone(f.at, this.timeZone()) : '';
  }

  /** Runs one piece of work after the others; its result, or its error, is the caller's. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  #run(fn) {
    const job = this.#work.then(fn);
    this.#work = job.catch((e) => console.warn('live mode: a check failed', e));
    return job;
  }

  /** Work nobody waits for (a sensor's news). @param {() => Promise<unknown>} fn */
  #bg(fn) {
    this.#run(fn).catch(() => {});
  }

  #tell() {
    for (const fn of this.#changes) {
      try {
        fn();
      } catch (e) {
        console.warn('a live mode listener failed', e);
      }
    }
  }

  #tellActivity() {
    for (const fn of this.#activityChanges) {
      try {
        fn();
      } catch (e) {
        console.warn('an activity listener failed', e);
      }
    }
  }

  /** Starts the visibility and connectivity sensors once each, and the location ones while live and on screen. */
  #sensors() {
    for (const s of this.registry.list('sensor')) {
      if (this.#sensorsOn.has(s) || (s?.kind !== 'visibility' && s?.kind !== 'connectivity') || typeof s.start !== 'function') continue;
      this.#sensorsOn.add(s);
      try {
        const off = s.start((/** @type {any} */ v) => (s.kind === 'visibility' ? this.visible(Boolean(v)) : this.connected(Boolean(v))));
        if (typeof off === 'function') this.#offs.push(off);
      } catch (e) {
        console.warn('a sensor did not start', e);
      }
    }
    if (this.on && this.shown) this.#gpsStart();
  }

  #gpsStart() {
    for (const s of this.registry.list('sensor')) {
      if (s?.kind !== 'location' || this.#gpsOn.has(s) || typeof s.start !== 'function') continue;
      if (this.gps !== 'ok') this.gps = 'waiting';
      try {
        const off = s.start((/** @type {any} */ x) => (x && typeof x === 'object' && 'error' in x ? this.#bg(async () => this.#gpsFailed(x)) : this.fixed(x)));
        this.#gpsOn.set(s, typeof off === 'function' ? off : () => {});
      } catch (e) {
        this.#gpsFailed({ error: 'unavailable', message: String(/** @type {any} */ (e)?.message ?? e) });
      }
    }
  }

  #gpsStop() {
    for (const off of this.#gpsOn.values()) {
      try {
        off();
      } catch {
        // already stopped
      }
    }
    this.#gpsOn.clear();
  }

  /** @param {{ error: string, message?: string }} x */
  #gpsFailed(x) {
    this.gps = x.error === 'denied' ? 'denied' : 'unavailable';
    this.gpsMessage = String(x.message ?? '');
    this.#tell();
  }

  /** @param {any} raw */
  async #onFix(raw) {
    if (!this.on || !this.shown) return;
    const fix = fixOf(raw, this.clock.now());
    if (!fix) return;
    await this.#follow();
    /** @type {{ from: string, to: string } | null} */
    let change = null;
    if (fix.source !== 'manual') {
      this.gps = 'ok';
      const c = this.#tracker.feed(fix);
      if (c) {
        change = { from: c.from, to: c.to };
        this.activity = c.to;
      }
    }
    if (!this.stop || meters(this.stop, fix) > Math.max(STOP_M, fix.accuracy)) this.stop = { lat: fix.lat, lng: fix.lng, since: fix.at };
    const moving = this.activity === 'walking' || this.activity === 'moving-fast';
    if (keep(this.#kept, fix, moving)) {
      this.#kept = fix;
      if (this.#trip) await logEvent(this.store, this.#trip, { type: 'location', actor: 'system', data: pointData(fix) }, fix.at);
    }
    // The odometer counts only while moving, so GPS jitter at a stop adds nothing (choice 13).
    if (!this.#odo) this.#odo = fix;
    else if (moving && fix.accuracy <= 100 && meters(this.#odo, fix) >= Math.max(KEEP_M, fix.accuracy)) {
      this.odometer += meters(this.#odo, fix) / 1000;
      this.#odo = fix;
    }
    this.fix = fix;
    if (change) this.#tellActivity();
    this.#tell();
    await this.#check({ newFix: true, change });
  }

  /** @param {boolean} v */
  async #onVisible(v) {
    if (v === this.shown) return;
    this.shown = v;
    if (!v) {
      // Off screen nothing is evaluated (spec §11.1, choice 15).
      this.#gpsStop();
      this.#clearTimer();
      this.#tell();
      return;
    }
    if (this.on) this.#gpsStart();
    this.#tell();
    await this.#check();
  }

  /** @param {boolean} v */
  async #onConnected(v) {
    if (v === this.online) return;
    this.online = v;
    this.#tell();
  }

  /** A wake of hers: moved counts again from here (spec §11.3: "X km travelled since the last wake"). @param {any} e */
  #heard(e) {
    if (e?.type !== 'wake' || e.data?.meanwhile) return;
    const prefix = `${e.scope ?? this.#scope()}\n`;
    for (const [key, mem] of this.#mem) if (key.startsWith(prefix)) mem.km0 = this.odometer;
  }

  /** A watch or the plan changed on disk. @param {{ scope: string, path: string }} c */
  #changed(c) {
    if (WATCH_FILE.test(c.path)) {
      this.#bg(async () => {
        await this.#loadScope(c.scope);
        await this.#check();
      });
    } else if (c.scope === this.#trip && (PLAN_FILE.test(c.path) || BOOKING_FILE.test(c.path))) {
      this.#bg(async () => {
        await this.#loadPlan();
        await this.#check();
      });
    }
  }

  /** Another conversation opened: its plan, and everyone's watches afresh. */
  async #follow() {
    const trip = this.agent.target;
    if (trip === this.#trip) return;
    const first = this.#trip === undefined;
    this.#trip = trip;
    this.#kept = null;
    this.stop = null;
    if (!first) await this.#loadAll();
    await this.#loadPlan();
  }

  /** Every conversation's watches, and what has fired. */
  async #loadAll() {
    const { active } = await listTrips(this.store);
    const scopes = [ME, ...active.map((s) => s.id)];
    this.#watches.clear();
    for (const scope of scopes) {
      await this.#loadScope(scope);
      for (const e of await this.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['trigger.fired'] }))) {
        this.#fired.set(this.#key(scope, String(e.data?.watch)), { at: e.ts, place: e.data?.place ?? null });
      }
    }
  }

  /** @param {string} scope */
  async #loadScope(scope) {
    const { watches } = await readWatches(this.ws, scope);
    if (watches.length) this.#watches.set(scope, watches);
    else this.#watches.delete(scope);
  }

  /** The open trip's plan, as the plan's own watches. */
  async #loadPlan() {
    const trip = this.#trip;
    this.#plan = [];
    this.#places = [];
    if (!trip) return;
    /** @type {{ path: string, item: any }[]} */
    const items = [];
    /** @type {Map<string, any>} */
    const bookings = new Map();
    for (const f of await this.ws.list(trip, '/plan/')) {
      if (!PLAN_FILE.test(f.path)) continue;
      const item = await this.ws.readJSON(trip, f.path).catch(() => null);
      if (item && typeof item === 'object') items.push({ path: f.path, item });
    }
    for (const f of await this.ws.list(trip, '/bookings/')) {
      if (!BOOKING_FILE.test(f.path)) continue;
      const b = await this.ws.readJSON(trip, f.path).catch(() => null);
      if (b && typeof b === 'object') bookings.set(f.path, b);
    }
    const info = await this.ws.readJSON(trip, '/trip.json').catch(() => null);
    const fallbackTz = [info?.timezones?.[0], this.timeZone()].find(validZone) ?? 'UTC';
    this.#plan = planWatches(items, bookings, { fallbackTz });
    for (const { item } of items) {
      const p = item.place;
      if (p && typeof p.lat === 'number' && typeof p.lng === 'number') this.#places.push({ name: String(p.name ?? item.title ?? 'a plan place'), lat: p.lat, lng: p.lng });
    }
  }

  /** The moment checks see. @param {{ newFix?: boolean, change?: { from: string, to: string } | null }} [o] @returns {Moment} */
  #moment(o = {}) {
    const now = this.clock.now();
    const f = this.fix;
    const fix = this.on && f && (f.source === 'manual' || now - f.at <= FRESH_MS) ? f : null;
    const scope = this.#scope();
    return {
      now, fix, newFix: Boolean(o.newFix) && Boolean(fix), past: false, live: this.on, activity: this.on ? this.activity : 'unknown', change: o.change ?? null,
      odometer: this.odometer, stop: this.on ? this.stop : null, gap: null, fired: (id) => this.#fired.has(this.#key(scope, id)),
    };
  }

  /** The watch's memory, made the first time it is seen (spec §11.3: it starts from now). @param {TriggerType} type @param {Watch} w @param {string} scope @param {Moment} m */
  #memFor(type, w, scope, m) {
    const key = this.#key(scope, w.id);
    let mem = this.#mem.get(key);
    if (mem) return mem;
    const last = this.#fired.get(key);
    mem = { set: Date.parse(w.created ?? '') || m.now, lastAt: last?.at ?? null, lastPlace: last?.place ?? null, km0: this.odometer };
    this.#mem.set(key, mem);
    try {
      type.start?.(w.when, m, mem);
    } catch {
      // a type that can't start just waits
    }
    return mem;
  }

  /** One check of one watch; a plugin's trigger that throws counts against its plugin (spec §5.5). @param {TriggerType} type @param {Watch} w @param {string} scope @param {Moment} m */
  #try(type, w, scope, m) {
    const mem = this.#memFor(type, w, scope, m);
    try {
      return type.check(w.when, m, mem) ?? null;
    } catch (e) {
      if (type.pluginId) this.registry.fail(type.pluginId, `trigger ${type.type}`, e);
      else console.warn(`the trigger ${type.type} failed`, e);
      return null;
    }
  }

  /** Whether a watch is looked at now: its conversation's, live mode for GPS, and time watches anywhere (choices 2 and 3). @param {TriggerType | undefined} type @param {string} scope */
  #looked(type, scope) {
    return Boolean(type) && !(type?.gps && !this.on) && (scope === this.#scope() || type?.type === 'time');
  }

  /** Looks at every watch now (spec §11.3), fires what is due as one wake, and sets the clock for the next. @param {{ newFix?: boolean, change?: { from: string, to: string } | null }} [o] */
  async #check(o = {}) {
    await this.#follow();
    const m = this.#moment(o);
    const open = this.#scope();
    const types = this.types();
    /** @type {Fired[]} */
    const fired = [];
    for (const [scope, list] of [...this.#watches]) {
      for (const w of [...list]) {
        if (expired(w, m.now)) {
          await this.#drop(scope, w);
          continue;
        }
        const type = types.get(w.when?.type);
        if (!type || !this.#looked(type, scope)) continue;
        const f = this.#try(type, w, scope, m);
        if (f) fired.push(this.#firedOf(scope, w, type, f, m.now));
      }
    }
    for (const w of this.#plan) {
      if (!w.repeat && this.#fired.has(this.#key(open, w.id))) continue;
      const f = this.#try(PLAN, w, open, m);
      if (f) fired.push(this.#firedOf(open, w, PLAN, f, m.now));
    }
    if (fired.length) await this.#fire(fired, m.now);
    this.#schedule(m);
  }

  /** @param {string} scope @param {Watch} watch @param {TriggerType} type @param {Firing} firing @param {number} now @returns {Fired} */
  #firedOf(scope, watch, type, firing, now) {
    return { scope, watch, type, firing, late: 0, fallback: firing.fallback ?? watch.fallback };
  }

  /** Logs each firing, then wakes Shiori: one wake a conversation (spec §6.1). @param {Fired[]} list @param {number} now */
  async #fire(list, now) {
    const open = this.#scope();
    /** @type {Fired[]} */
    const done = [];
    for (const x of list) {
      if (x.scope !== open && !(await this.#exists(x.scope))) {
        this.#watches.delete(x.scope); // a trip that was removed: nothing more goes into it (spec §4.9)
        continue;
      }
      const key = this.#key(x.scope, x.watch.id);
      const f = x.firing;
      await logEvent(this.store, x.scope, {
        type: 'trigger.fired', actor: 'system',
        data: {
          watch: x.watch.id, type: x.watch.when.type, ...(x.watch.when.event ? { event: x.watch.when.event } : {}), owner: x.watch.owner, text: f.text, fallback: x.fallback,
          ...(x.late ? { late: x.late } : {}), ...(f.place ? { place: f.place } : {}),
        },
      }, now);
      this.#fired.set(key, { at: now, place: f.place ?? null });
      const mem = this.#mem.get(key);
      if (mem) {
        mem.lastAt = now;
        mem.km0 = this.odometer;
        if (f.place) mem.lastPlace = f.place;
      }
      if (x.watch.owner !== 'system' && (x.watch.when.type === 'time' || (!x.watch.repeat && x.watch.when.type !== 'every'))) await this.#drop(x.scope, x.watch);
      done.push(x);
    }
    if (done.length) await this.#deliver(done);
  }

  /**
   * Wakes Shiori for what fired. In another conversation (a time watch of a trip that isn't open):
   * its reminders now, and the wake written into it for when it opens (choice 3).
   * @param {Fired[]} list @param {'trigger' | 'catch-up'} [kind] @param {string} [header]
   */
  async #deliver(list, kind = 'trigger', header = '') {
    const open = this.#scope();
    /** @type {Map<string, Fired[]>} */
    const by = new Map();
    for (const x of list) by.set(x.scope, [...(by.get(x.scope) ?? []), x]);
    for (const [scope, xs] of by) {
      const reasons = xs.map((x) => this.#reason(x));
      const fallbacks = xs.map((x) => ({ watch: x.watch.id, text: x.fallback }));
      if (scope !== open) {
        await this.agent.remind(fallbacks, scope);
        await this.agent.wake({ kind, text: reasons.join(' '), scope });
        continue;
      }
      await this.agent.wake({ kind, text: [header, ...reasons].filter(Boolean).join(' '), fallbacks });
    }
  }

  /** What fired, in words for Shiori's wake. @param {Fired} x */
  #reason(x) {
    const late = x.late ? ` (late by ${x.late} min: annai was off screen)` : '';
    if (x.watch.owner === 'system') return `${x.firing.text}${late}.`;
    const whose = x.watch.owner === 'shiori' ? 'Your watch' : `The watch of ${x.watch.owner}`;
    return `${whose} ${x.watch.id} (${x.type.describe(x.watch.when)}) fired: ${x.firing.text}${late}. Its reminder: "${x.watch.fallback}"`;
  }

  /** @param {string} scope */
  async #exists(scope) {
    return scope === ME || Boolean(await this.store.tx(['scopes'], 'readonly', (t) => t.getScope(scope)));
  }

  /** Removes a watch: fired once, cancelled, or expired. @param {string} scope @param {Watch} w */
  async #drop(scope, w, author = 'system') {
    this.#watches.set(scope, (this.#watches.get(scope) ?? []).filter((x) => x.id !== w.id));
    this.#mem.delete(this.#key(scope, w.id));
    if (await this.#exists(scope)) await removeWatch(this.ws, scope, w, author);
  }

  /** One timer, for the next due watch (spec §11.2); while live, at least once a minute. Off screen, none. @param {Moment} m */
  #schedule(m) {
    this.#clearTimer();
    if (!this.shown) return;
    let next = this.on ? m.now + RECHECK_MS : Infinity;
    const consider = (/** @type {number | null | undefined} */ t) => {
      if (typeof t === 'number' && Number.isFinite(t) && t > m.now && t < next) next = t;
    };
    const types = this.types();
    const open = this.#scope();
    for (const [scope, list] of this.#watches) {
      for (const w of list) {
        if (w.expires) consider(Date.parse(w.expires));
        const type = types.get(w.when?.type);
        const mem = this.#mem.get(this.#key(scope, w.id));
        if (!type?.next || !mem || !this.#looked(type, scope)) continue;
        try {
          consider(type.next(w.when, m, mem));
        } catch {
          // a type that can't say when waits for the next fix
        }
      }
    }
    for (const w of this.#plan) {
      const mem = this.#mem.get(this.#key(open, w.id));
      if (mem && (w.repeat || !this.#fired.has(this.#key(open, w.id)))) consider(PLAN.next?.(w.when, m, mem));
    }
    if (next === Infinity) return;
    this.#timer = this.clock.set(() => {
      this.#timer = null;
      this.#bg(() => this.#check());
    }, next - m.now);
  }

  #clearTimer() {
    if (this.#timer !== null) this.clock.clear(this.#timer);
    this.#timer = null;
  }
}

/** A location point as the log keeps it (spec §4.5). @param {Fix} f */
function pointData(f) {
  return {
    lat: round6(f.lat), lng: round6(f.lng), accuracy: Math.round(f.accuracy),
    ...(f.speed !== null ? { speed: Math.round(f.speed * 10) / 10 } : {}), ...(f.heading !== null ? { heading: Math.round(f.heading) } : {}),
    ...(f.source !== 'gps' ? { source: f.source } : {}),
  };
}
```

In `sw.js` `SHELL`, add `'/src/core/live/clock.js'`, `'/src/core/live/live.js'` and `'/src/core/live/skills.js'` in alphabetical order with the other `src/core/live` files.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/live-engine.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/live/clock.js src/core/live/skills.js src/core/live/live.js test/unit/live-kit.js test/unit/live-engine.test.js sw.js && git commit -m "Live mode's engine: GPS fixes in, kept location points, the activity for voice Auto, watches and the plan's reminders firing as one wake, one timer for the next (spec §11.1–§11.3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 5: Catch-up, and reminders with no connection

**Files:**
- Modify: `src/core/live/live.js`, `test/unit/live-engine.test.js` (its off-screen test now waits for the catch-up)
- Test: `test/unit/live-catch-up.test.js`

**Interfaces:**
- Consumes: Task 4's `Live`, the kit.
- Produces:
  - Coming back on screen (`visible(true)`), and starting (`start()`): a catch-up (spec §11.4). First a look from where the user was when annai went away (`Moment.past`): what the clock made due fires, labelled late. Then, with the first fix (or after `FIX_WAIT_MS = 15_000` without one), a look from where they are now: entering, leaving and arriving are inferred, and `moved` counts the distance. Everything goes into one wake `{ kind: 'catch-up', text: 'Catch-up: annai was off screen for 47 min (since 15:18), and the user moved 17.0 km. …', fallbacks }`; none when nothing fired (choice 12).
  - Firings during a catch-up are logged with `catchUp: true` and `late` (minutes, when 2 or more after they came due).
  - With no connection (`connected(false)`): each firing's reminders go to `agent.remind()` at once and are logged with `offline: true`; the wakes are held. Back online, one wake per conversation: `{ kind: 'trigger', text: 'While there was no connection (for 3 h, since 08:30), these came, and annai showed their reminders by itself: …', fallbacks: [] }`.
  - `LATE_MS = 120_000`, `FIX_WAIT_MS`.

- [ ] **Step 1: Write the failing test**

In `test/unit/live-engine.test.js`, the last test's end becomes (coming back on screen is a catch-up now, which waits for a fix):

```js
  k.sensors.visible(true);
  await k.settle();
  assert.equal(k.sensors.gpsOn(), true);
  assert.equal(k.agent.wakes.length, 0); // the catch-up waits for a fix, at most 15 s
  await k.to(at('10:05:15'));
  assert.deepEqual(k.agent.wakes.map((w) => w.kind), ['catch-up']);
});
```

`test/unit/live-catch-up.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, fakeAgent, fakeSensors, at, iso, off, LA, MONTEREY, BIXBY, RIVER_INN, NEPENTHE } from './live-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';

const NEP = { title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, end: { at: iso('13:15'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };
const BIX = { title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } };

test('back on screen: a time watch that came due fires late and labelled, with moved, in one catch-up wake with the time away and the distance (spec §11.4)', async () => {
  const k = await liveKit();
  const tea = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.live.setWatch(k.trip, { when: { type: 'moved', km: 10 }, repeat: true, fallback: 'Narrate.' });
  await k.drive(MONTEREY, off(MONTEREY, 0, -2000), at('09:40'), at('09:42'));
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('10:30'));
  assert.equal(k.agent.wakes.length, 0);
  k.sensors.visible(true);
  await k.settle();
  assert.equal(k.agent.wakes.length, 0); // waiting for a fix
  await k.fix(at('10:30:05'), off(MONTEREY, 0, -20_000), { speed: 15 });
  assert.equal(k.agent.wakes.length, 1);
  const w = k.agent.wakes[0];
  assert.equal(w.kind, 'catch-up');
  assert.ok(w.text.startsWith('Catch-up: annai was off screen for 48 min (since 09:42), and the user moved 18.0 km. '), w.text);
  assert.ok(w.text.includes(`Your watch ${tea.id} (at ${iso('10:00')}) fired: the time came: ${iso('10:00')} (late by 30 min: annai was off screen). Its reminder: "Tea time."`), w.text);
  assert.match(w.text, /fired: you have travelled 20\.\d km since your last wake\. Its reminder: "Narrate\."$/);
  assert.deepEqual(w.fallbacks.map((/** @type {any} */ f) => f.text), ['Tea time.', 'Narrate.']);
  assert.deepEqual((await k.events(['trigger.fired'])).map((e) => [e.data.late ?? 0, e.data.catchUp]), [[30, true], [0, true]]);
});

test("leaving is inferred from where the user was against where they are; the plan's leave reminder that came due while away fires late", async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  await k.stay(BIXBY, at('10:50'), at('10:51'));
  const bye = await k.live.setWatch(k.trip, { when: { type: 'leave', lat: BIXBY.lat, lng: BIXBY.lng, name: 'Bixby Bridge' }, fallback: 'Bye, Bixby.' });
  await k.stay(BIXBY, at('10:51:10'), at('10:52'));
  const before = k.agent.wakes.length; // arrived at Bixby, 2 min after stopping
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('11:40'));
  k.sensors.visible(true);
  await k.settle();
  await k.fix(at('11:40:05'), RIVER_INN);
  assert.equal(k.agent.wakes.length, before + 1);
  const w = k.agent.wakes.at(-1);
  assert.equal(w.kind, 'catch-up');
  assert.ok(w.text.startsWith('Catch-up: annai was off screen for 48 min (since 10:52), and the user moved 14.1 km from near Bixby Creek Bridge. '), w.text);
  assert.ok(w.text.includes('Plan: time to leave soon for "Lunch at Nepenthe" (fixed, 12:00): 21.2 km away in a straight line, about 36 min by car (late by 31 min: annai was off screen).'), w.text);
  assert.ok(w.text.includes(`Your watch ${bye.id} (on leaving Bixby Bridge (200 m)) fired: you left Bixby Bridge, now 14.1 km away. Its reminder: "Bye, Bixby."`), w.text);
});

test('arriving is inferred on coming back inside a plan place', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  await k.drive(RIVER_INN, off(RIVER_INN, 0, -500), at('11:40'), at('11:41'));
  const before = k.agent.wakes.length; // the leave reminder came at 11:40
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('11:55'));
  k.sensors.visible(true);
  await k.settle();
  await k.fix(at('11:55:05'), NEPENTHE);
  assert.equal(k.agent.wakes.length, before + 1);
  assert.ok(k.agent.wakes.at(-1).text.endsWith('Plan: you arrived at Nepenthe for "Lunch at Nepenthe" (fixed, 12:00), inferred on coming back on screen.'));
});

test('nothing came due while away: no wake (choice 12); no fix comes back: the catch-up goes after 15 s with what the clock made due', async () => {
  const k = await liveKit();
  await k.fix(at('09:00'), MONTEREY);
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('09:30'));
  k.sensors.visible(true);
  await k.settle();
  await k.fix(at('09:30:05'), MONTEREY);
  assert.equal(k.agent.wakes.length, 0);
  assert.equal(k.clock.pending, 1); // only the minute's look
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Ten.' });
  await k.to(at('09:50'));
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('10:10'));
  k.sensors.visible(true);
  await k.settle();
  assert.equal(k.agent.wakes.length, 0);
  await k.to(at('10:10:15'));
  assert.equal(k.agent.wakes.length, 1);
  assert.ok(k.agent.wakes[0].text.startsWith('Catch-up: annai was off screen for 20 min (since 09:50). Your watch'), k.agent.wakes[0].text);
});

test('after a restart: an overdue time watch fires late, an every watch once (not twenty times), nothing for a plan item long past; the distance from the last point counts', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  const once = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('09:00') }, fallback: 'Nine.' });
  const every = await k.live.setWatch(k.trip, { when: { type: 'every', minutes: 30 }, fallback: 'Half hour.' });
  await k.fix(at('08:31'), MONTEREY);
  k.live.dispose();
  // annai is closed until 18:30, then starts again
  const clock = new ManualClock(at('18:30'));
  const agent = fakeAgent(k.trip);
  const sensors = fakeSensors(k.registry);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent, clock, timeZone: () => LA });
  await live.start();
  await live.settled();
  assert.equal(agent.wakes.length, 0); // live mode was on: it waits for a fix
  sensors.fix({ lat: NEPENTHE.lat, lng: NEPENTHE.lng, accuracy: 8, speed: 0 });
  await live.settled();
  assert.equal(agent.wakes.length, 1);
  const w = agent.wakes[0];
  assert.equal(w.kind, 'catch-up');
  assert.match(w.text, /^Catch-up: annai was closed for 9 h 59 min \(since 08:31\), and the user moved 4\d\.\d km to near Nepenthe\. /);
  assert.ok(w.text.includes(`Your watch ${once.id} (at ${iso('09:00')}) fired: the time came: ${iso('09:00')} (late by 570 min: annai was closed).`));
  assert.ok(w.text.includes(`Your watch ${every.id} (every 30 min) fired: 30 min since you set it (late by 570 min: annai was closed).`));
  assert.ok(!w.text.includes('Nepenthe"'), 'no plan reminder for lunch, long past');
  await clock.advanceTo(at('19:00'), () => live.settled());
  assert.equal(agent.wakes.length, 2); // every goes on from now
  assert.equal(agent.wakes[1].kind, 'trigger');
});

test('with no connection, annai says each reminder at once and holds the wakes; back online, one wake says what came (spec §17, choice 8)', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  const tea = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  k.sensors.online(false);
  await k.settle();
  await k.to(at('10:00'));
  assert.deepEqual(k.agent.reminders, [{ watch: tea.id, text: 'Tea time.', scope: k.trip }]);
  assert.equal(k.agent.wakes.length, 0);
  await k.to(at('11:30')); // no position: the plan reminds half an hour before
  assert.deepEqual(k.agent.reminders.map((r) => r.text), ['Tea time.', 'Leave soon: Lunch at Nepenthe at 12:00.']);
  assert.equal(k.agent.wakes.length, 0);
  k.sensors.online(true);
  await k.settle();
  assert.equal(k.agent.wakes.length, 1);
  assert.equal(k.agent.wakes[0].kind, 'trigger');
  assert.match(k.agent.wakes[0].text, /^While there was no connection \(for 3 h, since 08:30\), these came, and annai showed their reminders by itself: Your watch w-\S+ \(at [^)]+\) fired: the time came: [^.]+\. Its reminder: "Tea time\." Plan: time to leave soon for "Lunch at Nepenthe" \(fixed, 12:00\)\.$/);
  assert.deepEqual(k.agent.wakes[0].fallbacks, []);
  assert.ok((await k.events(['trigger.fired'])).every((e) => e.data.offline === true));
  k.sensors.online(true);
  await k.settle();
  assert.equal(k.agent.wakes.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/live-catch-up.test.js test/unit/live-engine.test.js`
Expected: FAIL: the catch-up tests get no `catch-up` wake (a plain `trigger` wake, or none), the offline test gets wakes instead of reminders, and the engine's off-screen test gets its wake before the fix.

- [ ] **Step 3: Write the implementation**

In `src/core/live/live.js`:

1. Import `span` and `timeIn` too: `import { meters, keep, fixOf, kmText, span, KEEP_M } from './geo.js';` and `import { validZone, deviceZone, isoInZone, timeIn } from '../time.js';`.

2. After `RECHECK_MS`, add:

```js
/** After coming back on screen, catch-up waits this long for a GPS fix (spec §11.4). */
export const FIX_WAIT_MS = 15_000;
/** A firing this long after it came due is labelled late (spec §11.4: "late by N min"). */
export const LATE_MS = 2 * 60_000;
```

3. After the `#offs` field, add:

```js
  /** @type {{ since: number, from: Fix | null } | null} when annai went off screen, and where the user was */
  #away = null;
  /** @type {{ how: 'start' | 'shown', since: number | null, from: Fix | null, fired: Fired[], timer: any } | null} a catch-up collecting what fires (spec §11.4) */
  #catch = null;
  /** @type {{ scope: string, text: string }[]} what fired while there was no connection */
  #held = [];
  /** @type {number | null} when the connection went */
  #offlineSince = null;
```

4. In `start()`, the work becomes:

```js
    await this.#run(async () => {
      await this.#loadAll();
      await this.#follow();
      const last = await this.#lastSeen();
      this.#sensors();
      await this.#catchUp({ ...last, how: 'start' });
    });
```

5. `#onFix` ends with:

```js
    await this.#check({ newFix: true, change });
    if (this.#catch) await this.#endCatchUp(); // the first fix after coming back: the catch-up is complete
  }
```

6. `#onVisible` becomes:

```js
  /** @param {boolean} v */
  async #onVisible(v) {
    if (v === this.shown) return;
    this.shown = v;
    if (!v) {
      // Off screen nothing is evaluated (spec §11.1, choice 15); catch-up covers the gap.
      this.#away = { since: this.clock.now(), from: this.fix };
      this.#gpsStop();
      this.#clearTimer();
      if (this.#catch) await this.#endCatchUp();
      this.#tell();
      return;
    }
    const away = this.#away ?? { since: this.clock.now(), from: this.fix };
    this.#away = null;
    if (this.on) this.#gpsStart();
    this.#tell();
    await this.#catchUp({ ...away, how: 'shown' });
  }
```

7. `#onConnected` becomes:

```js
  /** @param {boolean} v */
  async #onConnected(v) {
    if (v === this.online) return;
    this.online = v;
    if (!v) this.#offlineSince = this.clock.now();
    this.#tell();
    if (!v) return;
    const since = this.#offlineSince ?? this.clock.now();
    this.#offlineSince = null;
    const held = this.#held.splice(0);
    /** @type {Map<string, string[]>} */
    const by = new Map();
    for (const h of held) by.set(h.scope, [...(by.get(h.scope) ?? []), h.text]);
    for (const [scope, texts] of by) {
      const text = `While there was no connection (for ${span(this.clock.now() - since)}, since ${timeIn(since, this.timeZone())}), these came, and annai showed their reminders by itself: ${texts.join(' ')}`;
      await this.agent.wake({ kind: 'trigger', text, fallbacks: [], ...(scope === this.#scope() ? {} : { scope }) });
    }
  }
```

8. Add, after `#onConnected`:

```js
  /** When annai last ran in the open conversation, and the last point it kept (spec §11.4, after a restart). */
  async #lastSeen() {
    const scope = this.#scope();
    const [last] = await this.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { reverse: true, limit: 1 }));
    const [point] = this.#trip ? await this.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['location'], reverse: true, limit: 1 })) : [];
    const from = point ? fixOf({ ...point.data, at: point.ts }, point.ts) : null;
    if (from) {
      this.#kept = from;
      this.#odo = from; // the distance from there counts once the user moves
    }
    return { since: last ? last.ts : null, from };
  }

  /**
   * Catch-up (spec §11.4). First, from where the user was when annai went away, what the clock made
   * due fires late; then, with the first fix (or after FIX_WAIT_MS without one), arriving and
   * leaving are inferred from there against here. Everything goes into one catch-up wake.
   * @param {{ how: 'start' | 'shown', since: number | null, from: Fix | null }} gap
   */
  async #catchUp(gap) {
    if (this.#catch) await this.#endCatchUp();
    const c = { ...gap, fired: /** @type {Fired[]} */ ([]), timer: /** @type {any} */ (null) };
    this.#catch = c;
    await this.#check({ past: true });
    if (this.on && this.shown && this.#gpsOn.size && this.gps !== 'denied') {
      c.timer = this.clock.set(() => {
        this.#bg(async () => {
          if (this.#catch === c) await this.#endCatchUp();
        });
      }, FIX_WAIT_MS);
    } else {
      await this.#endCatchUp();
    }
  }

  async #endCatchUp() {
    const c = this.#catch;
    if (!c) return;
    this.#catch = null;
    if (c.timer !== null) this.clock.clear(c.timer);
    if (c.fired.length) await this.#deliver(c.fired, 'catch-up', this.#catchUpHeader(c));
  }

  /** "Catch-up: annai was off screen for 47 min (since 15:18), and the user moved 17.0 km from near … to near …." @param {NonNullable<typeof this.#catch>} c */
  #catchUpHeader(c) {
    const now = this.clock.now();
    const was = c.how === 'start' ? 'closed' : 'off screen';
    const head = c.since === null ? 'Catch-up: annai has just started' : `Catch-up: annai was ${was} for ${span(now - c.since)} (since ${timeIn(c.since, this.timeZone())})`;
    const moved = c.from && this.fix && this.fix !== c.from ? meters(c.from, this.fix) : 0;
    if (moved < 500 || !c.from || !this.fix) return `${head}.`;
    const a = this.near(c.from);
    const b = this.near(this.fix);
    return `${head}, and the user moved ${kmText(moved)}${a ? ` from near ${a.name}` : ''}${b ? ` to near ${b.name}` : ''}.`;
  }
```

9. `#moment` becomes:

```js
  /** The moment checks see. @param {{ newFix?: boolean, change?: { from: string, to: string } | null, past?: boolean }} [o] @returns {Moment} */
  #moment(o = {}) {
    const now = this.clock.now();
    const c = this.#catch;
    // A catch-up's first look sees where the user was when annai went away (spec §11.4).
    const past = Boolean(o.past) && c !== null;
    const f = past ? c.from : this.fix;
    const fix = this.on && f && (past || f.source === 'manual' || now - f.at <= FRESH_MS) ? f : null;
    const scope = this.#scope();
    return {
      now, fix, newFix: !past && Boolean(o.newFix) && Boolean(fix), past, live: this.on, activity: this.on ? this.activity : 'unknown', change: o.change ?? null,
      odometer: this.odometer, stop: this.on && !past ? this.stop : null, gap: c ? { since: c.since, from: c.from } : null,
      fired: (id) => this.#fired.has(this.#key(scope, id)),
    };
  }
```

and `#check`'s parameter type gains `past?: boolean` (`@param {{ newFix?: boolean, change?: { from: string, to: string } | null, past?: boolean }} [o]`).

10. `#firedOf` becomes:

```js
  /** @param {string} scope @param {Watch} watch @param {TriggerType} type @param {Firing} firing @param {number} now @returns {Fired} */
  #firedOf(scope, watch, type, firing, now) {
    const late = this.#catch && firing.at !== undefined && now - firing.at >= LATE_MS ? Math.round((now - firing.at) / MIN) : 0;
    return { scope, watch, type, firing, late, ...(this.#catch ? { away: this.#catch.how } : {}), fallback: firing.fallback ?? watch.fallback };
  }
```

11. In `#fire`, the logged data gains `...(this.#catch ? { catchUp: true } : {}), ...(this.online ? {} : { offline: true }),` after `...(f.place ? { place: f.place } : {}),`; and its last line becomes:

```js
    if (this.#catch) this.#catch.fired.push(...done);
    else if (done.length) await this.#deliver(done);
```

12. In `#deliver`, after the `if (scope !== open) { … continue; }` block, add:

```js
      const text = [header, ...reasons].filter(Boolean).join(' ');
      if (!this.online) {
        // No connection: annai says the reminders itself now; Shiori hears of them when it is back (spec §17, choice 8).
        await this.agent.remind(fallbacks);
        this.#held.push({ scope, text });
        continue;
      }
      await this.agent.wake({ kind, text, fallbacks });
```

replacing the old last line (`await this.agent.wake({ kind, text: [header, ...reasons].filter(Boolean).join(' '), fallbacks });`).

13. `#reason` labels lateness by how annai was away:

```js
    const late = x.late ? ` (late by ${x.late} min: annai was ${x.away === 'start' ? 'closed' : 'off screen'})` : '';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/live-catch-up.test.js test/unit/live-engine.test.js`
Expected: PASS, 6 and 15 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/live/live.js test/unit/live-catch-up.test.js test/unit/live-engine.test.js sw.js && git commit -m "Catch-up after the phone was locked or annai closed: what came due fires late and labelled, arriving and leaving are inferred, all in one wake; with no connection annai says the reminders itself and Shiori hears later (spec §11.4, §17)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 6: Shiori's side: trigger wakes, reminders without a model, the now block, the Time tools

**Files:**
- Create: `src/core/live/watch-tools.js`
- Modify: `src/core/agent/loop.js` (wake kinds, fallbacks, `remind`, `sense`, housekeeping skips location points), `src/core/agent/transcript.js` (reminders in the transcript; location points and firings left out as it is read), `src/core/voice/voice.js` (an activity sensor that comes later), `src/app/main.js` (the engine in the app), `src/ui/screens/tools.js` (the Go and Time groups), `sw.js` (`SHELL`)
- Test: `test/unit/live-agent.test.js`

**Interfaces:**
- Consumes: Task 4's `Live` (`setWatch`, `watchText`, `listWatches`, `cancelWatch`, `types`, `nowInfo`) and its wakes; Task 5's catch-up and offline wakes.
- Produces:
  - `Wake.kind` gains `'trigger' | 'catch-up' | 'live'`; `Wake.fallbacks?: { watch, text }[]`.
  - `Agent.sense: (() => { place?, activity? }) | null`: the now block's place and activity (spec §6.3).
  - `Agent.remind(list, scope?)`: for each reminder, a `reminder` event (`{ watch, text, aloud? }`) in its conversation, a system card titled "Reminder", and the words said with voice on (spec §11.3, §16.1).
  - The Agent reminds when a turn ends with no model having answered the wakes that carried fallbacks (every model failed, none set, a budget stopped it first); when the hourly limit drops a trigger wake; and when quiet hours hold one (the wake itself waits). Wakes of kind `live` are the user's: no budget holds them.
  - The transcript shows a reminder to Shiori as `[annai] Shown (and said aloud) by annai itself, since you couldn't be reached: "…"`. `Transcript.load` and housekeeping leave out `location` and `trigger.fired` entries (`NOT_SAID`).
  - Voice follows the registry's `activity` item even when it is added after voice started.
  - `watchTools(live)`: `watch_set` (`{ when, fallback, repeat?, expires? }`), `watch_list`, `watch_cancel` (`{ id }`), group `Time`.
  - The app runs one `Live`, with the Time tools and `agent.sense`; `ctx.live` reaches the screens (milestone 5b uses it).

- [ ] **Step 1: Write the failing test**

`test/unit/live-agent.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { fakeSensors, at, iso, off, LA, NEPENTHE } from './live-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { watchTools } from '../../src/core/live/watch-tools.js';
import { readWatches } from '../../src/core/live/watches.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { logEvent } from '../../src/core/events.js';

const sleep = { name: 'sleep', input: {} };
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, sleep] });
const NEP = { id: 'nepenthe', title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, end: { at: iso('13:15'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };

/**
 * agentKit with live mode's engine on a manual clock at 08:30, the Time tools, and the now block's place.
 * @param {any[][]} scripts @param {Parameters<typeof agentKit>[1]} [o]
 */
async function liveAgent(scripts, o = {}) {
  const clock = new ManualClock(at('08:30'));
  const k = await agentKit(scripts, { ...o, agent: { now: clock.now, timeZone: () => LA, ...(o.agent ?? {}) } });
  const sensors = fakeSensors(k.registry);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => LA });
  k.agent.addLoopTools(watchTools(live));
  k.agent.sense = () => live.nowInfo();
  await live.start();
  const settle = async () => {
    let before;
    do {
      before = k.requests.length;
      await live.settled();
      await k.agent.idle();
      await live.settled();
    } while (k.requests.length !== before);
  };
  await settle();
  return { ...k, clock, sensors, live, settle, to: (/** @type {number} */ t) => clock.advanceTo(t, settle) };
}

test('a watch fires and Shiori answers: she is told why, and annai shows no reminder of its own', async () => {
  const k = await liveAgent([[say('Tea time, as you asked.')]]);
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.to(at('10:00'));
  assert.equal(k.requests.length, 1);
  assert.match(k.requests[0].tail, new RegExp(`woke for: Your watch ${w.id} \\(at [^)]+\\) fired: the time came`));
  assert.deepEqual((await k.events(['wake']))[0].data.reasons.map((/** @type {any} */ r) => r.kind), ['trigger']);
  assert.deepEqual(await k.events(['reminder']), []);
  assert.deepEqual(k.notices, []);
});

test("no model can be reached: annai shows the watch's reminder, says it with voice on, and Shiori hears of it later (spec §11.3)", async () => {
  const k = await liveAgent([[{ error: 'credit', status: 402 }]], { voice: { mode: 'on' } });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.to(at('10:00'));
  await until(() => k.said.includes('Tea time.'));
  const [r] = await k.events(['reminder']);
  assert.equal(r.data.text, 'Tea time.');
  assert.equal(r.data.aloud, true);
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => n.title), ["Shiori can't reach her model", 'Reminder']);
  assert.equal(k.notices[1].body, 'Tea time.');
  const t = await Transcript.load(k.store, k.trip);
  assert.ok(JSON.stringify(t.messages).includes(`[annai] Shown and said aloud by annai itself, since you couldn't be reached: \\"Tea time.\\"`));
  assert.equal(t.unanswered, false); // a reminder isn't something for her to answer at the next start
});

test('with no model set at all, the reminder still comes (spec §17 rule 2)', async () => {
  const k = await liveAgent([]);
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.to(at('10:00'));
  assert.deepEqual((await k.events(['reminder'])).map((e) => e.data.text), ['Tea time.']);
  assert.ok(k.notices.some((/** @type {any} */ n) => n.title === 'Reminder'));
});

test('a trigger wake the hourly limit drops still reminds; quiet hours hold Shiori, not the reminder; turning live mode on is the user’s own tap (spec §6.6)', async () => {
  const k = await liveAgent([[say('Hi.')]]);
  await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 1 } } });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'One.' });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:01') }, fallback: 'Two.' });
  await k.to(at('10:01'));
  assert.equal(k.requests.length, 1);
  assert.deepEqual((await k.events(['reminder'])).map((e) => e.data.text), ['Two.']);
  assert.ok(k.notices.some((/** @type {any} */ n) => n.title === 'Shiori skipped a wake'));
  const q = await liveAgent([[say('Hi.')]]);
  await updateAppSettings(q.ws, { shiori: { budgets: { quietHours: { from: '22:00', to: '07:00' } } } });
  await q.live.setWatch(q.trip, { when: { type: 'time', at: iso('23:00') }, fallback: 'Late call.' });
  await q.to(at('23:00'));
  assert.equal(q.requests.length, 0);
  assert.deepEqual((await q.events(['reminder'])).map((e) => e.data.text), ['Late call.']);
  await q.live.setLive(true);
  await q.settle();
  assert.equal(q.requests.length, 1);
  assert.match(q.requests[0].tail, /woke for: The user turned live mode on/);
});

test('the now block says where the user is and what they are doing (spec §6.3)', async () => {
  const k = await liveAgent([[say('Nepenthe is just ahead.')]]);
  await k.ws.write(k.trip, '/plan/nepenthe.json', NEP, { author: 'user' });
  await k.live.setLive(true);
  await k.settle();
  for (let s = 0; s <= 60; s += 5) {
    await k.to(at('11:40') + s * 1000);
    k.sensors.fix({ ...off(NEPENTHE, 0, 1500 - s * 15), accuracy: 8, speed: 15 });
    await k.settle();
  }
  k.agent.send('Where are we?');
  await k.settle();
  const tail = String(k.requests.at(-1).tail);
  assert.match(tail, /^place: near Nepenthe \(600 m\) · 36\.\d{5}, -121\.75670 \(±8 m\)$/m);
  assert.match(tail, /^activity: moving fast, about 54 km\/h$/m);
});

test('voice Auto hears "moving fast" from an activity sensor that came after voice started (spec §10.5)', async () => {
  const k = await agentKit([[say('Hi.')]], { voice: { mode: 'auto' } });
  assert.equal(k.voice.mode.on, false);
  /** @type {Set<() => void>} */
  const fns = new Set();
  let activity = 'still';
  k.registry.add('live', 'activity', { now: () => activity, onChange: (/** @type {() => void} */ fn) => { fns.add(fn); } });
  await until(() => fns.size === 1);
  activity = 'moving-fast';
  for (const fn of fns) fn();
  await until(() => k.voice.mode.on);
  assert.equal(k.voice.mode.why, 'moving');
});

test('Shiori sets, lists and cancels watches with her Time tools (spec §7.2)', async () => {
  const k = await liveAgent([[
    { toolCalls: [{ name: 'watch_set', input: { when: { type: 'moved', km: 15 }, repeat: true, fallback: 'Point Sur is ahead.' } }] },
    { toolCalls: [{ name: 'watch_list', input: {} }] },
    { toolCalls: [{ name: 'watch_cancel', input: { id: 'plan:nepenthe:leave' } }, sleep] },
  ]]);
  await k.ws.write(k.trip, '/plan/nepenthe.json', NEP, { author: 'user' });
  k.agent.send('Tell me about the road as we go.');
  await k.settle();
  const results = await k.events(['tool.result']);
  assert.match(results[0].data.content, /^Set w-\S+: after 15 km travelled, every time\. Live mode is off, so it waits until the user turns it on\. Now: /);
  assert.match(results[1].data.content, /^id\towner\twhen\trepeat\treminder\texpires\tlast_fired\n/);
  assert.match(results[1].data.content, /\tshiori\tafter 15 km travelled\tyes\tPoint Sur is ahead\.\t/);
  assert.match(results[1].data.content, /plan:nepenthe:leave\tsystem\t/);
  assert.equal(results[2].data.ok, false);
  assert.match(results[2].data.content, /follows the plan/);
  const { watches } = await readWatches(k.ws, k.trip);
  assert.equal(watches.length, 1);
  assert.equal((await k.ws.list(k.trip, '/watches/'))[0].author, 'shiori');
  const set = k.requests[0].tools.find((/** @type {any} */ t) => t.name === 'watch_set');
  assert.deepEqual(set.input.properties.when.properties.type.enum, ['time', 'every', 'enter', 'leave', 'dwell', 'arrived', 'moved', 'activity']);
  assert.match(set.description, /fallback \(required\)/);
  assert.ok(k.requests[0].tools.some((/** @type {any} */ t) => t.name === 'watch_list') && k.requests[0].tools.some((/** @type {any} */ t) => t.name === 'watch_cancel'));
});

test('thousands of location points never reach her context, and housekeeping does not weigh them (Review Focus 6)', async () => {
  const k = await agentKit([[say('OK.')]], { models: [{ contextWindow: 20_000 }], utility: [{ text: 'Earlier: some short exchanges.' }] });
  for (let i = 1; i <= 5; i++) {
    if (i === 5) for (let j = 0; j < 2000; j++) await logEvent(k.store, k.trip, { type: 'location', data: { lat: 36 + j / 1e5, lng: -121.9, accuracy: 8, speed: 20 } });
    k.agent.send(`Message ${i}`);
    await k.agent.idle();
  }
  const loaded = await Transcript.load(k.store, k.trip);
  assert.deepEqual(loaded.messages, k.agent.transcript.messages);
  assert.ok(!JSON.stringify(k.requests.at(-1)).includes('36.01'));
  assert.equal(await k.agent.compact('cold'), true);
  const wakes = await k.events(['wake']);
  const [c] = await k.events(['compaction']);
  assert.equal(c.data.to, wakes[1].seq - 1); // only the oldest exchange: the points weighed nothing
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/live-agent.test.js`
Expected: FAIL with `Cannot find module '…/src/core/live/watch-tools.js'`.

- [ ] **Step 3: Write the implementation**

`src/core/live/watch-tools.js`:

```js
/**
 * The Time tools (spec §7.2): watch_set, watch_list and watch_cancel. Providers accept only
 * letters, digits, "_" and "-" in a tool's name, so watch.set is watch_set (choice 1). Like the
 * Self tools, they are the loop's own, so they reach the live engine.
 * @param {import('./live.js').Live} live @returns {import('../agent/loop.js').LoopTool[]}
 */
export function watchTools(live) {
  const core = /** @type {const} */ ('core');
  return [
    {
      name: 'watch_set', pluginId: core, group: 'Time',
      // Read each time the tools are sent: a plugin may have added a trigger type (spec §11.3).
      get description() {
        const lines = [...live.types().values()].map((t) => `- ${t.summary}`).join('\n');
        return `Set a watch: annai wakes you when it fires, and says why. when.type is one of:\n${lines}\nfallback (required): what annai shows, and says with voice on, by itself if you can't be reached when it fires, such as "Low tide at Pfeiffer Beach in 30 minutes." repeat: fire every time, not just once (every always repeats; time never does). expires: an ISO date-time after which it is dropped. Location, distance and activity watches need live mode (GPS); time and every watches work whenever annai is on screen. The plan already sets its own reminders (leave, arrived, running late, off plan): don't add those.`;
      },
      get input() {
        return {
          type: 'object', required: ['when', 'fallback'],
          properties: {
            when: {
              type: 'object', required: ['type'],
              properties: {
                type: { enum: [...live.types().keys()] }, at: { type: 'string' }, minutes: { type: 'number' }, km: { type: 'number' },
                lat: { type: 'number' }, lng: { type: 'number' }, radius: { type: 'number' }, name: { type: 'string' },
                activity: { enum: ['still', 'walking', 'moving-fast'] }, edge: { enum: ['start', 'stop'] },
              },
            },
            fallback: { type: 'string', minLength: 1, maxLength: 500 },
            repeat: { type: 'boolean' },
            expires: { type: 'string' },
          },
        };
      },
      run: async (/** @type {any} */ i, /** @type {any} */ call) => live.watchText(await live.setWatch(call.scope, i)),
    },
    {
      name: 'watch_list', pluginId: core, group: 'Time',
      description: "Your watches in this conversation, and the plan's own reminders, as TSV: id, owner, when, repeat, reminder, expires, last_fired.",
      input: { type: 'object', properties: {} },
      run: async (/** @type {any} */ _i, /** @type {any} */ call) => live.listWatches(call.scope),
    },
    {
      name: 'watch_cancel', pluginId: core, group: 'Time',
      description: "Cancel one of your watches by its id (watch_list shows them). The plan's own reminders follow the plan: change the plan item instead.",
      input: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'] },
      run: async (/** @type {{ id: string }} */ i, /** @type {any} */ call) => live.cancelWatch(call.scope, String(i.id)),
    },
  ];
}
```

In `src/core/agent/transcript.js`:

1. After `export const RESTARTED = …`, add:

```js
/** Entries the conversation never shows Shiori, left out as it is read: a drive logs thousands of points (spec §4.5). */
export const NOT_SAID = new Set(['location', 'trigger.fired']);
```

2. In `apply`, before the `else if (e.type === 'tool.result' && …)` branch, add:

```js
    } else if (e.type === 'reminder') {
      // A reminder annai showed (and said) by itself, the model out of reach (spec §11.3): she knows, so she doesn't repeat it.
      if (!texts.text) return;
      this.#add('user', [{ type: 'text', text: `[annai] Shown${d.aloud ? ' and said aloud' : ''} by annai itself, since you couldn't be reached: "${texts.text}"` }]);
```

3. In `Transcript.load`, the loop becomes `for (const e of events) if (e.type !== 'compaction' && !NOT_SAID.has(e.type)) t.apply(e, await resolveEvent(store, e));`.

In `src/core/agent/loop.js`:

1. Import `NOT_SAID`: `import { Transcript, resolveEvent, repair, NOT_SAID } from './transcript.js';`.

2. The typedefs become:

```js
 * @typedef {'user' | 'choice' | 'plugin' | 'file' | 'restart' | 'personality' | 'heard' | 'trigger' | 'catch-up' | 'live'} WakeKind
 *   trigger and catch-up: live mode's watches fired (spec §11.3, §11.4); live: the user turned live mode on
 * @typedef {{ watch: string, text: string }} Reminder  a watch's fallback (spec §11.3)
 * @typedef {{ path: string, region?: number[] }} SentPhoto a photo the user sends: a path, and a part of it
 * @typedef {{ kind: WakeKind, text: string, plugin?: string, scope?: string, photos?: SentPhoto[], heard?: import('../voice/resolve.js').Heard, gate?: string, fallbacks?: Reminder[] }} Wake
 *   scope: the conversation it was meant for, set when it is queued; heard: what the microphone heard (spec §6.1); gate: what the quick-decision gate made of it;
 *   fallbacks: what annai shows and says by itself if no model answers (spec §11.3)
```

3. After the `voice = null;` field, add:

```js
  /** Where the user is and what they are doing, for the now block (spec §6.3): live mode's. @type {(() => { place?: string, activity?: string }) | null} */
  sense = null;
```

4. In `wake(w)`, the first test of kinds adds `|| w.kind === 'live'` (turning live mode on is the user's tap); in the budget check, quiet hours and the hourly limit become:

```js
      if (budgets.quietHours && inQuiet(now, budgets.quietHours, this.timeZone())) {
        // Quiet hours hold Shiori, not the reminders (spec §11.3).
        if (w.fallbacks?.length) this.remind(w.fallbacks).catch(() => {});
        const later = { ...w, fallbacks: [] };
        const held = setTimeout(() => this.wake(later), Math.max(1000, quietEnds(now, budgets.quietHours, this.timeZone()) - now));
        /** @type {any} */ (held).unref?.(); // in Node (tests), a held wake must not keep the process alive
        return;
      }
      this.#recentWakes = this.#recentWakes.filter((t) => t > now - 3_600_000);
      if (budgets.wakesPerHour && this.#recentWakes.length >= budgets.wakesPerHour) {
        this.#notice({ tone: 'info', title: 'Shiori skipped a wake', body: `${w.plugin ? `The plugin ${w.plugin}` : 'Something'} woke her more than the ${budgets.wakesPerHour} times an hour you allow: ${w.text}` });
        if (w.fallbacks?.length) this.remind(w.fallbacks).catch(() => {});
        return;
      }
```

5. In `#steps`, after `const reasons = wakes.map((w) => this.#reason(w));`, add:

```js
    /** The reminders of the wakes no model has answered yet: annai says them itself if none does (spec §11.3). */
    let owed = wakes.flatMap((w) => w.fallbacks ?? []);
```

after `answered = true;` add `owed = [];`; in the `if (more.length) { … }` block add `owed.push(...more.flatMap((w) => w.fallbacks ?? []));`; and before `return answered && !failed;` add:

```js
    if (owed.length && !abort.signal.aborted && !this.#leaving) await this.remind(owed);
```

6. In `#steps`, the now block takes the place and activity:

```js
      const here = this.sense?.() ?? {};
      const tail = nowBlock({ now: this.now(), timeZone: this.timeZone(), voice: this.#voiceNow ? 'on' : 'off', voiceWhy, online: this.online(), reasons, plan, place: here.place, activity: here.activity });
```

7. In `compact()`, the events read become `… .filter((e) => e.type !== 'compaction' && !NOT_SAID.has(e.type));`.

8. After `notify(n)`, add:

```js
  /**
   * Reminders annai says or shows by itself (spec §11.3: when a watch fires and the model can't be
   * reached, "the fallback is shown or spoken directly"; §17: with no connection, and no model): a
   * card, the words aloud with voice on, and an entry in the conversation they belong to. They are
   * never in Shiori's voice (§16.1).
   * @param {Reminder[]} list @param {string} [scope] their conversation; the open one if not given
   */
  async remind(list, scope = this.#target ?? ME) {
    const open = scope === (this.#target ?? ME);
    for (const r of list) {
      const text = String(r?.text ?? '').trim();
      if (!text) continue;
      const aloud = open && Boolean(this.voice?.on) && !this.voice?.speaker.speaking;
      const ev = { type: 'reminder', actor: 'system', data: { watch: String(r.watch ?? ''), text, ...(aloud ? { aloud: true } : {}) } };
      if (open && scope === this.scope) await this.#log(ev);
      else await record(this.store, scope, ev);
      await this.#notice({ tone: 'info', title: 'Reminder', body: text });
      if (aloud) this.voice?.say(text).catch(() => {});
    }
  }
```

In `src/core/voice/voice.js`, `#watch()` becomes:

```js
  /** Devices coming and going, and the activity changing, work out the mode again. */
  #watch() {
    if (this.#watching) return;
    const platform = this.platform;
    if (!platform) return;
    this.#watching = true;
    const again = () => { this.refresh().catch(() => {}); };
    platform.onDeviceChange?.(again);
    // The activity sensor comes with live mode (spec §11.2), maybe after voice started: followed once it is there.
    /** @type {any} */
    let followed = null;
    const follow = (/** @type {boolean} */ late) => {
      const sensor = this.registry.list('activity')[0] ?? null;
      if (!sensor || sensor === followed) return;
      followed = sensor;
      sensor.onChange?.(again);
      if (late) again(); // one that came later may already say something
    };
    follow(false); // called from refresh(), which reads the activity itself
    this.registry.onChange(() => follow(true));
  }
```

`src/ui/screens/tools.js`: `const GROUPS = ['Talk', 'Files', 'Web', 'Places', 'Go', 'Time', 'Self'];`.

`src/app/main.js`:

1. Import: `import { Live } from '../core/live/live.js';` and `import { watchTools } from '../core/live/watch-tools.js';`.

2. After `agent.addLoopTools(selfTools(agent));`, add:

```js
  // Live mode (spec §11): watches, the plan's own reminders, catch-up. The phone's sensors come in a plugin.
  const live = new Live({ store, ws, registry, agent });
  agent.addLoopTools(watchTools(live));
  agent.sense = () => live.nowInfo();
```

3. After `agent.open(exists ? active : null)…;`, add `live.start().catch((e) => console.warn('Live mode could not start', e));`, and pass `live` to the shell: `startShell(root, { store, ws, registry, plugins, llm, agent, voice, live, presets, version: VERSION })`.

In `src/ui/shell.js`, the `core` parameter's type gains `live?: any`.

In `sw.js` `SHELL`, add `'/src/core/live/watch-tools.js'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/live-agent.test.js`
Expected: PASS, 8 tests. Then `npm test` passes in full (the agent's existing tests are unchanged).

- [ ] **Step 5: Run the end-to-end suite in Docker**

The app now runs the engine: nothing on screen should change.

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test > .superpowers/sdd/2026-10-16-m5a-live-core/e2e.log 2>&1; tail -5 .superpowers/sdd/2026-10-16-m5a-live-core/e2e.log`
Expected: every test passes in chromium and webkit. Delete any `core*` file the run leaves in the worktree.

- [ ] **Step 6: Commit**

```bash
npm run stamp && npm run check && git add src/core/live/watch-tools.js src/core/agent/loop.js src/core/agent/transcript.js src/core/voice/voice.js src/app/main.js src/ui/shell.js src/ui/screens/tools.js test/unit/live-agent.test.js sw.js && git commit -m "Shiori's side of live mode: her Time tools, wakes when a watch fires, reminders annai says itself when no model can be reached, and where the user is in the now block (spec §6.3, §7.2, §11.3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 7: Trip simulation, and a simulated Big Sur drive

**Files:**
- Create: `src/core/live/simulate.js`, `test/fixtures/live/big-sur.json`
- Modify: `plugins-official/scripted-model/index.js` (rules), `plugins-official/scripted-model/annai-plugin.json` (version 0.4.0), `catalog/plugins.json` (`npm run catalog`), `test/unit/agent-kit.js` (a script may be `{ rules }`), `sw.js` (`SHELL`), `README.md` (milestone 5 in progress: what 5a adds)
- Test: `test/unit/live-simulate.test.js`, `test/unit/live-big-sur.test.js`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - `simulate.js`: `Itinerary = { name?, start, everySec?, stillSec?, accuracy?, endMin?, route: { name?, lat, lng, arrive?, leave? }[], marks?: { at, kind }[] }`; `TrackEvent = { at, kind: 'fix', fix } | { at, kind: 'hide' | 'show' | 'offline' | 'online' }`; `trackFrom(itinerary): TrackEvent[]`; `class Simulation { online; shown; constructor({ registry, track }); send(e); run(clock, settle?, { from?, to? }?); play(clock, { onEnd? }?): stop; dispose() }`. A Simulation registers sensors of its own (`simulation` plugin, kinds `location`, `visibility`, `connectivity`).
  - The scripted model's `rules` tunable: `[{ match, reply, then?, times? }]`. The first rule whose `match` (a case-insensitive regular expression) finds the request's "woke for:" line answers with `reply`; a call that follows tool results gets the rule's `then` (default: sleep); `times` limits how often a rule answers.
  - `agentKit(scripts)`: a script that is an object, such as `{ rules }`, is that endpoint's tunables.
  - The fixture: the itinerary, the trip's time zone, the plan and the bookings of the drive.

- [ ] **Step 1: Write the failing tests**

`test/fixtures/live/big-sur.json`:

```json
{
  "name": "Big Sur on Highway 1: Monterey to Cambria",
  "note": "A synthetic drive for annai's trip simulation (spec §18). It stops at Bixby Bridge, the Big Sur River Inn (not on the plan), Nepenthe, McWay Falls, Ragged Point and San Simeon pier (neither on the plan), Hearst Castle and Cambria. The connection is gone from 13:50 to 14:35 near Lucia; the phone is locked from 15:18 to 16:05.",
  "start": "2026-11-27T08:30:00-08:00",
  "timezone": "America/Los_Angeles",
  "everySec": 5,
  "stillSec": 10,
  "accuracy": 8,
  "endMin": 30,
  "route": [
    { "name": "Monterey", "lat": 36.6036, "lng": -121.8916, "leave": "09:00" },
    { "lat": 36.5367, "lng": -121.9081 },
    { "lat": 36.5153, "lng": -121.9387 },
    { "lat": 36.46, "lng": -121.92 },
    { "lat": 36.3789, "lng": -121.9033 },
    { "name": "Bixby Bridge", "lat": 36.3715, "lng": -121.9017, "arrive": "09:30", "leave": "09:50" },
    { "lat": 36.307, "lng": -121.899 },
    { "lat": 36.284, "lng": -121.844 },
    { "name": "Big Sur River Inn", "lat": 36.27, "lng": -121.807, "arrive": "10:08", "leave": "11:40" },
    { "name": "Nepenthe", "lat": 36.2213, "lng": -121.7567, "arrive": "11:48", "leave": "13:10" },
    { "name": "McWay Falls", "lat": 36.158, "lng": -121.672, "arrive": "13:22", "leave": "13:45" },
    { "lat": 36.02, "lng": -121.548 },
    { "lat": 35.93, "lng": -121.466 },
    { "name": "Ragged Point", "lat": 35.779, "lng": -121.329, "arrive": "14:43", "leave": "15:15" },
    { "name": "San Simeon pier", "lat": 35.6431, "lng": -121.1888, "arrive": "15:37", "leave": "16:30" },
    { "name": "Hearst Castle", "lat": 35.6852, "lng": -121.166, "arrive": "16:36", "leave": "18:15" },
    { "name": "Cambria", "lat": 35.5641, "lng": -121.0807, "arrive": "18:32" }
  ],
  "marks": [
    { "at": "13:50", "kind": "offline" },
    { "at": "14:35", "kind": "online" },
    { "at": "15:18", "kind": "hide" },
    { "at": "16:05", "kind": "show" }
  ],
  "plan": {
    "bixby": { "id": "bixby", "title": "Bixby Bridge photo stop", "fixed": false, "priority": 1, "start": { "at": "2026-11-27T09:45:00-08:00", "tz": "America/Los_Angeles" }, "end": { "at": "2026-11-27T10:05:00-08:00", "tz": "America/Los_Angeles" }, "place": { "name": "Bixby Creek Bridge", "lat": 36.3715, "lng": -121.9017 } },
    "nepenthe": { "id": "nepenthe", "title": "Lunch at Nepenthe", "kind": "meal", "fixed": true, "priority": 2, "start": { "at": "2026-11-27T12:00:00-08:00", "tz": "America/Los_Angeles" }, "end": { "at": "2026-11-27T13:15:00-08:00", "tz": "America/Los_Angeles" }, "place": { "name": "Nepenthe", "lat": 36.2213, "lng": -121.7567, "address": "48510 CA-1, Big Sur, CA" }, "booking": "/trip/bookings/nepenthe.json", "notes": "Window table if they have one." },
    "mcway": { "id": "mcway", "title": "McWay Falls", "fixed": false, "priority": 2, "start": { "at": "2026-11-27T13:45:00-08:00", "tz": "America/Los_Angeles" }, "end": { "at": "2026-11-27T14:15:00-08:00", "tz": "America/Los_Angeles" }, "place": { "name": "McWay Falls", "lat": 36.158, "lng": -121.672 } },
    "hearst": { "id": "hearst", "title": "Hearst Castle tour", "kind": "event", "fixed": true, "priority": 3, "start": { "at": "2026-11-27T16:30:00-08:00", "tz": "America/Los_Angeles" }, "end": { "at": "2026-11-27T18:15:00-08:00", "tz": "America/Los_Angeles" }, "place": { "name": "Hearst Castle", "lat": 35.6852, "lng": -121.166 }, "booking": "/trip/bookings/hearst.json" },
    "cambria": { "id": "cambria", "title": "Check in: Cambria Pines Lodge", "kind": "lodging", "fixed": true, "priority": 3, "start": { "at": "2026-11-27T19:00:00-08:00", "tz": "America/Los_Angeles" }, "place": { "name": "Cambria Pines Lodge", "lat": 35.5641, "lng": -121.0807 }, "booking": "/trip/bookings/lodge.json" }
  },
  "bookings": {
    "nepenthe": { "id": "nepenthe", "kind": "restaurant", "status": "confirmed", "source": "/files/nepenthe.pdf", "title": "Nepenthe", "confirmation": "NP-2241" },
    "hearst": { "id": "hearst", "kind": "event", "status": "confirmed", "source": "/files/hearst.pdf", "title": "Hearst Castle Grand Rooms Tour", "confirmation": "HC-88812" },
    "lodge": { "id": "lodge", "kind": "lodging", "status": "confirmed", "source": "/files/lodge.pdf", "title": "Cambria Pines Lodge", "confirmation": "CPL-5531" }
  }
}
```

In `test/unit/agent-kit.js`, the endpoint of each script becomes `user: { name: \`E${i}\`, tunables: Array.isArray(script) ? { script } : script }` (a script may be an object, such as `{ rules }`), and the JSDoc of `scripts` becomes `@param {(any[] | Record<string, any>)[]} scripts`.

`test/unit/live-simulate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackFrom, Simulation } from '../../src/core/live/simulate.js';
import { ManualClock, scaledClock } from '../../src/core/live/clock.js';
import { meters } from '../../src/core/live/geo.js';
import { liveKit, at, MONTEREY, BIXBY } from './live-kit.js';

const SHORT = {
  start: '2026-11-27T09:00:00-08:00', everySec: 5, stillSec: 10, endMin: 1,
  route: [{ name: 'Monterey', ...MONTEREY, leave: '09:01' }, { lat: 36.46, lng: -121.92 }, { name: 'Bixby Bridge', ...BIXBY, arrive: '09:31' }],
  marks: [{ at: '09:10', kind: /** @type {const} */ ('hide') }, { at: '09:20', kind: /** @type {const} */ ('show') }],
};

test('a track from an itinerary: still at the stops, a steady speed along the road between, marks first at the same moment; the same every time', () => {
  const t = trackFrom(SHORT);
  assert.deepEqual(trackFrom(SHORT), t);
  const fixes = t.filter((e) => e.kind === 'fix');
  assert.equal(fixes[0].at, at('09:00'));
  assert.equal(/** @type {any} */ (fixes[0]).fix.speed, 0);
  assert.ok(meters(/** @type {any} */ (fixes[0]).fix, MONTEREY) <= 5); // a little GPS jitter
  const moving = fixes.filter((e) => /** @type {any} */ (e).fix.speed > 0);
  assert.equal(moving[0].at, at('09:01'));
  assert.equal(moving.length, 360); // 30 minutes, every 5 s
  const road = meters(MONTEREY, { lat: 36.46, lng: -121.92 }) + meters({ lat: 36.46, lng: -121.92 }, BIXBY);
  assert.ok(Math.abs(/** @type {any} */ (moving[0]).fix.speed - road / 1800) < 0.01);
  assert.ok(meters(/** @type {any} */ (fixes.at(-1)).fix, BIXBY) <= 5);
  assert.equal(fixes.at(-1)?.at, at('09:32')); // a minute at the last stop
  const hide = t.findIndex((e) => e.kind === 'hide');
  assert.equal(t[hide].at, at('09:10'));
  assert.equal(t[hide + 1].at, at('09:10')); // the fix at the same moment comes after it
  assert.throws(() => trackFrom({ ...SHORT, start: '2026-11-27 09:00' }), /needs a start: an ISO date-time with an offset/);
  assert.throws(() => trackFrom({ ...SHORT, route: [SHORT.route[0], { ...SHORT.route[2], arrive: '08:59' }] }), /Bixby Bridge is reached before the drive there ends/);
  assert.throws(() => trackFrom({ ...SHORT, route: [SHORT.route[0]] }), /at least two places/);
});

test('a simulation plays a track through sensors of its own into the live engine: fixes, the phone locked and unlocked, the connection', async () => {
  const k = await liveKit({ start: at('09:00') });
  const sim = new Simulation({ registry: k.registry, track: trackFrom(SHORT) });
  await k.settle();
  await sim.run(k.clock, k.settle);
  const points = await k.events(['location']);
  assert.ok(points.length > 200);
  assert.ok(points.every((e) => e.data.source === 'sim'));
  assert.ok(!points.some((e) => e.ts > at('09:10') && e.ts < at('09:20')), 'no GPS while the phone was locked');
  assert.equal(k.live.shown, true);
  sim.send({ at: at('09:32'), kind: 'offline' });
  await k.settle();
  assert.equal(k.live.online, false);
  sim.dispose();
  assert.equal(k.registry.list('sensor').filter((s) => s.kind === 'location').length, 1); // only the kit's own
});

test('played on a clock ten times faster than real time (spec §18), 20 s of track take 2 s', async () => {
  const base = new ManualClock(0);
  const k = await liveKit({ start: at('09:00') });
  const sim = new Simulation({ registry: k.registry, track: [{ at: at('09:00'), kind: 'offline' }, { at: at('09:00:10'), kind: 'online' }, { at: at('09:00:20'), kind: 'offline' }] });
  const clock = scaledClock(at('09:00'), 10, base);
  let ended = false;
  sim.play(clock, { onEnd: () => { ended = true; } });
  await k.settle();
  assert.equal(k.live.online, false);
  await base.advanceTo(1000);
  await k.settle();
  assert.equal(k.live.online, true);
  assert.equal(ended, false);
  await base.advanceTo(2000);
  await k.settle();
  assert.equal(k.live.online, false);
  assert.equal(ended, true);
});
```

`test/unit/live-big-sur.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentKit } from './agent-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { trackFrom, Simulation } from '../../src/core/live/simulate.js';
import { watchTools } from '../../src/core/live/watch-tools.js';

const DRIVE = JSON.parse(await readFile(new URL('../fixtures/live/big-sur.json', import.meta.url), 'utf8'));
const sleep = { name: 'sleep', input: {} };
const speak = (/** @type {string} */ text) => ({ name: 'speak', input: { text } });
const NARRATE = 'Highway 1 runs on south along the coast.';
/**
 * Shiori, scripted (spec §18): what the driving-companion and replanning skills tell her to do,
 * for each thing that can wake her. The first rule whose match finds what woke her answers.
 */
const RULES = [
  { match: 'turned live mode on', reply: { toolCalls: [{ name: 'watch_set', input: { when: { type: 'activity', activity: 'moving-fast' }, repeat: true, fallback: 'On the road again. The plan has the next stop.' } }, sleep] } },
  { match: '^Catch-up', reply: { toolCalls: [speak('Welcome back. We have covered some ground.'), sleep] } },
  { match: '^While there was no connection', reply: { toolCalls: [sleep] } },
  { match: 'is now moving fast', times: 1, reply: { toolCalls: [{ name: 'watch_set', input: { when: { type: 'moved', km: 15 }, repeat: true, fallback: NARRATE } }, speak('Off we go. Bixby Bridge comes first.'), sleep] } },
  { match: 'is now moving fast', reply: { toolCalls: [sleep] } },
  { match: 'travelled .* km since your last wake', reply: { toolCalls: [{ name: 'nearby', input: { lat: 36.307, lng: -121.899, radius: 8000, kinds: ['sights'] } }, speak('Point Sur Lighthouse is up on the rock to the right.'), sleep] } },
  { match: 'you arrived at', reply: { toolCalls: [speak('Here we are.'), sleep] } },
  {
    match: '^Off plan: the user has been stopped', times: 1,
    reply: {
      toolCalls: [
        { name: 'patch', input: { path: '/trip/plan/mcway.json', changes: { start: { at: '2026-11-27T14:00:00-08:00', tz: 'America/Los_Angeles' }, end: { at: '2026-11-27T14:30:00-08:00', tz: 'America/Los_Angeles' } } } },
        speak('Take your time here. I moved McWay Falls to two; lunch at Nepenthe stays at noon.'), sleep,
      ],
    },
  },
  { match: '^Off plan', reply: { toolCalls: [speak('No rush. The castle tour is at half past four.'), sleep] } },
  { match: 'time to leave soon', reply: { toolCalls: [speak('Time to head on soon.'), sleep] } },
  { match: 'running late', reply: { toolCalls: [speak('We will be a few minutes late for the castle tour.'), sleep] } },
];
/** The wakes the drive must produce, in order: what fired, in a few words. */
const EXPECTED = [
  'live mode on', 'driving', 'moved', 'arrived: Bixby Creek Bridge',
  'driving', 'moved', 'stopped off plan', 'leave: Lunch at Nepenthe',
  'driving', 'arrived: Nepenthe',
  'driving', 'arrived: McWay Falls',
  'driving', 'back online', 'stopped off plan',
  'driving', 'catch-up', 'stopped off plan', 'late: Hearst Castle tour',
  'driving', 'arrived: Hearst Castle',
  'driving', 'moved', 'arrived: Cambria Pines Lodge',
];

/** A wake's reasons in a few words. @param {any[]} reasons */
function label(reasons) {
  const r = reasons.find((x) => x.kind !== 'user') ?? reasons[0];
  const t = String(r.text ?? '');
  if (r.kind === 'live') return 'live mode on';
  if (r.kind === 'catch-up') return 'catch-up';
  if (t.startsWith('While there was no connection')) return 'back online';
  if (t.includes('is now moving fast')) return 'driving';
  if (/travelled .* km since your last wake/.test(t)) return 'moved';
  const arrived = /you arrived at (.+?) for "/.exec(t);
  if (arrived) return `arrived: ${arrived[1]}`;
  if (t.startsWith('Off plan: the user has been stopped')) return 'stopped off plan';
  const leave = /time to leave soon for "(.+?)"/.exec(t);
  if (leave) return `leave: ${leave[1]}`;
  const late = /running late for "(.+?)"/.exec(t);
  if (late) return `late: ${late[1]}`;
  return t;
}

/** Overpass and Wikipedia, answering as they would near Point Sur. @param {string} url */
async function places(url) {
  const body = String(url).includes('overpass')
    ? { elements: [{ type: 'node', lat: 36.3066, lon: -121.9017, tags: { name: 'Point Sur Light Station', tourism: 'attraction' } }] }
    : { query: { geosearch: [] } };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('a simulated Big Sur drive produces the expected wakes, and Shiori does what her skills say (spec §20, milestone 5)', async () => {
  const track = trackFrom(DRIVE);
  const clock = new ManualClock(track[0].at);
  /** @type {Simulation | null} */
  let sim = null;
  const k = await agentKit([{ rules: RULES }], {
    agent: { now: clock.now, timeZone: () => DRIVE.timezone, online: () => sim?.online ?? true, fetch: places },
    voice: { mode: 'auto' },
  });
  await k.host.addBuiltin(new URL('../../src/plugins/places/index.js', import.meta.url).href);
  for (const [name, item] of Object.entries(DRIVE.plan)) await k.ws.write(k.trip, `/plan/${name}.json`, item, { author: 'user' });
  for (const [name, b] of Object.entries(DRIVE.bookings)) await k.ws.write(k.trip, `/bookings/${name}.json`, b, { author: 'user' });
  sim = new Simulation({ registry: k.registry, track });
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => DRIVE.timezone });
  k.agent.addLoopTools(watchTools(live));
  k.agent.sense = () => live.nowInfo();
  await live.start();
  const settle = async () => {
    let before;
    do {
      before = k.requests.length;
      await live.settled();
      await k.agent.idle();
      await live.settled();
    } while (k.requests.length !== before);
  };
  await settle();
  await live.setLive(true); // the user turns live mode on in Monterey
  await settle();
  await sim.run(clock, settle);

  const wakes = (await k.events(['wake'])).filter((e) => !e.data.meanwhile);
  assert.deepEqual(wakes.map((e) => label(e.data.reasons)), EXPECTED);
  // Unlocked after the phone was locked: what came due and how far they went, in one wake (spec §11.4).
  const catchUp = String(wakes.find((e) => e.data.reasons[0].kind === 'catch-up')?.data.reasons[0].text);
  assert.match(catchUp, /^Catch-up: annai was off screen for 47 min \(since 15:18\), and the user moved \d+\.\d km\. /);
  assert.match(catchUp, /Plan: time to leave soon for "Hearst Castle tour" \(fixed, 16:30\): .*\(late by 1\d min: annai was off screen\)\./);
  assert.match(catchUp, /fired: you have travelled \d+\.\d km since your last wake/);
  // With no connection near Lucia, annai said the narration watch's reminder itself, aloud (spec §11.3, §17).
  assert.deepEqual((await k.events(['reminder'])).map((e) => [e.data.text, e.data.aloud]), [[NARRATE, true], [NARRATE, true]]);
  assert.equal(k.said.filter((/** @type {string} */ s) => s === NARRATE).length, 2);
  // What Shiori did, as the skills say.
  const calls = (await k.events(['tool.call'])).map((e) => e.data.name);
  assert.equal(calls.filter((n) => n === 'watch_set').length, 2);
  assert.equal(calls.filter((n) => n === 'nearby').length, 3);
  assert.equal(calls.filter((n) => n === 'patch').length, 1);
  assert.equal((await k.ws.readJSON(k.trip, '/plan/mcway.json')).start.at, '2026-11-27T14:00:00-08:00'); // the replan: a patch, so it can be undone (§11.5)
  // Voice Auto came on with the driving and went off at the stops (spec §10.5).
  const voice = (await k.events(['state'])).filter((e) => e.data.voice).map((e) => `${e.data.voice} ${e.data.why}`);
  assert.ok(voice.includes('on moving'), voice.join(', '));
  assert.ok(voice.includes('off not sure'), voice.join(', '));
  // Nothing went wrong on the way: the only cards were the reminders.
  assert.deepEqual([...new Set(k.notices.map((/** @type {any} */ n) => n.title))], ['Reminder']);
  // The road is in the log, for replay (spec §4.5, §13).
  assert.ok((await k.events(['location'])).length > 1000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/live-simulate.test.js test/unit/live-big-sur.test.js`
Expected: FAIL with `Cannot find module '…/src/core/live/simulate.js'`.

- [ ] **Step 3: Write the implementation**

`src/core/live/simulate.js`:

```js
import { meters } from './geo.js';

/**
 * Trip simulation (spec §13, §18): a GPS track and a fake clock fed through the same machinery as
 * a real trip. A track comes from an itinerary (a route with stops and their times); a Simulation
 * plays it through sensors of its own (location, visibility, connectivity) into the live engine.
 * Milestone 7 puts a screen on it ("Simulate a trip"); tests step it as fast as it can go, and a
 * person can watch it ten times faster than real time (§18).
 * @typedef {{ name?: string, lat: number, lng: number, arrive?: string, leave?: string }} RoutePoint
 *   a stop has arrive and leave ("HH:MM" on the start's day, at its offset); the first only leaves, the last only
 *   arrives; points without either shape the road
 * @typedef {{ name?: string, start: string, everySec?: number, stillSec?: number, accuracy?: number, endMin?: number,
 *   route: RoutePoint[], marks?: { at: string, kind: 'hide' | 'show' | 'offline' | 'online' }[] }} Itinerary
 *   start: an ISO date-time with an offset; everySec: a fix this often while moving (5); stillSec: while stopped (10);
 *   endMin: how long the track stays at the last stop (30); marks: the phone locked and unlocked, the connection lost and back
 * @typedef {{ lat: number, lng: number, accuracy: number, speed: number }} TrackFix
 * @typedef {{ at: number, kind: 'fix', fix: TrackFix } | { at: number, kind: 'hide' | 'show' | 'offline' | 'online' }} TrackEvent
 */

/** Meters in a degree of latitude. */
const DEG = (6_371_000 * Math.PI) / 180;

/** The point d meters along a path. @param {{ lat: number, lng: number }[]} path @param {number} d */
function along(path, d) {
  let left = d;
  for (let i = 1; i < path.length; i++) {
    const seg = meters(path[i - 1], path[i]);
    if (left <= seg || i === path.length - 1) {
      const f = seg ? Math.min(1, left / seg) : 1;
      return { lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * f, lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * f };
    }
    left -= seg;
  }
  return { lat: path[0].lat, lng: path[0].lng };
}

/**
 * A track from an itinerary: still at each stop (with a little GPS jitter), and at a steady speed
 * between stops along the route's points. The same itinerary gives the same track every time.
 * @param {Itinerary} it @returns {TrackEvent[]}
 */
export function trackFrom(it) {
  const start = Date.parse(it?.start ?? '');
  const offset = /([zZ]|[+-]\d\d:\d\d)$/.exec(String(it?.start ?? ''))?.[1];
  if (!Number.isFinite(start) || !offset || !/^\d{4}-\d{2}-\d{2}T/.test(it.start)) throw new Error('An itinerary needs a start: an ISO date-time with an offset, like 2026-11-27T08:30:00-08:00.');
  const route = Array.isArray(it.route) ? it.route : [];
  if (route.length < 2) throw new Error('An itinerary needs a route of at least two places.');
  const day = it.start.slice(0, 10);
  /** @param {string | undefined} hhmm @param {string} what */
  const time = (hhmm, what) => {
    const t = Date.parse(`${day}T${hhmm}:00${offset}`);
    if (!/^\d\d:\d\d$/.test(String(hhmm)) || !Number.isFinite(t)) throw new Error(`${what} needs a time like 09:30, not ${JSON.stringify(hhmm)}.`);
    return t;
  };
  const every = (it.everySec ?? 5) * 1000;
  const still = (it.stillSec ?? 10) * 1000;
  const accuracy = it.accuracy ?? 8;
  const stops = route.map((p, i) => ({ p, i })).filter(({ p, i }) => i === 0 || i === route.length - 1 || p.arrive !== undefined || p.leave !== undefined);
  /** @type {TrackEvent[]} */
  const out = [];
  let n = 0;
  const jitter = () => Math.sin(++n * 12.9898) * 3; // ± 3 m, the same every run
  /** @param {{ lat: number, lng: number }} p @param {number} from @param {number} to */
  const stay = (p, from, to) => {
    for (let t = from; t < to; t += still) {
      const dx = jitter();
      const dy = jitter();
      out.push({ at: t, kind: 'fix', fix: { lat: p.lat + dy / DEG, lng: p.lng + dx / (DEG * Math.cos((p.lat * Math.PI) / 180)), accuracy, speed: 0 } });
    }
  };
  let reached = start;
  for (let s = 0; s < stops.length; s++) {
    const { p, i } = stops[s];
    const name = p.name ?? `Stop ${s + 1}`;
    const arrive = s === 0 ? start : time(p.arrive, `${name}'s arrive`);
    if (arrive < reached) throw new Error(`${name} is reached before the drive there ends: check its times.`);
    const last = s === stops.length - 1;
    const leave = last ? arrive + (it.endMin ?? 30) * 60_000 : time(p.leave, `${name}'s leave`);
    if (leave < arrive) throw new Error(`${name} is left before it is reached: check its times.`);
    stay(p, arrive, last ? leave + 1 : leave);
    if (last) break;
    const next = stops[s + 1];
    const reach = time(next.p.arrive, `${next.p.name ?? `Stop ${s + 2}`}'s arrive`);
    if (reach <= leave) throw new Error(`${next.p.name ?? `Stop ${s + 2}`} is reached before the drive there ends: check its times.`);
    const path = route.slice(i, next.i + 1);
    const length = path.slice(1).reduce((sum, q, k) => sum + meters(path[k], q), 0);
    const speed = length / ((reach - leave) / 1000);
    for (let t = leave; t < reach; t += every) out.push({ at: t, kind: 'fix', fix: { ...along(path, speed * ((t - leave) / 1000)), accuracy, speed } });
    reached = reach;
  }
  for (const m of it.marks ?? []) out.push({ at: time(m.at, `The mark ${m.kind}`), kind: m.kind });
  // At the same moment a mark comes first: the phone is unlocked, then its GPS gives a fix.
  return out.sort((a, b) => a.at - b.at || (a.kind === 'fix' ? 1 : 0) - (b.kind === 'fix' ? 1 : 0));
}

/** A track played through sensors of its own (spec §13, §18). */
export class Simulation {
  /** The connection, as the simulation has it. */
  online = true;
  /** On screen, as the simulation has it. */
  shown = true;
  /** @type {Record<string, ((x: any) => void) | null>} */
  #emit = { location: null, visibility: null, connectivity: null };
  /** @type {(() => void)[]} */
  #offs;

  /** @param {{ registry: import('../registry.js').Registry, track: TrackEvent[] }} c */
  constructor({ registry, track }) {
    this.track = track;
    this.#offs = ['location', 'visibility', 'connectivity'].map((kind) => registry.add('simulation', 'sensor', {
      kind,
      start: (/** @type {(x: any) => void} */ fn) => {
        this.#emit[kind] = fn;
        if (kind === 'connectivity') fn(this.online);
        return () => { if (this.#emit[kind] === fn) this.#emit[kind] = null; };
      },
    }));
  }

  /** Sends one event to its sensor. A fix while the location sensor is off (locked, live mode off) goes nowhere. @param {TrackEvent} e */
  send(e) {
    if (e.kind === 'fix') this.#emit.location?.({ ...e.fix, source: 'sim' });
    else if (e.kind === 'hide' || e.kind === 'show') {
      this.shown = e.kind === 'show';
      this.#emit.visibility?.(this.shown);
    } else {
      this.online = e.kind === 'online';
      this.#emit.connectivity?.(this.online);
    }
  }

  /**
   * As fast as it can go, on a manual clock: each event at its time, settle() after each.
   * @param {import('./clock.js').ManualClock} clock @param {() => Promise<unknown>} [settle] @param {{ from?: number, to?: number }} [o]
   */
  async run(clock, settle = async () => {}, { from = -Infinity, to = Infinity } = {}) {
    for (const e of this.track) {
      if (e.at < from || e.at > to) continue;
      await clock.advanceTo(e.at, settle);
      this.send(e);
      await settle();
    }
  }

  /**
   * In real time on a clock: a scaledClock, ten times faster for a person watching (spec §18).
   * @param {import('./clock.js').Clock} clock @param {{ onEnd?: () => void }} [o] @returns {() => void} stops it
   */
  play(clock, { onEnd } = {}) {
    let i = 0;
    /** @type {any} */
    let handle = null;
    const step = () => {
      handle = null;
      while (i < this.track.length && this.track[i].at <= clock.now()) this.send(this.track[i++]);
      if (i >= this.track.length) {
        onEnd?.();
        return;
      }
      handle = clock.set(step, this.track[i].at - clock.now());
    };
    step();
    return () => {
      if (handle !== null) clock.clear(handle);
      i = this.track.length;
    };
  }

  /** Takes its sensors away. */
  dispose() {
    for (const off of this.#offs.splice(0)) off();
  }
}
```

In `plugins-official/scripted-model/index.js`:

1. The doc comment gains, after the `stream: true …` line:

```js
 * With a rules tunable instead ([{ match, reply, then, times }]), the step depends on what woke her: the first
 * rule whose match (a case-insensitive regular expression) finds the request's "woke for:" line replies; a call
 * that follows tool results gets its rule's then (default: sleep); times limits how often a rule answers.
```

2. In `activate`, after `const calls = new Map();`, add:

```js
  /** @type {Map<string, number>} how often each rule has answered, by endpoint and rule */
  const used = new Map();
  /**
   * The step for this call, from the rules (by what woke her) or the script (in turn).
   * @param {any} endpoint @param {any} request @param {number} n
   */
  const stepFor = (endpoint, request, n) => {
    const rules = Array.isArray(endpoint.tunables?.rules) ? endpoint.tunables.rules : null;
    if (!rules) {
      const script = Array.isArray(endpoint.tunables?.script) && endpoint.tunables.script.length ? endpoint.tunables.script : [{ text: '' }];
      return script[Math.min(n, script.length - 1)] ?? {};
    }
    const tail = String(request?.tail ?? '');
    const woke = /^woke for: (.*)$/m.exec(tail)?.[1] ?? tail;
    const last = request?.messages?.at(-1);
    const followUp = last?.role === 'user' && (last.parts ?? []).some((/** @type {any} */ p) => p.type === 'tool_result');
    const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
    let i = 0;
    for (const r of rules) {
      const key = `${endpoint.id}:${i++}`;
      if (typeof r?.match !== 'string' || !new RegExp(r.match, 'i').test(woke)) continue;
      if (typeof r.times === 'number' && (used.get(key) ?? 0) >= r.times && !followUp) continue;
      if (followUp) return r.then ?? sleep;
      used.set(key, (used.get(key) ?? 0) + 1);
      return r.reply ?? sleep;
    }
    return sleep;
  };
```

3. `run` takes the request (`async *run({ endpoint, signal, request })`), and its first lines become:

```js
      const n = calls.get(endpoint.id) ?? 0;
      calls.set(endpoint.id, n + 1);
      const step = stepFor(endpoint, request, n);
```

(the `script` constant goes, now inside `stepFor`).

In `plugins-official/scripted-model/annai-plugin.json`, `"version": "0.4.0"`. Run `npm run catalog`.

In `sw.js` `SHELL`, add `'/src/core/live/simulate.js'`.

In `README.md`, under the milestones, milestone 5 reads "in progress: watches, the plan's reminders, catch-up and reminders without a model, in the core and tested by a simulated Big Sur drive (5a); the phone's sensors and screens next (5b), then the offline pack (5c)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/live-simulate.test.js test/unit/live-big-sur.test.js`
Expected: PASS, 3 and 1 tests. Then `npm test` passes in full.

- [ ] **Step 5: Commit**

```bash
npm run catalog && npm run stamp && npm run check && git add src/core/live/simulate.js test/fixtures/live/big-sur.json test/unit/live-simulate.test.js test/unit/live-big-sur.test.js test/unit/agent-kit.js plugins-official/scripted-model catalog/plugins.json sw.js README.md && git commit -m "Trip simulation, and a simulated Big Sur drive from Monterey to Cambria that produces the expected wakes: driving, narration, arrivals, a detour replanned, a lost connection, a locked phone and running late (spec §13, §18, §20)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
