# Milestone 7a: After the Trip, the Core (Stamps, the Road, the Recap, Simulated Trips) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything milestone 7 needs below the screens (spec §13), tested in Node:
- **Stamps:** each arrival at a plan place or a named point of interest earns one, worked out from the log, never stored. Live mode writes an arrival's place name into its log entry when it fires.
- **The road:** where the user stayed and how they moved, from tens of thousands of location points, without a model: stays and moves, the track split where it jumps and thinned for drawing, where the user was at any moment, a flat equirectangular map.
- **The journey:** one read of a trip's log (by type, through the index) and files: the road, stamps, Shiori's cards, the user's words, typed or spoken, and photos. The recap and the replay both read it.
- **The recap:** the utility model writes `/trip/recap.md` from the journey in words and TSV (no raw track), notes, memory and a few photos. Shiori can tell it by voice.
- **Simulated trips:** a clock that plays at a speed (pause, faster, slower, move), shared by the replay's playback and the simulation; a track from a trip's recorded points; live mode and Shiori taken over by a simulation and given back; and a controller for Developer → "Simulate a trip" that runs a sample, an itinerary or a recorded track in a new trip of its own.
- **Done when (§20 row 7), in Node:** the Big Sur drive is simulated through the machinery, then recapped by the scripted model into `/trip/recap.md`, and its journey has the stops, the five stamps and the cards.

**Architecture:**
- `src/core/after/` holds what is new and pure or nearly so: `stamps.js`, `route.js`, `journey.js`, `recap.js`.
- `src/core/live/clock.js` gains `PlayClock`; `src/core/live/simulate.js` gains `trackFromLog` and a stoppable `run`; `src/core/live/sim-run.js` is the controller.
- `Live` gains `simulate()` (a clock, a zone and only the simulation's sensors, for a while) and names arrivals; the `Agent` gains `useClock()`, `working`, entries stamped with its own clock, and the `recap` wake that is spoken even with voice off.
- `src/core/store-idb.js` reads a type's entries with `getAll` when there is no limit: a five-day trip's points come in one request, not one callback each.
- Milestone 7b (`2026-10-16-m7b-after-the-trip-screens.md`) puts the screens on this: stamps on trip cards, Recap, Replay, Simulate a trip, the e2e tests and the device checklist.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26); the store contract also runs against IndexedDB in Chromium and WebKit (Playwright 1.63.0 in Docker).

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`: §13 (recap, replay, stamps, trip simulation), §4.5 (location points, refs), §4.7 (lists as TSV), §4.8 (request copies, request sizes), §4.9 (everything stored is named), §6.1 and §6.5 (wakes; the maximum request size), §9.6 (roles: utility; fallback), §10 (Shiori telling it by voice), §11 (arrived, plan places, the offline pack's names), §11.7 (where location goes), §18 (trip simulation), §20 row 7.

**Not in this plan (7b):** the screens (trip cards with stamps, Recap, Replay, Settings → Developer → Simulate a trip, the live chip during a simulation), the end-to-end tests, the device checklist and the README.

## Choices this plan makes (please check them)

1. **What earns a stamp:** the plan's own "arrived", Shiori's `arrived` watches, and the plan's "stopped somewhere not on the plan" (an arrival too, just not a planned one), each only when it fires at a plan place (within 300 m) or a point of interest the offline pack names (within 500 m). Live mode writes that name into the `trigger.fired` entry as it fires, so stamps come from the log alone. *Cost if wrong:* a stop at a famous place without an offline pack, and without Shiori's arrived watch, earns no stamp; widening this is one function.
2. **One place earns one stamp a day,** so the plan's arrival and Shiori's watch firing at the same visit make one stamp, and the hotel earns one each night. *Cost if wrong:* the count reads "each visit" instead.
3. **A stamp's words:** two characters of a Chinese, Japanese or Korean name (the mockup's 伏見 and 嵐山); otherwise the first word, with the next one when the first has three letters or fewer ("Big Sur", "San Simeon"), at most 12 characters. The full name is always there for screen readers.
4. **What goes to the utility model for the recap** (§11.7: location goes to the user's own model provider): the trip's title, dates and party; `/me/profile.md`; each day's stays of 10 minutes or more (named, or for an unnamed one its position rounded to 3 decimals, about 100 m) and the moves between in km and minutes; the stamps; the plan's items and whether they were visited; Shiori's cards and the user's typed and spoken words (each cut to 300 characters); the photo list (time, path, where, size); `/trip/notes/` and `/trip/memory.md` (each cut to 4000 characters); and up to 6 photos as request copies, only when every model of the role takes photos, and at most half the maximum request size (§6.5). **No location point goes as it is.** The text is capped at 60,000 characters: the words are thinned evenly first. *Cost if wrong:* a recap that misses a quiet day's detail; each limit is a constant.
5. **The recap is written when the user taps for it** (7b's Recap screen), never by itself, by the utility role (empty: the main list, §9.6), with the old version kept in the file's history when written again. It is Markdown at `/trip/recap.md`, author `shiori`; a `recap` log entry names the photo copies it sent (§4.9).
6. **Telling it by voice:** a wake of a new kind, `recap`, that is the user's tap (budgets don't hold it). Shiori is asked to read `/trip/recap.md` and tell it with `speak`; that turn is spoken even when voice mode is off, since the tap asks for her voice, and she listens after each part as any spoken turn does. The voice setting itself doesn't change. *Cost if wrong:* the microphone opens after she speaks with voice mode off; the alternative is a bubble.
7. **Stays and moves:** a stay is 10 minutes or more within 200 m of where it began, placed where most of its time went. Where the track jumps (two points 1 km or more apart after 10 minutes or more: the phone was locked or annai closed; or 20 km or more apart at any time: a flight), the move between is marked as partly unseen, and the replay draws it dashed. A move under 8 km/h on average is a walk.
8. **The drawn route is thinned** (Douglas–Peucker, its tolerance doubled until at most 1,500 points are left), piece by piece between jumps. Positions in the replay come from the drawn route, so the marker stays on the line.
9. **A simulation runs in a new trip of its own,** "<name> (simulation)", with the itinerary's (or the recorded trip's) plan and bookings, so the user's trips are never touched; when it ends, the trip open before opens again. It can be removed like any trip.
10. **During a simulation, live mode is the simulation's:** its clock and zone, its sensors only (the phone's GPS stops; the phone's own visibility and connection are not heard), and live mode on for it without saving the switch; afterwards live mode is as the user left it. **Shiori wakes with the user's own models,** as she would on the road (the Big Sur sample wakes her about 24 times; a scripted model in Settings → Models makes it free). **Opening another trip stops the simulation,** that trip stays open, and nothing of the simulation is written into it.
11. **Simulated time:** while a simulation runs, the Agent's clock is the simulation's, so the conversation's entries are stamped in simulated time and the replay lines up. The model calls' trace entries keep the real time. Outside a simulation the Agent's clock is the device's, as before.
12. **Sources:** the Big Sur sample (moved from `test/fixtures/live/big-sur.json` to `assets/simulations/big-sur.json`, so the screen and the tests use one file), an itinerary file in that format, or the recorded track of a trip on this device. A recorded track gets still fixes every 10 seconds where the log kept none (the user was stopped), and the phone marked locked where the track jumps, so catch-up runs as it did.
13. **Speeds:** 10× (the default, §18), 60× and 600×, or as fast as it can go (a manual clock, each step settled before the next, as the tests run). Pause and the speed can change while it plays; as fast as it can go only pauses.
14. **Reading by type without a limit uses IndexedDB's `getAll`** on the type index: one request per type instead of one callback per entry.
15. **The size budget** is raised in 7b, where the screens add most of the code; 7a's modules fit in what is left (13 KiB), checked at each commit. If one doesn't, Task 7 raises it and says by how much.

## Global Constraints

- All of milestone 5's Global Constraints hold (`docs/superpowers/plans/2026-10-16-m5a-live-core.md`, `2026-10-16-m5b-live-on-the-phone.md`, `2026-10-16-m5c-offline-pack.md`). In particular:
  - Model output never goes into `innerHTML`; no `style` attribute is set.
  - Every write is one transaction; everything stored is named by a file or a log entry (§4.9).
  - Every file under `src/` and `assets/` is listed in `sw.js` `SHELL` (a unit test checks this). Run `npm run stamp` after any shipped file changes, and `npm run catalog` after changing `plugins-official/`.
  - Keys never appear in context, files, events or the trace.
- **"Recap. The utility model summarizes the event log, notes and photos into a recap stored as `/trip/recap.md`. Shiori can tell it by voice" (§13).**
- **"Stamps. Each `arrived` event at a plan place or point of interest earns a stamp, shown on trip cards and in replay. Stamps are computed from the log, not stored" (§13).**
- **"Trip simulation. Developer → 'Simulate a trip' feeds a recorded or fake GPS track and clock through the same machinery. Replay and testing share it" (§13).** "a GPS track plus a fake clock at 10× speed" (§18).
- **"Location otherwise goes only to the user's own model provider" (§11.7).** The recap sends places and times to the user's utility model, never the raw track.
- **"Flat homogeneous lists … TSV with a header row" (§4.7).**
- **"The maximum request size (Settings; default 8 MiB)… Photos count at their base64 size" (§6.5).**
- **"Each role is an ordered list of models… Empty chat roles fall back to the main list" (§9.6).**
- **Scale:** a five-day trip has tens of thousands of location points. They are read by type through the index (`listEvents` with `types`), never by walking the log; nothing here sends them to a model.
- **Timers:** `setTimeout` overflows above 2³¹−1 ms; `realClock` waits in steps, and `PlayClock` uses it.
- **A server's answer** is read through `readAnswer`/`answerJSON` or guarded; nothing here reads one directly.
- **Copy:** plain words; every error says what happened and what to do next; system cards are never in Shiori's voice (§16.1).
- **Work in the worktree** `.claude/worktrees/m7-after`, branch `m7-after`. Before every commit, `npm run stamp && npm run check` must pass, chained with `&&`. Commit messages end with the two attribution lines.

## Review Focus

1. **Logs that are empty, tiny or odd:** no points, one point, every point at one spot, a trip over the date line: no stays or one, a route of one piece, a map that fits, nothing throws. Pinned in Tasks 2 and 3.
2. **A five-day trip** (tens of thousands of points): legs, thinning and the journey in a second or two, and a recap request under its cap with no raw points in it. Pinned in Tasks 2 and 4.
3. **Broken entries in the log:** a location without coordinates, a `trigger.fired` without a place, a card that isn't an object, a heard segment whose words never came, a photo without `taken`: left out or placed by when it was added; nothing throws. Pinned in Task 3.
4. **A simulation stopped midway, or failing** (a broken itinerary, a plan item annai can't store): live mode, both clocks and the open trip come back as before; the user's live switch is never saved by it; a broken itinerary creates no trip. Pinned in Task 7.
5. **The utility model missing, failing, taking no photos, or answering empty:** a plain error that says what to do, nothing written, no copy stored unnamed. Pinned in Task 4.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/after/stamps.js`, `src/core/live/live.js` | 1 | `isArrival`, `stampsOf`, `stampLabel`; arrivals named as they fire |
| `src/core/after/route.js` | 2 | `pointsOf`, `jumps`, `segmentsOf`, `legsOf`, `thin`, `positionAt`, `fractionAt`, `fit` |
| `src/core/after/journey.js`, `src/core/store-idb.js`, `test/contract/store-contract.js` | 3 | `readJourney`, `takenAt`, `JOURNEY_TYPES`; `getAll` for a type without a limit |
| `src/core/after/recap.js` | 4 | `recapText`, `recapPhotos`, `writeRecap`, `RECAP_FILE`, `RECAP_SYSTEM`, `TELL_RECAP` |
| `src/core/agent/loop.js`, `assets/simulations/big-sur.json`, `test/unit/big-sur-kit.js` | 5 | the `recap` wake, spoken; the sample moved; the Big Sur drive simulated and recapped |
| `src/core/live/clock.js`, `src/core/live/simulate.js` | 6 | `PlayClock`; `trackFromLog`; `run` with `signal` and `gate` |
| `src/core/live/live.js`, `src/core/agent/loop.js`, `src/core/live/sim-run.js` | 7 | `Live.simulate`, `simulating`; `Agent.useClock`, `working`, entries in its time; `SimRun`, `SPEEDS` |

---

### Task 1: Stamps, from the log

**Files:**
- Create: `src/core/after/stamps.js`
- Modify: `src/core/live/live.js` (`#fire` writes an arrival's place name), `sw.js` (`SHELL`)
- Test: `test/unit/after-stamps.test.js`

**Interfaces:**
- Consumes: `dayIn(ms, tz)` from `src/core/time.js`; `meters` from `src/core/live/geo.js`.
- Produces: `isArrival(data): boolean`; `stampsOf(fired: { ts: number, data?: any }[], tz: string): Stamp[]` with `Stamp = { name: string, lat: number, lng: number, at: number, plan: boolean }`; `stampLabel(name: string): string`; `STAMP_PLAN_M = 300`, `STAMP_POI_M = 500` exported from `live.js`.

- [ ] **Step 1: Write the failing tests**

`test/unit/after-stamps.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampsOf, stampLabel, isArrival } from '../../src/core/after/stamps.js';
import { meters } from '../../src/core/live/geo.js';
import { liveKit, at, iso, LA, MONTEREY, RIVER_INN, NEPENTHE, MCWAY } from './live-kit.js';

const fired = (/** @type {string} */ hhmm, /** @type {any} */ data, day = '2026-11-27') => ({ ts: at(hhmm, day), data });
const place = (/** @type {string | undefined} */ name, /** @type {{ lat: number, lng: number }} */ p) => ({ ...(name ? { name } : {}), lat: p.lat, lng: p.lng });

test('each arrival at a named place earns a stamp, one a place a day, oldest first (spec §13)', () => {
  const log = [
    fired('11:00', { type: 'plan', event: 'linger', place: place('Big Sur River Inn', RIVER_INN) }),
    fired('09:40', { type: 'plan', event: 'arrived', watch: 'plan:nepenthe:arrived', place: place('Nepenthe', NEPENTHE) }),
    fired('09:41', { type: 'arrived', place: place('Nepenthe', NEPENTHE) }), // the same visit, by Shiori's watch
    fired('10:30', { type: 'arrived', place: place(undefined, MCWAY) }), // nowhere named: no stamp
    fired('11:30', { type: 'plan', event: 'leave', place: place('Hearst Castle', MCWAY) }), // not an arrival
    fired('08:00', { type: 'plan', event: 'arrived', place: place('Nepenthe', NEPENTHE) }, '2026-11-28'), // the next day: another
    { ts: at('12:00'), data: { type: 'arrived', place: { name: 'Broken', lat: 'x', lng: 1 } } },
    { ts: at('12:01') }, { ts: at('12:02'), data: null },
  ];
  assert.deepEqual(stampsOf(log, LA).map((s) => [s.name, s.plan, new Date(s.at).toISOString()]), [
    ['Nepenthe', true, '2026-11-27T17:40:00.000Z'],
    ['Big Sur River Inn', false, '2026-11-27T19:00:00.000Z'],
    ['Nepenthe', true, '2026-11-28T16:00:00.000Z'],
  ]);
  assert.equal(isArrival({ type: 'plan', event: 'late' }), false);
  assert.equal(isArrival(undefined), false);
});

test("a stamp's words: the first word, two when the first is short, two characters of a Japanese name", () => {
  assert.equal(stampLabel('Bixby Creek Bridge'), 'Bixby');
  assert.equal(stampLabel('Big Sur River Inn'), 'Big Sur');
  assert.equal(stampLabel('San Simeon pier'), 'San Simeon');
  assert.equal(stampLabel('伏見稲荷大社'), '伏見');
  assert.equal(stampLabel('Cambria Pines Lodge'), 'Cambria');
  assert.equal(stampLabel('Llanfairpwllgwyngyll'), 'Llanfairpwll');
  assert.equal(stampLabel('  '), '');
});

test('live mode names an arrival as it fires: a plan place within 300 m, else a place the offline pack names (spec §13)', async () => {
  const k = await liveKit({ plan: { nepenthe: { title: 'Dinner at Nepenthe', fixed: false, start: { at: iso('16:00'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } } } });
  k.live.namers.push((p) => (meters(p, RIVER_INN) <= 500 ? { name: 'Big Sur River Inn', m: meters(p, RIVER_INN) } : null));
  await k.live.setWatch(k.trip, { when: { type: 'arrived', minutes: 5 }, repeat: true, fallback: 'Here.' });
  await k.drive(MONTEREY, RIVER_INN, at('09:00'), at('09:40'));
  await k.stay(RIVER_INN, at('09:40'), at('09:50'));
  await k.drive(RIVER_INN, NEPENTHE, at('09:50'), at('10:00'));
  await k.stay(NEPENTHE, at('10:00'), at('10:10'));
  await k.drive(NEPENTHE, MCWAY, at('10:10'), at('10:25'));
  await k.stay(MCWAY, at('10:25'), at('10:35'));
  const names = (await k.events(['trigger.fired'])).filter((e) => e.data.type === 'arrived').map((e) => e.data.place.name ?? null);
  assert.deepEqual(names, ['Big Sur River Inn', 'Nepenthe', null]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/after-stamps.test.js`
Expected: FAIL: `Cannot find module '…/src/core/after/stamps.js'`.

- [ ] **Step 3: Write the code**

`src/core/after/stamps.js`:
```js
import { dayIn } from '../time.js';

/**
 * Stamps (spec §13), like a station stamp book: each arrival at a plan place or a named point of
 * interest earns one. They are worked out from the log's trigger.fired entries whenever they are
 * shown, and never stored. Live mode writes an arrival's place name into its entry as it fires
 * (choice 1); one place earns one stamp a day (choice 2).
 * @typedef {{ name: string, lat: number, lng: number, at: number, plan: boolean }} Stamp
 *   plan: the arrival was the plan's own, at a plan item's place
 */

/**
 * Whether a trigger.fired entry's data is an arrival: the plan's "arrived", the plan's "stopped
 * somewhere not on the plan", or an arrived watch (choice 1). @param {any} d
 */
export function isArrival(d) {
  return d?.type === 'arrived' || (d?.type === 'plan' && (d.event === 'arrived' || d.event === 'linger'));
}

/** @param {unknown} v @returns {v is number} */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The stamps a trip has earned, oldest first.
 * @param {{ ts: number, data?: any }[]} fired its trigger.fired entries
 * @param {string} tz the trip's zone: a place earns one stamp a day there
 * @returns {Stamp[]}
 */
export function stampsOf(fired, tz) {
  /** @type {Stamp[]} */
  const out = [];
  const seen = new Set();
  for (const e of [...fired].sort((a, b) => (a?.ts ?? 0) - (b?.ts ?? 0))) {
    const d = e?.data;
    const p = d?.place;
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (!isArrival(d) || !name || !finite(p.lat) || !finite(p.lng) || !finite(e.ts)) continue;
    const key = `${name.toLowerCase()}\n${dayIn(e.ts, tz)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, lat: p.lat, lng: p.lng, at: e.ts, plan: d.type === 'plan' && d.event === 'arrived' });
  }
  return out;
}

