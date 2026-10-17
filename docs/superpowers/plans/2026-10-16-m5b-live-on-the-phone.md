# Milestone 5b: Live Mode on the Phone (Sensors, the Live Chip, Now and Driving) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live mode works on a real phone:
- **The phone's sensors** (spec §11.2) as a built-in plugin: GPS through `watchPosition` (only while live mode is on and annai is on screen), visibility, connectivity. A refused location says what to do on this phone (§17 rule 3).
- **The live chip**, one tap away on every screen next to the voice chip (§11.1): the switch, "Keep the screen on" chosen per situation, and, with no GPS, "Where are you?" (§17: "a manual place").
- **The Now screen** (§16.2): where you are, golden hour and other chips (sunrise, sunset and golden hour computed on the phone, §11.5), the next items as a timetable, the latest card.
- **The Driving screen** (§16.2): route strip, a maps card, big quick-ask buttons, and the bigger dock.
- **The conversation, the Plan and the Trace** show live mode: reminders as system lines, an undo for each plan item Shiori changed (§11.5: every replan can be undone), and a Live view in the trace that keeps location points out of the rest.
- **The milestone's "Done when", second half:** end to end in both browsers with Playwright's geolocation override, and the device checklist for a real local drive (`docs/testing/device-checklist-m5.md`).

**Architecture:**
- `src/core/sun.js` (pure): sunrise, sunset, civil twilight and golden hour; the Now screen's sun chips.
- `src/core/now.js` (pure): what is next in the plan, and the route strip's stops with their distances.
- `src/plugins/sensors/index.js`: the sensors as registry items of kind `sensor`, which the live engine (5a) starts. A factory takes the browser objects, so it is tested in Node.
- `src/ui/`: `live-chip.js`, `wake-lock.js`, `live-help.js`, `trip-rows.js`, `screens/now.js`, `screens/drive.js`; changes to the dock, the conversation, the Plan, the Trace, the router and the shell.
- The stores gain `notTypes` in event queries, so the trace can leave location points out without reading them all.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26), and Playwright 1.63.0 in Docker (Chromium as Pixel 7, WebKit as iPhone 15), with `context.setGeolocation` and `page.clock`.

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`: §11.1 (the switch; the wake lock "the user's choice per situation"), §11.2 (sensors), §11.5 (sunrise, sunset and golden hour on the phone), §16.2 (Now, Driving), §17 rules 2 and 3 (a manual place without GPS; steps for this phone), §18 (end to end with simulated location; the device checklist), §4.5 and §15 (the trace shows what was recorded).

**Not in this plan:**
- **The offline pack** (§11.5): milestone 5c.
- **The trip simulation's screen** ("Simulate a trip", §13): milestone 7; the machinery is 5a's.
- **Background location** beyond "while annai is on screen": not in the spec (§11.1); a question for the user if ever wanted.

## Choices this plan makes (please check them)

1. **The live chip sits next to the voice chip on the dock,** on every screen ("Live off", "Live · moving fast", "Live · no GPS"). Its menu has the switch, "Keep the screen on while driving or riding" (or walking, or stopped), and "Where are you?" when there is no GPS.
2. **The screen wake lock is remembered per activity** (still, walking, moving fast): §11.1's "the user's choice per situation". Nothing keeps the screen on until it is chosen once for that situation. *Cost if wrong:* the first drive asks for one tap.
3. **Now is in the top menu, first; Trips stays the screen annai opens on.** Many tests and habits start on Trips; Now is one tap away. *Cost if wrong:* a tap at every start of a trip day.
4. **Now hands over to Driving** when live mode says moving fast while Now is on screen, once per visit; Driving has a link back.
5. **Driving's quick-ask buttons:** What's around here?, Food, Fuel, Restroom, How long? Each sends Shiori a plain question; with voice on she answers aloud, and her latest words show on the Driving screen. The dock is the big one there, voice or not (§16.2: "voice layouts, such as driving, enlarge the dock").
6. **The sun chips** use where the user is (live mode), else the next plan stop with a place: sunrise before dawn, golden hour, sunset, dusk; at night, tomorrow's sunrise. Golden hour is the sun below 6° above the horizon.
7. **Without a connection, the weather tool still gives the sun's times,** worked out on the phone (§11.5), in the phone's time zone, and says there is no forecast.
8. **A refused location gets one card** with steps for this phone (§17 rule 3), and live mode stays on with its time reminders; "Where are you?" lists the trip's plan places (§17: "a manual place").
9. **Each plan item Shiori changed shows "Changed by Shiori · Undo"** on the Plan screen; Undo brings back the version before her change, from the file's history (§11.5: "every replan is a set of patches to the plan files, so it can be undone"). An item she added has no Undo; it can be deleted.
10. **The Trace's "Everything" leaves out location points** (a drive logs about one a second); a new "Live" kind shows them, with the firings, reminders and switches. Typing "location" in "Type contains" shows them too.
11. **Reminders show in the conversation as system lines** ("Reminder, said aloud: …"), never as Shiori's bubbles (§16.1).
12. **The size budget** goes from 960 KiB to 1020 KiB in Task 1. You said to raise it as needed and list each raise; this is that list's entry.

## Global Constraints

- All of 5a's Global Constraints hold (`docs/superpowers/plans/2026-10-16-m5a-live-core.md`).
- **"While it's on and annai is on screen: GPS tracking runs. Triggers are evaluated. The screen wake lock is the user's choice per situation" (§11.1).**
- **"Location | watchPosition, thinned as in §4.5" (§11.2).** The sensors plugin reports positions; the engine thins them.
- **"Now, the home screen during a trip: current place, golden hour and other chips, the next items as a timetable, the latest card" (§16.2).**
- **"Driving: route strip, 'Show what she's saying', a maps card, big quick-ask buttons" (§16.2).** **"Voice layouts, such as driving, enlarge the dock; they never move it."**
- **"Sunrise, sunset and golden hour are computed on the phone" (§11.5).**
- **"GPS or location permission | time triggers, and a manual place" (§17 rule 2).** **"Denied permissions get instructions specific to iPhone or Android" (§17 rule 3).**
- **"Location otherwise goes only to the user's own model provider" (§11.7).** Nothing here sends a position anywhere; the maps card's links open the user's maps app only when tapped.
- **"System cards are not Shiori" (§16.1).** **Accessibility (§16.5):** labelled controls, targets of 44 px, visible focus; the chip's menu works with a keyboard.
- **Rendering:** model output never goes into `innerHTML`; no `style` attribute; links only `https:` and `http:`.
- **E2E in Docker only:** `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test`; delete any `core*` file a WebKit crash leaves. When a test changes a Trace filter, use `filterTrace` from `test/e2e/helpers.js`.
- **Size:** Task 1 raises the budget from 960 KiB to 1020 KiB (choice 12).

## Review Focus

1. **Permissions that change underfoot:** location refused, then allowed in the phone's settings; allowed, then revoked while live: the chip and the card say so, live mode keeps its time reminders, turning it off and on again asks once more. Pinned in Tasks 2 and 3.
2. **The page frozen and thawed** (a locked phone, a tab switch, the back-forward cache): GPS stops and starts, the wake lock is asked for again, nothing is counted twice. Pinned in Tasks 2 and 3.
3. **A trip with no plan, no places, or only all-day items:** Now and Driving still open and say what they can; no sun chip without a place; "Where are you?" with no places says so. Pinned in Tasks 4 and 5.
4. **Polar day and night, and time zones far from the phone's:** the sun chips don't show nonsense (no "Sunrise --:--"), and times are the trip's zone's. Pinned in Task 1.
5. **A Trace with thousands of points:** "Everything" stays quick and shows the rest; "Live" shows the points. Pinned in Task 6.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/sun.js`, `src/plugins/places/index.js` | 1 | `sunTimes`, `sunChips`; the weather tool without a connection |
| `scripts/size.mjs` | 1 | the budget |
| `src/plugins/sensors/index.js`, `src/ui/live-help.js`, `src/app/main.js` | 2 | `sensors(env)`, the plugin; `gpsProblem`, `tellGps` |
| `src/ui/wake-lock.js`, `src/ui/live-chip.js`, `src/ui/dock.js`, `src/ui/shiori.css`, `src/app/main.js`, `src/ui/shell.js` | 3 | `keepAwake`, `liveChip`, `liveText`, `whileText`; the dock's `setLarge` |
| `src/core/now.js`, `src/ui/trip-rows.js`, `src/ui/screens/now.js`, `src/ui/shell.js`, `src/ui/base.css` | 4 | `upcoming`, `routeStrip`, `sunPlace`; `tripRows`; the Now screen and its menu entry |
| `src/ui/screens/drive.js`, `src/ui/shell.js`, `src/ui/base.css` | 5 | the Driving screen |
| `src/core/store-memory.js`, `src/core/store-idb.js`, `src/core/types.js`, `test/contract/store-contract.js`, `src/ui/screens/trace.js`, `src/ui/screens/talk.js`, `src/ui/screens/plan.js` | 6 | `notTypes`; the trace's Live kind and summaries; reminders in the conversation; Undo on the Plan |
| `test/e2e/live.spec.js`, `docs/testing/device-checklist-m5.md`, `README.md` | 7 | end to end; the checklist |

---
### Task 1: The sun on the phone, and the weather tool without a connection

**Files:**
- Create: `src/core/sun.js`
- Modify: `src/plugins/places/index.js` (weather), `scripts/size.mjs` (the budget), `sw.js` (`SHELL`)
- Test: `test/unit/sun.test.js`, `test/unit/plugin-places.test.js`

**Interfaces:**
- Consumes: `timeIn`, `deviceZone` (`src/core/time.js`).
- Produces:
  - `SunTimes = { noon, sunrise, sunset, dawn, dusk, goldenMorningEnd, goldenEveningStart, polar }`: ms, or null when that moment doesn't come; `polar: 'day' | 'night' | null`.
  - `sunTimes(ms, lat, lng): SunTimes` for the day whose solar noon is nearest `ms`.
  - `sunChips(now, lat, lng, tz): string[]`: "Sunrise 06:55", "Golden hour until 07:38", "Golden hour 16:17" with "Sunset 16:54", "Golden hour now", "Dusk 17:21", tomorrow's "Sunrise 06:56" at night, "Midnight sun", "Polar night".
  - The weather tool, when Open-Meteo can't be reached: "Open-Meteo didn't answer (…), so there is no forecast. Worked out on the phone, in this phone's time zone (…): sunrise …, sunset …, golden hour until … in the morning and from … in the evening."

- [ ] **Step 1: Write the failing tests**

