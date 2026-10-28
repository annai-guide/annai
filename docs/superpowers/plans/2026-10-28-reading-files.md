# Reading Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whoever can read a photo or a PDF reads it (goal 11), and an official, optional plugin, PDF pages, turns a PDF's pages into pictures for models that see photos but read no PDFs, and gives every browser a first-page preview (goal 12).

**Architecture:** One reading path in core, `src/core/agent/reading.js`, decides who reads a file a model can't take: Koe's models, then Utility's, then Main's (for Kokoro; Kokoro's first for Koe), then, for a PDF, its pages as pictures from the plugin, and only then a note naming the setting that fixes it. It is used at two places: when a tool returns a file (the loop's existing `#described`, now delegating), and inside `callRole` as a second pass for models a file in the newest message kept out (the user's session: the reader timed out and every other model was passed over). The plugin registers a registry kind `pdf-pages` with one function; core reads it through `src/core/pdf-pages.js`, and the screens through `previewOf()` in `src/ui/preview.js`. The PDF library, Mozilla's PDF.js, lives only in the plugin.

**Tech Stack:** native ES modules with JSDoc checked by tsc; node:test; Playwright 1.63 in Docker (Chromium and WebKit) with the browser-suite harness in `test/browser/`; PDF.js 6.4.299 (`pdfjs-dist`, legacy build), vendored inside `plugins-official/pdf-pages/`.

**Spec:** `docs/superpowers/specs/2026-10-28-bookings-and-trips-design.md`, goals 11 and 12 (approved by the user 2026-10-28). The main spec it changes is `docs/superpowers/specs/2026-10-15-annai-design.md` (§5.1, §6.5, §7.2 "PDFs", §9.6 "capability gaps"). The other two plans of that spec ("handing over", "seeing bookings") are written by another planner; this plan's boundary with them is `previewOf()` and the reading path (see "Interfaces for the other plans").

## Global Constraints

- From the spec, verbatim: "The PDF library it needs lives in the plugin, not in annai's own code, so annai stays small for anyone who doesn't install it." Nothing under `src/` imports from `plugins-official/pdf-pages/`.
- From the spec, verbatim: "PDF preview without a new dependency in annai's own code." / "Safari draws a PDF's first page in an `<img>`. Elsewhere, without the plugin of goal 12, the preview is a file card".
- From the spec, verbatim: "Only when nothing can read it does she say which setting fixes it." The note names the setting: "Takes PDFs" / "Takes photos" on the model's page in Settings → Models, and the PDF pages plugin (Settings → Plugins → Add) when it isn't running and a model here sees photos.
- Anti-goal, verbatim: "The user's files or their contents going anywhere but the models the user chose. Nothing new leaves the phone." Pages are drawn on the device; readers are only the user's own models.
- RULES.md, Dependencies: PDF.js is a widely used, maintained library (mainstream), and it is vendored, so it gets a `docs/deps.md` entry (what we use, quirks, pitfalls, how to update) after its integration surface is read. No other third-party code. Dev tools: none new.
- The three kinds of words: notes and tool results a model reads are English, marked `/* en */`; every new user-facing message goes through `t`, `tc` or `plural` with `ja` and `zh-Hans` rows, read against their place and marked `ok` with notes. Store data, not words.
- Every stored blob is named (spec §4.9): page pictures given to a model at tool time are kept as the `tool.result`'s blobs, named by it. Pages made for a single request are never stored.
- The browser floor is iOS 16.4 Safari for annai itself. The plugin must fail working on an older engine (its `pages()` throws an `Error` in words; the preview falls back to the file card).
- Official plugin rules: a new plugin's version starts at `0.1.0`; any later change bumps it; run `npm run strings`, then `npm run catalog`, then `npm run stamp` after shipped-file changes.
- Test fixtures are synthetic and made here (`scripts/make-pdf-fixtures.mjs` → `test/fixtures/pdf/`). The repo is public: never the user's real files. A real-world sample, if one is needed, is the manual local step in Task 8, kept out of the repo.
- Every command runs under a cap: `node --max-old-space-size=2048` (via `NODE_OPTIONS` for npm), an outer `timeout`, Docker `--memory=6g`. No real model calls in tests.
- If a task changes an existing API's shape (rather than adding to it), add a `/mnt/optane/work/agent-rules/LESSONS.md` entry and list it in Calls to confirm. This plan expects none: everything here is an addition.

## Review Focus

1. **A big PDF** (the user's "Travel Reservation Center" PDF was 2 MB): at most `MAX_PAGES` (10) pages are drawn, the line says how many were left out, and drawing stops at the PDF's reading limit (90 s), saying so. Pinned in Task 2 ("pages that take longer than the PDF's limit…") and Task 5 ("max and from pick the pages").
2. **A locked or broken PDF:** the plugin answers with an `Error` in words; that never counts against the plugin, the reading says what happened, and the note still names the setting. Pinned in Task 1 ("an answer in words never counts against it") and Task 2 ("pages the plugin can't draw").
3. **The same PDF read again, or in another trip:** pages and words are reused within the conversation and never cross to another conversation, and Erase forgets them. Pinned in Task 2 ("pages are drawn once per conversation").
4. **The plugin switched off, crashing or removed mid-session:** the next reading behaves as if it were never installed (the note mentions it again), and `previewOf` returns null or the browser's own drawing. Pinned in Task 1 ("three crashes switch it off") and Task 6 ("without the plugin").
5. **PDF.js taking the caller's bytes:** PDF.js transfers the buffer it is given to its worker, which would leave the caller's `Uint8Array` empty (a blob read from the store, the details screen's Blob). Pinned in Task 5 ("the bytes given are still whole afterwards").

---

## Base and order

- This plan executes **after phone-fixes-1 is merged** into main. That batch (branch `phone-fixes-1`) fixes Claude's default inputs (photos and PDFs), Claude's thinking blocks, and showing failures in the Conversation. Step 0 of Task 1 checks it is merged.
- Work in a worktree on branch `reading-files` from main. Scratch goes in `/tmp/claude-0/-mnt-optane-work/1e786df4-3f8f-4d41-b3c7-86bd210df129/scratchpad/reading-files/`; keep a ledger at `.superpowers/sdd/reading-files/progress.md`.
- Files phone-fixes-1 also changed, to re-read on main before editing: `src/core/agent/loop.js`, `src/ui/screens/models.js`, `sw.js`, `shell.json`, `scripts/size.mjs`, `catalog/plugins.json`, `test/unit/agent-kit.js`, `test/unit/agent-loop.test.js`, `docs/superpowers/specs/2026-10-15-annai-design.md`.

## File map

| File | Responsibility |
|---|---|
| `src/core/pdf-pages.js` (new) | The `pdf-pages` kind's contract: the running plugin's `pages()`, guarded; `MAX_PAGES`, `PAGE_EDGE` |
| `src/core/agent/reading.js` (new) | Who reads a file a model can't take, in what order, and the words the model gets |
| `src/core/agent/loop.js` | `#described` delegates to reading.js; the turn's `callRole` gets `read`; warm housekeeping sends files as notes |
| `src/core/llm/fallback.js`, `src/core/llm/contract.js`, `src/core/llm/service.js` | `callRole`'s second pass (`read`); `Request.newestDocument` |
| `src/ui/preview.js` (new) | `previewOf()` and `imgDrawsPdf()` |
| `src/ui/screens/models.js` | The utility role's note, widened |
| `plugins-official/pdf-pages/` (new) | The plugin: `annai-plugin.json`, `index.js`, `l10n/`, `vendor/pdfjs/` |
| `sw.js` | Serves `application/octet-stream` plugin files (PDF.js's cmaps and fonts); SHELL gains the new modules |
| `scripts/make-pdf-fixtures.mjs`, `test/fixtures/pdf/` (new) | Synthetic PDFs |
| `docs/deps.md` (new), `docs/plugins.md` | PDF.js's entry; the `pdf-pages` kind |

## Interfaces for the other plans

- **`previewOf(file, { registry, signal })`** in `src/ui/preview.js` → `Promise<string | null>`: an object URL of the file's first page as a picture, or null when nothing here can draw it (the caller shows the file card). The caller revokes the URL (`URL.revokeObjectURL`) when it stops showing it. `file` is a `Blob` whose `type` says what it is (`new Blob([got.bytes], { type: got.entry.type })` from `ctx.ws.read`); pass `registry: ctx.registry`. A photo is itself; a PDF is the browser's own drawing where its `<img>` draws PDFs (Safari), else the plugin's page 1, else null; anything else is null.
- **The reading path:** any photo or PDF part in a model request is read by whoever can: one in a tool result (a `read` of `/trip/files/…`) at tool time, and one in the newest user message (attachments on the user's message) by `callRole`'s second pass. The hand-over plan needs only to put files on the user's message as `image`/`document` parts, or have Shiori `read` them; it must not add a reading path of its own. For Koe nothing changes: a PDF she reads and can't take goes to Kokoro at once.

---

### Task 1: The `pdf-pages` kind in core

**Files:**
- Create: `src/core/pdf-pages.js`
- Modify: `sw.js` (SHELL gains `/src/core/pdf-pages.js`), `docs/plugins.md` (the table row for `annai.register` kinds, and a new section "PDF pages" after "Search providers")
- Test: `test/unit/pdf-pages.test.js`

**Interfaces:**
- Consumes: `Registry` (`entries(kind)`, `fail`, `succeeded`, `isDisabled`) and `isPluginBug` from `src/core/registry.js`.
- Produces:
  ```js
  export const MAX_PAGES = 10;   // pages drawn for a model, at most
  export const PAGE_EDGE = 1600; // px, a page picture's longest side for a model
  /** @typedef {{ type: string, bytes: Uint8Array, width: number, height: number }} PageImage */
  /** @typedef {{ count: number, pages: PageImage[] }} Drawn  count: the PDF's pages; pages: those drawn */
  /** @typedef {{ pluginId: string, pages: (bytes: Uint8Array, o: { from?: number, max: number, edge: number, signal?: AbortSignal }) => Promise<Drawn> }} PdfPages
   *   from: the first page, 1-based (default 1); max: how many at most; edge: the longest side in px */
  /** The running plugin's pages(), or null. @param {import('./registry.js').Registry | null | undefined} registry @returns {PdfPages | null} */
  export function runningPdfPages(registry)
  ```
  The plugin registers `annai.register('pdf-pages', { id: string, pages(bytes, o) })`. The kind is not named (no `NAMED` entry): the first running registration is used, and plugins start in rank order, so annai's official one comes first.

- [ ] **Step 0: Check the base**

Run: `git merge-base --is-ancestor phone-fixes-1 main && echo merged`
Expected: `merged`. If not, stop and report: this plan runs after phone-fixes-1.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../../src/core/registry.js';
import { runningPdfPages, MAX_PAGES, PAGE_EDGE } from '../../src/core/pdf-pages.js';

const drawn = { count: 1, pages: [{ type: 'image/jpeg', bytes: new Uint8Array([1]), width: 10, height: 12 }] };

test('no plugin, no pages: null until one registers, and null again once it is removed', async () => {
  const r = new Registry();
  assert.equal(runningPdfPages(r), null);
  assert.equal(runningPdfPages(null), null);
  const off = r.add('pdf-pages', 'pdf-pages', { id: 'pdfjs', pages: async () => drawn });
  assert.equal(runningPdfPages(r)?.pluginId, 'pdf-pages');
  assert.deepEqual(await runningPdfPages(r)?.pages(new Uint8Array(4), { max: 1, edge: 100 }), drawn);
  off();
  assert.equal(runningPdfPages(r), null);
});

test('a registration without a pages function is passed over for the next', () => {
  const r = new Registry();
  r.add('broken', 'pdf-pages', { id: 'x' });
  r.add('good', 'pdf-pages', { id: 'y', pages: async () => drawn });
  assert.equal(runningPdfPages(r)?.pluginId, 'good');
});

test("an answer in words never counts against it: a locked PDF's Error, three times, leaves the plugin on", async () => {
  const r = new Registry({ maxFailures: 3 });
  r.add('p', 'pdf-pages', { id: 'x', pages: async () => { throw new Error('This PDF is locked with a password, so its pages can\'t be drawn.'); } });
  for (let i = 0; i < 3; i++) await assert.rejects(/** @type {any} */ (runningPdfPages(r)).pages(new Uint8Array(4), { max: 1, edge: 100 }), /locked with a password/);
  assert.equal(r.isDisabled('p'), false);
});

test('three crashes switch it off, as a tool\'s do: runningPdfPages is null then', async () => {
  const r = new Registry({ maxFailures: 3 });
  r.add('p', 'pdf-pages', { id: 'x', pages: async () => { throw new TypeError('boom'); } });
  for (let i = 0; i < 3; i++) await assert.rejects(/** @type {any} */ (runningPdfPages(r)).pages(new Uint8Array(4), { max: 1, edge: 100 }), /boom/);
  assert.equal(r.isDisabled('p'), true);
  assert.equal(runningPdfPages(r), null);
});

test('the limits: at most 10 pages, 1600 px on the longest side', () => {
  assert.equal(MAX_PAGES, 10);
  assert.equal(PAGE_EDGE, 1600);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test --test-timeout=60000 --import ./test/unit/pin-phone.js test/unit/pdf-pages.test.js`
Expected: FAIL, "Cannot find module …/src/core/pdf-pages.js".

- [ ] **Step 3: Implement `runningPdfPages(registry)` in `src/core/pdf-pages.js`**

Take the first `registry.entries('pdf-pages')` entry whose `item.pages` is a function. Wrap its call like a plugin tool's run in `src/core/plugins.js`: success → `registry.succeeded(pluginId)`; an error that `isPluginBug(e)` → `registry.fail(pluginId, /* en */ 'pdf pages', e)` and rethrow a `PluginError`; any other error is the plugin's answer, rethrown as it is. Add `/src/core/pdf-pages.js` to `sw.js`'s SHELL.

In `docs/plugins.md`: a row in "What `annai` gives you" for `annai.register('pdf-pages', { id, pages(bytes, { from, max, edge, signal }) })`, and a section "PDF pages" saying what annai asks for (`max` ≤ 10, `edge` 1600 for a model, 1200 for a preview), what to return (`{ count, pages: [{ type, bytes, width, height }] }`, a format every browser decodes; annai's own uses JPEG), that an `Error` in words (a locked PDF) is an answer and a crash counts against the plugin, that the first running registration is used, and that the bytes passed must be left whole (copy before handing them to a library that transfers buffers).

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test --test-timeout=60000 --import ./test/unit/pin-phone.js test/unit/pdf-pages.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp
git add src/core/pdf-pages.js test/unit/pdf-pages.test.js sw.js shell.json docs/plugins.md
git commit -F - <<'EOF'
PDF pages: the kind a plugin registers to draw a PDF's pages for annai

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG96wHTW1xUckqei4MC5Bi
EOF
```

---

### Task 2: The reading path, at tool time

Whoever can read a tool's photo or PDF reads it, for the model the result is for: Koe's models, then Utility's, then Main's (Kokoro or one Shiori); Kokoro's, then Utility's, then Koe's (Koe); then, for a PDF, its pages; and only then a note naming the setting. This widens the utility role's rule ("A model that can't see photos or read PDFs gets each photo or PDF it reads described by a model here that can, else by Main's"). Koe keeps handing a PDF she can't read to Kokoro at once ("You can't read PDFs; ask Kokoro about it."), as she answers at once: Kokoro then reads it by this path, Koe's other models included.

**Files:**
- Create: `src/core/agent/reading.js`
- Modify: `src/core/agent/loop.js` (`#described` at about lines 2206–2276 delegates to `readFile`; `#toldPdfs` keeps `Reading`s; `DESCRIBE`, `DESCRIBE_PDF`, `DESCRIBE_S`, `DESCRIBE_PDF_S`, `GOES_ON` move to reading.js and `DESCRIBE_S`/`DESCRIBE_PDF_S` are re-exported from loop.js), `src/plugins/files/index.js:99` (read's description: "a PDF as a document (in words or as pictures of its pages, if your model reads no PDFs)"), `src/ui/screens/models.js:178` (the utility note), `l10n/ja.tsv`, `l10n/zh-Hans.tsv`, `sw.js` (SHELL gains `/src/core/agent/reading.js`), `docs/superpowers/specs/2026-10-15-annai-design.md` §7.2 "PDFs" paragraph
- Test: `test/unit/agent-reading.test.js` (new), `test/unit/agent-loop.test.js`

**Interfaces:**
- Consumes: `runningPdfPages`, `MAX_PAGES`, `PAGE_EDGE` (Task 1); `chatCandidates`, `KOE_CLASSIC` from `src/core/llm/fallback.js`/`config.js`; `toBase64`, `fromBase64` from `src/core/bytes.js`.
- Produces, in `src/core/agent/reading.js`:
  ```js
  export const DESCRIBE_S = 30;      // a photo's reading limit, seconds (moved from loop.js)
  export const DESCRIBE_PDF_S = 90;  // a PDF's (moved)
  /** @typedef {{ kind: 'image' | 'pdf', mediaType: string, data: string, name?: string, path?: string }} FileToRead  data: base64 */
  /** @typedef {{ how: 'told' | 'pages' | 'none' | 'failed' | 'late' | 'stopped', text: string, images: { mediaType: string, data: string }[] }} Reading
   *   text: the line the model reads; images: page pictures, only when how is 'pages' (for a model that sees photos) */
  /** The roles that read for a half, in order: those with a chat model on, a role whose list is an earlier one's left out (an empty Utility is Main's).
   * @param {import('../llm/config.js').ModelConfig} cfg @param {'one' | 'kokoro' | 'koe'} half @returns {string[]} */
  export function readerRoles(cfg, half)   // one, kokoro: [KOE_CLASSIC, 'utility', 'main']; koe: ['main', 'utility', KOE_CLASSIC]
  /** The note when nothing here can read it, naming the setting. @param {'image' | 'pdf'} kind @param {{ plugin: boolean }} o plugin: name the PDF pages plugin */
  export function noReader(kind, o)
  /** @param {FileToRead} file @param {{ input?: string[] }} model the model the reading is for
   * @param {{ llm: { call: Function, config: () => Promise<any> }, half: 'one' | 'kokoro' | 'koe', pages: import('../pdf-pages.js').PdfPages | null,
   *   signal: AbortSignal, wakeId: string, scope: string, secondMs: number }} o @returns {Promise<Reading>} */
  export async function readFile(file, model, o)
  ```
- The words, exactly (English, for a model):
  - told: `What it says (told by ${by}, as you can't read PDFs): ${text}` (unchanged; `GOES_ON` when cut); a photo: `What it shows (described by ${by}, as you can't see photos): ${text}` (unchanged)
  - pages to the model: `Its pages as pictures, as you can't read PDFs: pages 1–${n} of ${count}.`, or when more: `…: pages 1–${n} of ${count}; the rest weren't sent.`
  - pages read by another model: `What it says (told by ${by} from pictures of its pages, as you can't read PDFs): ${text}`
  - `noReader('pdf', { plugin: true })`: `No model here can read PDFs, so what it says can't be told. Tell the user what fixes it: a model that reads PDFs (Takes PDFs on its page in Settings → Models), or the PDF pages plugin (Settings → Plugins → Add), which shows a PDF's pages to a model that sees photos.` With `plugin: false` the sentence ends after `Settings → Models).`
  - `noReader('image', …)`: `No model here can see photos, so what it shows can't be told. Tell the user what fixes it: a model that sees photos (Takes photos on its page in Settings → Models).`
  - pages that failed: `The PDF pages plugin couldn't draw its pages: ${e.message}` then a newline and `noReader('pdf', { plugin: false })`.
- The order inside `readFile` for a PDF: each reader role in turn with a model that takes `pdf` (a `DESCRIBE_PDF` call); then, if `pages` is not null, the pages: straight to the model when it takes `image` (`how: 'pages'`), else to the first reader role with a model that takes `image` (a `DESCRIBE_PAGES` call, new prompt, `how: 'told'`); then `noReader('pdf', { plugin })`, with `plugin` true when `pages` is null and the model, or a model of a reader role, takes `image`. For a photo: reader roles with a model that takes `image`, then `noReader('image')`. Every reader call passes `level: 'off'`, `record: { tag: 'describe', wake }`, and `firstOutputMs` equal to the reading's own limit, so a role's short wait (Koe's 8 s) doesn't cut a reading. The whole reading, pages included, stops at `DESCRIBE_S`/`DESCRIBE_PDF_S` (× `secondMs`) or at `signal`.
- The cache (loop.js `#toldPdfs`): a PDF's `Reading` is kept by `${scope}\n${bytes hash}\n${model takes image ? 'sees' : 'words'}`, only when `how` is `'told'` or `'pages'`, cleared where it is cleared today (conversation switch, Erase).

- [ ] **Step 1: Write the failing tests**

In `test/unit/agent-reading.test.js` (pure parts):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noReader } from '../../src/core/agent/reading.js';

test('with nothing here that reads a PDF, the note names the setting, and the plugin only when asked to', () => {
  assert.equal(noReader('pdf', { plugin: false }), "No model here can read PDFs, so what it says can't be told. Tell the user what fixes it: a model that reads PDFs (Takes PDFs on its page in Settings → Models).");
  assert.match(noReader('pdf', { plugin: true }), /Takes PDFs on its page in Settings → Models\), or the PDF pages plugin \(Settings → Plugins → Add\), which shows a PDF's pages to a model that sees photos\.$/);
  assert.match(noReader('image', { plugin: true }), /^No model here can see photos, .*Takes photos on its page in Settings → Models\)\.$/);
  assert.doesNotMatch(noReader('image', { plugin: true }), /PDF pages/);
});
```

In `test/unit/agent-loop.test.js`, beside the PDF tests at about line 290 (reuse `pdfKit`, `readPdf`, `say`, `useClock`; a fake plugin is `k.registry.add('pdf-pages', 'pdf-pages', { id: 'fake', pages })`):

```js
test("Koe's model reads a PDF for Kokoro before Utility's does (bookings design, goal 11)", async (t) => {
  // halves; Kokoro's model-0 takes text and photos; Koe's take PDFs (koe.input); Utility's take PDFs too.
  // …agentKit([[readPdf, say('Check-in is at 3 PM.')]], { halves: true, models: [{ input: ['text', 'image'] }], koe: { type: { rules: [/* "Give this PDF's content" → text 'Flight AN 123, SEA 08:05.' */] }, input: ['text', 'pdf'] }, utility: [{ text: 'never' }] })
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read' && e.data.half === 'kokoro');
  assert.match(r.data.content, /\nWhat it says \(told by model-koe, as you can't read PDFs\): Flight AN 123, SEA 08:05\.$/);
  assert.equal((k.sent['model-u'] ?? []).length, 0, 'Utility not asked');
});

test("with no Koe model that reads PDFs, Utility's reads it (the existing rule)", async (t) => {
  // as above with koe.input ['text']: told by model-u; model-koe was never sent a document.
  assert.match(r.data.content, /told by model-u, as you can't read PDFs/);
  assert.doesNotMatch(JSON.stringify(k.sent['model-koe'] ?? []), /"type":"document"/);
});

test("a reading has the reading's time, not the role's wait: Koe's 8-second first-words wait doesn't cut a PDF (secondMs 10)", async (t) => {
  // Koe's model answers the reading with delayMs 120 (12 s at secondMs 10).
  assert.match(r.data.content, /told by model-koe, as you can't read PDFs\): Flight AN 123/);
  const describe = (await k.events(['model.turn'])).find((e) => e.data.tag === 'describe');
  assert.deepEqual(describe.data.attempts.map((/** @type {any} */ a) => a.outcome), ['ok']);
});

test('Koe still hands a PDF she can\'t read to Kokoro at once', async (t) => {
  // Koe (koe.input ['text']) calls read on the PDF.
  const koeRead = (await k.events(['tool.result'])).find((e) => e.data.name === 'read' && e.data.half === 'koe');
  assert.match(koeRead.data.content, /\nYou can't read PDFs; ask Kokoro about it\.$/);
  assert.equal((await k.events(['model.turn'])).filter((e) => e.data.tag === 'describe' && e.data.wake === koeRead.data.wake).length, 0);
});

test('with no reader, a model that sees photos gets the PDF\'s pages as pictures, kept with the result (goal 12)', async (t) => {
  // model-0 takes ['text', 'image']; no reader; the fake plugin draws 3 pages of 3 (tiny JPEG bytes).
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.match(r.data.content, /^The PDF \/trip\/files\/booking\.pdf\.\nIts pages as pictures, as you can't read PDFs: pages 1–3 of 3\.$/);
  assert.equal(r.data.document, undefined);
  assert.equal(r.data.images.length, 3);
  for (const i of r.data.images) assert.match(i.hash, /^[0-9a-f]{64}$/, 'each page is a blob the result names');
  const next = k.sent['model-0'].at(-1).messages.at(-1).parts;
  assert.equal(next.filter((/** @type {any} */ p) => p.type === 'image').length, 3);
  assert.deepEqual(asked.map((/** @type {any} */ o) => [o.from ?? 1, o.max, o.edge]), [[1, 10, 1600]], 'the plugin was asked once, within the limits');
});

test('a PDF of 23 pages: the first 10 go, and the line says the rest weren\'t sent', async (t) => {
  assert.match(r.data.content, /pages 1–10 of 23; the rest weren't sent\.$/);
});

test('a model that sees no photos gets the pages told in words by a reader role\'s model that sees them', async (t) => {
  // model-0 takes ['text']; Utility's takes ['text', 'image'] and answers the pages.
  assert.match(r.data.content, /What it says \(told by model-u from pictures of its pages, as you can't read PDFs\): /);
  assert.equal(k.sent['model-u'][0].messages[0].parts.filter((/** @type {any} */ p) => p.type === 'image').length, 3);
});

test('pages that take longer than the PDF\'s limit stop there, and the result says it couldn\'t be read in time', async (t) => {
  // the fake pages() waits until its signal aborts (past DESCRIBE_PDF_S × secondMs), noting signal.aborted.
  assert.equal(sawAbort, true);
  assert.match(r.data.content, /\nIt couldn't be described in time \(90 seconds\)\.$/);
  assert.equal(r.data.images, undefined);
});

test('pages the plugin can\'t draw (a locked PDF) say why, and the note names the setting without the plugin', async (t) => {
  assert.match(r.data.content, /\nThe PDF pages plugin couldn't draw its pages: This PDF is locked with a password, so its pages can't be drawn\.\nNo model here can read PDFs, .*Settings → Models\)\.$/s);
  assert.equal(k.registry.isDisabled('pdf-pages'), false);
});

test('with nothing that reads it and no plugin, the note names Takes PDFs, and the plugin only when a model here sees photos', async (t) => {
  // seeing: model-0 takes ['text', 'image']; blind: a second kit whose models take ['text'] only. Neither has a reader or the plugin.
  assert.equal(seeing.data.content.split('\n').at(-1), noReader('pdf', { plugin: true }));
  assert.equal(blind.data.content.split('\n').at(-1), noReader('pdf', { plugin: false }));
});

test('pages are drawn once per conversation, never given to another, and forgotten at Erase', async (t) => {
  // readPdf twice in one trip; then another trip holding the same bytes; then hush('erase') and a read again.
  assert.equal(calls.length, 3, 'once here, once in the other trip, once after Erase');
  const [first, second] = (await k.events(['tool.result'])).filter((e) => e.data.name === 'read');
  assert.deepEqual(second.data.images.map((/** @type {any} */ i) => i.hash), first.data.images.map((/** @type {any} */ i) => i.hash));
});

test('a live Koe is never asked to read: realtime models are not chat models', async (t) => {
  // agentKit(…, { live: { origin: 'http://127.0.0.1:9' } }) as koe-tools.test.js has it; Kokoro's model takes ['text']; no other reader, no plugin.
  assert.equal(r.data.content.split('\n').at(-1), noReader('pdf', { plugin: false }));
  const tried = (await k.events(['model.turn'])).filter((e) => e.data.tag === 'describe').flatMap((e) => e.data.attempts.map((/** @type {any} */ a) => a.model));
  assert.ok(!tried.includes('m-live'), 'the realtime model was never asked to read');
});
```

Change the existing assertion at about line 312 (`/\nNo model here can read PDFs, so what it says can't be told\.$/`) to the new note: with model-0 taking photos and no plugin, `assert.equal(nr.data.content.split('\n').at(-1), noReader('pdf', { plugin: true }))`.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test --test-timeout=60000 --import ./test/unit/pin-phone.js test/unit/agent-reading.test.js test/unit/agent-loop.test.js`
Expected: FAIL: reading.js missing; Koe's model not asked; no pages.

- [ ] **Step 3: Implement `readerRoles`, `noReader` and `readFile` in `src/core/agent/reading.js`, and make `#described` use them**

`#described(output, wakeId, signal, model, failed, scope)` keeps its signature and contract: it builds a `FileToRead` for each photo the model can't see and the PDF it can't read (bytes from `m.data` or `blobBytes`), calls `readFile` with `half: this.#half.name` and `pages: runningPdfPages(this.registry)`, appends each `reading.text` to `content`, and for `how: 'pages'` puts the pages into `output.images` (with `data`, so `#runCall` stores them as the result's blobs) in place of `document`. The task tool's `failed` map keeps working as today (a `'failed'`, `'late'` or `'stopped'` reading by what was sent). `DESCRIBE_PAGES` (new, English): "These are pictures of a PDF's pages, in order. Give its content for someone who can't open it: its text word for word as far as it goes (dates, times, names, addresses, prices and numbers exactly), tables as plain lines, and what any picture in it shows. Reply with the content only."

The utility note in `src/ui/screens/models.js:178` becomes `t\`When Shiori's model can't see a photo or read a PDF, a model of Koe's that can reads it, else one here, else Main's. With the PDF pages plugin, a model that sees photos reads a PDF's pages.\`` with `ja` and `zh-Hans` rows (`npm run strings`, then fill and mark `ok` with a `Note:`). Update spec §7.2's "PDFs" paragraph: the reader order, the pages, the note naming the setting, Koe's hand-over unchanged, and "annai's own code has no PDF library; the optional PDF pages plugin draws pages as pictures". Add `/src/core/agent/reading.js` to SHELL.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test --test-timeout=60000 --import ./test/unit/pin-phone.js test/unit/agent-reading.test.js test/unit/agent-loop.test.js test/unit/agent-self.test.js`
Expected: PASS, the task tool's tests in agent-self.test.js unchanged.

- [ ] **Step 5: Commit**

```bash
npm run strings && npm run stamp
git add src/core/agent/reading.js src/core/agent/loop.js src/plugins/files/index.js src/ui/screens/models.js l10n/ja.tsv l10n/zh-Hans.tsv l10n/ja.json l10n/zh-Hans.json sw.js shell.json docs/superpowers/specs/2026-10-15-annai-design.md test/unit/agent-reading.test.js test/unit/agent-loop.test.js
git commit -F - <<'EOF'
Whoever can read a tool's photo or PDF reads it: Koe's models first, then Utility's and Main's, then its pages, and only then a note naming the setting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG96wHTW1xUckqei4MC5Bi
EOF
```

---

### Task 3: The second pass, for a file in the newest message

The user's session (trace, 04:03:30–04:04:03): Kokoro's first model read two PDFs, then timed out; Claude Opus 5.5 was passed over with "no-documents", and so was every other model. Now a model a file in the newest message kept out is tried again, once the rest have failed, with what the reading path made of that file.

**Files:**
- Modify: `src/core/llm/fallback.js` (`callRole`, about lines 389–551), `src/core/llm/contract.js` (Request typedef: `newestDocument`), `src/core/llm/service.js:466-476` (`call` passes `read` through), `src/core/agent/loop.js` (the turn's `this.llm.call` at about line 1752 passes `read`; a new `#readFor`), `docs/superpowers/specs/2026-10-15-annai-design.md` §9.6 "The list also handles capability gaps"
- Test: `test/unit/llm-fallback.test.js`, `test/unit/agent-loop.test.js`

**Interfaces:**
- Consumes: `readFile`, `Reading`, `FileToRead` (Task 2).
- Produces:
  ```js
  /** What to send in place of a photo or PDF a model can't take, for the model about to be called; it never throws.
   * @typedef {(part: Extract<import('./contract.js').Part, { type: 'image' | 'document' }>, model: import('./config.js').Model, signal?: AbortSignal) => Promise<import('./contract.js').Part[]>} ReadFor */
  // callRole(c): c.read?: ReadFor. service.call({ …, read }) passes it.
  // Request: newestDocument?: boolean — the newest message holds a PDF; false sends it as a note, as newestPhoto: false does a photo.
  ```
  In `loop.js`: `#readFor(part, model, signal, wakeId)` → `Promise<Part[]>`: `readFile` with this half, then the parts `[{ type: 'text', text: \`${stub} ${reading.text}\` }, ...pages as { type: 'image', mediaType, data }]`, where `stub` is `[a PDF: ${name}]` or `[a photo: ${path}]`, as `photosAsWords` writes them. The PDF cache of Task 2 serves it too.
- The second pass: after the first has tried every model, if `c.read` is given and some attempts were `no-images` or `no-documents`, those models are tried again in order, each with a request where older files go as words (`photosAsWords`, whatever `newestPhoto` says) and each photo or PDF of the last user message that the model can't take is replaced by `await c.read(part, model, signal)`. Each is an attempt like any other (the trace shows both). A model passed over for anything else (benched, too long, off) is not tried again. The request passed in is never changed.

- [ ] **Step 1: Write the failing tests**

In `test/unit/llm-fallback.test.js` (reuse `setup` and `call`; move `pdf` and `older` out of the test at about line 185 to module level, unchanged, so these tests share them):

```js
test("a model a PDF in the newest message kept out is tried again once the rest failed, with what read made of it (the user's session, 2026-10-28)", async () => {
  /** @type {any[]} */ const seen = [];
  const spy = /** @type {any} */ ({ type: 'spy', name: 'Spy', pluginId: 'spy', run: async function* (/** @type {any} */ c) { seen.push(c.request); yield { type: 'text', text: 'Booked.' }; yield { type: 'stop', reason: 'end' }; } });
  const s = setup([[{ error: 'credit', status: 402 }], []], { types: [['spy', spy]], endpointTypes: ['scripted', 'spy'], models: [{ input: ['text', 'pdf'] }, { input: ['text'] }] });
  const fresh = { messages: [older.messages[0], older.messages[1]] };
  /** @type {any[]} */ const asked = [];
  const read = async (/** @type {any} */ part, /** @type {any} */ model) => { asked.push([part.type, model.providerId]); return [{ type: 'text', text: '[a PDF: booking.pdf] What it says (told by model-u, as you can\'t read PDFs): Flight AN 123.' }]; };
  const r = await call(s, { request: fresh, read });
  assert.equal(r.answeredBy, 'model-1');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['credit', 'no-documents', 'ok']);
  assert.deepEqual(asked, [['document', 'model-1']]);
  assert.deepEqual(seen[0].messages[1].parts[1], { type: 'text', text: "[a PDF: booking.pdf] What it says (told by model-u, as you can't read PDFs): Flight AN 123." });
  assert.equal(fresh.messages[1].parts[1], pdf, 'the request itself is not changed');
});

test('read is asked only for the newest message\'s files: an older photo goes as words', async () => {
  // the spy type of the test above as the only model, taking ['text']; an older photo (the `photo` of the test at about line 167) in an earlier
  // user message, and a newest user photo with path '/trip/files/new.webp'; newestPhoto: true.
  assert.deepEqual(asked, [['image', 'model-0']]);
  assert.match(JSON.stringify(seen[0].messages), /"text":"\[a photo: \/trip\/files\/2026-10-18-1530\.webp\]"/);
});

test('a model passed over for another reason is not tried again: too long, benched, switched off', async () => {
  const s = setup([[{ text: 'never' }]], { models: [{ input: ['text'], contextWindow: 10 }] });
  let n = 0;
  await assert.rejects(call(s, { request: { messages: [older.messages[0], older.messages[1]] }, read: async () => { n++; return []; } }),
    (e) => e instanceof AllFailedError && e.attempts.map((a) => a.outcome).join() === 'too-long');
  assert.equal(n, 0);
});

test('without read, the second pass never runs (plugins\' annai.llm, a quick decision)', async () => {
  // The existing test's rejects with 'no-documents' (the last lines of the test at about line 185) stays exactly as it is.
});

test('newestDocument: false sends a newest PDF as a note, as newestPhoto: false does a photo', async () => {
  // the spy type as the only model, taking ['text'].
  const r = await call(s, { request: { messages: [older.messages[0], older.messages[1]], newestDocument: false } });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['ok']);
  assert.deepEqual(seen[0].messages[1].parts[1], { type: 'text', text: '[a PDF: booking.pdf]' });
});
```

In `test/unit/agent-loop.test.js`:

```js
test("the reader fails after reading, and a model that reads no PDFs answers with it told in words (2026-10-28, 04:04: 'It doesn't read PDFs' on every model)", async (t) => {
  // main: model-0 takes ['text', 'pdf'] and scripts [readPdf, { error: 'credit', status: 402 }]; model-1 takes ['text'] and says 'Check-in is at 3 PM.';
  // Utility's model-u takes ['text', 'pdf'] and tells 'Hotel booking: check-in 3 PM.'
  const sent = JSON.stringify(k.sent['model-1'][0].messages);
  assert.match(sent, /\[a PDF: booking\.pdf\] What it says \(told by model-u, as you can't read PDFs\): Hotel booking: check-in 3 PM\./);
  assert.doesNotMatch(sent, /"type":"document"/);
  const turn = (await k.events(['model.turn'])).find((e) => e.data.answeredBy === 'model-1');
  assert.deepEqual(turn.data.attempts.map((/** @type {any} */ a) => a.outcome), ['credit', 'no-documents', 'ok']);
  assert.equal((await k.events(['error'])).length, 0, 'no failure shown');
});

test('the user\'s photo, when no model of Kokoro\'s sees photos: described by one that does, then answered', async (t) => {
  // main model-0 takes ['text'] and says 'A menu.'; Utility's model-u sees and describes 'A menu; the fish is circled.'; the user sends a photo with "What's this?".
  assert.match(JSON.stringify(k.sent['model-0'][0].messages), /\[a photo: \/trip\/files\/[^\]]+\] What it shows \(described by model-u, as you can't see photos\): A menu; the fish is circled\./);
  assert.equal((await k.events(['error'])).length, 0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test --test-timeout=60000 --import ./test/unit/pin-phone.js test/unit/llm-fallback.test.js test/unit/agent-loop.test.js`
Expected: FAIL: AllFailedError with `no-documents`; `read` never called.

- [ ] **Step 3: Implement the second pass in `callRole`, `newestDocument`, and `#readFor`**

In `callRole`, move the body that tries one model into an inner function both passes use; `newestDocument(request)` honours `request.newestDocument` as `newestPhoto(request)` honours `request.newestPhoto`. In loop.js, the turn's `this.llm.call({ … })` gains `read: (part, model, signal) => this.#readFor(part, model, signal ?? abort.signal, wakeId)`. Update spec §9.6's capability-gap bullet: a model skipped for a photo or PDF in the newest message is tried again once the rest have failed, with it read by whoever can (§7.2).

- [ ] **Step 4: Run them to see them pass**

Run: `node --test --test-timeout=60000 --import ./test/unit/pin-phone.js test/unit/llm-fallback.test.js test/unit/agent-loop.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp
git add src/core/llm/fallback.js src/core/llm/contract.js src/core/llm/service.js src/core/agent/loop.js docs/superpowers/specs/2026-10-15-annai-design.md test/unit/llm-fallback.test.js test/unit/agent-loop.test.js sw.js shell.json
git commit -F - <<'EOF'
A model a photo or PDF in the newest message kept out is asked again, once the rest failed, with it read by whoever can

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG96wHTW1xUckqei4MC5Bi
EOF
```

---

### Task 4: Housekeeping with files

Tidy-up failed in the user's session with "It doesn't read PDFs" on every model: the PDFs Kokoro had just read were in the newest message of the warm summary's request. A summary never needs to read a file (the part it summarizes holds what was said about it, and the newest exchange stays word for word), so warm housekeeping sends every photo and PDF as words to a model that can't take them. Koe needs nothing new: her own reads hand a PDF to Kokoro, and no PDF reaches her transcript any other way (the hand-over plan's files are read with `read`).

**Files:**
- Modify: `src/core/agent/loop.js` (`#warmSummary`, about line 1338: the request gets `newestPhoto: false, newestDocument: false`), `docs/superpowers/specs/2026-10-15-annai-design.md` (§6.5: a sentence under "Warm")
- Test: `test/unit/agent-compaction.test.js`

**Interfaces:**
- Consumes: `Request.newestDocument` (Task 3).
- Produces: nothing new for other tasks.

- [ ] **Step 1: Write the failing test**

```js
test("warm housekeeping goes on past a reader that fails to a model that reads no PDFs, the newest PDF a note (2026-10-28, 04:04)", async (t) => {
  // main: model-0 takes ['text', 'pdf'] (reads the PDF, then fails the summary with credit 402); model-1 takes ['text'] and writes 'Summary.'
  // Read the PDF, then summarizeNow() while warm.
  assert.equal(await k.agent.summarizeNow(), 'done');
  const asked = JSON.stringify(k.sent['model-1'].at(-1).messages);
  assert.match(asked, /\[a PDF: booking\.pdf\]/);
  assert.doesNotMatch(asked, /"type":"document"/);
  assert.equal((await k.events(['compaction'])).at(-1).data.mode, 'warm');
  assert.equal((await k.events(['error'])).filter((e) => e.data.kind === 'compaction').length, 0);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test --test-timeout=60000 --import ./test/unit/pin-phone.js test/unit/agent-compaction.test.js`
Expected: FAIL: `summarizeNow()` returns `'failed'`; model-1 was passed over with `no-documents`.

- [ ] **Step 3: Implement**

`#warmSummary`'s request adds `newestPhoto: false, newestDocument: false`. Spec §6.5 gets one sentence under "Warm": a model that can't take a photo or a PDF gets each as words, wherever it is in the conversation.

- [ ] **Step 4: Run it to see it pass**

Run: `node --test --test-timeout=60000 --import ./test/unit/pin-phone.js test/unit/agent-compaction.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp
git add src/core/agent/loop.js docs/superpowers/specs/2026-10-15-annai-design.md test/unit/agent-compaction.test.js sw.js shell.json
git commit -F - <<'EOF'
Tidy-up never fails for a file: warm housekeeping sends photos and PDFs as words to a model that can't take them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG96wHTW1xUckqei4MC5Bi
EOF
```

---

### Task 5: The PDF pages plugin

**Why PDF.js:** drawing a PDF page needs a whole renderer (content streams, embedded font programs, compressed images, encryption); no few hundred lines of our own do that. No browser API draws a chosen page to a canvas: Safari's `<img>` draws page 1 only, and other browsers' viewers are frames a page can't read. PDF.js (Mozilla, Apache-2.0) is pure JavaScript, the most widely used and maintained choice, and runs in every browser annai supports. PDFium or MuPDF compiled to WebAssembly would be larger, and the page's CSP (`script-src 'self'`, no `'wasm-unsafe-eval'`) would refuse them. Version 6.4.299 (2026-10-03, the newest), its **legacy** build, which carries polyfills for older engines.

**Files:**
- Create: `plugins-official/pdf-pages/annai-plugin.json`, `plugins-official/pdf-pages/index.js`, `plugins-official/pdf-pages/l10n/ja.json`, `plugins-official/pdf-pages/l10n/zh-Hans.json` (written by `npm run strings`), `plugins-official/pdf-pages/vendor/pdfjs/` (below), `scripts/make-pdf-fixtures.mjs`, `test/fixtures/pdf/booking.pdf`, `test/fixtures/pdf/scan.pdf`, `test/browser/suites/pdf-pages.js`, `docs/deps.md`
- Modify: `sw.js:527` (`SAFE_PLUGIN_TYPES` gains `'application/octet-stream'`), `tsconfig.json` (`"exclude": ["plugins-official/*/vendor/**"]`), `scripts/strings.mjs` `jsFiles` (skips a `vendor` folder), `test/unit/credits.test.js` `walk` (skips a `vendor` folder: vendored code names hosts it never contacts), `test/e2e/browser-suites.spec.js` (adds `'pdf-pages'`), `test/e2e/sw.spec.js` (the safe-types test), `catalog/plugins.json`, `catalog/l10n/*.json` (by `npm run catalog`), `l10n/ja.tsv`, `l10n/zh-Hans.tsv`
- Test: `test/browser/suites/pdf-pages.js`, `test/e2e/sw.spec.js`

**Interfaces:**
- Consumes: the `pdf-pages` contract (Task 1).
- Produces: `export function activate(annai)` registering `{ id: 'pdfjs', pages }`, and `export async function pages(bytes, { from = 1, max, edge, signal })` → `Promise<Drawn>` (JPEG, quality 0.85, white behind the page, longest side `edge`, never larger than a page's own size at 4× scale).
- The manifest:
  ```json
  { "id": "pdf-pages", "name": "PDF pages", "version": "0.1.0", "api": 1, "l10n": ["ja", "zh-Hans"], "entry": "index.js", "category": "tools",
    "description": "Shows a PDF's pages as pictures to models that see photos but can't read PDFs, and draws a PDF's first page for its preview in any browser. It brings Mozilla's PDF.js, about 4.5 MB.",
    "keywords": ["PDF.js"], "homepage": "https://github.com/annai-guide/annai/blob/main/docs/plugins.md#pdf-pages" }
  ```
  `api: 1`: it uses only `annai.register`, which API 1 has (LESSONS, 2026-10-27: `api` is the oldest host it needs). An older annai would install it and never call it, which breaks nothing.
- `vendor/pdfjs/` holds, from the package: `LICENSE`; `build/pdf.min.mjs` and `build/pdf.worker.min.mjs` (from `legacy/build/`); `cmaps/` (all 169, for CJK PDFs whose fonts aren't embedded); `standard_fonts/` (all 16, with their licences); `wasm/openjpeg_nowasm_fallback.js`, `wasm/jbig2_nowasm_fallback.js` and their `LICENSE_*` files. Not shipped: the source maps, `quickjs-eval.*` (no PDF scripting), the `.wasm` files (the page's CSP refuses WebAssembly), `pdf.sandbox`, `image_decoders`, `web/`, `types/`.
- How `pages()` calls PDF.js (decisions; the builder confirms each against the source read in Step 2): `import()` the build on the first call, never at `activate` (activate stays instant, and nothing loads until a PDF needs it); `GlobalWorkerOptions.workerSrc` = the worker file's URL beside `import.meta.url`; `getDocument({ data: bytes.slice(), cMapUrl, cMapPacked: true, standardFontDataUrl, wasmUrl, useWasm: false, useWorkerFetch: false, enableXfa: false, verbosity: 0 })` (the copy: PDF.js transfers the buffer; `useWorkerFetch: false`: the page fetches cmaps and fonts, through annai's service worker); a `PasswordException` becomes `Error("This PDF is locked with a password, so its pages can't be drawn.")`, an `InvalidPDFException` `Error("This file isn't a PDF that can be read.")`, and an engine without `Promise.withResolvers` gets a four-line shim before the import; `signal` destroys the loading task; `finally` destroys the document.

- [ ] **Step 1: Make the fixtures**

`scripts/make-pdf-fixtures.mjs` (dev only, no dependency; writes the objects, the xref table and the trailer itself, deterministically) writes:
- `test/fixtures/pdf/booking.pdf`: 3 US-letter pages in Helvetica (not embedded), made-up words only: page 1 "ANNAI AIR · Confirmation TEST42 · Flight AN 123 · Seattle SEA 08:05 → Anchorage ANC 11:20 · Fri Nov 20, 2026 · Seat 14D"; page 2 "Return · Flight AN 124 · Anchorage ANC 13:00 → Seattle SEA 17:35 · Fri Nov 27, 2026"; page 3 "Bags: one carry-on, one checked".
- `test/fixtures/pdf/scan.pdf`: 1 page holding only `test/fixtures/photos/upright.jpg` (`/DCTDecode`, its left half red, its right half blue) drawn over the page, with no text.

Run: `node scripts/make-pdf-fixtures.mjs && ls -l test/fixtures/pdf`
Expected: two files, each under 8 KB; running it again leaves them byte for byte the same (`git diff --stat` empty after a second run).

- [ ] **Step 2: Vendor PDF.js and read its integration surface**

```bash
S=/tmp/claude-0/-mnt-optane-work/1e786df4-3f8f-4d41-b3c7-86bd210df129/scratchpad/reading-files/pdfjs
mkdir -p "$S" && cd "$S" && timeout 120 npm pack pdfjs-dist@6.4.299
node -e "const c=require('crypto'),f=require('fs');console.log('sha512-'+c.createHash('sha512').update(f.readFileSync('pdfjs-dist-6.4.299.tgz')).digest('base64'))"
mkdir x && tar xzf pdfjs-dist-6.4.299.tgz -C x
```
Expected: `sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==` (the registry's `dist.integrity`). Copy the files listed above into `plugins-official/pdf-pages/vendor/pdfjs/`, unchanged.

Read, in `x/package/legacy/build/pdf.mjs` and `pdf.worker.mjs`: `getDocument` and its options; `PDFDocumentProxy.getPage`/`destroy`; `PDFPageProxy.getViewport`/`render`/`cleanup`; `GlobalWorkerOptions` and the fake-worker fallback; how cmaps, standard fonts and the image decoders are fetched (`FetchBinaryData`, `WasmImage`); and the exceptions. Write `docs/deps.md` with one `## PDF.js (pdfjs-dist 6.4.299, legacy build)` entry: where it lives and that nothing under `src/` uses it; the integrity above and the licence (Apache-2.0; Foxit and Liberation fonts; OpenJPEG and JBIG2 decoders); what we use; its quirks and pitfalls (the transferred buffer; `useWorkerFetch`; a worker the service worker doesn't serve falls back to PDF.js's fake worker on the page; the image decoders are imported from inside the worker, so where the worker's own requests miss the service worker, JPEG 2000 and JBIG2 pictures are left out; `Promise.withResolvers` needs Safari 17.4, shimmed; no scripting, no XFA); and how to update (these steps, then a new plugin version, `npm run catalog`, and the browser suite in both engines).

- [ ] **Step 3: Write the failing tests**

`test/browser/suites/pdf-pages.js`:

```js
import { pages } from '../../../plugins-official/pdf-pages/index.js';

const fixture = async (/** @type {string} */ n) => new Uint8Array(await (await fetch(`/test/fixtures/pdf/${n}`)).arrayBuffer());
/** The share of dark pixels in a page picture, and the colour at a point (R, B, W or ?). */
async function look(/** @type {{ type: string, bytes: Uint8Array }} */ p, /** @type {[number, number][]} */ points = []) { /* createImageBitmap → OffscreenCanvas → getImageData */ }

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('the booking PDF: 3 pages, each a JPEG 1600 px on its longest side, with its words in dark pixels', async () => {
    const r = await pages(await fixture('booking.pdf'), { max: 10, edge: 1600 });
    assert.equal(r.count, 3);
    assert.equal(r.pages.length, 3);
    for (const p of r.pages) {
      assert.equal(p.type, 'image/jpeg');
      assert.equal(Math.max(p.width, p.height), 1600);
      assert.ok((await look(p)).dark > 0.002, 'text was drawn');
    }
  });
  test('max and from pick the pages: from 2, max 1 is page 2 alone, and count is still 3', async () => {
    const r = await pages(await fixture('booking.pdf'), { from: 2, max: 1, edge: 400 });
    assert.equal(r.count, 3);
    assert.equal(r.pages.length, 1);
  });
  test('a scanned page, a picture alone: red on its left, blue on its right', async () => {
    const [p] = (await pages(await fixture('scan.pdf'), { max: 1, edge: 800 })).pages;
    assert.deepEqual((await look(p, [[0.25, 0.5], [0.75, 0.5]])).colours, ['R', 'B']);
  });
  test('the bytes given are still whole afterwards', async () => {
    const bytes = await fixture('booking.pdf');
    const length = bytes.byteLength;
    await pages(bytes, { max: 1, edge: 200 });
    assert.equal(bytes.byteLength, length);
  });
  test("bytes that aren't a PDF are an answer in words, not a crash", async () => {
    await assert.rejects(pages(new TextEncoder().encode('%PDF-1.4 booking'), { max: 1, edge: 100 }), (/** @type {any} */ e) => !(e instanceof TypeError) && /PDF/.test(e.message));
  });
  test('a stopped signal stops it', async () => {
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(pages(await fixture('booking.pdf'), { max: 3, edge: 1600, signal: stop.signal }));
  });
}
```

In `test/e2e/sw.spec.js`'s safe-types test, also write `/on/x.bcmap` (bytes) and expect `200` with `Content-Type: application/octet-stream` and `nosniff`, while `page.html` and `pic.svg` stay `403`.

- [ ] **Step 4: Run them to see them fail**

Run: `timeout 1500 docker run --rm --memory=6g --ipc=host -v "$PWD":"$PWD" -v /mnt/optane/work/annai/node_modules:/mnt/optane/work/annai/node_modules:ro -w "$PWD" mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/browser-suites.spec.js test/e2e/sw.spec.js -g "pdf-pages|safe types"`
Expected: FAIL in both projects: the suite can't load `index.js`; the `.bcmap` is 403.

- [ ] **Step 5: Implement `index.js` and the manifest; widen `SAFE_PLUGIN_TYPES`; exclude `vendor/` from tsc, strings and the credits walk; translate**

`npm run strings`, then fill the plugin's `ja` and `zh-Hans` rows (`pdf-pages:@name`, `@description`, `@keywords.0`) and mark them `ok` with notes; `npm run strings` again; `npm run catalog`; `npm run stamp`. Delete `core*` dumps after the e2e.

- [ ] **Step 6: Run them to see them pass**

Run: the Step 4 command again.
Expected: PASS in chromium and webkit. Then `NODE_OPTIONS=--max-old-space-size=2048 timeout 1500 systemd-run --scope -q -p MemoryMax=6G npm run check`: green (the catalog check, strings check and tsc included).

- [ ] **Step 7: Commit**

```bash
git add plugins-official/pdf-pages scripts/make-pdf-fixtures.mjs test/fixtures/pdf test/browser/suites/pdf-pages.js test/e2e/browser-suites.spec.js test/e2e/sw.spec.js sw.js shell.json tsconfig.json scripts/strings.mjs test/unit/credits.test.js catalog/plugins.json catalog/l10n l10n/ja.tsv l10n/zh-Hans.tsv l10n/ja.json l10n/zh-Hans.json docs/deps.md
git status --short   # nothing else, and no core* dump
git commit -F - <<'EOF'
PDF pages, an official plugin: a PDF's pages as pictures for models that see photos, drawn by Mozilla's PDF.js, which lives only in the plugin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG96wHTW1xUckqei4MC5Bi
EOF
```

---

### Task 6: `previewOf()`, the first page for the screens

**Files:**
- Create: `src/ui/preview.js`, `test/browser/suites/preview.js`
- Modify: `sw.js` (SHELL gains `/src/ui/preview.js`), `test/e2e/browser-suites.spec.js` (adds `'preview'`)
- Test: `test/browser/suites/preview.js`

The "seeing bookings" plan (`docs/superpowers/plans/2026-10-28-seeing-bookings.md`, its Task 4) uses these signatures, and creates `preview.js` itself, without the plugin branch, if it lands first; it also adds its own `pdfPages(bytes)` (a page count) and `fileCard` there. If the file exists, modify it: add the plugin branch and this task's plugin tests, and leave its other exports as they are. The core function of Task 1 is named `runningPdfPages` so the two never clash.

**Interfaces:**
- Consumes: `runningPdfPages(registry)` (Task 1).
- Produces, in `src/ui/preview.js`:
  ```js
  export const PREVIEW_EDGE = 1200; // px, the plugin's first page for a preview
  /** Whether this browser's <img> draws a PDF's first page (Safari): told once, by drawing a tiny PDF made here, never by the browser's name. @returns {Promise<boolean>} */
  export function imgDrawsPdf()
  /** @param {Blob} file @param {{ registry?: import('../core/registry.js').Registry | null, signal?: AbortSignal }} [o] @returns {Promise<string | null>} an object URL the caller revokes */
  export async function previewOf(file, o = {})
  ```
  A photo type that this browser decodes (`createImageBitmap`) is itself; a PDF is itself when `imgDrawsPdf()`, else the plugin's page 1 at `PREVIEW_EDGE` when it runs, else null; a PDF the plugin can't draw is null; anything else is null. It never throws.

- [ ] **Step 1: Write the failing tests**

```js
import { previewOf, imgDrawsPdf } from '../../../src/ui/preview.js';
import { Registry } from '../../../src/core/registry.js';
import { pages } from '../../../plugins-official/pdf-pages/index.js';

const blob = async (/** @type {string} */ path, /** @type {string} */ type) => new Blob([await (await fetch(path)).arrayBuffer()], { type });
const drawn = async (/** @type {string} */ url) => { const img = new Image(); img.src = url; await img.decode(); return img.naturalWidth > 0; };

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('without the plugin, a PDF is itself exactly where this browser\'s <img> draws PDFs, else null (the file card)', async () => {
    const pdf = await blob('/test/fixtures/pdf/booking.pdf', 'application/pdf');
    const url = await previewOf(pdf, { registry: new Registry() });
    assert.equal(url !== null, await imgDrawsPdf());
    if (url) URL.revokeObjectURL(url);
  });
  test("with the plugin, every browser gets the first page as a picture at most 1200 px", async () => {
    const r = new Registry();
    /** @type {any[]} */ const asked = [];
    r.add('pdf-pages', 'pdf-pages', { id: 'pdfjs', pages: (/** @type {any} */ b, /** @type {any} */ o) => { asked.push(o); return pages(b, o); } });
    const url = await previewOf(await blob('/test/fixtures/pdf/booking.pdf', 'application/pdf'), { registry: r });
    assert.ok(url && (await drawn(url)));
    if (!(await imgDrawsPdf())) assert.deepEqual(asked.map((o) => [o.max, o.edge]), [[1, 1200]]);
  });
  test('a photo is itself; text, and a PDF nothing here can draw, are null', async () => {
    const photo = await previewOf(await blob('/test/fixtures/photos/upright.jpg', 'image/jpeg'));
    assert.ok(photo && (await drawn(photo)));
    assert.equal(await previewOf(new Blob(['Booking TEST42'], { type: 'text/plain' })), null);
    const r = new Registry();
    r.add('pdf-pages', 'pdf-pages', { id: 'x', pages: async () => { throw new Error("This file isn't a PDF that can be read."); } });
    const broken = new Blob(['%PDF-1.4 booking'], { type: 'application/pdf' });
    if (!(await imgDrawsPdf())) assert.equal(await previewOf(broken, { registry: r }), null);
  });
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `timeout 1500 docker run --rm --memory=6g --ipc=host -v "$PWD":"$PWD" -v /mnt/optane/work/annai/node_modules:/mnt/optane/work/annai/node_modules:ro -w "$PWD" mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/browser-suites.spec.js -g "preview"`
Expected: FAIL in both projects: `src/ui/preview.js` missing.

- [ ] **Step 3: Implement `previewOf` and `imgDrawsPdf` in `src/ui/preview.js`**

`imgDrawsPdf()` decodes a one-page PDF of a few hundred bytes, written as a string constant in the module, through `new Image()`, once per run (a cached promise); a failed decode is false. Add `/src/ui/preview.js` to SHELL; `npm run stamp`.

- [ ] **Step 4: Run them to see them pass**

Run: the Step 2 command again.
Expected: PASS in chromium and webkit.

- [ ] **Step 5: Commit**

```bash
git add src/ui/preview.js test/browser/suites/preview.js test/e2e/browser-suites.spec.js sw.js shell.json
git commit -F - <<'EOF'
previewOf: a file's first page for the screens, from the browser itself where it draws PDFs, else from PDF pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG96wHTW1xUckqei4MC5Bi
EOF
```

---

### Task 7: The whole path in the app

**Files:**
- Create: `test/e2e/reading-files.spec.js`
- Test: `test/e2e/reading-files.spec.js` (chromium and webkit)

**Interfaces:**
- Consumes: everything above; `startModelServer`, `modelSetUp`, `anthropicToolReply`, `openApp` from `test/e2e/helpers.js`; the model page's "Takes photos" and "Takes PDFs" checkboxes; the trip's "Add photos or files" input.

Set the model's inputs on its page in each test; don't rely on a provider's defaults (phone-fixes-1 changed Claude's). If the hand-over plan has already replaced the trip's "Add photos or files" box with its +, hand the PDF over that way instead; what is asserted stays the same.

- [ ] **Step 1: Write the tests**

```js
test('installed from the catalog, PDF pages shows a PDF\'s pages to a model that sees photos but reads no PDFs', async ({ page }) => {
  // stand-in: /b/v1/messages → [read the added PDF, then speak 'Your flight leaves at 8:05.' and sleep]
  // modelSetUp; on b-model's page: tick Takes photos, untick Takes PDFs; #/add → 'Install PDF pages' → 'Installed PDF pages.'
  // the trip: Add photos or files ← test/fixtures/pdf/booking.pdf; the file wake makes Shiori read it.
  const second = JSON.stringify(llm.bodies('/b/v1/messages')[1].messages.at(-1));
  expect(second.match(/"type":"image"/g) ?? []).toHaveLength(3); // the pages, wherever Anthropic Messages puts a tool's pictures
  expect(second).not.toContain('"type":"document"');
  expect(second).toContain('pages 1–3 of 3');
  await expect(page.getByText('Your flight leaves at 8:05.')).toBeVisible();
});

test('with nothing here that reads it, Shiori is told which setting fixes it, and nothing fails', async ({ page }) => {
  // the same, without installing the plugin: the second request's tool result names "Takes PDFs" and "PDF pages plugin";
  // no card says Shiori can't reach her model.
  expect(JSON.stringify(second)).toContain('Takes PDFs on its page in Settings → Models');
  await expect(page.getByText("Shiori can't reach her model")).toHaveCount(0);
});
```

- [ ] **Step 2: Run them**

Run: `timeout 1500 docker run --rm --memory=6g --ipc=host -v "$PWD":"$PWD" -v /mnt/optane/work/annai/node_modules:/mnt/optane/work/annai/node_modules:ro -w "$PWD" mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/reading-files.spec.js`
Expected: PASS, 4 (2 tests × chromium, webkit). If webkit fails only in PDF.js's worker, read the trace: the fake-worker fallback must still draw the pages (deps.md says so); fix in the plugin, never by skipping webkit. Delete `core*` dumps.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/reading-files.spec.js
git commit -F - <<'EOF'
e2e: a PDF read through PDF pages by a model that sees photos, and the note naming the setting without it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG96wHTW1xUckqei4MC5Bi
EOF
```

---

### Task 8: Check, size, catalog, docs

**Files:**
- Modify: `scripts/size.mjs` (`BUDGET`, with a note), `README.md:35` (the confirmations line), `docs/superpowers/specs/2026-10-15-annai-design.md` (a last read of §5.1 Kinds, §6.5, §7.2, §9.6, §18), `docs/plugins.md` (a last read)

- [ ] **Step 1: The full check**

Run: `NODE_OPTIONS=--max-old-space-size=2048 timeout 1500 systemd-run --scope -q -p MemoryMax=6G npm run check`
Expected: green. If `size` fails, raise `BUDGET` in `scripts/size.mjs` by the least that fits (to the next whole KiB above the printed size) and add to its note, in its style: "; N for reading files: whoever can read a file reads it, and PDF pages' preview (goals 11 and 12 of the bookings design)". Run the check again.

- [ ] **Step 2: The full e2e**

Run: `timeout 1500 docker run --rm --memory=6g --ipc=host -v "$PWD":"$PWD" -v /mnt/optane/work/annai/node_modules:/mnt/optane/work/annai/node_modules:ro -w "$PWD" mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test --workers=4`
Expected: 0 failed. Rerun failures alone with `--last-failed --workers=4` before treating one as real. Delete `core*` dumps.

- [ ] **Step 3: Catalog versions**

Run: `node scripts/catalog-versions.mjs /mnt/klein/deploy/annai/current/catalog/plugins.json catalog/plugins.json`
Expected: prints nothing (pdf-pages is new; no released plugin's files changed).

- [ ] **Step 4: Spec and docs**

- Main spec: §5.1 lists the `pdf-pages` kind; §7.2, §9.6 and §6.5 read as Tasks 2–4 left them; §18 names the browser suites `pdf-pages` and `preview`.
- `README.md:35`: "…Shiori reads them (or a model that can, for a model that can't; with the PDF pages plugin, a model that sees photos reads a PDF's pages) and writes each booking…".
- `docs/plugins.md` and `docs/deps.md` read once more against the code.
- Nothing goes into `docs/limitations.md`: the limits below are proposals for the user (Calls to confirm).

- [ ] **Step 5: The manual, local-only check (not in CI, not in the repo)**

Ask the coordinator for a real booking PDF from the user (the coordinator asks; a file is kept under the scratch folder only, never committed, never sent to Step or any outside service). On a local model on halo that sees photos and reads no PDFs, with PDF pages installed: Shiori reads the PDF's pages and writes the booking with the right flight times. On the user's iPhone (the user, at their pace): Safari's own preview of a PDF, and PDF pages drawing one. Record what was seen in `.superpowers/evidence/reading-files/manual.md`, with no content of the user's file.

- [ ] **Step 6: Commit**

```bash
git add scripts/size.mjs README.md docs/superpowers/specs/2026-10-15-annai-design.md docs/plugins.md docs/deps.md
git status --short
git commit -F - <<'EOF'
Reading files: the size it takes, and the spec, README and plugin guide for it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG96wHTW1xUckqei4MC5Bi
EOF
```

---

## Calls to confirm (for the coordinator to put to the user)

1. **"The other way round" for Koe:** Koe keeps handing a PDF she can't read to Kokoro at once, as now, because she answers at once and a reading can take 90 s; Kokoro then reads it by the whole path, Koe's other models included. For a photo, Koe's own reading order is Kokoro's models, Utility's, then Koe's other models.
2. **"Can read" means can and did:** a model that reads PDFs but failed this call (the session's timeout) counts as not reading it, so the next readers are asked. Otherwise the session's failure would stay.
3. **Order inside step 3:** the pages go straight to the asking model when it sees photos; otherwise a reader role's model that sees photos tells them in words.
4. **Proposed limits (not written down until the user agrees):** at most 10 pages drawn for a model (the rest said to be left out); in a browser whose service worker doesn't serve PDF.js's worker, JPEG 2000 and JBIG2 pictures inside a PDF are left out; PDF pages on iOS 16.4–17.3 is untested (PDF.js 6 targets newer Safari; one shim covers what we found), and on an engine it can't run it fails in words; installing PDF pages fetches about 190 files, 4.5 MB.
5. **API and behaviour changes:** the utility role's rule widened (Koe's models first; Models screen words changed); a new plugin kind `pdf-pages`; `callRole`'s `read` option and `Request.newestDocument`; the service worker serves `application/octet-stream` plugin files; warm housekeeping sends files as words to a model that can't take them; the "nothing can read it" note now names the setting where it used to say only that it can't be told.