const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * The words on a stamp (choice 3): two characters of a Chinese, Japanese or Korean name; otherwise
 * the first word, with the next when the first has three letters or fewer, at most 12 characters.
 * @param {string} name
 */
export function stampLabel(name) {
  const n = String(name ?? '').trim();
  if (CJK.test(n)) return [...n].slice(0, 2).join('');
  const words = n.split(/\s+/).filter(Boolean);
  let label = words[0] ?? '';
  if ([...label].length <= 3 && words[1]) label = `${label} ${words[1]}`;
  return [...label].slice(0, 12).join('');
}
```

In `src/core/live/live.js`, import `isArrival`:
```js
import { isArrival } from '../after/stamps.js';
```
add the two constants after `LATE_MS`:
```js
/** An arrival's place is named for its stamp (spec §13) by a plan place this close… */
export const STAMP_PLAN_M = 300;
/** …or by a place a namer (the offline pack) knows this close (choice 1). */
export const STAMP_POI_M = 500;
```
In `#fire`, name the place before the entry is written. Replace
```js
      const key = this.#key(x.scope, x.watch.id);
      const f = x.firing;
```
with
```js
      const key = this.#key(x.scope, x.watch.id);
      const f = { ...x.firing, place: this.#stampPlace(x.watch, x.firing.place) };
```
and add the method after `#reason`:
```js
  /**
   * An arrival's place, named when it is at a plan place or a place a namer knows, so its stamp
   * comes from the log alone (spec §13, choice 1). Other places are as they came.
   * @param {Watch} w @param {import('./triggers.js').Place | undefined} p
   */
  #stampPlace(w, p) {
    if (!p || p.name || !isArrival({ type: w.when?.type, event: /** @type {any} */ (w.when)?.event })) return p;
    /** @type {{ name: string, m: number } | null} */
    let best = null;
    for (const q of this.#places) {
      const d = meters(p, q);
      if (d <= STAMP_PLAN_M && (!best || d < best.m)) best = { name: q.name, m: d };
    }
    if (!best) {
      for (const n of this.namers) {
        try {
          const r = n(p);
          if (r && r.m <= STAMP_POI_M && (!best || r.m < best.m)) best = r;
        } catch {
          // a namer that fails names nothing
        }
      }
    }
    return best ? { name: best.name, ...p } : p;
  }
```
`f.place` is then what the entry, `#fired` and the watch's memory keep, as before.

In `sw.js`, add `'/src/core/after/stamps.js',` to `SHELL` (alphabetical, before `/src/core/agent/…`).

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/after-stamps.test.js test/unit/live-engine.test.js test/unit/live-big-sur.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/after/stamps.js src/core/live/live.js sw.js test/unit/after-stamps.test.js && git commit -m "Stamps: each arrival at a plan place or a place the offline pack names earns one, a place a day, worked out from the log; live mode writes the place's name into the arrival as it fires

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 2: The road: stays, moves, the drawn route, a flat map