`test/unit/sun.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunTimes, sunChips } from '../../src/core/sun.js';

const MIN = 60_000;
/** Within two minutes of a published time (api.sunrise-sunset.org, read 2026-10-16). @param {number | null} got @param {string} want */
const near = (got, want) => assert.ok(got !== null && Math.abs(got - Date.parse(want)) <= 2 * MIN, `${got === null ? 'null' : new Date(got).toISOString()} is not ${want}`);

test('sunrise, sunset and civil twilight within two minutes of published times, north and south', () => {
  const bigSur = sunTimes(Date.parse('2026-11-27T12:00:00-08:00'), 36.27, -121.807);
  near(bigSur.sunrise, '2026-11-27T14:55:06Z');
  near(bigSur.sunset, '2026-11-28T00:54:47Z');
  near(bigSur.dawn, '2026-11-27T14:28:32Z');
  near(bigSur.dusk, '2026-11-28T01:21:21Z');
  assert.equal(bigSur.polar, null);
  const sf = sunTimes(Date.parse('2026-06-21T12:00:00-07:00'), 37.7749, -122.4194);
  near(sf.sunrise, '2026-06-21T12:46:36Z');
  near(sf.sunset, '2026-06-22T03:36:32Z');
  near(sf.dawn, '2026-06-21T12:16:49Z');
  near(sf.dusk, '2026-06-22T04:06:20Z');
  const sydney = sunTimes(Date.parse('2026-12-21T12:00:00+11:00'), -33.8688, 151.2093);
  near(sydney.sunrise, '2026-12-20T18:39:17Z');
  near(sydney.sunset, '2026-12-21T09:06:45Z');
  const tokyo = sunTimes(Date.parse('2026-03-20T12:00:00+09:00'), 35.6762, 139.6503);
  near(tokyo.sunrise, '2026-03-19T20:44:06Z');
  near(tokyo.sunset, '2026-03-20T08:53:49Z');
});

test('golden hour: the sun below 6° above the horizon, after sunrise and before sunset', () => {
  const t = sunTimes(Date.parse('2026-11-27T12:00:00-08:00'), 36.27, -121.807);
  const morning = /** @type {number} */ (t.goldenMorningEnd) - /** @type {number} */ (t.sunrise);
  const evening = /** @type {number} */ (t.sunset) - /** @type {number} */ (t.goldenEveningStart);
  assert.ok(morning > 30 * MIN && morning < 60 * MIN, `${morning / MIN} min`);
  assert.ok(Math.abs(morning - evening) < 3 * MIN);
});

test('polar night and midnight sun: no sunrise or sunset, and it says which', () => {
  const night = sunTimes(Date.parse('2026-12-21T12:00:00+01:00'), 69.6492, 18.9553);
  assert.equal(night.sunrise, null);
  assert.equal(night.sunset, null);
  assert.equal(night.polar, 'night');
  near(night.dawn, '2026-12-21T08:31:12Z');
  near(night.dusk, '2026-12-21T12:53:13Z');
  const day = sunTimes(Date.parse('2026-06-21T12:00:00+02:00'), 69.6492, 18.9553);
  assert.equal(day.polar, 'day');
  assert.equal(day.sunrise, null);
  assert.equal(day.dawn, null);
});

test("the Now screen's sun chips through a day, in the place's own zone (spec §11.5)", () => {
  const LA = 'America/Los_Angeles';
  const chips = (/** @type {string} */ hhmm) => sunChips(Date.parse(`2026-11-27T${hhmm}:00-08:00`), 36.27, -121.807, LA);
  assert.match(chips('05:00').join(' | '), /^Sunrise 06:5[45]$/);
  assert.match(chips('07:00').join(' | '), /^Golden hour until 07:\d\d$/);
  assert.match(chips('12:00').join(' | '), /^Golden hour 16:\d\d \| Sunset 16:5[45]$/);
  assert.match(chips('16:40').join(' | '), /^Golden hour now \| Sunset 16:5[45]$/);
  assert.match(chips('17:05').join(' | '), /^Dusk 17:2[012]$/);
  assert.match(chips('21:00').join(' | '), /^Sunrise 06:5[567]$/); // tomorrow's
  // In Tokyo, on a phone set to Los Angeles: the place's zone, not the phone's.
  assert.match(sunChips(Date.parse('2026-03-20T12:00:00+09:00'), 35.6762, 139.6503, 'Asia/Tokyo').join(' | '), /Sunset 17:5[345]$/);
  assert.deepEqual(sunChips(Date.parse('2026-06-21T12:00:00+02:00'), 69.6492, 18.9553, 'Europe/Oslo'), ['Midnight sun']);
  assert.deepEqual(sunChips(Date.parse('2026-12-21T12:00:00+01:00'), 69.6492, 18.9553, 'Europe/Oslo'), ['Polar night']);
});
```

At the end of `test/unit/plugin-places.test.js`:

```js
test('weather without a connection: no forecast, but the sun, worked out on the phone (spec §11.5)', async () => {
  const { run } = await setup();
  const out = await run('weather', { lat: 36.27, lng: -121.807, when: '2026-11-27' }, () => { throw new TypeError('Failed to fetch'); });
  assert.match(out, /^Open-Meteo didn't answer \(Failed to fetch\), so there is no forecast\. Worked out on the phone, in this phone's time zone \([^)]+\): /);
  assert.match(out, /sunrise \d\d:\d\d, sunset \d\d:\d\d, golden hour until \d\d:\d\d in the morning and from \d\d:\d\d in the evening\.$/);
  const far = await run('weather', { lat: 69.6492, lng: 18.9553, when: '2026-12-21' }, () => { throw new TypeError('Load failed'); });
  assert.match(far, /the sun doesn't rise that day; twilight from \d\d:\d\d to \d\d:\d\d\.$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/sun.test.js test/unit/plugin-places.test.js`
Expected: FAIL: `Cannot find module '…/src/core/sun.js'`; the weather test fails with `Error: Failed to fetch` (the tool throws).

- [ ] **Step 3: Write the implementation**

`src/core/sun.js`:

```js
import { timeIn } from './time.js';

/**
 * The sun, worked out on the phone (spec §11.5: "Sunrise, sunset and golden hour are computed on
 * the phone"). The usual formulas (as in Vladimir Agafonkin's SunCalc, after Astronomy Answers),
 * good to about a minute away from the poles.
 * @typedef {{ noon: number, sunrise: number | null, sunset: number | null, dawn: number | null, dusk: number | null,
 *   goldenMorningEnd: number | null, goldenEveningStart: number | null, polar: 'day' | 'night' | null }} SunTimes
 *   ms, or null when that moment doesn't come that day; dawn and dusk: civil twilight, the sun 6° below the horizon;
 *   golden hour: the sun lower than 6° above it; polar: the sun doesn't set (day) or rise (night) that day
 */

const RAD = Math.PI / 180;
const DAY = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
/** The tilt of the Earth's axis. */
const TILT = RAD * 23.4397;

/** @param {number} ms */
const toDays = (ms) => ms / DAY - 0.5 + J1970 - J2000;
/** @param {number} j */
const fromJulian = (j) => (j + 0.5 - J1970) * DAY;
/** @param {number} d */
const anomaly = (d) => RAD * (357.5291 + 0.98560028 * d);
/** @param {number} m */
const longitude = (m) => m + RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m)) + RAD * 102.9372 + Math.PI;
/** @param {number} ds @param {number} m @param {number} l */
const transit = (ds, m, l) => J2000 + ds + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);

/**
 * The sun's times at a place, for the day whose solar noon is nearest ms.
 * @param {number} ms @param {number} lat @param {number} lng @returns {SunTimes}
 */
export function sunTimes(ms, lat, lng) {
  const lw = RAD * -lng;
  const phi = RAD * lat;
  const n = Math.round(toDays(ms) - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const m = anomaly(ds);
  const l = longitude(m);
  const dec = Math.asin(Math.sin(l) * Math.sin(TILT));
  const noon = transit(ds, m, l);
  /** When the sun is at deg above the horizon, rising and setting; a number when it never is (the hour angle's cosine). @param {number} deg */
  const at = (deg) => {
    const c = (Math.sin(deg * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (c < -1 || c > 1) return c;
    const set = transit(J0 + (Math.acos(c) + lw) / (2 * Math.PI) + n, m, l);
    return { rise: fromJulian(noon - (set - noon)), set: fromJulian(set) };
  };
  const horizon = at(-0.833);
  const civil = at(-6);
  const golden = at(6);
  const when = (/** @type {number | { rise: number, set: number }} */ x, /** @type {'rise' | 'set'} */ k) => (typeof x === 'number' ? null : x[k]);
  return {
    noon: fromJulian(noon),
    sunrise: when(horizon, 'rise'), sunset: when(horizon, 'set'),
    dawn: when(civil, 'rise'), dusk: when(civil, 'set'),
    goldenMorningEnd: when(golden, 'rise'), goldenEveningStart: when(golden, 'set'),
    polar: typeof horizon === 'number' ? (horizon < -1 ? 'day' : 'night') : null,
  };
}

/**
 * What the sun is doing, as chips for the Now screen (spec §16.2): the next sunrise, golden hour,
 * sunset or dusk, in the place's own time zone.
 * @param {number} now @param {number} lat @param {number} lng @param {string} tz @returns {string[]}
 */
export function sunChips(now, lat, lng, tz) {
  const t = sunTimes(now, lat, lng);
  const hm = (/** @type {number} */ x) => timeIn(x, tz);
  if (t.polar === 'day') return ['Midnight sun'];
  if (t.polar === 'night') return ['Polar night'];
  const sunrise = /** @type {number} */ (t.sunrise);
  const sunset = /** @type {number} */ (t.sunset);
  if (now < sunrise) return [`Sunrise ${hm(sunrise)}`];
  if (t.goldenEveningStart === null || t.goldenMorningEnd === null) return now < sunset ? ['Golden light all day', `Sunset ${hm(sunset)}`] : [];
  if (now < t.goldenMorningEnd) return [`Golden hour until ${hm(t.goldenMorningEnd)}`];
  if (now < t.goldenEveningStart) return [`Golden hour ${hm(t.goldenEveningStart)}`, `Sunset ${hm(sunset)}`];
  if (now < sunset) return ['Golden hour now', `Sunset ${hm(sunset)}`];
  if (t.dusk !== null && now < t.dusk) return [`Dusk ${hm(t.dusk)}`];
  const tomorrow = sunTimes(now + DAY / 2, lat, lng);
  return tomorrow.sunrise !== null ? [`Sunrise ${hm(tomorrow.sunrise)}`] : [];
}
```

In `src/plugins/places/index.js`:

1. Imports: `import { sunTimes } from '../../core/sun.js';` and `import { deviceZone, timeIn } from '../../core/time.js';`.

2. In `weather`'s `run`, the forecast fetch becomes:

```js
        /** @type {any} */
        let w;
        try {
          w = await json(`https://api.open-meteo.com/v1/forecast?latitude=${round(i.lat)}&longitude=${round(i.lng)}`
            + '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m'
            + '&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=16', call);
        } catch (e) {
          if (call.signal.aborted) throw e;
          return sunOnly(i, e); // spec §11.5: the sun is worked out on the phone
        }
```

3. After the `meters` function, add:

```js
/**
 * No forecast without Open-Meteo, but the sun's times, worked out on the phone (spec §11.5), in this
 * phone's time zone (the place's isn't known without the forecast).
 * @param {{ lat: number, lng: number, when?: string }} i @param {unknown} e
 */
function sunOnly(i, e) {
  const tz = deviceZone();
  const day = /^\d{4}-\d{2}-\d{2}/.exec(String(i.when ?? ''))?.[0];
  const noon = day ? Date.parse(`${day}T12:00:00Z`) - (i.lng / 15) * 3_600_000 : Date.now();
  const t = sunTimes(noon, i.lat, i.lng);
  const hm = (/** @type {number | null} */ x) => (x === null ? '' : timeIn(x, tz));
  const head = `Open-Meteo didn't answer (${String(/** @type {any} */ (e)?.message ?? e).replace(/\.$/, '')}), so there is no forecast. Worked out on the phone, in this phone's time zone (${tz}): `;
  if (t.polar === 'day') return `${head}the sun doesn't set that day.`;
  if (t.polar === 'night') return `${head}the sun doesn't rise that day${t.dawn !== null ? `; twilight from ${hm(t.dawn)} to ${hm(t.dusk)}` : ''}.`;
  const golden = t.goldenMorningEnd === null || t.goldenEveningStart === null
    ? 'the sun stays low, golden light all day'
    : `golden hour until ${hm(t.goldenMorningEnd)} in the morning and from ${hm(t.goldenEveningStart)} in the evening`;
  return `${head}sunrise ${hm(t.sunrise)}, sunset ${hm(t.sunset)}, ${golden}.`;
}
```

In `scripts/size.mjs`: `const BUDGET = 1020 * 1024; // …; 960 for milestone 5 (live mode), then 1020 for its screens`.

In `sw.js` `SHELL`, add `'/src/core/sun.js'` after `'/src/core/store-memory.js'` (alphabetical order with the other `src/core` files).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/sun.test.js test/unit/plugin-places.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/sun.js src/plugins/places/index.js test/unit/sun.test.js test/unit/plugin-places.test.js scripts/size.mjs sw.js && git commit -m "Sunrise, sunset and golden hour worked out on the phone, and the weather tool gives them when there is no connection (spec §11.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 2: The phone's sensors

**Files:**
- Create: `src/plugins/sensors/index.js`, `src/ui/live-help.js`
- Modify: `src/app/main.js` (the plugin, before live mode starts; the card for a refused location), `sw.js` (`SHELL`)
- Test: `test/unit/sensors.test.js`

