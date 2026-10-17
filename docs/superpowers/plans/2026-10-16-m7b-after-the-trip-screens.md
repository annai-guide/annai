# Milestone 7b: After the Trip, the Screens (Stamps on Trip Cards, Recap, Replay, Simulate a Trip) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The screens on 7a's core (spec §13, §16.2, §16.5), and milestone 7's "Done when" end to end:
- **Trip cards with stamps** (§16.2): station-stamp marks and "5 stamps" on each trip card and on the trip's page.
- **Recap:** the recap rendered safely, "Write the recap" (the utility model), "Hear Shiori tell it", what goes to the model said on the screen.
- **Replay:** the timeline (places, Shiori's cards, photos, the user's words), the route as an SVG polyline on a flat map with no tiles, playback at adjustable speed with a scrubber, a day at a time or the whole trip; all of it readable without seeing the map.
- **Settings → Developer → Simulate a trip:** the Big Sur sample, an itinerary file, or a trip's recorded track, at 10×, 60×, 600× or as fast as it can go; the live chip says a simulation runs and offers pause and stop; Now and Driving follow the simulated time.
- **Done when (§20 row 7):** in Chromium and WebKit, the Big Sur sample is simulated through the app, replayed (timeline, route, stamps, scrubbing, playback) and recapped by a stand-in model into `/trip/recap.md`, and its trip card shows its five stamps. The device checklist covers the real Thanksgiving trip.

**Architecture:**
- `src/core/after/replay.js` (pure, Node-tested): a journey (or one day of it) as the replay draws it, and what was so at any moment.
- `src/ui/stamps.js`: a trip's stamps from its log, and the marks.
- `src/ui/screens/recap.js`, `src/ui/screens/replay.js`, `src/ui/screens/simulate.js`: the three screens; routes `#/trip/<id>/recap`, `#/trip/<id>/replay(?day=YYYY-MM-DD)`, `#/simulate`.
- `src/app/main.js` makes the one `SimRun` the screens and the live chip share (`ctx.sim`).

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies; plain DOM and SVG built with `createElement`/`createElementNS`, never `innerHTML`.
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26); Playwright 1.63.0 in Docker (Chromium as Pixel 7, WebKit as iPhone 15), with stand-in model servers on their own ports (`startModelServer`).

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`: §13, §16.1–§16.3 (screens; station-stamp marks; Recap and Replay; Settings → Developer), §16.5 (accessibility), §11.7, §15 (no `innerHTML`; CSP `'self'`), §18 (e2e, device checklist), §20 row 7. 7a's plan: `docs/superpowers/plans/2026-10-16-m7a-after-the-trip-core.md`.

## Choices this plan makes (please check them)

1. **Stamps on a trip card:** the first two marks and "+N", and "N stamps" in the card's line; the trip's page shows them all, larger. Each mark is round, vermilion, double-ringed and a little crooked, as in the mockup; a screen reader hears "5 stamps: Bixby Creek Bridge, Nepenthe, …".
2. **Recap and Replay are buttons on the trip's page,** next to Plan. The Recap screen shows the recap rendered by annai's own Markdown renderer; "Edit" opens `/recap.md` in the file editor.
3. **"Hear Shiori tell it"** opens the trip as Shiori's conversation first if another one is open (as opening a trip's page does), then wakes her (7a choice 6).
4. **What the Recap screen says is sent:** a short list under "What goes to <model>": places and times of the stays (unnamed ones as positions rounded to about 100 m), moves in km, stamps, the plan, Shiori's cards and your words, notes, trip memory, your profile, and up to 6 photos; never the GPS track itself.
5. **Replay's playback speeds:** 1 minute, 10 minutes (the default) or 1 hour of the trip a second; the scrubber moves by the minute. Day tabs ("Whole trip", then each day) when the trip has more than one day; a day shows only that day's road and entries.
6. **Replay's timeline lists** stays ("09:30–09:50 Bixby Creek Bridge · 20 min · stamp"), moves ("Drove 25.3 km · 30 min"), Shiori's cards ("Shiori: …"), your words ("You: …", "You said: …") and photos ("Photo 2026-11-27-0945.webp"). Her spoken words aren't in it (they are hidden unless asked, §16.1), nor reminders. Tapping an entry moves the playback there.
7. **"At this moment"** shows the time, where you were ("At Nepenthe", "Driving from Bixby Creek Bridge"), the stamps so far, and the latest card, words or photo; a photo loads only when shown, one at a time, and opens full size. While it plays, a screen reader hears each new place, not every tick.
8. **The map:** the drawn route grey, what is behind you vermilion, jumps (the phone locked, a flight) dashed, stays as small rings, stamps as larger vermilion rings, you as a dot. It is an `<svg role="img">` whose name is the route in words ("212.3 km on the road, from Bixby Creek Bridge to Cambria Pines Lodge, with 9 stops and 5 stamps."). No tiles, nothing fetched.
9. **Simulate a trip** is in Settings under a new **Developer** section (§16.2 lists it). The screen says Shiori wakes with your models, about 24 times for the sample, and that a scripted model (Settings → Models) makes it free. With no model set up it still runs, and annai shows the reminders itself.
10. **While a simulation runs,** the live chip reads "Simulation · moving fast" (or stopped, walking), and its menu offers Pause or Resume, Stop, and the Simulate a trip screen, instead of the live mode switch. Now and Driving show the simulated time. When it ends the screen offers Replay it, Recap it and Open the trip.
11. **A reload ends a running simulation:** its trip keeps what it did; live mode is as the user left it.
12. **The size budget** is raised once, in Task 5, to what milestone 7 needs plus a little; the report lists it.

## Global Constraints

- All of 7a's Global Constraints hold.
- **"Recap and Replay" are screens; "Trips: … trip cards with stamps"; "station-stamp marks for visited places"; Settings includes "Developer" (§16.2).**
- **"the route drawn as an SVG polyline from the location points, using a simple equirectangular projection and no map tiles; playback at adjustable speed" (§13).**
- **Accessibility (§16.5): semantic HTML, labelled controls, large targets (44 px), visible focus, the reduced-motion preference respected.** The replay and the route must make sense without seeing the SVG.
- **"Model output never goes into innerHTML. Our own small Markdown renderer builds DOM nodes and escapes everything else" (§15).** No `style` attribute: SVG geometry and stroke attributes only, and CSS in `base.css`. Links only `https:`/`http:` (the card renderer already checks).
- **CSP `'self'`:** nothing is fetched from elsewhere; the sample is `/assets/simulations/big-sur.json`, read through `answerJSON`.
- **System cards are never in Shiori's voice (§16.1); every error says what happened and what to do next.**
- **E2E in Docker only:** `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test …`; never host ports 8765, 8790–8792; delete any `core*` file a WebKit crash leaves.
- **Device-only behavior goes on the checklist** (a finger's `pointerdown` isn't a user activation; Playwright clicks with a mouse).

## Review Focus

1. **A replay with little or a lot in it:** nothing recorded, only messages, one point, a day tab with nothing in it, five days of points: an empty-state line or a working replay, never a thrown error; the screen opens in a couple of seconds on a phone. Pinned in Tasks 3 and 5.
2. **Leaving the replay while it plays, or tapping Play at the end:** the animation stops once the screen is gone; Play at the end starts again from the beginning. Pinned in Task 3.
3. **Hostile model output in a recap or a card** (HTML, `javascript:` links, a 100 KB recap): it stays text, and links are http(s) only. Pinned in Task 2.
4. **A simulation while the user goes elsewhere:** other screens, another trip opened (it stops, 7a), a reload: the chip says what runs; nothing of it reaches the user's own trips. Pinned in Task 4 and 7a Task 7.
5. **A recap that fails** (no model, every model failing, an empty answer): the screen says why in plain words, keeps the old recap, and the button works again. Pinned in Task 2.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/after/stamps.js`, `src/ui/stamps.js`, `src/ui/screens/trips.js`, `src/ui/screens/trip.js`, `src/ui/base.css` | 1 | `stampCount`; `tripStamps`, `stampMarks`; the cards and the trip page |
| `src/core/after/recap.js`, `src/ui/screens/recap.js`, `src/ui/router.js`, `src/ui/shell.js`, `src/ui/screens/trace.js`, `test/e2e/after-recap.spec.js`, `test/e2e/after-kit.js` | 2 | `recapError`; the Recap screen; routes; the trace's kind; seeding a journey in the browser |
| `src/core/after/replay.js`, `src/ui/screens/replay.js`, `test/e2e/after-replay.spec.js` | 3 | `replayOf`, `momentAt`, `entryLine`, `routeWords`, `dayBounds`, `PLAY_SPEEDS`; the Replay screen |
| `src/ui/screens/simulate.js`, `src/ui/screens/settings.js`, `src/ui/live-chip.js`, `src/ui/screens/now.js`, `src/ui/screens/drive.js`, `src/app/main.js`, `test/e2e/after-simulate.spec.js` | 4 | Simulate a trip; Developer; the chip during a simulation; Now and Driving on live mode's clock; `ctx.sim` |
| `test/e2e/after-simulate.spec.js`, `docs/testing/device-checklist-m7.md`, `README.md`, `scripts/size.mjs` | 5 | the "Done when" end to end; the checklist; the README; the budget |

---

### Task 1: Stamps on trip cards and the trip's page

**Files:**
- Modify: `src/core/after/stamps.js` (`stampCount`), `src/ui/screens/trips.js`, `src/ui/screens/trip.js`, `src/ui/base.css`, `sw.js` (`SHELL`)
- Create: `src/ui/stamps.js`
- Test: `test/unit/after-stamps.test.js` (more), `test/e2e/trips.spec.js` (a card with stamps)

**Interfaces:**
- Consumes: 7a's `stampsOf`, `stampLabel`, `Stamp`.
- Produces: `stampCount(n): string` ("1 stamp", "5 stamps") in `src/core/after/stamps.js`; `tripStamps(ctx, id): Promise<Stamp[]>` and `stampMarks(stamps, { max?, big? }): HTMLElement | null` in `src/ui/stamps.js`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/after-stamps.test.js`:
```js
test('stamps in words, and a trip\'s stamps read from its log for its card (spec §13: never stored)', async () => {
  assert.equal(stampCount(1), '1 stamp');
  assert.equal(stampCount(5), '5 stamps');
  const k = await liveKit({ live: false });
  await k.ws.patch(k.trip, '/trip.json', { timezones: [LA] }, { author: 'user' });
  const { logEvent } = await import('../../src/core/events.js');
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { type: 'plan', event: 'arrived', place: place('Nepenthe', NEPENTHE) } }, at('12:00'));
  const { tripStamps } = await import('../../src/ui/stamps.js');
  assert.deepEqual((await tripStamps({ store: k.store, ws: k.ws }, k.trip)).map((s) => s.name), ['Nepenthe']);
});
```
(`stampCount` joins the import from `stamps.js`.)

Add to `test/e2e/trips.spec.js`:
```js
test('a trip card shows the stamps its arrivals earned, and the trip page all of them (spec §13, §16.2)', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Kyoto in spring');
  const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  for (const [name, lat, lng] of /** @type {const} */ ([['伏見稲荷大社', 34.967, 135.773], ['Arashiyama', 35.009, 135.667], ['Kiyomizu-dera', 34.995, 135.785]])) {
    await writeEvent(page, id, { type: 'trigger.fired', data: { type: 'plan', event: 'arrived', place: { name, lat, lng } } });
  }
  await page.goto('/#/trips');
  const card = page.getByRole('link', { name: /Kyoto in spring/ });
  await expect(card).toContainText('3 stamps');
  await expect(card.getByRole('img', { name: '3 stamps: 伏見稲荷大社, Arashiyama, Kiyomizu-dera' })).toBeVisible();
  await expect(card.locator('.stamp')).toHaveText(['伏見', 'Arashiyama', 'Kiyomizu-dera']);
  await card.click();
  await expect(page.getByRole('img', { name: /^3 stamps:/ })).toBeVisible();
});
```
(`writeEvent` joins the import from `./helpers.js`; the three arrivals are logged a moment apart, so they keep their order.)

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/after-stamps.test.js`
Expected: FAIL: `stampCount` is not exported.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/trips.spec.js -g "stamps"`
Expected: FAIL in both browsers: the card doesn't contain "3 stamps".

- [ ] **Step 3: Write the code**

In `src/core/after/stamps.js`:
```js
/** "1 stamp", "5 stamps". @param {number} n */
export const stampCount = (n) => `${n} ${n === 1 ? 'stamp' : 'stamps'}`;
```

`src/ui/stamps.js`:
```js
import { h } from './dom.js';
import { stampsOf, stampLabel, stampCount } from '../core/after/stamps.js';
import { validZone, deviceZone } from '../core/time.js';