**Files:**
- Create: `src/core/after/route.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/after-route.test.js`, and `test/unit/after-kit.js` (the morning's road, which the journey, recap and replay tests share; a kit, not a test file, so importing it runs no tests twice)

**Interfaces:**
- Consumes: `meters` from `src/core/live/geo.js`.
- Produces: `Point = { lat, lng, at, accuracy?, speed? }`; `Leg = { kind: 'stay', lat, lng, from, to } | { kind: 'move', from, to, km, mode: 'drive' | 'walk', gap: boolean }`; `pointsOf(events): Point[]`; `jumps(a, b): boolean`; `segmentsOf(points): Point[][]`; `legsOf(points): Leg[]`; `thin(segments, max = DRAWN): Point[][]`; `positionAt(segments, t): { lat, lng } | null`; `fractionAt(segment, t, dist = meters): number` (0..1 of its length, measured by dist); `fit(points, o?): { width, height, xy(p): [number, number] }`; constants `STAY_M`, `STAY_MIN`, `JUMP_M`, `JUMP_MIN`, `FAR_M`, `WALK_KMH`, `DRAWN`.

- [ ] **Step 1: Write the failing tests**

`test/unit/after-kit.js`:
```js
import { at, off, MONTEREY, BIXBY, RIVER_INN, NEPENTHE, HEARST } from './live-kit.js';

/** Points from a to b between t0 and t1 (t1 left out), one every sec seconds, as the log keeps them while moving. */
export function road(/** @type {{ lat: number, lng: number }} */ a, /** @type {{ lat: number, lng: number }} */ b, /** @type {number} */ t0, /** @type {number} */ t1, sec = 5) {
  const out = [];
  for (let t = t0; t < t1; t += sec * 1000) {
    const f = (t - t0) / (t1 - t0);
    out.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, at: t });
  }
  return out;
}
const LEAVING_BIXBY = off(BIXBY, 40, 0);
/** A morning on Highway 1: a stop at Bixby Bridge, five minutes at the River Inn, the phone locked at Nepenthe until Hearst Castle. */
export const MORNING = [
  ...road(MONTEREY, BIXBY, at('09:00'), at('09:30')),
  { ...BIXBY, at: at('09:30') }, { ...LEAVING_BIXBY, at: at('09:50') }, // stopped 20 min: the log kept the arrival, then the leaving
  ...road(LEAVING_BIXBY, RIVER_INN, at('09:50:05'), at('10:08')),
  { ...RIVER_INN, at: at('10:08') }, { ...off(RIVER_INN, 0, 30), at: at('10:13') }, // 5 min: not a stay
  ...road(off(RIVER_INN, 0, 30), NEPENTHE, at('10:13:05'), at('10:30')),
  { ...NEPENTHE, at: at('10:30') }, // the phone locked here…
  { ...HEARST, at: at('16:40') }, { ...off(HEARST, 20, 20), at: at('18:15') }, // …and unlocked at Hearst Castle
];
```

`test/unit/after-route.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointsOf, segmentsOf, legsOf, thin, positionAt, fractionAt, fit, jumps } from '../../src/core/after/route.js';
import { meters } from '../../src/core/live/geo.js';
import { at, off, MONTEREY, BIXBY, NEPENTHE, HEARST, CAMBRIA } from './live-kit.js';
import { road, MORNING } from './after-kit.js';

const MIN = 60_000;

test('location entries as points, in time order; entries that are not a position are left out', () => {
  const pts = pointsOf([
    { ts: 3, data: { lat: 36.1, lng: -121.6, accuracy: 8, speed: 12.5 } }, { ts: 1, data: { lat: 36, lng: -121.5 } },
    { ts: 2, data: { lat: 'x', lng: 1 } }, { ts: 4 }, { ts: 5, data: { lat: 91, lng: 0 } }, { ts: NaN, data: { lat: 1, lng: 1 } },
  ]);
  assert.deepEqual(pts, [{ lat: 36, lng: -121.5, at: 1 }, { lat: 36.1, lng: -121.6, at: 3, accuracy: 8, speed: 12.5 }]);
});

test('stays of 10 minutes or more, placed where the time went, and the moves between; a jump makes a move partly unseen (choice 7)', () => {
  const legs = legsOf(MORNING);
  assert.deepEqual(legs.map((l) => l.kind), ['move', 'stay', 'move', 'stay']);
  const [drive, bixby, on, castle] = /** @type {any[]} */ (legs);
  assert.equal(drive.mode, 'drive');
  assert.ok(Math.abs(drive.km - meters(MONTEREY, BIXBY) / 1000) < 1, String(drive.km));
  assert.equal(drive.gap, false);
  assert.deepEqual([bixby.lat, bixby.lng], [BIXBY.lat, BIXBY.lng]);
  assert.ok(Math.abs(bixby.from - at('09:30')) <= 30_000 && Math.abs(bixby.to - at('09:50')) <= 30_000);
  assert.equal(on.gap, true); // the phone was locked from Nepenthe to Hearst Castle
  assert.equal(on.from, bixby.to);
  assert.deepEqual([castle.lat, castle.lng, castle.from, castle.to], [HEARST.lat, HEARST.lng, at('16:40'), at('18:15')]);
});

test('walking is a walk; nothing, one point, or every point at one spot is no move', () => {
  const walk = [{ ...MONTEREY, at: at('08:00') }, { ...MONTEREY, at: at('08:20') }, ...road(MONTEREY, off(MONTEREY, 2000, 0), at('08:20:05'), at('08:45'), 10)];
  assert.deepEqual(legsOf(walk).map((l) => [l.kind, /** @type {any} */ (l).mode ?? '']), [['stay', ''], ['move', 'walk']]);
  assert.deepEqual(legsOf([]), []);
  assert.deepEqual(legsOf([{ ...MONTEREY, at: 0 }]), []);
  assert.deepEqual(legsOf([{ ...MONTEREY, at: 0 }, { ...off(MONTEREY, 10, 0), at: 5 * MIN }]), []);
});

test('the track splits where it jumps: the phone locked, or a flight', () => {
  assert.deepEqual(segmentsOf(MORNING).map((s) => s.length), [MORNING.length - 2, 2]);
  assert.equal(jumps({ ...MONTEREY, at: 0 }, { ...CAMBRIA, at: 60_000 }), true); // 150 km in a minute
  assert.equal(jumps({ ...MONTEREY, at: 0 }, { ...off(MONTEREY, 900, 0), at: 30 * MIN }), false);
  assert.deepEqual(segmentsOf([]), []);
});

test('the drawn route keeps at most 1500 points, its ends, and its shape, quickly even for a five-day trip (choice 8)', () => {
  /** @type {any[]} */
  const wiggly = [];
  for (let i = 0; i < 50_000; i++) wiggly.push({ lat: 36 + i * 1e-5, lng: -121.5 + Math.sin(i / 50) * 0.01, at: i * 5000 });
  const t0 = performance.now();
  const drawn = thin(segmentsOf(wiggly));
  const ms = performance.now() - t0;
  const n = drawn.reduce((s, x) => s + x.length, 0);
  assert.ok(n <= 1500 && n > 200, String(n));
  assert.deepEqual(drawn[0][0], wiggly[0]);
  assert.deepEqual(drawn.at(-1)?.at(-1), wiggly.at(-1));
  assert.ok(ms < 3000, `${Math.round(ms)} ms`);
  assert.deepEqual(thin([[{ lat: 1, lng: 1, at: 0 }]]), [[{ lat: 1, lng: 1, at: 0 }]]);
});

test('where the user was at a moment: between points by the time; held during a jump; the ends before and after', () => {
  const drawn = thin(segmentsOf(MORNING));
  const mid = /** @type {{ lat: number, lng: number }} */ (positionAt(drawn, at('09:15')));
  assert.ok(Math.abs(mid.lat - (MONTEREY.lat + BIXBY.lat) / 2) < 0.01, String(mid.lat));
  assert.deepEqual(positionAt(drawn, at('12:00')), { lat: NEPENTHE.lat, lng: NEPENTHE.lng });
  assert.deepEqual(positionAt(drawn, at('06:00')), { lat: MONTEREY.lat, lng: MONTEREY.lng });
  assert.deepEqual(positionAt(drawn, at('23:00')), { lat: off(HEARST, 20, 20).lat, lng: off(HEARST, 20, 20).lng });
  assert.equal(positionAt([], 0), null);
  assert.equal(fractionAt(drawn[0], at('08:00')), 0);
  assert.equal(fractionAt(drawn[0], at('11:00')), 1);
  const half = fractionAt(drawn[0], at('09:15'));
  assert.ok(half > 0.3 && half < 0.6, String(half));
});

test('a flat map: north up, west left, inside its padding; one point sits in the middle; the date line is crossed, not wrapped', () => {
  const m = fit([MONTEREY, CAMBRIA, BIXBY], { width: 1000, pad: 40 });
  const [mx, my] = m.xy(MONTEREY);
  const [cx, cy] = m.xy(CAMBRIA);
  assert.ok(my < cy, 'Monterey is north of Cambria');
  assert.ok(mx < cx, 'Monterey is west of Cambria');
  for (const [x, y] of [[mx, my], [cx, cy]]) assert.ok(x >= 39 && x <= 961 && y >= 39 && y <= m.height - 39, `${x},${y}`);
  assert.ok(m.height >= 500 && m.height <= 1300, String(m.height));
  const one = fit([MONTEREY], { width: 1000 });
  assert.deepEqual(one.xy(MONTEREY), [500, one.height / 2]);
  const fiji = fit([{ lat: -17, lng: 179.9 }, { lat: -17.1, lng: -179.9 }], { width: 1000 });
  const [ax] = fiji.xy({ lat: -17, lng: 179.9 });
  const [bx] = fiji.xy({ lat: -17.1, lng: -179.9 });
  assert.ok(bx > ax && bx - ax < 960, `${ax} ${bx}`);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/after-route.test.js`
Expected: FAIL: `Cannot find module '…/src/core/after/route.js'`.

- [ ] **Step 3: Write the code**

`src/core/after/route.js`:
```js
import { meters } from '../live/geo.js';

/**
 * The road a trip took, from its location points (spec §4.5, §13): where the user stayed and how
 * they moved between, the track split where it jumps and thinned for drawing, where they were at
 * any moment, and a flat map of it (equirectangular, no tiles). A five-day trip's tens of thousands
 * of points are fine: each step is a pass or a few over them.
 * @typedef {{ lat: number, lng: number, at: number, accuracy?: number, speed?: number }} Point
 * @typedef {{ kind: 'stay', lat: number, lng: number, from: number, to: number }} Stay
 * @typedef {{ kind: 'move', from: number, to: number, km: number, mode: 'drive' | 'walk', gap: boolean }} Move
 *   gap: the track jumps on the way (the phone was locked, annai closed, a flight), so km is what was seen
 * @typedef {Stay | Move} Leg
 */

/** A stay is within this many meters… */
export const STAY_M = 200;
/** …for at least this many minutes (choice 7). */
export const STAY_MIN = 10;
/** The track jumps where two points are this far apart after this long… */
export const JUMP_M = 1000;
export const JUMP_MIN = 10;
/** …or this far apart at any time (a flight). */
export const FAR_M = 20_000;
/** Slower than this on average is walking. */
export const WALK_KMH = 8;
/** At most this many points are drawn (choice 8). */
export const DRAWN = 1500;
const MIN = 60_000;
/** Meters in a degree of latitude. */
const DEG = (6_371_000 * Math.PI) / 180;
/** @param {number} d */
const rad = (d) => (d * Math.PI) / 180;
/** @param {unknown} v @returns {v is number} */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The location points of a log, in time order; an entry that isn't a position is left out. @param {{ ts: number, data?: any }[]} events @returns {Point[]} */
export function pointsOf(events) {
  /** @type {Point[]} */
  const out = [];
  for (const e of events) {
    const d = e?.data;
    if (!d || !finite(d.lat) || !finite(d.lng) || Math.abs(d.lat) > 90 || Math.abs(d.lng) > 180 || !finite(e.ts)) continue;
    out.push({ lat: d.lat, lng: d.lng, at: e.ts, ...(finite(d.accuracy) ? { accuracy: d.accuracy } : {}), ...(finite(d.speed) ? { speed: d.speed } : {}) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Whether the track jumps from a to b (choice 7). @param {Point} a @param {Point} b */
export function jumps(a, b) {
  const d = meters(a, b);
  return d >= FAR_M || (d >= JUMP_M && b.at - a.at >= JUMP_MIN * MIN);
}

/** The track in pieces, split where it jumps. @param {Point[]} points @returns {Point[][]} */
export function segmentsOf(points) {
  /** @type {Point[][]} */
  const out = [];
  /** @type {Point[]} */
  let cur = [];
  for (const p of points) {
    if (cur.length && jumps(cur[cur.length - 1], p)) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Where the user stayed and how they moved between (choice 7): a stay is STAY_MIN minutes or more
 * within STAY_M of where it began, placed at the point that waited longest for the next; a move is
 * what lies between, from a stay's last point to the next one's first.
 * @param {Point[]} points in time order @returns {Leg[]}
 */
export function legsOf(points) {
  const n = points.length;
  /** @type {{ i: number, j: number, best: number }[]} */
  const runs = [];
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && meters(points[i], points[j + 1]) <= STAY_M) j++;
    if (j > i && points[j].at - points[i].at >= STAY_MIN * MIN) {
      let best = i;
      for (let k = i; k < j; k++) if (points[k + 1].at - points[k].at > points[best + 1].at - points[best].at) best = k;
      runs.push({ i, j, best });
      i = j + 1;
    } else i++;
  }
  /** @type {Leg[]} */
  const legs = [];
  /** @param {number} a @param {number} b */
  const move = (a, b) => {
    let m = 0;
    let ms = 0;
    let gap = false;
    for (let k = a + 1; k <= b; k++) {
      if (jumps(points[k - 1], points[k])) gap = true;
      else {
        m += meters(points[k - 1], points[k]);
        ms += points[k].at - points[k - 1].at;
      }
    }
    if (m < 100) return;
    const kmh = ms > 0 ? m / 1000 / (ms / 3_600_000) : Infinity;
    legs.push({ kind: 'move', from: points[a].at, to: points[b].at, km: Math.round(m / 100) / 10, mode: kmh < WALK_KMH ? 'walk' : 'drive', gap });
  };
  let last = 0;
  for (const r of runs) {
    move(last, r.i);
    const p = points[r.best];
    legs.push({ kind: 'stay', lat: p.lat, lng: p.lng, from: points[r.i].at, to: points[r.j].at });
    last = r.j;
  }
  if (n) move(last, n - 1);
  return legs;
}

/** Meters from p to the line from a to b, in a flat local frame. @param {number[]} p @param {number[]} a @param {number[]} b */
function off(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Douglas–Peucker over one piece, without recursion. @param {Point[]} s @param {number[][]} xy @param {number} eps meters */
function simplify(s, xy, eps) {
  if (s.length <= 2) return [...s];
  const keep = new Uint8Array(s.length);
  keep[0] = 1;
  keep[s.length - 1] = 1;
  /** @type {[number, number][]} */
  const stack = [[0, s.length - 1]];
  while (stack.length) {
    const [a, b] = /** @type {[number, number]} */ (stack.pop());
    let best = -1;
    let far = eps;
    for (let k = a + 1; k < b; k++) {
      const d = off(xy[k], xy[a], xy[b]);
      if (d > far) {
        far = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return s.filter((_, k) => keep[k]);
}

/**
 * The track thinned for drawing (choice 8), piece by piece: Douglas–Peucker, its tolerance doubled
 * until at most max points are left. Every piece keeps its two ends.
 * @param {Point[][]} segments @param {number} [max] @returns {Point[][]}
 */
export function thin(segments, max = DRAWN) {
  const total = segments.reduce((n, s) => n + s.length, 0);
  if (total <= max) return segments.map((s) => [...s]);
  const all = segments.flat();
  const lat0 = all.reduce((sum, p) => sum + p.lat, 0) / all.length;
  const kx = Math.cos(rad(lat0)) * DEG;
  const xy = segments.map((s) => s.map((p) => [p.lng * kx, p.lat * DEG]));
  for (let eps = 5; ; eps *= 2) {
    const out = segments.map((s, i) => simplify(s, xy[i], eps));
    if (out.reduce((n, s) => n + s.length, 0) <= max || eps > 1e7) return out;
  }
}

/** The index of the last point at or before t in a piece (-1 when t is before it). @param {Point[]} s @param {number} t */
function before(s, t) {
  let lo = 0;
  let hi = s.length - 1;
  if (!s.length || t < s[0].at) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].at <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Where the user was at t on the drawn route: between two points in proportion to the time; during a
 * jump, where it began; before the start and after the end, at the ends.
 * @param {Point[][]} segments @param {number} t @returns {{ lat: number, lng: number } | null}
 */
export function positionAt(segments, t) {
  /** @type {Point | null} */
  let prev = null;
  for (const s of segments) {
    if (!s.length) continue;
    if (t < s[0].at) return prev ? { lat: prev.lat, lng: prev.lng } : { lat: s[0].lat, lng: s[0].lng };
    const k = before(s, t);
    if (k < s.length - 1) {
      const a = s[k];
      const b = s[k + 1];
      const f = b.at > a.at ? (t - a.at) / (b.at - a.at) : 0;
      return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
    }
    prev = s[s.length - 1];
  }
  return prev ? { lat: prev.lat, lng: prev.lng } : null;
}

/**
 * How much of a drawn piece was behind the user at t, as a part of its length (0 to 1), measured by
 * dist (meters; the replay passes its map's own distance, so the drawn line and the marker agree).
 * @param {Point[]} s @param {number} t @param {(a: Point, b: Point) => number} [dist]
 */
export function fractionAt(s, t, dist = meters) {
  if (s.length < 2 || t <= s[0].at) return 0;
  if (t >= s[s.length - 1].at) return 1;
  let total = 0;
  let done = 0;
  const k = before(s, t);
  for (let i = 1; i < s.length; i++) {
    const d = dist(s[i - 1], s[i]);
    total += d;
    if (i <= k) done += d;
    else if (i === k + 1) done += d * ((t - s[k].at) / Math.max(1, s[i].at - s[k].at));
  }
  return total ? done / total : 0;
}

/**
 * A flat map of the points (spec §13: "a simple equirectangular projection and no map tiles"): north
 * up, fitted into a box width wide with pad around it, as tall as the route needs within minHeight
 * and maxHeight. A trip over the date line counts its western longitudes on from 180.
 * @param {{ lat: number, lng: number }[]} points
 * @param {{ width?: number, pad?: number, minHeight?: number, maxHeight?: number }} [o]
 * @returns {{ width: number, height: number, xy: (p: { lat: number, lng: number }) => [number, number] }}
 */
export function fit(points, { width = 1000, pad = 40, minHeight = 500, maxHeight = 1300 } = {}) {
  if (!points.length) return { width, height: minHeight, xy: () => [width / 2, minHeight / 2] };
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    lo = Math.min(lo, p.lng);
    hi = Math.max(hi, p.lng);
  }
  const wrap = hi - lo > 180;
  const lng = (/** @type {number} */ x) => (wrap && x < 0 ? x + 360 : x);
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, lng(p.lng));
    maxLng = Math.max(maxLng, lng(p.lng));
  }
  const k = Math.cos(rad((minLat + maxLat) / 2));
  const w = Math.max((maxLng - minLng) * k, 0.005);
  const h = Math.max(maxLat - minLat, 0.005);
  const height = Math.round(Math.min(maxHeight, Math.max(minHeight, ((width - 2 * pad) * h) / w + 2 * pad)));
  const s = Math.min((width - 2 * pad) / w, (height - 2 * pad) / h);
  const cx = (minLng + maxLng) / 2;
  const cy = (minLat + maxLat) / 2;
  const r = (/** @type {number} */ v) => Math.round(v * 10) / 10;
  return { width, height, xy: (p) => [r(width / 2 + (lng(p.lng) - cx) * k * s), r(height / 2 - (p.lat - cy) * s)] };
}
```

In `sw.js`, add `'/src/core/after/route.js',` to `SHELL` after `stamps.js`'s line, in order.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/after-route.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/after/route.js sw.js test/unit/after-route.test.js test/unit/after-kit.js && git commit -m "The road a trip took, from its location points: stays and the moves between, the track split where it jumps and thinned for drawing, where the user was at any moment, and a flat map

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 3: A trip's journey, read once; a type's entries in one request

**Files:**
- Create: `src/core/after/journey.js`
- Modify: `src/core/store-idb.js` (`listEvents` by type without a limit uses `getAll`), `test/contract/store-contract.js`, `sw.js` (`SHELL`)
- Test: `test/unit/after-journey.test.js`, `test/contract/store-contract.js` (memory store in Node via `test/unit/store-memory.test.js`; IndexedDB in `test/browser/suites/store-idb.js`)

**Interfaces:**
- Consumes: Task 1's `stampsOf`, `isArrival`, `Stamp`; Task 2's `pointsOf`, `legsOf`, `Point`, `Leg`; `storedTexts` from `src/core/agent/log.js`; `PLAN_FILE` from `src/core/plan.js`; `validZone`, `deviceZone`, `instantOf`, `dayIn` from `src/core/time.js`.
- Produces: `readJourney({ store, ws, trip, namer? }): Promise<Journey>` with
  `Journey = { trip, title, tz, info, points: Point[], legs: Leg[], stamps: Stamp[], entries: Entry[], plan: PlanLine[], from: number | null, to: number | null, days: string[] }`,
  `Entry = { kind: 'stay', at, to, lat, lng, name: string | null, stamp: Stamp | null } | { kind: 'move', at, to, km, mode, gap } | { kind: 'card', at, card } | { kind: 'said', at, text, spoken } | { kind: 'photo', at, path, hash, type, size, width, height, place }`,
  `PlanLine = { title, at: number | null, place: { name, lat, lng } | null, fixed: boolean, visited: boolean }`;
  `takenAt(taken, tz): number | null`; `JOURNEY_TYPES`; `NAMED_M = 300`.

- [ ] **Step 1: Write the failing tests**

Add to `test/contract/store-contract.js`, after the "several types" test:
```js
  test('events: a type read without a limit gives every entry, in order, among many others', async () => {
    const s = await makeStore();
    await s.tx(['events'], 'readwrite', async (t) => {
      for (let i = 1; i <= 1500; i++) await t.appendEvent('x', { ts: i, type: i % 3 ? 'location' : 'wake', actor: 'system', data: { i } });
    });
    const q = (/** @type {any} */ query) => s.tx(['events'], 'readonly', (t) => t.listEvents('x', query));
    const points = await q({ types: ['location'] });
    assert.equal(points.length, 1000);
    assert.ok(points.every((e, i) => i === 0 || e.seq > points[i - 1].seq));
    assert.equal(points[0].data.i, 1);
    const back = await q({ types: ['location', 'wake'], reverse: true, after: 1400 });
    assert.deepEqual(back.slice(0, 3).map((e) => e.seq), [1500, 1499, 1498]);
    assert.equal(back.length, 100);
  });
```

`test/unit/after-journey.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJourney, takenAt } from '../../src/core/after/journey.js';
import { logEvent } from '../../src/core/events.js';
import { record } from '../../src/core/agent/log.js';
import { liveKit, at, iso, off, LA, BIXBY, NEPENTHE, HEARST, RIVER_INN } from './live-kit.js';
import { MORNING } from './after-kit.js';

const PLAN = {
  bixby: { title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } },
  hearst: { title: 'Hearst Castle tour', fixed: true, start: { at: iso('16:30'), tz: LA }, place: { name: 'Hearst Castle', ...HEARST } },
  dinner: { title: 'Dinner in Cambria', fixed: false, start: { at: iso('19:30'), tz: LA } },
};

/** A trip with the morning's road, arrivals, a card, words typed and spoken, and photos. */
async function aTrip() {
  const k = await liveKit({ live: false, plan: PLAN });
  await k.ws.patch(k.trip, '/trip.json', { timezones: [LA] }, { author: 'user' });
  for (const p of MORNING) await logEvent(k.store, k.trip, { type: 'location', data: { lat: p.lat, lng: p.lng, accuracy: 8 } }, p.at);
  await logEvent(k.store, k.trip, { type: 'location', data: { lat: 'broken' } }, at('09:01'));
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { watch: 'plan:bixby:arrived', type: 'plan', event: 'arrived', place: { name: 'Bixby Creek Bridge', ...BIXBY } } }, at('09:32'));
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { watch: 'w-1', type: 'arrived' } }, at('09:33'));
  await logEvent(k.store, k.trip, { type: 'out.show', data: { card: { title: 'Bixby Creek Bridge', text: 'Built in **1932**.' } } }, at('09:35'));
  await logEvent(k.store, k.trip, { type: 'out.show', data: { card: 'not a card' } }, at('09:35'));
  await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', `Look! ${'x'.repeat(2500)}`]], now: at('09:36') });
  await logEvent(k.store, k.trip, { type: 'heard', data: { id: 'h1' } }, at('09:40'));
  await logEvent(k.store, k.trip, { type: 'heard.text', data: { of: 'h1', text: 'Is that the bridge?' } }, at('09:40'));
  await logEvent(k.store, k.trip, { type: 'heard', data: { id: 'h2', dismissed: true, text: 'chatter in the back' } }, at('09:41'));
  await logEvent(k.store, k.trip, { type: 'heard', data: { id: 'h3' } }, at('09:42')); // its words never came
  await k.ws.write(k.trip, '/files/2026-11-27-0945.webp', new Uint8Array([1, 2, 3]), { author: 'user', type: 'image/webp', meta: { taken: '2026-11-27T09:45:00', width: 4000, height: 3000, place: { lat: BIXBY.lat, lng: BIXBY.lng } } });
  await k.ws.write(k.trip, '/files/notes.pdf', new Uint8Array([4]), { author: 'user', type: 'application/pdf' });
  return k;
}

test("a trip's journey: the road as stays and moves, named; stamps; cards; words typed and spoken; photos; in time order (spec §13)", async () => {
  const k = await aTrip();
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip, namer: (p) => (Math.abs(p.lat - HEARST.lat) < 0.01 ? { name: 'not this one', m: 10 } : null) });
  assert.equal(j.tz, LA);
  assert.equal(j.title, 'Big Sur');
  assert.equal(j.points.length, MORNING.length);
  const kinds = j.entries.map((e) => e.kind);
  assert.deepEqual(kinds, ['move', 'stay', 'card', 'said', 'said', 'photo', 'move', 'stay']);
  const [, bixby, card, typed, spoken, photo, , castle] = /** @type {any[]} */ (j.entries);
  assert.equal(bixby.name, 'Bixby Creek Bridge'); // named by its arrival
  assert.equal(bixby.stamp?.name, 'Bixby Creek Bridge');
  assert.equal(castle.name, 'Hearst Castle'); // a plan place within 300 m comes before the namer
  assert.equal(castle.stamp, null); // no arrival fired there
  assert.deepEqual(card.card, { title: 'Bixby Creek Bridge', text: 'Built in **1932**.' });
  assert.match(typed.text, /^Look! x{2500}$/); // a long message's words are read from where they are stored
  assert.deepEqual([spoken.text, spoken.spoken], ['Is that the bridge?', true]);
  assert.deepEqual([photo.path, photo.at, photo.width, photo.type], ['/files/2026-11-27-0945.webp', at('09:45'), 4000, 'image/webp']);
  assert.deepEqual(j.stamps.map((s) => s.name), ['Bixby Creek Bridge']);
  assert.deepEqual(j.days, ['2026-11-27']);
  assert.equal(j.from, MORNING[0].at);
  assert.equal(j.to, at('18:15'));
  assert.deepEqual(j.plan.map((p) => [p.title, p.visited, p.place?.name ?? null]), [
    ['Bixby Bridge photo stop', true, 'Bixby Creek Bridge'], ['Hearst Castle tour', false, 'Hearst Castle'], ['Dinner in Cambria', false, null]]);
});

test('a stay with no arrival and no plan place is named by the namer; a trip with nothing in its log is an empty journey', async () => {
  const k = await liveKit({ live: false });
  for (const [p, t] of /** @type {const} */ ([[RIVER_INN, '10:00'], [off(RIVER_INN, 20, 0), '10:30'], [NEPENTHE, '10:45']])) await logEvent(k.store, k.trip, { type: 'location', data: { lat: p.lat, lng: p.lng } }, at(t));
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip, namer: (p) => (Math.abs(p.lat - RIVER_INN.lat) < 0.001 ? { name: 'Big Sur River Inn', m: 30 } : null) });
  assert.equal(/** @type {any} */ (j.entries.find((e) => e.kind === 'stay'))?.name, 'Big Sur River Inn');
  const empty = await liveKit({ live: false });
  const none = await readJourney({ store: empty.store, ws: empty.ws, trip: empty.trip });
  assert.deepEqual([none.points, none.entries, none.stamps, none.from, none.to, none.days], [[], [], [], null, null, []]);
});

test("when a photo was taken: with its offset, or the wall clock where it was taken read in the trip's zone", () => {
  assert.equal(takenAt('2026-11-27T09:45:00-08:00', 'UTC'), Date.parse('2026-11-27T17:45:00Z'));
  assert.equal(takenAt('2026-11-27T09:45:00', LA), Date.parse('2026-11-27T17:45:00Z'));
  assert.equal(takenAt('2026-11-27T09:45', LA), Date.parse('2026-11-27T17:45:00Z'));
  assert.equal(takenAt('yesterday', LA), null);
  assert.equal(takenAt(undefined, LA), null);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/after-journey.test.js test/unit/store-memory.test.js`
Expected: the journey tests FAIL: `Cannot find module '…/src/core/after/journey.js'`; the new contract test passes on the memory store (it pins what IndexedDB must keep doing).

- [ ] **Step 3: Write the code**

In `src/core/store-idb.js`, in `listEvents`'s `if (q.types)` branch, replace the `Promise.all(kinds.map(…))` reader with one that asks `getAll` when nothing stops it early:
```js
        Promise.all(kinds.map((k) => new Promise((done, fail) => {
          const range = IDBKeyRange.bound([scope, k, lo], [scope, k, hi]);
          if (limit === Infinity || !q.reverse) {
            // Every entry of a type, or the first few: one request (a five-day trip's points), not one callback each.
            const r = index.getAll(range, limit === Infinity ? undefined : limit);
            r.onsuccess = () => done(q.reverse ? /** @type {any[]} */ (r.result).reverse() : r.result);
            r.onerror = () => fail(r.error);
            return;
          }
          /** @type {any[]} */
          const got = [];
          const r = index.openCursor(range, 'prev');
          r.onsuccess = () => {
            const c = r.result;
            if (!c || got.length >= limit) {
              done(got);
              return;
            }
            got.push(c.value);
            c.continue();
          };
          r.onerror = () => fail(r.error);
        }))).then((lists) => {
```
(the `.then` that merges and slices stays as it is).

`src/core/after/journey.js`:
```js
import { pointsOf, legsOf } from './route.js';
import { stampsOf, isArrival } from './stamps.js';
import { meters } from '../live/geo.js';
import { validZone, deviceZone, instantOf, dayIn } from '../time.js';
import { PLAN_FILE } from '../plan.js';
import { storedTexts } from '../agent/log.js';

/**
 * A trip as it went (spec §13), read once from its log and files for the recap and the replay: the
 * road (location points, read by type through the log's index), where the user stayed and how they
 * moved, the stamps, Shiori's cards, the user's words (typed or spoken), and the photos.
 * @typedef {import('./route.js').Point} Point
 * @typedef {import('./route.js').Leg} Leg
 * @typedef {import('./stamps.js').Stamp} Stamp
 * @typedef {{ kind: 'stay', at: number, to: number, lat: number, lng: number, name: string | null, stamp: Stamp | null }
 *   | { kind: 'move', at: number, to: number, km: number, mode: 'drive' | 'walk', gap: boolean }
 *   | { kind: 'card', at: number, card: any }
 *   | { kind: 'said', at: number, text: string, spoken: boolean }
 *   | { kind: 'photo', at: number, path: string, hash: string, type: string, size: number, width: number | null, height: number | null,
 *       place: { lat: number, lng: number } | null }} Entry
 * @typedef {{ title: string, at: number | null, place: { name: string, lat: number, lng: number } | null, fixed: boolean, visited: boolean }} PlanLine
 * @typedef {{ trip: string, title: string, tz: string, info: any, points: Point[], legs: Leg[], stamps: Stamp[], entries: Entry[],
 *   plan: PlanLine[], from: number | null, to: number | null, days: string[] }} Journey
 *   info: trip.json; from, to: when the first and last thing happened; days: each day something did, in the trip's zone
 */

/** A stay is named by an arrival or a plan place this close (the namer keeps its own reach: the offline pack's 500 m). */
export const NAMED_M = 300;
/** What the journey reads from the log, by type (A6: the log is never walked). */
export const JOURNEY_TYPES = Object.freeze(['location', 'trigger.fired', 'out.show', 'msg.user', 'heard', 'heard.text']);
const MIN = 60_000;

/** @param {any} p @returns {p is { lat: number, lng: number }} */
const hasPoint = (p) => Boolean(p) && typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng);

/**
 * When a photo was taken (spec §4.8: ISO 8601, with an offset when the photo records one; without
 * one it is the clock where it was taken, read in the trip's zone). @param {unknown} taken @param {string} tz
 */
export function takenAt(taken, tz) {
  if (typeof taken !== 'string') return null;
  if (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(taken)) {
    const t = Date.parse(taken);
    return Number.isFinite(t) ? t : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(taken);
  return m ? instantOf({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0) }, tz) : null;
}

/**
 * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, trip: string,
 *   namer?: (p: { lat: number, lng: number }) => { name: string, m: number } | null }} c
 *   namer: names a place where nothing in the trip does (the offline pack's, spec §11.5)
 * @returns {Promise<Journey>}
 */
export async function readJourney({ store, ws, trip, namer = () => null }) {
  const scope = await store.tx(['scopes'], 'readonly', (t) => t.getScope(trip));
  const info = (await ws.readJSON(trip, '/trip.json').catch(() => null)) ?? {};
  /** @type {{ slug: string, item: any }[]} */
  const items = [];
  for (const f of await ws.list(trip, '/plan/')) {
    if (!PLAN_FILE.test(f.path)) continue;
    const item = await ws.readJSON(trip, f.path).catch(() => null);
    if (item && typeof item === 'object' && !Array.isArray(item)) items.push({ slug: f.path.replace(/^\/plan\//, '').replace(/\.json$/, ''), item });
  }
  const tz = [info?.timezones?.[0], ...items.map((x) => x.item.start?.tz), deviceZone()].find(validZone) ?? 'UTC';
  const events = await store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: [...JOURNEY_TYPES] }));
  const points = pointsOf(events.filter((e) => e.type === 'location'));
  const fired = events.filter((e) => e.type === 'trigger.fired');
  const stamps = stampsOf(fired, tz);
  const arrivals = fired.filter((e) => isArrival(e.data) && hasPoint(e.data.place) && typeof e.data.place.name === 'string' && e.data.place.name.trim());
  const places = items.map((x) => x.item.place).filter(hasPoint).map((p) => ({ name: String(/** @type {any} */ (p).name ?? ''), lat: p.lat, lng: p.lng })).filter((p) => p.name);
  /** Where a stay was: its arrival's name, else a plan place's, else the namer's. @param {{ lat: number, lng: number, from: number, to: number }} s */
  const nameOf = (s) => {
    const a = arrivals.find((e) => e.ts >= s.from - 15 * MIN && e.ts <= s.to + MIN && meters(e.data.place, s) <= NAMED_M);
    if (a) return String(a.data.place.name).trim();
    /** @type {{ name: string, m: number } | null} */
    let best = null;
    for (const p of places) {
      const d = meters(p, s);
      if (d <= NAMED_M && (!best || d < best.m)) best = { name: p.name, m: d };
    }
    if (best) return best.name;
    try {
      return namer(s)?.name ?? null;
    } catch {
      return null;
    }
  };
  const legs = legsOf(points);
  /** @type {Entry[]} */
  const entries = [];
  for (const l of legs) {
    if (l.kind === 'move') {
      entries.push({ kind: 'move', at: l.from, to: l.to, km: l.km, mode: l.mode, gap: l.gap });
      continue;
    }
    const name = nameOf(l);
    const day = dayIn(l.from, tz);
    const stamp = name ? stamps.find((x) => x.name.toLowerCase() === name.toLowerCase() && dayIn(x.at, tz) === day) ?? null : null;
    entries.push({ kind: 'stay', at: l.from, to: l.to, lat: l.lat, lng: l.lng, name, stamp });
  }
  /** @type {Map<string, { text: string }>} heard segments whose words come later */
  const waiting = new Map();
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === 'out.show') {
      if (d.card && typeof d.card === 'object' && !Array.isArray(d.card)) entries.push({ kind: 'card', at: e.ts, card: d.card });
    } else if (e.type === 'msg.user') {
      const text = String({ ...d, ...(d.stored ? await storedTexts(store, e) : {}) }.text ?? '').trim();
      if (text) entries.push({ kind: 'said', at: e.ts, text, spoken: false });
    } else if (e.type === 'heard' && !d.dismissed) {
      const said = { kind: /** @type {const} */ ('said'), at: e.ts, text: typeof d.text === 'string' ? d.text.trim() : '', spoken: true };
      entries.push(said);
      if (typeof d.text !== 'string' && typeof d.id === 'string') waiting.set(d.id, said);
    } else if (e.type === 'heard.text') {
      const said = waiting.get(d.of);
      if (said) said.text = String(d.text ?? '').trim();
    }
  }
  for (const f of await ws.list(trip, '/files/')) {
    if (!f.type.startsWith('image/')) continue;
    const m = f.meta ?? {};
    entries.push({
      kind: 'photo', at: takenAt(m.taken, tz) ?? f.created, path: f.path, hash: f.hash, type: f.type, size: f.size,
      width: m.width ?? null, height: m.height ?? null, place: hasPoint(m.place) ? { lat: m.place.lat, lng: m.place.lng } : null,
    });
  }
  const kept = entries.filter((e) => e.kind !== 'said' || e.text).sort((a, b) => a.at - b.at);
  const times = [...kept.flatMap((e) => ('to' in e ? [e.at, e.to] : [e.at])), ...(points.length ? [points[0].at, points[points.length - 1].at] : [])];
  return {
    trip, title: scope?.title ?? String(info.title ?? 'Trip'), tz, info, points, legs, stamps, entries: kept,
    plan: items
      .map(({ slug, item }) => {
        const t = Date.parse(item.start?.at ?? '');
        return {
          title: String(item.title ?? slug), at: Number.isFinite(t) ? t : null, fixed: item.fixed === true,
          place: hasPoint(item.place) && item.place.name ? { name: String(item.place.name), lat: item.place.lat, lng: item.place.lng } : null,
          visited: fired.some((e) => e.data?.watch === `plan:${slug}:arrived`),
        };
      })
      .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)),
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
    days: [...new Set(times.map((t) => /** @type {string} */ (dayIn(t, tz))))].sort(),
  };
}
```
(`Math.min(...times)` takes at most a few thousand values: entries and two points, never the whole track.)

In `sw.js`, add `'/src/core/after/journey.js',` to `SHELL`.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/after-journey.test.js test/unit/store-memory.test.js`
Expected: PASS.

Run the store contract against IndexedDB in both browsers:
`docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/browser-suites.spec.js`
Expected: 8 passed (four suites in each browser). Then `ls core* 2>/dev/null` and delete any.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/after/journey.js src/core/store-idb.js sw.js test/contract/store-contract.js test/unit/after-journey.test.js && git commit -m "A trip's journey, read once from its log by type and its files: the road as stays and moves, named; stamps; Shiori's cards; the user's words, typed or spoken; photos. A type's entries come from IndexedDB in one request when nothing limits them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 4: The recap, by the utility model

**Files:**
- Create: `src/core/after/recap.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/after-recap.test.js`

**Interfaces:**
- Consumes: Task 3's `readJourney`, `Journey`; Task 2's `STAY_MIN`; `tsv` from `src/core/tsv.js`; `record` from `src/core/agent/log.js`; `modelOf` from `src/core/llm/config.js`; `stricter` from `src/core/agent/refusals.js`; `PhotoCopies`, `requestLimits` from `src/core/request-photos.js`; `photoSettings` from `src/core/photos.js`; `readAppSettings`; `toBase64`, `fromBase64` from `src/core/bytes.js`; `llm.call({ role, request, scope, record, signal })` and `llm.config()`.
- Produces: `RECAP_FILE = '/recap.md'`, `RECAP_PHOTOS = 6`, `RECAP_CHARS = 60_000`, `LINE_CHARS = 300`, `NOTE_CHARS = 4000`, `RECAP_SYSTEM`, `TELL_RECAP`; `recapText(j: Journey, more?: { profile?, memory?, notes? }): string`; `recapPhotos(j): Entry[]` (photos); `recapModels(cfg): Model[]`; `writeRecap({ store, ws, llm, trip, codec?, namer?, signal? }): Promise<{ text: string, photos: number, chars: number }>`.

- [ ] **Step 1: Write the failing tests**

`test/unit/after-recap.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recapText, recapPhotos, writeRecap, RECAP_SYSTEM, RECAP_CHARS } from '../../src/core/after/recap.js';
import { readJourney } from '../../src/core/after/journey.js';
import { logEvent } from '../../src/core/events.js';
import { agentKit, fakeCodec } from './agent-kit.js';
import { at, iso, LA, BIXBY, HEARST } from './live-kit.js';
import { MORNING } from './after-kit.js';
import { saveModel } from '../../src/core/llm/config.js';