**Interfaces:**
- Consumes: 5a's sensor items (`{ kind, start(emit): stop }`) and `Live.onChange`, `Live.on`, `Live.gps`; `platform()` (`src/ui/platform.js`).
- Produces:
  - `sensors(env: { geolocation?, document?, window?, navigator? })`: three sensor items. `location` watches the position with `{ enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }` and emits `{ lat, lng, accuracy, speed, heading }` (null for what the phone doesn't say), `{ error: 'denied', message }` for a refusal, `{ error: 'unavailable', message }` for no signal or a timeout (it keeps watching); `visibility` emits whether annai is on screen, at the start and on `visibilitychange`, `pagehide` and `pageshow`; `connectivity` emits `navigator.onLine` at the start and on `online` and `offline`.
  - The built-in plugin `sensors` registers them (kind `sensor`).
  - `gpsProblem(where): { title, body }` with steps for iPhone, Android or a computer; `tellGps({ live, notices, where? })`: one card when live mode's GPS becomes refused, again only after it worked meanwhile.

- [ ] **Step 1: Write the failing test**

`test/unit/sensors.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sensors } from '../../src/plugins/sensors/index.js';
import { gpsProblem, tellGps } from '../../src/ui/live-help.js';

/** Enough of a browser for the sensors. @param {{ visible?: boolean, online?: boolean, geolocation?: boolean }} [o] */
function fakeBrowser({ visible = true, online = true, geolocation = true } = {}) {
  /** @param {Map<string, Function[]>} map */
  const target = (map) => ({
    addEventListener: (/** @type {string} */ t, /** @type {Function} */ fn) => { map.set(t, [...(map.get(t) ?? []), fn]); },
    removeEventListener: (/** @type {string} */ t, /** @type {Function} */ fn) => { map.set(t, (map.get(t) ?? []).filter((f) => f !== fn)); },
  });
  const docs = new Map();
  const wins = new Map();
  const doc = { visibilityState: visible ? 'visible' : 'hidden', ...target(docs) };
  const nav = { onLine: online };
  /** @type {Map<number, { ok: Function, err: Function, opts: any }>} */
  const watches = new Map();
  let next = 1;
  const geo = {
    watchPosition: (/** @type {Function} */ ok, /** @type {Function} */ err, /** @type {any} */ opts) => { watches.set(next, { ok, err, opts }); return next++; },
    clearWatch: (/** @type {number} */ id) => { watches.delete(id); },
  };
  /** @param {Map<string, Function[]>} map @param {string} type @param {any} [e] */
  const fire = (map, type, e = {}) => { for (const fn of map.get(type) ?? []) fn(e); };
  return {
    env: /** @type {any} */ ({ geolocation: geolocation ? geo : undefined, document: doc, window: target(wins), navigator: nav }),
    doc, nav, watches, docs, wins,
    docEvent: (/** @type {string} */ t, /** @type {any} */ e) => fire(docs, t, e),
    winEvent: (/** @type {string} */ t, /** @type {any} */ e) => fire(wins, t, e),
  };
}
/** @param {ReturnType<typeof fakeBrowser>} b */
const byKind = (b) => Object.fromEntries(sensors(b.env).map((s) => [s.kind, s]));

test('location: watched with high accuracy while started; positions, refusals and lost signals come in; stopping clears it (spec §11.2)', () => {
  const b = fakeBrowser();
  /** @type {any[]} */
  const got = [];
  const stop = byKind(b).location.start((/** @type {any} */ x) => got.push(x));
  assert.equal(b.watches.size, 1);
  const w = [...b.watches.values()][0];
  assert.deepEqual(w.opts, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  w.ok({ coords: { latitude: 36.37, longitude: -121.9, accuracy: 12, speed: 14.5, heading: 170 } });
  w.ok({ coords: { latitude: 36.37, longitude: -121.9, accuracy: 12, speed: null, heading: NaN } });
  w.err({ code: 1, message: 'User denied Geolocation' });
  w.err({ code: 2, message: 'Position unavailable' });
  w.err({ code: 3, message: 'Timeout expired' });
  assert.deepEqual(got, [
    { lat: 36.37, lng: -121.9, accuracy: 12, speed: 14.5, heading: 170 },
    { lat: 36.37, lng: -121.9, accuracy: 12, speed: null, heading: null },
    { error: 'denied', message: 'User denied Geolocation' },
    { error: 'unavailable', message: 'Position unavailable' },
    { error: 'unavailable', message: 'Timeout expired' },
  ]);
  stop?.();
  assert.equal(b.watches.size, 0);
  /** @type {any[]} */
  const none = [];
  byKind(fakeBrowser({ geolocation: false })).location.start((/** @type {any} */ x) => none.push(x));
  assert.deepEqual(none, [{ error: 'unavailable', message: "This browser can't tell where it is." }]);
});

test('visibility: what it is at the start, then each change; the back-forward cache is off screen and on again', () => {
  const b = fakeBrowser();
  /** @type {boolean[]} */
  const got = [];
  const stop = byKind(b).visibility.start((/** @type {boolean} */ v) => got.push(v));
  b.doc.visibilityState = 'hidden';
  b.docEvent('visibilitychange');
  b.doc.visibilityState = 'visible';
  b.docEvent('visibilitychange');
  b.winEvent('pagehide', { persisted: true });
  b.winEvent('pageshow', { persisted: true });
  assert.deepEqual(got, [true, false, true, false, true]);
  stop?.();
  b.docEvent('visibilitychange');
  assert.equal(got.length, 5);
});

test('connectivity: as it is at the start, then offline and online', () => {
  const b = fakeBrowser({ online: false });
  /** @type {boolean[]} */
  const got = [];
  const stop = byKind(b).connectivity.start((/** @type {boolean} */ v) => got.push(v));
  b.nav.onLine = true;
  b.winEvent('online');
  b.nav.onLine = false;
  b.winEvent('offline');
  assert.deepEqual(got, [false, true, false]);
  stop?.();
  b.winEvent('online');
  assert.equal(got.length, 3);
});

test('a refused location gets one card, with steps for this phone (spec §17 rule 3)', () => {
  assert.equal(gpsProblem('ios').title, "annai can't see where you are");
  assert.match(gpsProblem('ios').body, /Settings → Privacy & Security → Location Services/);
  assert.match(gpsProblem('android').body, /allow Location/);
  assert.match(gpsProblem('desktop').body, /site settings/);
  assert.match(gpsProblem('ios').body, /Live → Where are you/);
  /** @type {Set<() => void>} */
  const fns = new Set();
  const live = { on: true, gps: 'waiting', onChange: (/** @type {() => void} */ fn) => { fns.add(fn); return () => fns.delete(fn); } };
  /** @type {any[]} */
  const cards = [];
  tellGps({ live, notices: { card: (/** @type {any} */ c) => cards.push(c) }, where: 'android' });
  const tick = () => { for (const fn of fns) fn(); };
  live.gps = 'denied';
  tick();
  tick();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].tone, 'warn');
  live.gps = 'ok';
  tick();
  live.gps = 'denied';
  tick();
  assert.equal(cards.length, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/sensors.test.js`
Expected: FAIL with `Cannot find module '…/src/plugins/sensors/index.js'`.

- [ ] **Step 3: Write the implementation**

`src/plugins/sensors/index.js`:

```js
import { VERSION } from '../../app/version.js';

export const manifest = {
  id: 'sensors',
  name: 'Sensors',
  version: VERSION,
  api: 1,
  description: 'Where the phone is (GPS, only while live mode is on and annai is on screen), whether annai is on screen, and whether there is a connection.',
};

/** A number the phone gave, or null. @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The phone's sensors for live mode (spec §11.2), as registry items the live engine starts and
 * stops: location (watchPosition), visibility and connectivity. They only report: nothing here
 * sends a position anywhere (§11.7).
 * @param {{ geolocation?: Geolocation, document?: Document, window?: Window, navigator?: Navigator }} env
 */
export function sensors({ geolocation, document: doc, window: win, navigator: nav }) {
  return [
    {
      kind: /** @type {const} */ ('location'),
      /** @param {(x: any) => void} emit */
      start(emit) {
        if (!geolocation?.watchPosition) {
          emit({ error: 'unavailable', message: "This browser can't tell where it is." });
          return () => {};
        }
        const id = geolocation.watchPosition(
          (p) => emit({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: num(p.coords.accuracy) ?? 50, speed: num(p.coords.speed), heading: num(p.coords.heading) }),
          // A refusal is the user's; anything else (no signal, a timeout) passes, and the watch goes on.
          (e) => emit({ error: e.code === 1 ? 'denied' : 'unavailable', message: String(e.message ?? '') }),
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 30_000 },
        );
        return () => geolocation.clearWatch(id);
      },
    },
    {
      kind: /** @type {const} */ ('visibility'),
      /** @param {(x: boolean) => void} emit */
      start(emit) {
        const now = () => emit(doc?.visibilityState !== 'hidden');
        const gone = () => emit(false);
        doc?.addEventListener('visibilitychange', now);
        // The back-forward cache freezes a page without a visibilitychange on some browsers.
        win?.addEventListener('pagehide', gone);
        win?.addEventListener('pageshow', now);
        now();
        return () => {
          doc?.removeEventListener('visibilitychange', now);
          win?.removeEventListener('pagehide', gone);
          win?.removeEventListener('pageshow', now);
        };
      },
    },
    {
      kind: /** @type {const} */ ('connectivity'),
      /** @param {(x: boolean) => void} emit */
      start(emit) {
        const now = () => emit(nav?.onLine !== false);
        win?.addEventListener('online', now);
        win?.addEventListener('offline', now);
        now();
        return () => {
          win?.removeEventListener('online', now);
          win?.removeEventListener('offline', now);
        };
      },
    },
  ];
}

/** @param {any} annai */
export function activate(annai) {
  const offs = sensors({ geolocation: navigator.geolocation, document, window, navigator }).map((s) => annai.register('sensor', s));
  return () => offs.forEach((off) => off());
}
```

`src/ui/live-help.js`:

```js
import { platform } from './platform.js';

/**
 * A refused location, in plain words, with steps for this phone (spec §17 rule 3). Live mode keeps
 * its time reminders, and the user can say where they are (§17 rule 2: "a manual place").
 * @param {'ios' | 'android' | 'desktop'} where @returns {{ title: string, body: string }}
 */
export function gpsProblem(where) {
  const steps = where === 'ios'
    ? 'On iPhone: open Settings → Privacy & Security → Location Services, turn it on, and set Safari Websites (or annai, once it is on your Home Screen) to While Using the App.'
    : where === 'android'
      ? 'On Android: tap the icon left of the address (in the installed app: hold the annai icon, then App info → Permissions) and allow Location.'
      : "Allow location for this site in your browser's site settings.";
  return {
    title: "annai can't see where you are",
    body: `Location isn't allowed, so live mode has only its time reminders. ${steps} Then turn live mode off and on again. Or tell annai where you are: Live → Where are you?`,
  };
}

/**
 * Shows that card once when live mode's GPS is refused; again only if it worked in between.
 * @param {{ live: { on: boolean, gps: string, onChange: (fn: () => void) => () => void }, notices: { card: (c: any) => unknown }, where?: 'ios' | 'android' | 'desktop' }} c
 */
export function tellGps({ live, notices, where = platform() }) {
  let told = false;
  return live.onChange(() => {
    if (live.on && live.gps === 'denied') {
      if (!told) notices.card({ tone: 'warn', ...gpsProblem(where) });
      told = true;
    } else if (live.gps === 'ok') told = false;
  });
}
```

In `src/app/main.js`:
1. After `await plugins.addBuiltin(new URL('../plugins/voice-browser/index.js', import.meta.url).href);`, add `await plugins.addBuiltin(new URL('../plugins/sensors/index.js', import.meta.url).href);`.
2. Import `import { tellGps } from '../ui/live-help.js';`; after `agent.on('notice', (n) => shell.notices.card(n));`, add `tellGps({ live, notices: shell.notices });`.

In `sw.js` `SHELL`, add `'/src/plugins/sensors/index.js'` and `'/src/ui/live-help.js'` in alphabetical order with their neighbours.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/sensors.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/plugins/sensors/index.js src/ui/live-help.js src/app/main.js test/unit/sensors.test.js sw.js && git commit -m "The phone's sensors for live mode: GPS only while it is on and annai is on screen, visibility and connectivity; a refused location says what to do on this phone (spec §11.2, §17)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 3: The live chip: the switch, the screen kept on, "Where are you?"

**Files:**
- Create: `src/ui/wake-lock.js`, `src/ui/live-chip.js`
- Modify: `src/ui/dock.js` (the chip; `setLarge`), `src/ui/shiori.css`, `src/app/main.js` (`keepAwake`), `src/ui/shell.js` (the core's type), `sw.js` (`SHELL`)
- Test: `test/unit/wake-lock.test.js`

**Interfaces:**
- Consumes: 5a's `Live` (`on`, `shown`, `activity`, `fix`, `gps`, `setLive`, `place`, `onChange`); `readAppSettings`, `updateAppSettings`; `PLAN_FILE`.
- Produces:
  - `wake-lock.js`: `situation(activity): 'still' | 'walking' | 'moving-fast' | 'unknown'`; `keepAwake({ live, ws, lock? })` → `{ ready, available, held, chosen, choose(on), onChange(fn) }`. Choices are kept in the app settings as `live.awake: { [situation]: boolean }`.
  - `live-chip.js`: `liveText(live)`: "Live off", "Live · finding you", "Live · no GPS", "Live · no location", "Live · moving fast", "Live · walking", "Live · stopped", "Live on"; `whileText(activity)`: "while driving or riding", "while walking", "while stopped", "in live mode"; `liveChip(ctx)` → `{ el }`: the chip and its menu (role group, label "Live mode").
  - The dock shows the live chip in its chip row, and gains `setLarge(on)` (the Driving screen's big dock).
  - `ctx.awake`: the app's `keepAwake`.

- [ ] **Step 1: Write the failing test**

`test/unit/wake-lock.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepAwake, situation } from '../../src/ui/wake-lock.js';
import { liveText, whileText } from '../../src/ui/live-chip.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { readAppSettings } from '../../src/core/settings.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
/** Live mode as the wake lock sees it. @param {Record<string, any>} o */
function fakeLive(o) {
  /** @type {Set<() => void>} */
  const fns = new Set();
  return {
    on: true, shown: true, activity: 'unknown', ...o,
    onChange: (/** @type {() => void} */ fn) => { fns.add(fn); return () => fns.delete(fn); },
    /** @param {Record<string, any>} c */
    set(c) {
      Object.assign(this, c);
      for (const fn of fns) fn();
    },
  };
}
/** A screen wake lock that counts, and can be let go as the browser does off screen. */
function fakeLock() {
  /** @type {any} */
  let current = null;
  const lock = {
    requests: 0, released: 0,
    async request(/** @type {string} */ type) {
      assert.equal(type, 'screen');
      lock.requests++;
      /** @type {Set<() => void>} */
      const fns = new Set();
      current = {
        addEventListener: (/** @type {string} */ _t, /** @type {() => void} */ fn) => fns.add(fn),
        release: async () => { lock.released++; for (const fn of fns) fn(); },
        browserRelease: () => { for (const fn of fns) fn(); },
      };
      return current;
    },
    browserRelease: () => current?.browserRelease(),
  };
  return lock;
}

