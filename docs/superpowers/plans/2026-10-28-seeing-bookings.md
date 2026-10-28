# Seeing Bookings: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every booking is on its day on the Plan: a flight with each airport's own times, a stay with its check-in, a quiet line on each night between, and its check-out, and anything with no day under "Not on a day". A tap opens its details first: what Shiori read (with a light "check" on just the fields she is unsure of), the file's preview with Open the original, Ask Shiori about this, and Change it. The trip has a Files section listing what each file became, with All files folded below it. There is no confirming step.

**Architecture:**
- **Uncertainty is per field, as data.** A booking Shiori writes now always carries `unsure: string[]` (`[]` when she is sure). A booking without that key is an old record. An old `unverified` one is marked whole ("Check this") until she is told it's right and writes `unsure: []`. One function, `checkOf`, decides the marks everywhere.
- **The Plan's rows come from plan items and bookings.** `planRows` adds a row for every booking no plan item stands for (a stay's check-out too), night lines for a stay, and `notOnDay` for a booking with no time. Every row links to a details screen: a booking's (`booking.js`, redone) or a plan item's (`item.js`, new).
- **Previews go through one function,** the "Reading files" plan's `previewOf(file, { registry })` in `src/ui/preview.js`, which returns an image URL or null. Safari draws a PDF's first page in an `<img>`, and the PDF-pages plugin draws one anywhere; otherwise the screen shows a file card. This plan wraps it once, as `filePreview(ctx, scope, path)`.
- **Files and short names use the handing-over plan's data** (`readNames`, `shortName`, `HandedFile`, `askAbout`). This plan only shows them.

**Tech Stack:** native ES modules, no build step, JSDoc checked by TypeScript 6.0.3; `node:test`; Playwright 1.63.0 in Docker (Chromium as Pixel 7, WebKit as iPhone 15). No new dependencies, and no PDF library.

