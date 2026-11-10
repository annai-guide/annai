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
- The heard line counts dismissed or not: the word list is the check, and the user accepted "a passenger or song could grant, read-only". (Fix pass 2 had a kept line outrank one set aside; the voice-yes change, 2026-11-10, took the verdict out of the choice: the newest listed word decides, so "No." then a song's "yes" grants, and a set-aside line after a yes drops it.)
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
- [ ] Implement, with the grant check from Task 2 stubbed to allowed. Read through `ws`, text only. Refusal words, one sentence for every file it doesn't open (fix pass 1): `/* en */ "read_trip opens only text and JSON files, not photos, PDFs or other kinds. Offer to move to that trip to look at it."`
- [ ] Run, commit `read_trip: another trip's text and conversation, read-only`.

### Task 2: The gate

**Files:** Modify `src/core/agent/loop.js`, `src/core/agent/halves.js`, `src/core/agent/trip-tools.js`, `src/core/settings` readers, `src/core/archive.js:779`; create `src/core/agent/spoken-yes.js`; test `test/unit/read-trip.test.js`, `test/unit/spoken-yes.test.js`, `test/unit/halves*.test.js`.

**Interfaces:**
- **As built since the voice-yes change (2026-11-10, from the real-voice check):** `Agent.confirm(call, { question, options, yes?, no? })`: a heard line's words are judged when they are written down (a live session's transcript as it reaches the socket, handed on by `LiveHost.heard` through Halves; classic voice's `writeDown`; a text Koe's entry), by annai's lists alone, never by Koe's or the quick gate's kept/chatter verdict. A yes begun inside the 20 s window (live: by when the session began sending it; classic: by `p.hold`), or a no at any time, arms its option, unless the line began over her voice (`LiveInput.overHer`, half-duplex's own rule on every route; classic's microphone is closed while she speaks, now while the question is said too). Each listed word starts `SETTLE_S` (3 s, its own number) from its words' arrival; the newest decides: a yes grants Allow, a no declines as Not now (`how: 'voice'`, "The user said no"). Any other line drops an armed yes at once, never a no; the card listens on. A kept line that arms nothing ends the card unanswered SETTLE_S after its verdict, unless a listed word is armed; one set aside leaves it. A tap wins at any time. A live line whose words came before the card isn't the card's (its late entry is ignored). The text below is the stage as first built.
- **As built since the final review (2026-11-10, the same day):** a line's begin time comes from where it is first heard on every path: a live session's turn, classic voice's segment (its own detector start, not when it is routed behind another line's gate call), and a chat Koe's microphone (`Half.speech` with the segment's id and start; `#koeLogged` invents no time, so an entry alone is "heard before the card" on every path). Such a segment is written down for the card as it is heard (`voice.writeDown`, as classic voice's own): with a Koe model that takes the sound (Gemini), Koe's turn writes nothing down until it ends, and the real-speech check saw it never end while the card waited. `Agent.confirmSpeech(on)`, fed by both microphones and a live session's turn edges (`LiveHost.speech`): an armed yes doesn't settle while someone speaks, and has `SETTLE_S` again once they stop; a no doesn't wait. When the card ends, the listed words said to it are written first, in order, with `answer: <call id>`, and are not queued to her. Where annai hears while she speaks, a run begun while her voice plays or within 360 ms after (half-duplex's gate) is hers, quiet or not, tap or no tap (the fix round's exception for a tap, narrowed by the re-review, was taken out by the last review: see below); a line marked hers doesn't end the card.
- **As built since the re-review of the final fix (2026-11-10, the same day):** the newest line by when it was heard decides: in `#askWords`, once a line heard after this one has words, this one's words (written down late, or again by the other half in other words: "Yes!" for "Yes.") arm and drop nothing, and only count for the unanswered end. `confirmSpeech(on, said)`: when a line was just said (a segment, or a live turn's end; not a click), a kept line's unanswered end has `SETTLE_S` again, without a hold while someone speaks. A chat Koe's segment begun while annai's voice plays (`voice.speaker.speaking`) comes marked `her`. `#askWriteDown` stays as the final fix built it: a chat Koe's segment is written down once, through the speech-in list for this half's own model (`#hearer(this.#half.role)`). The re-review's diff 5 (Koe · Chat's first model that takes audio writes it down) was taken back out after real speech: with a transcription model listed, a turn of Koe's chat model wrote the line down slower (the grant 9.5 s after "Sure." instead of 4.1 s), wrote it twice (Koe's turn found no transcript kept), and its timeout rested Koe's only model, so nothing was granted; the setup it served (no transcription model, Kokoro on a model that takes no audio, a typed question) gets the yes's words when Koe's turn ends, and is deferred. The re-review's tap exception (`LiveInput.tapped()` ending her tail once her sound had played 690 ms) was taken out after the last review: her last word before a tap, coming back as a run of its own, was taken for the user's. `tapped()` sets only `#theirs`, and on a duplex route a run begun while she plays or within the 360 ms after is hers, tap or no tap.
- **As built since the last review (2026-11-10, the same day):** `#settleAsk` doesn't settle an armed yes while a line after it in `ask.heard` has no words, as it doesn't while someone speaks: those words drop it or arm their own, however long they take, and a line whose words never come leaves the card for a tap or another spoken answer. `LiveHost.speech(on, line)` hands the card a turn's line as it begins (its id, begin time and `her`), and Halves passes it on as `confirmHeard({ …line, live: true })`, which starts no write-down for it. The cost: a sound within a yes's 3 s that a live session takes for a turn and writes no words for keeps the yes from being granted; the card waits for a second "Yes." or a tap.
- `Agent.confirm(call, { question: string, options: string[], yes?: (heard: string) => string | null }) -> Promise<{ chosen?: string, how?: 'tap' | 'voice', stopped?: boolean }>`, on the loop: logs the `out.ask` with `own: true`, says the question aloud with voice on through `remind`'s `aloud` path (annai's voice, never hers), waits with `#waitFor(call.id, 'ask', 0)`, and takes a heard line for 20 s. Classic voice hears through `#listenFor`, as `#askAloud` does. In a Koe session `Halves.#koeLogged` hands each `heard` and `heard.text` to the new `kokoro.confirmHeard(text)`, which resolves the wait with a yes only inside the window. Fix pass 1, one rule for both voice modes: a heard line kept as the user's that is no yes ends the card unanswered at any time (classic voice hears only in the card's 20 s), as typing does, and fix pass 2 adds one heard in classic voice while she thought, before the card went up, as a queued typed line; one set aside as chatter (classic voice: by the quick gate, as a spoken `ask`'s) leaves it listening. Fix pass 2, with Koe talking, and fix pass 3, in classic voice too (`#settleAsk`, one judge): one settle per card (3 s, `STALL_MIN_MS`), which each new or revised kept line (classic voice: each kept segment, once written down and past the gate) starts again and chatter set aside doesn't, while a line not judged yet and, in classic voice, speech going on hold it; then the newest kept line decides ("Yes." then "No, wait." is no), else a yes set aside, and the window counts from when a line was heard.
- `spokenYes(text: string) -> boolean`: NFKC, lower case, punctuation and spaces out, then an exact match in one set. No substring, no model. A line that ends in a question mark is no yes (fix pass 1: "はい？" and "Yes?" say "pardon?"). Each word has one meaning: いいです ("no thanks" too), 嗯 (the filled pause too) and ええ (surprise, and ええと) came off the list after the final review (2026-11-10), and are on neither list. `spokenNo(text)` (voice-yes, 2026-11-10): the same match on a set of plain refusals and take-backs in the same languages, no filler and nothing on the yes list; a question mark doesn't stop it, as declining is always safe.

```js
const YES = ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'allow', 'allowit', 'goahead', 'yesplease',
  'はい', 'うん', 'いいよ', 'お願い', 'お願いします', 'どうぞ',
  '好', '好的', '可以', '行', '是', '是的'];
// The final review (2026-11-10): いいです, ええ and 嗯 are off, since each has another meaning as often ("no thanks"; surprise and ええと; the filled pause).
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