/**
 * Station-stamp marks for visited places (spec §13, §16.2): round, vermilion, a little crooked, each
 * with the start of its place's name. A trip card shows the first two and "+N"; the label names them all.
 * @typedef {import('../core/after/stamps.js').Stamp} Stamp
 */

/** A trip's stamps, from its log: worked out each time, never stored (spec §13). @param {{ store: any, ws: any }} ctx @param {string} id @returns {Promise<Stamp[]>} */
export async function tripStamps(ctx, id) {
  const info = await ctx.ws.readJSON(id, '/trip.json').catch(() => null);
  const tz = [info?.timezones?.[0], deviceZone()].find(validZone) ?? 'UTC';
  const fired = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(id, { types: ['trigger.fired'] }));
  return stampsOf(fired, tz);
}

/** @param {Stamp[]} stamps @param {{ max?: number, big?: boolean }} [o] max: how many show before "+N"; big: the trip page's and the replay's */
export function stampMarks(stamps, { max = 2, big = false } = {}) {
  if (!stamps.length) return null;
  const shown = stamps.length > max + 1 ? stamps.slice(0, max) : stamps;
  return h('span', { class: ['stamps', big ? 'big' : ''], role: 'img', 'aria-label': `${stampCount(stamps.length)}: ${stamps.map((s) => s.name).join(', ')}` },
    ...shown.map((s) => h('span', { class: 'stamp', title: s.name, text: stampLabel(s.name) })),
    stamps.length > shown.length ? h('span', { class: 'stamp more', text: `+${stamps.length - shown.length}` }) : null);
}
```

In `src/ui/screens/trips.js`, import `tripStamps`, `stampMarks` from `../stamps.js` and `stampCount` from `../../core/after/stamps.js`; the cards are made with `tripCard(s, json, backup, await tripStamps(ctx, s.id))` (active and archived alike), and:
```js
/** @param {any} s @param {any} trip @param {{ at: number | null, changed: boolean }} backup @param {import('../stamps.js').Stamp[]} stamps */
function tripCard(s, trip, backup, stamps) {
  const when = trip?.start ? dateRange(trip.start, trip.end) : null;
  return h('li', {}, h('a', { class: 'card trip-card', href: `#/trip/${encodeURIComponent(s.id)}` },
    h('span', { class: 'trip-card-text' },
      h('span', { class: 'name', text: s.title }),
      h('span', { class: 'sub', text: [when, stamps.length ? stampCount(stamps.length) : null, `updated ${relTime(s.updated)}`, backupText(backup)].filter(Boolean).join(' · ') })),
    stampMarks(stamps)));
}
```

In `src/ui/screens/trip.js`, read `const stamps = await tripStamps(ctx, id);`, add `stamps.length ? stampCount(stamps.length) : null` to the line under the title, and after it `stampMarks(stamps, { max: 24, big: true })`.

Append to `src/ui/base.css`:
```css
/* Stamps (spec §13, §16.2): station-stamp marks for visited places. */
.trip-card { flex-direction: row; align-items: center; justify-content: space-between; gap: 10px; }
.trip-card-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.stamps { display: flex; flex: none; padding-left: 10px; }
.stamp {
  width: 40px; height: 40px; margin-left: -10px; padding: 3px; border-radius: 50%; border: 3px double var(--ai);
  background: var(--sheet); color: var(--ai); display: grid; place-items: center; text-align: center;
  font-family: var(--f-display); font-size: 9px; font-weight: 700; line-height: 1.05; overflow: hidden; overflow-wrap: anywhere;
}
.stamp:nth-child(3n + 1) { transform: rotate(-9deg); }
.stamp:nth-child(3n + 2) { transform: rotate(6deg); }
.stamp:nth-child(3n) { transform: rotate(-3deg); }
.stamp.more { font-family: var(--f-mono); font-size: 11px; }
.stamps.big { flex-wrap: wrap; gap: 8px; padding-left: 0; }
.stamps.big .stamp { width: 60px; height: 60px; margin-left: 0; font-size: 11px; }
```

In `sw.js`, add `'/src/ui/stamps.js',` to `SHELL`.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/after-stamps.test.js`
Expected: PASS.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/trips.spec.js`
Expected: all pass in both browsers. Delete any `core*` file.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/after/stamps.js src/ui/stamps.js src/ui/screens/trips.js src/ui/screens/trip.js src/ui/base.css sw.js test/unit/after-stamps.test.js test/e2e/trips.spec.js && git commit -m "Trip cards show the stamps a trip's arrivals earned, station-stamp marks and \"N stamps\"; the trip's page shows them all

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 2: The Recap screen

**Files:**
- Modify: `src/core/after/recap.js` (`recapError`), `src/ui/router.js` (`recap`, `replay`), `src/ui/shell.js` (`SCREENS`), `src/ui/screens/trip.js` (the Recap button), `src/ui/screens/trace.js` (`recap` in Models), `src/ui/base.css`, `sw.js` (`SHELL`)
- Create: `src/ui/screens/recap.js`, `test/e2e/after-kit.js` (seeding a journey in the browser)
- Test: `test/unit/after-recap.test.js` (more), `test/unit/ui-pure.test.js` (routes), `test/e2e/after-recap.spec.js`

**Interfaces:**
- Consumes: 7a's `writeRecap`, `recapModels`, `RECAP_FILE`, `TELL_RECAP`; Task 1's `tripStamps`, `stampMarks`; `renderMarkdown` (`src/ui/markdown.js`); `codec` (`src/ui/photo-codec.js`); `loadPack` (`src/core/pack/read.js`); `withoutSecrets` (`src/core/agent/net.js`); `AllFailedError` (`src/core/llm/fallback.js`), `ProviderError`, `explain` (`src/core/llm/contract.js`).
- Produces: `recapError(e): string`; `renderRecap(ctx, route)`; routes `#/trip/<id>/recap` → `{ name: 'recap' }` and `#/trip/<id>/replay` → `{ name: 'replay' }`; `test/e2e/after-kit.js` exports `seedMorning(page, trip)` (the morning's road, an arrival, a card, words and a photo, written through annai's own modules in the page).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/after-recap.test.js`:
```js
test("why a recap wasn't written, in plain words with what to do next", () => {
  assert.equal(recapError(new AllFailedError([{ model: 'm', name: 'Haiku', outcome: 'auth', ms: 1, error: 'invalid x-api-key' }])), 'No model could write it: Haiku: invalid x-api-key. Check Settings → Models, then try again.');
  assert.equal(recapError(new AllFailedError([])), 'No model is set for the utility or main role. Add one in Settings → Models.');
  assert.equal(recapError(new ProviderError('rate', 'slow down')), 'The provider says too many requests for now. Try again in a while.');
  assert.equal(recapError(new Error('The model sent back an empty recap.')), 'The model sent back an empty recap.');
});
```
(`recapError` joins the import from `recap.js`; add `import { AllFailedError } from '../../src/core/llm/fallback.js';` and `import { ProviderError } from '../../src/core/llm/contract.js';`.)

Add to `test/unit/ui-pure.test.js`:
```js
test('parseHash: the recap and replay screens of a trip, with a day', () => {
  assert.deepEqual(parseHash('#/trip/t1/recap'), { name: 'recap', parts: ['trip', 't1', 'recap'], params: {} });
  assert.deepEqual(parseHash('#/trip/t1/replay?day=2026-11-27'), { name: 'replay', parts: ['trip', 't1', 'replay'], params: { day: '2026-11-27' } });
  assert.equal(parseHash('#/simulate').name, 'simulate');
});
```

`test/e2e/after-kit.js`:
```js
import { readFile } from 'node:fs/promises';
import { MORNING } from '../unit/after-kit.js';
import { BIXBY } from '../unit/live-kit.js';

const PHOTO = [...await readFile(new URL('../fixtures/photos/plain.jpg', import.meta.url))];
/** A moment of the drive's day, Pacific time. @param {string} hhmm */
export const at = (hhmm) => Date.parse(`2026-11-27T${hhmm}:00-08:00`);

/**
 * A trip's morning on Highway 1, written through annai's own modules in the page: its road (thinned
 * as the log keeps it), the arrival at Bixby Creek Bridge, Shiori's card, the user's words, a photo,
 * and the castle tour on the plan (which names the stay there).
 * @param {import('@playwright/test').Page} page @param {string} trip
 */
export async function seedMorning(page, trip) {
  const events = [
    ...MORNING.map((p) => ({ ts: p.at, type: 'location', data: { lat: p.lat, lng: p.lng, accuracy: 8 } })),
    { ts: at('09:32'), type: 'trigger.fired', data: { watch: 'plan:bixby:arrived', type: 'plan', event: 'arrived', place: { name: 'Bixby Creek Bridge', ...BIXBY } } },
    { ts: at('09:35'), type: 'out.show', data: { card: { title: 'Bixby Creek Bridge', text: 'Built in **1932**, 85 m above the creek.' } } },
    { ts: at('09:36'), type: 'msg.user', data: { text: 'Sam wants to see the sea lions.' } },
  ].sort((a, b) => a.ts - b.ts);
  await page.evaluate(async ({ trip, events, photo }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    await store.tx(['events'], 'readwrite', async (/** @type {any} */ t) => {
      for (const e of events) await t.appendEvent(trip, { ts: e.ts, type: e.type, actor: 'system', data: e.data });
    });
    const ws = new Workspace(store);
    await ws.patch(trip, '/trip.json', { timezones: ['America/Los_Angeles'] }, { author: 'user' });
    await ws.write(trip, '/plan/hearst.json', { id: 'hearst', title: 'Hearst Castle tour', fixed: true, start: { at: '2026-11-27T16:30:00-08:00', tz: 'America/Los_Angeles' }, place: { name: 'Hearst Castle', lat: 35.6852, lng: -121.166 } }, { author: 'user' });
    await ws.write(trip, '/files/2026-11-27-0945.jpg', Uint8Array.from(photo), { author: 'user', type: 'image/jpeg', meta: { taken: '2026-11-27T09:45:00', width: 64, height: 48 } });
    store.close();
  }, { trip, events, photo: PHOTO });
}
```