test('the screen is kept on per situation: chosen for driving, not for walking; let go off screen and asked for again (spec §11.1)', async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const live = fakeLive({ activity: 'moving-fast' });
  const lock = fakeLock();
  const a = keepAwake({ live, ws, lock });
  await a.ready;
  assert.equal(a.available, true);
  assert.equal(lock.requests, 0); // nothing until it is chosen
  assert.equal(a.chosen, false);
  await a.choose(true);
  assert.equal(a.held, true);
  assert.equal(lock.requests, 1);
  assert.deepEqual((await readAppSettings(ws)).live.awake, { 'moving-fast': true });
  live.set({ activity: 'walking' });
  await tick();
  assert.equal(a.held, false);
  assert.equal(lock.released, 1);
  live.set({ activity: 'moving-fast' });
  await tick();
  assert.equal(a.held, true);
  live.set({ shown: false });
  lock.browserRelease();
  await tick();
  assert.equal(a.held, false);
  live.set({ shown: true });
  await tick();
  assert.equal(a.held, true);
  assert.equal(lock.requests, 3);
  live.set({ on: false });
  await tick();
  assert.equal(a.held, false);
  const again = keepAwake({ live: fakeLive({ activity: 'moving-fast' }), ws, lock: fakeLock() });
  await again.ready;
  assert.equal(again.held, true); // a later start remembers the choice
  const none = keepAwake({ live: fakeLive({ activity: 'moving-fast' }), ws, lock: null });
  await none.ready;
  assert.equal(none.available, false);
  assert.equal(none.held, false);
  assert.equal(situation('moving-fast'), 'moving-fast');
  assert.equal(situation('anything'), 'unknown');
});

test('the live chip says how things stand, in a few words', () => {
  assert.equal(liveText({ on: false, gps: 'off', activity: 'unknown', fix: null }), 'Live off');
  assert.equal(liveText({ on: true, gps: 'waiting', activity: 'unknown', fix: null }), 'Live · finding you');
  assert.equal(liveText({ on: true, gps: 'unavailable', activity: 'unknown', fix: null }), 'Live · no GPS');
  assert.equal(liveText({ on: true, gps: 'denied', activity: 'unknown', fix: null }), 'Live · no location');
  assert.equal(liveText({ on: true, gps: 'denied', activity: 'unknown', fix: { lat: 1, lng: 2 } }), 'Live on'); // a place the user set
  assert.equal(liveText({ on: true, gps: 'ok', activity: 'moving-fast', fix: { lat: 1, lng: 2 } }), 'Live · moving fast');
  assert.equal(liveText({ on: true, gps: 'ok', activity: 'still', fix: { lat: 1, lng: 2 } }), 'Live · stopped');
  assert.equal(whileText('moving-fast'), 'while driving or riding');
  assert.equal(whileText('walking'), 'while walking');
  assert.equal(whileText('still'), 'while stopped');
  assert.equal(whileText('unknown'), 'in live mode');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/wake-lock.test.js`
Expected: FAIL with `Cannot find module '…/src/ui/wake-lock.js'`.

- [ ] **Step 3: Write the implementation**

`src/ui/wake-lock.js`:

```js
import { readAppSettings, updateAppSettings } from '../core/settings.js';

/** The situations the screen choice is kept for (spec §11.1: "per situation"). @param {string} activity */
export const situation = (activity) => (activity === 'moving-fast' || activity === 'walking' || activity === 'still' ? activity : 'unknown');

/**
 * The screen kept on in live mode (spec §11.1: "the user's choice per situation (on the car charger,
 * yes; walking, probably not)"): one choice for each activity, kept in the app settings. The lock is
 * held while live mode is on, annai is on screen, and the choice for the activity now says so; the
 * browser lets it go off screen, and it is asked for again on coming back.
 * @param {{ live: { on: boolean, shown: boolean, activity: string, onChange: (fn: () => void) => unknown },
 *   ws: import('../core/workspace.js').Workspace, lock?: { request: (type: 'screen') => Promise<any> } | null }} c
 */
export function keepAwake({ live, ws, lock = /** @type {any} */ (globalThis.navigator)?.wakeLock ?? null }) {
  /** @type {Record<string, boolean>} */
  let choices = {};
  /** @type {any} */
  let held = null;
  let asking = false;
  /** @type {Set<() => void>} */
  const changes = new Set();
  const tell = () => {
    for (const fn of changes) {
      try {
        fn();
      } catch (e) {
        console.warn('a wake lock listener failed', e);
      }
    }
  };
  const want = () => Boolean(live.on && live.shown && choices[situation(live.activity)]);
  const apply = async () => {
    if (want() && !held && lock && !asking) {
      asking = true;
      try {
        const sentinel = await lock.request('screen');
        held = sentinel;
        sentinel?.addEventListener?.('release', () => {
          if (held !== sentinel) return;
          held = null;
          tell();
        });
      } catch {
        held = null; // refused (low battery, say): the screen goes off as usual
      } finally {
        asking = false;
      }
      if (held && !want()) await apply();
    } else if (!want() && held) {
      const sentinel = held;
      held = null;
      await Promise.resolve(sentinel.release?.()).catch(() => {});
    }
    tell();
  };
  const ready = readAppSettings(ws).then((s) => { choices = { ...(s.live?.awake ?? {}) }; }, () => {}).then(apply);
  live.onChange(() => { apply().catch(() => {}); });
  return {
    ready,
    available: Boolean(lock),
    get held() {
      return Boolean(held);
    },
    get chosen() {
      return Boolean(choices[situation(live.activity)]);
    },
    /** Keep the screen on (or not) in the situation now. @param {boolean} on */
    async choose(on) {
      const key = situation(live.activity);
      choices = { ...choices, [key]: on };
      await updateAppSettings(ws, { live: { awake: { [key]: on } } });
      await apply();
    },
    /** @param {() => void} fn */
    onChange(fn) {
      changes.add(fn);
      return () => { changes.delete(fn); };
    },
  };
}
```

`src/ui/live-chip.js`:

```js
import { h } from './dom.js';
import { PLAN_FILE } from '../core/plan.js';

const DOING = /** @type {Record<string, string>} */ ({ 'moving-fast': 'moving fast', walking: 'walking', still: 'stopped' });

/** The live chip's words. @param {{ on: boolean, gps: string, activity: string, fix: unknown }} live */
export function liveText(live) {
  if (!live.on) return 'Live off';
  if (!live.fix) return live.gps === 'denied' ? 'Live · no location' : live.gps === 'unavailable' ? 'Live · no GPS' : 'Live · finding you';
  return DOING[live.activity] ? `Live · ${DOING[live.activity]}` : 'Live on';
}

/** "Keep the screen on while driving or riding". @param {string} activity */
export function whileText(activity) {
  return /** @type {Record<string, string>} */ ({ 'moving-fast': 'while driving or riding', walking: 'while walking', still: 'while stopped' })[activity] ?? 'in live mode';
}

/**
 * The live chip (spec §11.1: live mode is a switch), one tap away on every screen next to the voice
 * chip. A tap shows the switch; with live mode on, "Keep the screen on" for this situation; and with
 * no GPS, "Where are you?", the trip's plan places (§17: "a manual place").
 * @param {any} ctx
 */
export function liveChip(ctx) {
  const live = ctx.live;
  const chip = h('button', { class: 'chip live-chip', type: 'button', 'aria-expanded': 'false' });
  const menu = h('div', { class: 'voice-menu live-menu', role: 'group', 'aria-label': 'Live mode', hidden: true });
  const close = () => {
    menu.hidden = true;
    menu.replaceChildren();
    chip.setAttribute('aria-expanded', 'false');
  };
  const open = async () => {
    const items = [h('button', {
      class: 'btn', type: 'button', 'aria-pressed': String(live.on),
      onclick: async () => {
        close();
        await live.setLive(!live.on);
      },
    }, live.on ? 'Turn live mode off' : 'Turn live mode on')];
    const awake = ctx.awake;
    if (live.on && awake?.available) {
      items.push(h('button', {
        class: 'btn', type: 'button', 'aria-pressed': String(awake.chosen),
        onclick: async () => {
          close();
          const on = !awake.chosen;
          await awake.choose(on);
          ctx.notices.toast(on ? `The screen stays on ${whileText(live.activity)}.` : `The screen goes off as usual ${whileText(live.activity)}.`);
        },
      }, `Keep the screen on ${whileText(live.activity)}`));
    }
    if (live.on && (live.gps === 'denied' || live.gps === 'unavailable')) {
      const places = await planPlaces(ctx);
      items.push(h('p', { class: 'sub', text: places.length ? 'Where are you?' : 'Where are you? The plan has no places to choose from yet.' }));
      for (const p of places) {
        items.push(h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            close();
            await live.place(p);
            ctx.notices.toast(`Live mode takes it you are at ${p.name}.`);
          },
        }, p.name));
      }
    }
    menu.replaceChildren(...items);
    menu.hidden = false;
    chip.setAttribute('aria-expanded', 'true');
  };
  chip.addEventListener('click', () => { if (menu.hidden) open(); else close(); });
  menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Escape') return;
    close();
    chip.focus();
  });
  const show = () => {
    chip.textContent = liveText(live);
    chip.classList.toggle('on', live.on);
  };
  live.onChange(show);
  show();
  return { el: h('div', { class: 'voice-chip-wrap' }, chip, menu) };
}

/** The open trip's plan places, for "Where are you?". @param {any} ctx @returns {Promise<{ name: string, lat: number, lng: number }[]>} */
async function planPlaces(ctx) {
  const trip = ctx.agent?.trip;
  if (!trip) return [];
  /** @type {{ name: string, lat: number, lng: number }[]} */
  const out = [];
  for (const f of await ctx.ws.list(trip, '/plan/')) {
    if (!PLAN_FILE.test(f.path)) continue;
    const it = await ctx.ws.readJSON(trip, f.path).catch(() => null);
    const p = it?.place;
    if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
    const name = String(p.name ?? it.title ?? 'A plan place');
    if (!out.some((x) => x.name === name)) out.push({ name, lat: p.lat, lng: p.lng });
  }
  return out.slice(0, 8);
}
```

In `src/ui/dock.js`:
1. Import `import { liveChip } from './live-chip.js';`.
2. After `const chip = ctx.voice ? voiceChip(ctx) : null;`, add `const live = ctx.live ? liveChip(ctx) : null;`.
3. The row becomes `chip || live ? h('div', { class: 'voice-row' }, chip?.el, live?.el, showWords) : null,`.
4. The layout and the return become:

```js
  /** The Driving screen's big dock, voice or not (spec §16.2). */
  let large = false;
  /** @param {{ on: boolean }} m */
  const layout = (m) => {
    el.classList.toggle('voice', m.on || large);
    showWords.hidden = !m.on;
    if (!m.on) caption.hidden = true;
  };
  ctx.voice?.onChange(layout);
  if (ctx.voice) layout(ctx.voice.mode);
  return {
    el, avatar,
    /** @param {boolean} on */
    setLarge(on) {
      large = on;
      layout(ctx.voice?.mode ?? { on: false });
    },
  };
