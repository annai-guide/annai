# Localization: annai's screens in other languages, design

Date: 2026-10-23. Status: accepted. On 2026-10-23 the user took all 11 recommendations in "Decisions for the user" as written. Building starts with L1. The plan to build it is `docs/superpowers/plans/2026-10-23-localization.md`.

Builds on the phase2-language branch (spec §10.9, merging tonight): the languages the user speaks, the language Shiori answers in, `src/core/languages.js` (41 languages) and its words module, `LANGUAGE_WORDS`. Line numbers below are main at d0658c5 unless a branch is named.

## Why

- The user, 2026-10-22: "I personally speak English, Chinese and Japanese, so multi language in audio shall be supported. And we shall also plan for localization in other languages later."
- Spec §14.3 says the UI ships in English, "All strings live in one module, ready for translation", and that dates, numbers, units and currency are formatted with `Intl` "according to the profile". Neither is true today: the words are inline in 171 of the 243 files of `src/`, and much formatting is by hand (below). phase2-language's §14.3 calls localizing the UI "a later phase". This is that phase.
- The audio side is phase2-language's: it tells every model that hears or speaks which languages the user speaks. This design is about **annai's own words on screen**: menus, cards, errors, toasts, notifications, the install screen, and how numbers and dates look.

## Goals

1. Every word annai shows can be shown in another language, without changing the code that shows it.
2. Chinese (Simplified) and Japanese first, reviewed by the user; the machinery fits the other 39 languages of `LANGUAGES` later, right-to-left ones included.
3. The English app costs almost nothing more: no catalog in the shell, a few KiB of machinery.
4. Dates, times, numbers, money, distances, lists and "2 hours ago" look right in every language, through the platform's `Intl`.
5. Chinese and Japanese text is drawn with the right glyphs, in any interface language.
6. Plugins, official and third-party, can carry their own translations.

## Non-goals

- Translating what Shiori says. She answers in the user's language already (§10.9); the interface language doesn't change it.
- Translating the user's content: trip names, notes, files, Shiori's cards and recaps.
- Translating what models read: instructions, tool descriptions, annai's lines in the conversation (why: "What models see", below).
- A translation service or library. No i18next, no FormatJS, no ICU MessageFormat parser.

## Anti-goals (a failure even if it works)

- **Raw keys or codes on screen.** A missing word shows in English, never as `trips.empty` or `k3x9a1`.
- **Sentences glued from translated fragments.** They can't be translated well ("Back up this " + noun + " over it").
- **A heavier English app.** Key lookups in a shell module would cost about 100 KiB (below).
- **A language that half works offline.** Once chosen, it works with no connection, like the rest of annai.
- **E2e tests that break on a machine set to German.**
- **Chinese drawn with Japanese glyphs**, or the reverse.

## Constraints

- No build step: native ES modules, JSDoc checked by tsc, `node:test`. Generated files are committed and checked, as `catalog/plugins.json`, `src/core/official-names.js` and sw.js's `BUILD` are today (`npm run check` runs `stamp.mjs --check` and `catalog.mjs --check`, package.json:17).
- The shell budget: `scripts/size.mjs` counts the JS and CSS in sw.js's `SHELL`, now 2219 KiB with 2218.8 used (size.mjs:4; d0658c5's commit message). Every KiB is argued for.
- Save data on the go: nothing is downloaded that the user didn't choose.
- The floor is iOS 16.4 Safari. Every `Intl` API used is checked against it below.
- Copy is plain words. No raw codes on screen.
- Rulings can't drop spec requirements: where this design differs from the letter of §14.3, it is a decision for the user (decisions 1 and 4).

## What exists today (measured)

### The words

