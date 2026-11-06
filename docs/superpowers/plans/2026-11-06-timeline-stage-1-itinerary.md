# Timeline stage 1, Itinerary: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Plan screen is called the Itinerary, its today tab opens with where you are, the sun chips, plugins' Now slots and Driving, and Driving takes over from more screens than Now.

**Architecture:** One new module, `src/ui/today.js`, holds what Now and the Itinerary share until Now goes in stage 8. The handover leaves `renderNow` and becomes one listener in the shell. Nothing stored changes.

**Tech Stack:** Native ES modules, no build step, JSDoc checked by `tsc`, `node:test`, Playwright e2e in Docker (Chromium Pixel 7, WebKit iPhone 15).

**Spec:** `docs/superpowers/specs/2026-11-04-timeline-home-design.md`: sections Words, Plugins, The conversation (Itinerary), GPS voice and watches (Driving), Decided by the user ("Driving takes over, once"). Read it first.

## Global Constraints

- Browser-only, local-first PWA. iPhone Safari is the main target. No new dependency.
- Work in `/mnt/optane/work/annai-timeline`, branch `timeline`. No push, no merge. Never `git stash`. Stage files by name. Delete with `/bin/rm -f`, move with `command mv -f`.
- Never read `/var/lib/private/annai-trace/`, `/root/annai-test-keys/` or any secret file. The repo is public: fixtures use the existing test names (Testville, Hotel Aurora Test, ANNAI AIR AN 123).
- Display only: files, tools, routes, CSS classes and model text keep `plan`.
- New user-facing words: `npm run strings`, fill each `new` row in `l10n/{ja,zh-Hans,zh-Hant}.tsv`, set it to `draft`, `npm run strings` again, then `npm run strings -- --check`. Read `docs/translating.md` first.
- After a change to a shipped file (`src/`, `index.html`, `sw.js`): `npm run stamp`.
- Size: `scripts/size.mjs` line 4 is a 58 KB line, never print it. It stands at 2988.3 of 2989 KiB. **This stage expects +2 KiB.** Raise `BUDGET` in whole KiB by what the build needs, with the reason appended to the comment. Comments count.
- Top-bar tests stay green until stage 8, apart from the word.
- The handoff ends with Calls to confirm: the size raise, each changed behaviour, each call of your own, and this plan's calls below.

**Commands**
- Unit: `NODE_OPTIONS=--max-old-space-size=2048 timeout 600 systemd-run --scope -q -p MemoryMax=4G node --test --test-timeout=120000 --import ./test/unit/pin-phone.js test/unit/<file>.test.js`
- All: `systemd-run --scope --collect -q -p MemoryMax=8G -p MemorySwapMax=0 -- npm run check`
- E2e: `docker run --rm --memory=6g --ipc=host -v "$PWD":"$PWD" -v /mnt/optane/work/annai/node_modules:/mnt/optane/work/annai/node_modules:ro -w "$PWD" mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test <specs…> --workers=2`

**Where the code moved past the spec**
- The spec moves Now's helpers into `plan.js` and `drive.js`, but Now stays until stage 8 while the top bar is there. So they go to a shared `today.js` now, and stage 8 only deletes `renderNow`.
- `typing()` in `shell.js` looks only inside `main`. The dock's box is outside it, so "not while typing" needs its own check.
- `drive.js` reads `agent.trip`. With nothing open there is no road to show, so until stage 2's `live.play` the take-over needs a trip open.

**This plan's calls**
- Every display noun for this thing becomes Itinerary, not only the screen's name: one word per concept, and the glossary row is one concept. Verbs stay ("Ask Shiori to plan with you").
- The e2e lines naming the word change here, not in stage 8.
- Typing when moving fast begins skips the take-over for that drive, with no retry: "once".
- A reload during a drive may take over once, on the screens above: the activity comes back from the drive record after the shell starts, and that reads as a change. Driving is the right screen then, so no extra state guards it.
- `handover` stays a pure function in `today.js`, with only the listener in `shell.js`, which unit tests can't import.
- `now-card` and `ui:now-section` draw on both Now and the Itinerary's today until stage 8. The screens never show together.

## Review Focus

1. **Typing in the dock as moving fast begins:** the box and its words stay. Test in Task 3 (`typing: true`), computed from `document.activeElement`, not from `typing()`.
2. **Back on a screen during the drive:** the next fixes don't pull you into Driving again. Test in Task 3 (`activity === was`), and the existing B2 block in `drive.spec.js` stays green.
3. **Today's tab left and come back to:** the top keeps updating. A node taken out of the page ends `live.onChange` listeners, so it is hidden, not removed. Test in Task 2.
4. **A plugin's Now card that fails on the Itinerary:** annai's own top is drawn and the day tabs still work. Test in Task 2.
5. **A trip with no tab for today, or a simulation:** no top on a past or future trip, and in a simulation "today" is the simulation's. Test in Task 2.