**Spec:** `docs/superpowers/specs/2026-10-28-bookings-and-trips-design.md` (goals 5–9, My calls 1, 4 and 5, and the short names' display from goal 10). The main spec is `docs/superpowers/specs/2026-10-15-annai-design.md` (§4.4, §7.3, §8, §16.2).

**Starts from:** main **after phone-fixes-1 and the handing-over plan** (`docs/superpowers/plans/2026-10-28-handing-over.md`) have both merged. It uses phone-fixes-1's `fileHref(id, path, from)` and `cameFrom(from, id)` (`src/ui/screens/file.js`), and its tab highlight (`SECTION` in `src/ui/shell.js`). From handing-over it uses `SYS_WAITING`, `HandedFile`, `readNames`, `shortName`, `NAMES_FILE`, `askAbout`, `canAsk`, `ctx.dock.attach` with `suggestions`, `filesToRead`, `keepFiles`, `bringIn`, `handOverText`, and the booking fixtures in `test/fixtures/bookings/`. Tasks marked **[after phone-fixes-1]** change files that branch changed; tasks marked **[after handing-over]** change files that plan changed. A builder rebases onto main first.

**Boundary with "Reading files":** that plan makes any file readable whatever the roles' abilities, and adds an optional plugin that gives a PDF's first page as an image. Nothing here reads a file's content beyond counting a PDF's pages (Task 4). `previewOf` (theirs, `src/ui/preview.js`: `previewOf(file: Blob, { registry, signal })`, `imgDrawsPdf()`) is the one place a preview is decided. Whichever plan lands first creates that file with those signatures (Task 4).

---

## Global Constraints

- **The platform:** a browser-only, local-first PWA. The main target is the iPhone's Safari as a Home Screen app, with Android Chrome and desktop browsers also supported. The browser floor is iOS 16.4 Safari.
- **"PDF preview without a new dependency in annai's own code. Safari draws a PDF's first page in an `<img>`. Elsewhere, without the plugin of goal 12, the preview is a file card (an icon, the name, the page count when known). Open the original uses the browser's own viewer for the file."**
- **"A screen that shows raw JSON as the first thing a tap opens"** is a failure, even if it works.
- **"The records stay as they are (spec §4.4), extended rather than replaced: a booking keeps `status` (`unverified`/`confirmed`) and `source` (the path of the file it came from); plan items keep their shape; … old trips and bookings keep working."**
- **A new record always writes the field that tells it from an old one** (LESSONS 2026-10-27). Tell old from new with `'unsure' in b`, never with its value.
- **Screens in English, Japanese and Chinese (Simplified).** Every new user-facing message goes through `t`, `tc` or `plural`, with ja and zh-Hans rows in `l10n/*.tsv` marked `ok`, with notes. A model's words (tool text, `[annai]` lines, instructions) stay English, marked `/* en */`. What Shiori wrote in a record (a hotel's name, a seat) is shown as written, with `dir="auto"`. Field keys are data: known keys get words, and an unknown key is shown as written with `lang="en"`.
- **Store data, not words;** pass data between modules and make sentences where they are shown (LESSONS 2026-10-26).
- **Photos are not listed in Files** (My call 4). **"The trip screen's list of every file by folder stays, folded under 'All files' below the Files section"** (My call 5).
- **Accessible as built:** every tappable row is a real link or button; the details screen reads in order (what, when, where, the facts, the file, the actions); "check" marks have words for screen readers. E2e locators stay English.
- **Tests, commits, size, l10n:** as in the handing-over plan's Global Constraints. Unit: `node --test --test-timeout=60000 --import ./test/unit/pin-phone.js test/unit/<file>.test.js`. Full check: `NODE_OPTIONS=--max-old-space-size=2048 timeout 1500 systemd-run --scope -q -p MemoryMax=6G npm run check`. E2e: `timeout 1500 docker run --rm --memory=6g --ipc=host -v "$PWD":"$PWD" -v /mnt/optane/work/annai/node_modules:/mnt/optane/work/annai/node_modules:ro -w "$PWD" mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test <spec>`. Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QG96wHTW1xUckqei4MC5Bi
  ```
- **Test files are synthetic** (`test/fixtures/bookings/`, made by `scripts/make-booking-fixtures.mjs`). A check against a user's real confirmation is a manual, local-only step (Task 9), and that file never enters the repo.

## Review Focus

1. **A booking with a broken time** (no time zone, an unknown one, `at` with no offset, or `end` before `start`): it still shows on the Plan, in the trip's zone, with the note the Plan gives a plan item today. It is never dropped, and a stay gets no nights. Test in Task 2.
2. **A stay of 0, 1 or 200 nights:** no night lines for 0 or 1; at most 60 (the Plan's day cap) for a long one. Test in Task 2.
3. **A booking whose file is gone** (deleted, moved to another trip, never there): the details screen says so in words and shows no preview, and Ask Shiori about this still works for the booking. Test in Task 5.
4. **A large or odd PDF** (30 MB, a scan with compressed page objects, a file named .pdf that isn't one): the preview never freezes the page. The page count is read from the first 2 MiB only, or left out. Test in Task 4.
5. **`unsure` naming a field that isn't there, or a booking edited by hand to an odd shape:** unknown names mark nothing, and nothing throws. Test in Task 1.

---

### Task 1: Per-field uncertainty in a booking **[after handing-over]**

My call 1: "There is no confirming step… Only a field she is unsure of gets a light 'check' mark… a booking's uncertainty is now per field, kept as data… Old `unverified` bookings show with their whole booking marked, until the user tells her it's right."

**Files:**
- Modify: `src/plugins/core-schemas/schemas.js` (`BOOKING_SCHEMA`), `src/core/bookings.js` (`shioriBooking`, new `checkOf`), `src/core/agent/instructions.js` (`CORE`'s booking line), `src/core/handover.js` (`handOverText`'s booking sentence), `src/core/imports.js` (`newFilesText`'s booking sentence), `test/unit/bookings.test.js`, `test/unit/plugin-files.test.js`, `test/unit/agent-handover.test.js`

**Interfaces:**
- Produces:
  - `BOOKING_SCHEMA.properties.unsure = { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 30 }`.
  - `checkOf(b: any): { whole: boolean, fields: string[] }`: `whole` is true for an old record (no `unsure` key) whose `status` isn't `'confirmed'`. `fields` holds the strings in `unsure` that name a booking field: a top-level key (`start`, `end`, `place`, `confirmation`, `cost`, `title`) or a `fields` key, as written. A non-array `unsure` gives `[]`.
  - `shioriBooking(before, next)`: a booking Shiori writes new (no `before`) without the `unsure` key is refused with `/* en */ 'A new booking lists the fields you are unsure of in unsure (an empty list when you are sure of all of them), so the user sees what to check.'`. Changing an old one needs no `unsure`. The rules already in place stay: she can't set `confirmed`, and her change to a confirmed one sends it back to `unverified`.
  - `CORE`'s line "A booking you write is unverified until the user confirms it. Ask only about what you are unsure of." becomes: write each booking with `unsure` naming just the fields you are not sure of; ask about only those; when the user says one is right, take it out of `unsure` (an old booking without `unsure`: write `unsure: []`).
  - The booking sentence in `handOverText` and `newFilesText` says the same, and stops asking for "an unverified booking". The rest of `handOverText` is the handing-over plan's.

- [ ] **Step 1: Write the failing tests:**

```js
// bookings.test.js
test('checkOf: an old unverified booking is marked whole; an old confirmed one not at all; a new one by its unsure fields', () => {
  assert.deepEqual(checkOf({ kind: 'flight', status: 'unverified' }), { whole: true, fields: [] });
  assert.deepEqual(checkOf({ kind: 'flight', status: 'confirmed' }), { whole: false, fields: [] });
  assert.deepEqual(checkOf({ kind: 'flight', status: 'unverified', unsure: ['seat', 'end'], fields: { seat: '14C' }, end: { at: '2026-11-20T14:05:00-09:00', tz: 'America/Anchorage' } }), { whole: false, fields: ['seat', 'end'] });
  assert.deepEqual(checkOf({ kind: 'flight', status: 'unverified', unsure: [] }), { whole: false, fields: [] });
});
test('checkOf: an unsure name that is no field, or an unsure that is not a list, marks nothing and throws nothing', () => {
  assert.deepEqual(checkOf({ kind: 'other', status: 'unverified', unsure: ['wings'] }), { whole: false, fields: [] });
  assert.deepEqual(checkOf({ kind: 'other', status: 'unverified', unsure: 'seat' }), { whole: false, fields: [] });
});
test("shioriBooking: a new booking without unsure is refused in words; an old one's change needs none", () => {
  assert.throws(() => shioriBooking(undefined, { id: 'b', kind: 'flight', status: 'unverified', source: '/files/f.pdf' }), /unsure/);
  assert.doesNotThrow(() => shioriBooking({ id: 'b', kind: 'flight', status: 'unverified', source: '/files/f.pdf' }, { id: 'b', kind: 'flight', status: 'unverified', source: '/files/f.pdf', confirmation: 'TESTQ1' }));
});
// plugin-files.test.js
test("bookings: Shiori's new booking needs unsure; the schema takes a list of names", async () => {});
// agent-handover.test.js
test("handOverText's booking sentence asks for unsure, not for an unverified booking to confirm", () => {
  assert.doesNotMatch(handOverText([pdf]), /until the user confirms/);
  assert.match(handOverText([pdf]), /unsure/);
});
```
Update the existing `bookings.test.js` and `plugin-files.test.js` tests that write new bookings so their records carry `unsure: []`.

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass**, then the full check (the agent suites quote `CORE`).
- [ ] **Step 5: Commit** the files above by name ("Shiori marks only the fields of a booking she is unsure of"). Add a LESSONS.md entry for the §7.3 change. What changed: a new booking no longer waits for the user to confirm it whole; it lists `unsure` fields. Why: the user wants no confirming step. What was wrong: one flag stood for "Shiori read this" and "every field may be wrong", so the user had to check everything to clear it.

---

### Task 2: The Plan's rows from bookings

Goal 5: "a flight on the day it leaves, with times in each airport's own time zone; a stay on its check-in and check-out days, plus a quiet 'Staying at Hotel Aurora Test · night 2 of 3' line on the nights between; a booking with no day of its own … at the top of the Plan, under 'Not on a day'."

**Files:**
- Modify: `src/core/plan.js` (`PlanRow`, `planRows`, `planDays`), `test/unit/plan.test.js`

**Interfaces:**
- Consumes: `checkOf` (Task 1).
- Produces:
  - `PlanRow` gains `from: 'item' | 'booking' | 'checkout' | 'night'`, `night: { n: number, of: number } | null` and `checkFields: string[]`. `check` now means `checkOf(booking).whole`, and `checkFields` holds `checkOf(booking).fields`. For a booking row, `path` is the booking's path and `item` is a view of the booking (`{ title, kind: 'booking', fixed: true, start, end, place }`), so `when`, legs and plugins' rows work unchanged.
  - `planRows(items, bookings, { fallbackTz })` adds, for each booking:
    - no plan item links it: a `booking` row at its `start` (on no day when it has none). A `lodging` booking also gets a `checkout` row at its `end`.
    - plan items link it: those rows, as today. A `lodging` booking also gets a `checkout` row at its `end`, unless a linked item falls on that day.
    - a `lodging` booking with a good `start` and `end` (in its own zone; `end` after `start`) gets `night` rows on each day strictly between check-in and check-out: `night: { n: 2 … N, of: N }`, where N is the number of nights. Night rows have `at: null`, `time: ''` and the check-in day's place. There are at most `NIGHTS_MAX = 60`.
  - `planDays(rows, trip)` returns `{ days, untimed, notOnDay }`. `notOnDay` holds the `booking` rows with no day, ordered by title. `untimed` stays plan items only. Within a day, `night` rows come first, before the day's other rows, as in the approved mockup 2b.
  - Now and Driving read `tripRows` → `planRows`. A night row has no `at`, so they never list it; a `booking` row does show as a next item. Keep that, and test it.

- [ ] **Step 1: Write the failing tests** in `test/unit/plan.test.js`, with a flight booking `{ kind: 'flight', start: { at: '2026-11-20T11:20:00-08:00', tz: 'America/Los_Angeles' }, end: { at: '2026-11-20T14:05:00-09:00', tz: 'America/Anchorage' } }` and a stay from `2026-11-20T15:00:00-09:00` to `2026-11-27T11:00:00-09:00` (`America/Anchorage`):

```js
test('a flight no plan item stands for is on the day it leaves, at its own clock, its arrival zone named', () => {
  const [r] = planRows([], [flight], { fallbackTz: 'UTC' });
  assert.deepEqual([r.from, r.day, r.time, r.end, r.endZone], ['booking', '2026-11-20', '11:20', '14:05', 'AKST']);
});
test('a stay: check-in, a night line on each day between (night 2 of 7 … 7 of 7), then check-out', () => {
  const rows = planRows([], [stay], { fallbackTz: 'UTC' });
  assert.deepEqual(rows.map((r) => [r.from, r.day, r.night && `${r.night.n}/${r.night.of}`]), [
    ['booking', '2026-11-20', null], ['checkout', '2026-11-27', null],
    ['night', '2026-11-21', '2/7'], ['night', '2026-11-22', '3/7'], ['night', '2026-11-23', '4/7'],
    ['night', '2026-11-24', '5/7'], ['night', '2026-11-25', '6/7'], ['night', '2026-11-26', '7/7']]);
});
test("a plan item linking a booking stands for it; a stay's check-out is still shown unless an item is on that day", () => {});
test('a booking with no time is Not on a day; plan items with no time stay under No time yet', () => {
  const { notOnDay, untimed } = planDays(planRows([untimedItem], [pass], { fallbackTz: 'UTC' }), {});
  assert.deepEqual(notOnDay.map((r) => r.path), ['/bookings/pass.json']);
  assert.deepEqual(untimed.map((r) => r.path), ['/plan/u.json']);
});
test('nights come first in their day, before its other rows; a 0- or 1-night stay has none; a 200-night one stops at 60', () => {
  const { days } = planDays(planRows([dinnerOn21st], [stay], { fallbackTz: 'UTC' }), {});
  assert.deepEqual(days.find((d) => d.key === '2026-11-21').rows.map((r) => r.from), ['night', 'item']);
});
test('a booking with a time zone annai does not know, or an end before its start, still shows, in the fallback zone with the note; no nights', () => {});
test('check and checkFields come from checkOf: an old unverified booking is check, a new one lists its fields, an old confirmed one neither', () => {});
test("Now's next items include a flight booking no plan item stands for, and never a night line", () => { /* tripRows over a memory workspace */ });
```
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** Night days come from `dayIn(start.at, start.tz)` and `dayIn(end.at, end.tz)`, counted with `daysApart`.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** `src/core/plan.js test/unit/plan.test.js`: "Bookings are on their days on the Plan, with a line for each night of a stay".

---

### Task 3: The Plan screen **[after phone-fixes-1]**

**Files:**
- Modify: `src/ui/screens/plan.js` (rows, chips, "Not on a day", the Bookings list removed), `src/ui/screens/now.js` (`planRowOf`, `nowRow` links), `src/ui/format.js` (`itemHref`), `src/ui/router.js` (`item` in `SUB`), `src/ui/shell.js` (`SECTION`: `item` → `plan`), `src/ui/base.css` (the night line), `test/e2e/plan.spec.js`, `l10n/*.tsv`

**Interfaces:**
- Consumes: `PlanRow.from`, `night`, `checkFields`, `planDays().notOnDay` (Task 2).
- Produces:
  - `itemHref(id: string, path: string): string`: `#/trip/<id>/item?path=…`, the plan item details screen (Task 6).
  - Every row's name links to its details: `bookingHref(id, r.bookingPath ?? r.path)` for a row of a booking (`booking`, `checkout`, or an item linking one), else `itemHref`. Nothing on the Plan links to the raw file any more.
  - The row's mark: a check-out row's name is `` t`Check out · ${name}` ``, and a stay's own row `` t`Check in · ${name}` ``. A night row is a quiet line, not a link: `` t`Staying at ${name} · night ${num(n)} of ${num(of)}` ``.
  - The row chips: `check` shows `` t`Check this` `` (links to the details); `checkFields` shows `` plural(n, 'Check # detail', 'Check # details') ``; the Undo chip, Booking missing and the note stay as they are.
  - "Not on a day": a section at the top of the Plan, above the day tabs, headed `` t`Not on a day` ``, holding the booking rows with no day, when there are any.
  - The Bookings list below the timetable is gone (goal 9). "Add to calendar" stays.

- [ ] **Step 1: Write the failing e2e tests** in `test/e2e/plan.spec.js`, seeded with `writeRecords`. Rewrite the two tests that tap "Looks right": that button goes in Task 6.
  - `"the Plan: the flight on Nov 20 with its times, the stay's check-in, a line for each night, its check-out; a pass under Not on a day; no Bookings list"`.
  - `'a tap on any row opens its details, never the raw file'`: tap the flight, then expect the booking's details heading; tap a plain item, then expect the item's details heading.
  - `'an old unverified booking says Check this; a new one with an unsure seat says Check 1 detail; an old confirmed one says neither'`.
- [ ] **Step 2: Run to verify they fail** (the e2e command with `test/e2e/plan.spec.js`).
- [ ] **Step 3: Implement.** Night lines use `class: 'plan-row night'`: smaller, muted and unbordered, in `base.css`'s tokens.
- [ ] **Step 4: Run to verify they pass** on both projects, together with `test/e2e/now.spec.js` and `test/e2e/drive.spec.js`.
- [ ] **Step 5: Commit** the files above by name: "The Plan shows every booking on its day, and a tap opens its details".

---

### Task 4: Previews and the original **[after phone-fixes-1]**

`src/ui/preview.js` belongs to the "Reading files" plan (its Task 6: `previewOf(file, { registry, signal })` and `imgDrawsPdf()`, with browser-suite tests). Use it as it defines it.
- **If it has merged:** add only what is below.
- **If it hasn't:** create `preview.js` with exactly its signatures and behaviour without the plugin branch (a photo is itself; a PDF is the browser's own drawing where `imgDrawsPdf()`, else null; anything else null), and copy its browser-suite cases for those branches. Reading files then adds the plugin branch.
- Either way, the screens never decide a preview anywhere else.

**Files:**
- Create: `test/unit/preview.test.js`
- Modify: `src/ui/preview.js` (adds `pdfPages`, `fileCard`), `src/ui/screens/file.js` (`editor`: a PDF shows itself; a text file keeps its editor), `src/ui/base.css`, `sw.js`, `l10n/*.tsv`

**Interfaces:**
- Consumes: `previewOf(file: Blob, o?: { registry?, signal? }): Promise<string | null>` and `imgDrawsPdf(): Promise<boolean>` (Reading files); the caller revokes the URL.
- Produces:
  - `pdfPages(bytes: Uint8Array): number | null`: the largest `/Count n` of a `/Type /Pages` dictionary in the first 2 MiB, read as Latin-1. It is null when none is found, or when the bytes don't start with `%PDF-`.
  - `fileCard(o: { name: string, type: string, pages?: number | null }): HTMLElement`: an icon (by type: PDF, text, pass, other), the name (`dir="auto"`) and `` plural(pages, '# page', '# pages') `` when known.
  - `filePreview(ctx, scope: string, path: string): Promise<HTMLElement | null>`: what a screen shows for a stored file: an `<img>` of `previewOf(new Blob([bytes], { type }), { registry: ctx.registry })`, else `fileCard` with `pdfPages`. It is null when there is no file, and it revokes the URL when the image goes. Tasks 6 and 7 use it.
  - The file screen for a PDF (the screen Open the original goes to, which shows "the file itself"):
    - with `navigator.pdfViewerEnabled`, the browser's own viewer in an `<iframe>` of the object URL, titled with the file's name;
    - else the file card with Open (a link to the object URL, `target="_blank"`) and Download.
    - Its crumb goes back where it came from (`from`, phone-fixes-1).

- [ ] **Step 1: Write the failing tests** in `test/unit/preview.test.js`:

```js
test('pdfPages: the page count of the flight fixture; null for no PDF; a count past 2 MiB is not looked for', async () => {
  assert.equal(pdfPages(await readFile('test/fixtures/bookings/flight.pdf')), 2);
  assert.equal(pdfPages(utf8('not a pdf /Type /Pages /Count 9')), null);
  const big = new Uint8Array(3 * 1024 * 1024); big.set(utf8('%PDF-1.4\n'));
  big.set(utf8('<< /Type /Pages /Count 4 >>'), 2.5 * 1024 * 1024);
  assert.equal(pdfPages(big), null);
});
```
  - A new `test/e2e/original.spec.js`: `'Open the original shows a PDF in the browser where it can, else a card with Open and Download; Back returns to the details'`. Assert whichever `navigator.pdfViewerEnabled` the browser reports, on both projects.
  - The same spec: `'a stored PDF's preview is the browser's drawing where an img draws PDFs, else a card naming 2 pages'`. This is `filePreview` on a seeded trip; assert by `imgDrawsPdf()`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass**, unit and e2e on both projects.
- [ ] **Step 5: Commit** the files above by name: "A file's preview card and page count, and the original shown by the browser itself".

---

### Task 5: Ask Shiori about this **[after handing-over]**

Goal 7: "opens the Conversation with the booking (and its file) attached as a chip in the type box … A one-tap Read it again suggestion sits under the chip. The same button is on every event's details and on each file in the trip's Files section."

**Files:**
- Modify: `src/ui/composer.js` (suggestions drawn under the chips; a booking's chip), `src/core/handover.js` (`handOverText` for a reference to a booking), `test/unit/composer.test.js`, `test/unit/agent-handover.test.js`, `test/e2e/hand-over.spec.js`, `l10n/*.tsv`

**Interfaces:**
- Consumes: `askAbout(ctx, ref, { suggestions })`, `createComposer`'s `attach(items, { suggestions })` (handing-over Task 7).
- Produces:
  - `READ_AGAIN`: the suggestion's words are the user's, sent in the language they speak: `` asUser(speaksScreens(app))`Read it again` `` (as `file.js` sends "Look at this part of…").
  - Under the chips, each suggestion is a real button. One tap sends that text with the attachments at once, and the chips clear. Typing instead keeps the chips and sends what is typed.
  - A chip for a booking (`path` under `/bookings/`) is labelled with the booking's title. The `HandedFile` for it is `{ path: '/trip/bookings/b.json', type: 'application/json', name: <title>, new: false }`. `handOverText` for such a reference says the user is asking about this booking, and that she should read it and the file it came from (its `source`) before answering.
  - `askAboutButton(ctx, ref): HTMLElement | null`: `` t`Ask Shiori about this` ``, calling `askAbout(ctx, ref, { suggestions: [READ_AGAIN] })`. It is null when `!canAsk(ctx)`. Tasks 6 and 7 use it.

- [ ] **Step 1: Write the failing tests:**
  - `composer.test.js`: `"a booking's chip is named by its title; its HandedFile is a reference"`: `handedOf({ scope: trip, path: '/bookings/flight.json' }, { type: 'application/json', name: 'ANNAI AIR AN 123' })` deep-equals `{ path: '/trip/bookings/flight.json', type: 'application/json', name: 'ANNAI AIR AN 123', new: false }`, and the chip's text is the title.
  - `agent-handover.test.js`: `'asking about a booking: she is told which booking, and to read it and its file first'`.
  - `hand-over.spec.js`: `"Ask Shiori about this: the booking is a chip in the type box with Read it again under it; one tap sends it, and Shiori is asked about that booking"`. Expect the stand-in's last request to name `/trip/bookings/flight.json`.
  - `hand-over.spec.js`: `'with "the seat is 14D" typed under the chip, her patch fixes the seat'` (Done looks like 7): the stand-in replies with `patch` `{ fields: { seat: '14D' }, unsure: [] }`; the details then show seat 14D with no check mark.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** the files above by name: "Ask Shiori about this puts the booking in the type box, with Read it again".

---

### Task 6: Details first **[after phone-fixes-1]**

Goal 6 and screen 3 of the approved mockups.

**Files:**
- Create: `src/ui/screens/item.js`
- Modify: `src/ui/screens/booking.js` (redone), `src/ui/format.js` (`bookingFacts` replaces `bookingLines`; `FIELD_WORDS`), `src/ui/shell.js` (route `item`), `src/ui/base.css`, `test/unit/ui-pure.test.js` (its `bookingLines` test becomes `bookingFacts`'), `test/e2e/plan.spec.js`, `sw.js`, `l10n/*.tsv`

**Interfaces:**
- Consumes: `checkOf` (Task 1), `filePreview` (Task 4), `askAboutButton` (Task 5), `readNames`, `shortName`, `fileHref(id, path, from)`.
- Produces:
  - `FIELD_WORDS: Record<string, string>`: words for the keys Shiori writes most: `flight` (Flight), `airline`, `from`, `to`, `seat`, `class` (Cabin), `travellers`, `bags`, `terminal`, `gate`, `room`, `guests`, `nights`, `pickup`, `dropoff`, `train`, `car` (Car, of a train), `party` (Party size), `notes`. They go in `tc('booking')` where a word is ambiguous.
  - `bookingFacts(b): { key: string, label: string, value: string, lang?: 'en', unsure: boolean }[]`, in reading order by kind:
    - flight: from → to, departs (its own zone), arrives (its own zone), flight, airline, seat, travellers, bags, confirmation, cost;
    - lodging: place, check-in, check-out, nights, room, guests, confirmation, cost;
    - other kinds: starts, ends, place, confirmation, cost.
    - Then any other `fields` key as written (`lang: 'en'` on the label). Arrays are joined with `list()`.
    - `unsure` comes from `checkOf(b).fields`.
    - `bookingLines` goes; its only caller is this screen (and its test in `ui-pure.test.js`, rewritten for `bookingFacts`, keeping its cases: a zone annai doesn't know, `fields` that isn't an object).
  - **The booking details screen** (`#/trip/<id>/booking?path=`):
    - title (Shiori's `title`, else its kind's word), the kind and day as a sub line;
    - for an old record marked whole, a banner: `` t`Check this: Shiori read it before annai marked single details. Tell her if anything is wrong.` ``;
    - the facts as a `<dl>`. A field in `unsure` carries a light mark: a "check" chip with `` t`Shiori isn't sure of this` `` for screen readers;
    - the file: `filePreview(ctx, id, source)`, with its short name, then `` t`Open the original` `` (`fileHref(id, source, here)`). With no file: `` t`The original, ${name}, isn't in the trip.` `` or `` t`This booking doesn't say which file it came from.` `` (as today);
    - Open in Maps when it has a place; `askAboutButton(ctx, { scope: id, path })`; `` t`Change it` `` (the raw form, `fileHref(id, path, here)`).
    - No Looks right: the confirming step is gone (My call 1).
    - The crumb goes back to the Plan.
  - **The plan item details screen** (`renderItem`, `#/trip/<id>/item?path=`):
    - what (title, kind), when (start–end in its zones, or All day), where (place, address, Open in Maps), notes (Markdown as text), and the file it came from: the item's `source` (a calendar's) or its booking's `source`, with preview and Open the original;
    - an item linking a booking says `` t`Booked: ${bookingTitle}` `` and links to the booking's details;
    - Ask Shiori about this; Change it. The crumb goes back to the Plan.
    - A path that isn't a plan item gets words and a link back, never the raw JSON.

- [ ] **Step 1: Write the failing tests:**

```js
// ui-pure.test.js
test('bookingFacts: a flight reads from → to, departs and arrives in each airport\'s zone, then seat; unsure fields marked', () => {
  const f = bookingFacts(flightBooking); // unsure: ['seat']
  assert.deepEqual(f.map((x) => x.key), ['route', 'start', 'end', 'flight', 'airline', 'seat', 'travellers', 'confirmation']);
  assert.match(f[1].value, /11:20.*PST/); assert.match(f[2].value, /14:05.*AKST/);
  assert.equal(f.find((x) => x.key === 'seat').unsure, true);
});
test('bookingFacts: a stay counts its nights; an unknown field is shown as written, its label marked English', () => {});
test('bookingFacts in ja: the labels are words, not keys', () => {});
```
  - `plan.spec.js`:
    - `"a flight's details: what Shiori read, its PDF's preview or card, Open the original and Back, Ask Shiori about this, Change it; no Looks right"`;
    - `"a plain item's details: what, when, where, notes and its calendar file; never raw JSON first"`;
    - `'a booking whose file is gone says so, with no preview, and can still be asked about'` (Review Focus 3).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** The layout follows screen 3: facts first, file below, actions at the foot. On a phone the preview is at most 40vh tall.
- [ ] **Step 4: Run to verify they pass**, unit and e2e on both projects.
- [ ] **Step 5: Commit** the files above by name: "A tap on the Plan opens details first: what Shiori read, the file, and what you can do".

---

### Task 7: The Files section, and All files below it **[after handing-over]**

Goal 8 and My calls 4 and 5.

**Files:**
- Create: `src/core/trip-files.js`, `test/unit/trip-files.test.js`
- Modify: `src/ui/screens/trip.js` (the Files section; `fileList` and `newFile` folded under All files), `test/e2e/trips.spec.js`, `test/e2e/bring-in.spec.js`, `sw.js`, `l10n/*.tsv`

**Interfaces:**
- Consumes: `readNames`, `shortName`, `filesToRead`, `bringIn`, `askAboutButton`, `isPhotoType` (photos.js).
- Produces:
  - `@typedef {{ kind: 'booking', bookingKind: string, path: string, title: string } | { kind: 'plan', path: string, title: string } | { kind: 'photo' } | { kind: 'waiting' } | { kind: 'nothing' }} Became`
  - `fileRows(o: { files: FileEntry[], bookings: { path, booking }[], items: { path, item, source? }[], names: Record<string, string>, toRead: string[] }): { path: string, name: string, real: string, became: Became[] }[]`:
    - the trip's `/files/` files, each with what it became: the bookings whose `source` names it, and the plan items whose file `source` names it (a calendar's);
    - else `waiting` when it is in `toRead`, `photo` for a photo nothing came from, else `nothing`;
    - photos are left out unless they became a booking or wait to be read (My call 4);
    - ordered by name.
  - **The Files section** on the trip screen, right under its actions, headed `` t`Files` ``:
    - each row: the short name, the real file name small beneath it (`dir="ltr"`), and what it became (`` t`A flight: ${title}` ``, `` t`A stay: ${title}` ``…, from the kinds' words; `` t`Plan items from a calendar` ``; `` t`Waiting for Shiori to read it` ``; `` t`Nothing yet` ``);
    - a tap opens the file (`fileHref(id, path, here)`); a booking it became links to that booking's details; Ask Shiori about this;
    - at its foot, `` t`Add photos or files` `` (by hand, through `bringIn`: Shiori is woken to read them, as today).
  - **All files**: a `<details>` below Files, summary `` t`All files` ``, holding today's by-folder list (notes, memory, the raw records) and the box that adds a file by path. Its ids (`#new-path`, `#upload-file`, `#take-photo`) stay, so existing e2e locators work once the fold is opened.

- [ ] **Step 1: Write the failing tests:**

```js
// trip-files.test.js
test('fileRows: a PDF became a flight, a screenshot a stay, a calendar plan items; a plain photo is left out; a new file waits to be read', () => {
  const rows = fileRows({ files, bookings, items, names: { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, toRead: ['/files/new.pdf'] });
  assert.deepEqual(rows.map((r) => [r.name, r.became.map((b) => b.kind)]), [
    ['ANNAI AIR flight · Nov 20', ['booking']], ['hotel.png', ['booking']], ['new.pdf', ['waiting']], ['trip.ics', ['plan']], ['pasted-2026-10-28-0310.txt', ['nothing']]]);
  assert.equal(rows.some((r) => r.real === 'view.jpg'), false);
});
test('fileRows: one file that became two bookings (outbound and return) lists both', () => {});
```
  - `trips.spec.js`: `"a trip's Files: each file's short name, real name and what it became; opening one; asking about one; adding one by hand"`; `'All files is folded below Files, and still has notes, memory, the raw records and the box that adds a file by path'`.
  - `bring-in.spec.js`: open All files before using its controls.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** on both projects, together with `test/e2e/photos.spec.js` and `test/e2e/backups-files.spec.js`, which use the trip's file list.
- [ ] **Step 5: Commit** the files above by name: "A Files section says what each file became; All files keeps the full list below it".

---

### Task 8: Short names wherever a file is named **[after handing-over]**

Goal 10: "She names each file for what it is ('ANNAI AIR flight · Nov 20'), shown in Files and on chips. The real file name is kept and shown on the file's own screen."

**Files:**
- Modify: `src/ui/composer.js` (a stored file's chip), `src/ui/screens/talk.js` (the chips on the user's lines), `src/ui/screens/trips.js` (Waiting with Shiori), `src/ui/screens/file.js` (title and real name), `test/e2e/hand-over.spec.js`

**Interfaces:**
- Consumes: `readNames`, `shortName`, `NAMES_FILE`.
- Produces:
  - Chips (in the type box and on the user's lines), Waiting with Shiori's rows, and the details screens' "From …" show `shortName(names, path)`, with the real name as the chip's `title`.
  - A chip on a line in the no-trip conversation names its file by the waiting space's names at the time of drawing. Once the file has moved, it keeps its own file name; the moved line says where it went.
  - The file screen's heading is the short name. Under it, `` t`File name: ${real}` `` (`dir="ltr"`, a monospace span), then the path as today.

- [ ] **Step 1: Write the failing e2e test** in `hand-over.spec.js`: `'once Shiori names a file, its chip, its Files row and its screen show the short name; its screen shows the real file name too'`. The stand-in patches `/trip/names.json` with `{ "/files/flight.pdf": "ANNAI AIR flight · Nov 20" }`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Each screen reads `names.json` once per draw.
- [ ] **Step 4: Run to verify it passes** on both projects.
- [ ] **Step 5: Commit** the files above by name: "Files go by the short names Shiori gives them, with the real name on their own screen".

---

### Task 9: The user's evening, done again

"Done looks like", steps 1–7, end to end.

**Files:**
- Create: `test/e2e/evening.spec.js`

**Interfaces:**
- Consumes: everything above; `test/fixtures/bookings/flight.pdf` and `hotel.png`; the stand-in Anthropic server helpers.

- [ ] **Step 1: Write the test** `'the user's evening: on Trips with no trip open, + with the flight PDF and the hotel screenshot; Shiori starts Anchorage · Nov 20–27 and it opens; the Plan has the flight on Nov 20 with Seattle and Anchorage times, and the stay with its check-in, nights and check-out; the flight's details show the PDF; Open the original and Back; nothing asked where a file goes; Ask Shiori about this with "the seat is 14D" fixes the seat'`. The stand-in's replies (in order):
  1. `list_trips`;
  2. `start_trip` with both files, the dates and a recap;
  3. `speak`;
  4. in the trip, `write` two flight bookings (with `unsure: []`) and a stay (`unsure: ['end']`), `patch` `names.json`, then `speak`;
  5. after the ask, `patch` the seat.

  Assertions, in order:
  - the top bar names the trip;
  - Nov 20's tab has `11:20–14:05 AKST` for the flight and `Check in · Hotel Aurora Test`;
  - Nov 21's tab has `Staying at Hotel Aurora Test · night 2 of 7`;
  - Nov 27's tab has `Check out · Hotel Aurora Test`;
  - the flight's details show `Seattle` and `Anchorage` with both zones;
  - the preview is an `<img>` (WebKit when it draws PDFs) or the file card naming 2 pages;
  - Open the original, then Back returns to the details heading;
  - `.convo .shiori .acts button` has count 0;
  - after the ask, the details show `14D` with no check mark on the seat.
- [ ] **Step 2: Run it on both projects;** fix what it finds, each fix with its own unit test.
- [ ] **Step 3: Manual, local only, before release (the coordinator asks the user):**
  - With a real model that reads PDFs (one of the user's configured Claude models; keys are read only inside the command that uses them, never printed), hand over the synthetic `flight.pdf` and `hotel.png` and check the bookings, times, nights and short names Shiori writes.
  - If the user provides a real confirmation (a PDF or screenshot), repeat with it on this machine only. It never goes into the repo, a test, a commit, a trace given to an outside service, or a report beyond a one-line outcome.
  - On the user's iPhone, check that Safari draws the PDF's first page in the details. Linux WebKit can't show that path.
- [ ] **Step 4: Commit** `test/e2e/evening.spec.js`: "The user's evening, end to end".

---

### Task 10: Everything green, and the spec says what was built

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-annai-design.md` (§4.4, §7.3, §8, §16.2), `docs/superpowers/specs/2026-10-28-bookings-and-trips-design.md` (a "Built" note), `test/e2e/phone-fit.spec.js`, `test/e2e/restore.spec.js` or `roundtrip.spec.js` (old records), `scripts/size.mjs`, `l10n/*.tsv`

- [ ] **Step 1: Old records keep rendering.** E2e `'a trip from before: unverified and confirmed bookings without unsure, plan items linking them, a trip with no dates; the Plan, the details and Files all show them, the old unverified one marked whole'`. Seed it with `writeRecords` in the old shapes (copied from today's `plan.spec.js` records). Run it on both projects.
- [ ] **Step 2: Phone-fit:** add `'the Plan with a stay, a booking's details, an item's details and a trip's Files fit a phone 320 px wide, in ja and zh-Hans'` to `phone-fit.spec.js`, seeded. Run it in Docker. Expected: no sideways scroll.
- [ ] **Step 3: The full check**: `NODE_OPTIONS=--max-old-space-size=2048 timeout 1500 npm run stamp && NODE_OPTIONS=--max-old-space-size=2048 timeout 1500 systemd-run --scope -q -p MemoryMax=6G npm run check`. Expected: exit 0.
- [ ] **Step 4: The full e2e** with `--workers=4`. Expected: 0 failed; rerun failures with `--last-failed --workers=4` first. Delete `core*` dumps.
- [ ] **Step 5: The size budget:** `node scripts/size.mjs`. Raise `BUDGET` by the least that fits, with a note: "…; N for seeing bookings (bookings on their days, details first, previews, Files), M KiB used before it, P after: the least that fits".
- [ ] **Step 6: The main spec**, in one commit:
  - §4.4: the booking's `unsure` (the fields she isn't sure of, `[]` when none; a booking without it is from before). Drop "New records must be `unverified`"; `status` stays, and Shiori still never sets `confirmed`.
  - §7.3: step 3 becomes "she reads it, writes the booking with `unsure` naming just the fields she isn't sure of, and asks about only those"; step 4 becomes "the Plan marks just those fields; an old `unverified` booking is marked whole, as Check this, until she is told it's right". There is no confirming step.
  - §8: bookings are on their day on the Plan whether or not a plan item stands for them: a flight where it leaves, a stay's check-in, nights and check-out, and "Not on a day".
  - §16.2:
    - Plan: day tabs, "Not on a day", night lines, check marks, a tap opens details.
    - "Booking confirmation" becomes the booking details (what she read, the preview, Open the original with Back, Ask Shiori about this, Change it), plus the plan item details.
    - The trip screen: Files, then All files folded.
    - Files and chips go by short names.
- [ ] **Step 7: Commit** the spec, the tests, `scripts/size.mjs` and the TSVs by name: "The spec describes seeing bookings; the size budget for it".

---

## Calls to confirm (for the coordinator to put to the user)

1. **Looks right goes.** There is no confirming step. An old `unverified` booking stays marked "Check this" until the user tells Shiori it's right, and she then writes `unsure: []`. The user can still change any booking by hand with Change it.
2. **New bookings still store `status: 'unverified'`.** The schema requires `status`, and Shiori still can't set `confirmed`. For a new booking, the marks come only from `unsure`, so `status` is history for new records.
3. **A trip photo isn't listed in Files.** My call 4 says photos are not listed. Goal 8 lists "a trip photo" among the things a file can become. The data keeps `photo`, but Files leaves those photos out. A photo shows in Files only when a booking came from it, or while it waits to be read.
4. **Bookings are on the Plan even without a plan item.** A plan item that links a booking stands for it. A stay's check-out and nights are always drawn from the booking.
5. **Night lines come first in each night's day** (mockup 2b): "Staying at … · night 2 of 7" on the day after check-in, through the day before check-out.
6. **Safari's `<img>` of a PDF can't be tested on Linux WebKit.** The e2e test checks the file card path, and the iPhone check is manual (Task 9).
7. **The page count** is read from the PDF's own `/Count` within its first 2 MiB. That is a few lines of annai's own code, not a PDF library. When the count is unknown, the card leaves it out.
8. **`bookingLines` became `bookingFacts`,** which returns labelled facts with an `unsure` flag. Its only caller is the booking screen.
