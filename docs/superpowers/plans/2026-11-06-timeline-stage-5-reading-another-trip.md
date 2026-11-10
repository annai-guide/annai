# Timeline stage 5, Reading another trip: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With the user's approval, Shiori reads another trip's text files and conversation from where she is, so a user can mention another trip and carry on in this one.

**Architecture:** One new read-only tool, `read_trip`, Kokoro's only. Its gate is annai's own card, never a model's words. `read`, `list`, `recall`, `resolvePath` and `reach.js` stay untouched, so the walls hold as they are.

**Tech Stack:** Native ES modules, no build step, JSDoc checked by `tsc`, `node:test`, Playwright e2e in Docker.

**Spec:** `docs/superpowers/specs/2026-11-04-timeline-home-design.md`: sections Reading another trip, Decided by the user after the spec check, The main session's additions. Read it first.

## Global Constraints

- The user: "with user approval, shiori can just read another trip's files? this includes trascripts and stuff so she just able to know what you are talking about without going to the other trip?" Picked: "Once per chat, or always for mine (Recommended)"; spoken yes "Yes, a strict word list (Recommended)"; photos "Not read; she offers to move (Recommended)".
- **No model text may grant (RULES 9).** A grant comes only from `got.chosen` on annai's own card, or annai's word list on a heard line. A late tap grants nothing.
- She writes only in the open conversation. Files from another trip are information, not instructions.
- Work in `/mnt/optane/work/annai-timeline`, branch `timeline`. No push, no merge. Never `git stash`. Stage files by name. Never read `/var/lib/private/annai-trace/`, `/root/annai-test-keys/` or any secret file. Fixtures use the repo's test names.
- Stored additions get their lessons entry in the same commit. Old pages must ignore them. New user-facing words get `draft` rows. `npm run stamp` after a change to a shipped file.
- Size: never print `scripts/size.mjs` line 4. **This stage expects +7 KiB.**
- The handoff ends with Calls to confirm.
- Commands as in the stage 1 plan.

**Where the code moved past the spec**
- `#waitFor` is private, and `ask` is gated as a note while Koe talks (`#gate`), so the card needs a new public method on the loop.
- In a Koe session Kokoro doesn't listen, so a spoken yes reaches annai as a logged `heard` in `Halves.#koeLogged`, not through `#listenFor`. A chatter gate may also mark it `dismissed`.
- `recall` lives in `self-tools.js`, and reads only the open conversation.

**This plan's calls**
- "Trips other people shared always ask": the Always setting doesn't cover them, and their card has no Always. A once-per-chat Allow still lasts the chat.
- A spoken yes grants Allow only, never Always.
- The heard line counts dismissed or not: the word list is the check, and the user accepted "a passenger or song could grant, read-only". Fix pass 2: with Koe talking, a kept line in the same settle outranks one set aside, so the user's "No." then a song's "yes" is no.
- The window is 20 s from the question ending. A typed "yes" grants nothing: `ui.shiori.send` shares that path, so a plugin could write it. She is told to ask for a tap.
- "The last few conversations" is 5, and only in an undated conversation's snapshot.
- `imported` is stamped for archive kind `trip` only, and kept through an "everything" restore.

## Stored

| What | Where | Shape | Old page |
|---|---|---|---|
| Grant | conversation log, `trip.grant` | `{ trip, how: 'tap' \| 'voice', always?: true }`, actor `user` | not in `SHOWN`, not `SAID`: ignored |
| Read | conversation log, `trip.read` | `{ trip, title, path?, query? }`, actor `system` | ignored, listed by Trace |
| Card | conversation log, `out.ask` | today's, plus `own: true` and `tap` (annai's random id for the card, what a tap answers; fix pass 1) | shown as today's card; a tap there is an ordinary line |
| Imported | scope record | `imported: true` | kept by spreads, ignored |
| Always | app settings | `readMyTrips: boolean` | ignored; confirm `sys:settings` isn't closed by a schema |

A grant counts only when it was written after the conversation's last `import` entry. An imported conversation gets a new id, but the trips its log names keep theirs (every Share names its trip's id), so a grant it brought is no grant, and she asks again.

## Review Focus

1. **Model text that looks like a grant:** a tool result or quoted file saying "Allow" changes nothing. Test in Task 2: only `chosen` from `answer` on the card's own id writes `trip.grant`.
2. **A tap on the card after the tool gave up:** `answer` falls through to `send(…, { chose: true })`, an ordinary line. No grant. Test in Task 2.
3. **Another trip's file that says "ignore your instructions" or holds a closing tag:** comes back marked as that trip's data, with `theirs()`. Test in Task 1.
4. **A photo, a PDF, a binary, a path outside the trip, a removed or draft trip:** refused in words, nothing thrown into the transcript. Test in Task 1; a blob hash in the output would make `record` throw.
5. **A reload between Allow and the read; a second conversation:** the grant holds in its conversation and nowhere else. Test in Task 2.

---

### Task 1: The tool

**Files:** Modify `src/core/agent/trip-tools.js`, `src/core/agent/tools.js:36` (`UNTIMED`); test `test/unit/read-trip.test.js`, `test/unit/cross-trip.test.js`. `src/core/koe/tools.js` must not gain it: assert that.