const RECAP = '# Big Sur, Thanksgiving\n\n## Friday, November 27\n\nBixby Bridge in the morning sun.';

/** A trip on a memory annai with the morning's road, a stamp, words, a card, a note and photos; a scripted utility model writes the recap. */
async function aTrip(/** @type {any[]} */ utility = [{ text: RECAP }], /** @type {any} */ o = {}) {
  const k = await agentKit([[{ text: '' }]], { utility, ...o });
  await k.ws.patch(k.trip, '/trip.json', { timezones: [LA], start: '2026-11-27', end: '2026-11-28', party: [{ name: 'Alex', driver: true }, { name: 'Sam', age: 12, interests: ['tide pools'] }] }, { author: 'user' });
  await k.ws.write(k.trip, '/plan/bixby.json', { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } }, { author: 'user' });
  await k.ws.write(k.trip, '/plan/hearst.json', { id: 'hearst', title: 'Hearst Castle tour', fixed: true, start: { at: iso('16:30'), tz: LA }, place: { name: 'Hearst Castle', ...HEARST } }, { author: 'user' });
  for (const p of MORNING) await logEvent(k.store, k.trip, { type: 'location', data: { lat: p.lat, lng: p.lng, accuracy: 8 } }, p.at);
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { watch: 'plan:bixby:arrived', type: 'plan', event: 'arrived', place: { name: 'Bixby Creek Bridge', ...BIXBY } } }, at('09:32'));
  await logEvent(k.store, k.trip, { type: 'out.show', data: { card: { title: 'Bixby Creek Bridge', text: 'Built in 1932.' } } }, at('09:35'));
  await logEvent(k.store, k.trip, { type: 'msg.user', data: { text: 'Sam wants to see the sea lions.' } }, at('09:36'));
  await k.ws.write(k.trip, '/notes/day1.md', '# Day 1\nThe fog lifted at ten.\n', { author: 'shiori' });
  for (let i = 0; i < 8; i++) {
    await k.ws.write(k.trip, `/files/2026-11-27-10${i}0.jpg`, new TextEncoder().encode('3000x2000'), { author: 'user', type: 'image/jpeg', meta: { taken: `2026-11-27T10:${i}0:00`, width: 3000, height: 2000 } });
  }
  return k;
}

test('the recap is written from the journey in words and lists, never the raw track (spec §13, §4.7, choice 4)', async () => {
  const k = await aTrip();
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip });
  const text = recapText(j, { profile: '# Profile\n- What to call me: Alex', memory: '# Trip memory\n- Sam is vegetarian', notes: [{ path: '/trip/notes/day1.md', text: 'The fog lifted at ten.' }] });
  assert.match(text, /^# Big Sur\n/);
  assert.match(text, /Times are local, in America\/Los_Angeles\./);
  assert.match(text, /Travel party: Alex, driver; Sam, age 12, likes tide pools\./);
  assert.match(text, /2026-11-27\t09:2\d\t09:5\d\tstayed\tBixby Creek Bridge\t\tyes/);
  assert.match(text, /\tdrove \(partly unseen: the phone was locked or annai closed\)\t/);
  assert.match(text, /stayed\tHearst Castle/);
  assert.match(text, /2026-11-27 09:35\tShiori \(card\)\tBixby Creek Bridge: Built in 1932\./);
  assert.match(text, /2026-11-27 09:36\ttraveler\tSam wants to see the sea lions\./);
  assert.match(text, /Hearst Castle tour\tHearst Castle\tfixed\tno/);
  assert.match(text, /\/trip\/files\/2026-11-27-1000\.jpg/);
  assert.match(text, /The fog lifted at ten\./);
  assert.match(text, /Sam is vegetarian/);
  assert.match(text, /What to call me: Alex/);
  // No location point goes as it is: at most a few positions, for unnamed stays (choice 4).
  assert.ok((text.match(/-121\.\d{3,}/g) ?? []).length <= 2, text);
});