```

In `src/ui/shiori.css`, after the `.voice-menu .btn[aria-pressed='true']` rule:

```css
.live-chip.on { border-color: var(--ai); color: var(--ai); }
.live-menu { flex-direction: column; align-items: stretch; min-width: 260px; max-height: 60vh; overflow-y: auto; }
.live-menu .sub { margin: 4px 6px 0; }
```

In `src/app/main.js`: import `import { keepAwake } from '../ui/wake-lock.js';`; after `agent.sense = () => live.nowInfo();` add `const awake = keepAwake({ live, ws });`, and pass `awake` to `startShell` (`{ store, ws, registry, plugins, llm, agent, voice, live, awake, presets, version: VERSION }`). In `src/ui/shell.js`, the core's type gains `awake?: any`.

In `sw.js` `SHELL`, add `'/src/ui/live-chip.js'` and `'/src/ui/wake-lock.js'` in alphabetical order.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/wake-lock.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/ui/wake-lock.js src/ui/live-chip.js src/ui/dock.js src/ui/shiori.css src/app/main.js src/ui/shell.js test/unit/wake-lock.test.js sw.js && git commit -m "The live chip on the dock: live mode on or off, the screen kept on as chosen for each situation, and \"Where are you?\" without GPS (spec §11.1, §17)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 4: The Now screen

**Files:**
- Create: `src/core/now.js`, `src/ui/trip-rows.js`, `src/ui/screens/now.js`, `test/e2e/now.spec.js`
- Modify: `src/ui/shell.js` (the screen; Now first in the menu), `src/ui/base.css`, `test/e2e/helpers.js` (`startTrip`, `writeRecords`, `writeEvent`), `sw.js` (`SHELL`)
- Test: `test/unit/now.test.js`, `test/e2e/now.spec.js`

**Interfaces:**
- Consumes: `planRows`, `PlanRow`, `distanceText`, `PLAN_FILE`, `BOOKING_FILE` (`src/core/plan.js`); Task 1's `sunChips`; Task 3's `liveText`; 5a's `Live` (`on`, `fix`, `gps`, `activity`, `online`, `near`, `setLive`, `onChange`); `renderCard`; `fileHref`.
- Produces:
  - `core/now.js`: `upcoming(rows, now, limit = 4)`: items not over yet (one without an end lasts 30 min), soonest first, no all-day or untimed ones; `routeStrip(rows, here, now, activity, limit = 3)` → `{ row, name, place, km, minutes }[]` for the next items with places; `sunPlace(here, rows, now)`: where the user is, else the next stop with a place, else null.
  - `ui/trip-rows.js`: `tripRows(ctx, id)` → `{ scope, trip, tz, rows }`.
  - `ui/screens/now.js`: `renderNow(ctx)`; `whereWords(live, locale)`; `latestCard(ctx, scope)` and `eventCard(ctx, e)` (Shiori's card or words, or a reminder) for Driving too.
  - Route `#/now`; the menu's first link "Now".
  - E2E helpers: `startTrip(page, title)` → the trip's id; `writeRecords(page, trip, { write?, text?, patch?, author? })`; `writeEvent(page, scope, { type, data })`.

- [ ] **Step 1: Write the failing tests**

`test/unit/now.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRows } from '../../src/core/plan.js';
import { upcoming, routeStrip, sunPlace } from '../../src/core/now.js';
import { at, iso, LA, BIXBY, NEPENTHE, RIVER_INN } from './live-kit.js';

const ROWS = planRows([
  { path: '/plan/bixby.json', item: { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, end: { at: iso('10:05'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } } },
  { path: '/plan/coffee.json', item: { id: 'coffee', title: 'Coffee', fixed: false, start: { at: iso('11:00'), tz: LA } } },
  { path: '/plan/nepenthe.json', item: { id: 'nepenthe', title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } } },
  { path: '/plan/day.json', item: { id: 'day', title: 'Park day', kind: 'all-day', fixed: false, start: { at: iso('00:00', '2026-11-28'), tz: LA } } },
  { path: '/plan/skate.json', item: { id: 'skate', title: 'Ice skating', fixed: false } },
], [], { fallbackTz: LA, locale: 'en-US' });
/** @param {import('../../src/core/plan.js').PlanRow[]} rows */
const ids = (rows) => rows.map((r) => r.item.id);

test('what is next: items not over yet, soonest first; one without an end lasts half an hour; all-day and untimed items are not "next"', () => {
  assert.deepEqual(ids(upcoming(ROWS, at('09:00'))), ['bixby', 'coffee', 'nepenthe']);
  assert.deepEqual(ids(upcoming(ROWS, at('10:05'))), ['bixby', 'coffee', 'nepenthe']);
  assert.deepEqual(ids(upcoming(ROWS, at('10:06'))), ['coffee', 'nepenthe']);
  assert.deepEqual(ids(upcoming(ROWS, at('11:30'))), ['coffee', 'nepenthe']);
  assert.deepEqual(ids(upcoming(ROWS, at('11:31'))), ['nepenthe']);
  assert.deepEqual(ids(upcoming(ROWS, at('09:00'), 1)), ['bixby']);
  assert.deepEqual(upcoming([], at('09:00')), []);
});

test('the route strip: the next stops with places, how far each is in a straight line, and about how long (spec §16.2, §11.3)', () => {
  const s = routeStrip(ROWS, RIVER_INN, at('09:00'), 'moving-fast');
  assert.deepEqual(s.map((x) => x.name), ['Bixby Creek Bridge', 'Nepenthe']);
  assert.equal(Math.round(/** @type {number} */ (s[1].km) * 10), 70);
  assert.equal(s[1].minutes, 12);
  assert.deepEqual(s[1].place, NEPENTHE);
  assert.deepEqual(routeStrip(ROWS, null, at('09:00'), 'unknown').map((x) => [x.km, x.minutes]), [[null, null], [null, null]]);
});

test('the sun is worked out where the user is, else at the next stop with a place, else nowhere', () => {
  assert.deepEqual(sunPlace(RIVER_INN, ROWS, at('09:00')), RIVER_INN);
  assert.deepEqual(sunPlace(null, ROWS, at('11:00')), NEPENTHE);
  assert.equal(sunPlace(null, ROWS, at('23:00')), null);
});
```

In `test/e2e/helpers.js`, add:

```js
/** Starts a trip from the Trips screen and returns its id. @param {import('@playwright/test').Page} page @param {string} title */
export async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  return decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
}

/**
 * Writes trip records through annai's own modules in the page, with no format check (so a broken
 * file can be written too); patches merge into existing JSON. author: who wrote them (the user's by default).
 * @param {import('@playwright/test').Page} page @param {string} trip
 * @param {{ write?: Record<string, any>, text?: Record<string, string>, patch?: Record<string, any>, author?: string }} c
 */
export async function writeRecords(page, trip, c) {
  await page.evaluate(async ({ trip, c }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const author = c.author ?? 'user';
    for (const [path, value] of Object.entries(c.write ?? {})) await ws.write(trip, path, value, { author });
    for (const [path, value] of Object.entries(c.text ?? {})) await ws.write(trip, path, value, { author, type: 'text/plain' });
    for (const [path, value] of Object.entries(c.patch ?? {})) await ws.patch(trip, path, value, { author });
    store.close();
  }, { trip, c });
}

/** Appends an entry to a scope's log through annai's own modules in the page. @param {import('@playwright/test').Page} page @param {string} scope @param {{ type: string, data: any }} ev */
export async function writeEvent(page, scope, ev) {
  await page.evaluate(async ({ scope, ev }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { logEvent } = await load('/src/core/events.js');
    const store = await createIdbStore();
    await logEvent(store, scope, { type: ev.type, actor: 'system', data: ev.data });
    store.close();
  }, { scope, ev });
}
```

`test/e2e/now.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { openApp, startTrip, writeRecords, writeEvent } from './helpers.js';

/** An ISO time some minutes from now, in UTC. @param {number} min */
const soon = (min) => new Date(Date.now() + min * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');

test('Now: where you are, the sun, what is next and the latest card; live mode from the chip (spec §16.2)', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 36.372, longitude: -121.901, accuracy: 10 }); // by Bixby Bridge
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await writeRecords(page, trip, {
    write: {
      '/plan/bixby.json': { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: soon(30), tz: 'UTC' }, place: { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 } },
      '/plan/lunch.json': { id: 'lunch', title: 'Lunch at Nepenthe', fixed: true, start: { at: soon(150), tz: 'UTC' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } },
    },
  });
  await writeEvent(page, trip, { type: 'reminder', data: { watch: 'plan:lunch:leave', text: 'Leave soon: Lunch at Nepenthe.' } });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Now' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
  await expect(page.locator('.now-place')).toHaveText("Live mode is off, so annai isn't following where you are.");
  const next = page.getByRole('region', { name: 'Next' });
  await expect(next.locator('.plan-row')).toHaveCount(2);
  await expect(next.locator('.plan-row').first()).toContainText('Bixby Bridge photo stop');
  await expect(page.locator('.now .chips')).toContainText(/Sunrise|Golden|Sunset|Dusk/); // worked out at the next stop
  await expect(page.getByRole('region', { name: 'Latest' })).toContainText('Reminder: Leave soon: Lunch at Nepenthe.');
  await page.locator('.live-chip').click();
  await page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Turn live mode on' }).click();
  await expect(page.locator('.now-place')).toHaveText('At Bixby Creek Bridge');
  await expect(page.locator('.live-chip')).toHaveText(/^Live (on|· )/);
  await expect(page.locator('.now .chips')).toContainText(/^Live /);
  await page.locator('.live-chip').click();
  await expect(page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Turn live mode off' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Live mode' })).toBeHidden();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/now.test.js`
Expected: FAIL with `Cannot find module '…/src/core/now.js'`.

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/now.spec.js`
Expected: FAIL in both browsers: there is no "Now" link.

- [ ] **Step 3: Write the implementation**

`src/core/now.js`:

```js
import { meters, travelMinutes, modeFor } from './live/geo.js';

/**
 * What the Now and Driving screens show (spec §16.2), from the Plan screen's rows: what is next,
 * and the stops ahead with how far each is from where the user is.
 * @typedef {import('./plan.js').PlanRow} PlanRow
 * @typedef {{ lat: number, lng: number }} Point
 */

const MIN = 60_000;
/** @param {any} p @returns {p is Point} */
const hasPoint = (p) => Boolean(p) && typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng);
/** When an item is over: its end, or half an hour after its start. @param {PlanRow} r */
function over(r) {
  const start = /** @type {number} */ (r.at);
  const end = Date.parse(r.item.end?.at ?? '');
  return Number.isFinite(end) && end > start ? end : start + 30 * MIN;
}

/** The plan's next items: those not over yet, soonest first; all-day and untimed items aren't "next". @param {PlanRow[]} rows @param {number} now */
export function upcoming(rows, now, limit = 4) {
  return rows.filter((r) => r.at !== null && r.item.kind !== 'all-day' && over(r) >= now)
    .sort((a, b) => /** @type {number} */ (a.at) - /** @type {number} */ (b.at))
    .slice(0, limit);
}

/**
 * The route strip (spec §16.2): the next stops with places, with the straight-line distance from
 * where the user is and about how long it takes, by the rough estimate (§11.3).
 * @param {PlanRow[]} rows @param {Point | null} here @param {number} now @param {string} activity
 * @returns {{ row: PlanRow, name: string, place: Point, km: number | null, minutes: number | null }[]}
 */
export function routeStrip(rows, here, now, activity, limit = 3) {
  return upcoming(rows.filter((r) => hasPoint(r.item.place)), now, limit).map((row) => {
    const p = row.item.place;
    const km = here ? meters(here, p) / 1000 : null;
    return { row, name: String(p.name ?? row.item.title), place: { lat: p.lat, lng: p.lng }, km, minutes: km === null ? null : travelMinutes(km, modeFor(km, activity)) };
  });
}

/** Where the sun chips are worked out (choice 6): where the user is, else the next stop with a place. @param {Point | null} here @param {PlanRow[]} rows @param {number} now */
export function sunPlace(here, rows, now) {
  if (here) return { lat: here.lat, lng: here.lng };
  return routeStrip(rows, null, now, 'unknown', 1)[0]?.place ?? null;
}
```

`src/ui/trip-rows.js`:

```js
import { planRows, PLAN_FILE, BOOKING_FILE } from '../core/plan.js';
import { validZone, deviceZone } from '../core/time.js';

/**
 * A trip's plan as the Plan screen's rows, for Now and Driving: its scope record, trip.json, the zone
 * for a time whose own zone annai doesn't know, and the rows. A file that can't be read is left out.
 * @param {any} ctx @param {string} id
 */
export async function tripRows(ctx, id) {
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  const trip = (await ctx.ws.readJSON(id, '/trip.json').catch(() => null)) ?? {};
  const tz = [trip.timezones?.[0], deviceZone()].find(validZone) ?? 'UTC';
  /** @param {string} prefix @param {RegExp} shape */
  const read = async (prefix, shape) => {
    /** @type {{ path: string, value: any }[]} */
    const out = [];
    for (const f of await ctx.ws.list(id, prefix)) {
      if (!shape.test(f.path)) continue;
      const value = await ctx.ws.readJSON(id, f.path).catch(() => null);
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push({ path: f.path, value });
    }
    return out;
  };
  const items = (await read('/plan/', PLAN_FILE)).map((x) => ({ path: x.path, item: x.value }));
  const bookings = (await read('/bookings/', BOOKING_FILE)).map((x) => ({ path: x.path, booking: x.value }));
  return { scope, trip, tz, rows: planRows(items, bookings, { fallbackTz: tz, locale: navigator.language || 'en-US' }) };
}
```

`src/ui/screens/now.js`:

```js
import { h } from '../dom.js';
import { upcoming, sunPlace } from '../../core/now.js';
import { sunChips } from '../../core/sun.js';
import { distanceText } from '../../core/plan.js';
import { storedTexts } from '../../core/agent/log.js';
import { renderCard } from '../cards.js';
import { liveText } from '../live-chip.js';
import { tripRows } from '../trip-rows.js';
import { fileHref } from '../format.js';