Measured with a scanner written for this design (TypeScript's own parser, already a dev dependency, over every string and template literal; the scratch copy is not in the repository, and plan step L1 makes it a script). A literal counts when it reads as words: letters and a space, a capital, a non-ASCII letter or closing punctuation, and it is not an import, a comparison, a key, a class name, a path, a URL or a CSS value. Then 100 random hits per area were read by hand to say who each one is for.

| Area | Literals (distinct) | With parameters | Text | Who reads them (from the hand-read sample) |
|---|---|---|---|---|
| `src/ui` | 1,809 (1,483) | 326 | 57.5 KiB | 96 of 100 the user; 4 not words (an SVG transform, a media query, a plugin author's error) |
| `src/app` | 24 | 4 | 1.0 KiB | the user (the blocking screens in main.js:58–70) |
| `src/core` | 1,271 (1,139) | 509 | 57.2 KiB | 46 of 100 the user (errors, reminders, notices, voice states), 32 a model (tool results, prompts), 5 a plugin's author, 17 not words (error kinds, voice names, language word lists) |
| `src/plugins` (built-in) | 251 (215) | 116 | 10.6 KiB | 10 of 50 the user (tool groups in Settings → Tools, plugin descriptions), 38 a model (tool descriptions and results) |
| `plugins-official` code | 400 (320) | 137 | 18.9 KiB | 22 of 50 the user (backup places' errors and notes, Gemini's safety words), 26 not words (Gemini's voice names, error kinds) |
| `plugins-official` manifests | 195 shown fields | | 15.4 KiB | 106 `name`s (mostly brands and model names), 38 `description`, 38 `note`, 9 `title`, 3 `label`, 1 `featured`: about 90 to translate |
| `sw.js` | 12 | 2 | 0.3 KiB | 3 the user: a reminder's fallback words (sw.js:465–469) |
| `index.html`, the web manifest | 4 | | | "Opening annai…", the `<noscript>` line, two descriptions |

So, roughly: **about 2,700 user-facing literals, about 2,300 distinct messages, about 85 KiB of English** in annai itself, plus about 175 literals and 90 manifest fields in the official plugins. About **600 more are for models** and stay English. The counts are good to ±10%: the scanner misses lowercase one-word values outside known places (format.js's `removed: 'removed'`), and the sample decides the core split.

The files with the most: `src/core/agent/loop.js` (138, mostly model-facing), `src/ui/screens/provider.js` (99), `settings.js` (83), `plugin-install.js` (79), `backups.js` (74), `trace.js` (71), `src/plugins/places/index.js` (67, model-facing), `storage-forgejo` (65).

The branches merging tonight barely move this: phase2-screens' `src/ui` count is 1,811, phase2-language's 1,776 (its Languages screen draws from `LANGUAGE_WORDS`), pops-fix's 1,779 (all three branch from be05577, before main's search work).

### Patterns that can't be translated as they are

- **Sentences glued from parts.** `newerText` builds "… back up this ${noun} over it" around a noun (src/ui/format.js:165–172); `placeStatus` joins "${when}. Automatic backups are off" (format.js:150–159); the Languages screen writes `${said}. ${W.saved}` (phase2-language src/ui/languages.js:44) and lowercases a translated phrase into another (`W.follow.toLowerCase()`, languages.js:117).
- **English grammar in code.** `withArticle` picks "a" or "an" (format.js:124–126; 5 uses); `andList` joins with ", " and " and " (format.js:75), as `named` does for models (phase2-language src/core/languages.js:72); 21 such joins in all.
- **Plurals by hand.** 56 choices written as `n === 1 ? … : …` (39 in `src/ui` and `src/app`, 17 in core and plugins), and 14 more that add an "s". Japanese and Chinese have one form, Arabic six.
- **Case changes.** 9 in `src/ui`: "SHIORI · ${name.toUpperCase()}" (cards.js:42), a capital forced onto a sentence (format.js:169, plugin.js:62), lowercased role names inside a sentence (provider-setup.js:241).
- **Words stored as data.** The system scopes are titled 'Me', 'System log', 'Settings' and 'Plugins' in the store (src/core/scopes.js:37); a plan reminder's `fallback` is composed in English when the watches are made (src/core/live/plan-watches.js:73–87) and kept; the Conversation shows a wake as "Shiori woke: " plus the model's own English wake text (phase2-screens src/ui/screens/talk.js:184). Done well already: "Started fresh" is drawn from the event's type at display time (phase2-screens talk.js:188).
- **Errors as English sentences.** 331 `new …Error('…')` in core, 113 in official plugins; the UI shows `err.message` (`messageOf`, src/ui/dom.js:146–157).

### Formatting

Some is `Intl` already, with the wrong locale; much is by hand. Every place is listed under "Formatting" below.

### Fonts

`--f-body` is `'Zen Kaku Gothic New', 'Hiragino Sans', 'Noto Sans JP', system-ui, …` and `--f-display` names `'Hiragino Maru Gothic ProN'` (src/ui/tokens.css:32–33). The Zen web fonts are Latin subsets (about 10 KB a weight, assets/fonts/), so every Chinese or Japanese character falls through to the next name in the stack, Hiragino Sans on an iPhone, whatever the text's language. Chinese should then be drawn with Japanese glyph forms, and a simplified character a Japanese font lacks taken from another font mid-sentence. That would be **today**, in the user's own Chinese conversations, with the English interface; L3's device check confirms it on the user's iPhone. Nothing sets `lang` on the conversation's lines. The one `lang` span is phase2-screens' welcome, for 声 and 心 (welcome.js:26).

### phase2-language's pieces

- `LANGUAGES` (41 rows: id, English name, locale and protocol codes; languages.js:18–33) and `nativeName`, a language's name for itself from `Intl.DisplayNames` (languages.js:36–45).
- `LANGUAGE_WORDS`, the Languages screen's words in one object, written "for a later pass that localizes the interface" (languages.js:200–225). Its functions take names and places as parameters, which is the shape this design wants.
- `languagesText` and the other model-facing sentences (languages.js:71–98, 198) are English for models, and stay so.

## The design

### 1. How strings are kept

#### English stays in the code, marked

A message is written where it is used, in English, marked with a tag:

```js
h('p', { class: 'empty', text: t`No trips yet. Start one below, or open a trip someone sent you.` })
h('p', { class: 'sub', text: t`Last backup ${relTime(latest.last.at)}, to ${latest.name}.` })
export const stampCount = (n) => plural(n, '# stamp', '# stamps');   // src/core/after/stamps.js:64 today: `${n} ${n === 1 ? 'stamp' : 'stamps'}`
h('button', {}, tc('verb')`Open`)
```

- `t` is a tagged template. The English, with `${…}` as `{0}`, `{1}`… in order, is the message's source.
- `tc(context)` is `t` with a context, for the rare English that means two things (gettext's msgctxt).
- `plural(n, one, other, ...values)`: the English forms; `#` is n, formatted for the language; `{0}`… are the other values.
- There are no message ids. A message's key is a hash of its context and source (FNV-1a, 32 bits, in base 36: about 6.5 characters). Over the 3,120 distinct literals measured, it has no collision; the check fails on any.

**Why not ids in an English module** (`t('trips.empty')`, the shape of i18next and of §14.3's "one module"): each message would cost its key twice (the module and the call) and a call, about 45 bytes, for about 2,700 sites: **about 100 to 125 KiB of shell**, 5% of the budget, for nothing an English user sees. The tagged form costs one byte a site (the `t`). It also keeps the words where the code is read and reviewed: this project tunes copy constantly, commit messages quote it, and 2,575 e2e locators find the screens by their English names. And it makes staleness free: when English changes, its hash changes, so every translation of the old words is flagged, which ids can't do without hashing the English anyway.

**Why not one module, as §14.3's letter says**: same reason. The intent, every word in one place ready for translation, is kept by the generated translator file of each language (below), which lists every message. Decision 1.

#### Writing messages

- **Whole sentences.** A message is a sentence, a label or a title, never part of one. Where a noun changes the sentence, write each sentence. This also covers grammatical gender and case: there is no "select" syntax, because there is nothing it does that two whole messages don't.

  ```js
  kind === 'phone' ? t`Back up this phone over it` : t`Back up this computer over it`   // not t`Back up this ${noun} over it`
  ```
- **Parameters are values, never translated words**: names, numbers already formatted, dates, file names. A message may hold whole sentences that are messages themselves (two sentences side by side), never a phrase.
- **Parameters are numbered in the English order**; a translation may use them in any order (`{1}への最後のバックアップ: {0}`). Each must appear in the translation, and no other; the check says which is missing or extra.
- **Where a parameter's gender or case is unknown** (a place name, a language), the translator may write "label: value" ("Removed: Japanese").
- **No case changes on words**: capitals and small capitals are CSS (`text-transform`), which leaves CJK alone. No `toLowerCase()` of a message, no a/an, no "s" for plurals.
- **Numbers inside messages are formatted before**, with the formatting helpers (section 4); `plural` formats its own `#`.

#### The runtime

`src/core/l10n.js`, pure (no DOM), used by core and UI alike; `src/ui/dom.js` re-exports `t`, `tc` and `plural`, so a screen that imports `h` adds three bytes, not an import line.

```js
let tag = 'en';                        // the interface language
let table = null;                      // { key: text | { one, other, … } } for it; null for English
export function setWords(next, words) { … }        // once, at boot (and in tests)
export const lang = () => tag;
export const dir = () => (RTL.includes(tag.split('-')[0]) ? 'rtl' : 'ltr');
export function t(strings, ...values) { … }        // cached per call site
export const tc = (context) => (strings, ...values) => …;
export function plural(n, one, other, ...values) { … }   // Intl.PluralRules(tag)
```

- A call site's template strings array is the same object every time, so its translation is looked up once and kept in a `WeakMap`.
- A translation is used only when its placeholders are the source's; else the English.
- In a right-to-left interface each value is wrapped in First Strong Isolate and Pop Directional Isolate (U+2068, U+2069), so a Latin trip name inside Arabic keeps its place. In a left-to-right interface nothing is added.
- A prototype of this file, with the project's comments, is 2.75 KB.

#### Where the translations live

```
l10n/languages.json      the languages annai has, each "shipped" or "experimental"
l10n/glossary.tsv        the names of annai's screens and things (Settings, Models, Trips, Koe…), per language
l10n/ja.tsv              the translator's file: one row per message
l10n/ja.json             what ships: { key: text } (generated from ja.tsv, checked)
src/core/l10n-list.js    the languages annai has, shipped and experimental, for the runtime (generated, checked)
```

`ja.tsv` has these columns:

| key | state | en | text | where | note |
|---|---|---|---|---|---|
| `yeiyfl` | ok | No trips yet. Start one below, or open a trip someone sent you. | まだ旅はありません。下で始めるか、送られてきた旅を開いてください。 | src/ui/screens/trips.js:22 | |
| `33pqd9` | draft | Last backup {0}, to {1}. | {1}への最後のバックアップ: {0} | src/ui/screens/trips.js:25 | {0} = relTime(latest.last.at), {1} = latest.name |
| `1e9ja08#other` | draft | # stamps | スタンプ #個 | src/core/after/stamps.js:64 | plural; English: "# stamp" (one), "# stamps" (other) |

(The keys are the real hashes of these messages.)

- **state**: `new` (no text yet), `draft` (a machine's or an unreviewed person's), `ok` (read by a person who reads the language).
- **where** and **note** are written by the script: the first place the message is used, and what each placeholder is (the expression's own text), so a translator sees `{1} = latest.name` without opening the code. A context shows as "context: verb".
- A plural message has one row per category the language has (`Intl.PluralRules(tag).resolvedOptions().pluralCategories`: Japanese and Chinese `other` only; Russian `one, few, many, other`; Arabic six).
- TSV because GitHub draws it as a table the user can read and search in the browser, English beside Japanese, and a diff shows one changed message as one changed line.
- The shipped JSON has only keys and texts: about half the size, and no English sent to a phone that has it already.

#### Finding the strings

`scripts/strings.mjs`, on TypeScript's parser (a dev dependency already, for tsc; nothing new):

- `--find`: the measurement above, as a list: every literal that reads as words and isn't marked, with where it is and a guess at who reads it. Each extraction step starts from it.
- the default: reads every `t`, `tc` and `plural` in `src/` and the official plugins, updates each language's TSV (new rows `new`; rows whose English is gone removed, or carried over, below) and writes the JSON files and `l10n-list.js`.
- `--check` (in `npm run check`): fails, saying which and where, on
  - a message with no text in a language `languages.json` lists, shipped or experimental (`new`, or no row), or a row whose message no longer exists (stale); a language being drafted that isn't listed yet only gets warnings;
  - placeholders that differ from the English, or plural rows that don't match the language's categories;
  - a key collision;
  - a JSON file or `l10n-list.js` that isn't what the TSV makes;
  - **a bare English literal where the screen surely shows it**: a child of `h()`, or `text`, `title`, `aria-label`, `placeholder`, `label`, `alt`, `body` in an object, or the first argument of `field`, `checkbox`, `toast`, `card`, `twoStep`. These places are certain, so the rule has no false alarms; other places are `--find`'s. A deliberate English word (a brand, a licence's own attribution) is marked `/* en */`.

  It prints, without failing, how many rows of each language are drafts.
- `--review ja`: the drafts as a Markdown table, English beside the draft, for the user to read in a terminal or a PR.
- `--pseudo`: nothing on disk; see "Tests".

#### Who reads what: three kinds of words

Each literal is one of three, decided by hand when its file is extracted (the wrapper is the decision):

- **The user's**: wrapped, translated.
- **A model's**: instructions, tool descriptions and results, `[annai]` lines, the now block. Not wrapped; English (section 7).
- **A developer's**: a plugin manifest's schema errors in depth (src/core/packages.js, src/core/ui-slots.js, src/core/storage-types.js), the Trace's raw request and response bodies, `console` lines. Not wrapped; shown with `lang="en"`. The messages a user meets when an install fails ("isn't a plugin or a skill") are the user's.

Where one sentence serves both (a reason shown on a card and told to Shiori), it is written twice: English for the model, `t` for the user.

#### Store data, not words

What annai keeps in the store or the log is data from which words are made when shown. New events and records carry a kind and parameters, and the screen makes the sentence in the language of the day:

- the system scopes' titles become words chosen by scope kind at display (scopes.js:37);
- a wake shown in the Conversation says why in the user's words from the trigger's kind and its parameters, not the model's wake text (talk.js:184, phase2-screens);
- a reminder event carries its plan item, kind and time; the line and the card are made at display.

Words that must be stored because they leave the device (a push notification's body at the relay, a commit message at GitHub) or are a model's (a recap, a summary) are stored with their language, `lang: 'ja'`, so a screen can mark them. Old events keep their English words and are shown as stored, marked `lang="en"`.

#### When a translation is missing

1. The message in the interface language's catalog.
2. A regional language falls back to its base: `pt-BR` → `pt`. Never across scripts: `zh-Hant` never falls back to `zh-Hans`.
3. English, the source. Never a key.

A listed language can't miss a message, as the check fails first; the fallback is for plugins, experimental languages and a plugin's text in its own source language (section 8).

### 2. Choosing the interface language

- **Its own setting** (decision 2): **annai's screens in**, the first row of Settings → Shiori → Languages (phase2-language's section), above "Languages you speak". The choices: **As this phone is set** (the default; it says which: "As this phone is set (English)"), then each language annai has, by its own name ("日本語", "简体中文"), in `lang` spans.
- **Not tied to the languages you speak.** They answer other questions. "Languages you speak" orders what dictation listens for (the first) and what models are told; the user speaks English, Chinese and Japanese and may want screens in any one of them, or English screens while practising Japanese with Shiori. Tying the screens to the first spoken language would change dictation when the user only wanted other menus.
- **Before the user picks**: the first of the phone's languages (`navigator.languages`) annai has, matched by language and script (`Intl.Locale(…).maximize()`: `zh-TW` is `zh-Hant`, not `zh-Hans`); else English. On a first start, the welcome's first step says "annai's screens: English · Change" when annai has two or more languages.
- **Where it is kept**: the app settings, `languages.ui` (absent: as the phone is set), so a backup carries it, as it carries the languages you speak (decision 3); and a copy on the device, `localStorage['annai.ui']`, because it is needed before anything else loads (section 3). A restore writes the copy before its restart. Erase clears it with the rest of `annai.*` (settings.js:187). If the two differ at start (the copy was cleared), annai writes the copy and offers a restart on a card.
- **A change restarts annai**, through the restart Settings → Updates uses, which waits for Shiori's turn to end. Every screen's words, and words made once at load, are then in the new language. A language not yet on the device is fetched first, while the picker says "Getting 日本語…"; with no connection it says annai needs one once.
- **Unfinished languages** (`experimental` in `languages.json`) are offered only while Settings → Experimental's "Unfinished translations" is on. zh-Hans and ja start there (decision 5).

### 3. Loading

#### The start

`index.html` loads `src/app/boot.js` instead of main.js. It is small (about 1 KiB):

1. Read `annai.ui` (or work it out from `navigator.languages`) and, in development, `?l10n=en-XA` or `?l10n=ar-XB` (the pseudo-locales).
2. Set `<html lang>` (the interface's tag, with the phone's region when the language is the phone's: `en-GB`) and `dir`.
3. For a language other than English, fetch `/l10n/<tag>.json` (from the service worker's cache), and `setWords(tag, words)`.
4. `await import('./main.js')`.

Because main.js and everything it imports are evaluated only after step 3, a message made at a module's top level (a table of words, `LANGUAGE_WORDS`) is in the right language, and nothing needs to be rewritten as a function to wait for the catalog. No top-level await is needed, and unit tests in Node import the modules directly and get English.

If the catalog can't be had (never fetched, no connection), annai starts in English and a card says why ("日本語 couldn't be loaded. annai shows English until it is online.").

`index.html`'s "Opening annai…" (index.html:20) becomes Shiori's mark with no words, its label set by boot.js; the `<noscript>` line stays English (nothing can choose without script). The web manifest's name is annai everywhere, and its description stays English: there is one manifest.

#### The service worker

- Catalogs are not in `SHELL`. sw.js gets a second list, `LANGS`, written by `strings.mjs` (`const LANGS = ['ja', 'zh-Hans'];`).
- On install, it caches the shell as now (sw.js:282) and the catalog of the interface language, into the same versioned cache: the choice from the app settings in IndexedDB (`sys:settings` `/app.json`, read the way it already reads `sys:device` `/push.json`, sw.js `handled()`), else the first of the worker's own `navigator.languages` in `LANGS`. A new version whose words can't be fetched doesn't install, and is tried again later, as a shell file that can't be fetched is today.
- Picking a language asks the worker to fetch that catalog into its cache (a message, answered when it is stored) before the restart.
- `scripts/stamp.mjs` hashes the files of `LANGS` with `SHELL`'s, so a translation fixed alone makes a new build.
- The push words: sw.js makes three strings of its own today (sw.js:465–469: the fallback body, and "In N min", "Now", "Started N min ago", which it finds with an English regular expression). The page writes the interface language's versions into `/push.json` (`words`), which the worker reads already; the mirror sends the item's start time and its words with a `{0}` for the minutes, never English to match against.

#### What it costs

| | English | Another language |
|---|---|---|
| Shell (counted by size.mjs) | the machinery, about 4 to 5 KiB, then about 1 byte a message | the same |
| Downloaded once per version | nothing more | its catalog: about 160 to 175 KiB of JSON for Chinese or Japanese (85 KiB of English is about 140 KiB of Japanese UTF-8, plus 13 bytes a key), about 50 KiB over the wire compressed |
| Offline | as today | as today, once chosen |

- `scripts/size.mjs` reports each catalog under its own budget, 200 KiB, so a catalog can't grow unseen; the shell budget stays as it is.
- Each new version of annai downloads its shell again in full (sw.js:282 fetches all 267 `SHELL` files with `cache: 'reload'`, 2.66 MiB before compression); a catalog adds about 6% to that. Copying unchanged files from the old cache would save far more, for everyone; it is another piece of work, noted here because the catalog is the first file that isn't needed by all.
- An official plugin's translations are in its package (section 8): installed with it, in IndexedDB, offline by nature.

### 4. Formatting

#### One place

The helpers in `src/ui/format.js` grow into the one place that formats for people, each formatter made once per language and kept:

| Helper | With | For |
|---|---|---|
| `num(n, opts)` | `Intl.NumberFormat` | counts, sizes typed in fields |
| `money(amount, currency)` | `NumberFormat` `style: 'currency'`, at most 2 significant digits below a cent | costs and prices ($0.0042 stays readable: Japanese's default rounds it to "$0.00") |
| `size(bytes)` | `NumberFormat` `style: 'unit'`, `kilobyte` … `gigabyte` | file and backup sizes |
| `distance(km)` | `NumberFormat` `unit: 'kilometer'` or `'mile'`, short | the plan's legs, "Near …" |
| `duration(ms)` | `Intl.DurationFormat` where there is one, else `NumberFormat` `unit: 'minute'`/`'second'` | "about 25 min", "1.4 s of speech" |
| `relTime(ts)` | `Intl.RelativeTimeFormat`, `numeric: 'auto'` | "2 hours ago", "yesterday", "now" |
| `day`, `dateRange`, `when(at, tz)` | `Intl.DateTimeFormat`, `formatRange` | dates, trip dates, booking times |
| `zone(at, tz)` | `DateTimeFormat` `timeZoneName: 'shortGeneric'` | "PT", "Japan Time": never "America/Los_Angeles" |
| `list(items, 'and' \| 'or')` | `Intl.ListFormat` | "English, Chinese, and Japanese", "英語、中国語、日本語" |
| `languageName(id)` | `Intl.DisplayNames` in the interface language | the Languages screen ("Japanese" / "日本語" / "日语"), falling back to `LANGUAGES`' English name when the browser has none |
| `sortWords(a, b)` | `Intl.Collator` | the plan's untimed rows by title (src/core/plan.js:101), plugin names |
| `parseNum(text)` | the language's decimal sign, from `formatToParts` | 16 number fields: "1,5" typed in German is 1.5, not refused |

#### The locale

Formats follow the interface language with the phone's region, `new Intl.Locale(ui, { region })`: English screens on a British phone format as `en-GB`, and on a German phone as `en-DE` ("1.234,5", "25 Nov 2026": the decimal comma a German user types, with English words); Japanese screens on an American phone ask for `ja-US`, which `Intl` resolves to `ja` (measured in Node's ICU: `en-DE`, `en-FR`, `en-GB` and `en-JP` resolve as asked; `ja-US`, `zh-Hans-US` and `en-CN` fall back to their language). Today they follow the phone alone (`navigator.language`, or `undefined`, which is the same), or are fixed to `en-US`.

**Distances** are miles when the region uses them (src/core/plan.js:128: US, GB, LR, MM), else kilometres, as now, unless the user chooses (decision 4). §14.3 says formats follow "the profile", a Markdown file Shiori and the user write freely (src/core/scopes.js:31: "- Units:"), which a screen can't read reliably; phase2-language already made the profile's "Language" line "hers to read, not the setting". The same is recommended for units: a **Distances** choice (Automatic, Kilometres, Miles) beside the interface language, Shiori told it in the languages section, and the profile's line hers. Because it changes a requirement's letter, it is the user's decision.

#### Every place that changes

| Where | Today | Becomes |
|---|---|---|
| src/ui/format.js:3, 8–12 | `RelativeTimeFormat(undefined)`; "just now" in English | `relTime` in the interface locale; `numeric: 'auto'` says "now" itself |
| format.js:15–25 | `bytes()`: "KB", "MB", `toFixed` | `size()` |
| format.js:27, 30–35 | `DateTimeFormat(undefined)`; a hand-made " – " when `formatRange` is missing | the interface locale; `formatRange` (Safari 14.1) always |
| format.js:41–46, 95–121 | `takenText`, `bookingLines` take a locale from their callers; a booking's zone shown as its id "(America/Los_Angeles)" (line 100) | the interface locale; `zone()` |
| format.js:52–55, 150–159, 165–172 | backup status sentences glued from parts; "1 of 3" unformatted | whole messages; `num()` |
| format.js:58–62 | `formatCost`: `$` + `toFixed`, "free", "cost unknown" | `money()`; the words as messages |
| format.js:65–72 | `OUTCOMES`: 30 lowercase phrases | messages (they are the error kinds' words, section 8) |
| format.js:75, 124–126 | `andList`, `withArticle` | `list()`; whole sentences |
| src/ui/screens/backups.js:194, src/ui/screens/trace.js:77 | `new Date(…).toLocaleString()` (the phone's locale) | `when()` |
| src/ui/offline-pack.js:15 | `toLocaleString('en-US')` and its own plural | `plural()` |
| src/ui/screens/replay.js:35, 41, 53; simulate.js:59; plan.js:30; drive.js:32; now.js:31; booking.js:49; src/ui/trip-rows.js:26 | `navigator.language \|\| 'en-US'` passed down | the interface locale, from one function |
| src/core/plan.js:75–78, 120–141 | `zoneName` 'short' ("EST", "GMT-5"); `distanceText` "≈ 26 mi" with its own unit words; `dayLabel` | `zone()`, `distance()`, `day` |
| src/ui/screens/drive.js:46, src/ui/search-panel.js:45 | "about ${s.minutes} min", "in ${…} min" | `duration()`, `relTime()` |
| src/ui/screens/provider.js:22–25, src/core/agent/budgets.js:101 | "$${prices.perMinute} a minute", "$${spent.toFixed(2)}" | `money()` |
| src/ui/screens/voice.js:105; trace.js:108, 146, 150 | seconds and milliseconds by `toFixed` | `duration()`, `num()` |
| src/core/llm/fallback.js:66–67 | `toLocaleTimeString([])`, `toLocaleDateString([])` inside an English sentence the user reads | `when()` in a message |
| src/core/live/plan-watches.js:87, 148 | a reminder's fallback, "In 15 min: …", "About N min by car" | made from data at display or when mirrored (section 1) |
| sw.js:466–469 | "In N min", "Now", "Started N min ago" by an English regular expression | the words from `/push.json` (section 3) |
| src/ui/cards.js:42 and the `'SHIORI'` labels (now.js:158, replay.js:98, talk.js) | `toUpperCase()` in code | the name as a message; capitals by CSS |

What stays as it is: the now block, the time and dates written for models, and the parsing of times (src/core/time.js:14, 32; src/core/agent/context.js:84; src/core/koe/context.js:10; budgets.js:13), which are `en-US` on purpose, for the model and for code; file names and ISO dates (format.js:129 `localDay`); coordinates (now.js:134), kept as maps apps take them; the voice's sentence splitting (src/core/voice/sentences.js:18), which follows the language spoken, not the screens.

#### On iOS 16.4

From MDN's compatibility data (mdn/browser-compat-data, read 2026-10-23; iOS Safari mirrors Safari) and WebKit's Safari 16.4 notes:

| API | Safari | Used for |
|---|---|---|
| `PluralRules` | 13 | `plural()` |
| `RelativeTimeFormat` | 14 | `relTime()` |
| `Locale`, `maximize()` | 14 | matching languages and regions |
| `ListFormat` | 14.1 (iOS 14.5) | `list()` |
| `DisplayNames` | 14.1 | language names |
| `NumberFormat` `style: 'unit'`, `unitDisplay`, `notation` | 14.1 | sizes, distances, durations |
| `DateTimeFormat` `dateStyle`, `timeStyle`, `formatRange` | 14.1 | dates and ranges |
| `DateTimeFormat` `timeZoneName: 'shortGeneric'` | 15.4 | zone names |
| `NumberFormat` `formatRange`, rounding options | 15.4 | (not needed) |
| `DurationFormat` | 16.4 (Chrome 129, Firefox 136) | `duration()`, with a fallback where it is missing |
| `Locale.getTextInfo()` | 17 (15.4 as a `textInfo` accessor) | **not used**: the direction comes from annai's own list (`ar`, `he`, `fa`, `ur`) |
| `Segmenter` | 14.1 | (the voice, already) |

Everything needed is there; `DurationFormat` is felt for and has a fallback.

### 5. Right-to-left

Arabic, Hebrew and Persian are in `LANGUAGES`. What a right-to-left interface takes:

- `dir="rtl"` on `<html>` from `dir()` (boot.js), and `dir="auto"` on every element that shows user content (trip names, file names, Shiori's lines), so a Hebrew trip name in an English interface reads right. That second part helps today.
- **CSS logical properties.** The three style sheets have about 37 physical declarations: `padding-left` 10, `left:` 7, `right:` 4, `margin-left` 3, `border-left` 3, `text-align: left` 3, `float` 3, `translateX` 2, `margin-right` 1, `padding-right` 1, and no four-value box shorthand. They become `padding-inline-start`, `inset-inline-start`, `text-align: start` and so on (Safari 14.1 and older; `float: inline-start` 15). In a left-to-right interface nothing changes, so the rule "new CSS is logical" can start now.
- **Directions in script.** Swiping between tabs (src/ui/shell.js) and the photo viewer's swipe and arrow keys (src/ui/photo-viewer.js) go the other way.
- **Arrows.** 33 back links carry "← Settings" in their text (voice.js:128, tools.js:59, plan.js:65…), and 78 literals name a path with "→" ("Settings → Tools"; 67 of them in annai itself, the rest in plugins). A back link becomes `crumb(href, label)`: its arrow is a span of its own, hidden from screen readers (VoiceOver reads "leftwards arrow" today), pointing the way the page reads, and the label is a message. A path's arrow is in the message, and a right-to-left translation writes "←".
- **What doesn't mirror**: Shiori herself, the route drawn in replay (a map), photos, clocks, media controls' play icon, numbers.
- **Bidi isolation** of parameters is in `t` already (section 1).

**Not in the first phases** (decision 9). No right-to-left language is planned with a reviewer; it touches the layout of every screen and wants a reader of the language to judge it. The parts that cost nothing in a left-to-right interface come earlier: logical properties in new CSS, `dir="auto"` on user content, isolation in `t`. The rest is the last step of the plan, done when a right-to-left language is wanted.

### 6. Fonts and CJK

- **Glyphs follow `lang`.** The same character is drawn differently in Japanese, Simplified and Traditional Chinese (Han unification: 直, 骨, 角). Browsers choose the CJK fallback font by the text's `lang`, but only when the stack doesn't name a CJK font first. So:
  - The base stacks lose their Japanese fonts: `--f-body: 'Zen Kaku Gothic New', system-ui, -apple-system, sans-serif`, `--f-display: 'Zen Maru Gothic', ui-rounded, system-ui, sans-serif`. On an iPhone, a run in `lang="ja"` should then fall back to Hiragino Sans, `zh-Hans` to PingFang SC, `zh-Hant` to PingFang TC, `ko` to Apple SD Gothic Neo; on Android, to the matching Noto CJK. The device check in L3 confirms it; if a system font doesn't follow `lang`, `:lang()` rules name the font for each language on the elements that carry one.
  - Under a Japanese interface, `:root:lang(ja)` puts Hiragino Maru Gothic ProN back into the display stack, the rounded look the design chose.
  - `<html lang>` is the interface language; every line of Shiori's and of the user's in the Conversation, the dock's bubble, cards and recaps gets `lang` from its text: phase2-language's `languageOf` and `listedFor` (kana is Japanese; Han alone is the listed Chinese, or Japanese when only Japanese is listed; Hangul is Korean), or the fixed answer language for Shiori's lines. When unsure, no `lang`, and the line inherits the interface's.
  - Language names in their own script (the Languages screen's "日本語") get their own `lang`, as phase2-screens' welcome does for 声 and 心.
- **No CJK web fonts.** A Japanese or Chinese font is megabytes; the system's are good. The Zen fonts stay Latin subsets.
- **Line breaking.** `overflow-wrap: anywhere` is used on long text already (base.css, shiori.css). Add `line-break: strict` under `:lang(ja)` (no line starting with ゃ or ー), `word-break: keep-all` under `:lang(ko)` (Korean breaks at spaces), and `word-break: auto-phrase` for Japanese headings where the browser has it (Chrome 119; Safari ignores it).
- **No synthetic italics on CJK.** The dock's caption is italic (shiori.css:138); CJK fonts have no italic and the browser slants them. `:lang(ja), :lang(zh), :lang(ko)` set `font-style: normal` there.
- **Small capitals and letter-spacing** (the "SHIORI" label) stay on Latin; CJK labels are not spaced out.

This part needs no catalog, fixes the user's Chinese conversations now, and is its own early step (L3).

### 7. What models see, and what the user sees

| What | Language | Why | Prompt cache | Model quality |
|---|---|---|---|---|
| Shiori's, Kokoro's and Koe's system text (src/core/agent/instructions.js, src/core/koe/instructions.js) | **English** | They are tuned and tested in English: unit tests and the realtime check (docs/testing/realtime-check.md) hold their words; 41 translations would be 41 prompts nobody has tested. The languages section (§10.9) already says which language to answer in. | Either way, a change of the interface language would cost one cold cache, as a change of the languages setting does; English costs none. | Small local models (llama.cpp, Ollama, LM Studio) follow English instructions best. CJK text takes more tokens for the same meaning in most tokenizers, and Gemini Live bills the whole context every turn (koe-kokoro plan, spike table: "2,105 prompt tokens after 8 turns"). |
| Tool names, descriptions and schemas | **English** | Part of the same cached prefix; tool choice is best in English; names are identifiers. | Same as above. | Same. |
| What tools return, `[annai]` lines, wake reasons, `[heard]` and the other labels, notes between the halves, the now block | **English** | The model reads them, and the instructions define them in English ("Lines starting with [annai] come from the app", instructions.js:11). They stay in the log: localized, a switch of language would leave the transcript in two. | Appended lines never break the prefix; English keeps every line the same whatever the screens. | One language for the protocol the instructions describe. |
| The interface's names for screens and buttons, when the screens aren't English | **The interface language**, one stable line in the languages section: "annai's screens are in Japanese. Name them as they show: Settings 設定, Models モデル, Trips 旅, …" from `l10n/glossary.tsv` | Shiori tells the user where things are ("Add one in Settings → Models", in her answers and in tool results); in English, on Japanese screens, that misleads. | Changes only with the interface language: one cold cache from the languages section on, as the languages setting itself (§6.3 item 2). About 100 to 300 tokens, cached. | Recommended (decision 7). The line names the screens only; the answer language is still the languages section's. |
| Words annai shows in the Conversation that annai makes ("Started fresh", "said aloud", "Shiori woke: …", a reminder's line, the error lines, the "Tidy up" menu) | **The interface language**, made at display | They are the screens' words, not Shiori's. | None: never sent to a model. | |
| Shiori's own words (speak, show, ask, cards, recaps, summaries) | **Her answer language** (§10.9) | They are hers. | | |
| System cards and toasts, notifications | **The interface language** | annai's voice, never Shiori's (§16.1). A push body is made in the interface language when it is mirrored to the relay. | | |
| Errors from providers | the error kind's words in the interface language; the provider's own message below it, as given, marked `lang="en"` where it is English | A provider's words can't be translated, its kind can. | | |
| Skills and personalities (skills/, assets/personalities/) | **English** text; the presets' names and one-line descriptions shown in Settings → Shiori are messages | The text is the model's; the listing is the screen's. | | |
| "Try this model" (src/ui/talk-panel.js:7) | **English** | A test prompt. | | |

### 8. Plugins

#### What a plugin ships

A manifest names the languages it has, and the language its own words are written in when it isn't English:

```json
{
  "id": "acme-tides",
  "language": "en",
  "l10n": ["ja", "zh-Hans"]
}
```

Each listed language is a file in the package, `l10n/<tag>.json`:

```json
{
  "manifest": {
    "description": "潮汐表を…",
    "settings.properties.station.title": "観測地点",
    "settings.properties.depth.oneOf.0.title": "基本"
  },
  "messages": {
    "yeiyfl": "…",
    "1e9ja08": { "other": "…" }
  }
}
```

- **The manifest's translatable fields:** `description`, `keywords` (added to, never replacing, the English ones: a search in Japanese finds it), a provider ability's `note`, `search.key.note`, a settings property's `title` and `description`, and the titles of its choices. `name` is not: the install screen names the plugin the user trusts the same way in every language. annai's own catalog translates its official plugins' descriptive names ("Custom provider", "Another address", "Remote trace"), because annai vouches for those (decision 10).
- **Choices with words.** A settings `enum` is shown raw today (src/ui/settings-form.js:25: `basic`, `advanced`). The form takes JSON Schema's own `oneOf: [{ "const": "basic", "title": "Basic" }, …]` and shows the titles; a plain `enum` still works.
- **Code's words.** `annai.l10n` gives a plugin `lang` (the interface tag), `dir`, `t`, `tc` and `plural` bound to its own `messages` (the same keys: a hash of its English), and the formatting helpers of section 4. A plugin with no translation for the interface language shows its own words, marked with its `language`, so a screen reader reads them right.
- **Where annai shows a plugin's words** (its description, notes, settings form, cards, toasts, screens, slots), the container carries the plugin's `lang` when its words are not in the interface language.

#### What annai checks

At install, as the rest of the manifest is checked (src/core/packages.js:35–41), and refused with the reason in plain words:

- `language` and each tag in `l10n` are well-formed and canonical (`Intl.getCanonicalLocales(x)[0] === x`); at most 50 languages;
- each listed file is there (and in `files` for an install from an address), is JSON, at most 256 KiB, an object with only `manifest` and `messages`;
- every `manifest` key names a translatable field that exists in this manifest, and its text is within that field's own limit (500 characters for a description);
- every message is a string, or an object of plural forms whose keys are among the language's categories, each at most 2,000 characters.

At use, a translation whose placeholders aren't its source's is skipped for the source, without a card. Nothing in a translation is ever HTML: it reaches the page as text, as everything else does. The install screen's warnings (full trust, whose keys it could read, where a search goes) are annai's own words, never the plugin's, in every language.

#### The catalog

- `scripts/catalog.mjs` writes, beside `catalog/plugins.json` (which stays English), one file per language, `catalog/l10n/<tag>.json`: each official plugin's translated `description`, `featured`, `note`s and name, from its `l10n` file.
- The Add screen fetches the interface language's file with `plugins.json` (src/core/llm/official.js:25), only when the screens aren't English: no download for English, a few KiB otherwise.
- Official plugins' translations are written in the same `l10n/<tag>.tsv` as annai's (their `where` names the plugin), so the user reviews one file per language; `strings.mjs` writes each plugin's `l10n/<tag>.json`, which the catalog then hashes like any file of the package. A plugin's translation changing is an update the user is offered, as any changed file is.
- `docs/plugins.md` gets a "Translations" section: the fields, the files, `annai.l10n`, the checks, and an example.

### 9. The translation workflow

- **Whoever changes English writes the drafts.** A commit that adds or changes a message runs `npm run strings`, which leaves `new` rows; it fills them with drafts for every language `languages.json` lists, in the same commit. The agents building annai write Chinese and Japanese drafts well; `npm run check` fails until there are none `new`.
- **The user reviews Chinese and Japanese**: `npm run strings -- --review ja` lists the drafts, or the TSV on GitHub; a row read and accepted is `ok`. A review can be any time after a merge; drafts ship (decision 5).
- **Changed English carries its translation as a draft.** When a message's English changes, its key changes. `strings.mjs` pairs an orphaned row with a new message in the same file whose English is close (a small edit distance, or the same words reordered), and carries the old translation as a `draft` with the note "English was: …", for the reviewer to confirm; otherwise the row goes, and the new one is `new`.
- **The glossary** (`l10n/glossary.tsv`) fixes the names of annai's screens and things per language (Trips, Plan, Now, Models, Koe · Realtime…), the names iPhone and Android use for their own settings ("ホーム画面に追加", "添加到主屏幕"), and what is never translated (annai; Shiori, Koe and Kokoro, decision 6; brand names). Drafts follow it, the check warns when a message that names a glossary term in English doesn't use the language's term, and Shiori's glossary line is made from it.
- **docs/translating.md**: for anyone translating: plain words, Shiori is "she", keep `{0}`, write "←" for back in a right-to-left language, the glossary, how to run the check.
- **Later languages** ship when a person who reads the language has reviewed them; machine drafts alone stay `experimental` (decision 8).

### 10. Tests

- **E2e selectors stay English.** `playwright.config.js` sets `locale: 'en-US'` for every project, so the interface is English whatever the machine's language, and the 2,575 locators by role, text and label (60 specs) keep working. Steps that change visible English (a crumb's arrow, a glued sentence made whole) change the few locators that name them, in the same commit; 84 lines in the e2e specs name an arrow ("← Back to trip").
- **One e2e per shipped language** (`test/e2e/l10n.spec.js`): chooses the language, restarts, and checks `<html lang>`, a few screens' words, a date, a plural, the language kept after a reload and offline, and the Add screen's plugin descriptions. Not the whole suite again.
- **Pseudo-locales**, made at load from the English by a module outside the shell (no shell cost), in development only:
  - `en-XA`: every message accented and 40% longer, in brackets ("⟦Ńó ţŕíṕś ýéţ… ·····⟧"). The phone-fit test (test/e2e/phone-fit.spec.js, every screen at 320 and 420 px) runs again under it, as German-length words would. A second check walks every screen's text nodes and lists any run of plain ASCII words outside brackets that isn't user content: a string that escaped `t`.
  - `ar-XB`: the English, mirrored, with `dir="rtl"` (for step L8).
  - A CJK run: the phone-fit test under Japanese, once zh-Hans and ja are drafted, for the opposite (short words, tall glyphs, no spaces to break at).
- **Unit tests** (`node:test`; Node has full ICU): the runtime (keys, placeholders in any order, a missing or mismatched translation, plural categories for ja, ru and ar, contexts, isolation in right-to-left); `strings.mjs` on fixtures (find, check's every failure, the carry-over); the formatting helpers in `en-US`, `en-GB`, `ja`, `zh-Hans`, `de` and `ar`; a plugin's `l10n` checks.
- **Size**: `size.mjs` checks the shell as now and each catalog under its own budget.
- **Device checks** (the user's iPhone): 直骨角 in a Chinese and a Japanese line of the same conversation, drawn differently; VoiceOver switching voices on a Chinese line under English screens; a reminder notification in Japanese with annai closed; the welcome on a phone set to Japanese.

### 11. Accessibility

- `<html lang>` and `dir` are the interface's (index.html:2 says `en` today, always).
- Every mixed-language span has its own `lang`: conversation lines, cards, recaps, language names, a plugin's words in its own language, old events' stored English. VoiceOver and TalkBack choose their voice by it.
- Screen-reader names are messages like any other: `aria-label`, the announcer's lines, `role="status"` text. The check's certain places include `aria-label`.
- Decorative arrows are hidden from screen readers (`crumb()`).
- Numbers, dates and durations read right because they are formatted for the language (a screen reader reads "1.234" in German as a thousand and more).
- §16.5 gains: "the page and every passage in another language say their language (`lang`), and the interface's direction (`dir`)".

### 12. The spec and the docs

**§14.3, proposed** (replacing it whole; decisions 1, 2, 4 and 5 shape it):

> ### 14.3 Language
>
> - **annai's screens** are in English, and in each language annai has once it is complete: Chinese (Simplified) and Japanese first. Settings → Shiori → Languages → **annai's screens in**: *As this phone is set* (the first of the phone's languages annai has, else English), or one of them by its own name. It is kept in the app settings, so a backup carries it, and on the device for the start; a change restarts annai. A language not yet complete is offered only under Settings → Experimental.
> - **Every word annai shows is written in English where it is used, marked** (`t`, `tc`, `plural`), and gathered by a script into one translator's file per language (`l10n/<tag>.tsv`), from which a small catalog is made (`l10n/<tag>.json`). Only the chosen language's catalog is downloaded, once a version, and kept for offline use. A missing word is shown in English, never as a key. `npm run check` fails on a message with no translation in a language annai lists, a translation whose English is gone, or a bare English word where the screen shows it.
> - **Shiori replies** in the language the user used among those they speak, or the one they fixed (§10.9); the screens' language doesn't change it. What models read (instructions, tool descriptions, annai's lines in the conversation) stays English; when the screens aren't English, Shiori is told their names for her answers.
> - **Formats**: dates, times, numbers, money, sizes, distances, durations, lists and relative times are formatted with `Intl`, in the screens' language with the phone's region; distances in [kilometres or miles by region, or the user's Distances choice]. Time zones are named ("Pacific Time"), never by their id.
> - **Text in another language** carries its `lang`, so Chinese and Japanese are drawn with their own glyphs and read with their own voice; no CJK font is downloaded.
> - **Plugins** carry their own translations (§5.2, `l10n`), and annai's catalog carries its official plugins'.
> - **Right-to-left** (Arabic, Hebrew, Persian) comes with the first such language: logical CSS, mirrored directions and arrows; parameters are isolated already.

Other changes: §5.2 gains `language` and `l10n`; §6.3 item 2's languages section gains the glossary line; §10.9's last bullet points here; §16.1 or §16.2's Settings → Shiori lists the new row; §16.5 as above; §18 gains the strings check, the pseudo-locales and the catalog budget; §19 says "zero runtime dependencies" still holds (Intl is the platform).

`docs/plugins.md` gets "Translations"; `docs/translating.md` is new; the README's "Languages" line, if any, says which.

## Decisions for the user

Answered 2026-10-23: each as recommended.

1. **English in the code, marked, instead of "all strings in one module".** §14.3's letter is one module; this design keeps each message in English where it is used (marked with the `t` tag) and gathers them into one translator's file per language. Keyed messages in a module would cost about 100 KiB of shell and move the words away from the code and the tests. *Recommended: marked English.*
2. **Is the interface language its own setting?** *Recommended: yes, "annai's screens in", defaulting to the phone's language; not tied to "Languages you speak", which drives dictation.*
3. **Carried by backups, or this device only?** *Recommended: in the app settings (backups carry it, as the languages you speak), with a copy on the device for the start.*
4. **Distances and formats: the profile, or a setting?** §14.3 says "according to the profile", a free-text file a screen can't read reliably. *Recommended: formats follow the screens' language and the phone's region; a Distances choice (Automatic, Kilometres, Miles) beside the language; Shiori told the same; the profile's Units line hers to read, as phase2-language did for its Language line. This changes the requirement's letter, so it is yours.*
5. **Do unreviewed drafts ship?** *Recommended: zh-Hans and ja start under Settings → Experimental until you have read them through once; after that, a new message's draft ships with its feature and you review drafts when convenient (the check counts them).*
6. **Shiori, Koe and Kokoro on Chinese and Japanese screens.** *Recommended: the Latin names everywhere (what you call her aloud is the same), with 声 and 心 explained in the welcome as now.* The alternative is しおり / 栞, 声 and 心 on Japanese screens.
7. **Is Shiori told the screens' names?** *Recommended: yes, one stable glossary line in the languages section when the screens aren't English; it costs one cold cache at a change of language.*
8. **Which languages next, and who reviews them?** *Recommended: Chinese (Simplified) and Japanese now; any other only with a person who reads it; Traditional Chinese next if you want it (it needs its own translation, not a conversion).* Is Simplified the Chinese you want first?
9. **Right-to-left: when?** *Recommended: last, when an Arabic, Hebrew or Persian reader is there to judge it; the parts that cost nothing in English (logical CSS in new code, `dir="auto"` on user content, isolation in `t`) earlier.*
10. **Plugin names.** *Recommended: a third party's name is shown as written in every language; annai translates only its official plugins' descriptive names.*
11. **Developer screens.** *Recommended: translate the Trace's, Experimental's and Simulate's own words; keep raw requests, responses and a manifest's detailed schema errors in English, marked.*

## Left to the builder

- The scanner's exact rules for `--find`, the carry-over's similarity threshold, and the pseudo-locale's characters.
- Which messages need a context (`tc`); the translators' reports decide.
- Whether `src/ui/format.js` splits into a core part (core makes some of these words: reminders, errors) and a UI part.
- How the welcome's "Change" link looks.