`test/e2e/after-recap.spec.js`:
```js
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply, startTrip, watchConsole } from './helpers.js';
import { seedMorning } from './after-kit.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const sleep = { name: 'sleep', input: {} };
const RECAP = '# A morning on Highway 1\n\n## Friday, November 27\n\nThe fog lifted over **Bixby Creek Bridge**. [More](javascript:alert(1)) <img src=x onerror="window.__pwned=1">';

/** Shiori's main model and a utility model, each on a stand-in Anthropic endpoint. @param {any} page @param {string} origin */
async function models(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Writer', url: `${origin}/u`, key: 'sk-test-u', model: 'u-model' });
  await page.getByLabel('Add a model to utility').selectOption({ label: 'u-model' });
  await page.getByRole('button', { name: 'Add to utility' }).click();
}

test('the recap: written by the utility model from the trip in words, shown safely, told by Shiori (spec §13)', async ({ page }) => {
  const errors = watchConsole(page);
  const llm = await startModelServer({ '/b/v1/messages': sse(anthropicToolReply([sleep])), '/u/v1/messages': sse(anthropicToolReply([], RECAP)) });
  try {
    await models(page, llm.origin);
    await page.goto('/#/trips');
    const trip = await startTrip(page, 'Big Sur');
    await seedMorning(page, trip);
    await page.getByRole('link', { name: 'Recap' }).click();
    await expect(page.getByRole('heading', { name: 'Recap' })).toBeVisible();
    await expect(page.getByText('No recap yet.')).toBeVisible();
    await expect(page.getByText(/^What goes to u-model/)).toBeVisible();
    await page.getByRole('button', { name: 'Write the recap' }).click();
    const text = page.locator('.recap-text');
    await expect(text).toContainText('The fog lifted over Bixby Creek Bridge.', { timeout: 20_000 });
    await expect(text.locator('strong')).toHaveText('Bixby Creek Bridge');
    await expect(text.locator('a')).toHaveCount(0); // a javascript: link stays text
    expect(await page.evaluate(() => /** @type {any} */ (window).__pwned)).toBeUndefined();
    const sent = JSON.stringify(llm.bodies('/u/v1/messages')[0]);
    expect(sent).toContain('stayed\\tBixby Creek Bridge\\t\\tyes');
    expect(sent).toContain('Sam wants to see the sea lions.');
    expect(sent).toContain('/trip/files/2026-11-27-0945.jpg'); // listed
    expect(sent).not.toContain('"type":"image"'); // not sent: this model takes no photos (7a choice 4)
    expect((sent.match(/-121\.\d{3,}/g) ?? []).length).toBeLessThanOrEqual(2); // never the track itself
    await page.getByRole('button', { name: 'Hear Shiori tell it' }).click();
    await expect.poll(() => JSON.stringify(llm.bodies('/b/v1/messages').at(-1) ?? '')).toContain("asked to hear the trip's recap");
    await expect(page.getByRole('button', { name: 'Write it again' })).toBeVisible();
    await page.getByRole('link', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: '/recap.md' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await llm.stop();
  }
});

test("a recap that can't be written says why and what to do; with no model the button waits for one", async ({ page }) => {
  const refused = { status: 401, type: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) };
  const llm = await startModelServer({ '/b/v1/messages': refused, '/u/v1/messages': refused });
  try {
    await openApp(page);
    const bare = await startTrip(page, 'No models yet');
    await page.goto(`/#/trip/${encodeURIComponent(bare)}/recap`);
    await expect(page.getByRole('button', { name: 'Write the recap' })).toBeDisabled();
    await expect(page.getByText('No model is set up to write it yet.')).toBeVisible();
    await models(page, llm.origin);
    await page.goto(`/#/trip/${encodeURIComponent(bare)}/recap`);
    await page.getByRole('button', { name: 'Write the recap' }).click();
    await expect(page.locator('.notice', { hasText: "The recap wasn't written" })).toContainText('Check Settings → Models, then try again.');
    await expect(page.getByRole('button', { name: 'Write the recap' })).toBeEnabled();
  } finally {
    await llm.stop();
  }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/after-recap.test.js test/unit/ui-pure.test.js`
Expected: FAIL: `recapError` isn't exported; `parseHash('#/trip/t1/recap').name` is `'trip'`.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/after-recap.spec.js`
Expected: FAIL in both browsers: no "Recap" link on the trip's page.

- [ ] **Step 3: Write the code**

In `src/core/after/recap.js`, import `AllFailedError` from `../llm/fallback.js` and `ProviderError`, `explain` from `../llm/contract.js`, and add:
```js
/** Why the recap wasn't written, in plain words with what to do next. @param {unknown} e */
export function recapError(e) {
  if (e instanceof AllFailedError) {
    return e.attempts.length
      ? `No model could write it: ${e.attempts.map((a) => `${a.name}: ${a.error ?? a.outcome}`).join('; ')}. Check Settings → Models, then try again.`
      : 'No model is set for the utility or main role. Add one in Settings → Models.';
  }
  if (e instanceof ProviderError) return `${explain(e).replace(/[.!?]?$/, '.')} Try again in a while.`;
  return String(/** @type {any} */ (e)?.message ?? e);
}
```

In `src/ui/router.js`, `SUB` becomes `{ file: 'file', plan: 'plan', booking: 'booking', recap: 'recap', replay: 'replay' }` (and the doc comment lists the new routes and `#/simulate`).

`src/ui/screens/recap.js`:
```js
import { h } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { writeRecap, recapModels, recapError, RECAP_FILE, TELL_RECAP, RECAP_PHOTOS } from '../../core/after/recap.js';
import { loadPack } from '../../core/pack/read.js';
import { updateAppSettings } from '../../core/settings.js';
import { withoutSecrets } from '../../core/agent/net.js';
import { text } from '../../core/bytes.js';
import { codec } from '../photo-codec.js';
import { fileHref, relTime } from '../format.js';
import { tripStamps, stampMarks } from '../stamps.js';

/**
 * Recap (spec §13, §16.2): the trip's recap as the utility model wrote it, rendered by annai's own
 * Markdown renderer (§15); a tap writes it, or writes it again (the old one stays in the file's
 * history); Shiori can tell it aloud. What goes to the model is said here (§11.7, choice 4).
 * @param {any} ctx @param {{ parts: string[] }} route
 */
export async function renderRecap(ctx, route) {
  const id = route.parts[1];
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  if (!scope || scope.kind !== 'trip') {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: "This trip isn't on this device" }), h('p', {}, h('a', { href: '#/trips' }, 'Back to Trips')));
  }
  const got = await ctx.ws.read(id, RECAP_FILE).catch(() => undefined);
  const recap = got ? text(got.bytes) : '';
  const stamps = await tripStamps(ctx, id);
  const model = ctx.llm ? recapModels(await ctx.llm.config().catch(() => null))[0] ?? null : null;
  const trip = `#/trip/${encodeURIComponent(id)}`;
  const status = h('p', { class: 'sub', role: 'status' });
  const write = h('button', { class: recap ? 'btn' : 'btn pri', type: 'button', disabled: !model }, recap ? 'Write it again' : 'Write the recap');
  write.addEventListener('click', async () => {
    if (!model) return;
    write.disabled = true;
    status.textContent = `Writing it: ${model.name} is reading the trip. This can take a minute.`;
    try {
      const pack = await loadPack(ctx.ws, id).catch(() => null);
      await writeRecap({ store: ctx.store, ws: ctx.ws, llm: ctx.llm, trip: id, codec, namer: (p) => pack?.name(p) ?? null });
      ctx.notices.toast('The recap is written.');
      if (status.isConnected) ctx.render();
    } catch (e) {
      status.textContent = '';
      write.disabled = false;
      ctx.notices.card({ tone: 'warn', title: "The recap wasn't written", body: await withoutSecrets(ctx.store, recapError(e)) });
    }
  });
  const tell = recap && ctx.agent ? h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      // Shiori talks about the trip that is open: this one, as opening its page makes it (choice 3).
      if (ctx.agent.target !== id) {
        await updateAppSettings(ctx.ws, { activeTrip: id });
        await ctx.agent.open(id);
      }
      ctx.agent.wake({ kind: 'recap', aloud: true, text: TELL_RECAP });
      ctx.notices.toast('Shiori is getting ready to tell it.');
    },
  }, 'Hear Shiori tell it') : null;
  return h('div', { class: 'screen recap' },
    h('p', { class: 'crumbs' }, h('a', { href: trip }, `← ${scope.title}`)),
    h('h1', { class: 'title', text: 'Recap' }),
    stampMarks(stamps, { max: 24, big: true }),
    recap
      ? h('article', { class: 'recap-text' }, renderMarkdown(recap))
      : h('p', { class: 'empty', text: "No recap yet. annai's utility model writes it from the trip: where you stayed and went, the stamps, what you and Shiori said, your notes and some photos." }),
    got ? h('p', { class: 'sub', text: `Written ${relTime(got.entry.modified)}${got.entry.author === 'user' ? ', then edited by you' : ''}.` }) : null,
    h('div', { class: 'acts' }, tell, write,
      recap ? h('a', { class: 'btn', href: fileHref(id, RECAP_FILE) }, 'Edit') : null,
      h('a', { class: 'btn', href: `${trip}/replay` }, 'Replay')),
    status,
    model
      ? h('details', { class: 'sent' },
        h('summary', { text: `What goes to ${model.name}` }),
        h('ul', {},
          h('li', { text: 'Where you stayed and for how long, by name; a place without one as its position, rounded to about 100 m. Never the GPS track itself.' }),
          h('li', { text: 'How far you drove or walked between, the stamps, and the plan.' }),
          h('li', { text: "Shiori's cards and your words, typed or spoken, each shortened." }),
          h('li', { text: 'The trip\'s notes and memory, and your profile.' }),
          h('li', { text: `Up to ${RECAP_PHOTOS} photos, if the model takes photos.` })))
      : h('p', { class: 'sub' }, 'No model is set up to write it yet. ', h('a', { href: '#/models' }, 'Add one in Settings → Models.')));
}
```

In `src/ui/shell.js`, import `renderRecap` and add `recap: renderRecap` to `SCREENS`.

In `src/ui/screens/trip.js`, after the Plan button: `h('a', { class: 'btn', href: `#/trip/${encodeURIComponent(id)}/recap` }, 'Recap'),`.

In `src/ui/screens/trace.js`, `Models` becomes `['model.turn', 'net.request', 'decide', 'speech.browser', 'recap']`.

Append to `src/ui/base.css`:
```css
/* Recap (spec §13) */
.recap-text { padding: 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--sheet); }
.recap-text .md { display: flex; flex-direction: column; gap: 10px; }
.recap-text .md-h { font-family: var(--f-display); font-weight: 700; font-size: 18px; }
.sent summary { cursor: pointer; color: var(--ink-2); min-height: 44px; display: flex; align-items: center; }
.sent ul { padding-left: 20px; color: var(--ink-2); font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
```

In `sw.js`, add `'/src/ui/screens/recap.js',` to `SHELL`.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/after-recap.test.js test/unit/ui-pure.test.js`
Expected: PASS.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/after-recap.spec.js test/e2e/trace.spec.js`
Expected: all pass in both browsers. Delete any `core*` file.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/after/recap.js src/ui/router.js src/ui/shell.js src/ui/screens/recap.js src/ui/screens/trip.js src/ui/screens/trace.js src/ui/base.css sw.js test/unit/after-recap.test.js test/unit/ui-pure.test.js test/e2e/after-kit.js test/e2e/after-recap.spec.js && git commit -m "The Recap screen: the utility model writes it on a tap from the trip in words, shown by annai's own Markdown renderer; Shiori tells it aloud; the screen says what goes to the model and why a recap wasn't written

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 3: The Replay screen

**Files:**
- Create: `src/core/after/replay.js`, `src/ui/screens/replay.js`
- Modify: `src/ui/shell.js` (`SCREENS`), `src/ui/screens/trip.js` (the Replay button), `src/ui/base.css`, `sw.js` (`SHELL`)
- Test: `test/unit/after-replay.test.js`, `test/e2e/after-replay.spec.js`

**Interfaces:**
- Consumes: 7a's `readJourney`, `Journey`, `Entry`; `segmentsOf`, `thin`, `positionAt`, `fractionAt`, `fit`, `Point`; `PlayClock`; `stampCount` (Task 1); `instantOf`, `timeIn`; `kmText`, `span` (geo.js); `renderCard`, `openPhotoViewer`, `stampMarks`; `seedMorning` (Task 2).
- Produces (`src/core/after/replay.js`): `PLAY_SPEEDS: [number, string][]`; `dayBounds(day, tz): { from, to }`; `replayOf(j, day?): Replay | null` with `Replay = { day, tz, from, to, segments: Point[][], lengths: number[], map, entries: Entry[], stamps, km, words }`; `momentAt(r, t): { xy: [number, number] | null, index: number, where: string, stamps: number, done: number[] }`; `entryLine(e, tz): { when: string, text: string }`; `routeWords(r): string`. `renderReplay(ctx, route)`.

- [ ] **Step 1: Write the failing tests**

`test/unit/after-replay.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayOf, momentAt, entryLine, routeWords, dayBounds, PLAY_SPEEDS } from '../../src/core/after/replay.js';
import { readJourney } from '../../src/core/after/journey.js';
import { logEvent } from '../../src/core/events.js';
import { liveKit, at, iso, LA, BIXBY, HEARST, NEPENTHE } from './live-kit.js';
import { MORNING } from './after-kit.js';