/**
 * Now (spec §16.2), the home screen during a trip: where you are, golden hour and other chips, the
 * next items as a timetable, and the latest card. When live mode says moving fast, it hands over
 * to Driving (choice 4).
 * @param {any} ctx
 */
export async function renderNow(ctx) {
  await ctx.agent?.opening.catch(() => {});
  const id = ctx.agent?.trip;
  if (!id) {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'Now' }),
      h('p', { class: 'empty' }, 'Open a trip to see where you are and what is next. ', h('a', { href: '#/trips' }, 'Go to Trips')));
  }
  const { scope, tz, rows } = await tripRows(ctx, id);
  const live = ctx.live;
  const locale = navigator.language || 'en-US';
  const place = h('p', { class: 'now-place' });
  const chips = h('div', { class: 'chips' });
  const start = h('div', { class: 'acts' });
  const draw = () => {
    const now = Date.now();
    place.textContent = whereWords(live, locale);
    const sunAt = sunPlace(live?.on ? live.fix : null, rows, now);
    const words = [live ? liveText(live) : null, ...(sunAt ? sunChips(now, sunAt.lat, sunAt.lng, tz) : []), live && !live.online ? 'Offline · reminders still work' : null];
    chips.replaceChildren(...words.filter(Boolean).map((t) => h('span', { class: 'chip', text: String(t) })));
    start.replaceChildren(...(live && !live.on ? [h('button', { class: 'btn pri', type: 'button', onclick: () => live.setLive(true) }, 'Turn on live mode')] : []));
  };
  draw();
  let handed = false;
  const off = live?.onChange(() => {
    if (!place.isConnected) {
      off?.();
      return;
    }
    draw();
    if (!handed && live.on && live.activity === 'moving-fast' && location.hash.startsWith('#/now')) {
      handed = true;
      ctx.go('#/drive');
    }
  });
  const next = upcoming(rows, Date.now(), 4);
  const latest = await latestCard(ctx, id);
  return h('div', { class: 'screen now' },
    h('h1', { class: 'title', text: String(scope?.title ?? 'Now') }),
    place, chips, start,
    h('section', { 'aria-label': 'Next' },
      h('h2', { class: 'section', text: 'Next' }),
      next.length ? h('ol', { class: 'timetable' }, ...next.map((r) => nowRow(id, r))) : h('p', { class: 'empty', text: 'Nothing more is planned.' }),
      h('p', {}, h('a', { href: '#/plan' }, 'The whole plan'))),
    latest ? h('section', { 'aria-label': 'Latest' }, h('h2', { class: 'section', text: 'Latest' }), latest) : null,
    h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/drive' }, 'Driving')));
}

/** Where the user is, in words for them (Shiori's are in the now block). @param {any} live @param {string} locale */
export function whereWords(live, locale) {
  if (!live || !live.on) return "Live mode is off, so annai isn't following where you are.";
  const f = live.fix;
  if (!f) return live.gps === 'denied' ? "Location isn't allowed for annai. Tap Live below to say where you are." : 'Finding where you are…';
  const near = live.near(f);
  if (near) return near.m < 100 ? `At ${near.name}` : `Near ${near.name}, ${distanceText(near.m / 1000, locale)}`;
  return `${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}`;
}

/** @param {string} id @param {import('../../core/plan.js').PlanRow} r */
function nowRow(id, r) {
  const it = r.item;
  return h('li', { class: ['plan-row', it.fixed ? 'fixed' : 'flexible'] },
    h('span', { class: 'when', text: r.time }),
    h('span', { class: 'mark', 'aria-hidden': 'true', text: it.fixed ? '●' : '○' }),
    h('a', { class: 'what', href: fileHref(id, r.path) },
      h('span', { class: 'visually-hidden', text: it.fixed ? 'Fixed: ' : 'Flexible: ' }),
      h('span', { class: 'name', text: String(it.title ?? r.path) }),
      it.place?.name ? h('span', { class: 'sub', text: String(it.place.name) }) : null));
}

/** The conversation's latest card: Shiori's card or words, or a reminder annai showed. @param {any} ctx @param {string} scope */
export async function latestCard(ctx, scope) {
  const [e] = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['out.show', 'out.speak', 'reminder'], reverse: true, limit: 1 }));
  return e ? eventCard(ctx, e) : null;
}

/** One of those, drawn: model output as text or through the card renderer, never innerHTML. @param {any} ctx @param {any} e */
export async function eventCard(ctx, e) {
  const d = e.data ?? {};
  const who = () => h('span', { class: 'who', text: 'SHIORI' });
  if (e.type === 'out.show') return h('div', { class: 'shiori-card' }, who(), renderCard(d.card ?? {}, { ctx, onChoice: (o) => ctx.agent.send(o) }));
  if (e.type === 'reminder') return h('p', { class: 'system-line', text: `Reminder${d.aloud ? ', said aloud' : ''}: ${String(d.text ?? '')}` });
  const text = String({ ...d, ...(await storedTexts(ctx.store, e)) }.text ?? '');
  if (!d.voice) return h('div', { class: 'shiori-card' }, who(), h('p', { text }));
  // Said aloud: hidden unless asked (spec §2 principle 4).
  const words = h('p', { text, hidden: true });
  const show = h('button', { class: 'btn ghost', type: 'button', onclick: () => { words.hidden = false; show.remove(); } }, 'Show what she said');
  return h('div', { class: 'shiori-card' }, who(), h('span', { class: 'sub', text: 'Said aloud' }), show, words);
}
```

In `src/ui/shell.js`:
1. Import `import { renderNow } from './screens/now.js';` and add `now: renderNow` to `SCREENS`.
2. The menu's links become `[['#/now', 'Now'], ['#/trips', 'Trips'], ['#/plan', 'Plan'], ['#/talk', 'Conversation'], ['#/trace', 'Trace'], ['#/settings', 'Settings']]`.
3. The section that is marked current: `const section = route.name === 'plan' ? 'plan' : route.name === 'drive' ? 'now' : route.parts[0] === 'trip' ? 'trips' : route.parts[0];`.

In `src/ui/base.css`, after the `.leg` rule:

```css
/* Now and Driving (spec §16.2) */
.now-place { font-family: var(--f-display); font-weight: 700; font-size: 20px; overflow-wrap: anywhere; }
.shiori-card { display: flex; flex-direction: column; gap: 6px; padding: 10px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--sheet); }
.shiori-card p { margin: 0; white-space: pre-line; overflow-wrap: anywhere; }
```

In `sw.js` `SHELL`, add `'/src/core/now.js'`, `'/src/ui/screens/now.js'` and `'/src/ui/trip-rows.js'` in alphabetical order.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/now.test.js`
Expected: PASS, 3 tests.

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/now.spec.js`
Expected: PASS in chromium and webkit. Delete any `core*` file.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/now.js src/ui/trip-rows.js src/ui/screens/now.js src/ui/shell.js src/ui/base.css test/unit/now.test.js test/e2e/now.spec.js test/e2e/helpers.js sw.js && git commit -m "The Now screen: where you are, the sun's chips, what is next in the plan, and the latest card (spec §16.2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 5: The Driving screen

**Files:**
- Create: `src/ui/screens/drive.js`, `test/e2e/drive.spec.js`
- Modify: `src/ui/shell.js` (the screen), `src/ui/base.css`, `sw.js` (`SHELL`)
- Test: `test/e2e/drive.spec.js`

**Interfaces:**
- Consumes: Task 4's `routeStrip`, `tripRows`, `latestCard`, `eventCard`; Task 3's `whileText`, `ctx.awake`, `ctx.dock.setLarge`; `loadLinks`, `mapsLinks` (`src/core/links.js`); `distanceText`.
- Produces: `renderDrive(ctx)`, route `#/drive`. The quick-ask buttons send Shiori these words: "What is around us right now that is worth knowing about?", "Where can we eat along the way?", "Where is the next fuel station or charger?", "Where is the nearest restroom?", and "How long until we reach <next stop>?".

- [ ] **Step 1: Write the failing test**

`test/e2e/drive.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply, startTrip, writeRecords } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

test('Driving: Now hands over when moving fast; the road ahead, directions, big quick-ask buttons, the big dock, and voice Auto on (spec §16.2, §10.5)', async ({ page, context }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 36.60, longitude: -121.89, accuracy: 10 });
    await page.clock.install({ time: new Date() });
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/trips');
    const trip = await startTrip(page, 'Big Sur');
    const lunch = new Date(Date.now() + 2 * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    await writeRecords(page, trip, { write: { '/plan/lunch.json': { id: 'lunch', title: 'Lunch at Nepenthe', fixed: true, start: { at: lunch, tz: 'UTC' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } } } });
    await page.goto('/#/now');
    await page.locator('.live-chip').click();
    await page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Turn live mode on' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1); // she was told live mode is on
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
    for (let i = 1; i <= 10; i++) {
      await context.setGeolocation({ latitude: 36.60 - i * 0.0011, longitude: -121.89, accuracy: 10 }); // 122 m every 5 s: 88 km/h
      await page.clock.fastForward(5000);
    }
    await expect(page.getByRole('heading', { name: 'Driving' })).toBeVisible();
    await expect(page.locator('.voice-chip')).toHaveText('Voice on · moving');
    await expect(page.locator('nav.dock')).toHaveClass(/\bvoice\b/);
    const strip = page.getByRole('list', { name: 'The road ahead' });
    await expect(strip.locator('li').first()).toHaveText('You');
    await expect(strip).toContainText('Nepenthe');
    await expect(strip).toContainText(/≈ \d+ (mi|km) · about \d+ min/);
    await expect(page.getByRole('link', { name: 'Apple Maps' })).toHaveAttribute('href', /^https:\/\/maps\.apple\.com\/\?daddr=36\.2213,-121\.7567/);
    await expect(page.getByRole('link', { name: 'Google Maps' })).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/dir\//);
    await page.getByRole('button', { name: 'Fuel' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('Where is the next fuel station or charger?');
    await page.getByRole('link', { name: '← Now' }).click();
    await expect(page.locator('nav.dock')).toHaveClass(/\bvoice\b/); // voice is still on: the dock stays big for it
  } finally {
    await llm.stop();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/drive.spec.js`
Expected: FAIL in both browsers: no "Driving" heading (the route opens Trips).

- [ ] **Step 3: Write the implementation**

`src/ui/screens/drive.js`:

