# Timeline stage 3, Conversation address: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each conversation has its own address, `#/trip/<id>/talk`, with a header (←, name, ⋯), a Next line, the Itinerary as a sheet, Details as the trip's page, and notifications that open the right conversation.

**Architecture:** The router gains `talk`. One helper opens a conversation from an address, and only on a move, never on a redraw. `#/talk` and `#/plan` stay accepted and redirect while a trip is open. The top bar is still there.

**Tech Stack:** Native ES modules, no build step, JSDoc checked by `tsc`, `node:test`, Playwright e2e in Docker.

**Spec:** `docs/superpowers/specs/2026-11-04-timeline-home-design.md`: sections The conversation, Notifications imports exports (the `sw.js` part). Read it first.

## Global Constraints

- Work in `/mnt/optane/work/annai-timeline`, branch `timeline`. No push, no merge. Never `git stash`. Stage files by name. Delete with `/bin/rm -f`, move with `command mv -f`.
- Never read `/var/lib/private/annai-trace/`, `/root/annai-test-keys/` or any secret file. Fixtures use the repo's test names.
- Only `talk`, `plan` and Details open a conversation, because `open` stops a turn and closes voice.
- Redirects use `location.replace`, or Back traps.
- A route is an API: its lessons entry goes in the same commit.
- Top-bar tests stay green until stage 8. `live.js`, `activity.js` and the drive logic aren't touched.
- New user-facing words get `draft` rows (`npm run strings`, fill, `npm run strings`, `npm run strings -- --check`). After a change to a shipped file: `npm run stamp`.
- Size: never print `scripts/size.mjs` line 4. **This stage expects +6 KiB.** Raise `BUDGET` in whole KiB by what the build needs, with the reason appended.
- The handoff ends with Calls to confirm.

**Commands:** as in the stage 1 plan (unit, all, e2e).

**Where the code moved past the spec**
- The spec's count of `#/talk` e2e lines is 68; it is 64 now. `toHaveURL` names it once (`file-details.spec.js:185`).
- `#/talk` with nothing open still shows the no-trip conversation until stage 7, and `#/plan` its empty state. e2e expects both. So they redirect only while a trip is open.
- `#/now` stays a screen until stage 8: the Now tab is there.
- The spec leaves `went` to the moving stage, but it bites here. `renderTrip` opens on every draw, and a redraw of `#/trip/A/talk` after `openWhenDone(B)` would open A again. `agent.open` is no no-op either: with the same target it still closes the ear and halts a turn (`loop.js:617`). So opening needs the move rule below now.
- Details has no way to change the name or dates today, only All files. The spec's "the user renames in Details" needs a form.
- `keepNews` and `onPushMessage` carry no scope, so an open window needs its own message.
- `file.js`, `dock.js`, `composer.js` and `talk.js` test `location.hash.startsWith('#/talk')`, which the new address fails.

**This plan's calls**
- A hidden `<h1 class="visually-hidden">Conversation</h1>` stays until stage 8, so 32 e2e lines stay green. Playwright counts a 1px box as visible; check on the first test you run.
- `SECTION` gains `talk: 'talk'`, so the tab stays lit on the new address.
- Details keeps its Itinerary button: with no rows the Next line isn't there, and nothing else reaches the screen.
- Details' crumb goes to the conversation, and the Itinerary's too.
- The Next line redraws itself when its row's time passes (one timer), as `live.onChange` may never fire with GPS off.

## Review Focus

1. **A redraw on an old address after the agent moved** (a hand-over, Undo, `went`): the old conversation is not opened again, and a running turn isn't stopped. Test in Task 1.
2. **Back through a redirect:** `#/talk` then Back doesn't land on `#/talk` again and bounce. Test in Task 1.
3. **An address whose trip is gone** (removed here, an old notification, a bookmark): home, and Back doesn't return to it. Test in Task 1.
4. **A notification with a hostile or old payload:** `me`, `trip-../x`, `TRIP-A`, nothing, `trip-a/../..`: home. Test in Task 5.
5. **Clearing the dates in Details:** a blank field sends `null`, never `''`, which the schema refuses. End before start says so. A blank name says so. Test in Task 4.

---

### Task 1: The address

**Files:**
- Modify: `src/ui/router.js`, `src/ui/format.js`, `src/ui/shell.js`, `src/ui/screens/trip.js:28-31`, `talk.js:625`, `plan.js`, `file.js:227`, `src/ui/dock.js:98,162`, `src/ui/composer.js:91,214`
- Create: `src/ui/open-trip.js`
- Modify: `docs/lessons-full.md`, `docs/lessons.md`
- Test: `test/unit/ui-pure.test.js` (with the other `parseHash` tests), `test/e2e/trips.spec.js`, `test/e2e/file-details.spec.js:185`

