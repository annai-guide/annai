# One entry per file, one details screen: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The trip's Files lists one row per file the user gave, and one details screen shows a file with every booking Shiori read from it (or a booking with no file), with Open, Download, Ask, Change, Open in Maps and a Delete that removes the file and what came from it. Back goes to wherever the screen was opened from.

**Architecture:** One pure reading in `src/core/trip-files.js` works out each file's rows, blocks and plan items from what is stored. The existing booking route (`#/trip/<id>/booking?path=…`) becomes the details screen. Its `path` is either a file under `/files/` or a booking under `/bookings/`. A booking path opens its file's screen at its block, so every old link keeps working with no alias. Delete is one `writeMany` of null contents, shared by the details screen and the raw file screen.

**Tech Stack:** Native ES modules, no build step. JSDoc checked by `tsc`. `node:test` for unit tests. Playwright e2e in Docker (Chromium Pixel 7, WebKit iPhone 15).

**Spec:** `docs/superpowers/specs/2026-11-01-file-details-design.md` (it amends goals 6–8 of `docs/superpowers/specs/2026-10-28-bookings-and-trips-design.md`). Its "user's decisions" quote the user, and those words come first. Read the whole spec before Task 1.

## Global Constraints

- Browser-only, local-first PWA. iPhone Safari is the main target. No new dependency.
- **The stored formats don't change.** A booking's `source` names its file (`/files/x` or `/trip/files/x`). A plan item stands for a booking through `booking` (`bookingRef()` in `src/core/plan.js`). A plan item made from a calendar file carries that file in its **file entry's** `source` (the `source` field of `ws.list()` entries), not in its JSON.
- Accessible as built: real links and buttons, headings in order, a label on each region, and focus moved on purpose.
- **Every new or changed user-facing string** gets ja, zh-Hans and zh-Hant rows. Unused rows go. See "Strings" below.
- **Shipped-size budget** (`scripts/size.mjs`, `BUDGET`): raise it only by what the build needs, in whole KiB, with a reason appended to its comment. List the raise in Calls to confirm.
- Fixtures are synthetic. The repo is public, so tests, docs and commits carry no real booking details, names or file names. Use the repo's existing test names: ANNAI AIR AN 123/124, Hotel Aurora Test, Testville, `*.test.invalid`.
- Run `npm run stamp` after any change to a shipped file (anything under `src/`, `index.html` or `sw.js`), before committing.

### House rules (every task)

- Never `git stash`. Delete with `/bin/rm -f` and move with `command mv -f` (the shell aliases `rm` and `mv` to `-i`).
- Every test run gets a memory cap (the commands below have them). No system package installs.
- Stage files by name. Never `git add -A` or `git add .`.
- Never read `/root/annai-test-keys` or `/var/lib/private`.
- Work only in `/mnt/optane/work/annai/.claude/worktrees/file-details`.
- End every commit message with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01J9mww4xUP6suf5vAWKfWD8
  ```

- Your final handoff ends with **Calls to confirm**: the size raise, each changed API or behaviour, and each call of your own that changed what got built. The plan's own calls are listed at the end; repeat them, and add yours.

### Commands

- Unit, one file: `NODE_OPTIONS=--max-old-space-size=2048 timeout 600 systemd-run --scope -q -p MemoryMax=4G node --test --test-timeout=120000 --import ./test/unit/pin-phone.js test/unit/<file>.test.js`
- E2e, some specs: `docker run --rm --memory=6g --ipc=host -v "$PWD":"$PWD" -v /mnt/optane/work/annai/node_modules:/mnt/optane/work/annai/node_modules:ro -w "$PWD" mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test <specs…> --workers=2`
- Types: `NODE_OPTIONS=--max-old-space-size=2048 timeout 600 systemd-run --scope -q -p MemoryMax=4G npm run typecheck`
- Strings: `npm run strings`, then `npm run strings -- --check`.

### Strings (how every task adds words)

Read `docs/translating.md` and `l10n/glossary.md` first. After a task changes English in the code:
1. Run `npm run strings`. New rows land in `l10n/{ja,zh-Hans,zh-Hant}.tsv` with state `new`. Rows no longer in the code are dropped.
2. Fill each new row's `text`, set its state to `draft`, and add a `Note:` saying where it shows. Use the glossary's words: 予約/预订/預訂 for Booking, 予定/行程 for Plan, ファイル/文件/檔案 for Files. Use the drafts below as a starting point.
3. Run `npm run strings` again to write the JSON, then `npm run strings -- --check`, which must be green.

| English (one / other) | ja | zh-Hans | zh-Hant |
|---|---|---|---|
| `# flight` / `# flights` | フライト#便 | #个航班 | #個航班 |
| `# stay` / `# stays` | 宿泊#件 | #处住宿 | #處住宿 |
| `# car` / `# cars` | レンタカー#件 | #项租车 | #項租車 |
| `# train` / `# trains` | 列車#件 | #趟火车 | #趟火車 |
| `# event` / `# events` | イベント#件 | #个活动 | #個活動 |
| `# restaurant` / `# restaurants` | レストラン#件 | #家餐厅 | #家餐廳 |
| `# booking` / `# bookings` | 予約#件 | #项预订 | #項預訂 |
| `# plan item` / `# plan items` | 予定の項目#件 | #个行程项目 | #個行程項目 |
| `On the plan` | 予定に入っている項目 | 已在行程中 | 已在行程中 |
| `This file isn't in the trip` | このファイルは旅にありません | 这个旅行中没有此文件 | 這個旅行中沒有此檔案 |
| `Deleted {0}` | {0}を削除しました | 已删除{0} | 已刪除{0} |
| `Deleting this file also deletes {0}.` | このファイルを削除すると、{0}も削除されます。 | 删除此文件也会删除{0}。 | 刪除此檔案也會刪除{0}。 |

Japanese and Chinese have only the `other` form. Also update the `Note:` of the existing `Details` row (key `43f6md`), which now also names the crumb back to this details screen.

## Review Focus

These inputs are the most likely to bite. Each has its test in the task named.