---

### Task 1: The word

**Files:**
- Modify: `src/ui/shell.js:63`, `src/ui/screens/plan.js`, `trip.js:43`, `now.js:84`, `file.js:24-26`, `booking.js:58,80,100,166`, `item.js:24-25,36`, `offline-pack.js`, `notifications.js`, `file-delete.js`, `format.js:132`, `drive.js:34,90`, `simulate.js:123`, `export-panel.js:40`, `credits.js:19`, `welcome.js:68`, `import.js:324`, `trip.js:232`
- Modify: `l10n/glossary.tsv` (row `Plan`), `l10n/glossary.md`, `docs/translating.md` if it names the word, `l10n/*.tsv`
- Test: `test/e2e/plan.spec.js`, `phone-fixes.spec.js`, `phone-fit.spec.js`, `file-details.spec.js`, `evening.spec.js`, `trips.spec.js`

- [ ] **Step 1: Change the e2e lines first**

`grep -rn "'Plan'\|Plan'" test/e2e` names them: 9 top-bar links, the headings, the crumbs and `tab()` checks. `name: 'Plan'` becomes `name: 'Itinerary'`, and `toHaveText('Plan')` becomes `toHaveText('Itinerary')`.

- [ ] **Step 2: Change the words**

The rule: the noun for this thing becomes `Itinerary`/`itinerary`, a verb stays, `/* en */` stays. Find the rest with `grep -rnE "t\`[^\`]*\b[Pp]lan\b" src/ui`. `"The whole plan"` becomes `"The whole itinerary"`, `"Open a trip to see its plan."` becomes `"Open a trip to see its itinerary."`, `"# plan item"` becomes `"# itinerary item"`. Keep `"Plan the trip day by day…"` and `"Ask Shiori to plan with you"`.

- [ ] **Step 3: Glossary and strings**

`l10n/glossary.tsv`: `Plan screen 予定 行程 行程` becomes `Itinerary screen 旅程 行程 行程`. In new rows, ja uses 旅程 for the noun; zh-Hans and zh-Hant keep 行程. Run the strings steps from Global Constraints.

- [ ] **Step 4: Run and commit**

Run: e2e on the six specs, `npm run strings -- --check`, `npm run stamp`. Expected: PASS.

```bash
git commit -m "Itinerary: the Plan screen's new name, in every display noun"
```

### Task 2: Today's top, shared

**Files:**
- Create: `src/ui/today.js`
- Modify: `src/ui/screens/now.js`, `plan.js:38-50,64-74`, `drive.js` (imports), `docs/plugins.md:169,185-193`
- Test: `test/unit/now.test.js`, `test/unit/ui-pure.test.js` (imports), `test/e2e/plan.spec.js`, `test/e2e/ui-extension.spec.js`

**Interfaces:**
- Produces, in `src/ui/today.js`: `nowOf(live) -> number` and `whereWords(live) -> string` (moved unchanged); `handover(activity, was, screens) -> string | null` (moved unchanged); `todayTop(ctx, { title: string, rows: PlanRow[], tz: string }) -> HTMLElement[]`, the `.now-card` block then one `section.now-section` per plugin, keeping itself current through `live.onChange` until its nodes leave the page.
- `now.js` keeps `planRowOf`, `latestCard`, `eventCard`, which `plan.js` and `drive.js` still import from it. Stage 8 moves them.

- [ ] **Step 1: Write the failing e2e tests in `plan.spec.js`**

```js
test("today's tab of a trip happening now starts with where you are and Driving; another day's doesn't", async ({ page }) => {
  // trip from yesterday to tomorrow by the test's own clock, one plan item today
  await expect(page.locator('.today-top .now-place')).toBeVisible();
  await expect(page.locator('.today-top').getByRole('link', { name: 'Driving' })).toBeVisible();
  await page.getByRole('tab').first().click();             // yesterday
  await expect(page.locator('.today-top')).toBeHidden();
  await page.getByRole('tab').nth(1).click();              // back on today
  await expect(page.locator('.today-top .now-place')).toBeVisible();
});

test('a trip that ended has no today top', async ({ page }) => {
  await expect(page.locator('.today-top')).toHaveCount(0);
});
```

In `ui-extension.spec.js`, beside its `now-card` test: the same plugin's card shows on the Itinerary's today with `{ title, place, chips, liveOn }`; one whose `render` throws leaves `.now-place` drawn and the day tabs working. `ui:now-section` shows there too.

- [ ] **Step 2: Run them**

Expected: FAIL, `.today-top` not found.

- [ ] **Step 3: Move the shared parts**