```js
import { h } from '../dom.js';
import { routeStrip } from '../../core/now.js';
import { distanceText } from '../../core/plan.js';
import { loadLinks, mapsLinks } from '../../core/links.js';
import { tripRows } from '../trip-rows.js';
import { whileText } from '../live-chip.js';
import { latestCard, eventCard } from './now.js';

/** Big quick-ask buttons (spec §16.2): what each says to Shiori. */
const QUICK = /** @type {const} */ ([
  ["What's around here?", 'What is around us right now that is worth knowing about?'],
  ['Food', 'Where can we eat along the way?'],
  ['Fuel', 'Where is the next fuel station or charger?'],
  ['Restroom', 'Where is the nearest restroom?'],
]);

/**
 * Driving (spec §16.2): the route strip, a maps card, big quick-ask buttons, and the big dock
 * ("voice layouts, such as driving, enlarge the dock"). Shiori's latest words or card show here, so
 * nothing needs the Conversation while driving.
 * @param {any} ctx
 */
export async function renderDrive(ctx) {
  await ctx.agent?.opening.catch(() => {});
  const id = ctx.agent?.trip;
  if (!id) {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'Driving' }),
      h('p', { class: 'empty' }, 'Open a trip to see the road ahead. ', h('a', { href: '#/trips' }, 'Go to Trips')));
  }
  const { rows } = await tripRows(ctx, id);
  const live = ctx.live;
  const locale = navigator.language || 'en-US';
  const links = await loadLinks({ ws: ctx.ws }).catch(() => null);
  const strip = h('ol', { class: 'route-strip', 'aria-label': 'The road ahead' });
  const maps = h('div', { class: 'maps-card' });
  const ask = h('div', { class: 'quick-ask' });
  const awake = h('div', { class: 'acts' });
  const latest = h('div', { class: 'drive-latest', 'aria-live': 'polite' });
  const draw = () => {
    const here = live?.on && live.fix ? live.fix : null;
    const stops = routeStrip(rows, here, Date.now(), live?.activity ?? 'unknown');
    strip.replaceChildren(
      h('li', { class: 'you' }, here ? 'You' : live?.on ? 'You (finding where)' : 'You (live mode is off)'),
      ...stops.map((s) => h('li', {},
        h('span', { class: 'name', text: s.name }),
        h('span', { class: 'sub', text: [s.row.time ? `at ${s.row.time}` : '', s.km !== null ? `${distanceText(s.km, locale)} · about ${s.minutes} min` : ''].filter(Boolean).join(' · ') }))),
      stops.length ? null : h('li', { class: 'empty', text: 'Nothing more is planned with a place.' }));
    const next = stops[0];
    maps.replaceChildren(...(!next ? [] : links ? [
      h('strong', { class: 'card-title', text: `Directions to ${next.name}` }),
      h('div', { class: 'acts' }, ...mapsLinks(links, { destination: `${next.place.lat},${next.place.lng}`, ...(here ? { origin: `${here.lat},${here.lng}` } : {}), mode: 'drive' })
        .map((l) => h('a', { class: 'btn', href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.label }))),
    ] : [h('p', { class: 'sub', text: "annai hasn't downloaded its maps links yet; it needs to be online once." })]));
    const quick = [...QUICK, ['How long?', next ? `How long until we reach ${next.name}?` : 'How long until our next stop?']];
    ask.replaceChildren(...quick.map(([label, text]) => h('button', {
      class: 'btn big', type: 'button',
      onclick: () => {
        ctx.agent.send(text);
        ctx.notices.toast(`Asked Shiori: ${text}`);
      },
    }, label)));
    const a = ctx.awake;
    awake.replaceChildren(...(live?.on && a?.available
      ? [h('button', { class: 'btn', type: 'button', 'aria-pressed': String(a.chosen), onclick: async () => { await a.choose(!a.chosen); draw(); } }, `Keep the screen on ${whileText(live.activity)}`)]
      : live && !live.on ? [h('button', { class: 'btn pri', type: 'button', onclick: () => live.setLive(true) }, 'Turn on live mode')] : []));
  };
  draw();
  const first = await latestCard(ctx, id);
  if (first) latest.replaceChildren(first);
  const offLive = live?.onChange(() => {
    if (!strip.isConnected) {
      offLive?.();
      return;
    }
    draw();
  });
  const offEvents = ctx.agent.on('event', async (/** @type {any} */ e) => {
    if (!strip.isConnected) {
      offEvents();
      return;
    }
    if (e.scope === id && ['out.show', 'out.speak', 'reminder'].includes(e.type)) latest.replaceChildren(await eventCard(ctx, e));
  });
  // The big dock while Driving is on screen.
  ctx.dock?.setLarge(true);
  const leave = () => {
    if (location.hash.startsWith('#/drive')) return;
    ctx.dock?.setLarge(false);
    removeEventListener('hashchange', leave);
  };
  addEventListener('hashchange', leave);
  return h('div', { class: 'screen drive' },
    h('h1', { class: 'title', text: 'Driving' }),
    strip, maps, ask, latest, awake,
    h('p', {}, h('a', { href: '#/now' }, '← Now')));
}
```

In `src/ui/shell.js`, import `import { renderDrive } from './screens/drive.js';` and add `drive: renderDrive` to `SCREENS`.

In `src/ui/base.css`, after the Now rules:

```css
.route-strip { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 3px solid var(--ai); display: flex; flex-direction: column; gap: 10px; }
.route-strip li { display: flex; flex-direction: column; }
.route-strip .name { font-family: var(--f-display); font-weight: 700; font-size: 18px; }
.route-strip .you { color: var(--ai); font-weight: 700; }
.maps-card { display: flex; flex-direction: column; gap: 8px; }
.maps-card:empty, .drive-latest:empty { display: none; }
.quick-ask { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.btn.big { min-height: 64px; font-size: 18px; border-radius: 18px; }
```

In `sw.js` `SHELL`, add `'/src/ui/screens/drive.js'`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/drive.spec.js test/e2e/now.spec.js`
Expected: PASS in chromium and webkit. Delete any `core*` file.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/ui/screens/drive.js src/ui/shell.js src/ui/base.css test/e2e/drive.spec.js sw.js && git commit -m "The Driving screen: the road ahead with distances, directions in the maps app, big quick-ask buttons and the big dock; Now hands over to it when moving fast (spec §16.2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 6: The conversation, the Plan and the Trace in live mode

**Files:**
- Modify: `src/core/types.js` (`EventQuery.notTypes`), `src/core/store-memory.js`, `src/core/store-idb.js`, `test/contract/store-contract.js`, `src/core/plan.js` (`beforeShiori`), `src/ui/screens/plan.js` (Undo), `src/ui/screens/trace.js` (the Live kind, summaries), `src/ui/screens/talk.js` (reminders; short wake lines)
- Test: `test/contract/store-contract.js`, `test/unit/plan.test.js`, `test/unit/ui-pure.test.js`

**Interfaces:**
- Consumes: 5a's events (`location`, `trigger.fired`, `state`, `reminder`); `Workspace.history`, `Workspace.restore`.
- Produces:
  - `EventQuery.notTypes?: string[]`: entries of these types are left out (both stores).
  - `beforeShiori(history): string | null`: the version a file had before Shiori's last change, when the last change is hers; else null.
  - The Plan screen: a "Changed by Shiori · Undo" button on each item Shiori changed last; Undo restores the version before.
  - The Trace: kind "Live" (`location`, `trigger.fired`, `state`, `reminder`); "Everything" leaves `location` out, unless "Type contains" asks for it; one-line summaries for these four.
  - The conversation: a reminder is a system line "Reminder, said aloud: …"; a wake's line is cut at 160 characters.

- [ ] **Step 1: Write the failing tests**

In `test/contract/store-contract.js`, in the test `events: listEvents with after, before, limit, reverse and types`, add after the `types` line:

```js
    assert.deepEqual((await q({ notTypes: ['odd'], reverse: true, limit: 2 })).map((e) => e.seq), [6, 4]);
    assert.deepEqual((await q({ notTypes: ['odd', 'even'] })).map((e) => e.seq), []);