**Interfaces:**
- Produces: `talkHref(id: string) -> string` in `format.js`; `redirectOf(route, target: string | null) -> string | null` in `router.js`; `route.moved: boolean`, set by `render`; `openTrip(ctx, id: string, route) -> Promise<boolean>` in `open-trip.js`; `toTalk(ctx) -> void`, going to the open conversation unless already there.

- [ ] **Step 1: Write the failing tests**

```js
test('the conversation has an address', () => {
  assert.equal(parseHash('#/trip/trip-a/talk').name, 'talk');
  assert.deepEqual(parseHash('#/trip/trip-a/talk').parts, ['trip', 'trip-a', 'talk']);
});
test('#/talk and #/plan redirect only while a trip is open', () => {
  assert.equal(redirectOf(parseHash('#/talk'), 'trip-a'), '#/trip/trip-a/talk');
  assert.equal(redirectOf(parseHash('#/plan'), 'trip-a'), '#/trip/trip-a/plan');
  assert.equal(redirectOf(parseHash('#/talk'), null), null);
  assert.equal(redirectOf(parseHash('#/plan'), null), null);
  assert.equal(redirectOf(parseHash('#/trip/trip-b/talk'), 'trip-a'), null);
});
```

E2e, in `trips.spec.js`:

```js
test('Back from a conversation reached by #/talk goes to where you came from', async ({ page }) => {});
test('an address whose trip is gone goes home, and Back does not return to it', async ({ page }) => {});
test('opening #/trip/<b>/talk with a turn running in a stops it; a redraw of a trip screen after Shiori moved on opens nothing', async ({ page }) => {});
test('a reload on #/trip/<id>/talk shows that conversation, not the last one active', async ({ page }) => {});
```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement**

- `SUB` gains `talk: 'talk'`. `SECTION` gains `talk: 'talk'`.
- `render()`, before anything is drawn: `const to = redirectOf(route, core.agent?.target ?? null); if (to) return void location.replace(to);`. Then `route.moved = Boolean(o.moved)`. On a redraw (not moved) of a `talk` route whose trip isn't `agent.target`, `location.replace(talkHref(target))`: this is what makes `went` and Undo land right.
- `openTrip(ctx, id, route)`: reads the scope. Not there, or not a trip: `location.replace('#/trips')`, returns false. Else, only when `route.moved && ctx.agent && ctx.agent.target !== id`: `updateAppSettings(ctx.ws, { activeTrip: id })`, `ctx.agent.open(id)`. `renderTrip`, `renderTalk` (for a `trip` route) and `renderPlan` (for a `trip` route) call it first and return an empty `div.screen` on false. This replaces `renderTrip`'s lines 28-31 and its "isn't on this device" page, and the e2e that asserts that page changes.
- `renderTalk`: awaits `ctx.agent.opening` as today, so a cold start's `activeTrip` open doesn't race the route's.
- `toTalk` replaces every `location.hash.startsWith('#/talk')` check and `ctx.go('#/talk')` in `dock.js`, `composer.js`, `file.js` and `talk.js`.
- `file-details.spec.js:185`: `/\/talk$/`. `cameFrom` needs no change: `talk` is in `BACK`.

- [ ] **Step 4: Lessons, in this commit**

`## 2026-11-06 The conversation has its own address`: `#/talk` named no conversation, so phone Back could show another one.

- [ ] **Step 5: Run and commit.** Run: `ui-pure.test.js`, `resume.test.js`, e2e `trips.spec.js`, `conversation-menu.spec.js`, `conversation-lines.spec.js`. Expected: PASS. `git commit -m "Conversations get their own address; only a move opens one"`.

### Task 2: Header and Next line

**Files:**
- Modify: `src/ui/screens/talk.js` (the `title-row`), `src/ui/shiori.css`
- Test: `test/e2e/conversation-menu.spec.js`

**Interfaces:**
- Consumes: `upcoming(rows, now, limit)` from `core/now.js`, `tripRows(ctx, id)`, `nowOf`, `talkHref`.
- Produces: `nextLine(ctx, id) -> Promise<HTMLElement | null>` in `talk.js`.

- [ ] **Step 1: Write the failing e2e tests**

```js
test('the header: ← goes home, the name goes to Details, the ⋯ is there', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1, name: 'Conversation' })).toBeVisible(); // hidden, for stage 8
});
test('a trip with plan rows shows "Next: 13:00 Lunch", which opens the Itinerary; none, no line', async ({ page }) => {});
test('the header stays in view as the conversation scrolls', async ({ page }) => {});
```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement**