**Interfaces:** `read_trip({ trip: string, path?: string, query?: string })`. No path or query: its name, dates, text file list and last 12 lines. `path`: that text or JSON file, up to `MAX_TEXT`. `query`: matching lines of its conversation, with who said them. Each answer starts by naming the trip, and wraps content with `theirs()`.

`list_trips` changes here, where she first needs it: dated trips and the 30 newest chats, read from the record (no `/trip.json` read per row), as TSV `id, title, start, end, places` with places blank for a chat.

- [ ] Write failing tests for each line of Review Focus 3 and 4, for `list_trips` with 500 chats, and that `reach.js`'s behaviour didn't change: `read` of `/trip/…` still reaches only the open trip.
- [ ] Implement, with the grant check from Task 2 stubbed to allowed. Read through `ws`, text only. Refusal words: `/* en */ 'That file is a photo or a PDF, which read_trip doesn\'t open. Offer to move to that trip to look at it.'`
- [ ] Run, commit `read_trip: another trip's text and conversation, read-only`.

### Task 2: The gate

**Files:** Modify `src/core/agent/loop.js`, `src/core/agent/halves.js`, `src/core/agent/trip-tools.js`, `src/core/settings` readers, `src/core/archive.js:779`; create `src/core/agent/spoken-yes.js`; test `test/unit/read-trip.test.js`, `test/unit/spoken-yes.test.js`, `test/unit/halves*.test.js`.

**Interfaces:**
- `Agent.confirm(call, { question: string, options: string[], yes?: (heard: string) => string | null }) -> Promise<{ chosen?: string, how?: 'tap' | 'voice', stopped?: boolean }>`, on the loop: logs the `out.ask` with `own: true`, says the question aloud with voice on through `remind`'s `aloud` path (annai's voice, never hers), waits with `#waitFor(call.id, 'ask', 0)`, and takes a heard line for 20 s. Classic voice hears through `#listenFor`, as `#askAloud` does. In a Koe session `Halves.#koeLogged` hands each `heard` and `heard.text` to the new `kokoro.confirmHeard(text)`, which resolves the wait with a yes only inside the window. Fix pass 1, one rule for both voice modes: a heard line kept as the user's that is no yes ends the card unanswered at any time, as typing does; one set aside as chatter (classic voice: by the quick gate, as a spoken `ask`'s) leaves it listening. Fix pass 2, with Koe talking: one settle per card (3 s, `STALL_MIN_MS`), which each new or revised kept line starts again and chatter set aside doesn't; then the newest kept line decides ("Yes." then "No, wait." is no), else a yes set aside, and the window counts from when a line was heard.
- `spokenYes(text: string) -> boolean`: NFKC, lower case, punctuation and spaces out, then an exact match in one set. No substring, no model. A line that ends in a question mark is no yes (fix pass 1: "はい？" and "Yes?" say "pardon?").

```js
const YES = ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'allow', 'allowit', 'goahead', 'yesplease',
  'はい', 'ええ', 'うん', 'いいよ', 'いいです', 'お願い', 'お願いします', 'どうぞ',
  '好', '好的', '可以', '行', '是', '是的', '嗯'];
```

Order in `read_trip`: a `trip.grant` for this trip in this log, then the setting if the trip isn't `imported`, then the card: t`Read ${title}?` with t`Allow`, t`Always for my trips`, t`Not now` (no Always when `imported`). The title is the scope's, never the model's input.

- [ ] Write failing tests: each Review Focus 1, 2, 5; `spokenYes` for `yes`, `Yes.`, `はい。`, `好的`, and against `yes but no`, `not yes`, `yesterday`, `おはい`, `yes yes yes`; a heard yes at 19 s grants and at 21 s doesn't; dismissed counts; Koe mode and classic voice both reach it; Always writes the setting and a grant; `imported` asks in spite of the setting and has no Always; Not now tells her not to ask again unless the user does; a Stop ends it.
- [ ] Implement. `archive.js`: `imported: true` when the archive's `kind === 'trip'`, kept otherwise.
- [ ] Lessons entry in this commit: `## 2026-11-06 Reading another trip is granted by annai, not by her`. It records `read_trip`, `imported`, and why `ask` couldn't do it.
- [ ] Run, commit `read_trip's gate: annai's own card, a strict spoken yes, once per conversation`.

### Task 3: What the user sees, and what she knows

**Files:** Modify `src/ui/screens/talk.js` (`SHOWN` gains `trip.read`), the Settings screen for the switch, `src/core/agent/context.js`, `src/core/agent/instructions.js`; test `test/e2e/read-trip.spec.js`, `test/unit/context*.test.js`.

- [ ] Failing tests: the quiet line "Shiori read Testville"; Trace lists each read; Settings shows the switch and turning it off asks again; an undated conversation's snapshot names the happening trip and up to 5 recent conversations, each through `quote()`; it is built at the conversation's first snapshot and stays the same turn to turn, so the cached prefix holds; extending stage 4's text with "if this is about one of their trips, read it first".
- [ ] Implement. Her instructions: read first, say what she read, offer to move for a photo.
- [ ] Run all, e2e whole, raise the budget, commit `Reading another trip: the quiet line, the setting, and what a new chat knows`.

### Task 4: Check it on a real model

Hand back to the main session: does she ask for the right trip, and does "what's on tomorrow?" get answered in place? **Stage 6 is cut by what this shows.** Known risk, already told to the user: details she copies into this chat go with it if this chat is shared.