test('a long trip fits the cap: the words are thinned evenly, the road and the stamps stay', async () => {
  const k = await aTrip();
  for (let i = 0; i < 3000; i++) await logEvent(k.store, k.trip, { type: 'msg.user', data: { text: `Message ${i}: ${'blah '.repeat(60)}` } }, at('11:00') + i * 1000);
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip });
  const text = recapText(j);
  assert.ok(text.length <= RECAP_CHARS, String(text.length));
  assert.match(text, /stayed\tBixby Creek Bridge/);
  assert.match(text, /Message 0: /);
  assert.match(text, /lines left out to fit/);
  assert.ok(!text.includes('blah '.repeat(61)), 'each line is cut to 300 characters');
});

test('six photos at most go with it, spread over the trip', async () => {
  const k = await aTrip();
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip });
  assert.deepEqual(recapPhotos(j).map((p) => p.path), ['/files/2026-11-27-1000.jpg', '/files/2026-11-27-1010.jpg', '/files/2026-11-27-1030.jpg', '/files/2026-11-27-1040.jpg', '/files/2026-11-27-1060.jpg', '/files/2026-11-27-1070.jpg']);
});

test('the utility model writes /trip/recap.md, with request copies of the photos; the log names what was sent (spec §13, §4.8, §4.9)', async () => {
  const k = await aTrip();
  const r = await writeRecap({ store: k.store, ws: k.ws, llm: k.llm, trip: k.trip, codec: fakeCodec() });
  assert.equal(r.photos, 6);
  assert.equal(await k.ws.readText(k.trip, '/recap.md'), `${RECAP}\n`);
  assert.equal((await k.ws.read(k.trip, '/recap.md'))?.entry.author, 'shiori');
  const asked = k.requests.at(-1);
  assert.equal(asked.system, RECAP_SYSTEM);
  const parts = asked.messages[0].parts;
  assert.equal(parts.filter((/** @type {any} */ p) => p.type === 'image').length, 6);
  assert.match(parts[1].text, /^Photo \/trip\/files\/2026-11-27-1000\.jpg, 2026-11-27 10:00:$/);
  const [entry] = await k.events(['recap']);
  assert.deepEqual([entry.data.path, entry.data.photos], ['/recap.md', 6]);
  assert.equal(entry.refs.length, 6); // the copies, named (§4.9)
  const [turn] = (await k.events(['model.turn'])).filter((e) => e.data.tag === 'recap');
  assert.ok(turn, 'the call is in the trace');
});

test('no photos go to a model that takes none; a model that answers nothing, or none at all, is a plain error and nothing is written', async () => {
  const k = await aTrip([{ text: RECAP }], { models: [{ input: ['text'] }] });
  await saveModel(k.ws, { id: 'm-u', endpoint: 'ep-u', template: null, user: { providerId: 'model-u', prices: { input: 1, output: 1 }, input: ['text'] }, created: 0 });
  await writeRecap({ store: k.store, ws: k.ws, llm: k.llm, trip: k.trip, codec: fakeCodec() });
  assert.equal(k.requests.at(-1).messages[0].parts.length, 1);

  const empty = await aTrip([{ text: '   ' }]);
  await assert.rejects(writeRecap({ store: empty.store, ws: empty.ws, llm: empty.llm, trip: empty.trip }), /The model sent back an empty recap\. Try again, or put another model first in the utility role \(Settings → Models\)\./);
  assert.equal(await empty.ws.read(empty.trip, '/recap.md'), undefined);
  assert.deepEqual(await empty.events(['recap']), []);

  const none = await agentKit([]);
  await assert.rejects(writeRecap({ store: none.store, ws: none.ws, llm: none.llm, trip: none.trip }), /No model is set up to write the recap\. Add one in Settings → Models\./);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/after-recap.test.js`
Expected: FAIL: `Cannot find module '…/src/core/after/recap.js'`.

- [ ] **Step 3: Write the code**

`src/core/after/recap.js`:
```js
import { readJourney } from './journey.js';
import { STAY_MIN } from './route.js';
import { tsv } from '../tsv.js';
import { dayIn, timeIn } from '../time.js';
import { record } from '../agent/log.js';
import { modelOf } from '../llm/config.js';
import { stricter } from '../agent/refusals.js';
import { PhotoCopies, requestLimits } from '../request-photos.js';
import { photoSettings } from '../photos.js';
import { readAppSettings } from '../settings.js';
import { toBase64, fromBase64 } from '../bytes.js';
import { ME } from '../scopes.js';

/**
 * The recap (spec §13): the utility model writes /trip/recap.md from the trip as it went (the
 * journey), its notes and memory, and a few photos. The road goes as stays and moves in words and
 * TSV (§4.7), never as its location points (choice 4). Shiori can tell it by voice (TELL_RECAP).
 * @typedef {import('./journey.js').Journey} Journey
 * @typedef {import('./journey.js').Entry} Entry
 */

export const RECAP_FILE = '/recap.md';
/** Photos sent with it at most (choice 4)… */
export const RECAP_PHOTOS = 6;
/** …taking at most this part of the maximum request size (spec §6.5). */
export const PHOTO_SHARE = 0.5;
/** The text sent, at most (about 17,000 tokens). */
export const RECAP_CHARS = 60_000;
/** Each card and message, at most. */
export const LINE_CHARS = 300;
/** Each note and the trip's memory, at most. */
export const NOTE_CHARS = 4000;

export const RECAP_SYSTEM = 'You write the recap of a trip for the traveler who took it, from what the annai app recorded on the way: '
  + 'where they stayed and for how long, how they moved between, the stamps they earned at places they visited, what they said and what Shiori, their guide, showed them, '
  + 'their notes, and some of their photos. Write Markdown: a first line "# " with a title for the trip; then one "## " section for each day, in order, '
  + 'telling the day in a few short paragraphs: the places, what happened there, and the photos by their paths where they belong; '
  + 'then "## Highlights" with three to five short bullet points. Be warm, concrete and brief, about 150 words a day. '
  + 'Use only what the record says, and leave out what you don\'t know rather than guess. Shiori may read the recap aloud, so write sentences that are easy to say. '
  + 'Write in the traveler\'s language (their profile says which). Reply with the recap only.';

/** What Shiori is woken with when the user asks to hear the recap (choice 6). */
export const TELL_RECAP = "The user asked to hear the trip's recap. Read /trip/recap.md and tell it to them with speak, a few sentences at a time, in your own words.";

/** @param {string} s @param {number} n */
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The models of the utility role, or of the main role when it has none (spec §9.6). @param {any} cfg */
export function recapModels(cfg) {
  const ids = cfg?.roles?.utility?.models?.length ? cfg.roles.utility.models : cfg?.roles?.main?.models ?? [];
  return ids.map((/** @type {string} */ id) => (cfg.models?.[id] ? modelOf(cfg.models[id]) : null)).filter(Boolean);
}

/** The photos sent with the recap: up to RECAP_PHOTOS, spread evenly over the trip. @param {Journey} j */
export function recapPhotos(j, max = RECAP_PHOTOS) {
  const all = j.entries.filter((e) => e.kind === 'photo');
  if (all.length <= max) return all;
  return [...new Set(Array.from({ length: max }, (_, i) => Math.round((i * (all.length - 1)) / (max - 1))))].map((i) => all[i]);
}

/**
 * The recap's input in words (choice 4): the trip, its days, the way (stays and moves), stamps, the
 * plan, what was said and shown, photos, notes and memory. At most RECAP_CHARS: the words are thinned
 * evenly until it fits, then it is cut.
 * @param {Journey} j @param {{ profile?: string, memory?: string, notes?: { path: string, text: string }[] }} [more]
 */
export function recapText(j, { profile = '', memory = '', notes = [] } = {}) {
  const day = (/** @type {number} */ t) => String(dayIn(t, j.tz));
  const time = (/** @type {number} */ t) => String(timeIn(t, j.tz));
  const info = j.info ?? {};
  const party = Array.isArray(info.party) ? info.party.filter((/** @type {any} */ p) => p && typeof p.name === 'string') : [];
  const head = [
    `# ${j.title}`,
    [info.start ? `Dates: ${info.start}${info.end ? ` to ${info.end}` : ''}.` : '', `Times are local, in ${j.tz}.`].filter(Boolean).join(' '),
    party.length ? `Travel party: ${party.map((/** @type {any} */ p) => [p.name, typeof p.age === 'number' ? `age ${p.age}` : '', p.driver ? 'driver' : '', p.interests?.length ? `likes ${p.interests.join(', ')}` : ''].filter(Boolean).join(', ')).join('; ')}.` : '',
    profile.trim() ? `\n## The traveler's profile\n${cut(profile.trim(), 2000)}` : '',
  ].filter(Boolean).join('\n');
  const stays = j.entries.filter((e) => e.kind === 'stay');
  const moves = j.entries.filter((e) => e.kind === 'move');
  const photos = j.entries.filter((e) => e.kind === 'photo');
  const words = j.entries.filter((e) => e.kind === 'said' || e.kind === 'card');
  const days = tsv(['day', 'km', 'stays', 'stamps', 'photos', 'words'], j.days.map((d) => [
    d, Math.round(moves.filter((m) => day(m.at) === d).reduce((s, m) => s + /** @type {any} */ (m).km, 0) * 10) / 10,
    stays.filter((s) => day(s.at) === d).length, j.stamps.filter((s) => day(s.at) === d).length,
    photos.filter((p) => day(p.at) === d).length, words.filter((w) => day(w.at) === d).length,
  ]));
  const way = tsv(['day', 'from', 'to', 'what', 'place', 'km', 'stamp'], j.entries.flatMap((e) => {
    if (e.kind === 'stay') return [[day(e.at), time(e.at), time(e.to), 'stayed', e.name ?? `unnamed, near ${e.lat.toFixed(3)}, ${e.lng.toFixed(3)}`, '', e.stamp ? 'yes' : '']];
    if (e.kind === 'move') return [[day(e.at), time(e.at), time(e.to), `${e.mode === 'walk' ? 'walked' : 'drove'}${e.gap ? ' (partly unseen: the phone was locked or annai closed)' : ''}`, '', e.km, '']];
    return [];
  }));
  const stamps = tsv(['day', 'time', 'place', 'kind'], j.stamps.map((s) => [day(s.at), time(s.at), s.name, s.plan ? 'on the plan' : 'off the plan']));
  const plan = tsv(['day', 'time', 'item', 'place', 'kind', 'visited'], j.plan.map((p) => [p.at === null ? '' : day(p.at), p.at === null ? '' : time(p.at), p.title, p.place?.name ?? '', p.fixed ? 'fixed' : 'flexible', p.visited ? 'yes' : 'no']));
  /** Where a moment was: the stay it fell in. @param {number} t */
  const where = (t) => /** @type {any} */ (stays.find((s) => t >= s.at && t <= /** @type {any} */ (s).to))?.name ?? '';
  const photoList = tsv(['time', 'path', 'where', 'size'], photos.map((p) => {
    const ph = /** @type {Extract<Entry, { kind: 'photo' }>} */ (p);
    return [`${day(ph.at)} ${time(ph.at)}`, `/trip${ph.path}`, where(ph.at) || (ph.place ? `near ${ph.place.lat.toFixed(3)}, ${ph.place.lng.toFixed(3)}` : ''), ph.width && ph.height ? `${ph.width}×${ph.height}` : ''];
  }));
  const rows = words.map((w) => {
    if (w.kind === 'card') {
      const c = w.card ?? {};
      return [`${day(w.at)} ${time(w.at)}`, 'Shiori (card)', cut([c.title, c.text, c.place?.name].filter((x) => typeof x === 'string' && x.trim()).join(': ').replace(/\s+/g, ' '), LINE_CHARS)];
    }
    const s = /** @type {Extract<Entry, { kind: 'said' }>} */ (w);
    return [`${day(s.at)} ${time(s.at)}`, s.spoken ? 'traveler (spoke)' : 'traveler', cut(s.text.replace(/\s+/g, ' '), LINE_CHARS)];
  });
  const tail = [
    ...notes.filter((n) => n.text.trim()).map((n) => `### ${n.path}\n${cut(n.text.trim(), NOTE_CHARS)}`),
  ];
  const build = (/** @type {unknown[][]} */ said, /** @type {number} */ left) => [
    head,
    `## Days\n${days}`,
    `## The way\nStays of ${STAY_MIN} minutes or more and the moves between, worked out from ${j.points.length} location points (the points themselves aren't sent).\n${way}`,
    j.stamps.length ? `## Stamps (places visited)\n${stamps}` : '',
    j.plan.length ? `## The plan\n${plan}` : '',
    rows.length ? `## What was said and shown\n${tsv(['time', 'who', 'text'], said)}${left ? `\n[${left} lines left out to fit]` : ''}` : '',
    photos.length ? `## Photos\n${photoList}` : '',
    tail.length ? `## Notes\n${tail.join('\n\n')}` : '',
    memory.trim() ? `## Trip memory\n${cut(memory.trim(), NOTE_CHARS)}` : '',
  ].filter(Boolean).join('\n\n');
  let text = build(rows, 0);
  if (text.length > RECAP_CHARS) {
    // Evenly thinned: the fewest left out that fits.
    let lo = 0;
    let hi = rows.length;
    const pick = (/** @type {number} */ n) => (n >= rows.length ? rows : Array.from({ length: n }, (_, i) => rows[Math.floor((i * rows.length) / n)]));
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (build(pick(mid), rows.length - mid).length <= RECAP_CHARS) lo = mid;
      else hi = mid - 1;
    }
    text = build(pick(lo), rows.length - lo);
  }
  return text.length > RECAP_CHARS ? `${text.slice(0, RECAP_CHARS - 1)}…` : text;
}

/** @param {import('../types.js').Store} store @param {string} hash */
async function bytesOf(store, hash) {
  const b = await store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
  return b ? new Uint8Array(b.data) : null;
}

/**
 * Writes /trip/recap.md with the utility model (spec §13, choice 5), and logs a recap entry that names
 * the photo copies it sent (§4.9). Errors are plain: what happened and what to do next.
 * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, llm: any, trip: string,
 *   codec?: import('../photos.js').Codec | null, namer?: (p: { lat: number, lng: number }) => { name: string, m: number } | null, signal?: AbortSignal }} c
 * @returns {Promise<{ text: string, photos: number, chars: number }>}
 */
export async function writeRecap({ store, ws, llm, trip, codec = null, namer, signal }) {
  const cfg = await llm.config();
  const models = recapModels(cfg);
  if (!models.length) throw new Error('No model is set up to write the recap. Add one in Settings → Models.');
  const j = await readJourney({ store, ws, trip, namer });
  const profile = (await ws.readText(ME, '/profile.md').catch(() => '')) ?? '';
  const memory = (await ws.readText(trip, '/memory.md').catch(() => '')) ?? '';
  /** @type {{ path: string, text: string }[]} */
  const notes = [];
  for (const f of await ws.list(trip, '/notes/')) {
    if (/\.(md|txt)$/i.test(f.path)) notes.push({ path: `/trip${f.path}`, text: (await ws.readText(trip, f.path).catch(() => '')) ?? '' });
  }
  const text = recapText(j, { profile, memory, notes });
  /** @type {import('../llm/contract.js').Part[]} */
  const parts = [{ type: 'text', text }];
  /** @type {{ hash?: string, bytes?: Uint8Array, type: string }[]} */
  const blobs = [];
  if (models.every((/** @type {any} */ m) => m.input?.includes('image'))) {
    /** @type {import('../agent/refusals.js').Learned} */
    let images = {};
    for (const m of models) images = stricter(images, /** @type {any} */ (m).images ?? {});
    const app = await readAppSettings(ws);
    const limits = requestLimits(photoSettings(app).request, images);
    const room = (app.shiori?.compaction?.maxRequestMiB ?? 8) * 2 ** 20 * PHOTO_SHARE;
    const copies = codec ? new PhotoCopies({ codec: /** @type {any} */ (codec), read: (h) => bytesOf(store, h) }) : null;
    let used = 0;
    for (const p of recapPhotos(j, Math.min(RECAP_PHOTOS, limits.maxCount ?? RECAP_PHOTOS))) {
      const ph = /** @type {Extract<Entry, { kind: 'photo' }>} */ (p);
      try {
        const c = copies
          ? await copies.copy({ hash: ph.hash, type: ph.type, width: ph.width, height: ph.height, size: ph.size }, limits)
          : { hash: ph.hash, mediaType: ph.type, data: undefined };
        const data = c.data ?? toBase64(/** @type {Uint8Array} */ ((await bytesOf(store, c.hash)) ?? new Uint8Array()));
        if (!data || used + data.length > room) continue;
        used += data.length;
        parts.push({ type: 'text', text: `Photo /trip${ph.path}, ${dayIn(ph.at, j.tz)} ${timeIn(ph.at, j.tz)}:` }, { type: 'image', mediaType: c.mediaType, data, hash: c.hash, path: `/trip${ph.path}` });
        blobs.push(c.data ? { bytes: fromBase64(c.data), type: c.mediaType } : { hash: c.hash, type: c.mediaType });
      } catch {
        // A photo that can't be read or made small enough stays out; the list still names it.
      }
    }
  }
  const r = await llm.call({ role: 'utility', request: { system: RECAP_SYSTEM, messages: [{ role: 'user', parts }] }, scope: trip, record: { tag: 'recap' }, signal });
  const out = String(r?.reply?.text ?? '').trim();
  if (!out) throw new Error('The model sent back an empty recap. Try again, or put another model first in the utility role (Settings → Models).');
  await ws.write(trip, RECAP_FILE, `${out}\n`, { author: 'shiori' });
  await record(store, trip, { type: 'recap', actor: 'system', data: { path: RECAP_FILE, chars: text.length, photos: blobs.length, points: j.points.length }, blobs });
  return { text: out, photos: blobs.length, chars: text.length };
}
```

In `sw.js`, add `'/src/core/after/recap.js',` to `SHELL`.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/after-recap.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/after/recap.js sw.js test/unit/after-recap.test.js && git commit -m "The recap: the utility model writes /trip/recap.md from the trip's stays and moves, stamps, plan, words and cards, notes, memory and up to six photos, never the raw track; the log names the photo copies it sent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 5: Shiori tells it by voice; the Big Sur drive simulated and recapped

**Files:**
- Modify: `src/core/agent/loop.js` (the `recap` wake kind; `aloud`), `sw.js` (`SHELL`: the sample)
- Move: `test/fixtures/live/big-sur.json` → `assets/simulations/big-sur.json` (`git mv`)
- Create: `test/unit/big-sur-kit.js` (the drive, its rules and labels, shared)
- Modify: `test/unit/live-big-sur.test.js` (uses the kit), `test/unit/pack-plan.test.js` (the sample's new path)
- Test: `test/unit/agent-recap.test.js`, `test/unit/after-big-sur.test.js`

**Interfaces:**
- Consumes: Task 4's `writeRecap`, `TELL_RECAP`, `RECAP_FILE`; Task 3's `readJourney`.
- Produces: `WakeKind` gains `'recap'`; `Wake` gains `aloud?: boolean` (that turn is spoken even with voice off); `test/unit/big-sur-kit.js` exports `DRIVE`, `RULES`, `NARRATE`, `EXPECTED`, `label(reasons)`, `places(url)`, `driveBigSur({ utility? }): Promise<{ k, live, track }>`.

- [ ] **Step 1: Write the failing tests**

`test/unit/agent-recap.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { TELL_RECAP } from '../../src/core/after/recap.js';

test('asked to tell the recap, Shiori reads it and says it aloud, even with voice off; the tap is the user\'s, so budgets don\'t hold it (spec §13, choice 6)', async () => {
  const k = await agentKit([{
    rules: [{
      match: "asked to hear the trip's recap",
      reply: { toolCalls: [{ name: 'read', input: { path: '/trip/recap.md' } }] },
      then: { toolCalls: [{ name: 'speak', input: { text: 'Friday began at Bixby Bridge.' } }, { name: 'sleep', input: {} }] },
    }],
  }], { voice: { mode: 'off' } });
  await k.ws.write(k.trip, '/recap.md', '# Big Sur\n\nFriday began at Bixby Bridge.\n', { author: 'shiori' });
  const { updateAppSettings } = await import('../../src/core/settings.js');
  await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 1 } } });
  await k.agent.wake({ kind: 'trigger', text: 'something fired' }); // uses the hour's one wake
  await k.agent.idle();
  await k.agent.wake({ kind: 'recap', aloud: true, text: TELL_RECAP });
  await k.agent.idle();
  assert.ok(k.said.includes('Friday began at Bixby Bridge.'), k.said.join(' | '));
  const [speak] = (await k.events(['out.speak'])).slice(-1);
  assert.equal(speak.data.voice, true);
  const wake = (await k.events(['wake'])).at(-1);
  assert.deepEqual(wake.data.reasons.map((/** @type {any} */ r) => r.kind), ['recap']);
  assert.equal(k.voice.on, false); // the voice setting itself didn't change
});
```

`test/unit/after-big-sur.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveBigSur } from './big-sur-kit.js';
import { writeRecap, RECAP_SYSTEM } from '../../src/core/after/recap.js';
import { readJourney } from '../../src/core/after/journey.js';

