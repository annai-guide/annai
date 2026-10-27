# Localization: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** annai's screens can be shown in other languages, Chinese (Simplified) and Japanese first; dates, numbers and units look right in every language; Chinese and Japanese text is drawn with its own glyphs; plugins can carry translations. The English app grows by a few KiB, not a hundred.

**Architecture:**
- **English stays in the code, marked.** `` t`…` ``, `` tc(context)`…` `` and `plural(n, one, other)` from `src/core/l10n.js` (pure; `src/ui/dom.js` re-exports them). A message's key is a hash of its English, so a changed English flags its translations.
- **One translator's file per language**, `l10n/<tag>.tsv` (key, state, English, text, where, note), from which `scripts/strings.mjs` writes the shipped `l10n/<tag>.json` and checks everything in `npm run check`.
- **`src/app/boot.js` loads the chosen language's words before main.js is imported**, so words made at a module's top level are right; a change of language restarts annai.
- **The service worker caches only the chosen language**, in the versioned shell cache; catalogs are outside the shell budget, under one of their own.
- **Formatting goes through one set of `Intl` helpers** in `src/ui/format.js`.

**Tech Stack:** native ES modules, no build step, zero runtime dependencies; JSDoc checked by TypeScript 6.0.3; `node:test` on Node 26 (full ICU); Playwright 1.63.0 (Chromium as Pixel 7, WebKit as iPhone 15). `scripts/strings.mjs` uses the `typescript` package already in devDependencies for its parser; nothing is added.

**Spec:** `docs/superpowers/specs/2026-10-23-localization-design.md` (the design; its "Decisions for the user" were all answered as recommended on 2026-10-23). The main spec is `docs/superpowers/specs/2026-10-15-annai-design.md` (§10.9 and §14.3 after phase2-language).

**Starts from:** main **after** phase2-screens, phase2-language and pops-fix have merged (tonight, 2026-10-23). L1 needs phase2-language's `src/core/languages.js`; every step touches `sw.js` and `scripts/size.mjs`, which all three change.

---

## Global constraints

- **Every commit passes `npm run check`** (typecheck, unit tests, size, stamp, catalog, and from L1 the strings check). Steps that touch screens also pass the full e2e on both browsers. After a change to any file in sw.js's `SHELL`, run `npm run stamp`.
- **The size budget.** Each step raises `BUDGET` in `scripts/size.mjs` only by what it measured, and appends to the comment in its style: what it is for, the KiB used before and after ("2218.8 KiB used before it, 2223.1 after: the least that fits").
- **Messages follow the design's rules** ("Writing messages"): whole sentences, values as parameters, no case changes, no a/an, plurals through `plural`, numbers formatted before they go in.
- **Three kinds of words:** the user's are wrapped; a model's are not (instructions, tool descriptions and results, `[annai]` lines, the now block); a developer's are not, and are shown with `lang="en"`. When unsure, read where the string goes before wrapping it.
- **E2e locators stay English.** Change one only when its English changes, in the same commit.
- **No new dependencies.** `Intl` only; feel for `Intl.DurationFormat`.
- **Never `git stash`.** `rm` and `mv` are interactive aliases on this machine: `/bin/rm -f`, `command mv -f`.

## Running alongside other work

Tonight's three branches change these files that this plan also changes. Besides these, every step changes `sw.js` (its `SHELL` list or its stamp) and `scripts/size.mjs`, as all three branches do.

| Step | Shared with phase2-language | with phase2-screens | with pops-fix |
|---|---|---|---|
| L1 | `src/core/languages.js` (it creates it), `src/ui/languages.js` | | |
| L2 | | `drive.js`, `replay.js`, `simulate.js`, `now.js`, `trace.js`, `screens/voice.js` | `trace.js` |
| L3 | `src/core/languages.js`, `src/ui/languages.js` | `talk.js`, `dock.js`, `now.js`, `shiori.css` | |
| L4 | `src/ui/languages.js`, `src/ui/screens/shiori.js` | `src/ui/screens/shiori.js` | |
| L5 | `src/core/agent/*`, `koe/live.js`, `voice/voice.js` | nearly every screen, `halves.js`, `loop.js`, `transcript.js`, `live/*` | `trace.js`, `koe/live.js`, `realtime/open.js` |
| L6 | `src/core/languages.js`, `agent/context.js`, `koe/instructions.js`, the spec | `welcome.js`, the spec | the spec |
| L7 | seven official plugins' manifests, `catalog/plugins.json` | `remote-trace`'s manifest, `catalog/plugins.json` | |
| L8 | | `shiori.css` | |

All of them merge before L1 starts, so none of these is a live conflict tonight. **After tonight, the risk is the next branches:**

