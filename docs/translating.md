# Translating annai

annai's screens are in English, Japanese (`ja`) and Chinese, Simplified (`zh-Hans`). This page is for anyone who
translates them, a person or an agent. The design is
[the localization design](superpowers/specs/2026-10-23-localization-design.md); the spec's rule is §14.3.

## Where the words are

- **The English is in the code,** marked where it is used: `` t`Last backup ${when}.` ``, `` tc('screen')`Voice` ``
  (a context, for English that means two things) and `plural(n, '# stamp', '# stamps')`.
- **One translator's file per language:** `l10n/<tag>.tsv`, with the columns `key`, `state`, `en`, `text`, `where`
  and `note`. Edit `text`, `state` and your own `Note:`; the script writes the rest.
- **What ships** is `l10n/<tag>.json`, made from the TSV. Never edit it by hand.
- **The glossary,** `l10n/glossary.tsv` (and `glossary.md` to read it), fixes the names of annai's screens and things
  in each language, the names iPhone and Android use for their own settings, and what is never translated.

## The commands

```bash
npm run strings                    # after changing English: new rows, rows carried over, the JSON files
npm run strings -- --review ja     # a language's drafts as a Markdown table
npm run strings -- --check         # what npm run check runs: fails on anything missing or wrong
```

## A row's state

- `new`: no text yet. The check fails until it has one.
- `draft`: a translation nobody has read and accepted yet. When English changes a little, the old translation is
  carried over as a draft, with "English was: …" in its note.
- `ok`: read against its English and its place on the screen, and accepted. The check doesn't warn about the
  glossary on an `ok` row: its `Note:` says why it reads as it does.

Whoever changes English writes the drafts for every language in the same commit. A row is marked `ok` only by
someone who has read it in place: the `where` column says where it is used.

## How to write

- **Plain words,** as annai's English is. What a button does, said the way a phone says it; the glossary has the
  phones' own words ("ホーム画面に追加", "添加到主屏幕").
- **Meaning first.** Anything about losing data (erase, remove, restore, replace, backups), money (costs, spend
  limits, "free"), trust (plugin installs, "full access", keys, passphrases) or what leaves the phone must say
  exactly what the English says.
- **Shiori is "she".** Shiori, Koe and Kokoro keep their Latin names everywhere; the welcome explains 声 and 心.
  annai, brand names and protocol names (MCP, GPS) stay as written.
- **Placeholders:** keep every `{0}`, `{1}` …, in whatever order the sentence needs. A plural's `#` is the number,
  already formatted. Each language gives only its own plural forms (Japanese and Chinese have one, `other`).
- **A button quoted in a sentence** is written as the button says it.
- **Whole sentences only.** If a message can't be translated whole (it is glued from parts, or capitalised in
  code), say so in a `Note:` and ask for the code to change, rather than working around it.
- **A back link's arrow** is drawn by the code (`crumb()`), apart from its label: don't write "←" in a message.
- Keep a `Note:` for any choice that isn't obvious. The user may change wording later, and the note says why.

## What is not translated

- **What models read** stays English: instructions, tool descriptions and results, `[annai]` lines, the now block.
  The code marks these `/* en */`.
- **Raw requests, responses and schema errors** on the developer screens stay English, marked `lang="en"`.
- **What Shiori is told** when the screens aren't English is one line made from the glossary: the 31 names a traveller
  is likeliest to be pointed to (`TOLD` in `scripts/strings.mjs`: "Settings (設定), Models (モデル), …"), so she names a
  screen as the user sees it. A change to those rows changes that line, and so every user's cached prompt once; keep
  the line under 300 tokens.

## A new language

A language is added to `l10n/languages.json` as `experimental`: it is offered only under Settings → Experimental →
Unfinished translations. It becomes `shipped` once someone who reads the language has reviewed every row. Japanese
and Chinese were reviewed by Opus, at the user's word (2026-10-26).

Look at the screens in the language before marking rows `ok`: choose it under Settings → Shiori → Languages, or
set `localStorage['annai.ui']` to its tag. The phone-fit test (`test/e2e/phone-fit.spec.js`) runs every screen at
320 and 420 px in each shipped language.
