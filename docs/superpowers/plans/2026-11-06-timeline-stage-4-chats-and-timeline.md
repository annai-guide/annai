# Timeline stage 4, Chats, + and the timeline: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `#/trips` becomes a timeline of trips and chats, tapping a row opens its conversation, and a + drops you into a new conversation with no naming step, which names itself from your first line. The top bar is still there. This is the user's first phone test.

**Architecture:** A chat is a trip scope (`createTrip`). One standing draft, `draft: true` on its scope record, is ready before +. New `src/core/chats.js` keeps it and spends it. `src/core/timeline.js` gains the rows. Stages 2 and 3 must be in.

**Tech Stack:** Native ES modules, no build step, JSDoc checked by `tsc`, `node:test`, Playwright e2e in Docker.

**Spec:** `docs/superpowers/specs/2026-11-04-timeline-home-design.md`: sections The model, The timeline, The conversation (the dock on home, the +), Moving into a trip (its first paragraph), Notifications imports exports, Stages. Read it first.

## Global Constraints

- Work in `/mnt/optane/work/annai-timeline`, branch `timeline`. No push, no merge. Never `git stash`. Stage files by name. Delete with `/bin/rm -f`, move with `command mv -f`.
- Never read `/var/lib/private/annai-trace/`, `/root/annai-test-keys/` or any secret file. Fixtures use the repo's test names.
- **Anti-goals, from the spec:** a new kind of scope, a stored end for a chat, a naming model, a rename tool, "trip" on small chats, drawing for overlaps, writing across trips.
- A draft is never removed. Removing one would sweep every blob in a four-store transaction, and lose a file added without a line.
- `listTrips`, exports and `changedSince` skip drafts, and no location points go into one.
- Back from a conversation never calls `open`: home is a screen, not a state.
- Any released copy's records must still read. A format change gets its lessons entry in the same commit.
- If a change must touch `#play`, `#inPlay` or watches, the routes in stage 2's Review Focus stay green with no edited assertion.
- Tests that lean on the top bar stay green until stage 8.
- New user-facing words get `draft` rows (`npm run strings`, fill, `npm run strings`, `npm run strings -- --check`). Glossary: add `New conversation` (新しい会話, 新对话, 新對話). After a change to a shipped file: `npm run stamp`.
- Size: never print `scripts/size.mjs` line 4. **This stage expects +14 KiB.** Raise `BUDGET` in whole KiB by what the build needs, with the reason appended.
- The handoff ends with Calls to confirm.

**Commands:** as in the stage 1 plan (unit, all, e2e).

**Where the code moved past the spec**
- `start_trip`'s refusal and the "patch /trip/trip.json" snapshot text are in the spec's Moving section, but chats ship here, so they land here. The "read it first, move only if" half waits for stages 5 and 6, which give her those tools.
- `file.write` doesn't reach `agent.on('event')`, so the "Shiori set the dates" line reads a filtered log query, and `ws.onChange` keeps it live.
- A `heard` line can arrive with no text, its words following in `heard.text`, so naming waits for them.
- `tap()` returns `stopped`, not `listening`, when the state is still `thinking`. `open` halts a turn but the state may lag, and + over a running turn could leave the mic shut.
- The spec's "as sketched" has no sketch in the repo: `docs/mockups/` and `.superpowers/brainstorm/` hold none of the timeline's dock. Task 4 says what to build, and the phone test judges it.
- `#loadAll` reads about four transactions a scope. Dropped from `#follow` in stage 2; at start it still runs, so Task 7 narrows it.
- The Start a trip form and `startTrip`, used 130 times, stay until stage 8, which rewrites that helper anyway. The no-trip card and Waiting panel stay until stage 7. All three sit in the foot. The phone test will show them; they aren't the design.