With a trip open: `h('div', { class: 'talk-head' }, back, name, tidy.el, tidy.status)`, sticky under `--topbar-h`. `back` is `a[href="#/trips"]` with `aria-label` t`Back to Trips`, and never calls `open`. `name` is a link to `#/trip/<id>` with `dir: 'auto'`. With nothing open, today's row stays until stage 7. `nextLine`: the first of `upcoming(rows, nowOf(ctx.live), 1)`, as t`Next: ${time} ${name}`, linking to `#/trip/<id>/plan`; null with no rows. One `setTimeout` to the row's time redraws it, cleared when it leaves the page.

- [ ] **Step 4: Run and commit.** Expected: PASS. `git commit -m "Conversation: a sticky header and the Next line"`.

### Task 3: The Itinerary as a sheet

**Files:**
- Modify: `src/ui/screens/plan.js`, `src/ui/shiori.css`
- Test: `test/e2e/plan.spec.js`

- [ ] **Step 1: Write the failing e2e tests**

```js
test('the Itinerary opens over the conversation: phone Back closes it, the dock stays', async ({ page }) => {
  await page.getByRole('link', { name: /^Next:/ }).click();
  await expect(page.locator('.screen.sheet')).toBeVisible();
  await expect(page.locator('nav.dock')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/talk$/);
});
test('#/trip/<id>/plan of another trip opens that conversation', async ({ page }) => {});
```

- [ ] **Step 2: Implement**

`renderPlan` calls `openTrip` for a `trip` route. A trip route's screen gets the class `sheet`: a rounded top edge and a drawn-up look. The spec's call stands: a screen drawn as a sheet, not a true overlay. Its crumb goes to `talkHref(id)`. A row's `from` stays `here`.

- [ ] **Step 3: Run and commit.** Expected: PASS. `git commit -m "The Itinerary, drawn as a sheet with a history entry of its own"`.

### Task 4: Details

**Files:**
- Modify: `src/ui/screens/trip.js`
- Test: `test/e2e/trips.spec.js`, `after-recap.spec.js` and `after-replay.spec.js` (their fixtures gain dates if they lack them)

- [ ] **Step 1: Write the failing e2e tests**

```js
test('Details changes the name and the dates; a cleared date goes, a backward range and a blank name say why', async ({ page }) => {});
test('Recap and Replay show once dated', async ({ page }) => {});
test("Details shows what the trip has cost", async ({ page }) => {});
test('the crumb goes back to the conversation', async ({ page }) => {});
```

- [ ] **Step 2: Implement**

Order of the screen: crumb to `talkHref(id)` labelled t`Conversation`; a form with name, Starts, Ends and Save; the Itinerary button; Recap and Replay when `trip?.start`; plugins' `ui:trip-tab` buttons at the same address; Share, Archive, Remove; cost; files. Save is `ws.patch(id, '/trip.json', { title, start: start.value || null, end: end.value || null }, { author: 'user' })`: `mergePatch` follows RFC 7396, so `null` removes. Refuse `end < start` and a blank name before patching, in `trips.js`'s `explain` words. Move `explain` to a place both import. Cost: `(await costs(ctx.store, id)).total`, shown as Trace shows it.

- [ ] **Step 3: Run and commit.** Expected: PASS. `git commit -m "Details: the name and dates can change here; Recap and Replay once dated; cost"`.

### Task 5: Notifications open the conversation

**Files:**
- Modify: `sw.js` (`openReminder`), `src/ui/push.js`, `src/app/main.js`
- Test: `test/unit/sw-push.test.js`

**Interfaces:**
- Produces: SW message `{ type: 'annai.open', scope: string }`; `onReminderOpened(fn: (scope: string) => void)` in `push.js`.

- [ ] **Step 1: Write the failing tests in `sw-push.test.js`**

```js
test('a tap with an open window focuses it and posts the scope', async () => {
  // data { scope: 'trip-abc1' }: posted { type: 'annai.open', scope: 'trip-abc1' }, no openWindow
});
test('a tap with none open opens that conversation', async () => {
  // openWindow('/#/trip/trip-abc1/talk')
});
for (const scope of ['me', 'sys:waiting', 'trip-../x', 'TRIP-A', 'trip-', '', undefined, 7]) {
  test(`${String(scope)} opens home, and posts nothing`, async () => { /* openWindow('/#/trips') */ });
}
test('the tap is written down first, as today', async () => {});
```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement**

`const TRIP = /^trip-[0-9a-z]+$/`. A window that focuses gets `postMessage` when the scope fits. Otherwise `openWindow` with `/#/trip/<scope>/talk`, or `/#/trips`. In `main.js`, `onReminderOpened((scope) => { location.hash = talkHref(scope); })`. The `annai.push` message and `onPushMessage` stay as they are.

- [ ] **Step 4: Lessons and budget.** One line in `docs/lessons.md` if a message type counts as an API here (it does: the page and the worker ship apart).

- [ ] **Step 5: Run all, then e2e whole.** Raise the budget. Expected: PASS. `git commit -m "A notification opens its conversation; anything but a trip's strict id opens home"`.