- **L5's batches touch every screen** with many small edits (a `t` on each string). Run a batch only when no other open branch edits its files, and merge it within a day. Its batches are cut by area so the rest of annai stays open to other work.
- **L2 and L3** are small and can run side by side (they share only `now.js`, in different lines).
- **L7** conflicts with any plugin or catalog work; **L8** with any CSS work.
- The phase2-search worktree is at d0658c5 with no commits; if it starts, it shares `search-panel.js` and `tools.js` with L5d and the search plugins' manifests with L7.

## Size, step by step

Estimates from the prototype and the measurements in the design; each step measures its own.

| Step | Shell (size.mjs) | Outside the shell |
|---|---|---|
| L1 The machinery, and English from one area | +4 to 5 KiB (runtime about 2.8, boot.js about 1, sw.js about 0.5) | the pseudo-locale module, dev only |
| L2 Formatting | +1 to 2 KiB | |
| L3 Glyphs | +0.5 to 1 KiB | |
| L4 The setting; Chinese and Japanese begin | +2 to 3 KiB | two partial catalogs, about 10 KiB each |
| L5 The remaining areas (7 batches) | +5 to 8 KiB in all (about 1 byte a message, 3 bytes a screen's import, 40 bytes a core file's, and sentences made whole) | the catalogs grow to about 160 to 175 KiB each |
| L6 Chinese and Japanese ship | +0.5 to 1 KiB | |
| L7 Plugins | +2.5 to 3.5 KiB | `catalog/l10n/*.json`, a few KiB each; translations inside plugin packages |
| L8 Right-to-left | +1 to 2 KiB | |
| **All** | **about 17 to 25 KiB** | |

For comparison, keyed messages in an English module would cost about 100 to 125 KiB (the design, section 1).

---

## L1: The machinery, and English from one area

**Builds first.** The runtime, the start, the strings script and its check, the pseudo-locale, and two small areas wrapped end to end: the Trips screen and phase2-language's Languages section (whose words were gathered into `LANGUAGE_WORDS` for exactly this). No language but English ships yet; nothing changes for the user.