**This plan's calls**
- Rows keep the class `trip-card`, line rows add `line`, so `.trip-card` e2e needs only fixtures changed. Line rows skip the three reads, so tests that assert a file count on an undated trip date their fixture.
- A card keeps its unread-file count and backup words beside the spec's dates and stamps: they say something the user acts on, and they are read only for cards.
- `updated …` goes from rows. Archived rows open Details, where Unarchive is.
- A `file` wake in a draft counts as first use, named from the file, so a file added from Details isn't hidden.
- The draft's title is stored `/* en */ 'New conversation'` and shown as t`New conversation`.
- Heard words that never transcribe name it t`Voice · 12:10`, beside the spec's t`Photo · 12:10`.
- Trace keeps every conversation and fixes its cost, not its meaning: see Task 7.

## Review Focus

1. **+ with Voice on, on an iPhone:** `open` and `tap` run before the first `await`, so `voice.unlock()` stays inside the gesture. Test in Task 3 on the order of calls. Only a real phone proves it: the phone test.
2. **+ while Kokoro works in another conversation:** the turn stops (approved) and the mic still opens. Test in Task 3.
3. **A reload with a draft open, or a draft in a backup:** the draft reads as an empty conversation, exports leave it out, and a restored `activeTrip` pointing at it opens nothing. Test in Task 1.
4. **A first line that is one long word, an emoji sequence, only punctuation, or Japanese with no space:** the name is at most 40 characters, never splits a surrogate pair, and never is blank. Test in Task 1.
5. **Two trips overlapping, or 500 chats:** overlaps are just rows; only dated trips sit below now, so a planned trip stays right under the line. Tests in Tasks 2 and 7.
6. **A quick chat open the evening before a trip:** the trip's first-morning reminder must reach the relay, though neither open nor play is that trip. On the released copy this isn't mirrored either, and chats will make it common. Stage 4 must test it.

---

### Task 1: Drafts and first use

**Files:**
- Create: `src/core/chats.js`
- Modify: `src/core/scopes.js` (`createTrip`, `listTrips`), `src/core/archive.js:183`, `src/core/backup-auto.js:38`, `src/core/live/live.js` (`#play`), `src/app/main.js`, `src/types.js:15`, `docs/lessons-full.md`, `docs/lessons.md`
- Test: `test/unit/chats.test.js`, `test/unit/live-play.test.js`, `test/unit/archive.test.js`

**Interfaces:**
- Produces, in `chats.js`: `DRAFT_TITLE`; `ensureDraft(ws) -> Promise<string>`; `chatName({ text?, file?, photo?, voice?, at, tz }) -> string`; `class Chats { ready: string | null; constructor({ ws, agent, tz }); start(): Promise<void>; whenReady(): Promise<string> }`. Scope record gains `draft?: true`. `createTrip`'s options gain `draft?: boolean`. `listTrips` returns `{ active, archived, draft: string | null }`.

- [ ] **Step 1: Write the failing tests**

```js
test('one draft, made once and hidden', async () => {
  const id = await ensureDraft(ws);
  assert.equal(await ensureDraft(ws), id);
  const l = await listTrips(store);
  assert.equal(l.draft, id);
  assert.ok(!l.active.some((s) => s.id === id));
});
test('names', () => {
  assert.equal(chatName({ text: 'Where should we eat? I am hungry.', at, tz }), 'Where should we eat?');
  assert.equal([...chatName({ text: 'a'.repeat(100), at, tz })].length, 40);
  assert.equal(chatName({ text: '今日はどこに行こうか。雨だね', at, tz }), '今日はどこに行こうか。');
  assert.ok([...chatName({ text: '👨‍👩‍👧'.repeat(30), at, tz })].length <= 40);
  assert.equal(chatName({ text: '   ', file: 'menu.pdf', at, tz }), 'menu.pdf');
  assert.equal(chatName({ text: '...', photo: true, at: noon, tz }), 'Photo · 12:00');
});
test('the first typed line clears the flag, names it as system, and a new draft is ready', async () => {
  // e: msg.user on the draft; record has no draft; trip.json title; last write's author is 'system'; chats.ready is another id
});
test('heard: a dismissed line does nothing; one with no text names it when heard.text comes; one never transcribed is Voice · hh:mm', async () => {});
test('a file wake is first use, named from the file', async () => {});
test("her own lines, a reminder and a state entry aren't first use", async () => {});
test('a long first line, kept as a blob, is read back for the name', async () => {});
test('exports and changedSince leave a draft out; a backup restored with activeTrip on it opens nothing', async () => {});
test('no location point goes into an open draft', async () => { /* in live-play: k.agent.opened(draft): k.live.play is null with nothing happening */ });
test('a used draft takes points like any chat', async () => {});
```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement**