const RECAP = '# Big Sur on Highway 1\n\n## Friday, November 27\n\nFrom Monterey down the coast to Cambria.\n\n## Highlights\n\n- Lunch at Nepenthe';

test('the Big Sur drive, simulated through live mode and Shiori, is recapped by the scripted model into /trip/recap.md (spec §20, milestone 7)', async () => {
  const { k } = await driveBigSur({ utility: [{ text: RECAP }] });
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip });
  // The five plan places the drive arrived at earned stamps; the stops off the plan, with no offline pack, didn't.
  assert.deepEqual(j.stamps.map((s) => s.name), ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']);
  const stays = j.entries.filter((e) => e.kind === 'stay').map((e) => /** @type {any} */ (e).name);
  for (const n of ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']) assert.ok(stays.includes(n), stays.join(', '));
  assert.ok(stays.includes(null), 'the River Inn, Ragged Point and the pier are stays without a name');
  assert.ok(j.entries.some((e) => e.kind === 'move' && e.gap), 'the phone was locked from 15:18 to 16:05');
  assert.deepEqual(j.days, ['2026-11-27']);

  await writeRecap({ store: k.store, ws: k.ws, llm: k.llm, trip: k.trip });
  assert.equal(await k.ws.readText(k.trip, '/recap.md'), `${RECAP}\n`);
  const asked = k.requests.at(-1);
  assert.equal(asked.system, RECAP_SYSTEM);
  const text = asked.messages[0].parts[0].text;
  assert.match(text, /stayed\tNepenthe/);
  assert.match(text, /worked out from \d{4} location points/);
  assert.ok(text.length < 20_000, String(text.length)); // the day in words, not its thousands of points
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/agent-recap.test.js test/unit/after-big-sur.test.js`
Expected: FAIL: agent-recap: nothing was said (`k.said` is empty): a `recap` wake isn't the user's yet, so the per-hour limit drops it, and voice off would make it a bubble anyway; after-big-sur: `Cannot find module './big-sur-kit.js'`.

- [ ] **Step 3: Write the code**

`git mv test/fixtures/live/big-sur.json assets/simulations/big-sur.json`. In `test/unit/pack-plan.test.js`, read it from `'../../assets/simulations/big-sur.json'`.

`test/unit/big-sur-kit.js`: move everything above the `test(…)` call in `test/unit/live-big-sur.test.js` here (the imports, `DRIVE` read from `'../../assets/simulations/big-sur.json'`, `sleep`, `speak`, `NARRATE`, `RULES`, `EXPECTED`, `label`, `places`), exported, and add the drive itself:
```js
/**
 * The Big Sur drive (spec §18) on a memory annai: the plan and bookings written, live mode turned on in
 * Monterey, and the whole track run through the sensors on a manual clock, each step settled.
 * @param {{ utility?: any[] }} [o] utility: a script for a utility model (the recap's)
 */
export async function driveBigSur({ utility } = {}) {
  const track = trackFrom(DRIVE);
  const clock = new ManualClock(track[0].at);
  /** @type {Simulation | null} */
  let sim = null;
  const k = await agentKit([{ rules: RULES }], {
    agent: { now: clock.now, timeZone: () => DRIVE.timezone, online: () => sim?.online ?? true, fetch: places },
    voice: { mode: 'auto' }, ...(utility ? { utility } : {}),
  });
  await k.host.addBuiltin(new URL('../../src/plugins/places/index.js', import.meta.url).href);
  await k.ws.patch(k.trip, '/trip.json', { timezones: [DRIVE.timezone] }, { author: 'user' });
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
  return { k, live, track };
}
```
`test/unit/live-big-sur.test.js` keeps its one test, now starting with `const { k } = await driveBigSur();` and importing `driveBigSur`, `EXPECTED`, `NARRATE`, `label` from `./big-sur-kit.js`; its assertions don't change.

In `src/core/agent/loop.js`:
- the `WakeKind` typedef gains `| 'recap'` and its note: `recap: the user asked to hear the trip's recap (spec §13)`;
- the `Wake` typedef gains `aloud?: boolean` with the note `aloud: this turn is spoken even with voice off (the user asked to hear her, spec §13)`;
- in `wake(w)`, the kinds that skip budgets become `w.kind === 'user' || w.kind === 'choice' || w.kind === 'restart' || w.kind === 'file' || w.kind === 'live' || w.kind === 'recap'`;
- in `#turn`, `this.#voiceNow = await this.#voiceOn();` becomes `this.#voiceNow = await this.#voiceOn(wakes.some((w) => w.aloud));`;
- `#voiceOn` becomes:
```js
  /**
   * Whether voice is on for this turn (spec §10.5): it is on, and speak isn't switched off (§7.2). A
   * wake that asks for her voice (the recap told aloud) has it whatever the mode (choice 6).
   * @param {boolean} [asked]
   */
  async #voiceOn(asked = false) {
    if (!this.voice) return false;
    await this.voice.refresh();
    return (this.voice.on || asked) && (await toolSwitches(this.ws)).speak !== false;
  }
```

In `sw.js`, add `'/assets/simulations/big-sur.json',` to `SHELL` (after `/assets/shiori.svg`).

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/agent-recap.test.js test/unit/after-big-sur.test.js test/unit/live-big-sur.test.js test/unit/pack-plan.test.js test/unit/sw-shell.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A assets/simulations test/fixtures/live src/core/agent/loop.js sw.js test/unit/big-sur-kit.js test/unit/live-big-sur.test.js test/unit/pack-plan.test.js test/unit/agent-recap.test.js test/unit/after-big-sur.test.js && git commit -m "Shiori tells the recap aloud when asked, even with voice off; the Big Sur drive, simulated through live mode and Shiori, is recapped by the scripted model into /trip/recap.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 6: A clock that plays at a speed; a recorded track; a run that stops and pauses

**Files:**
- Modify: `src/core/live/clock.js` (`PlayClock`), `src/core/live/simulate.js` (`trackFromLog`, `run` options, `SIMULATION`)
- Test: `test/unit/live-play-clock.test.js`, `test/unit/live-simulate.test.js`

**Interfaces:**
- Consumes: `realClock`, `ManualClock`, `Clock` (clock.js); `meters` (geo.js).
- Produces:
  - `class PlayClock implements Clock { constructor(start: number, o?: { speed?: number, base?: Clock, playing?: boolean }); now(); set(fn, ms); clear(h); speed (get/set); playing: boolean (get); play(); pause(); seek(t: number); onChange(fn): () => void }`. Its timers are in its own time; pausing, a new speed or a seek waits them again from there.
  - `trackFromLog(points: { lat, lng, at, accuracy?, speed? }[], o?: { stillSec?: number }): TrackEvent[]` (throws a plain Error with fewer than two points).
  - `Simulation.run(clock, settle?, { from?, to?, signal?, gate? })`: `signal` stops it; `gate()` is awaited before each event (pausing).
  - `SIMULATION = 'simulation'`: the plugin id a Simulation's sensors are registered under.

- [ ] **Step 1: Write the failing tests**

`test/unit/live-play-clock.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock, PlayClock } from '../../src/core/live/clock.js';

test('a play clock runs at its speed, pauses, moves, and changes speed; its timers follow (spec §13, §18)', async () => {
  const base = new ManualClock(0);
  const c = new PlayClock(1_000_000, { speed: 10, base });
  /** @type {string[]} */
  const ran = [];
  c.set(() => ran.push('a'), 60_000); // a minute of its time: 6 s of the base's at 10×
  await base.advanceTo(3000);
  assert.equal(c.now(), 1_030_000);
  c.pause();
  await base.advanceTo(60_000);
  assert.equal(c.now(), 1_030_000);
  assert.deepEqual(ran, []); // paused: the timer waits
  c.speed = 60;
  c.play();
  await base.advanceTo(60_499);
  assert.deepEqual(ran, []);
  await base.advanceTo(60_500); // the 30 s left, at 60×
  assert.deepEqual(ran, ['a']);
  c.set(() => ran.push('b'), 3_600_000);
  c.seek(2_000_000_000);
  await base.advanceTo(60_501); // moved past it: it runs at once
  assert.deepEqual(ran, ['a', 'b']);
  const gone = c.set(() => ran.push('x'), 1000);
  c.clear(gone);
  await base.advanceTo(70_000);
  assert.deepEqual(ran, ['a', 'b']);
});

test('a play clock tells who listens when it plays, pauses, moves or changes speed', () => {
  const c = new PlayClock(0, { base: new ManualClock(0), playing: false });
  let n = 0;
  const off = c.onChange(() => n++);
  c.play();
  c.speed = 600;
  c.seek(5);
  c.pause();
  off();
  c.play();
  assert.equal(n, 4);
  assert.equal(c.playing, true);
  assert.equal(c.speed, 600);
});
```

Add to `test/unit/live-simulate.test.js`:
```js
test('a recorded track: still fixes fill the stops the log kept no points for, and a jump marks the phone locked (spec §13, choice 12)', () => {
  const at = (/** @type {string} */ t) => Date.parse(`2026-11-27T${t}:00-08:00`);
  const track = trackFromLog([
    { lat: 36.3715, lng: -121.9017, at: at('09:30'), accuracy: 8, speed: 0 },
    { lat: 36.3716, lng: -121.9016, at: at('09:50'), accuracy: 8, speed: 1.2 }, // the leaving, 20 min later
    { lat: 36.36, lng: -121.89, at: at('09:52'), accuracy: 8, speed: 14 },
    { lat: 35.68, lng: -121.17, at: at('16:40'), accuracy: 12 }, // unlocked at Hearst Castle
  ]);
  const fixes = track.filter((e) => e.kind === 'fix');
  assert.equal(fixes.filter((e) => e.at > at('09:30') && e.at < at('09:50')).length, 119); // every 10 s while stopped
  assert.ok(fixes.filter((e) => e.at > at('09:30') && e.at < at('09:50')).every((e) => e.kind === 'fix' && e.fix.speed === 0));
  assert.deepEqual(track.filter((e) => e.kind !== 'fix').map((e) => [e.kind, e.at]), [['hide', at('09:52') + 1000], ['show', at('16:40') - 1000]]);
  assert.equal(/** @type {any} */ (fixes.at(-1)).fix.speed, undefined); // no speed recorded: the GPS's own isn't made up
  assert.throws(() => trackFromLog([{ lat: 1, lng: 1, at: 0 }]), /^Error: That trip has no recorded track yet: live mode records one while it is on\.$/);
});

test('a run stops when told, and waits at its gate', async () => {
  const registry = new Registry();
  const track = trackFrom({ start: '2026-11-27T09:00:00-08:00', route: [{ lat: 36.6, lng: -121.9, leave: '09:01' }, { lat: 36.5, lng: -121.9, arrive: '09:11' }], endMin: 1 });
  const sim = new Simulation({ registry, track });
  const clock = new ManualClock(track[0].at);
  const abort = new AbortController();
  let sent = 0;
  /** @type {() => void} */
  let open = () => {};
  const gate = () => (sent === 10 ? new Promise((resolve) => { open = () => resolve(undefined); }) : Promise.resolve());
  const running = sim.run(clock, async () => { sent++; if (sent === 20) abort.abort(); }, { signal: abort.signal, gate });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent, 10); // waiting at the gate
  open();
  await running;
  assert.equal(sent, 20); // stopped
  assert.equal(SIMULATION, 'simulation');
});
```
(and `trackFromLog`, `SIMULATION` join the test file's import from `simulate.js`; `Registry` and `ManualClock` are imported there already, or add them.)

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/live-play-clock.test.js test/unit/live-simulate.test.js`
Expected: FAIL: `PlayClock` is not exported; `trackFromLog` is not exported.

- [ ] **Step 3: Write the code**

Add to `src/core/live/clock.js`:
```js
/**
 * A clock that plays time at a speed from a moment, and can pause, change speed or move (spec §13:
 * the replay's playback at adjustable speed; §18: a simulation at 10×). Its timers are in its own
 * time: when it pauses, changes speed or moves, they wait again from there, and one it moved past
 * runs at once. Long waits are the base clock's to hold (the real one waits in steps).
 */
export class PlayClock {
  /** @type {Clock} */
  #base;
  /** Its time when it last started, paused, moved or changed speed… */
  #pos;
  /** …and the base's time then. */
  #t0;
  #speed;
  #playing;
  /** @type {Map<number, { at: number, fn: () => void, h: any }>} */
  #timers = new Map();
  #seq = 0;
  /** @type {Set<() => void>} */
  #listeners = new Set();

  /** @param {number} start @param {{ speed?: number, base?: Clock, playing?: boolean }} [o] */
  constructor(start, { speed = 1, base = realClock(), playing = true } = {}) {
    this.#base = base;
    this.#pos = start;
    this.#t0 = base.now();
    this.#speed = speed;
    this.#playing = playing;
  }

  now = () => (this.#playing ? this.#pos + (this.#base.now() - this.#t0) * this.#speed : this.#pos);

  /** @param {() => void} fn @param {number} ms of its own time */
  set = (fn, ms) => {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.now() + Math.max(0, ms), fn, h: null });
    this.#arm(id);
    return id;
  };

  /** @param {any} id */
  clear = (id) => {
    const t = this.#timers.get(id);
    if (t && t.h !== null) this.#base.clear(t.h);
    this.#timers.delete(id);
  };

  get speed() {
    return this.#speed;
  }

  set speed(v) {
    if (!(v > 0) || v === this.#speed) return;
    this.#mark();
    this.#speed = v;
    this.#changed();
  }

  get playing() {
    return this.#playing;
  }

  play() {
    if (this.#playing) return;
    this.#t0 = this.#base.now();
    this.#playing = true;
    this.#changed();
  }

  pause() {
    if (!this.#playing) return;
    this.#mark();
    this.#playing = false;
    this.#changed();
  }

  /** Moves to t. @param {number} t */
  seek(t) {
    this.#pos = t;
    this.#t0 = this.#base.now();
    this.#changed();
  }

  /** @param {() => void} fn @returns {() => void} */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  #mark() {
    this.#pos = this.now();
    this.#t0 = this.#base.now();
  }

  /** @param {number} id */
  #arm(id) {
    const t = this.#timers.get(id);
    if (!t || !this.#playing) return;
    t.h = this.#base.set(() => {
      t.h = null;
      if (!this.#timers.has(id)) return;
      if (this.now() + 1 < t.at) {
        this.#arm(id); // woken a little early: wait the rest
        return;
      }
      this.#timers.delete(id);
      t.fn();
    }, Math.max(0, (t.at - this.now()) / this.#speed));
  }

  #changed() {
    for (const [id, t] of this.#timers) {
      if (t.h !== null) this.#base.clear(t.h);
      t.h = null;
      this.#arm(id);
    }
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (e) {
        console.warn('a clock listener failed', e);
      }
    }
  }
}
```

In `src/core/live/simulate.js`:
- the `TrackFix` typedef's `speed: number` becomes `speed?: number` (a recorded point may have none);
- export the plugin id, after `DEG`:
```js
/** The plugin id a simulation's sensors are registered under: live mode tells them from the phone's. */
export const SIMULATION = 'simulation';
```
  and `registry.add('simulation', 'sensor', …)` becomes `registry.add(SIMULATION, 'sensor', …)`;
- the sort at the end of `trackFrom` becomes `return out.sort(byTime);` with, above `trackFrom`:
```js
/** In time order; at the same moment a mark comes first: the phone is unlocked, then its GPS gives a fix. @param {TrackEvent} a @param {TrackEvent} b */
const byTime = (a, b) => a.at - b.at || (a.kind === 'fix' ? 1 : 0) - (b.kind === 'fix' ? 1 : 0);
```
- add after `trackFrom`:
```js
/**
 * A track from a trip's recorded location points (spec §13: "a recorded … GPS track"). The log keeps
 * a point only after moving (§4.5), so a stop between two points close together a minute or more
 * apart is filled with still fixes; where the track jumps (a kilometre or more after ten minutes or
 * more: the phone was locked, or annai closed) the phone is marked locked, so catch-up runs as it did.
 * @param {{ lat: number, lng: number, at: number, accuracy?: number, speed?: number }[]} points in time order
 * @param {{ stillSec?: number }} [o] @returns {TrackEvent[]}
 */
export function trackFromLog(points, { stillSec = 10 } = {}) {
  if (points.length < 2) throw new Error('That trip has no recorded track yet: live mode records one while it is on.');
  const still = stillSec * 1000;
  /** @type {TrackEvent[]} */
  const out = [];
  for (let k = 0; k < points.length; k++) {
    const p = points[k];
    const accuracy = p.accuracy ?? 10;
    out.push({ at: p.at, kind: 'fix', fix: { lat: p.lat, lng: p.lng, accuracy, ...(typeof p.speed === 'number' ? { speed: p.speed } : {}) } });
    const q = points[k + 1];
    if (!q) break;
    const gap = q.at - p.at;
    const d = meters(p, q);
    if (gap > 60_000 && d < 150) {
      for (let t = p.at + still; t < q.at; t += still) out.push({ at: t, kind: 'fix', fix: { lat: p.lat, lng: p.lng, accuracy, speed: 0 } });
    } else if (gap >= 10 * 60_000 && d >= 1000) {
      out.push({ at: p.at + 1000, kind: 'hide' }, { at: q.at - 1000, kind: 'show' });
    }
  }
  return out.sort(byTime);
}
```
- `run` gains its options:
```js
  /**
   * As fast as it can go, on a manual clock: each event at its time, settle() after each. signal stops
   * it; gate() is awaited before each event (a pause).
   * @param {import('./clock.js').ManualClock} clock @param {() => Promise<unknown>} [settle]
   * @param {{ from?: number, to?: number, signal?: AbortSignal, gate?: () => Promise<unknown> }} [o]
   */
  async run(clock, settle = async () => {}, { from = -Infinity, to = Infinity, signal, gate } = {}) {
    for (const e of this.track) {
      if (signal?.aborted) return;
      if (e.at < from || e.at > to) continue;
      if (gate) await gate();
      if (signal?.aborted) return;
      await clock.advanceTo(e.at, settle);
      this.send(e);
      await settle();
    }
  }
```

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/live-play-clock.test.js test/unit/live-simulate.test.js test/unit/live-big-sur.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/live/clock.js src/core/live/simulate.js test/unit/live-play-clock.test.js test/unit/live-simulate.test.js && git commit -m "A clock that plays at a speed, pauses and moves, its timers following; a track from a trip's recorded points, its stops filled in and its gaps marked locked; a simulation run that stops and waits at a gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 7: A simulation takes live mode and Shiori over, and gives them back

**Files:**
- Modify: `src/core/live/live.js` (`simulate()`, `simulating`; sensors told apart by plugin), `src/core/agent/loop.js` (`useClock()`, `working`, entries in the Agent's time)
- Create: `src/core/live/sim-run.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/live-sim-run.test.js`

**Interfaces:**
- Consumes: Task 6's `PlayClock`, `trackFromLog`, `SIMULATION`, `Simulation.run(…, { signal, gate })`; Task 5's sample at `assets/simulations/big-sur.json` and `test/unit/big-sur-kit.js` (`RULES`, `places`, `DRIVE`); Task 3's `readJourney` (tests); `createTrip`, `removeTrip` (scopes.js); `pointsOf` (route.js); `PLAN_FILE`, `BOOKING_FILE` (plan.js).
- Produces:
  - `Live.simulate({ clock, timeZone, trip }): Promise<() => Promise<void>>` (the function gives live mode back); `Live.simulating: boolean`; while simulating, `setLive` doesn't save the switch, and while another trip than the simulation's is open, live mode does nothing.
  - `Agent.useClock({ now, online, timeZone }): () => void` (restores); `Agent.working: boolean` (a turn runs, wakes wait, or budgets are being checked); every conversation entry the Agent writes is stamped `this.now()`.
  - `SimRun` (`src/core/live/sim-run.js`): `new SimRun({ store, ws, registry, agent, live, base? })`; `start(source: SimSource, { speed?: SimSpeed }): Promise<{ trip }>`; `finished: Promise<void>`; `state: SimState | null`; `running: boolean`; `now(): number | null`; `pause()`, `resume()`, `setSpeed(n)`, `stop()`; `onChange(fn): () => void`; `SPEEDS = [10, 60, 600]`; `SimSource = { kind: 'itinerary', itinerary } | { kind: 'trip', trip }`; `SimSpeed = 'fast' | number`; `SimState = { trip, title, tz, from, to, speed, paused, done, stopped, error }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/live-sim-run.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { liveKit, at, LA, MONTEREY, BIXBY } from './live-kit.js';
import { RULES, DRIVE, places } from './big-sur-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock, realClock } from '../../src/core/live/clock.js';
import { Simulation, trackFrom } from '../../src/core/live/simulate.js';
import { watchTools } from '../../src/core/live/watch-tools.js';
import { SimRun } from '../../src/core/live/sim-run.js';
import { readJourney } from '../../src/core/after/journey.js';
import { readAppSettings } from '../../src/core/settings.js';
import { listTrips, createTrip } from '../../src/core/scopes.js';

test('a simulation takes live mode over: its clock, its sensors only, live on without saving the switch; then gives it back (choice 10)', async () => {
  const k = await liveKit({ live: false });
  const clock = new ManualClock(at('09:00'));
  const realWas = k.live.clock;
  const giveBack = await k.live.simulate({ clock, timeZone: () => LA, trip: k.trip });
  assert.equal(k.live.simulating, true);
  const sim = new Simulation({ registry: k.registry, track: [] });
  await k.live.setLive(true);
  await k.live.settled();
  assert.equal(k.live.on, true);
  assert.equal((await readAppSettings(k.ws)).live?.on, undefined); // not saved
  assert.equal(k.sensors.gpsOn(), false); // the phone's GPS isn't started
  k.sensors.visible(false); // the phone's own visibility isn't heard
  sim.send({ at: at('09:00'), kind: 'fix', fix: { lat: BIXBY.lat, lng: BIXBY.lng, accuracy: 8, speed: 0 } });
  await k.live.settled();
  assert.equal(k.live.shown, true);
  assert.equal(k.live.fix?.lat, BIXBY.lat);
  assert.equal(k.live.fix?.at, at('09:00')); // in the simulation's time
  const [point] = await k.events(['location']);
  assert.equal(point.ts, at('09:00'));
  sim.dispose();
  await giveBack();
  assert.equal(k.live.simulating, false);
  assert.equal(k.live.clock, realWas);
  assert.equal(k.live.on, false); // as the user left it
  assert.equal(k.live.fix, null);
  await assert.doesNotReject(giveBack()); // twice is fine
});

test("the Agent on a simulation's clock stamps the conversation in its time, then goes back to the device's (choice 11)", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Hi.' } }, { name: 'sleep', input: {} }] }]]);
  const t = Date.parse('2026-11-27T12:00:00-08:00');
  const restore = k.agent.useClock({ now: () => t, online: () => true, timeZone: () => LA });
  k.agent.send('Hello');
  assert.equal(k.agent.working, true);
  await k.agent.idle();
  assert.equal(k.agent.working, false);
  for (const e of await k.events(['msg.user', 'wake', 'out.speak'])) assert.equal(e.ts, t, e.type);
  restore();
  assert.notEqual(k.agent.now(), t);
});

/** A memory annai as the app has it: an Agent with Shiori's scripted rules, live mode on the real clock, the phone's sensors, and a SimRun. */
async function anApp(/** @type {any} */ o = {}) {
  const k = await agentKit([{ rules: RULES }], { agent: { fetch: places }, voice: { mode: 'auto' } });
  await k.host.addBuiltin(new URL('../../src/plugins/places/index.js', import.meta.url).href);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent });
  k.agent.addLoopTools(watchTools(live));
  k.agent.sense = () => live.nowInfo();
  await live.start();
  const run = new SimRun({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, live, ...o });
  return { k, live, run };
}