1. **A file with two bookings** (outbound and return flights): one row, "2 flights · Nov 20, Nov 27"; one screen with two blocks in time order, each with its own heading, Change it and Open in Maps; a Plan tap on the second lands on its block, focused. Tasks 1, 2, 3, 4.
2. **A booking with no file** (`source` names no file under `/files/`, or one that's gone): its block alone, with no preview, Open or Download, and still Ask, Change it and Delete. A `/files/` source that's gone still says "The original, X, isn't in the trip." Tasks 1, 3, 5.
3. **A calendar (.ics) file:** its row says "Plan items from a calendar". Its screen lists those items with their days, each opening its plan item, and has Change it (it is a text file). Delete removes the file and those items. It sorts after the dated files. Tasks 1, 2, 3, 5.
4. **A file still waiting to be read:** its row says "Waiting for Shiori to read it", and so does its screen under the heading. It has Open, Download, Ask and Delete, and no Change it (a PDF). Tasks 1, 2, 3.
5. **A photo that became a booking:** it is in Files (a plain photo isn't), its screen shows the photo as the preview, and Open shows the photo full size. A plain photo opened by its address (a Conversation chip) gets the screen too. Tasks 1, 2, 3.
6. **Old links:** `#/trip/<id>/booking?path=/bookings/…` from Shiori's cards, the Conversation's chips, the Plan and Now, and old `from=#/trip/<id>/booking?…` crumbs. Each opens the screen at that booking's block. Tasks 3, 4.
7. **Back from every origin:** the trip (the crumb names the trip), the Plan, Now, the Conversation, a plan item's details, and no `from` (goes to the trip). Open and Change it come back here. After Delete, Back goes to the trip when the screen it would return to was a screen of something deleted. Tasks 3, 4, 5.
8. **Delete from the raw file screen** (All files, or Open's screen) for a file under `/files/`: it says what else goes and deletes the same set. For any other path it is unchanged. Task 5.

---

## File structure

| File | Change |
|---|---|
| `src/core/trip-files.js` | The reading: `readTripFiles`, `tripZoneOf`, `fileRows` (new name rule, time-sorted `became`, new order), `fileDetails`, `deletionOf`. |
| `src/ui/format.js` | `fileLine(became)` (a row's second line); `recordHref` sends `/files/x` to the details screen; `bookingHref`'s doc widened. |
| `src/ui/screens/trip.js` | The Files rows: one link each, two lines, no Ask. All files' region label becomes "All files". |
| `src/ui/screens/booking.js` | `renderBooking` becomes the details screen. `backCrumb` gains the trip. `original()` (used only by `item.js`) links to the details screen. |
| `src/ui/screens/file.js` | `BACK` gains `trip` and `talk`, and `booking` reads "Details". Delete of a `/files/` file runs the shared delete. |
| `src/ui/file-delete.js` (new) | `deleteDetails`, `afterDelete`, `countParts`. |
| `src/ui/composer.js` | `askAboutButton` and `askAbout` take one ref or several. |
| `src/ui/screens/plan.js`, `src/ui/cards.js`, `src/ui/screens/talk.js`, `src/ui/screens/item.js` | Their links pass `from` and reach the details screen. |
| `src/ui/base.css` (or wherever `.details` is styled) | Block spacing only, within the existing details styles. |
| `test/unit/trip-files.test.js`, `test/unit/ui-pure.test.js` | Unit tests. |
| `test/e2e/file-details-fixture.js` (new), `test/e2e/file-details.spec.js` (new) | The synthetic trip and the e2e tests. |
| Existing e2e: `trips`, `plan`, `original`, `evening`, `hand-over`, `phone-fixes` | Updated as each task says. |
| `l10n/*.tsv`, `l10n/*.json`, `scripts/size.mjs` | Strings; the budget (Task 6). |

**The route (the spec leaves it to the builder):** keep `#/trip/<id>/booking?path=<p>&from=<hash>`, and widen what `p` may be. `src/ui/router.js`, `src/ui/shell.js` and `src/ui/resume.js` don't change. Old links work as they are, and `from=` values naming the booking route keep parsing as `booking`.

---

### Task 1: The reading (core)

**Files:**
- Modify: `src/core/trip-files.js`
- Test: `test/unit/trip-files.test.js`

**Interfaces:**
- Produces (exact; later tasks use these names):

```js
/** @typedef {{ at: number | null, day: string | null }} When  at: the instant; day: "YYYY-MM-DD" */
/** @typedef {{ kind: 'booking', bookingKind: string, path: string, title: string, at: number | null, day: string | null }
 *   | { kind: 'plan', path: string, title: string, at: number | null, day: string | null } | { kind: 'photo' } | { kind: 'waiting' } | { kind: 'nothing' }} Became */
/** @typedef {{ path: string, name: string, real: string, type: string, became: Became[] }} FileRow */
/** @typedef {{ files: import('./types.js').FileEntry[], bookings: { path: string, booking: any }[],
 *   items: { path: string, item: any, source?: string }[], names: Record<string, string>, toRead: string[], fallbackTz: string }} TripFiles */
/** @typedef {{ path: string, item: Record<string, any>, at: number | null, day: string | null }} Planned */
/** @typedef {{ path: string, booking: Record<string, any>, at: number | null, day: string | null, items: Planned[] }} Block */
/** @typedef {{ file: FileRow | null, blocks: Block[], made: Planned[], focus: string | null }} Details */

export async function tripZoneOf(ws, id)                 // Promise<string>: trip.json's timezones[0], else deviceZone(), else 'UTC' (validZone each)
export async function readTripFiles(ws, store, id)       // Promise<TripFiles>
export function fileRows(t)                              // FileRow[]
export function fileDetails(t, path)                     // Details | null
export function deletionOf(d)                            // { file: string | null, bookings: string[], items: string[] }
```

**Rules:**
- **When** (a private helper): a time `{ at, tz }` uses its own `tz` when `validZone`, else `fallbackTz`. A date-only `at` (`/^\d{4}-\d{2}-\d{2}$/`) has `day` = that string and `at` = `Date.parse(at + 'T00:00:00Z')`. Otherwise `at = instantAt(at, tz)`, and `day = dayIn(at, tz)` when finite, else both null. A booking's `When` is its `start`, and so is a plan item's.
- **`readTripFiles`:** `files` = `ws.list(id, '/')`. `bookings` = each `/bookings/` entry matching `BOOKING_FILE`, read with `readJSON` (`null` when it can't be read). `items` = each `/plan/` entry matching `PLAN_FILE`, with `source` taken from the list entry. `names` = `readNames`. `toRead` = `filesToRead(store, id)` (`src/core/handover.js`). `fallbackTz` = `tripZoneOf`. This is what `trip.js`'s `filesSection` reads today. Move it here.
- **`fileRows`:** list only files matching `/^\/files\/[^/]+$/`, with today's photo rule (`isPhotoType` with nothing from it → left out).
  - `became`: the bookings whose `inTrip(source)` is the file, in time order (null `at` last, then by path); then the plan items made from it (file-entry `source`), in time order. Otherwise waiting / photo / nothing, as today.
  - `name`: Shiori's short name when `names` has one; else the booking's title when the file became exactly one booking with a non-blank title; else `real`.
  - Order: by the earliest booking `day` (rows with no booking day after all those with one); then `sortWords(name)`; then `sortWords(real)`. Only bookings' days count (spec, My call 1).
- **`fileDetails(t, path)`:** `path` may start with `/trip`; strip it (`inTrip`).
  - **A file** (`/^\/files\/[^/]+$/` and in `t.files`): `file` = its row, built by the same private `rowOf()` that `fileRows` uses but **without** the photo filter. A plain photo opened by its address gets a row.
    - `blocks`: its bookings (object values only), in the same order as `became`. Each block's `items` = the plan items with `bookingRef(item.booking) === block.path`, in time order. That is every one of them, with or without notes.
    - `made`: the plan items whose file-entry `source` is the file and that are in no block, in time order.
    - `focus`: null.
  - **A booking** (`BOOKING_FILE`, present, an object): if `inTrip(booking.source)` is a file under `/files/` that is in `t.files`, return that file's details with `focus` = this booking's path. Otherwise `{ file: null, blocks: [its block], made: [], focus: null }`.
  - Anything else: `null`.
- **`deletionOf(d)`:** `file` = `d.file?.path ?? null`; `bookings` = the blocks' paths; `items` = the blocks' items' paths and `made`'s, deduplicated.

- [ ] **Step 1: Write the failing tests** in `test/unit/trip-files.test.js`. Update the two existing tests for the new fields: pass `fallbackTz: 'America/Anchorage'`, add `at`/`day` (both `null` in the existing fixture, which has no starts) to the expected `became` entries, and expect `rows[1].name === 'Hotel Aurora Test'` (one booking with a title, no short name). Then add:

```js
const AK = 'America/Anchorage';
const out = { kind: 'flight', title: 'ANNAI AIR AN 123', source: '/files/flight.pdf', start: { at: '2026-11-20T11:20:00-08:00', tz: 'America/Los_Angeles' } };
const back = { kind: 'flight', title: 'ANNAI AIR AN 124', source: '/trip/files/flight.pdf', start: { at: '2026-11-27T13:00:00-09:00', tz: AK } };
const two = { files, names: {}, toRead: ['/files/new.pdf'], fallbackTz: AK,
  bookings: [{ path: '/bookings/back.json', booking: back }, { path: '/bookings/out.json', booking: out },
    { path: '/bookings/stay.json', booking: { kind: 'lodging', title: 'Hotel Aurora Test', source: '/files/hotel.png', start: { at: '2026-11-20T15:00:00-09:00', tz: AK } } },
    { path: '/bookings/said.json', booking: { kind: 'restaurant', title: 'Testville Grill', source: '/talk', start: { at: '2026-11-22T19:00:00-09:00', tz: AK } } }],
  items: [{ path: '/plan/fly-home.json', item: { title: 'Fly home', booking: '/trip/bookings/back.json' } },
    { path: '/plan/grill.json', item: { title: 'Dinner at the grill', booking: '/bookings/said.json' } },
    { path: '/plan/ics-a-1.json', item: { title: 'Aurora walk', start: { at: '2026-11-22T22:00:00-09:00', tz: AK } }, source: '/files/trip.ics' }] };

test('fileRows: a file with two flights is one row, its bookings in time order with their days; rows by first booking day, then name; no day last', () => {
  const rows = fileRows(two);
  assert.deepEqual(rows.map((r) => r.real), ['flight.pdf', 'hotel.png', 'new.pdf', 'pasted-2026-10-28-0310.txt', 'trip.ics']);
  assert.equal(rows[0].name, 'flight.pdf'); // two bookings: neither title names the file
  assert.deepEqual(rows[0].became.map((b) => b.kind === 'booking' && [b.path, b.day]), [['/bookings/out.json', '2026-11-20'], ['/bookings/back.json', '2026-11-27']]);
  assert.equal(rows[1].name, 'Hotel Aurora Test');
});

test('fileDetails: a file with two bookings has two blocks in time order, each with the plan items that stand for it', () => {
  const d = fileDetails(two, '/files/flight.pdf');
  assert.deepEqual(d?.blocks.map((b) => b.path), ['/bookings/out.json', '/bookings/back.json']);
  assert.deepEqual(d?.blocks[1].items.map((p) => p.path), ['/plan/fly-home.json']);
  assert.equal(d?.focus, null);
  assert.deepEqual(fileDetails(two, '/bookings/back.json')?.focus, '/bookings/back.json');
  assert.equal(fileDetails(two, '/bookings/back.json')?.file?.path, '/files/flight.pdf');
});

test('fileDetails: a booking with no file is its block alone; its plan item without notes is listed', () => {
  const d = fileDetails(two, '/bookings/said.json');
  assert.equal(d?.file, null);
  assert.deepEqual(d?.blocks.map((b) => [b.path, b.items.map((p) => p.path)]), [['/bookings/said.json', ['/plan/grill.json']]]);
  // A source under /files/ that isn't there: alone too.
  const gone = fileDetails({ ...two, bookings: [{ path: '/bookings/x.json', booking: { kind: 'car', source: '/files/gone.pdf' } }] }, '/bookings/x.json');
  assert.equal(gone?.file, null);
});

test('fileDetails: a calendar file lists the plan items made from it; a waiting file and a plain photo have rows and no blocks', () => {
  const ics = fileDetails(two, '/trip/files/trip.ics');
  assert.deepEqual([ics?.blocks.length, ics?.made.map((p) => [p.path, p.day])], [0, [['/plan/ics-a-1.json', '2026-11-22']]]);
  assert.deepEqual(fileDetails(two, '/files/new.pdf')?.file?.became, [{ kind: 'waiting' }]);
  assert.deepEqual(fileDetails(two, '/files/view.jpg')?.file?.became, [{ kind: 'photo' }]); // not in Files, still has a screen
  assert.equal(fileDetails(two, '/files/hotel.png')?.blocks.length, 1); // a photo that became a booking
  for (const p of ['/trip.json', '/files/nope.pdf', '/bookings/nope.json', '/notes/day1.md']) assert.equal(fileDetails(two, p), null, p);
});

test('deletionOf: the file, its bookings, and every plan item shown, once each', () => {
  assert.deepEqual(deletionOf(/** @type {any} */ (fileDetails(two, '/files/flight.pdf'))), { file: '/files/flight.pdf', bookings: ['/bookings/out.json', '/bookings/back.json'], items: ['/plan/fly-home.json'] });
  assert.deepEqual(deletionOf(/** @type {any} */ (fileDetails(two, '/bookings/said.json'))), { file: null, bookings: ['/bookings/said.json'], items: ['/plan/grill.json'] });
  assert.deepEqual(deletionOf(/** @type {any} */ (fileDetails(two, '/files/trip.ics'))), { file: '/files/trip.ics', bookings: [], items: ['/plan/ics-a-1.json'] });
});
```

  Also test that an all-day plan item with `start: { at: '2026-11-23' }` has `day: '2026-11-23'` in a western `fallbackTz` (`'America/Los_Angeles'`).

- [ ] **Step 2: Run them and see them fail** (unit command, `trip-files`). Expected: FAIL (`fileDetails` and `deletionOf` aren't exported).
- [ ] **Step 3: Implement** the interfaces above in `src/core/trip-files.js`. Import `bookingRef`, `BOOKING_FILE` and `PLAN_FILE` from `./plan.js`, `filesToRead` from `./handover.js`, `readNames` from `./names.js`, and `validZone`, `deviceZone`, `dayIn` and `instantAt` from `./time.js`. Have `booking.js`'s `tripZone(ctx, id)` return `tripZoneOf(ctx.ws, id)`, so the rule lives in one place.
- [ ] **Step 4: Run the tests and the typecheck.** Expected: PASS, and `tsc` clean. `trip.js` still calls `fileRows` with its old input. Give it `fallbackTz` (or switch it to `readTripFiles` now) so `tsc` passes.
- [ ] **Step 5: Commit** `src/core/trip-files.js`, `src/ui/screens/booking.js`, `src/ui/screens/trip.js` and `test/unit/trip-files.test.js`, after `npm run stamp` (and add its output files by name): "Read a file's bookings, plan items and days in one place".

---

### Task 2: The Files list

**Files:**
- Modify: `src/ui/format.js`, `src/ui/screens/trip.js`
- Create: `test/e2e/file-details-fixture.js`, `test/e2e/file-details.spec.js`
- Test: `test/unit/ui-pure.test.js`. Update `test/e2e/trips.spec.js` (the Files test at "a trip's Files: …"), `test/e2e/hand-over.spec.js` (lines ~165 and ~334, the row assertions only), `test/e2e/plan.spec.js` (~428).

**Interfaces:**
- Consumes: `readTripFiles`, `fileRows`, `Became` (Task 1).
- Produces: `export function fileLine(became: Became[]): string` in `src/ui/format.js`, used again by Task 3.

**`fileLine` words** (spec goal 1; the mixed-kinds wording is the plan's call):
- One booking: its kind word, and ` · ` with `day(dayKey)` when it has a day: "Stay · Nov 20". The kind word is `BOOKING_KINDS[kind]` for flight, lodging, car, rail, event and restaurant, else `` t`Booking` ``.
- Several, all of one kind: the count by kind, then ` · ` and the distinct days, sorted and `list(days.map((d) => day(d)), 'plain')`: "2 flights · Nov 20, Nov 27". No days means the count alone.
- Several of different kinds: each kind's count, in order of first appearance, joined with ` · `: "1 flight · 1 stay".
- Counts come from a `COUNTS` map of literal plurals (`'# flight'/'# flights'`, `'# stay'/'# stays'`, `'# car'/'# cars'`, `'# train'/'# trains'`, `'# event'/'# events'`, `'# restaurant'/'# restaurants'`), with `'# booking'/'# bookings'` for any other kind.
- Plan entries: append `` t`Plan items from a calendar` `` (once) as a further ` · ` part.
- `waiting` → `` t`Waiting for Shiori to read it` ``, `nothing` → `` t`Nothing yet` ``, `photo` → `''`.

**The row** (`trip.js` `filesSection`): build it from `readTripFiles(ctx.ws, ctx.store, id)`.
- `li.trip-file > a.file-row[href=bookingHref(id, r.path, '#/trip/' + encodeURIComponent(id))]`, which holds `span.name` (`dir=auto`) and `span.sub.became` (`fileLine(r.became)`).
- Nothing else in the `li`: no real-name line, no booking links, no Ask button.
- Remove `BECAME`, `becameParts` and the `askAboutButton` import.
- `fileList`'s region `aria-label` becomes `` t`All files` ``.

- [ ] **Step 1: Write the failing unit test** in `test/unit/ui-pure.test.js` (import `fileLine` from `../../src/ui/format.js`):

```js
test('fileLine: one booking, several of a kind with their days, mixed kinds, a calendar, waiting', () => {
  const b = (/** @type {string} */ k, /** @type {string | null} */ day) => ({ kind: /** @type {const} */ ('booking'), bookingKind: k, path: `/bookings/${k}${day}.json`, title: '', at: null, day });
  assert.equal(fileLine([b('lodging', '2026-11-20')]), 'Stay · Nov 20');
  assert.equal(fileLine([b('flight', '2026-11-20'), b('flight', '2026-11-27')]), '2 flights · Nov 20, Nov 27');
  assert.equal(fileLine([b('flight', '2026-11-20'), b('flight', '2026-11-20')]), '2 flights · Nov 20');
  assert.equal(fileLine([b('flight', '2026-11-20'), b('lodging', '2026-11-20')]), '1 flight · 1 stay');
  assert.equal(fileLine([b('other', null)]), 'Booking');
  assert.equal(fileLine([{ kind: 'plan', path: '/plan/a.json', title: 'A', at: null, day: null }, { kind: 'plan', path: '/plan/b.json', title: 'B', at: null, day: null }]), 'Plan items from a calendar');
  assert.equal(fileLine([{ kind: 'waiting' }]), 'Waiting for Shiori to read it');
  assert.equal(fileLine([{ kind: 'nothing' }]), 'Nothing yet');
});
```

- [ ] **Step 2: Write the fixture** `test/e2e/file-details-fixture.js`. It exports `fileTrip(page): Promise<string>` (the trip id), using `startTrip`, `putFile`, `writeRecords` and `writeEvent` from `./helpers.js`. Starting from Trips, it:
  1. Starts the trip "Anchorage".
  2. Puts `/files/itinerary.pdf` (bytes of `test/fixtures/bookings/flight.pdf`), `/files/hotel.png` (`test/fixtures/bookings/hotel.png`), `/files/new.pdf` (`%PDF-1.4 new`) and `/files/view.png` (the 1×1 PNG `trips.spec.js` uses).
  3. Writes the records below.
  4. Writes a wake event `{ type: 'wake', data: { reasons: [{ files: ['/files/new.pdf'] }] } }`.
  5. Reloads the trip screen and adds `walks.ics` through "Add photos or files": `plan.spec.js`'s one-event calendar, "Aurora walk", 2026-11-22 22:00 Anchorage. It waits for the toast `/walks\.ics, and 1 plan item from the calendar/`.

  Also export `FILE_TRIP`, the records:

  - `/trip.json` patch `{ start: '2026-11-20', end: '2026-11-27', timezones: ['America/Anchorage'] }`;
  - `/bookings/out.json`: flight, source `/files/itinerary.pdf`, title ANNAI AIR AN 123, `unsure: []`, 2026-11-20 11:20 LA → 14:05 AK, fields Seattle (SEA) → Anchorage (ANC);
  - `/bookings/back.json`: flight, source `/trip/files/itinerary.pdf`, title ANNAI AIR AN 124, `unsure: ['seat']`, 2026-11-27 13:00 AK → 20:30 LA, fields Anchorage (ANC) → Seattle (SEA), seat 14C;
  - `/bookings/stay.json`: lodging, source `/files/hotel.png`, title Hotel Aurora Test, `unsure: []`, place `{ name: 'Hotel Aurora Test', address: '1 Test Way, Testville' }`, 2026-11-20 15:00 → 2026-11-27 11:00 AK;
  - `/bookings/said.json`: restaurant, source `/talk`, title Testville Grill, `unsure: []`, 2026-11-22 19:00 AK;
  - `/plan/fly-home.json` `{ title: 'Fly home', fixed: true, start: <back's start>, booking: '/trip/bookings/back.json', notes: 'Terminal S.' }`;
  - `/plan/grill.json` `{ title: 'Dinner at the grill', fixed: true, start: <said's start>, booking: '/bookings/said.json' }`;
  - `/names.json` `{ '/files/itinerary.pdf': 'ANNAI AIR itinerary' }`.

  All bookings get `status: 'unverified'` and an `id`.
- [ ] **Step 3: Write the failing e2e test** in `test/e2e/file-details.spec.js`:

```js
test('Files: one row per file, by its first booking day then name, each one link with what it is; no record names, no Ask; a plain photo is not listed', async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  const files = page.getByRole('region', { name: 'Files', exact: true });
  const rows = files.locator('.trip-file');
  await expect(rows.locator('.name')).toHaveText(['ANNAI AIR itinerary', 'Hotel Aurora Test', 'new.pdf', 'walks.ics']);
  await expect(rows.locator('.became')).toHaveText(['2 flights · Nov 20, Nov 27', 'Stay · Nov 20', 'Waiting for Shiori to read it', 'Plan items from a calendar']);
  for (const row of await rows.all()) await expect(row.getByRole('link')).toHaveCount(1);
  await expect(files.getByRole('button', { name: 'Ask Shiori about this' })).toHaveCount(0);
  await expect(files).not.toContainText('.json');
  await expect(rows.first().getByRole('link')).toHaveAttribute('href', /\/booking\?path=%2Ffiles%2Fitinerary\.pdf&from=%23%2Ftrip%2F/);
  await expect(files).not.toContainText('view.png');
});
```

- [ ] **Step 4: Run them and see them fail** (unit `ui-pure`; e2e `file-details.spec.js`).
- [ ] **Step 5: Implement** `fileLine` and the row as specified.
- [ ] **Step 6: Update the existing tests** that read rows. Assert `.name` and `.became` instead of `.real` and "A stay: …"/"A car: …". In `trips.spec.js`'s Files test, replace the "what it became links to the booking" and "asking about one" parts with: the row's single link has `href` matching `/\/booking\?path=/`. Asking moves to Task 3's tests. Use `{ name: 'Files', exact: true }` for the region wherever you touch it.
- [ ] **Step 7: Strings.** New: the seven count plurals. Dropped: the seven "A flight: {0}"… messages. Follow "Strings".
- [ ] **Step 8: Run** unit `ui-pure`, `trip-files`; e2e `file-details.spec.js trips.spec.js plan.spec.js hand-over.spec.js`; typecheck; `npm run strings -- --check`. Expected: the new tests PASS. Tests that click a Files row through to its screen may still fail until Task 3 (the screen doesn't take a `/files/` path yet). List any that do in the commit message, and Task 3 fixes them.
- [ ] **Step 9: Commit** (after `npm run stamp`): "Files: one row per file, named and described, one tap target".

---

### Task 3: The details screen

**Files:**
- Modify: `src/ui/screens/booking.js`, `src/ui/screens/file.js` (`BACK` only), `src/ui/composer.js`, `src/ui/screens/item.js` (the `original()` call), the details CSS
- Test: `test/e2e/file-details.spec.js`, `test/unit/ui-pure.test.js`. Update `test/e2e/plan.spec.js` (the tests at ~225, ~299 and ~431), `test/e2e/original.spec.js`, `test/e2e/evening.spec.js` (steps 4–7), `test/e2e/hand-over.spec.js` (the Ask tests and the named-file test), `test/e2e/phone-fixes.spec.js` (item 8 test).

**Interfaces:**
- Consumes: `readTripFiles`, `fileDetails`, `Details`, `Block`, `Planned` (Task 1); `fileLine` (Task 2).
- Produces:
  - `askAboutButton(ctx, refs)` and `askAbout(ctx, refs, o)` in `composer.js`, where `refs: Ref | Ref[]` and `Ref = { scope: string, path: string, name?: string }`. One ref works as before. Several become several chips. The conversation to open is `refs[0].scope`'s.
  - `backCrumb(ctx, id, from, o = {})` in `booking.js`, with `o: { trip?: string }` (the trip's title). With `o.trip` set, no `from` or a `from` of the trip goes to `#/trip/<id>`, labelled with the title. Without it, it behaves as today (the Plan), which is what `item.js` keeps.
  - `BACK` in `file.js`: `{ plan: t\`Plan\`, booking: t\`Details\`, item: t\`Details\`, now: t\`Now\`, trip: t\`Back to trip\`, talk: t\`Conversation\` }`. `cameFrom` itself is unchanged: `trip` passes its trip-id check, and `talk` passes when the trip is the open one.
  - `renderBooking(ctx, route)`: the screen below. Task 5 adds its Delete.

**The screen** (`route.params.path` = `p`, `here = bookingHref(id, p, route.params.from)`):
- The scope isn't a trip → today's "This trip isn't on this device" screen.
- `d = fileDetails(await readTripFiles(ctx.ws, ctx.store, id), p)` is null:
  - `p` under `/files/` → h1 `` t`This file isn't in the trip` `` and `` t`It may have been deleted or renamed.` ``;
  - else today's pair ("This booking isn't in the trip", …).
- **Crumb:** `backCrumb(ctx, id, route.params.from, { trip: scope.title })`.
- **h1 (`.title`, `dir=auto`):** `d.file.name`, else the lone booking's title, else its kind word (`BOOKING_KINDS[kind] ?? t\`Booking\``). Add `checkMark()` when the heading is that booking's own title and `checkOf(booking).fields` includes `title`.
- **Under h1:** with no blocks and no `made`, `p.sub` with `fileLine(d.file.became)` when that isn't `''`.
- **Each block** is `section.booking-block`, in order.
  - **Several blocks:**
    - an `h2.section` with `id="block-<i>"` and `tabindex="-1"`, whose text is the title (plus `checkMark()` when the title is unsure), else `kind · day(day, true)`;
    - the section gets `aria-labelledby` that id;
    - then `p.sub` `kind · day(day, true)`.
  - **One block:** the `p.sub` kind · day line. Before it, an `h2.section` with the title (plus check mark) only when the title is not blank and differs from the h1.
  - **Then, as today's booking details:**
    - the `check-banner` note when `checkOf(b).whole`;
    - `dl.facts` from `bookingFacts(b, { fallbackTz })`, with `checkMark()` on unsure facts.
  - **When `items` isn't empty:** `section.block-items` with `aria-label` "On the plan" and a heading `` t`On the plan` ``. The heading is an h3 with several blocks and an h2 with one. Each item is a `li`:
    - `a[href=itemHref(id, item.path, here)]` with `[title || t\`Plan item\`, day ? day(day, true) : null].filter(Boolean).join(' · ')`;
    - then `p.sub.notes` with its notes when it has any.
  - **Several blocks only:** `div.acts` with Open in Maps (when `place.name`, as today) and `a.btn` "Change it" → `fileHref(id, b.path, here)`.
- **`made` not empty:** a `section` with `aria-label` and an `h2.section` reading `` t`Plan items from a calendar` ``, listing the items as above.
- **File present:** `section.original` with `aria-label` `` t`The original` ``:
  - `await filePreview(ctx, id, file.path, { name: file.name })`;
  - then `p.sub` `` t`From ${file.real}` ``.
- **Lone booking:** when its `inTrip(source)` matches `/^\/files\/[^/]+$/` (so the file is gone), `p.sub.warn` with today's `` t`The original, ${shortName(names, src)}, isn't in the trip.` ``. Nothing otherwise.
- **The foot, `div.acts`, in this order:**
  1. File present: `a.btn` `` t`Open` `` → `fileHref(id, file.path, here)`.
  2. File present: `button.btn` `` t`Download` ``. Its `onclick` calls `saveFile(blob, file.real)`, with the `Blob` built from **one `ctx.ws.read` at render**: a share sheet needs the tap's fresh activation.
  3. `askAboutButton(ctx, refs)`. The refs are the file (`name: file.name`) when present, then each block's booking (`name`: title, else kind word).
  4. "Change it":
     - one block → `fileHref(id, b.path, here)`;
     - no block and `isTextType(file.type)` → `fileHref(id, file.path, here)`;
     - otherwise none.
  5. One block with a place: Open in Maps.
  6. (Task 5 adds Delete last.)
- **Focus (spec goal 6):** when `d.focus` names a block and there are several, `requestAnimationFrame(() => { if (h2.isConnected) { h2.scrollIntoView({ block: 'start' }); h2.focus({ preventScroll: true }); } })` after building. The shell's own `scrollTo` runs before that frame.
- `original()` (now used only by `item.js`):
  - Its button links to `bookingHref(id, entry.path, here)` when `entry.path` is under `/files/`, else to `fileHref` as today. It keeps its label "Open the original".
  - Drop its `none` option and the "This booking doesn't say which file it came from." line. `item.js` always passes `none`, and with no file named it returns `null`.
- Remove the now-unused `itemNotes`.

- [ ] **Step 1: Write the failing e2e tests** in `test/e2e/file-details.spec.js` (all from `fileTrip`; set `localStorage['annai.forceDownload'] = '1'` before Download):

```js
test('a file with two flights: one screen, two blocks in time order, each with its heading, facts and Change it; Fly home under the second; the preview, Open, Download, Ask with the file and both flights', async ({ page }) => {
  // Trip → the itinerary's row.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ANNAI AIR itinerary');
  await expect(page.locator('.booking-block h2')).toHaveText(['ANNAI AIR AN 123', 'ANNAI AIR AN 124']);
  const second = page.getByRole('region', { name: 'ANNAI AIR AN 124' });
  await expect(second.locator('dl.facts .mark-check')).toHaveCount(1); // the seat
  await expect(second.getByRole('region', { name: 'On the plan' })).toContainText('Fly home');
  await expect(second.getByRole('region', { name: 'On the plan' })).toContainText('Terminal S.');
  await expect(page.getByRole('link', { name: 'Change it' })).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'The original' })).toContainText('From itinerary.pdf');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  expect((await downloading).suggestedFilename()).toBe('itinerary.pdf');
  await page.getByRole('button', { name: 'Ask Shiori about this' }).click();
  await expect(page.locator('.type-sheet .attach-chip .attach-name')).toHaveText(['ANNAI AIR itinerary', 'ANNAI AIR AN 123', 'ANNAI AIR AN 124']);
});

test('a link to the second flight opens the file at its block, focused and in view', async ({ page }) => {
  // goto #/trip/<id>/booking?path=%2Fbookings%2Fback.json
  const h = page.getByRole('heading', { name: 'ANNAI AIR AN 124' });
  await expect(h).toBeFocused();
  await expect(h).toBeInViewport();
});

test('one booking reads as the booking details did: the stay, its photo as the preview, Change it and Open in Maps at the foot; Open shows the photo', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hotel Aurora Test');
  await expect(page.getByRole('heading', { name: 'Hotel Aurora Test' })).toHaveCount(1); // no second heading of the same title
  await expect(page.locator('dl.facts dt')).toHaveText(['Place', 'Check-in', 'Check-out', 'Nights']);
  await expect(page.locator('.original img.file-preview')).toBeVisible();
  await expect(page.locator('.screen > .acts').last().getByRole('link', { name: 'Change it' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in Maps' })).toBeVisible();
  await page.getByRole('link', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open the photo full size' })).toBeVisible();
});

test('a booking with no file: its block alone, no preview, Open or Download; its plan item listed though it has no notes', async ({ page }) => {
  // goto booking?path=%2Fbookings%2Fsaid.json
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Testville Grill');
  await expect(page.getByRole('region', { name: 'The original' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'On the plan' })).toContainText('Dinner at the grill');
  await expect(page.getByRole('link', { name: 'Change it' })).toHaveCount(1);
});

test('a calendar file lists its plan items with their days, each opening its item and coming back; Change it is its editor', async ({ page }) => {
  // Trip → walks.ics row.
  const made = page.getByRole('region', { name: 'Plan items from a calendar' });
  await expect(made.getByRole('link')).toHaveText(['Aurora walk · Sun, Nov 22']);
  await made.getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Aurora walk' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Details' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('walks.ics');
  await page.getByRole('link', { name: 'Change it' }).click();
  await expect(page.locator('#file-content')).toHaveValue(/BEGIN:VCALENDAR/);
});

test('a file waiting to be read says so, with Open, Download and Ask, and no Change it', async ({ page }) => {
  // Trip → new.pdf row.
  await expect(page.locator('.screen > .sub').first()).toHaveText('Waiting for Shiori to read it');
  await expect(page.getByRole('link', { name: 'Open', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change it' })).toHaveCount(0);
});

test("a link to a file that isn't there says so", async ({ page }) => {
  // goto booking?path=%2Ffiles%2Fnope.pdf
  await expect(page.getByRole('heading', { name: "This file isn't in the trip" })).toBeVisible();
});
```

  Fill in the navigation (marked by comments) with `fileTrip`, the Files row link, or `page.goto`.

- [ ] **Step 2: Write the failing unit test** for `cameFrom` in `test/unit/ui-pure.test.js` (import from `../../src/ui/screens/file.js`):

```js
test('cameFrom: the trip, the Conversation, the Plan, Now, an item, and an old booking crumb', () => {
  assert.deepEqual(cameFrom('#/trip/t-1', 't-1', 't-1'), { hash: '#/trip/t-1', name: 'trip' });
  assert.equal(cameFrom('#/trip/t-2', 't-1', 't-1'), null); // another trip's screen
  assert.deepEqual(cameFrom('#/talk', 't-1', 't-1'), { hash: '#/talk', name: 'talk' });
  assert.equal(cameFrom('#/talk', 't-1', 't-2'), null); // the Conversation is another trip's now
  assert.deepEqual(cameFrom('#/trip/t-1/booking?path=%2Fbookings%2Fa.json', 't-1', null)?.name, 'booking');
  assert.equal(cameFrom('#/settings', 't-1', 't-1'), null);
});
```

  If `file.js` can't be imported under node, move `cameFrom` (not `BACK`) into `src/ui/router.js`, re-export it from `file.js`, and say so in Calls.
- [ ] **Step 3: Run them and see them fail.**
- [ ] **Step 4: Implement** the screen, `askAboutButton`/`askAbout`, `backCrumb`'s `o.trip`, `BACK` and `original()` as specified. CSS: give `.booking-block + .booking-block` a top margin and a rule matching the existing section rules. No new layout system. Check it at 320 px.
- [ ] **Step 5: Update the existing tests** for the screen:
  - **The raw screen's crumb:** "Booking" → "Details" everywhere.
  - **"Open the original" on the details screen → `{ name: 'Open', exact: true }`.** In `evening.spec.js`, step 5 then lands on the raw screen with its short-name heading, as now.
  - **"From <short name>" → "From <real file name>"** (`evening.spec.js`).
  - **Ask from a booking whose file exists** gives two chips, the file's short name then the booking's title (`evening.spec.js`). `hand-over.spec.js`'s `flightDetails` writes no file, so one chip stays.
  - **`plan.spec.js` notes test:** region "Notes" → "On the plan".
  - **`hand-over.spec.js` named-file test:** the row opens the details screen, which shows the short name as h1 and "From flight.pdf". Its "File name: flight.pdf" and path assertions move to the raw screen, reached with Open.
  - **`phone-fixes.spec.js` item 8:** "Open the original" → "Open". "From the trip's own files" now taps the Files row (named "Avis TESTCAR1", the booking's title), lands on the details screen with the Trips tab current, and its crumb (the trip's title "Alaska") goes back to the trip.
  - **`plan.spec.js` first details test:** its last crumb is still "Plan" only after Task 4. Leave that line failing here, or move it to Task 4.
- [ ] **Step 6: Strings.**
  - New: `On the plan`, `This file isn't in the trip`.
  - Dropped: `This booking doesn't say which file it came from.`
  - Changed use: `Details` (update its Note).
- [ ] **Step 7: Run** e2e `file-details.spec.js plan.spec.js original.spec.js evening.spec.js hand-over.spec.js phone-fixes.spec.js phone-fit.spec.js trips.spec.js`, unit `ui-pure`, typecheck, and the strings check. Expected: PASS, except lines that need Task 4's `from` (name them).
- [ ] **Step 8: Commit** (after `npm run stamp`): "One details screen for a file and the bookings Shiori read from it".

---

### Task 4: Links in, and Back from every origin

**Files:**
- Modify: `src/ui/format.js` (`recordHref`, `bookingHref`'s doc), `src/ui/screens/plan.js`, `src/ui/cards.js`, `src/ui/screens/talk.js`, `src/ui/screens/item.js`
- Test: `test/unit/ui-pure.test.js`, `test/e2e/file-details.spec.js`. Update `test/e2e/plan.spec.js` (~372, the card test's crumb), `test/e2e/hand-over.spec.js` (the chip `href`).

**Interfaces:**
- Consumes: the screen and `BACK` (Task 3).
- Produces:
  - `recordHref(id, path, from)` sends `/^\/files\/[^/]+$/` to `bookingHref(id, path, from)`. It keeps bookings → `bookingHref`, plan items → `itemHref`, and anything else → `fileHref`.
  - `bookingHref`'s doc now says: "a trip file's or booking's details; `from` is the screen its crumb goes back to (the trip, the Plan, Now, the Conversation, a plan item's details), else the trip".

**Changes:**
- **`plan.js`:** `const here = route.parts[0] === 'trip' ? \`#/trip/${encodeURIComponent(id)}/plan\` : '#/plan'`. Pass it to `timetable` and `row`, and use `detailsHref(id, r, here)` for the row link and both Check chips.
- **`cards.js`:** `bookingHref(ctx.agent.trip, booking.path, location.hash)` (in the Conversation, `#/talk`; in Now, `#/now`).
- **`talk.js`:** `recordHref(where, m[2], '#/talk')`.
- **`item.js`:** "Booked: …" → `bookingHref(id, ref, here)`.

- [ ] **Step 1: Write the failing unit test** for `recordHref`:

```js
test('recordHref: a file the user gave and a booking open the details screen; a plan item its own; anything else the raw file', () => {
  assert.equal(recordHref('t-1', '/files/a.pdf', '#/talk'), '#/trip/t-1/booking?path=%2Ffiles%2Fa.pdf&from=%23%2Ftalk');
  assert.match(recordHref('t-1', '/bookings/a.json'), /\/booking\?path=%2Fbookings%2Fa\.json$/);
  assert.match(recordHref('t-1', '/plan/a.json'), /\/item\?path=/);
  assert.match(recordHref('t-1', '/files/scans/a.pdf'), /\/file\?path=/);
  assert.match(recordHref('t-1', '/notes/a.md'), /\/file\?path=/);
});
```

- [ ] **Step 2: Write the failing e2e test.** One test per origin, in `file-details.spec.js`:

```js
test('Back from the trip: the crumb names the trip', async ({ page }) => {
  // Trip → Hotel Aurora Test row → crumb "Anchorage" → the trip's h1 "Anchorage".
});
test('Back from the Plan: a tap on the return flight lands on its block, and the crumb goes back to the Plan', async ({ page }) => {
  // Plan → tab "Fri, Nov 27" → the row link /Fly home/ (the item standing for the return flight; check which row the Plan draws for it) → heading ANNAI AIR AN 124 focused → crumb "Plan" → h1 "Plan".
});
test('Back from Now and from the Conversation', async ({ page }) => {
  // goto booking?path=%2Fbookings%2Fstay.json&from=%23%2Fnow → crumb "Now" → expect(page).toHaveURL(/#\/now$/)
  // goto booking?path=%2Fbookings%2Fstay.json&from=%23%2Ftalk → crumb "Conversation" → expect(page).toHaveURL(/#\/talk$/)
});
test("Back from a plan item's details, both ways; Open and Change it come back here", async ({ page }) => {
  // itinerary → "Fly home · …" link → item h1 "Fly home" → its "Booked: ANNAI AIR AN 124" → details, block 2 focused → crumb "Details" → item h1 "Fly home".
  // From the item: crumb "Details" → itinerary's h1. Open (exact) → raw screen → crumb "Details" → h1 "ANNAI AIR itinerary". Same for the first block's Change it.
});
test('an old booking link with no from goes back to the trip', async ({ page }) => {
  // goto booking?path=%2Fbookings%2Fback.json (no from) → crumb "Anchorage" → h1 "Anchorage".
});
```

  Write each step's `click` and `expect` as the comment says. The crumb is `page.getByRole('main').locator('.crumbs a')`; assert its text, then click it.
- [ ] **Step 3: Run them and see them fail.**
- [ ] **Step 4: Implement** the changes above.
- [ ] **Step 5: Update the existing tests.**
  - `plan.spec.js` card test: after "Open the booking", its crumb is "Conversation". Go to the Plan through the top bar: `page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plan' })`.
  - `hand-over.spec.js` chip test: the `href` still matches `/\/booking\?path=/`, and add `/from=%23%2Ftalk/`.
  - `plan.spec.js` first details test: its final crumb "Plan" now passes.
- [ ] **Step 6: Run** unit `ui-pure`; e2e `file-details.spec.js plan.spec.js hand-over.spec.js now.spec.js phone-fixes.spec.js`; typecheck. Expected: PASS.
- [ ] **Step 7: Commit** (after `npm run stamp`): "Links into the details screen say where they came from; Back goes there".

---

### Task 5: Delete

**Files:**
- Create: `src/ui/file-delete.js`
- Modify: `src/ui/screens/booking.js` (the Delete button), `src/ui/screens/file.js` (Delete for `/files/`)
- Test: `test/unit/ui-pure.test.js`, `test/e2e/file-details.spec.js`

**Interfaces:**
- Consumes: `readTripFiles`, `fileDetails`, `deletionOf`, `Details` (Task 1); the screen (Task 3).
- Produces, in `src/ui/file-delete.js`:

```js
/** "2 bookings", "1 plan item": the parts saying what else a Delete removes; none when nothing. @param {number} bookings @param {number} items @returns {string[]} */
export function countParts(bookings, items)
/**
 * Where Delete goes: back, unless back is a screen of something just deleted (its route's `path` param, `/trip` stripped, is one of
 * gone: a plan item's details, this file's raw or details screen), then the trip. @param {string} back @param {string[]} gone @param {string} id
 */
export function afterDelete(back, gone, id)
/**
 * Deletes what a details screen showed (spec goal 4): deletionOf(d)'s paths that are still in the trip, in one ws.writeMany of null
 * contents (author 'user'), then toasts what went. Returns the paths deleted. A failure is explained (explainStorageFull, else a
 * toast of messageOf(e)) and deletes nothing. @param {any} ctx @param {string} id @param {Details} d @param {string} name what the toast calls it
 * @returns {Promise<string[] | null>} null when it failed
 */
export async function deleteDetails(ctx, id, d, name)
```

**Rules:**
- **The toast:**
  - with a file: `` t`Deleted ${list([name, ...countParts(bookings.length, items.length)])}` ``, so "Deleted ANNAI AIR itinerary, 2 bookings, and 1 plan item";
  - without one: the same with `countParts(0, items.length)`, so "Deleted Testville Grill and 1 plan item".
  - Counts are of what was actually deleted: shown and still there.
- **The details screen:**
  - **Placement:** `twoStep(t\`Delete\`, t\`Tap again to delete\`, …)` is the foot's last button.
  - **Its action:** `const gone = await deleteDetails(ctx, id, d, heading)`. If `gone` isn't null, `ctx.go(afterDelete(back, gone, id))`, where `back` is the crumb's target hash.
- **The raw file screen** (`file.js`), for a path matching `/^\/files\/[^/]+$/` only:
  1. Compute `d = fileDetails(await readTripFiles(ctx.ws, ctx.store, id), path)`.
  2. When `countParts(d.blocks.length, deletionOf(d).items.length)` isn't empty, show `p.sub` `` t`Deleting this file also deletes ${list(parts)}.` `` just above the Delete button.
  3. The button stays "Delete file" / "Tap again to delete". Its action is `deleteDetails(ctx, id, d, d.file.name)`, then `ctx.go(afterDelete(back, gone, id))`.

  Any other path keeps today's `ws.delete` and `ctx.go(back)`.
- Names: `syncNames` already drops a deleted file's short name on its delete event. `writeMany` emits one per path. Don't add anything for it.

- [ ] **Step 1: Write the failing unit tests:**

```js
test('afterDelete: back where it came from, unless that screen was of something deleted', () => {
  const gone = ['/files/a.pdf', '/bookings/a.json', '/plan/a.json'];
  assert.equal(afterDelete('#/trip/t-1/plan', gone, 't-1'), '#/trip/t-1/plan');
  assert.equal(afterDelete('#/now', gone, 't-1'), '#/now');
  assert.equal(afterDelete('#/talk', gone, 't-1'), '#/talk');
  assert.equal(afterDelete('#/trip/t-1', gone, 't-1'), '#/trip/t-1');
  assert.equal(afterDelete('#/trip/t-1/item?path=%2Fplan%2Fa.json', gone, 't-1'), '#/trip/t-1');
  assert.equal(afterDelete('#/trip/t-1/item?path=%2Fplan%2Fb.json', gone, 't-1'), '#/trip/t-1/item?path=%2Fplan%2Fb.json');
  assert.equal(afterDelete('#/trip/t-1/booking?path=%2Ftrip%2Ffiles%2Fa.pdf', gone, 't-1'), '#/trip/t-1');
});

test('countParts: what else goes, in words', () => {
  assert.deepEqual(countParts(2, 1), ['2 bookings', '1 plan item']);
  assert.deepEqual(countParts(0, 3), ['3 plan items']);
  assert.deepEqual(countParts(0, 0), []);
});
```

- [ ] **Step 2: Write the failing e2e tests** (each from `fileTrip`):

```js
test('Delete removes the file, its bookings and their plan items, says what went, and goes back to the trip', async ({ page }) => {
  // Trip → itinerary row → Delete → "Tap again to delete".
  await expect(page.getByText(/^Deleted ANNAI AIR itinerary, 2 bookings,? and 1 plan item$/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
  await expect(page.getByRole('region', { name: 'Files', exact: true }).locator('.trip-file .name')).toHaveText(['Hotel Aurora Test', 'new.pdf', 'walks.ics']);
  // Plan, tab "Fri, Nov 27": no ANNAI AIR AN 124, no Fly home; the stay's check-out is still there.
  // A Back (page.goBack()) onto the deleted file's screen says "This file isn't in the trip".
});
test('Delete from a screen opened from the Plan goes back to the Plan; from an item that went, to the trip', async ({ page }) => {
  // Plan → "Check in · Hotel Aurora Test" → Delete twice → URL ends /plan.
  // Plan → tab "Sun, Nov 22" → "Aurora walk" → item → "Open the original" → walks.ics details → Delete twice → h1 "Anchorage".
});
test('a booking with no file: Delete removes it and its plan item', async ({ page }) => {
  // goto booking?path=%2Fbookings%2Fsaid.json → Delete twice → toast /^Deleted Testville Grill and 1 plan item$/ → h1 "Anchorage";
  // then goto item?path=%2Fplan%2Fgrill.json → "This isn't on the plan".
});
test('the raw file screen says what else its Delete removes, and removes it', async ({ page }) => {
  // Trip → All files (allFiles(page)) → link /\/files\/itinerary\.pdf/ → expect text "Deleting this file also deletes 2 bookings and 1 plan item."
  // → "Delete file" → "Tap again to delete" → toast /^Deleted ANNAI AIR itinerary/ → h1 "Anchorage"; the Plan has no ANNAI AIR AN 123.
  // And a /notes/ file's raw screen shows no such line (create /notes/day1.md with the File path box).
});
```

  Write the clicks and expects as each comment says.
- [ ] **Step 3: Run them and see them fail.**
- [ ] **Step 4: Implement** `file-delete.js` and the two buttons as specified.
- [ ] **Step 5: Strings.** New: `Deleted {0}`, `# plan item`/`# plan items`, `Deleting this file also deletes {0}.`. `# booking`/`# bookings` came in Task 2.
- [ ] **Step 6: Run** unit `ui-pure`; e2e `file-details.spec.js trips.spec.js roundtrip.spec.js backups.spec.js`; typecheck; the strings check. Expected: PASS.
- [ ] **Step 7: Commit** (after `npm run stamp`): "Delete removes a file and what Shiori read from it, from either screen".

---

### Task 6: Gates and screenshots

**Files:**
- Modify: `scripts/size.mjs` (only if needed)
- Create (gitignored, not committed): `.superpowers/evidence/file-details/shots.config.js`, `.superpowers/evidence/file-details/shots.spec.js`, and the PNGs and logs

- [ ] **Step 1: Size.** Run `npm run size`.
  - If it is over budget, set `BUDGET` to the smallest whole KiB at or above the measured size.
  - Append `; <N> for one entry per file and one details screen (file-details)` to its comment.
  - Note the old value, the new value and the measured size for the handoff.
- [ ] **Step 2: Stamp.** Run `npm run stamp` and stage what it changed.
- [ ] **Step 3: Check.** Run from the worktree:

  ```
  NODE_OPTIONS=--max-old-space-size=2048 timeout 1500 systemd-run --scope -q -p MemoryMax=6G npm run check 2>&1 | tee .superpowers/evidence/file-details/check.log
  ```

  Expected: green, with no warnings left unexplained.
- [ ] **Step 4: E2e, the whole suite:**

  ```
  docker run --rm --memory=6g --ipc=host -v "$PWD":"$PWD" -v /mnt/optane/work/annai/node_modules:/mnt/optane/work/annai/node_modules:ro -w "$PWD" mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test --workers=4 2>&1 | tee .superpowers/evidence/file-details/e2e.log
  ```

  Expected: green. Main had 1036 passed and 20 skipped. Report the new counts. A failure is fixed at its cause, never by loosening an assertion that checks what the spec asks for.
- [ ] **Step 5: Screenshots.**
  - **The config:** `shots.config.js` imports the repo's `playwright.config.js` and spreads it. It sets:
    - `testDir` to its own folder;
    - `webServer.cwd` to the worktree root (`new URL('../../..', import.meta.url).pathname`);
    - one project, `{ name: 'webkit', use: { ...devices['iPhone 15'], viewport: { width: 390, height: 844 } } }`.
  - **The spec:** `shots.spec.js` imports `fileTrip` from `../../../test/e2e/file-details-fixture.js` and `openApp` from the helpers. For each language in `['en', 'ja']` and each colour scheme in `['light', 'dark']`:
    1. Set `localStorage['annai.ui']` to the language, and `page.emulateMedia({ colorScheme })`.
    2. Build the trip with `fileTrip`.
    3. Save three full-page screenshots to `.superpowers/evidence/file-details/`:
       - `files-<lang>-<scheme>.png`: the trip screen, scrolled so Files shows;
       - `one-<lang>-<scheme>.png`: Hotel Aurora Test's details;
       - `two-<lang>-<scheme>.png`: the itinerary's details.
  - **Run it:** `docker run … npx playwright test --config .superpowers/evidence/file-details/shots.config.js --workers=2`. Expected: 12 PNGs. Open two or three to check they show the right screens. A reviewer judges them later.
- [ ] **Step 6: Commit** `scripts/size.mjs` and the stamp output, if they changed: "Raise the shipped-size budget for the file details screen".

---

## Calls to confirm (the plan's; the builder repeats them and adds its own)

1. **The route:** the existing `#/trip/<id>/booking?path=` now also takes a file under `/files/`. A booking path opens its file's screen at its block. There is no new route and no alias.
2. **The crumb label** back to this screen, from the raw file screen and from a plan item, changes from "Booking" to "Details".
3. **`askAboutButton`/`askAbout` take one ref or several.** Ask on a file's screen attaches the file and each of its bookings, so a booking with a file now gives two or more chips where it gave one.
4. **The labels kept from today:**
   - "Change it" (the spec says "Change");
   - "Open" for the whole file (it was "Open the original" on the booking details, which the plan item's details keep);
   - "Delete" on the details screen, "Delete file" on the raw screen.
5. **The raw file screen's Delete** for a `/files/` file says what else goes ("Deleting this file also deletes 2 bookings and 1 plan item."). The plan adds this so it doesn't break the spec's anti-goal "Deleting something the user didn't see on the screen they deleted from".
6. **Back after Delete** goes to the trip only when the screen it would go back to was a screen of something deleted (a plan item's details, this file's screens). The Plan, Now, the Conversation and the trip are returned to as they are.
7. **A plain photo** opened by its address (a Conversation chip) gets the details screen, though Files doesn't list it.
8. **A booking whose `/files/` source is gone** keeps today's line "The original, X, isn't in the trip." A booking whose source isn't under `/files/` shows nothing about a file. The line "This booking doesn't say which file it came from." is gone.
9. **The list order** counts bookings' days only (spec My call 1), so a calendar file sorts with the undated files.
10. **The mixed-kinds second line** reads "1 flight · 1 stay".
11. **The size raise** (Task 6), in KiB.