`chatName`: split at the first `[.!?。！？]` or newline, keeping the mark; take 40 code points of `Intl.Segmenter` graphemes where it exists, else of `[...s]`; trim. Words with nothing but punctuation count as none.

`Chats.start` runs `ensureDraft`, sets `ready`, and listens on `agent.on('event')` for `msg.user`, `heard`, `heard.text` and a `wake` of kind `file`, in the conversation `ready` names. Text comes through `storedTexts`. Spending: clear `draft` in a `scopes` transaction first, then `ws.patch(scope, '/trip.json', { title }, { author: 'system' })`, then `ready = await ensureDraft(ws)`. `main.js` makes it after the agent and hands it to the shell as `chats`.

`live.js`: `#loadRows` keeps `#draft = list.draft`. `#play()`'s last step returns `null` for it. `#changed`'s `/trip.json` branch refreshes it with `listTrips`, which is also how a new draft is seen.

- [ ] **Step 4: Lessons, in this commit.** `## 2026-11-06 A chat is a trip with a draft flag`. An old page shows a draft as an ordinary trip called New conversation; say so in the entry.

- [ ] **Step 5: Run and commit.** Expected: PASS. `git commit -m "Chats: one standing draft, spent and named by the first line"`.

### Task 2: The rows

**Files:**
- Modify: `src/core/timeline.js`
- Test: `test/unit/timeline.test.js`

**Interfaces:**
- Produces: `timelineRows(trips: ScopeRecord[], now: number, zone: string) -> { above: Entry[], happening: Row[], below: Row[] }`; `Row = { id, title, phase, at: number, card: boolean }`; `Entry = { heading: { kind: 'day' | 'month', key: string } } | { row: Row } | { fold: { month: string, rows: Row[] } }`; `dayOfTrip(trip, now, zone) -> { day: number, of: number } | null`. Constants `RECENT_DAYS = 30`, `FOLD_OVER = 3`.

- [ ] **Step 1: Write the failing tests**