test('Simulate a trip: the Big Sur sample, as fast as it can go, in a new trip of its own; afterwards everything is as it was (spec §13)', async () => {
  const { k, live, run } = await anApp();
  const { trip } = await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 'fast' });
  assert.notEqual(trip, k.trip);
  assert.equal(run.running, true);
  await run.finished;
  assert.deepEqual([run.state?.done, run.state?.error, run.state?.stopped], [true, null, false]);
  assert.equal(run.state?.title, 'Big Sur on Highway 1: Monterey to Cambria (simulation)');
  const j = await readJourney({ store: k.store, ws: k.ws, trip });
  assert.deepEqual(j.stamps.map((s) => s.name), ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']);
  assert.equal(j.tz, 'America/Los_Angeles');
  assert.equal((await k.ws.readJSON(trip, '/plan/nepenthe.json')).title, 'Lunch at Nepenthe');
  const wakes = await k.store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: ['wake'] }));
  assert.ok(wakes.length >= 20, String(wakes.length));
  assert.ok(wakes.every((e) => new Date(e.ts).toISOString().startsWith('2026-11-27')), 'stamped in simulated time');
  // As it was: the trip open before, live mode off and unsaved, the real clock.
  assert.equal(k.agent.target, k.trip);
  assert.equal((await readAppSettings(k.ws)).activeTrip, k.trip);
  assert.deepEqual([live.simulating, live.on, (await readAppSettings(k.ws)).live?.on], [false, false, undefined]);
  assert.ok(Math.abs(k.agent.now() - Date.now()) < 5000);
});

test("a recorded track: a trip's own points, played again in a new trip, earn the same stamps (choice 12)", async () => {
  const { k, run } = await anApp();
  const { trip: first } = await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 'fast' });
  await run.finished;
  const { trip } = await run.start({ kind: 'trip', trip: first }, { speed: 'fast' });
  await run.finished;
  assert.equal(run.state?.error, null);
  assert.equal(run.state?.title, 'Big Sur on Highway 1: Monterey to Cambria (simulation) (simulation)');
  const j = await readJourney({ store: k.store, ws: k.ws, trip });
  assert.deepEqual(j.stamps.map((s) => s.name), ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']);
  assert.equal((await k.ws.readJSON(trip, '/bookings/lodge.json')).confirmation, 'CPL-5531');
});

test('at ten times real time it plays on its clock, pauses, changes speed and stops; stopped, everything is as it was', async () => {
  const base = new ManualClock(0);
  const { k, live, run } = await anApp({ base });
  const short = { name: 'Around Monterey', start: '2026-11-27T09:00:00-08:00', timezone: LA, route: [{ ...MONTEREY, leave: '09:05' }, { ...BIXBY, arrive: '09:35' }], endMin: 10 };
  await run.start({ kind: 'itinerary', itinerary: short }, { speed: 10 });
  const t0 = /** @type {number} */ (run.now());
  await base.advanceTo(60_000, () => live.settled());
  assert.equal(run.now(), t0 + 600_000); // a minute is ten
  run.pause();
  await base.advanceTo(120_000, () => live.settled());
  assert.equal(run.now(), t0 + 600_000);
  assert.equal(run.state?.paused, true);
  run.resume();
  run.setSpeed(60);
  assert.equal(run.state?.speed, 60);
  await base.advanceTo(150_000, () => live.settled());
  assert.equal(run.now(), t0 + 600_000 + 1_800_000);
  run.stop();
  await run.finished;
  assert.deepEqual([run.state?.done, run.state?.stopped], [true, true]);
  assert.deepEqual([live.simulating, live.on, k.agent.target], [false, false, k.trip]);
  assert.ok((await k.store.tx(['events'], 'readonly', (t) => t.listEvents(/** @type {string} */ (run.state?.trip), { types: ['location'] }))).length > 10);
});

test('opening another trip stops the simulation; that trip stays open, and nothing of the simulation goes into it (choice 10)', async () => {
  const base = new ManualClock(0);
  const { k, live, run } = await anApp({ base });
  const other = await createTrip(k.ws, { title: 'Kyoto in spring' });
  await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 10 });
  await base.advanceTo(120_000, () => live.settled()); // twenty minutes into the drive
  await k.agent.open(other);
  await base.advanceTo(240_000, () => live.settled());
  await run.finished;
  assert.deepEqual([run.state?.stopped, run.state?.done, k.agent.target], [true, true, other]);
  assert.deepEqual(await k.store.tx(['events'], 'readonly', (t) => t.listEvents(other, { types: ['location', 'trigger.fired'] })), []);
});