/** The morning's journey, with an arrival, a card and words, and a day after with one message. */
async function morning() {
  const k = await liveKit({ live: false, plan: { hearst: { title: 'Hearst Castle tour', fixed: true, start: { at: iso('16:30'), tz: LA }, place: { name: 'Hearst Castle', ...HEARST } } } });
  await k.ws.patch(k.trip, '/trip.json', { timezones: [LA] }, { author: 'user' });
  for (const p of MORNING) await logEvent(k.store, k.trip, { type: 'location', data: { lat: p.lat, lng: p.lng } }, p.at);
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { type: 'plan', event: 'arrived', place: { name: 'Bixby Creek Bridge', ...BIXBY } } }, at('09:32'));
  await logEvent(k.store, k.trip, { type: 'out.show', data: { card: { title: 'Bixby Creek Bridge', text: 'Built in 1932.' } } }, at('09:35'));
  await logEvent(k.store, k.trip, { type: 'heard', data: { id: 'h', text: 'Can we stop at Nepenthe?' } }, at('09:36'));
  await logEvent(k.store, k.trip, { type: 'msg.user', data: { text: 'Good morning!' } }, at('08:00', '2026-11-28'));
  return readJourney({ store: k.store, ws: k.ws, trip: k.trip });
}

test('the whole trip, or a day of it: the drawn route, its entries and stamps, and the route in words (spec §13, §16.5)', async () => {
  const j = await morning();
  const all = /** @type {import('../../src/core/after/replay.js').Replay} */ (replayOf(j));
  assert.equal(all.segments.length, 2); // the phone locked from Nepenthe to Hearst Castle
  assert.equal(all.from, MORNING[0].at);
  assert.equal(all.to, at('08:00', '2026-11-28'));
  assert.ok(all.lengths.every((n) => n >= 0) && all.lengths[0] > 100);
  assert.match(all.words, /^\d+\.\d km on the road, from Bixby Creek Bridge to Hearst Castle, with 2 stops and 1 stamp\.$/);
  const friday = /** @type {any} */ (replayOf(j, '2026-11-27'));
  assert.equal(friday.entries.some((/** @type {any} */ e) => e.text === 'Good morning!'), false);
  const saturday = /** @type {any} */ (replayOf(j, '2026-11-28'));
  assert.deepEqual([saturday.segments, saturday.entries.length, saturday.km], [[], 1, 0]);
  assert.equal(saturday.words, 'No road was recorded, with 0 stops and 0 stamps.');
  assert.equal(replayOf(j, '2026-12-01'), null);
  assert.deepEqual(dayBounds('2026-11-27', LA), { from: Date.parse('2026-11-27T08:00:00Z'), to: Date.parse('2026-11-28T08:00:00Z') });
  assert.deepEqual(PLAY_SPEEDS.map(([v]) => v), [60, 600, 3600]);
});

test('what was so at a moment: where, the last entry reached, the stamps so far, how much of the route is behind', async () => {
  const r = /** @type {import('../../src/core/after/replay.js').Replay} */ (replayOf(await morning(), '2026-11-27'));
  const before = momentAt(r, at('08:00'));
  assert.deepEqual([before.index, before.where, before.stamps, before.done.every((d) => d === 0)], [-1, 'Not started yet', 0, true]);
  const bridge = momentAt(r, at('09:40'));
  assert.equal(bridge.where, 'At Bixby Creek Bridge');
  assert.equal(bridge.stamps, 1);
  assert.equal(/** @type {any} */ (r.entries[bridge.index]).kind, 'said'); // the words at 09:36 were the last thing reached
  const onTheWay = momentAt(r, at('12:00'));
  assert.equal(onTheWay.where, 'Driving from Bixby Creek Bridge');
  assert.ok(onTheWay.done[0] > 0 && Math.abs(onTheWay.done[0] - r.lengths[0]) < 1, 'the first piece is all behind, held during the jump');
  const [x, y] = /** @type {[number, number]} */ (onTheWay.xy);
  const [nx, ny] = r.map.xy(NEPENTHE);
  assert.ok(Math.abs(x - nx) < 1 && Math.abs(y - ny) < 1, 'held where the jump began');
  assert.equal(momentAt(r, at('17:00')).where, 'At Hearst Castle');
});

test('each timeline entry in a few words', async () => {
  const r = /** @type {import('../../src/core/after/replay.js').Replay} */ (replayOf(await morning(), '2026-11-27'));
  const lines = r.entries.map((e) => entryLine(e, LA));
  assert.match(lines[0].text, /^Drove \d+\.\d km · 30 min$/);
  assert.match(lines[1].when, /^09:29–09:5\d$/);
  assert.equal(lines[1].text, 'Bixby Creek Bridge · 20 min · stamp');
  assert.deepEqual(lines[2], { when: '09:35', text: 'Shiori: Bixby Creek Bridge' });
  assert.deepEqual(lines[3], { when: '09:36', text: 'You said: Can we stop at Nepenthe?' });
  assert.match(lines[4].text, /^Drove \d+\.\d km · 6 h \d+ min \(partly unseen: the phone was locked\)$/);
  assert.equal(entryLine({ kind: 'photo', at: at('10:00'), path: '/files/2026-11-27-1000.webp', hash: 'h', type: 'image/webp', size: 1, width: null, height: null, place: null }, LA).text, 'Photo 2026-11-27-1000.webp');
  assert.equal(entryLine({ kind: 'stay', at: at('10:00'), to: at('10:30'), lat: 1, lng: 1, name: null, stamp: null }, LA).text, 'A stop · 30 min');
  assert.equal(routeWords({ entries: [], km: 0, stamps: [] }), 'No road was recorded, with 0 stops and 0 stamps.');
});
```

`test/e2e/after-replay.spec.js`:
```js
import { test, expect } from '@playwright/test';
import { openApp, startTrip, watchConsole } from './helpers.js';
import { seedMorning, at } from './after-kit.js';