```js
const rows = (l) => timelineRows(l, now, LA);
test('where each sits', () => {
  // undated at talked, else created; past at end, else start; happening by start; future by start, below now
});
test('old to new; only dated trips sit below now', () => {
  const r = rows([chat('a', { talked: now - HOUR }), trip('f', '2027-01-01', '2027-01-05')]);
  assert.deepEqual(r.below.map((x) => x.id), ['f']);
  assert.ok(r.above.some((e) => e.row?.id === 'a'));
});
test('a card is dated, so an old undated trip with files is a line', () => {});
test('overlapping trips are just rows, in order', () => {});
test('the last 30 days have day headings, before that month headings', () => {});
test('a month before the last 30 days with over three chats folds; three stay; cards never fold', () => {
  // October: four chats and a card: { fold: { month: '2026-10', rows: 4 } } and the card outside it
});
test('dayOfTrip', () => {
  assert.deepEqual(dayOfTrip({ start: '2026-11-25', end: '2026-12-02' }, noonOn('2026-11-27'), LA), { day: 3, of: 8 });
  assert.equal(dayOfTrip({ start: '2026-11-25' }, noonOn('2026-11-27'), LA), null);
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.** A date's `at` is noon of that day in the zone, so it compares with a chat's ms in the right day. Pure, no store. **Step 4: Run.** Expected: PASS. `git commit -m "Timeline: the rows, their headings and the fold"`.

### Task 3: The +

**Files:**
- Create: `src/ui/plus.js`
- Modify: `src/ui/shell.js`, `src/ui/shiori.css`
- Test: `test/unit/plus.test.js`, `test/e2e/timeline.spec.js`, `test/unit/halves*.test.js` (the file that holds `tap`)

**Interfaces:**
- Consumes: `Chats.ready`, `talkHref`.
- Produces: `newConversation(ctx) -> void`.

- [ ] **Step 1: Write the failing tests**

```js
test('+ opens the draft and taps with nothing awaited between: the gesture holds', () => {
  const log = [];
  const ctx = { chats: { ready: 'trip-d' }, agent: { open: () => { log.push('open'); return Promise.resolve(); }, tap: () => { log.push('tap'); return 'listening'; } }, ws, dock: {} };
  newConversation(ctx);
  assert.deepEqual(log, ['open', 'tap']);   // synchronously, before this line
});
test("voice off: tap says typing, so the box opens", () => {});
test("a plugin's dock, which has no openTyping: nothing throws", () => {});
test('no draft ready yet (the first moments): it waits for one, then goes', async () => {});
```

In the `tap` tests: `open` to another conversation with a turn running, then `tap()` at once, with voice on: the turn stops and the microphone opens in the new conversation, and what is heard is logged there.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement**

```js
export function newConversation(ctx) {
  const id = ctx.chats.ready;
  if (!id) return void ctx.chats.whenReady().then(() => newConversation(ctx));
  updateAppSettings(ctx.ws, { activeTrip: id }).catch(() => {});
  ctx.agent.open(id).catch(() => {});
  if (ctx.agent.tap() === 'typing') ctx.dock?.openTyping?.();
  location.hash = talkHref(id);
}
```

The shell owns the button, `h('button', { class: 'plus', type: 'button', 'aria-label': t\`New conversation\`, onclick: () => newConversation(ctx) }, '+')`, shown only on home, whatever the dock, a plugin's included. `render` toggles `body.home` on `route.name === 'trips'`.

If the `tap` test fails on `thinking`: `Halves.open` is where to settle it, so that a state left by the conversation being left doesn't answer a tap for the new one. Fix there, not in `newConversation`.

- [ ] **Step 4: Run and commit.** Expected: PASS. `git commit -m "The +: opens the draft and taps inside the gesture"`.

### Task 4: The timeline screen and the dock on home

**Files:**
- Modify: `src/ui/screens/trips.js`, `src/ui/shell.js`, `src/ui/dock.js`, `src/ui/shiori.css`, `src/ui/screens/welcome.js:47`
- Test: `test/e2e/timeline.spec.js`, then the specs Step 4 names

**Interfaces:**
- Consumes: `timelineRows`, `dayOfTrip`, `talkHref`, `upcoming`, `tripRows`.

- [ ] **Step 1: Write the failing e2e tests**

```js
test('a chat is one line, a dated trip a card; a tap opens its conversation', async ({ page }) => {});
test('happening: tinted, "Day 3 of 8", Next; future: "In 2 weeks", her last line', async ({ page }) => {});
test('home opens with the now line 40% down; Back restores your place', async ({ page }) => {
  const y = await page.locator('.now-line').evaluate((n) => n.getBoundingClientRect().top / innerHeight);
  expect(y).toBeGreaterThan(0.35); expect(y).toBeLessThan(0.45);
});
test('home with nothing yet: the now line, "Tap + to talk to Shiori", Open a file', async ({ page }) => {});
test('home at rest shows the chips and +; while she works, the whole dock with "In Testville ›", which opens that conversation', async ({ page }) => {});
test('an open mic can be stopped from home', async ({ page }) => {});
test('← from a conversation with a turn running leaves it running, and voice on', async ({ page }) => {});
test('moving fast begins on home: Driving takes over, as in stage 1', async ({ page }) => {});
```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement**

`renderTrips`: above, `.now-line`, happening, below, then the foot in this order: no-trip card, Waiting panel, Start a trip form, Archived fold, Open a file, last backup. `tripStamps`, `backupState` and `filesToRead` run for cards only. "In 2 weeks": `relTime`'s future form, or a new t`` if it has none. Her last line: the last `out.speak`, one line, clipped by CSS.

Shell: `if (want && route.name !== 'talk' && route.name !== 'trips') follow(my, want)`. On `trips` with `want === 0`, scroll `.now-line` to 40% of `innerHeight`.

Dock: the shell toggles `body.dock-busy` from `agent.on('state')`, for every state but the resting ones (`sleeping`, `offline`; read `dock.js` for the full list). CSS: `body.home:not(.dock-busy)` leaves the chips row and the +. `dock.js` adds an `a.in-convo` shown only on `body.home.dock-busy`: t`In ${title} ›`, to `talkHref(target)`. Elsewhere the dock is as today. Welcome's "She is at the bottom of every screen: tap her to talk, or type." becomes t`Tap + on the timeline to talk to her, or tap her in any conversation.`, and it ends at home.

- [ ] **Step 4: Fix what the design changes, nothing else**

Run e2e whole. Expect three kinds of failure: a row tap now reaches the conversation, not Details (go by address or the new header); a test using the dock on `#/trips` goes to a conversation first; a card's facts on an undated fixture need dates (`l10n.spec.js:36`, `trips.spec.js:512`, `hand-over.spec.js:235`). A failure of any other kind is a bug.

- [ ] **Step 5: Commit.** `git commit -m "Home is the timeline: rows, the now line, and the dock at rest"`.

### Task 5: A chat becomes a trip

**Files:**
- Modify: `src/core/agent/trip-tools.js` (`start_trip`), `src/core/agent/context.js` (`systemText`), `src/ui/screens/talk.js`, `docs/lessons-full.md`, `docs/lessons.md`
- Test: `test/unit/trip-tools.test.js`, `test/unit/context*.test.js`, `test/e2e/hand-over.spec.js`, `test/e2e/timeline.spec.js`

- [ ] **Step 1: Write the failing tests**

```js
test('start_trip is refused in an undated conversation, and says to patch /trip/trip.json', async () => {
  await assert.rejects(run('start_trip', { title: 'Testville' }, { trip: chat }), /patch \/trip\/trip\.json/);
  assert.equal((await listTrips(store)).active.length, before);
});
test('in a dated trip it works as today', async () => {});
test('an undated conversation\'s system text says how it becomes a trip, a dated one\'s does not, and it is the same on every turn', () => {});
```

E2e: Shiori's patch dates the open chat: the row moves and becomes a card on home, and the conversation shows "Shiori set the dates" with Undo; Undo puts the row back as a line and the line goes, and it survives a reload. A date the user set in Details shows no such line.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement**

`start_trip`, first: `if (call.trip && !(await ws.readJSON(call.trip, '/trip.json').catch(() => null))?.start) throw new Error(/* en */ 'This conversation has no dates yet, so it can\'t start another trip. If it is becoming a trip, patch /trip/trip.json with its title and dates.')`.

`systemText`, for an undated trip: `/* en */ '# This conversation has no dates\nIts name is a first guess: patch /trip/trip.json when you know a better one. If it becomes a trip, patch its title and dates there.'`. It must not change from turn to turn: it follows `s.tripInfo`, so the cached prefix holds (see the per-turn-prompt lesson).

`talk.js`: `store.listEvents(scope, { types: ['file.write'], reverse: true, … })` filtered to `path === '/trip.json'`, `actor === 'shiori'`, where the old version has no `start` and the new one does, and it is still the current version. Undo is `ws.restore(scope, '/trip.json', e.data.old, { author: 'user' })`. `ws.onChange` on that path redraws the line. `restore` emits `write`, so the mirror and live mode follow (checked).

- [ ] **Step 4: Fixture changes.** In `hand-over.spec.js` and `trip-tools.test.js`, a trip that must start another gets dates.

- [ ] **Step 5: Lessons, run, commit.** `## 2026-11-06 start_trip refuses in an undated conversation`. `git commit -m "A chat becomes a trip by a patch: start_trip refuses there, and Undo takes the dates back"`.

### Task 6: Share target

**Files:**
- Modify: `src/ui/screens/import.js:320-350`
- Test: `test/e2e/` (the spec that holds the Share target; `grep -l "Start a trip first" test/e2e`)

- [ ] **Step 1: Failing test.** With 40 chats and 2 dated trips, the Share screen offers the 2 trips and New conversation. New conversation adds the photo to the draft, which is named from it and opens. "Start a trip first" is gone.

- [ ] **Step 2: Implement.** The buttons come from dated active trips (`start` on the record), plus `ctx.chats.ready` as t`New conversation`, adding and waking as the others do.

- [ ] **Step 3: Run and commit.** `git commit -m "Share target: dated trips and New conversation"`.

### Task 7: 500 chats

**Files:**
- Create: `scripts/chats-fixture.mjs`
- Modify: `src/core/live/live.js` (`#loadAll`), `src/ui/screens/trips.js`, `src/ui/screens/trace.js:47-75`, `src/ui/screens/import.js` (`preview`), `src/ui/screens/simulate.js`, `src/core/live/sim-run.js` if `ownTitle` walks every trip
- Test: `test/unit/scale.test.js`

- [ ] **Step 1: Write the failing test, counting transactions, not milliseconds**

```js
test('500 chats: transactions do not follow chats', async () => {
  // wrap store.tx with a counter; 500 undated chats, 3 dated trips, one with a watch
  // open change: at most 3; the timeline's reads: at most 3 + a constant per card; live start: at most 5 + a constant per scope with watches
});
```

- [ ] **Step 2: Run it.** Expected: FAIL at live start.

- [ ] **Step 3: Implement, each only as far as it needs**

- `#loadAll`: one transaction lists which scopes hold `/watches/` files; `#loadScope` and `#recall` run for those and dated trips only.
- Trace: the select shows dated trips, the 30 newest chats, `me`, `sys` and the one in the address. Everything keeps its meaning: one transaction for every scope's query, and `costs` only for the scopes of the 300 rows shown.
- Import's preview: undated trips are one row with one choice; afterwards one "Go to the timeline" when more than three came in, in place of an Open each.
- Simulate: dated trips only.
- `spentToday` and `changedSince`: measure with the fixture in a browser, and report numbers. Change them only if a real pause shows. Deferred is fine; write it down.

- [ ] **Step 4: The fixture.** `node scripts/chats-fixture.mjs <out>` writes an archive of 500 synthetic chats over a year, six lines each, plus 3 dated trips ("Testville", no real places), through annai's own export on a memory store. Dev-only, unshipped. It is how the phone gets them: Open a file.

- [ ] **Step 5: Run and commit.** `git commit -m "Timeline scale: 500 chats cost no more than the trips that have watches"`.

### Task 8: The limitation, and the phone test

**Files:**
- Modify: `docs/limitations.md`, `scripts/size.mjs` (`BUDGET`)

- [ ] **Step 1: The approved limitation.** `### A turn stops when another conversation is tapped`: kind known limitation. What the operator sees: tapping another conversation while Kokoro works stops her turn until you come back. Why: conversations don't run side by side, and `open` stops a turn. Revisit if drives show it. Approved 2026-11-05: "Stop until you come back (Recommended)".

- [ ] **Step 2: Run all, then e2e whole.** Expected: PASS.

- [ ] **Step 3: Commit, and hand back this list for the user's phone**

- **The gesture:** with Voice on, + on an iPhone opens the microphone at once.
- **Forgetting:** a new chat knows only profile and memory. Does that feel wrong yet? (Stage 5 is the answer to it.)
- **500 chats:** home opens and scrolls well with the fixture, and + stays instant.
- **Judgement:** on a real model, does she date a chat too early, or name it badly?
- **The dock at rest:** the spec's sketch isn't in the repo, so this is the first look.
- The form, the no-trip card and the Waiting panel in the foot are temporary.