**Files:**
- Create: `src/core/l10n.js`, `src/app/boot.js`, `src/core/l10n-list.js` (generated), `src/core/l10n-pseudo.js` (dev only, not in `SHELL`), `scripts/strings.mjs`, `l10n/languages.json` (`[]`), `test/unit/l10n.test.js`, `test/unit/strings.test.js`, `test/fixtures/strings/` (a few small source files and TSVs), `test/e2e/l10n.spec.js`.
- Modify: `index.html` (load boot.js), `sw.js` (`SHELL` gains boot.js, l10n.js, l10n-list.js; an empty `LANGS`), `scripts/stamp.mjs` (hash `LANGS`' catalogs too), `scripts/size.mjs` (the catalog budget), `package.json` (`"strings"`, and `node scripts/strings.mjs --check` in `check`), `playwright.config.js` (`locale: 'en-US'`), `src/ui/dom.js` (re-export), `src/core/languages.js` (`LANGUAGE_WORDS`), `src/ui/languages.js` (the glued sentences), `src/ui/screens/trips.js`, `src/core/after/stamps.js` (`stampCount`), `src/ui/format.js` (`backupText` only).

### Task 1: The runtime

- [ ] **Write the failing tests** in `test/unit/l10n.test.js`:
  - `t` gives the English with values in place when no words are set;
  - with `setWords('ja', { [key('Last backup {0}, to {1}.')]: '{1}への最後のバックアップ: {0}' })`, `` t`Last backup ${a}, to ${b}.` `` gives the Japanese with the values reordered;
  - a translation whose placeholders differ (`'{0} only'` for a two-value source) gives the English;
  - `` tc('verb')`Open` `` and `` t`Open` `` look up different keys;
  - `plural(n, '# stamp', '# stamps')` in English for 0, 1, 2 and 1000 ("1,000 stamps"); in `ja` with `{ other: 'スタンプ #個' }` for 1 and 3; in `ar` with six forms for 0, 1, 2, 3, 11, 100 (the categories from `Intl.PluralRules`);
  - in `ar`, values come back wrapped in U+2068 … U+2069; in `en` and `ja`, not;
  - `setWords` again forgets what call sites cached;
  - `key` of the 3 example messages in the design are `yeiyfl`, `33pqd9` and `1e9ja08`.
- [ ] Run `node --test test/unit/l10n.test.js`: it fails (no module).
- [ ] **Write `src/core/l10n.js`** (the shape below; JSDoc types for tsc, comments in the project's style):

```js
/**
 * annai's words in the interface's language (localization design, section 1). English is written where it is used, marked:
 * t`…`, tc(context)`…`, plural(n, one, other). A message's key is a hash of its context and English, so changed English
 * flags every translation of the old. With no words set, the English is shown; a translation is used only when its
 * placeholders are the English's. Pure: core and the screens use it alike, and boot.js sets the words before main.js loads.
 */
import { SHIPPED } from './l10n-list.js';

const RTL = ['ar', 'he', 'fa', 'ur'];
let tag = 'en';
/** @type {Record<string, string | Record<string, string>> | null} */
let table = null;
/** @type {((english: string) => string) | null} a pseudo-locale's transform (development only) */
let pseudo = null;
/** @type {WeakMap<TemplateStringsArray, (string | number)[]>} */
let seen = new WeakMap();
/** @type {Intl.PluralRules | null} */
let rules = null;

/** Sets the interface language and its words, once at the start (and in tests). @param {string} next @param {Record<string, any> | null} words @param {(english: string) => string} [transform] */
export function setWords(next, words, transform) { tag = next; table = words; pseudo = transform ?? null; seen = new WeakMap(); rules = null; }
/** The interface's language tag ("en", "ja", "zh-Hans"). */
export const lang = () => tag;
/** The interface's direction. */
export const dir = () => (RTL.includes(tag.split('-')[0]) ? 'rtl' : 'ltr');

/** FNV-1a, 32 bits, base 36: a message's key. @param {string} s */
export function key(s) { … }
// find(source, context): the translation if its placeholders match, else the (pseudo-transformed) English.
// t, tc and plural as in the design's sketch; fill() wraps values in U+2068/U+2069 when dir() is 'rtl'.
export { SHIPPED };
```

- [ ] Run the tests: they pass. Run `npm run typecheck`.
- [ ] **Commit:** "The words machinery: t, tc and plural, keyed by a hash of their English (localization L1)".

### Task 2: The strings script

- [ ] **Write failing tests** in `test/unit/strings.test.js` against `test/fixtures/strings/`: a source with a `t`, a `tc`, a `plural` and a bare literal in a `text:`; a `ja.tsv` with one `ok` row, one stale row, one row with a placeholder missing, and a plural row with `one` (Japanese has only `other`). `check()` reports each, by file and line; `update()` adds a `new` row, removes the stale one, and carries a translation over as `draft` with "English was: …" when the English changed by a little in the same file; the JSON it writes has only keys and texts; two messages with one key are reported.
- [ ] **Write `scripts/strings.mjs`** (Node, `typescript`'s parser via `createSourceFile`, no type checking):
  - **extract**: every `` t`…` ``, `` tc('…')`…` `` and `plural(n, '…', '…')` in `src/` (and, from L7, `plugins-official/`), with the English (values as `{0}`…), the context, the first place it is used and each value's expression text for the note. A `plural` whose forms aren't string literals, or a `t` used as a plain function, is an error: the script can't read it.
  - **default run** (`npm run strings`): rewrites each `l10n/<tag>.tsv` (sorted by where), writes `l10n/<tag>.json` and `src/core/l10n-list.js` (`export const SHIPPED = Object.freeze([...])` from `languages.json`'s shipped tags, with `'en'` first).
  - **`--check`**: the design's list (missing or `new` rows in a shipped language, and from L4 in an experimental one; stale rows; placeholders; plural categories from `Intl.PluralRules(tag).resolvedOptions().pluralCategories`; key collisions; generated files current; bare literals in the certain places, in the files listed as extracted). Prints draft counts. Exits 1 on any failure.
  - **`--find [paths]`**: the scanner of the design's measurement, as a list: file:line, a guess at who reads it, the text. Each L5 batch starts from it.
  - **`--review <tag>`**: the drafts as a Markdown table.
  - **The extracted files** are a list at the top of the script (`EXTRACTED`), which each step extends; L5's last batch replaces it with whole folders.
  - **TSV**: tabs and line breaks in a message written as `\t` and `\n`; a header row; UTF-8.
- [ ] Add `"strings": "node scripts/strings.mjs"` and `&& node scripts/strings.mjs --check` at the end of `check` in package.json.
- [ ] Run the tests and `npm run check`: they pass (no language yet, so only the extracted files' bare literals and collisions are checked).
- [ ] **Commit:** "scripts/strings.mjs finds, gathers and checks annai's words, in npm run check (localization L1)".

### Task 3: The start

- [ ] **`src/app/boot.js`:** reads `localStorage['annai.ui']` in a try (blocked storage is English), else matches `navigator.languages` against `SHIPPED` by `new Intl.Locale(x).maximize()`'s language and script; on localhost or 127.0.0.1 only, `?l10n=en-XA` or `?l10n=ar-XB` imports `../core/l10n-pseudo.js`. Sets `document.documentElement.lang` and `.dir`. For a tag other than English, fetches `/l10n/<tag>.json` and calls `setWords`; on any failure, English and a flag main.js turns into a card (L4 writes the card's words). Then `await import('./main.js')`.
- [ ] `index.html`: `<script type="module" src="/src/app/boot.js">`; main.js is no longer named there.
- [ ] `sw.js`: `SHELL` gains `/src/app/boot.js`, `/src/core/l10n.js`, `/src/core/l10n-list.js`; add `const LANGS = [];` beside it (written by strings.mjs from L4). `scripts/stamp.mjs` hashes `/l10n/<tag>.json` for each tag in `LANGS` after the `SHELL` files.
- [ ] `playwright.config.js`: `use: { …, locale: 'en-US' }`.
- [ ] Run the full e2e on both browsers: everything passes as before (the start is one module longer).
- [ ] **Commit:** "annai starts through boot.js, which sets the page's language and loads its words before the app (localization L1)".

### Task 4: The pseudo-locale

- [ ] **`src/core/l10n-pseudo.js`** (not in `SHELL`): `en-XA` maps ASCII letters to accented ones, keeps `{0}`… and `#`, pads by 40% with `·`, and brackets the message in ⟦ ⟧; `ar-XB` reverses letter order inside words and is right-to-left. boot.js passes it to `setWords('en-XA', null, transform)`.
- [ ] **`test/e2e/l10n.spec.js`:** `/?l10n=en-XA#/trips` shows the Trips title and the empty line in pseudo text, `<html lang="en-XA">`; a helper `unmarked(page)` lists the text nodes of `main` that are plain ASCII words outside ⟦ ⟧ and not user content (the trip names it made). It is a report, printed for the builder, not an assertion: it also lists what `Intl` writes in English for `en-XA` (relative times, dates) and the parts not extracted yet (the open-file button). Each L5 batch reads it for its screens.
- [ ] **Commit:** "A pseudo-locale, en-XA, shows which words escaped and where words 40% longer don't fit (localization L1)".

### Task 5: English from the Trips screen and the Languages section

- [ ] `src/ui/dom.js` re-exports `t`, `tc` and `plural` from `../core/l10n.js`.
- [ ] `src/ui/screens/trips.js`: every user-facing literal through `t`; "Archived trips (${n})" stays one message with its number; `explain()`'s two messages too. `src/core/after/stamps.js:64` `stampCount` becomes `plural(n, '# stamp', '# stamps')`. `src/ui/format.js`'s `backupText` (52–55) becomes three whole messages ("not backed up", "backed up {0}", "backed up {0}, changed since").
- [ ] `src/core/languages.js`: each `LANGUAGE_WORDS` value through `t` (its functions return `` t`…` ``). `src/ui/languages.js:44`'s `${said}. ${W.saved}` becomes a message per status ("{0} moved to {1}. Saved"), and `:117`'s `W.follow.toLowerCase()` a message of its own ("Shiori answers in the language you speak to her"). The model-facing sentences in languages.js (`languagesText`, `speakerLine`, `strayNote`) are not wrapped.
- [ ] Add the three files to `EXTRACTED`. Run `npm run strings -- --find src/ui/screens/trips.js src/ui/languages.js src/core/languages.js`: nothing left but `/* en */`.
- [ ] Run `npm run check` and the e2e (`trips`, `languages`, `phone-fit`, `l10n`) on both browsers.
- [ ] Measure: `npm run size`; raise `BUDGET` by what it takes, with its note.
- [ ] **Commit:** "The Trips screen and the Languages section speak through t (localization L1)".

**Done when:** `npm run check` runs the strings check; the pseudo-locale shows the two areas in pseudo text and the rest in plain English; the English app looks and tests exactly as before; the shell grew by about 4 to 5 KiB.

---

## L2: Formatting through Intl

Every place in the design's "Every place that changes" table, through one set of helpers. Visible to the user in English too: a British phone gets British dates, a booking's zone is named ("PT"), and "1,5" typed on a German phone is 1.5.

**Files:**
- Modify: `src/ui/format.js` (helpers: `num`, `money`, `size`, `distance`, `duration`, `relTime`, `day`, `dateRange`, `when`, `zone`, `list`, `languageName`, `sortWords`, `parseNum`, and `locale()`, the interface language with the phone's region); `src/core/plan.js` (75–78, 120–141, 101); `src/ui/screens/backups.js:194`; `src/ui/screens/trace.js:77, 108, 146, 150`; `src/ui/offline-pack.js:15, 41, 53`; `src/ui/screens/replay.js:35, 41, 53`; `simulate.js:59`; `src/ui/screens/plan.js:30`; `drive.js:32, 46`; `now.js:31, 133`; `booking.js:49`; `src/ui/trip-rows.js:26`; `src/ui/screens/provider.js:22–25`; `src/ui/screens/voice.js:105`; `src/ui/search-panel.js:45`; `src/core/llm/fallback.js:66–67`; `src/core/agent/budgets.js:101`; `src/ui/dom.js` (number fields read with `parseNum`); `src/ui/screens/models.js` (spend per day) and the other `inputmode` number fields (16).
- Tests: extend `test/unit/ui-pure.test.js` or create `test/unit/format.test.js`; e2e `booking` (the zone named), `models` (one test with `locale: 'de-DE'`: the screens stay English, formats are `en-DE`, and a spend typed "1,5" is saved as 1.5).

### Tasks
- [ ] **Tests first**: each helper in `en-US`, `en-GB`, `ja`, `zh-Hans`, `de` and `ar` (Node's ICU; compare against `Intl` itself where the output is the platform's, and against fixed strings for annai's own rules: a cost below a cent keeps two significant digits; miles for US and GB; `parseNum('1,5')` in `de` and in `en-DE` is 1.5, and `'1,500'` in `en` is 1500).
- [ ] **Helpers** in format.js, each `Intl` object made once per locale and kept; `duration` uses `Intl.DurationFormat` where it is a function, else `NumberFormat` `style: 'unit'`.
- [ ] **Callers**: replace each place in the table. The words around numbers (`'free'`, `'cost unknown'`, "about {0} by car") go through `t` in the same edit; add the touched files to `EXTRACTED` only if the whole file is done (most are done in L5).
- [ ] Remove `andList` and `withArticle` once nothing uses them (their callers become whole messages here or in L5; leave them while callers remain).
- [ ] `npm run check`, the e2e on both browsers, size and its note.
- [ ] **Commit** per group (format.js and its tests; the plan and trip screens; costs; durations and times; number fields).

**Does not change:** the model-facing times (src/core/time.js, agent/context.js, koe/context.js, budgets.js:13), `localDay`, coordinates.

**Distances:** the region rule as today, until the user answers decision 4; the Distances choice, if wanted, is an L6 task.

---

## L3: Chinese and Japanese drawn right

Needs no catalog. Fixes the user's Chinese conversations now (the design, section 6).

**Files:**
- Modify: `src/ui/tokens.css` (32–33: the stacks lose `'Hiragino Sans'`, `'Noto Sans JP'` and `'Hiragino Maru Gothic ProN'`; `:root:lang(ja)` puts Hiragino Maru Gothic ProN back in the display stack); `src/ui/base.css` (`:lang(ja) { line-break: strict }`, `:lang(ko) { word-break: keep-all }`); `src/ui/shiori.css:138` (the caption's italic off under `:lang(ja)`, `:lang(zh)`, `:lang(ko)`); `src/core/languages.js` (`tagOf(text, settings)`: a BCP 47 tag for a line, from `languageOf` and `listedFor`, or the fixed answer language; '' when unsure; zh → `zh-Hans`, yue → `yue-Hant`); `src/ui/screens/talk.js` (each line's `lang`); `src/ui/dock.js` (the bubble); `src/ui/cards.js` (a card's text); `src/ui/screens/now.js` (Shiori's card); `src/ui/screens/recap.js`; `src/ui/languages.js` (own names in `lang` spans; an `<option>` gets `lang` only when its text is the own name alone); `dir="auto"` on user content: trip names (`trips.js`, `trip.js`, crumbs), file names (`file.js`), the conversation's lines.
- Tests: `test/unit/languages.test.js` (`tagOf`: kana → ja; Han alone → the listed Chinese, or ja when only ja is listed; Hangul → ko; Latin → ''); e2e `test/e2e/l10n.spec.js` (a conversation with a Chinese and a Japanese line, by the scripted model: the lines carry `zh-Hans` and `ja`; the body's computed `font-family` doesn't name Hiragino).

### Tasks
- [ ] Tests first; then `tagOf`; then the screens; then the CSS.
- [ ] **Device check** (the user's iPhone, added to `docs/testing/device-checklist-koe.md` or a new l10n checklist): a Chinese and a Japanese line with 直骨角 are drawn differently; VoiceOver reads each with its own voice.
- [ ] `npm run check`, the e2e on both browsers, size and its note. **Commit.**

---

## L4: The setting; Chinese and Japanese begin

The interface language becomes a setting (decision 2), offered languages come from `l10n/languages.json`, and zh-Hans and ja start as **experimental** with drafts for everything extracted so far. From here on, every step that adds or changes English writes zh-Hans and ja drafts in the same commit. **Needs decisions 2, 3 and 5.**

**Files:**
- Create: `l10n/ja.tsv`, `l10n/zh-Hans.tsv`, `l10n/ja.json`, `l10n/zh-Hans.json`, `l10n/glossary.tsv` (the screens' and things' names; what is never translated).
- Modify: `l10n/languages.json` (`[{ "tag": "ja", "status": "experimental" }, { "tag": "zh-Hans", "status": "experimental" }]`); `scripts/strings.mjs` (writes `LANGS` in sw.js, and `EXPERIMENTAL` beside `SHIPPED` in `l10n-list.js`; `new` rows fail for experimental languages too); `sw.js` (install caches the interface language's catalog: the choice from `sys:settings` `/app.json`'s `languages.ui`, read as `handled()` reads `/push.json`, else the worker's `navigator.languages` against `LANGS`; a `'cache-words'` message that fetches one catalog into `CACHE` and answers); `src/app/boot.js` (the card when the words couldn't load); `src/ui/languages.js` ("annai's screens in" row: As this phone is set (…), then each language by its own name; choosing asks the worker to cache, then saves `languages.ui`, writes `annai.ui`, and restarts as Settings → Updates does); `src/ui/screens/experimental.js` ("Unfinished translations" switch, which offers experimental languages); `src/app/main.js` (at start, the app settings' choice against `annai.ui`: when they differ, write the copy and offer a restart on a card); `src/ui/screens/import.js` (a restore writes `annai.ui` before its restart); `scripts/size.mjs` (reports each catalog against its 200 KiB budget).
- Tests: `test/unit/l10n.test.js` (matching: `['zh-TW', 'ja-JP']` with ja and zh-Hans shipped is `ja`; `['en-GB']` is `en`); `test/unit/strings.test.js` (experimental languages' `new` rows fail); e2e `l10n.spec.js` (Experimental's switch, choose 日本語, the restart, `<html lang="ja">`, the Trips title in Japanese, still Japanese after going offline and reloading; As this phone is set under `locale: 'ja-JP'` is Japanese only once ja ships, so not yet); a check that the worker's cache holds the catalog after the choice, and again after a new version installs.

### Tasks
- [ ] Glossary first (the user's names for screens matter more than any sentence): draft it, and ask the user to read it before the drafts are written.
- [ ] Drafts for the extracted messages (L1, L2's words): `npm run strings`, then fill the `new` rows of both languages as `draft`.
- [ ] The setting, the worker, the restart, Experimental's switch; tests.
- [ ] `npm run check`, e2e on both browsers, size and its note. **Commit** in three: the glossary and drafts; the worker and boot; the setting.

---

## L5: The remaining areas

Seven batches, each a commit or two and a merge of its own. For each batch:

- [ ] `npm run strings -- --find <the batch's files>`: the list to do.
- [ ] Wrap the user's words; leave a model's and a developer's (`lang="en"` where a developer's reach the screen). Make glued sentences whole, plural ternaries `plural`, case changes CSS or messages.
- [ ] Where words are stored, store data and make the words at display (the design, "Store data, not words"); old events are shown as stored, with `lang="en"`.
- [ ] Add the files to `EXTRACTED`; `--find` on them lists nothing but `/* en */`.
- [ ] `npm run strings`, then zh-Hans and ja drafts for the new rows.
- [ ] `npm run check`; e2e on both browsers, and `phone-fit` under `en-XA` for the batch's screens; fix the overflows it finds.
- [ ] Size and its note. **Commit and merge.**

| Batch | Files | Notes |
|---|---|---|
| **L5a** The shell | `shell.js`, `router.js`, `dock.js`, `notices.js`, `cards.js` (42: the name as a message, capitals by CSS), `dom.js` (`twoStep`, `jsonField`, `messageOf`'s joins), `install.js`, `platform.js`, `updates.js`, `src/app/claim.js`, `src/app/main.js` (58–70), `index.html` (20: Shiori's mark, no words), `storage-full.js`, `unlock.js`, `mic-help.js`, `live-help.js`, `wake-lock.js`, `slots.js`, `media-keys.js`, `tap-keeps-keyboard.js`, `dock-hides.js`, and **`crumb(href, label)`** for the 33 back links, its arrow a span hidden from screen readers | The 84 e2e lines naming "← …" change to the label alone, in this commit |
| **L5b** Trips and the trip | `trip.js`, `plan.js`, `booking.js`, `file.js`, `now.js`, `drive.js`, `replay.js`, `recap.js`, `stamps.js`, `trip-rows.js`, `photo-viewer.js`, `add-files.js`, `open-file.js`, `bring-in.js`, `offline-pack.js`, `format.js` (`placeStatus`, `newerText`, `OUTCOMES`) | `newerText` (165–172) becomes whole sentences per device kind |
| **L5c** Conversation, voice and Shiori | `talk.js`, `talk-panel.js` (its words; its test prompt stays English), `voice-chip.js`, `live-chip.js`, `speech-check.js`, `model-check.js`, `screens/voice.js`, `screens/shiori.js`, `avatar.js` (labels), `welcome.js`, `screens/welcome.js`, `ask.js`, `markdown.js` (no words, check), `grounding.js` ("From Google Search") | A wake is shown from its kind and parameters, not the model's wake text; a reminder line from its data |
| **L5d** Models and tools | `models.js`, `model.js`, `provider.js`, `provider-setup.js` (239–241), `add.js`, `search-panel.js`, `tools.js`, `mcp.js`, `credits.js` (licence attributions `/* en */`, their explanations wrapped), `privacy.js` | |
| **L5e** Plugins, backups, settings | `plugins.js`, `plugin.js` (62), `plugin-install.js`, `plugin-cards.js`, `plugin-pending.js`, `plugin-updates.js`, `settings-form.js`, `backups.js`, `auto-backup.js`, `export-panel.js`, `import.js`, `import-state.js`, `save.js`, `settings.js`, `notifications.js`, `push.js`, `about.js`, `updates.js` (screen), `experimental.js`, `simulate.js`, `trace.js` (its own words; raw bodies `lang="en"`), `ext.js` | |
| **L5f** Core's words for the user | `errors.js`, `scopes.js` (37: titles made at display), `llm/contract.js` (the error kinds' words), `llm/fallback.js`, `llm/check.js`, `after/recap.js` (its errors; its prompt stays English), `after/replay.js`, `push/mirror.js`, `push/relay-client.js` (the relay's codes, not its English), `live/plan-watches.js` (fallbacks made from data), `live/live.js` (the user's parts), `voice/mode.js`, `voice/voice.js`, `voice/mic.js`, `agent/budgets.js`, `agent/loop.js` and `agent/halves.js` (only what the user sees: states, cards), `backup.js`, `backup-auto.js`, `archive.js`, `zip.js`, `inflate.js` (developer's: English), `official.js`, `packages.js` (install failures the user meets), `imports.js`, `ics.js`, `pkpass.js`, `sun.js`, `request-photos.js`; and **sw.js**: `/push.json` gains `words` (the fallback body, "In {0} min: ", "Now: ", "Started {0} min ago: ") written by the page, and the mirror sends the start time with them, so sw.js:465–469 matches no English | A sentence for both the user and a model is written twice. `EXTRACTED` gains only the user-facing core files |
| **L5g** Built-in plugins | `src/plugins/*` (tool groups' names, plugins' descriptions shown in Settings → Tools; tool descriptions and results stay English) | Then `EXTRACTED` becomes `src/ui/`, `src/app/` and the listed core and plugin files |

---

## L6: Chinese and Japanese ship

**Needs decisions 5, 6, 7, 8 and 4 (if a Distances choice is wanted).**

**Files:**
- Modify: `l10n/languages.json` (both `shipped`); `l10n/*.tsv` (the user's review: rows `ok`, texts corrected); `src/core/languages.js` (the glossary line in the languages section when the screens aren't English: one stable sentence from `glossary.tsv`, after the languages sentence; unit tests); `src/core/agent/context.js` and `src/core/koe/instructions.js` (where the section is placed, if phase2-language's builder needs it passed); `src/ui/screens/welcome.js` ("annai's screens: … · Change" on the first step when two or more languages ship); the Distances choice in `src/ui/languages.js` and `format.js` (if decided), and its line to Shiori.
- Create: `docs/translating.md`.
- Docs: the spec's §14.3 (the design's proposed text, as decided), §5.2 (`language`, `l10n`, for L7), §6.3 (the glossary line), §16.5, §18; README.
- Tests: e2e `l10n.spec.js` (As this phone is set under `locale: 'ja-JP'` and `'zh-CN'` opens in Japanese and Chinese; `phone-fit` under `ja`); unit (the glossary line is stable and absent in English); the realtime check's multilingual scenario run once with Japanese screens, to see the answer language is unchanged (docs/testing/realtime-check.md).
- [ ] An Opus review of every ja and zh-Hans draft (wrong or misleading meaning first; data-loss, cost and trust wording exact; glossary), with fixes, replaces the user's read-through (decision 5 as changed on 2026-10-26).
- [ ] The rest as above; `npm run check`, e2e, size. **Commit** per part.

---

## L7: Plugins

**Needs decision 10.**

**Files:**
- Modify: `src/core/packages.js` (manifest: `language`, `l10n`; the checks of the design's section 8; plain-words refusals); `src/core/plugins.js` (`annai.l10n`: `lang`, `dir`, `t`, `tc`, `plural` over the plugin's `messages`, and the format helpers); the screens that show a plugin's words (`plugin.js`, `plugins.js`, `plugin-install.js`, `add.js`, `settings-form.js` with `oneOf` titles, `slots.js` for its containers' `lang`); `src/core/llm/official.js` (fetch `catalog/l10n/<tag>.json` beside `plugins.json` when the screens aren't English); `scripts/catalog.mjs` (writes `catalog/l10n/<tag>.json`; checks each official plugin's `l10n` as `packages.js` does); `scripts/strings.mjs` (official plugins' messages and manifest fields into the same TSVs; writes `plugins-official/<id>/l10n/<tag>.json`); the official plugins with user-facing words (storage-github, storage-forgejo, storage-s3, storage-webdav, search-tavily, search-serper, search-searxng, provider-another-address, provider-openrouter, remote-trace, gemini-api's safety words; every provider's `description` and `note`s) wrapped with `annai.l10n.t`, translated, versions bumped; `catalog/plugins.json`; `docs/plugins.md` ("Translations").
- Tests: `test/unit/packages.test.js` (each check, accepted and refused); `test/unit/official-plugins.test.js` or the catalog check (official plugins' `l10n` valid and complete for shipped languages); a fixture third-party plugin with `ja`; e2e: the Add screen under Japanese shows a translated description; a plugin without Japanese shows its words with `lang="en"`.
- [ ] Packages and the API first (tests first); then the screens; then the catalog; then the official plugins one commit each; then the docs. `npm run check`, `npm run catalog -- --check`, e2e, size.

---

## L8: Right-to-left

**When a right-to-left language is wanted (decision 9).** The parts that cost nothing in English (logical CSS in new code, `dir="auto"` on user content in L3, isolation in `t` in L1) are done already.

**Files:**
- Modify: `src/ui/base.css`, `src/ui/shiori.css`, `src/ui/tokens.css` (the 37 physical declarations to logical ones); `src/ui/shell.js` (swipe direction); `src/ui/photo-viewer.js` (swipe and arrow keys); `crumb()` (its arrow's direction); what must not mirror marked (`avatar.js`, the replay route, media icons).
- Tests: `phone-fit` and `l10n.spec.js` under `ar-XB`; a screenshot review of every screen in `ar-XB` by the user or a reader of the language.
- [ ] As above; then the language's catalog and its reviewer, as L4 and L6 did for Chinese and Japanese.

---

## Decisions only the user makes

From the design ("Decisions for the user"), with where they bite:

| # | Decision | Recommended | Needed by |
|---|---|---|---|
| 1 | English in the code, marked, instead of "all strings in one module" (§14.3's letter) | Marked English: about 1 byte a message instead of about 45 | L1 |
| 2 | The interface language its own setting | Yes, "annai's screens in", defaulting to the phone's; not tied to "Languages you speak" | L4 |
| 3 | Carried by backups, or this device only | The app settings, with a copy on the device | L4 |
| 4 | Distances and formats: the profile (§14.3's letter) or a setting | The screens' language and the phone's region; a Distances choice; the profile's Units line hers to read | L2 (keeps today's rule), L6 |
| 5 | Unreviewed drafts ship | **Changed 2026-10-26:** ship after Opus has reviewed every draft (no read-through by the user); drafts ship with their feature after that | L4, L6 |
| 6 | Shiori, Koe and Kokoro on Chinese and Japanese screens | Latin names; 声 and 心 explained in the welcome | L4's glossary |
| 7 | Shiori told the screens' names | Yes, one stable glossary line | L6 |
| 8 | Which languages next, and who reviews | zh-Hans and ja now; others only with a reader; is Simplified the Chinese you want? | L4 |
| 9 | Right-to-left: when | Last, with a reader of the language | L8 |
| 10 | Plugin names translated | Official plugins' descriptive names only | L7 |
| 11 | Developer screens | Their own words translated; raw bodies and schema details English | L5e, L5f |

## Risks

- **A batch that wraps a model's words.** Tool results or `[annai]` lines in Japanese would confuse Shiori. Mitigation: the three-kinds rule, and the reviewer of each batch checks every wrapped string in `src/core` against where it goes; unit tests of the agent hold English for model text.
- **Words made before the catalog loads.** Anything evaluated before boot.js's `setWords` is English forever. Mitigation: boot.js imports only `l10n.js`, `l10n-list.js` and, in development, the pseudo module; a unit test imports boot's graph and checks it.
- **A stale copy of the choice.** `annai.ui` and the app settings disagree after a restore or a cleared storage. Mitigation: the start compares them and offers a restart; a restore writes the copy.
- **A new version whose words can't be fetched.** The worker doesn't install it (all or nothing, as the shell), and tries later; the old version keeps running with its own words.
- **Drafts that read badly.** The user reviews; until then they are experimental (decision 5).
- **Layout in Japanese and Chinese.** Short words, tall glyphs, no spaces: `phone-fit` under `ja` in L6, and the device check.