test('the replay: the timeline, the route on a flat map and in words, scrubbing and playback (spec §13, §16.5)', async ({ page }) => {
  const errors = watchConsole(page);
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await seedMorning(page, trip);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
  await page.getByRole('link', { name: 'Replay' }).click();
  await expect(page.getByRole('heading', { name: 'Replay' })).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline.getByRole('button')).toHaveText([
    /^\d\d:\d\dDrove \d+\.\d km · 30 min$/, /Bixby Creek Bridge · 20 min · stamp/, /^09:35Shiori: Bixby Creek Bridge$/,
    /^09:36You: Sam wants to see the sea lions\.$/, /^09:45Photo 2026-11-27-0945\.jpg$/, /^\d\d:\d\dDrove .*partly unseen/, /^16:40–18:15Hearst Castle · 1 h 35 min$/,
  ]);
  const map = page.getByRole('img', { name: /^The route: \d+\.\d km on the road, from Bixby Creek Bridge to Hearst Castle, with 2 stops and 1 stamp\.$/ });
  await expect(map).toBeVisible();
  expect((await page.locator('svg.route-map polyline.route-all').first().getAttribute('points'))?.split(' ').length).toBeGreaterThan(100);
  await expect(page.locator('svg.route-map line.route-jump')).toHaveCount(1);
  const scrub = page.getByLabel('Time in the trip');
  await scrub.fill(String(at('09:40')));
  await expect(page.locator('.replay-where')).toHaveText('At Bixby Creek Bridge');
  await expect(page.locator('.replay-shown')).toContainText('Sam wants to see the sea lions.');
  await expect(scrub).toHaveAttribute('aria-valuetext', /09:40, At Bixby Creek Bridge$/);
  await timeline.getByRole('button', { name: /Photo 2026-11-27-0945\.jpg/ }).click();
  await expect(page.locator('.replay-shown img')).toHaveAttribute('src', /^blob:/);
  await timeline.getByRole('button', { name: /Shiori: Bixby Creek Bridge/ }).click();
  await expect(page.locator('.replay-shown strong')).toHaveText('1932'); // the card, through the card renderer
  await page.getByLabel('Speed').selectOption({ label: '1 hour a second' });
  const time = page.locator('.replay-time');
  const was = await time.textContent();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(time).not.toHaveText(/** @type {string} */ (was));
  await expect(page.locator('.replay-where')).toHaveText('At Hearst Castle', { timeout: 20_000 }); // it plays to the end and stops there
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await page.getByRole('button', { name: 'Play' }).click(); // at the end: it starts again
  await page.goto('/#/trips'); // leaving while it plays
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

test('a trip with nothing recorded has nothing to replay, and says why', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Not yet');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/replay`);
  await expect(page.getByText(/^Nothing to replay yet\./)).toBeVisible();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/after-replay.test.js`
Expected: FAIL: `Cannot find module '…/src/core/after/replay.js'`.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/after-replay.spec.js`
Expected: FAIL in both browsers: no "Replay" link on the trip's page.

- [ ] **Step 3: Write the code**

`src/core/after/replay.js`:
```js
import { segmentsOf, thin, positionAt, fractionAt, fit } from './route.js';
import { stampCount } from './stamps.js';
import { instantOf, timeIn } from '../time.js';
import { kmText, span } from '../live/geo.js';

/**
 * The replay (spec §13) of a journey or one of its days, for the screen to draw: the route as drawn
 * (thinned, on a flat map), its entries, the route in words for anyone who can't see it (§16.5), and
 * what was so at any moment of the playback.
 * @typedef {import('./journey.js').Journey} Journey
 * @typedef {import('./journey.js').Entry} Entry
 * @typedef {import('./route.js').Point} Point
 * @typedef {{ day: string | null, tz: string, from: number, to: number, segments: Point[][], lengths: number[], map: ReturnType<typeof fit>,
 *   entries: Entry[], stamps: import('./stamps.js').Stamp[], km: number, words: string }} Replay
 *   lengths: each drawn piece's length on the map
 * @typedef {{ xy: [number, number] | null, index: number, where: string, stamps: number, done: number[] }} Moment
 *   index: the entry last reached (-1: none yet); done: how much of each piece is behind, on the map
 */

/** Playback speeds: trip time a second, and their words (choice 5). */
export const PLAY_SPEEDS = Object.freeze(/** @type {[number, string][]} */ ([[60, '1 minute a second'], [600, '10 minutes a second'], [3600, '1 hour a second']]));

/** When a day begins and ends in a zone. @param {string} day "YYYY-MM-DD" @param {string} tz */
export function dayBounds(day, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return { from: instantOf({ year: y, month: m, day: d }, tz), to: instantOf({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, tz) };
}

/** Distance on the map. @param {ReturnType<typeof fit>} map */
const onMap = (map) => (/** @type {Point} */ a, /** @type {Point} */ b) => {
  const [x1, y1] = map.xy(a);
  const [x2, y2] = map.xy(b);
  return Math.hypot(x2 - x1, y2 - y1);
};

/**
 * @param {Journey} j @param {string | null} [day] one of j.days; null: the whole trip
 * @returns {Replay | null} null when nothing was recorded then
 */
export function replayOf(j, day = null) {
  const b = day ? dayBounds(day, j.tz) : null;
  const inside = (/** @type {number} */ t) => !b || (t >= b.from && t < b.to);
  const points = b ? j.points.filter((p) => inside(p.at)) : j.points;
  const entries = j.entries.filter((e) => inside(e.at));
  if (!points.length && !entries.length) return null;
  const times = [...entries.flatMap((e) => ('to' in e ? [e.at, e.to] : [e.at])), ...(points.length ? [points[0].at, points[points.length - 1].at] : [])];
  const segments = thin(segmentsOf(points));
  const map = fit(segments.flat());
  const dist = onMap(map);
  const lengths = segments.map((s) => s.slice(1).reduce((n, p, i) => n + dist(s[i], p), 0));
  const km = Math.round(entries.reduce((n, e) => n + (e.kind === 'move' ? e.km : 0), 0) * 10) / 10;
  const stamps = j.stamps.filter((s) => inside(s.at));
  return { day, tz: j.tz, from: Math.min(...times), to: Math.max(...times), segments, lengths, map, entries, stamps, km, words: routeWords({ entries, km, stamps }) };
}

/**
 * The route in words (spec §16.5: it must make sense without seeing it): how far, from where to
 * where, with how many stops and stamps. @param {{ entries: Entry[], km: number, stamps: unknown[] }} r
 */
export function routeWords({ entries, km, stamps }) {
  const stays = /** @type {Extract<Entry, { kind: 'stay' }>[]} */ (entries.filter((e) => e.kind === 'stay'));
  const named = stays.filter((e) => e.name);
  const first = named[0]?.name;
  const last = named[named.length - 1]?.name;
  const tail = `with ${stays.length} ${stays.length === 1 ? 'stop' : 'stops'} and ${stampCount(stamps.length)}.`;
  if (!km) return `No road was recorded, ${tail}`;
  return `${kmText(km * 1000)} on the road${first ? `, from ${first}` : ''}${last && last !== first ? ` to ${last}` : ''}, ${tail}`;
}

/** What was so at t. @param {Replay} r @param {number} t @returns {Moment} */
export function momentAt(r, t) {
  let index = -1;
  for (let lo = 0, hi = r.entries.length - 1; lo <= hi;) {
    const mid = (lo + hi) >> 1;
    if (r.entries[mid].at <= t) {
      index = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  /** @type {any} */
  const stay = r.entries.find((e) => e.kind === 'stay' && t >= e.at && t <= e.to);
  /** @type {any} */
  const move = stay ? null : r.entries.find((e) => e.kind === 'move' && t >= e.at && t <= e.to);
  /** @type {any} */
  let prev = null;
  for (let i = index; i >= 0 && !prev; i--) if (r.entries[i].kind === 'stay' && /** @type {any} */ (r.entries[i]).name) prev = r.entries[i];
  const where = stay ? (stay.name ? `At ${stay.name}` : 'Stopped')
    : move ? `${move.mode === 'walk' ? 'Walking' : 'Driving'}${prev ? ` from ${prev.name}` : ''}`
      : t < r.from || index < 0 ? 'Not started yet'
        : prev ? `After ${prev.name}` : 'On the way';
  const pos = positionAt(r.segments, t);
  const dist = onMap(r.map);
  return { xy: pos ? r.map.xy(pos) : null, index, where, stamps: r.stamps.filter((s) => s.at <= t).length, done: r.segments.map((s, i) => fractionAt(s, t, dist) * r.lengths[i]) };
}

/** @param {string} s @param {number} n */
const cut = (s, n) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** One timeline entry in words: when, and what (choice 6). @param {Entry} e @param {string} tz */
export function entryLine(e, tz) {
  const at = String(timeIn(e.at, tz));
  if (e.kind === 'stay') return { when: `${at}–${timeIn(e.to, tz)}`, text: `${e.name ?? 'A stop'} · ${span(e.to - e.at)}${e.stamp ? ' · stamp' : ''}` };
  if (e.kind === 'move') return { when: at, text: `${e.mode === 'walk' ? 'Walked' : 'Drove'} ${kmText(e.km * 1000)} · ${span(e.to - e.at)}${e.gap ? ' (partly unseen: the phone was locked)' : ''}` };
  if (e.kind === 'card') {
    const c = e.card ?? {};
    const words = [c.title, c.text, c.place?.name].find((x) => typeof x === 'string' && x.trim());
    return { when: at, text: `Shiori: ${cut(String(words ?? 'a card'), 120)}` };
  }
  if (e.kind === 'said') return { when: at, text: `You${e.spoken ? ' said' : ''}: ${cut(e.text, 120)}` };
  return { when: at, text: `Photo ${e.path.split('/').pop()}` };
}
```

`src/ui/screens/replay.js`:
```js
import { h, field } from '../dom.js';
import { readJourney } from '../../core/after/journey.js';
import { replayOf, momentAt, entryLine, PLAY_SPEEDS } from '../../core/after/replay.js';
import { stampCount } from '../../core/after/stamps.js';
import { PlayClock } from '../../core/live/clock.js';
import { loadPack } from '../../core/pack/read.js';
import { timeIn } from '../../core/time.js';
import { renderCard } from '../cards.js';
import { openPhotoViewer } from '../photo-viewer.js';
import { stampMarks } from '../stamps.js';

const NS = 'http://www.w3.org/2000/svg';

/** An SVG element: geometry and strokes as attributes, never a style attribute. @param {string} tag @param {Record<string, string | number>} [attrs] @param {...(Node | string | null)} children */
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) if (c !== null) el.append(c);
  return el;
}

/**
 * Replay (spec §13, §16.2): the trip's timeline (places, Shiori's cards, photos, the user's words),
 * the route drawn from its location points on a flat map with no tiles, and playback at adjustable
 * speed. The route is also said in words, and every entry is a list item, so the replay makes sense
 * without seeing the map (§16.5).
 * @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route
 */
export async function renderReplay(ctx, route) {
  const id = route.parts[1];
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  if (!scope || scope.kind !== 'trip') {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: "This trip isn't on this device" }), h('p', {}, h('a', { href: '#/trips' }, 'Back to Trips')));
  }
  const locale = navigator.language || 'en-US';
  const pack = await loadPack(ctx.ws, id).catch(() => null);
  const j = await readJourney({ store: ctx.store, ws: ctx.ws, trip: id, namer: (p) => pack?.name(p) ?? null });
  const day = j.days.includes(route.params.day ?? '') ? route.params.day : null;
  const r = replayOf(j, day);
  const base = `#/trip/${encodeURIComponent(id)}/replay`;
  const dayName = (/** @type {string} */ d) => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.parse(`${d}T12:00:00Z`));
  const tab = (/** @type {string | null} */ d, /** @type {string} */ label) => h('a', { class: 'tab', href: d ? `${base}?day=${d}` : base, 'aria-current': d === day ? 'page' : null }, label);
  const head = [
    h('p', { class: 'crumbs' }, h('a', { href: `#/trip/${encodeURIComponent(id)}` }, `← ${scope.title}`)),
    h('h1', { class: 'title', text: 'Replay' }),
    j.days.length > 1 ? h('nav', { class: 'tabs', 'aria-label': 'Days' }, tab(null, 'Whole trip'), ...j.days.map((d) => tab(d, dayName(d)))) : null,
  ];
  if (!r) {
    return h('div', { class: 'screen replay' }, ...head,
      h('p', { class: 'empty', text: "Nothing to replay yet. While live mode is on, annai records the road; Shiori's cards, your messages and your photos show here too." }));
  }
  const clock = new PlayClock(r.from, { speed: 600, playing: false });
  const clockText = (/** @type {number} */ t) => new Intl.DateTimeFormat(locale, { timeZone: r.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);

  // The map: the drawn route grey, what is behind vermilion, jumps dashed, stays and stamps as rings, you as a dot (choice 8).
  const { width, height, xy } = r.map;
  const line = (/** @type {import('../../core/after/route.js').Point[]} */ seg) => seg.map((p) => xy(p).join(',')).join(' ');
  const jumps = r.segments.slice(1).map((seg, i) => {
    const prev = r.segments[i];
    const [x1, y1] = xy(prev[prev.length - 1]);
    const [x2, y2] = xy(seg[0]);
    return svg('line', { class: 'route-jump', x1, y1, x2, y2 });
  });
  const done = r.segments.map((seg, i) => svg('polyline', { class: 'route-done', points: line(seg), 'stroke-dasharray': `${r.lengths[i]} ${r.lengths[i] + 1}`, 'stroke-dashoffset': r.lengths[i] }));
  const stays = /** @type {Extract<import('../../core/after/journey.js').Entry, { kind: 'stay' }>[]} */ (r.entries.filter((e) => e.kind === 'stay'));
  const rings = stays.map((e) => {
    const [cx, cy] = xy(e);
    return svg('circle', { class: e.stamp ? 'route-stamp' : 'route-stay', cx, cy, r: e.stamp ? 16 : 9 }, svg('title', {}, e.name ?? 'A stop'));
  });
  const here = svg('circle', { class: 'route-here', r: 13, cx: -100, cy: -100 });
  const titleId = `route-${Math.random().toString(36).slice(2)}`;
  const map = svg('svg', { class: 'route-map', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': titleId, preserveAspectRatio: 'xMidYMid meet' },
    svg('title', { id: titleId }, `The route: ${r.words}`),
    ...jumps, ...r.segments.map((seg) => svg('polyline', { class: 'route-all', points: line(seg) })), ...done, ...rings, here);

  // At this moment (choice 7).
  const timeEl = h('p', { class: 'replay-time' });
  const whereEl = h('p', { class: 'replay-where now-place' });
  const soFar = h('p', { class: 'sub' });
  const shown = h('div', { class: 'replay-shown' });
  const told = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  /** @type {any} */
  let shownEntry = null;
  let photoUrl = '';
  /** The latest card, words or photo reached. @param {number} index */
  const showLatest = (index) => {
    let e = null;
    for (let i = index; i >= 0 && !e; i--) if (['card', 'said', 'photo'].includes(r.entries[i].kind)) e = /** @type {any} */ (r.entries[i]);
    if (e === shownEntry) return;
    shownEntry = e;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = '';
    if (!e) {
      shown.replaceChildren();
      return;
    }
    const when = h('span', { class: 'sub', text: timeIn(e.at, r.tz) });
    if (e.kind === 'card') shown.replaceChildren(h('div', { class: 'shiori-card' }, h('span', { class: 'who', text: 'SHIORI' }), renderCard(e.card, { ctx }), when));
    else if (e.kind === 'said') shown.replaceChildren(h('div', { class: 'shiori-card' }, h('span', { class: 'who', text: e.spoken ? 'YOU SAID' : 'YOU' }), h('p', { text: e.text }), when));
    else {
      const img = h('img', { class: 'replay-photo', alt: `Photo ${e.path.split('/').pop()}, ${timeIn(e.at, r.tz)}` });
      const open = h('button', { class: 'btn ghost', type: 'button', disabled: true }, 'Open full size');
      shown.replaceChildren(h('figure', { class: 'replay-figure' }, img, h('figcaption', {}, when, open)));
      const mine = e;
      ctx.ws.read(id, e.path).then((/** @type {any} */ got) => {
        if (shownEntry !== mine || !got) return;
        photoUrl = URL.createObjectURL(new Blob([got.bytes], { type: got.entry.type }));
        img.src = photoUrl;
        open.disabled = false;
        open.onclick = () => openPhotoViewer(photoUrl, mine.path);
      }).catch(() => {});
    }
  };

  // The controls (choice 5).
  const play = h('button', { class: 'btn pri', type: 'button' }, 'Play');
  const speed = h('select', { id: 'replay-speed' }, ...PLAY_SPEEDS.map(([v, label]) => h('option', { value: String(v), text: label })));
  speed.value = '600';
  const scrub = h('input', { id: 'replay-scrub', type: 'range', min: String(r.from), max: String(r.to), step: '60000', value: String(r.from) });

  // The timeline (choice 6): each entry a button that moves the playback there.
  const items = r.entries.map((e) => {
    const { when, text } = entryLine(e, r.tz);
    return h('li', { class: ['replay-entry', e.kind] }, h('button', {
      class: 'replay-item', type: 'button',
      onclick: () => {
        clock.seek(e.at);
        draw();
      },
    }, h('span', { class: 'when', text: when }), h('span', { class: 'what', text })));
  });

  let was = { index: -2, where: '', minute: NaN, stamps: -1 };
  const draw = () => {
    const t = Math.min(r.to, Math.max(r.from, clock.now()));
    const m = momentAt(r, t);
    if (m.xy) {
      here.setAttribute('cx', String(m.xy[0]));
      here.setAttribute('cy', String(m.xy[1]));
    }
    done.forEach((pl, i) => pl.setAttribute('stroke-dashoffset', String(Math.max(0, r.lengths[i] - m.done[i]))));
    const minute = Math.floor(t / 60_000);
    if (minute !== was.minute || m.where !== was.where) {
      const words = clockText(t);
      timeEl.textContent = words;
      scrub.value = String(t);
      scrub.setAttribute('aria-valuetext', `${words}, ${m.where}`);
    }
    if (m.where !== was.where) {
      whereEl.textContent = m.where;
      if (clock.playing) told.textContent = `${timeIn(t, r.tz)}, ${m.where}`;
    }
    if (m.stamps !== was.stamps) soFar.textContent = `${stampCount(m.stamps)} so far`;
    if (m.index !== was.index) {
      items[was.index]?.classList.remove('now');
      items[was.index]?.firstElementChild?.removeAttribute('aria-current');
      items[m.index]?.classList.add('now');
      items[m.index]?.firstElementChild?.setAttribute('aria-current', 'true');
      showLatest(m.index);
    }
    was = { index: m.index, where: m.where, minute, stamps: m.stamps };
  };
  const root = h('div', { class: 'screen replay' }, ...head,
    stampMarks(r.stamps, { max: 24, big: true }),
    h('figure', { class: 'route' }, map, h('figcaption', { class: 'sub', text: `${r.words} The timeline below lists each place in order.` })),
    h('section', { class: 'replay-now', 'aria-label': 'At this moment' }, timeEl, whereEl, soFar, shown, told),
    h('div', { class: 'replay-controls' },
      h('div', { class: 'acts' }, play),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Time in the trip' }), scrub),
      field('Speed', speed)),
    h('section', { 'aria-label': 'The trip in order' }, h('h2', { class: 'section', text: 'Timeline' }), h('ol', { class: 'timeline', 'aria-label': 'Timeline' }, ...items)));
  const setPlaying = (/** @type {boolean} */ on) => { play.textContent = on ? 'Pause' : 'Play'; };
  const tick = () => {
    if (!root.isConnected) {
      // The screen is gone: playback stops with it.
      clock.pause();
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      return;
    }
    if (clock.now() >= r.to) {
      clock.pause();
      clock.seek(r.to);
      setPlaying(false);
    }
    draw();
    if (clock.playing) requestAnimationFrame(tick);
  };
  play.addEventListener('click', () => {
    if (clock.playing) {
      clock.pause();
      setPlaying(false);
      draw();
      return;
    }
    if (clock.now() >= r.to) clock.seek(r.from); // at the end: from the beginning again
    clock.play();
    setPlaying(true);
    requestAnimationFrame(tick);
  });
  speed.addEventListener('change', () => { clock.speed = Number(speed.value); });
  scrub.addEventListener('input', () => {
    clock.seek(Number(scrub.value));
    draw();
  });
  draw();
  return root;
}
```
(The route in words is the map's name and its caption; the stamps come first.)

In `src/ui/shell.js`, import `renderReplay` and add `replay: renderReplay` to `SCREENS`. In `src/ui/screens/trip.js`, after the Recap button: `h('a', { class: 'btn', href: `#/trip/${encodeURIComponent(id)}/replay` }, 'Replay'),`.

Append to `src/ui/base.css`:
```css
/* Replay (spec §13): a flat map, no tiles; strokes and geometry are attributes and these rules, never a style attribute. */
.tab[aria-current='page'] { background: var(--ai-wash); color: var(--ai); border-color: transparent; }
a.tab { display: inline-flex; align-items: center; text-decoration: none; }
.route { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.route-map { display: block; width: 100%; height: auto; max-height: 62vh; background: var(--sheet); border: 1px solid var(--line); border-radius: var(--radius); }
.route-all, .route-done { fill: none; stroke-width: 8; stroke-linecap: round; stroke-linejoin: round; }
.route-all { stroke: var(--line); }
.route-done { stroke: var(--ai); }
.route-jump { stroke: var(--ink-2); stroke-width: 4; stroke-dasharray: 12 14; }
.route-stay { fill: var(--sheet); stroke: var(--ink-2); stroke-width: 4; }
.route-stamp { fill: var(--sheet); stroke: var(--ai); stroke-width: 6; }
.route-here { fill: var(--ai); stroke: var(--sheet); stroke-width: 5; }
.replay-now { display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--sheet); }
.replay-time { font-family: var(--f-mono); color: var(--ink-2); }
.replay-photo { display: block; max-width: 100%; max-height: 40vh; border-radius: 10px; }
.replay-figure { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.replay-figure figcaption { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.replay-controls { display: flex; flex-direction: column; gap: 10px; }
.replay-controls input[type='range'] { padding: 0; accent-color: var(--ai); }
.timeline { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; }
.replay-item { width: 100%; min-height: 44px; display: grid; grid-template-columns: 6.5em minmax(0, 1fr); gap: 8px; align-items: baseline; padding: 8px 0; border: 0; border-bottom: 1px solid var(--line); background: none; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.replay-item .when { font-family: var(--f-mono); font-size: 13px; color: var(--ink-2); }
.replay-entry.stay .what { font-weight: 700; }
.replay-entry.now .replay-item { background: var(--ai-wash); }
```

In `sw.js`, add `'/src/core/after/replay.js',` and `'/src/ui/screens/replay.js',` to `SHELL`.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/after-replay.test.js`
Expected: PASS (3 tests).
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/after-replay.spec.js`
Expected: 4 passed (2 tests × 2 browsers). Delete any `core*` file.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/after/replay.js src/ui/screens/replay.js src/ui/shell.js src/ui/screens/trip.js src/ui/base.css sw.js test/unit/after-replay.test.js test/e2e/after-replay.spec.js && git commit -m "The Replay screen: the timeline of places, Shiori's cards, photos and the user's words; the route as an SVG polyline on a flat map, said in words too; playback at a minute, ten or an hour a second, a scrubber, and day tabs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 4: Settings → Developer → Simulate a trip; the live chip and Now during a simulation

**Files:**
- Create: `src/ui/screens/simulate.js`
- Modify: `src/ui/screens/settings.js` (Developer), `src/ui/live-chip.js` (`knownFix` on live mode's clock; `liveText` and the menu during a simulation), `src/ui/screens/now.js` and `src/ui/screens/drive.js` (live mode's clock), `src/ui/shell.js` (`SCREENS`, the Settings tab for `#/simulate`), `src/app/main.js` (`ctx.sim`), `src/ui/base.css`, `sw.js` (`SHELL`)
- Test: `test/unit/ui-pure.test.js` (the chip's words), `test/e2e/after-simulate.spec.js`

**Interfaces:**
- Consumes: 7a's `SimRun`, `SPEEDS`, `SimState`; `answerJSON` (`src/core/answer.js`); `listTrips`.
- Produces: `renderSimulate(ctx)`; `knownFix(live, now = live.clock?.now() ?? Date.now())`; `liveText(live)` gives `Simulation · <doing>` while `live.simulating`; `ctx.sim` (the app's one `SimRun`).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/ui-pure.test.js` (import `liveText`, `knownFix` from `../../src/ui/live-chip.js`):
```js
test("the live chip during a simulation, and where the user is by live mode's own clock", () => {
  const fix = { lat: 36, lng: -121, at: Date.parse('2026-11-27T12:00:00-08:00'), source: 'sim' };
  const live = { on: true, gps: 'ok', activity: 'moving-fast', fix, simulating: true, clock: { now: () => fix.at + 5000 } };
  assert.equal(liveText(live), 'Simulation · moving fast');
  assert.equal(knownFix(live), fix); // fresh by the simulation's clock, weeks from today
  assert.equal(liveText({ ...live, simulating: false, activity: 'still' }), 'Live · stopped');
  assert.equal(knownFix({ ...live, clock: { now: () => fix.at + 3_600_000 } }), null);
});
```

`test/e2e/after-simulate.spec.js`:
```js
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const sleep = { name: 'sleep', input: {} };

/** Shiori's main model on a stand-in endpoint. @param {any} page @param {string} origin */
async function mainModel(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
}

test('Simulate a trip at ten times real time: the chip says so, it pauses and stops, and live mode is as it was (spec §13)', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': sse(anthropicToolReply([sleep])) });
  try {
    await mainModel(page, llm.origin);
    await page.goto('/#/settings');
    await page.getByRole('link', { name: 'Simulate a trip' }).click();
    await expect(page.getByRole('heading', { name: 'Simulate a trip' })).toBeVisible();
    await expect(page.getByLabel(/^Big Sur on Highway 1/)).toBeChecked();
    await expect(page.getByLabel('Speed')).toHaveValue('10');
    await page.getByRole('button', { name: 'Start the simulation' }).click();
    await expect(page.getByRole('heading', { name: 'Big Sur on Highway 1: Monterey to Cambria (simulation)' })).toBeVisible();
    await expect(page.locator('.sim-time')).toContainText(/Nov 27|27 Nov/);
    await expect(page.locator('.live-chip')).toHaveText(/^Simulation/);
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(0); // Shiori heard live mode come on
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
    await page.locator('.live-chip').click();
    await page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Stop the simulation' }).click();
    await expect(page.getByText('You stopped the simulation.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Replay it' })).toBeVisible();
    await expect(page.locator('.live-chip')).toHaveText('Live off');
  } finally {
    await llm.stop();
  }
});

test('an itinerary file that is not one says so, and starts nothing', async ({ page }) => {
  await openApp(page, '#/simulate');
  await page.getByLabel('An itinerary file').check();
  await page.getByLabel('Itinerary file', { exact: true }).setInputFiles({ name: 'trip.json', mimeType: 'application/json', buffer: Buffer.from('{"name": "Nowhere", "route": []}') });
  await page.getByRole('button', { name: 'Start the simulation' }).click();
  await expect(page.getByRole('alert')).toHaveText(/^An itinerary needs a start/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/ui-pure.test.js`
Expected: FAIL: `liveText` says `'Live · moving fast'`; `knownFix` gives null.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/after-simulate.spec.js`
Expected: FAIL in both browsers: no "Simulate a trip" link in Settings.

- [ ] **Step 3: Write the code**

In `src/ui/live-chip.js`:
- `knownFix(live, now = Date.now())` becomes `knownFix(live, now = live.clock?.now() ?? Date.now())`, its `live` type `{ on: boolean, gps: string, fix: any, clock?: { now: () => number } }`, with the note "by live mode's own clock: a simulation's, while one runs";
- `liveText` begins `if (live.simulating) return \`Simulation · ${DOING[live.activity] ?? 'on'}\`;` (its type gains `simulating?: boolean`);
- in `open()`, while `ctx.sim?.running`, the menu's items are, instead of the switch:
```js
      const sim = ctx.sim;
      const items = [
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); if (sim.state?.paused) sim.resume(); else sim.pause(); } }, sim.state?.paused ? 'Resume the simulation' : 'Pause the simulation'),
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); sim.stop(); } }, 'Stop the simulation'),
        h('a', { class: 'btn', href: '#/simulate', onclick: () => close() }, 'Simulate a trip'),
      ];
```
  (the rest of `open()` is for live mode as before), and `show()` also runs on `ctx.sim?.onChange(show)`.

In `src/ui/screens/now.js` and `src/ui/screens/drive.js`, every `Date.now()` that stands for "now" becomes `nowOf(live)`, with, in `now.js` (exported, and imported by `drive.js`):
```js
/** Now, by live mode's own clock: a simulation's while one runs (spec §13). @param {any} live */
export const nowOf = (live) => live?.clock?.now() ?? Date.now();
```
(`renderNow`'s `upcoming(rows, Date.now(), 4)` and `draw()`'s `now`; `renderDrive`'s `routeStrip(rows, here, Date.now(), …)`.)

`src/ui/screens/simulate.js`:
```js
import { h, field } from '../dom.js';
import { SPEEDS } from '../../core/live/sim-run.js';
import { listTrips } from '../../core/scopes.js';
import { answerJSON } from '../../core/answer.js';

const SAMPLE = '/assets/simulations/big-sur.json';
/** @type {Record<string, string>} */
const SPEED_WORDS = { 10: '10 times real time: an hour takes 6 minutes', 60: '60 times: an hour takes a minute', 600: '600 times: an hour takes 6 seconds', fast: 'As fast as it can go' };

/**
 * Settings → Developer → Simulate a trip (spec §13): a sample drive, an itinerary file or a trip's
 * recorded track, played through live mode and Shiori in a new trip of its own (7a choices 9–13).
 * While it runs this screen shows its clock and controls; afterwards, Replay it and Recap it.
 * @param {any} ctx
 */
export async function renderSimulate(ctx) {
  const sim = ctx.sim;
  const screen = h('div', { class: 'screen simulate' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Simulate a trip' }));
  if (!sim) return screen;
  const body = h('div', { class: 'screen' });
  screen.append(body);
  /** @type {any} */
  let timer = null;
  const draw = async () => {
    clearInterval(timer);
    if (!screen.isConnected && timer !== null) return;
    body.replaceChildren(...(sim.running ? running(ctx) : [...ended(ctx), await form(ctx)]));
    if (sim.running) {
      timer = setInterval(() => {
        if (!screen.isConnected) return clearInterval(timer);
        tickTime(ctx, body);
      }, 1000);
      tickTime(ctx, body);
    }
  };
  const off = sim.onChange(() => {
    if (!screen.isConnected) off();
    else draw();
  });
  await draw();
  return screen;
}

/** The simulated time and how far it has got. @param {any} ctx @param {HTMLElement} body */
function tickTime(ctx, body) {
  const s = ctx.sim.state;
  const now = ctx.sim.now();
  const time = body.querySelector('.sim-time');
  const bar = body.querySelector('progress');
  if (!s || now === null || !time || !bar) return;
  time.textContent = new Intl.DateTimeFormat(navigator.language || 'en-US', { timeZone: s.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  bar.value = Math.max(0, now - s.from);
}

/** While it runs (choice 10). @param {any} ctx */
function running(ctx) {
  const sim = ctx.sim;
  const s = sim.state;
  const speed = typeof s.speed === 'number'
    ? field('Speed', (() => {
      const sel = h('select', { id: 'sim-speed' }, ...SPEEDS.map((v) => h('option', { value: String(v), text: SPEED_WORDS[v] })));
      sel.value = String(s.speed);
      sel.addEventListener('change', () => sim.setSpeed(Number(sel.value)));
      return sel;
    })())
    : h('p', { class: 'sub', text: SPEED_WORDS.fast });
  const trip = `#/trip/${encodeURIComponent(s.trip)}`;
  return [
    h('h2', { class: 'section', text: s.title }),
    h('p', { class: 'sim-time now-place' }),
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'How far it has got' }), h('progress', { max: String(Math.max(1, s.to - s.from)), value: '0' })),
    speed,
    h('div', { class: 'acts' },
      h('button', { class: 'btn', type: 'button', onclick: () => (s.paused ? sim.resume() : sim.pause()) }, s.paused ? 'Resume' : 'Pause'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => sim.stop() }, 'Stop')),
    h('p', { class: 'sub', text: 'Watch it on Now, Driving and the Conversation; Shiori wakes as on the road. Opening another trip stops it.' }),
    h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/now' }, 'Now'), h('a', { class: 'btn', href: '#/drive' }, 'Driving'), h('a', { class: 'btn', href: '#/talk' }, 'Conversation'), h('a', { class: 'btn', href: trip }, 'The trip')),
  ];
}

/** After one ended: how, and where its trip is. @param {any} ctx */
function ended(ctx) {
  const s = ctx.sim.state;
  if (!s) return [];
  const trip = `#/trip/${encodeURIComponent(s.trip)}`;
  const how = s.error ? `The simulation stopped: ${s.error}` : s.stopped ? 'You stopped the simulation.' : 'The simulation has ended.';
  return [h('section', { class: 'panel', 'aria-label': 'The last simulation' },
    h('h2', { class: 'section', text: s.title }),
    h('p', { role: 'status', text: `${how} What it did is in its own trip.` }),
    h('div', { class: 'acts' },
      h('a', { class: 'btn pri', href: `${trip}/replay` }, 'Replay it'),
      h('a', { class: 'btn', href: `${trip}/recap` }, 'Recap it'),
      h('a', { class: 'btn', href: trip }, 'Open the trip')))];
}

/** Choosing a track and a speed (7a choices 12 and 13). @param {any} ctx */
async function form(ctx) {
  const { active, archived } = await listTrips(ctx.store);
  /** @type {{ id: string, title: string }[]} */
  const recorded = [];
  for (const t of [...active, ...archived]) {
    const two = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(t.id, { types: ['location'], limit: 2 }));
    if (two.length >= 2) recorded.push({ id: t.id, title: t.title });
  }
  const name = `sim-${Math.random().toString(36).slice(2)}`;
  const radio = (/** @type {string} */ value, /** @type {string} */ label, checked = false) => {
    const input = h('input', { type: 'radio', name, value });
    input.checked = checked;
    return { input, el: h('label', { class: 'check' }, input, h('span', { text: label })) };
  };
  const sample = radio('sample', 'Big Sur on Highway 1: a sample drive, about ten hours, with a plan and bookings', true);
  const fromTrip = radio('trip', 'The recorded track of a trip on this device');
  const fromFile = radio('file', 'An itinerary file');
  const trips = h('select', { id: 'sim-trip', disabled: !recorded.length }, ...(recorded.length ? recorded.map((t) => h('option', { value: t.id, text: t.title })) : [h('option', { value: '', text: 'No trip has a recorded track yet' })]));
  const file = h('input', { id: 'sim-file', type: 'file', accept: '.json,application/json' });
  const speed = h('select', { id: 'sim-speed-start' }, ...[...SPEEDS.map(String), 'fast'].map((v) => h('option', { value: v, text: SPEED_WORDS[v] })));
  speed.value = '10';
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const start = h('button', { class: 'btn pri', type: 'button' }, 'Start the simulation');
  start.addEventListener('click', async () => {
    error.hidden = true;
    start.disabled = true;
    try {
      /** @type {any} */
      let source;
      if (fromTrip.input.checked) {
        if (!trips.value) throw new Error('No trip on this device has a recorded track yet: live mode records one while it is on.');
        source = { kind: 'trip', trip: trips.value };
      } else if (fromFile.input.checked) {
        const f = file.files?.[0];
        if (!f) throw new Error('Choose an itinerary file first.');
        source = { kind: 'itinerary', itinerary: readItinerary(await f.text()) };
      } else {
        source = { kind: 'itinerary', itinerary: await answerJSON(await fetch(SAMPLE), 'annai') };
      }
      await ctx.sim.start(source, { speed: speed.value === 'fast' ? 'fast' : Number(speed.value) });
    } catch (e) {
      error.textContent = String(/** @type {any} */ (e)?.message ?? e);
      error.hidden = false;
      start.disabled = false;
    }
  });
  const main = (await ctx.llm?.config().catch(() => null))?.roles?.main?.models ?? [];
  return h('section', { class: 'panel', 'aria-label': 'A new simulation' },
    h('p', { class: 'sub', text: 'A recorded or made-up GPS track, and its clock, run through live mode and Shiori as on a real trip, in a new trip of its own: then replay it and recap it.' }),
    h('p', { class: 'sub', text: main.length
      ? 'Shiori wakes with your own models, as she would on the road: the sample wakes her about 24 times. A scripted model (Settings → Models) makes it free.'
      : "No model is set up, so Shiori can't answer: annai shows the reminders itself." }),
    h('fieldset', { class: 'radios' }, h('legend', { text: 'The track' }), sample.el, fromTrip.el, field('Trip', trips), fromFile.el, field('Itinerary file', file)),
    field('Speed', speed),
    error,
    h('div', { class: 'acts' }, start));
}

/** An itinerary file's text, as an itinerary, or a plain error. @param {string} text */
function readItinerary(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {
    // said below
  }
  throw new Error("That file isn't an itinerary annai can read: it needs to be JSON like the Big Sur sample (a start, a route of places, and times).");
}
```

In `src/ui/screens/settings.js`, before the Diagnostics section:
```js
    section('Developer',
      h('p', { class: 'sub', text: 'Try live mode, the replay and the recap with a simulated trip.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/simulate' }, 'Simulate a trip'))),
```

In `src/ui/shell.js`, import `renderSimulate`; `SCREENS` gains `simulate: renderSimulate`; the section for the top bar becomes `route.name === 'simulate' ? 'settings' : …` before the others; the core type gains `sim?: any`.

In `src/app/main.js`, import `SimRun` from `../core/live/sim-run.js`, and after the Live engine:
```js
  // Developer → Simulate a trip (spec §13): one at a time, shared by its screen and the live chip.
  const sim = new SimRun({ store, ws, registry, agent, live });
```
and pass `sim` to `startShell`.

Append to `src/ui/base.css`:
```css
/* Simulate a trip (spec §13) */
.simulate progress { width: 100%; height: 12px; accent-color: var(--ai); }
.sim-time { font-family: var(--f-mono); }
```

In `sw.js`, add `'/src/ui/screens/simulate.js',` to `SHELL`.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/ui-pure.test.js`
Expected: PASS.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/after-simulate.spec.js test/e2e/live.spec.js test/e2e/now.spec.js test/e2e/drive.spec.js`
Expected: all pass in both browsers. Delete any `core*` file.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/ui/screens/simulate.js src/ui/screens/settings.js src/ui/live-chip.js src/ui/screens/now.js src/ui/screens/drive.js src/ui/shell.js src/app/main.js src/ui/base.css sw.js test/unit/ui-pure.test.js test/e2e/after-simulate.spec.js && git commit -m "Settings → Developer → Simulate a trip: the Big Sur sample, an itinerary file or a trip's recorded track, at 10, 60 or 600 times real time or as fast as it can go; the live chip says a simulation runs and pauses or stops it; Now and Driving follow its clock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 5: Done when, end to end; the device checklist; the README

**Files:**
- Modify: `test/e2e/after-simulate.spec.js` (the "Done when"), `README.md`, `scripts/size.mjs`
- Create: `docs/testing/device-checklist-m7.md`
- Test: `test/e2e/after-simulate.spec.js`; then the whole e2e suite in both browsers

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new in code.

- [ ] **Step 1: Write the failing test**

Add to `test/e2e/after-simulate.spec.js`:
```js
const RECAP = '# Big Sur on Highway 1\n\n## Friday, November 27\n\nFrom Monterey down the coast: Bixby Bridge, lunch at Nepenthe, McWay Falls, and the castle at San Simeon.\n\n## Highlights\n\n- Lunch at Nepenthe';

test('the Big Sur trip, simulated through the app, is replayed and recapped, and its card has its stamps (spec §20, milestone 7)', async ({ page }) => {
  test.setTimeout(300_000);
  const card = { title: 'Highway 1 today', text: 'Fog until ten, then sun all the way to Cambria.' };
  const llm = await startModelServer({
    '/b/v1/messages': [sse(anthropicToolReply([{ name: 'show', input: { card } }, sleep])), sse(anthropicToolReply([sleep]))],
    '/u/v1/messages': sse(anthropicToolReply([], RECAP)),
  });
  try {
    await mainModel(page, llm.origin);
    await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Writer', url: `${llm.origin}/u`, key: 'sk-test-u', model: 'u-model' });
    await page.getByLabel('Add a model to utility').selectOption({ label: 'u-model' });
    await page.getByRole('button', { name: 'Add to utility' }).click();
    await page.goto('/#/simulate');
    await page.getByLabel('Speed').selectOption('fast');
    await page.getByRole('button', { name: 'Start the simulation' }).click();
    await expect(page.getByText('The simulation has ended.')).toBeVisible({ timeout: 240_000 });

    // Replay: the timeline, the route and the stamps.
    await page.getByRole('link', { name: 'Replay it' }).click();
    await expect(page.getByRole('heading', { name: 'Replay' })).toBeVisible();
    const timeline = page.getByRole('list', { name: 'Timeline' });
    for (const place of ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']) await expect(timeline).toContainText(`${place} · `);
    await expect(timeline).toContainText('Shiori: Highway 1 today');
    await expect(timeline).toContainText('partly unseen: the phone was locked');
    await expect(page.getByRole('img', { name: '5 stamps: Bixby Creek Bridge, Nepenthe, McWay Falls, Hearst Castle, Cambria Pines Lodge' }).first()).toBeVisible();
    await expect(page.getByRole('img', { name: /^The route: \d+\.\d km on the road, from Bixby Creek Bridge to Cambria Pines Lodge, with \d+ stops and 5 stamps\.$/ })).toBeVisible();
    expect((await page.locator('svg.route-map polyline.route-all').first().getAttribute('points'))?.split(' ').length).toBeGreaterThan(200);
    await page.getByLabel('Time in the trip').fill(String(Date.parse('2026-11-27T12:30:00-08:00')));
    await expect(page.locator('.replay-where')).toHaveText('At Nepenthe');
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.locator('.replay-where')).not.toHaveText('At Nepenthe', { timeout: 20_000 });
    await page.getByRole('button', { name: 'Pause' }).click();

    // Recap: by the utility model, from the trip in words.
    await page.goto('/#/simulate');
    await page.getByRole('link', { name: 'Recap it' }).click();
    await page.getByRole('button', { name: 'Write the recap' }).click();
    await expect(page.locator('.recap-text')).toContainText('lunch at Nepenthe', { timeout: 20_000 });
    const sent = JSON.stringify(llm.bodies('/u/v1/messages').at(-1));
    expect(sent).toContain('stayed\\tNepenthe');
    expect(sent).toMatch(/worked out from \d{4} location points/);
    expect(sent.length).toBeLessThan(40_000);

    // The trip card.
    await page.goto('/#/trips');
    await expect(page.getByRole('link', { name: /\(simulation\)/ })).toContainText('5 stamps');
  } finally {
    await llm.stop();
  }
});
```

- [ ] **Step 2: Run it**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/after-simulate.spec.js`
Expected: the new test PASSES in both browsers (Tasks 1–4 built what it checks; this is the milestone's acceptance). If it doesn't, the failure is a finding: systematic-debugging, fix, and ledger it.

- [ ] **Step 3: Write the checklist, the README and the budget**

`docs/testing/device-checklist-m7.md`:
```markdown
# Device checklist: milestone 7 (after the trip)

After the real Thanksgiving trip (Nov 25–29), on an iPhone and an Android phone, with annai
installed to the Home Screen. Milestone 7's "Done when" is "The Thanksgiving trip can be replayed
and recapped": this is that. Note the times each step takes on each phone, and anything that reads
wrong.

## Before: a simulated trip, from Developer
- [ ] Settings → Developer → Simulate a trip → Big Sur sample, 600 times. The live chip says "Simulation · …"; Now and Driving follow the simulated day (Now hands over to Driving when the drive begins); Shiori wakes (Trace → Live).
- [ ] Pause, then Resume from the live chip; change the speed on the screen. Stop it. The chip says "Live off", and live mode is as you left it (on or off).
- [ ] Simulate it again as fast as it can go: it ends in about a minute. Replay it and Recap it from the screen. Remove that trip afterwards (Trips → it → Remove trip).
- [ ] With a trip of your own that has a recorded track (a local drive from milestone 5), simulate "The recorded track of a trip on this device": the replay of the new trip looks like the drive did.

## Stamps
- [ ] Trips: the Thanksgiving trip's card shows "N stamps" and the first two marks and "+N". The marks read as station stamps, a little crooked, in both light and dark mode.
- [ ] Each stamp is a place you arrived at: the plan's stops, and named places off the plan where the offline pack knew them. Note any you expected and didn't get, and any you didn't expect.
- [ ] VoiceOver / TalkBack on the card: it says "N stamps:" and the places' names.

## Recap
- [ ] The trip → Recap → Write the recap. It takes about a minute (note how long on each phone). The text has a section for each day, in order, and names the places you were.
- [ ] Open "What goes to …": it matches what the trace shows was sent (Trace → Models: the recap call; no GPS track in it).
- [ ] Write it again: the new one replaces it; Edit → the file's history has the old one.
- [ ] Hear Shiori tell it, with voice off and in a quiet room: she reads it aloud, a few sentences at a time, then listens. Interrupt her by tapping her. Try it again in the car over Bluetooth.

## Replay, on both phones
- [ ] The trip → Replay opens within a few seconds even with five days of points (time it). The day tabs show each day; the whole trip shows the whole road.
- [ ] The map shows the road you drove, north up, with dashed lines where the phone was locked or you flew; stops as rings, stamps as vermilion rings.
- [ ] Play at each speed: the dot follows the road and the vermilion line grows behind it; "At this moment" says where you were, the stamps so far, and the latest card, words or photo. It stops at the end; Play again starts over.
- [ ] Drag the scrubber with a finger: the dot and the panel follow; it doesn't fight your finger while playing.
- [ ] Tap entries in the timeline: the playback jumps there. Tap a photo entry: the photo shows; Open full size opens the viewer, with pinch zoom.
- [ ] Leave the replay while it plays and come back: nothing keeps running (the phone doesn't warm up).
- [ ] VoiceOver / TalkBack: the map is announced as "The route: … km on the road, from … to …"; the scrubber says the time and where you were; the timeline reads in order; while it plays, each new place is announced once.

## Afterwards
- [ ] Export the trip as a Backup and import it on the other phone: the recap, the replay and the stamps are the same there.
```

In `README.md`, the status line gains, after the offline pack's sentence: "And after the trip (milestone 7): stamps for the places you arrived at, shown on trip cards; a recap written by your utility model from the trip, which Shiori can tell aloud; a replay of the timeline and the route on a flat map; and Settings → Developer → Simulate a trip." Add a section after "Voice":
```markdown
## After the trip

- Stamps: each place you arrived at on the plan, or a named place the offline pack knows, earns a station stamp, shown on the trip's card. They come from the trip's log; nothing extra is stored.
- Recap: your utility model writes `/trip/recap.md` from where you stayed and went (in words: never the GPS track itself), the stamps, what you and Shiori said, your notes and up to six photos. Shiori can tell it aloud.
- Replay: the trip's timeline, the route drawn on a flat map with no map tiles, playback at a minute, ten minutes or an hour a second, a scrubber, and a day at a time.
- Settings → Developer → Simulate a trip: the Big Sur sample, an itinerary file, or a trip's recorded track, played through live mode and Shiori in a new trip of its own, so the replay and the recap can be tried before a real trip.
```

In `scripts/size.mjs`, run `npm run size`, and set `BUDGET` to the next 10 KiB above what it prints plus 10 KiB of room, with the comment's history gaining "; N for milestone 7 (after the trip)".

- [ ] **Step 4: Run everything**

Run: `npm run stamp && npm run check`
Expected: pass; note the test count.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test > .superpowers/e2e.txt 2>&1; tail -30 .superpowers/e2e.txt`
Expected: every test passes in Chromium and WebKit. Delete any `core*` file.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add test/e2e/after-simulate.spec.js docs/testing/device-checklist-m7.md README.md scripts/size.mjs && git commit -m "Done when, end to end: the Big Sur sample simulated through the app is replayed and recapped in both browsers, and its card has its five stamps; the device checklist for after the Thanksgiving trip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