Create `today.js`. `todayTop` is lines 33-44 and 62-77 of today's `renderNow` with the handover left out. Keep the failing-card path (`onFail`) and the `isConnected` stop. `renderNow` calls it; its Next, Latest, pack line and Driving stay. Update imports in `plan.js`, `drive.js` and the two unit tests.

- [ ] **Step 4: Draw it in `renderPlan`**

`today` becomes `dayIn(nowOf(ctx.live), ctx.live?.timeZone?.() ?? deviceZone())`, so a simulation's day counts. Only when `tabs.some((x) => x.key === today)`, build `const top = h('div', { class: 'today-top' }, ...todayTop(ctx, { title: scope.title, rows, tz: fallbackTz }), driving)`, and put it after the tablist, before `panel`. `show(tab)` sets `top.hidden = tab.key !== today`. `driving` is the `#/drive` link, shown only when `id === ctx.agent?.trip`, because Driving shows the open trip until stage 2.

- [ ] **Step 5: `docs/plugins.md`**

`now-card` and `ui:now-section`: "drawn at the top of the Itinerary's today too, with the same arguments".

- [ ] **Step 6: Run and commit**

Run: `now.test.js`, `ui-pure.test.js`, e2e `plan.spec.js`, `now.spec.js`, `ui-extension.spec.js`. Expected: PASS.

```bash
git commit -m "Itinerary: today's tab opens with where you are, the plugins' Now slots and Driving"
```

### Task 3: Driving takes over from the shell

**Files:**
- Modify: `src/ui/today.js`, `src/ui/shell.js`, `src/ui/screens/now.js:45-57`, `src/ui/screens/drive.js:127`
- Test: `test/unit/now.test.js`, `test/e2e/drive.spec.js`

**Interfaces:**
- Consumes: `handover` (Task 2).
- Produces: `takeover({ activity, was, screens, on, hash, typing, trip }) -> string | null` in `today.js`; `ctx.drivingFrom: string | undefined`, the address Driving was entered from.

- [ ] **Step 1: Write the failing test**

```js
const go = { activity: 'moving-fast', was: 'walking', screens: [], on: true, hash: '#/trips', typing: false, trip: 'trip-a' };
test('moving fast begins: Driving takes over from home, the conversation, the Itinerary and Now', () => {
  for (const hash of ['#/trips', '#/talk', '#/plan', '#/trip/trip-a/plan', '#/now']) assert.equal(takeover({ ...go, hash }), '#/drive');
});
test('it stays put elsewhere, while typing, with GPS off, and with nothing open', () => {
  for (const o of [{ hash: '#/settings' }, { hash: '#/trip/trip-a' }, { typing: true }, { on: false }, { trip: null }]) assert.equal(takeover({ ...go, ...o }), null);
});
test('once: a drive already going takes nobody over', () => {
  assert.equal(takeover({ ...go, was: 'moving-fast' }), null);
});
test("a plugin's screen for the activity takes over, with no trip open too", () => {
  const screens = [{ pluginId: 'p', item: { id: 's', homeFor: 'walking' } }];
  assert.equal(takeover({ ...go, activity: 'walking', was: 'still', screens, trip: null }), '#/ext/p/s');
});
```

- [ ] **Step 2: Run it**

Expected: FAIL, `takeover` is not exported.

- [ ] **Step 3: Implement**

`takeover` parses `hash` with `parseHash` and allows the route names `trips`, `talk`, `plan`, `now`. `#/drive` also needs `trip`; a plugin's screen doesn't. In `startShell`, once, after the first `render`:

```js
let was = core.live?.activity;
core.live?.onChange(() => {
  const to = takeover({ activity: core.live.activity, was, screens: slotEntries(ctx, 'ui:screen'), on: core.live.on, hash: location.hash, typing: Boolean(document.activeElement?.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=file])')), trip: core.agent?.trip ?? null });
  was = core.live.activity;
  if (to) { /** @type {any} */ (ctx).drivingFrom = location.hash; ctx.go(to); }
});
```

Remove the handover from `renderNow`; its `onChange` keeps only the draw. ← returns: `drive.js`'s crumb goes to `ctx.drivingFrom ?? '#/now'`, labelled `t\`Now\`` when that is `#/now`, else `t\`Back\``.

- [ ] **Step 4: E2e**

In `drive.spec.js`, beside the Now test: moving fast begun on `#/trips` and on the conversation shows Driving, and the crumb returns there and stays through the next fixes. With the dock's box focused, no take-over.

- [ ] **Step 5: Run and commit**

Run: `now.test.js`, e2e `drive.spec.js`, `now.spec.js`, then all, then e2e whole. Raise the budget by what `npm run size` says. Expected: PASS.

```bash
git commit -m "Driving takes over once from home, the conversation and the Itinerary, from the shell"
```