test('a broken itinerary is a plain error, and no trip is made; one already running refuses a second', async () => {
  const { k, run } = await anApp();
  const before = (await listTrips(k.store)).active.length;
  await assert.rejects(run.start({ kind: 'itinerary', itinerary: { name: 'x', start: 'soon', route: [] } }, { speed: 'fast' }), /^Error: An itinerary needs a start/);
  await assert.rejects(run.start({ kind: 'itinerary', itinerary: { ...DRIVE, plan: { bad: { title: 'No id' } } } }, { speed: 'fast' }), /The itinerary's plan item "bad" doesn't fit annai's plan format/);
  assert.equal((await listTrips(k.store)).active.length, before);
  assert.equal(run.running, false);
  await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 'fast' });
  await assert.rejects(run.start({ kind: 'itinerary', itinerary: DRIVE }), /^Error: A simulation is already running\. Stop it first\.$/);
  run.stop();
  await run.finished;
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/live-sim-run.test.js`
Expected: FAIL: `Cannot find module '…/src/core/live/sim-run.js'`.

- [ ] **Step 3: Write the code**

In `src/core/agent/loop.js`:
- every entry the Agent writes is stamped with its own clock. In `#log`, `record(this.store, this.scope, ev)` becomes `record(this.store, this.scope, { now: this.now(), ...ev })`; the same for the `record(this.store, s, ev)` and `record(this.store, scope, ev)` loggers in `#keepElsewhere` and `#keepFor`, the `record` in `remind` for another conversation, the compaction entry, the housekeeping tool results, and the voice `state` entry in `#voiceChanged`;
- add after `idle()`:
```js
  /** Whether she is busy: a turn or housekeeping runs, wakes wait, or a wake's budgets are being checked. */
  get working() {
    return this.#busy || this.#queue.length > 0 || this.#checking > 0;
  }

  /**
   * A simulation's clock, zone and connection in place of the device's (spec §13, choice 11), until the
   * returned function puts them back: the conversation's entries are stamped in its time, so a replay lines up.
   * @param {{ now: () => number, online: () => boolean, timeZone: () => string }} c @returns {() => void}
   */
  useClock({ now, online, timeZone }) {
    const was = { now: this.now, online: this.online, timeZone: this.timeZone };
    this.now = now;
    this.online = online;
    this.timeZone = timeZone;
    return () => {
      this.now = was.now;
      this.online = was.online;
      this.timeZone = was.timeZone;
    };
  }
```

In `src/core/live/live.js`:
- import `SIMULATION` from `./simulate.js`;
- add the field `/** @type {{ clock: import('./clock.js').Clock, timeZone: () => string, trip: string } | null} while a simulation runs: the device's clock and zone, and the simulation's trip */ #sim = null;`;
- while a simulation runs and another trip is open, live mode does nothing (choice 10): `#onFix` and `#check` begin with `if (this.#elsewhere()) return;`, with
```js
  /** A simulation runs, and the open trip isn't its own: nothing of it may go there (choice 10). */
  #elsewhere() {
    return this.#sim !== null && this.agent.target !== this.#sim.trip;
  }
```
- `#sensors()` and `#gpsStart()` go over `this.registry.entries('sensor')` (`{ pluginId, item }`) instead of `list('sensor')`, and hear a sensor only when `this.#heeds(pluginId)`:
```js
  /** While a simulation runs, only its sensors are heard (choice 10). @param {string} pluginId */
  #heeds(pluginId) {
    return !this.#sim || pluginId === SIMULATION;
  }
```
  In `#sensors()`, the visibility and connectivity callback becomes `(v) => { if (!this.#heeds(pluginId)) return; if (s.kind === 'visibility') this.visible(Boolean(v)); else this.connected(Boolean(v)); }`. In `#gpsStart()`, a sensor whose plugin isn't heeded is skipped, and its callback checks `this.#heeds(pluginId)` first too.
- in `setLive`, `await updateAppSettings(this.ws, { live: { on } });` becomes `if (!this.#sim) await updateAppSettings(this.ws, { live: { on } }); // a simulation's switch isn't the user's (choice 10)`;
- add after `dispose()`:
```js
  /** A simulation has live mode now (spec §13). */
  get simulating() {
    return this.#sim !== null;
  }

  /**
   * A simulation takes live mode over (spec §13: "feeds a … GPS track and clock through the same
   * machinery", choice 10): its clock and zone, and only its own sensors (the phone's GPS stops; the
   * phone's visibility and connection aren't heard), from nothing known; live mode is then on for it
   * through setLive without saving the switch. The function returned gives live mode back as it was.
   * @param {{ clock: import('./clock.js').Clock, timeZone: () => string, trip: string }} s trip: the simulation's own
   * @returns {Promise<() => Promise<void>>}
   */
  async simulate({ clock, timeZone, trip }) {
    await this.#run(async () => {
      if (this.#sim) throw new Error('A simulation is already running.');
      this.#gpsStop();
      this.#quiet();
      this.#sim = { clock: this.clock, timeZone: this.timeZone, trip };
      this.clock = clock;
      this.timeZone = timeZone;
      this.#fresh(false);
      await this.#check();
    });
    let given = false;
    return async () => {
      if (given) return;
      given = true;
      await this.#run(async () => {
        const was = this.#sim;
        if (!was) return;
        this.#gpsStop();
        this.#quiet();
        this.#sim = null;
        this.clock = was.clock;
        this.timeZone = was.timeZone;
        this.#fresh(Boolean((await readAppSettings(this.ws)).live?.on));
        if (this.on && this.shown) this.#gpsStart();
        await this.#check();
      });
    };
  }

  /** Stops the timer and any catch-up, on the clock they were set on. */
  #quiet() {
    this.#clearTimer();
    if (this.#catch?.timer != null) this.clock.clear(this.#catch.timer);
    this.#catch = null;
  }

  /** Nothing known of where the user is or has been, as live mode starts or ends a simulation. @param {boolean} on */
  #fresh(on) {
    this.on = on;
    this.fix = null;
    this.activity = 'unknown';
    this.odometer = 0;
    this.stop = null;
    this.gps = 'off';
    this.gpsMessage = '';
    this.shown = true;
    this.online = true;
    this.#tracker.reset();
    this.#kept = null;
    this.#odo = null;
    this.#away = null;
    this.#held = [];
    this.#offlineSince = null;
    this.#mem.clear();
    this.#tell();
    this.#tellActivity();
  }
```

`src/core/live/sim-run.js`:
```js
import { trackFrom, trackFromLog, Simulation } from './simulate.js';
import { ManualClock, PlayClock, realClock } from './clock.js';
import { createTrip, removeTrip } from '../scopes.js';
import { updateAppSettings } from '../settings.js';
import { validZone, deviceZone, dayIn } from '../time.js';
import { pointsOf } from '../after/route.js';
import { PLAN_FILE, BOOKING_FILE } from '../plan.js';

/**
 * Developer → "Simulate a trip" (spec §13): a recorded or made-up GPS track and its clock fed through
 * live mode and Shiori as on the road, in a new trip of its own (choice 9), so the replay and the recap
 * can be tried before a real trip. The screen and the tests share it.
 * @typedef {import('./simulate.js').Itinerary & { timezone?: string, plan?: Record<string, any>, bookings?: Record<string, any> }} SimItinerary
 * @typedef {{ kind: 'itinerary', itinerary: SimItinerary } | { kind: 'trip', trip: string }} SimSource
 * @typedef {'fast' | number} SimSpeed  fast: as fast as it can go; a number: that many times real time
 * @typedef {{ trip: string, title: string, tz: string, from: number, to: number, speed: SimSpeed, paused: boolean, done: boolean, stopped: boolean, error: string | null }} SimState
 *   tz: the trip's zone, for its times
 * @typedef {{ track: import('./simulate.js').TrackEvent[], tz: string, title: string, make: () => Promise<string> }} Prepared
 */

/** The speeds a simulation can play at, besides as fast as it can go (choice 13). */
export const SPEEDS = Object.freeze([10, 60, 600]);

/** A file name from an itinerary's key. @param {string} name */
const fileName = (name) => String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';

export class SimRun {
  /** @type {SimState | null} the running simulation, or the last one */
  state = null;
  /** Settles when the running simulation has ended. @type {Promise<void>} */
  finished = Promise.resolve();
  /** @type {import('./clock.js').Clock | null} */
  #clock = null;
  /** @type {Set<() => void>} */
  #listeners = new Set();
  /** @type {AbortController | null} */
  #abort = null;
  /** @type {Promise<void> | null} while paused (as fast as it can go) */
  #held = null;
  /** @type {(() => void) | null} */
  #release = null;
  /** @type {(() => void) | null} ends a timed run */
  #end = null;

  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, registry: import('../registry.js').Registry,
   *   agent: import('../agent/loop.js').Agent, live: import('./live.js').Live, base?: import('./clock.js').Clock }} c
   *   base: the clock a timed simulation plays on (the real one; tests pass a manual one)
   */
  constructor(c) {
    this.c = c;
  }

  get running() {
    return Boolean(this.state && !this.state.done);
  }

  /** The simulated time now, while one runs. */
  now() {
    return this.#clock ? this.#clock.now() : null;
  }

  /** @param {() => void} fn @returns {() => void} */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  /**
   * Starts a simulation in a new trip and settles once it runs; `finished` settles when it ends. A
   * broken source is a plain error, and then no trip is made.
   * @param {SimSource} source @param {{ speed?: SimSpeed }} [o] @returns {Promise<{ trip: string }>}
   */
  async start(source, { speed = 10 } = {}) {
    if (this.running) throw new Error('A simulation is already running. Stop it first.');
    const { agent, live, registry, ws, store } = this.c;
    const p = source.kind === 'trip' ? await this.#fromTrip(source.trip) : this.#fromItinerary(source.itinerary);
    const trip = await p.make();
    const before = agent.target;
    await updateAppSettings(ws, { activeTrip: trip });
    await agent.open(trip);
    const clock = speed === 'fast' ? new ManualClock(p.track[0].at) : new PlayClock(p.track[0].at, { speed, base: this.c.base ?? realClock() });
    this.#clock = clock;
    const giveBack = await live.simulate({ clock, timeZone: () => p.tz, trip });
    const sim = new Simulation({ registry, track: p.track });
    const restore = agent.useClock({ now: clock.now, online: () => sim.online, timeZone: () => p.tz });
    this.state = { trip, title: p.title, tz: p.tz, from: p.track[0].at, to: p.track[p.track.length - 1].at, speed, paused: false, done: false, stopped: false, error: null };
    this.#abort = new AbortController();
    this.#emit();
    const state = this.state;
    // Another trip opened: the simulation stops, and that trip stays open (choice 10).
    const offOpen = agent.on('open', (/** @type {{ trip: string | null }} */ o) => { if (o.trip !== trip) this.stop(); });
    this.finished = (async () => {
      try {
        await live.setLive(true); // Shiori hears it, as when the user turns live mode on
        await this.#settle();
        if (clock instanceof ManualClock) {
          await sim.run(clock, () => this.#settle(), { signal: this.#abort?.signal, gate: () => this.#held ?? Promise.resolve() });
        } else {
          await new Promise((resolve) => {
            this.#end = () => resolve(undefined);
            const stop = sim.play(clock, { onEnd: () => resolve(undefined) });
            this.#abort?.signal.addEventListener('abort', () => { stop(); resolve(undefined); }, { once: true });
          });
        }
        await this.#settle();
      } catch (e) {
        state.error = String(/** @type {any} */ (e)?.message ?? e);
      } finally {
        offOpen();
        sim.dispose();
        await giveBack();
        restore();
        // The trip open before opens again, so the phone's own GPS goes on into it (choice 9), unless the user opened another.
        if (agent.target === trip) {
          const back = before && before !== trip && (await store.tx(['scopes'], 'readonly', (t) => t.getScope(before))) ? before : null;
          await updateAppSettings(ws, { activeTrip: back }).catch(() => {});
          await agent.open(back).catch(() => {});
        }
        this.#clock = null;
        this.#held = null;
        this.#release?.();
        state.done = true;
        state.paused = false;
        this.#emit();
      }
    })();
    return { trip };
  }

  /** Pauses it. */
  pause() {
    const s = this.state;
    if (!s || s.done || s.paused) return;
    s.paused = true;
    if (this.#clock instanceof PlayClock) this.#clock.pause();
    else this.#held = new Promise((resolve) => { this.#release = () => resolve(undefined); });
    this.#emit();
  }

  /** Goes on after a pause. */
  resume() {
    const s = this.state;
    if (!s || s.done || !s.paused) return;
    s.paused = false;
    if (this.#clock instanceof PlayClock) this.#clock.play();
    this.#held = null;
    this.#release?.();
    this.#release = null;
    this.#emit();
  }

  /** A new speed, while it plays in time (as fast as it can go has none). @param {number} speed */
  setSpeed(speed) {
    const s = this.state;
    if (!s || s.done || !(this.#clock instanceof PlayClock) || !(speed > 0)) return;
    this.#clock.speed = speed;
    s.speed = speed;
    this.#emit();
  }

  /** Stops it; what it did stays in its trip. */
  stop() {
    const s = this.state;
    if (!s || s.done) return;
    s.stopped = true;
    this.#abort?.abort();
    this.#end?.();
    this.resume();
  }

  #emit() {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (e) {
        console.warn('a simulation listener failed', e);
      }
    }
  }

  /** Live mode and Shiori have done what this moment asked of them. */
  async #settle() {
    const { live, agent } = this.c;
    for (let i = 0; i < 20; i++) {
      await live.settled();
      await agent.idle();
      await live.settled();
      if (!agent.working) return;
    }
  }

  /** @param {SimItinerary} it @returns {Prepared} */
  #fromItinerary(it) {
    const track = trackFrom(it);
    const tz = validZone(it?.timezone) ? /** @type {string} */ (it.timezone) : deviceZone();
    const title = `${String(it?.name ?? '').trim().slice(0, 150) || 'A simulated trip'} (simulation)`;
    const { ws, store } = this.c;
    return {
      track, tz, title,
      make: async () => {
        const id = await createTrip(ws, { title, start: /** @type {string} */ (dayIn(track[0].at, tz)), end: /** @type {string} */ (dayIn(track[track.length - 1].at, tz)) });
        /** @type {[string, string, any][]} */
        const files = [
          ...Object.entries(it.plan ?? {}).map(([n, v]) => /** @type {[string, string, any]} */ ([`plan item "${n}"`, `/plan/${fileName(n)}.json`, v])),
          ...Object.entries(it.bookings ?? {}).map(([n, v]) => /** @type {[string, string, any]} */ ([`booking "${n}"`, `/bookings/${fileName(n)}.json`, v])),
        ];
        try {
          await ws.patch(id, '/trip.json', { timezones: [tz] }, { author: 'user' });
          for (const [what, path, value] of files) {
            try {
              await ws.write(id, path, value, { author: 'user' });
            } catch (e) {
              const why = /** @type {any} */ (e)?.errors?.join('; ') ?? String(/** @type {any} */ (e)?.message ?? e);
              throw new Error(`The itinerary's ${what} doesn't fit annai's ${path.startsWith('/plan/') ? 'plan' : 'booking'} format: ${why}. Fix it in the file and try again.`);
            }
          }
        } catch (e) {
          await removeTrip(store, id).catch(() => {});
          throw e;
        }
        return id;
      },
    };
  }

  /** A trip's recorded track, its plan and bookings (choice 12). @param {string} id @returns {Promise<Prepared>} */
  async #fromTrip(id) {
    const { store, ws } = this.c;
    const scope = await store.tx(['scopes'], 'readonly', (t) => t.getScope(id));
    if (!scope || scope.kind !== 'trip') throw new Error("That trip isn't on this device any more.");
    const track = trackFromLog(pointsOf(await store.tx(['events'], 'readonly', (t) => t.listEvents(id, { types: ['location'] }))));
    const info = (await ws.readJSON(id, '/trip.json').catch(() => null)) ?? {};
    const tz = [info.timezones?.[0], deviceZone()].find(validZone) ?? 'UTC';
    const title = `${scope.title.slice(0, 150)} (simulation)`;
    /** @type {[string, any][]} */
    const copies = [];
    for (const f of await ws.list(id, '/')) {
      if (!PLAN_FILE.test(f.path) && !BOOKING_FILE.test(f.path)) continue;
      const v = await ws.readJSON(id, f.path).catch(() => null);
      if (v && typeof v === 'object') copies.push([f.path, v]);
    }
    return {
      track, tz, title,
      make: async () => {
        const t = await createTrip(ws, { title, start: /** @type {string} */ (dayIn(track[0].at, tz)), end: /** @type {string} */ (dayIn(track[track.length - 1].at, tz)) });
        await ws.patch(t, '/trip.json', { timezones: [tz], ...(Array.isArray(info.party) ? { party: info.party } : {}), ...(Array.isArray(info.places) ? { places: info.places } : {}) }, { author: 'user' });
        for (const [path, v] of copies) await ws.write(t, path, v, { author: 'user' }).catch(() => {}); // one annai no longer accepts stays out
        return t;
      },
    };
  }
}
```

In `sw.js`, add `'/src/core/live/sim-run.js',` to `SHELL`.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/live-sim-run.test.js test/unit/live-engine.test.js test/unit/live-big-sur.test.js test/unit/agent-loop.test.js`
Expected: PASS.

Run: `npm run size`
Expected: within the 1150 KiB budget (choice 15). If it isn't, raise `BUDGET` in `scripts/size.mjs` to the next 10 KiB above what it prints, say so in its comment ("1160 for milestone 7's core"), and ledger the raise.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/live/live.js src/core/agent/loop.js src/core/live/sim-run.js sw.js scripts/size.mjs test/unit/live-sim-run.test.js && git commit -m "Simulate a trip: a sample, an itinerary or a trip's recorded track played through live mode and Shiori in a new trip of its own, at 10, 60 or 600 times real time or as fast as it can go; live mode, the clocks and the open trip come back as they were

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