```

At the end of `test/unit/plan.test.js` (import `beforeShiori` from `../../src/core/plan.js`):

```js
test("a plan item Shiori changed last can go back to the version before (spec §11.5: every replan can be undone)", () => {
  const w = (/** @type {string} */ actor, /** @type {string | null} */ old, /** @type {string | null} */ next, type = 'file.write') => ({ seq: 1, ts: 1, actor, type, old, new: next });
  assert.equal(beforeShiori([w('user', null, 'a'), w('shiori', 'a', 'b')]), 'a');
  assert.equal(beforeShiori([w('user', null, 'a'), w('shiori', 'a', 'b'), w('user', 'b', 'c')]), null); // the user changed it since
  assert.equal(beforeShiori([w('shiori', null, 'a')]), null); // she added it: nothing to go back to
  assert.equal(beforeShiori([w('user', null, 'a'), w('shiori', 'a', null, 'file.delete')]), null);
  assert.equal(beforeShiori([]), null);
});
```

At the end of `test/unit/ui-pure.test.js`:

```js
test("the trace's one-line summaries of live mode: points, firings, reminders and switches", () => {
  assert.equal(traceSummary({ type: 'location', data: { lat: 36.3715, lng: -121.9017, accuracy: 8, speed: 15 } }), '36.3715, -121.9017 ±8 m · 54 km/h');
  assert.equal(traceSummary({ type: 'location', data: { lat: 36.3715, lng: -121.9017, accuracy: 50, source: 'manual' } }), '36.3715, -121.9017 ±50 m · manual');
  assert.equal(traceSummary({ type: 'trigger.fired', data: { watch: 'plan:hearst:leave', text: 'Plan: time to leave soon for "Hearst Castle tour"', late: 17, offline: true } }),
    'plan:hearst:leave · Plan: time to leave soon for "Hearst Castle tour" · late by 17 min · no connection');
  assert.equal(traceSummary({ type: 'reminder', data: { text: 'Tea time.', aloud: true } }), 'said aloud · Tea time.');
  assert.equal(traceSummary({ type: 'state', data: { live: 'on' } }), 'live mode on');
  assert.equal(traceSummary({ type: 'state', data: { voice: 'on', why: 'moving' } }), 'voice on (moving)');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/store-memory.test.js test/unit/plan.test.js test/unit/ui-pure.test.js`
Expected: FAIL: `notTypes` is ignored (6 and 5 come back); `beforeShiori` is not exported; the summaries are empty strings.

- [ ] **Step 3: Write the implementation**

`src/core/types.js`: the `EventQuery` typedef becomes `@typedef {{ after?: number, before?: number, limit?: number, reverse?: boolean, types?: string[], notTypes?: string[] }} EventQuery`.

`src/core/store-memory.js`, in `listEvents`, after the `types` line: `if (q.notTypes) list = list.filter((e) => !q.notTypes?.includes(e.type));`.

`src/core/store-idb.js`, in `listEvents`'s cursor: `if ((!q.types || q.types.includes(c.value.type)) && (!q.notTypes || !q.notTypes.includes(c.value.type))) out.push(c.value);`.

`src/core/plan.js`, at the end:

```js
/**
 * The version a file had before Shiori's last change, when the last change is hers and there was a
 * version before (spec §11.5: "every replan is a set of patches to the plan files, so it can be
 * undone"). @param {{ actor: string, type: string, old: string | null }[]} history oldest first
 */
export function beforeShiori(history) {
  const last = history.at(-1);
  return last && last.actor === 'shiori' && last.type === 'file.write' && last.old ? last.old : null;
}
```

`src/ui/screens/plan.js`:
1. Import `beforeShiori` from `../../core/plan.js`.
2. `records()` keeps each file's author: `list.push({ path: f.path, value, author: f.author })` (its type gains `author: string`).
3. In `renderPlan`, after `const rows = …`, work out the undos:

```js
  /** @type {Map<string, string>} plan files Shiori changed last, and the version before (choice 9) */
  const undo = new Map();
  for (const x of plan.list) {
    if (x.author !== 'shiori') continue;
    const old = beforeShiori(await ctx.ws.history(id, x.path));
    if (old) undo.set(x.path, old);
  }
```

and `timetable(id, t.rows, links, locale)` becomes `timetable(ctx, id, t.rows, links, locale, undo)`; `timetable` passes `ctx` and `undo` on to `row(ctx, id, r, undo)`.
4. In `row`, the chips become:

```js
    r.check || r.missing || undo.has(r.path) ? h('span', { class: 'chips' },
      r.check && r.bookingPath ? h('a', { class: 'chip check', href: bookingHref(id, r.bookingPath) }, 'Check this') : null,
      r.missing ? h('span', { class: 'chip warn', text: 'Booking missing' }) : null,
      undo.has(r.path) ? h('button', {
        class: 'chip undo', type: 'button',
        onclick: async () => {
          await ctx.ws.restore(id, r.path, /** @type {string} */ (undo.get(r.path)), { author: 'user' });
          ctx.notices.toast(`Undone: ${String(it.title ?? r.path)} is back as it was before Shiori changed it.`);
          ctx.render();
        },
      }, 'Changed by Shiori · Undo') : null) : null,
```

`src/ui/base.css`: `button.chip.undo { min-height: 44px; border: 1px solid var(--line); cursor: pointer; font: inherit; font-size: 13px; }`.

`src/ui/screens/trace.js`:
1. `KINDS` gains, after `Housekeeping`: `Live: ['location', 'trigger.fired', 'state', 'reminder'],`.
2. In `load`, the events are read with a query:

```js
    const f = filter.value.trim();
    const types = KINDS[kind.value];
    // A drive logs a location point about every second: "Everything" leaves them to the Live kind (choice 10).
    const query = types ? { types } : f && 'location'.includes(f) ? {} : { notTypes: ['location'] };
    const all = (await Promise.all(ids.map((/** @type {string} */ id) => ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(id, { reverse: true, limit: 300, ...query }))))).flat();
```

(the later `const f = …` and `const types = …` lines go, as they are now above).
3. In `traceSummary`, before the `decide` branch:

```js
  if (e.type === 'location') return `${d.lat}, ${d.lng} ±${d.accuracy} m${typeof d.speed === 'number' && d.speed > 0 ? ` · ${Math.round(d.speed * 3.6)} km/h` : ''}${d.source ? ` · ${d.source}` : ''}`;
  if (e.type === 'trigger.fired') return `${d.watch} · ${cut(d.text)}${d.late ? ` · late by ${d.late} min` : ''}${d.offline ? ' · no connection' : ''}`;
  if (e.type === 'reminder') return `${d.aloud ? 'said aloud' : 'shown'} · ${cut(d.text)}`;
  if (e.type === 'state') return d.live ? `live mode ${d.live}` : d.voice ? `voice ${d.voice}${d.why ? ` (${d.why})` : ''}` : '';
```

`src/ui/screens/talk.js`:
1. `SHOWN` gains `'reminder'`.
2. In `item`, before the `wake` branch:

```js
    if (e.type === 'reminder') return h('li', { class: 'system-line', text: `Reminder${d.aloud ? ', said aloud' : ''}: ${String(d.text ?? '')}` });
```

3. The wake line cuts long texts (a watch's wake says a lot, for Shiori):

```js
    if (e.type === 'wake') {
      const others = (d.reasons ?? []).filter((/** @type {any} */ r) => r.kind !== 'user' && r.kind !== 'choice');
      const why = others.map((/** @type {any} */ r) => r.text).join('; ');
      return others.length ? h('li', { class: 'system-line', text: `Shiori woke: ${why.length > 160 ? `${why.slice(0, 160)}…` : why}` }) : null;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/store-memory.test.js test/unit/plan.test.js test/unit/ui-pure.test.js`
Expected: PASS. Then the browser suite for the IndexedDB store: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/browser-suites.spec.js test/e2e/trace.spec.js test/e2e/plan.spec.js` passes in both browsers.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/types.js src/core/store-memory.js src/core/store-idb.js test/contract/store-contract.js src/core/plan.js src/ui/screens/plan.js src/ui/screens/trace.js src/ui/screens/talk.js src/ui/base.css test/unit/plan.test.js test/unit/ui-pure.test.js sw.js && git commit -m "Live mode in the conversation, the Plan and the Trace: reminders as system lines, an Undo for each plan item Shiori changed, and a Live view that keeps location points out of the rest (spec §11.5, §15)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 7: Live mode end to end, and the device checklist

**Files:**
- Create: `test/e2e/live.spec.js`, `docs/testing/device-checklist-m5.md`
- Modify: `README.md`
- Test: `test/e2e/live.spec.js`

**Interfaces:**
- Consumes: everything in 5a and 5b; the e2e helpers.
- Produces: the end-to-end proof, in both browsers, of what a real local drive needs; the checklist for the drive itself.

- [ ] **Step 1: Write the test**

`test/e2e/live.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply, startTrip, writeRecords, filterTrace } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const sleep = { name: 'sleep', input: {} };
const BIXBY = { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 };
/** An ISO time some minutes after t, in UTC. @param {number} t @param {number} min */
const plus = (t, min) => new Date(t + min * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');

/** Shiori's main model on a stand-in Anthropic endpoint, and a trip. @param {any} page @param {string} origin */
async function setUp(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await page.goto('/#/trips');
  return startTrip(page, 'Big Sur');
}

/** Turns live mode on from the chip. @param {any} page */
async function liveOn(page) {
  await page.locator('.live-chip').click();
  await page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Turn live mode on' }).click();
}

/** The page as if the phone locked (true) or unlocked (false). @param {any} page @param {boolean} hidden */
async function locked(page, hidden) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('a watch Shiori sets fires on arriving; she is told where you are; the trace shows the road (spec §11.3, §6.3)', async ({ page, context }) => {
  const llm = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'watch_set', input: { when: { type: 'enter', lat: BIXBY.lat, lng: BIXBY.lng, radius: 200, name: 'Bixby Bridge' }, fallback: 'Bixby Bridge, just ahead.' } }, sleep])),
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'Bixby Bridge is on your right.' } }, sleep])),
    ],
  });
  try {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 36.40, longitude: -121.90, accuracy: 10 });
    const trip = await setUp(page, llm.origin);
    await writeRecords(page, trip, { write: { '/plan/bixby.json': { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: plus(Date.now(), 60), tz: 'UTC' }, place: BIXBY } } });
    await page.goto('/#/now');
    await liveOn(page);
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[0])).toContain('The user turned live mode on');
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
    await context.setGeolocation({ latitude: BIXBY.lat, longitude: BIXBY.lng, accuracy: 10 });
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    const second = JSON.stringify(llm.bodies('/b/v1/messages')[1]);
    expect(second).toContain('fired: you entered Bixby Bridge');
    expect(second).toContain('place: near Bixby Creek Bridge');
    await page.goto('/#/talk');
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Bixby Bridge is on your right.');
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Live' });
    await expect(page.locator('ol.trace .k', { hasText: 'trigger.fired' }).first()).toBeVisible();
    await expect(page.locator('ol.trace .k', { hasText: 'location' }).first()).toBeVisible();
    await filterTrace(page, { kind: 'Everything' });
    await expect(page.locator('ol.trace .k', { hasText: /^location$/ })).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test("no model can be reached: annai shows the plan's reminder itself, and the conversation says so (spec §11.3, §17)", async ({ page }) => {
  const refused = { status: 401, type: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) };
  const llm = await startModelServer({ '/b/v1/messages': refused });
  try {
    const start = Date.now();
    await page.clock.install({ time: start });
    const trip = await setUp(page, llm.origin);
    await writeRecords(page, trip, { write: { '/plan/tea.json': { id: 'tea', title: 'Tea at the inn', fixed: true, start: { at: plus(start, 16), tz: 'UTC' } } } });
    await page.clock.fastForward(90_000); // the plan's "coming up" comes 15 minutes before
    await expect(page.locator('.notice', { hasText: 'Reminder' })).toContainText('In 15 min: Tea at the inn at');
    await expect(page.locator('.notice', { hasText: "Shiori can't reach her model" })).toBeVisible();
    await page.goto('/#/talk');
    await expect(page.locator('.convo .system-line', { hasText: 'Reminder' })).toContainText('In 15 min: Tea at the inn at');
  } finally {
    await llm.stop();
  }
});

test('the phone locked and unlocked: one catch-up wake, with the time away and what came due, late (spec §11.4)', async ({ page, context }) => {
  const start = Date.now();
  const llm = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'watch_set', input: { when: { type: 'time', at: plus(start, 10) }, fallback: 'Ten minutes are up.' } }, sleep])),
      sse(anthropicToolReply([sleep])),
    ],
  });
  try {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 36.40, longitude: -121.90, accuracy: 10 });
    await page.clock.install({ time: start });
    await setUp(page, llm.origin);
    await page.goto('/#/now');
    await liveOn(page);
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1);
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
    await locked(page, true);
    await page.clock.fastForward('15:00');
    expect(llm.bodies('/b/v1/messages').length).toBe(1); // nothing while locked
    await locked(page, false);
    await context.setGeolocation({ latitude: 36.41, longitude: -121.90, accuracy: 10 });
    await page.clock.fastForward(16_000); // at most 15 s for a fix
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    const body = JSON.stringify(llm.bodies('/b/v1/messages')[1]);
    expect(body).toMatch(/Catch-up: annai was off screen for 15 min/);
    expect(body).toMatch(/fired: the time came: [^(]+\(late by 5 min: annai was off screen\)/);
  } finally {
    await llm.stop();
  }
});

test('location refused: a card with steps for this phone, and "Where are you?" with the plan\'s places (spec §17)', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await writeRecords(page, trip, { write: { '/plan/bixby.json': { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: plus(Date.now(), 60), tz: 'UTC' }, place: BIXBY } } });
  await page.goto('/#/now');
  await liveOn(page);
  const card = page.locator('.notice', { hasText: "annai can't see where you are" });
  await expect(card).toContainText(/On (iPhone|Android):/);
  await expect(page.locator('.live-chip')).toHaveText('Live · no location');
  await page.locator('.live-chip').click();
  await page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Bixby Creek Bridge' }).click();
  await expect(page.locator('.now-place')).toHaveText('At Bixby Creek Bridge');
});

test('a plan item Shiori changed can be put back with one tap (spec §11.5)', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  const at = plus(Date.parse('2026-11-27T21:45:00Z'), 0);
  await writeRecords(page, trip, { write: { '/plan/mcway.json': { id: 'mcway', title: 'McWay Falls', fixed: false, start: { at, tz: 'UTC' } } } });
  await writeRecords(page, trip, { author: 'shiori', patch: { '/plan/mcway.json': { start: { at: '2026-11-27T22:00:00Z', tz: 'UTC' } } } });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab').first().click();
  await expect(page.locator('.plan-row')).toContainText('22:00');
  await page.getByRole('button', { name: 'Changed by Shiori · Undo' }).click();
  await expect(page.locator('.plan-row')).toContainText('21:45');
  await expect(page.getByRole('button', { name: 'Changed by Shiori · Undo' })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the test**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/live.spec.js`
Expected: PASS in chromium and webkit (it tests Tasks 1–6 together; a failure here is a bug in them, fixed with a test that reproduces it first). Delete any `core*` file.

- [ ] **Step 3: Write the device checklist**

`docs/testing/device-checklist-m5.md`:

```markdown
# Device checklist: milestone 5 (live mode)

The real local drive, on an iPhone and an Android phone, with annai installed to the Home Screen.
Milestone 5's "Done when" is "a real local drive works": this is that drive. Before it, plan a short
trip with three stops in annai (one fixed, two flexible, with places), and have a model set up.
Note what you see in the trip's Trace (kind: Live) after each part.

## Live mode on both phones
- [ ] Open the trip, tap the Live chip on the dock, and turn live mode on. The phone asks for location once; allow it "While Using". The chip says "Live · finding you", then "Live · stopped" (or on).
- [ ] Shiori is woken once ("The user turned live mode on"); she sets an activity watch (Trace → Live: no; Trace → Tools: watch_set).
- [ ] Now shows "At …" or "Near …" a plan stop, the sun chips, what's next and the latest card.
- [ ] Close annai fully and open it again: live mode is still on, and nothing is asked again.

## Refused location
- [ ] On one phone, refuse location (or turn it off in Settings). A card says "annai can't see where you are" with steps for this phone; the steps are right for iOS / Android.
- [ ] Live → Where are you? lists the plan's places; choosing one makes Now say "At …".
- [ ] Allow location again, turn live mode off and on: the GPS works.

## The drive
- [ ] Drive off: within a minute the chip says "Live · moving fast", voice Auto turns on ("Voice on · moving") and Now hands over to Driving.
- [ ] Driving shows You, the next stops with distances and minutes, Directions in Apple or Google Maps, and the quick-ask buttons; each button gets an answer, aloud.
- [ ] Shiori narrates: a moved watch fires every 10–20 km and she says something worth hearing, or nothing.
- [ ] Arriving at a plan stop: after about two minutes stopped, she knows you arrived.
- [ ] A fixed stop's "leave in about 15 min" reminder comes before you need to leave; "running late" comes if you dawdle.
- [ ] Stop somewhere not on the plan for 20 minutes: she welcomes the detour, says what it costs, and moves flexible items; the Plan shows "Changed by Shiori · Undo", and Undo puts an item back.

## The screen kept on
- [ ] On the car charger, Live → Keep the screen on while driving or riding. The screen stays on while driving.
- [ ] Walk somewhere: the screen turns off as usual (the choice is per situation). Drive again: it stays on again.
- [ ] Installed app on iPhone: the wake lock works there too (it didn't before iOS 18.4).

## Locked and unlocked: catch-up
- [ ] With a time watch due in 10 minutes (ask Shiori to remind you of something), lock the phone for 15 minutes while driving, then unlock.
- [ ] One catch-up wake: she hears how long annai was off screen and how far you went, and the reminder came late, labelled. Nothing fires while locked.

## No connection
- [ ] Turn on airplane mode (or drive where there's no signal) with voice on, and let a watch or a plan reminder come due.
- [ ] The reminder's fallback is said aloud by the phone's own voice and shown as a card; the dock says "Offline · reminders still work".
- [ ] When the connection is back, Shiori hears what came while offline, once.

## Battery
- [ ] An hour of live mode with the screen on (on the charger, and once off it): note the battery used, and whether the phone got warm. Compare with an hour of Maps navigation.

## Afterwards
- [ ] Trace → Live: the road is there as location points, about one a second while moving, few while stopped; the firings and reminders match what happened.
- [ ] Export the trip as a Backup and remove it: no location points or watches are left behind (Trips is empty of it).
```

- [ ] **Step 4: Update the README**

In `README.md`'s status, the milestone 5 sentence becomes: "Milestone 5 (live mode) is in progress: watches Shiori sets, the plan's own reminders (leave in time, arrived, running late, off plan), catch-up after the phone was locked, and reminders annai shows and says by itself when no model can be reached, tested by a simulated Big Sur drive; on the phone, the GPS in live mode, the Live chip (the screen kept on as you choose, and where you are without GPS), and the Now and Driving screens. The offline pack is next."

- [ ] **Step 5: Run everything, then commit**

Run: `npm run stamp && npm run check`, then the whole end-to-end suite in Docker (both browsers): `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test`.
Expected: all pass. Delete any `core*` file.

```bash
npm run stamp && npm run check && git add test/e2e/live.spec.js docs/testing/device-checklist-m5.md README.md && git commit -m "Live mode end to end in both browsers (a watch firing on arrival, reminders with no model, catch-up after a lock, a refused location, undoing a replan), and the device checklist for a real local drive

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
