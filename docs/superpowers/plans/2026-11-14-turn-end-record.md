# Plan: the loop records when a turn of Shiori's ends (route A, second step)

2026-11-14. Revised the same day after its spec check, the user's two answers to it, the merge of ask-owed (d84b9e39) and
the docs round (0d6ed7a5). No real model was called. Copied into the repo by the build; where the build differs, its report
says so.

## The goal, in the user's words

A traveller who answers Shiori's question card (typed, tapped or spoken) always gets a reply they can see; a turn cut by a
reload, a crash or another conversation is taken up when it should be and not when it shouldn't; and Undo of a hand-over
takes back exactly what she did under it. The user: "what I prefer is simple and robust solutions. Again that is #1 in our
agent rules. DO NOT miss that. Clever design sometimes also means accept known limitations early in design phase to avoid
scope creeps and bring in more vectors".

The user's picks (2026-11-14):
- On the design check: **"A: remove 2 parts, then record (Recommended)"**, the record "so the reader stops guessing
  from her words"; old logs: **"Treat as finished (Recommended)"**: "Once per update, a turn the old version left paused ('She
  picks it up when you come back') and not yet reopened is not picked up; you ask again."
- On the spec check: Q1 **"Approve the wider entry (Recommended)"**: the old-log entry names all five effects (a)-(e) of §5.
  Q2 **"Accept, widen the entry (Recommended)"**: the approved "An answer Shiori already gave can be said once more" gains one
  clause for the later open after a declined restart (§7).

## Base, and what this plan was checked against

- **Build on main d84b9e39** (ask-owed merged). Its src is cd354d02's, so the line numbers below hold; check them first.
- I tried this plan in a scratch `git archive` of d84b9e39 (one sitting, not reviewed). Its src change, kept as a trial
  diff with the plan's notes, applies cleanly to d84b9e39 and has the names this revision uses.
  - **Unit suite, no test changed:** 5111 pass, 8 fail, 0 cancelled. The 8 are exactly the hand-built logs of §6.1. With
    the rewrites of §6.1 that I tried (agent-loop ×3, agent-owed ×1, agent-transcript ×3, the owed table and the one-Shiori
    asserts after it), those files pass.
  - **Shapes the build must bring back, run on the trial:**
    - F2's 8 shapes and N1's 4 (the 5e7bca68 test, its loop widened to "a wait, then a sleep"): pass.
    - L1, open and Stop (the docs round's probe): taken up with h-1; the next file is h-1's, and Undo takes it.
    - L1w and L1n: taken up.
    - L2's four variants: the file is h-1's, and Undo takes it.
    - The silent-twice shape: the write carries h-1.
    - The move case: e17900f5's tests pass.
  - **Typecheck:** `tsc -p tsconfig.json` clean.
  - **Shipped size:** 3268.9 KiB, against 3269.6 on d84b9e39 and a 3270 budget.
  - **Not run:** tsconfig.test.json, e2e, a device.

## 1. The record

- **Event** `turn.end`, `actor: 'system'`, `data: { wake: <the turn's wakeId>, handover: <this.#handover, string or null> }`,
  plus the half's mark (`#log` → `#marked`). `#steps` writes it once a turn, through `#log`; nothing else writes one.
- **Key** `endLogged: true` on every reply's `model.turn` record (loop.js:2418 `record: {...}`): "the loop logs this turn's
  end". The trial's `ends` read as "this reply ended the turn" on replies that end nothing, so it goes (LESSONS: one field,
  one meaning; write the field on every new record and test for the key).
- **Lists:**
  - `'turn.end'` joins `SAID` (transcript.js:46) and Halves' `MARKED` (halves.js:34; without it, Koe's record has no `half`
    and Koe's reader never sees it).
  - `endLogged?: boolean` joins the `record` typedef (llm/fallback.js:455).
  - Not in talk.js `SHOWN` (no line in the Conversation). The Trace lists it under Everything with an empty summary, as
    other entries without a line of their own.
  - In `SAID` it is harmless where `compact()` sizes the cut (about 15 tokens a turn) and in Start fresh's "already fresh"
    check (loop.js:1733, 1866), as the `error` records already in `SAID` are. Start fresh's held turn writes its records
    before the compaction.
- **Nothing of it reaches the model:** the reader returns before `#line`/`#add`. §8 check 6 proves it.

### Where `#steps` writes it: one row per way a turn ends

`let ended = false;` sits next to `let notes = [];` (2249), **before** `this.#owing = ...` (2250). `takeOwed()` can call
`#owing` during the turn's first await (`spentToday`, 2314), and a `let` declared later would throw there. The record is
written after the unsaid notes are shown, just before `if (silent && unanswered())` (2585):
`if (ended && !(silent && unanswered())) await this.#log({ type: 'turn.end', actor: 'system', data: { wake: wakeId, handover: this.#handover } });`

| # | How the turn ends (d84b9e39 line) | Written | Read after a reload | Hand-over (h-1) |
|---|---|---|---|---|
| 1 | A reply with no calls, the nudge declines (2501-2502) | `turn.end` (`ended = true` before `break`) | ended | answered |
| 2 | `asleep` or `endTurn`, the nudge declines (2563) | `turn.end` | ended | answered |
| 3 | The same after the cue (silent once, then speaks and sleeps) | `turn.end` | ended | answered |
| 4 | Silent twice: "Shiori didn't answer" (2304, 2585) | `error` `silent` | ended | **owed**: Try again carries it |
| 5 | Koe after its cue and two more steps, only Kokoro's notes owed (2558-2561) | `turn.end` (`silent = ended = true`; annai's backstop shows the notes). If the user's own words are owed too: the silent card instead | ended | answered |
| 6 | annai takes Koe's owed notes to show them (`#owing`: Halves.open, Start fresh) | `turn.end` when nothing else is owed: in `#owing`, `if (taken.length && !unanswered()) ended = true;` | ended | answered |
| 7 | A paused reply (`stop: 'pause'`, 2499); a plain-text reply before the nudge decides | nothing yet: the turn goes on | under way (a kill here is taken up: §8's list) | owed until the end |
| 8 | A sleep that gave way (a failed call, or her question came back) | nothing yet | under way | owed |
| 9 | Budget (2338), stuck (2550), compaction failed (`#tidyUp`, 2386/2464), every model failed (`#failed`, 2473) | their `error`, unchanged | ended | owed, as now |
| 10 | The user's Stop (2601) | `error` `stopped`; plus `turn.end` when it lands after every call but the reply's `sleep` had come back (run), and at Start fresh (row 6) | ended | owed; answered in those two cases, as main reads them |
| 11 | An open, let go (`#lettingGo`, 2603-2607) | `error` `left` | ended | owed, as now |
| 12 | An open cut at work: a non-sleep call of the last reply came back cut or never ran; or between steps; or in the model call (2332, 2563, the `cancelled` catch) | nothing | **under way**: "She picks it up" line, taken up on return | owed: the restart carries it |
| 13 | An open that lands on the reply's `sleep`, every other call done | `turn.end` (`cutCall` skips the sleep; the aborted nudge declines) | ended, not paused | answered |
| 14 | A reload, a kill, or the page leaving (`#leaving`) mid-turn | nothing | under way: `repair()` answers open calls; taken up | owed |
| 15 | A note cuts in on her model call (2441) | not an end: the turn goes on | | |

A turn can get both `turn.end` and an error record (row 10). The reader ends the turn at whichever comes first, and only
`turn.end` answers the hand-over. No rule is needed to keep one of the two.

The step's end (2563) becomes as follows. Before the call loop (2513) add `let cutCall = false;`. After `#runCall` (2524)
add `if (abort.signal.aborted && output.isError && c.name !== 'sleep') cutCall = true;`. Then:

```js
      if (abort.signal.aborted && (cutCall || !(asleep || endTurn))) break; // cut at its work: no end, so it is taken up
      if ((asleep || endTurn) && !(await nudge())) {
        ended = true;
        break;
      }
```

It is `cutCall`, not the trial's `cutIn`: `Agent` has a public `cutIn()` (loop.js:1332). `broke` can't stand in for it,
because `breaks()` leaves out `tell_koe` and `tell_kokoro`, and a cut hand-off must be taken up.

The stand-in reply that `#applyTurn` applies when the trace's write failed (2819) carries the same keys:
`data: { tag: this.#half.tag, wake: wakeId, handover: this.#handover, endLogged: true }`.

`#runCall` (2937) still writes `end: true` and `awake: true`, and `repair()` (transcript.js:593) still stamps `awake` on a
sleep it answers. An older page reads them (§5), and their removal is Deferred (§7). Only their comments change.

## 2. The reader (transcript.js)

- **A new field `#underway`:** "a reply of hers whose turn's end the loop has not logged". It is not the trial's
  `#turning`, which is the Agent's own field in loop.js:479. `get unanswered()` returns
  `this.#owes || this.#underway || this.#heardOwed > 0`; the setter never clears it.
- **At her reply** (after `this.unanswered = false;`, ≈236), replacing the settle at :224-233:
  ```js
      // Her turn is under way until the loop logs its end. A reply from before the loop logged one (no `endLogged` key) is read as its turn's end.
      this.#underway = 'endLogged' in d;
      if (this.#underway) this.waiting = this.#last.length ? 'turn' : '';
      else if (this.#mine(d) && (!('handover' in d) || d.handover === this.#handover)) this.#handover = null;
  ```
  `waiting` is '' after a reply with no calls, so a turn killed there gets the restart words annai already has, "annai
  restarted before you answered" (or "Another conversation was opened before you answered"). It does not get "your tool
  calls had come back", which wouldn't be true (run). No new string.
- **A new branch before `note`:**
  ```js
    } else if (e.type === 'turn.end') {
      // The loop's record that her turn ended by its own rule: the hand-over it carried is answered.
      if (!this.#mine(d)) return;
      this.#underway = false;
      if (d.handover === this.#handover) this.#handover = null;
      return;
  ```
- **`error` with a wake** (:304): first `if (this.#mine(d)) this.#underway = false;`. Any such error ends the turn, as now;
  it leaves `#handover` owed for Try again or the user's next line, as now.
- **`conversation.moved`** (:298): add `this.#underway = false;` after `this.unanswered = false;`.
- **What it now reads:** a reply means her turn is under way. A `turn.end` of hers, or an error of hers with a wake, ends
  it. A turn still under way with nothing after it was cut, so it is owed. The hand-over is answered by a `turn.end` that
  names it, by an Undo, or by an old reply (§5), at no other time.
- **One rule of the same kind stays:** one Shiori's `#koeCalls` settles a heard line once Koe's reply's calls are done
  (:189-199). Route A doesn't need it changed. With Koe's `turn.end` it could become fewer parts later; that is not this
  change, and nothing the user sees is wrong.

## 3. What goes, what stays

| Part | Fate |
|---|---|
| `#ends`, `#reached`, `#settled` and their docs (transcript.js:105-106, 117-120) | **go now** |
| The settle at a reply (:224-233, the sleep-in-the-reply rule: "it sleeps, or calls no tool") | **goes now**; only an old reply is read as an end, every one of them (§5) |
| The `#reached = true` lines at `note` (:244) and `out.*` (:256); the Undo's clear of `#settled` (:279) | **go now** (the Undo's own `#handover` clear stays) |
| The result rules (:374-389: `end`, the Stop's words without `cut`, `awake`, `cut` with its name table, the give-back, the "results in, no end → owed 'turn'" block) | **go now** |
| The wake give-back and the `ask` exemption | gone already (e17900f5) |
| `end: true` (`#runCall`), `awake: true` (`#runCall`, and `repair()`'s stamp, which the design check's trial took out) | **written one more version**, unread here; Deferred (§7) |
| `cut` on results | **stays** (halves.js:1289 reads it) |
| `#asked`, the "Not asleep" results, the nudge and `answeredAt`, `repair()` answering open calls, `#open` taking up a turn it repaired (loop.js:763), the error records, `#heardOwed`/`#koeCalls` | **stay**, untouched |

## 4. Builder's questions, from the code

From the design check (§2, "What the record does not decide by itself"):
1. **Koe's exit after its cue with only notes owed (2558-2561): it ends** (row 5). After the `break`, `unsaid = notes` goes
   to `#half.unsaid` (Halves `#backstop`), which shows them, as at the nudge's second silent end. Run (koe-relay's P5b
   shape): on main, Koe reads as owed after it (`waiting: 'turn'`), so reopening has Koe say the note again. With the line,
   Koe's `turn.end` is logged and nothing is owed.
2. **annai showing Kokoro's note itself at a cut: Koe's turn ends where annai takes the notes** (row 6), not in
   `#leftUnsaid`. Halves.open calls `koe.takeOwed()` (halves.js:782) before `koe.open` halts Koe (:803); Start fresh calls
   it before `holdStill` (:1004-1007). The loop then logs its own end, with its wake and hand-over.
   - Run: without the line, the card row of halves.test.js's switch test fails (`out.show:Fuel` twice on coming back). With
     it, the card shows once, as today.
   - **The words' double stays, as approved** ("Kokoro's words owed at a switch may be shown, then said again on coming
     back"). It comes from Koe's reader owing Kokoro's note (`#owes`), which annai's `reminder` doesn't settle (an `out.show`
     does), not from the turn's end. The design check's "which ends both doubles" is not so. A `turn.end` that cleared
     `#owes` would also drop a line logged after her last reply.
3. **The moment between her last result and the record: accepted.** In between are `settle()` and, for Koe, the backstop's
   writes (`remind` doesn't await `voice.say`). A kill there reads as cut and is taken up: a double, not a loss, as today
   between a speak's result and its sleep's. I read it as covered by the approved "An answer Shiori already gave can be
   said once more" (a kill while she speaks is taken up and may repeat); Calls 3.
4. **A cut that lands on the reply's `sleep`, every other call done: ended, as today** (row 13; run).
5. **Koe said its answer and a restart answered its open calls, with no Koe turn since: owed for Koe until its next turn;
   no record at the restart.** The user accepted this and widened the approved entry (Q2, §7). At the open that repairs,
   Koe takes it up unless its `restart` hook declines (halves.js:319-322: Kokoro takes it up, or Koe is live). A record at
   the decline would end the turn but not what Koe owes (`#owes`).

From the spec check's §3:
1. **Base:** d84b9e39 (above).
2. **`turn.end` and an error both:** they can come together and that's fine (row 10). Run: a Stop landing on the reply's
   `sleep` logs both, and the hand-over is answered, as main reads it. Start fresh logs both for Koe (read).
3. **The restart words after a reply with no calls:** `waiting` '' (§2), which gives words annai already has.
4. **`#turning`** is renamed `#underway`. 5. **`ends`** is renamed `endLogged`.
6. **`turn.end` in `SAID`:** harmless (§1).
7. **N1:** in F2's test (§6.2).
8. **§8:** the specs are named, check 2 no longer waits on a timer, and the old-log check (a repeat of unit test (a)) is gone.
9. **Row 9's compaction case** goes in agent-turn-end.test.js, with agent-loop.test.js:1499's setup (a forced tidy-up,
   `k.llm.call` stood in for `record.tag === 'compaction'`), throwing `new ProviderError('server', …)` instead of the
   cancel.
10. **No date in spec §6.7:** it says "a reply without the key (written before this change)".
11. **The "Opening another conversation…" entry's Revisit-when is reworded with its Why** (§7).
12. Not needed: Q2 was answered "accept".

## 5. Old logs (the user's picks); an older page reading a newer log

- **The rule:** a reply with no `endLogged` key is read as its turn's end (§2's `else if`). `#underway` is false, and its
  hand-over is answered (no `handover` key, or the one it carried). A user's line she never replied to is still owed (a
  fact, `#owes`). A turn killed with calls open is still taken up (`repair()`), without its hand-over. This happens once
  per conversation: the first reply this version writes carries the key.
- **What it does, all approved (Q1):**
  - (a) A turn the previous version left paused by an open, not yet returned to, is not picked up; they ask again.
  - (b) The same for a turn annai closed after her calls had come back, or during her next model call (no "picks it up"
    line there).
  - (c) A hand-over in such a turn reads as answered, so what she files when they ask again is outside its Undo.
  - (d) A turn killed while her calls were running is picked up, but what she files in it is outside the hand-over's Undo.
  - (e) Try again on a "Shiori didn't answer" or model-failure card from before the update carries no hand-over.
  - The F2, L1 and L2 shapes left in such a log fall under (a)-(e). Undo errs only by leaving a file.
- **An older page** (a rollback, an old tab) reads a newer log as its own. `turn.end` is not in its `SAID`, so
  `Transcript.load` never lists it, and it ignores `endLogged`. It reads `end`, `awake`, `cut` and her words, which this
  version keeps writing (§3). What it misreads is exactly what this change fixes.
- **Probe, not committed:** load logs this build's loop wrote (dumped from agentKit stores for rows 1-14) with d84b9e39's
  `Transcript.load`. Pass: each reads as d84b9e39 reads its own log for the same turn.

## 6. Tests

### 6.1 Rewritten to logs as the loop now writes them (every rewrite here was run on the trial)

| Test (d84b9e39) | Change |
|---|---|
| agent-loop: "a typed message wakes Shiori…" (:20) | `types` ends with `'turn.end'` |
| agent-loop: "killed after her tool calls came back…" (≈:836) | `endLogged: true` in the hand-built turn record |
| agent-loop: the restart-note table, "a restart, her calls back" (≈:1780) | `endLogged: true`; add a row: a reply with no calls, killed: "annai restarted before you answered." |
| agent-owed: "a hand-over, annai restarted while her card waited…" | `endLogged: true` in its `info` |
| agent-transcript: "a msg.user with handed…" (:101) | Replies with `endLogged: true`, plus the sleep's result. The hand-over stays owed after the `sleep` reply; a `turn.end` with `handover: null` leaves it owed, and one with `'h-1'` answers it. Rename: "…until her turn's end record answers it" |
| agent-transcript: `askAndSleep` and its two tests (:121-152) | The reply gets `endLogged: true`; `gaveWay: false` adds `turn.end` with `'h-1'`. Rename the first: "the hand-over is answered by her turn's end record, not by a sleep among her calls" |
| agent-transcript: "annai restarted while her question waited…" (:154) | `killed(old)` adds `endLogged: true` unless `old`. Before the repair the result is now `['h-1', 'h-1', true]` ("under way: no end was logged"). The stored-`awake` assertion stays (one version). The R2 half uses `killed(true)` and is otherwise as e17900f5 wrote it |
| halves-transcript: the owed table (:413) and the one-Shiori asserts after it | See below |

The owed table follows the design check's trial of it:
- **Replies:** `endLogged: true` on every turn except the Kokoro replies of the two "an old log" rows.
- **Ends:** `fin(w, half)` after each turn that ended.
- **Four wants change** (run):
  - "Koe answered, a close while it listened": `[false, true, false]`.
  - "Koe answered, then annai restarted": `[false, true, false]`.
  - "Koe asked, Kokoro answered": `[true, false, true]`.
  - "Koe's reply under way, Kokoro's turn ends in an error": `[false, true, true]`.
  - Each is a reply with no end yet, so it is owed by its half; the open after a kill already takes it up (`repair()`).
- **The one-Shiori asserts:**
  - The first two get `endLogged: true`.
  - The second ("whose sleep alone was cut, after she spoke") adds the `turn.end` the loop logs there (row 13).
  - The old-log ones stay without the key.

### 6.2 New (all in the build; the first four close the Deferred entries, §7)

- **F2:** bring back 5e7bca68's agent-owed test (:191-228). Its silent replies widen to three (`[{ text }]`,
  `[{ toolCalls: [sleep] }]`, and N1's `[{ toolCalls: [{ name: 'wait', input: { seconds: 1 } }] }, { toolCalls: [sleep] }]`,
  as agent-owed's `silent` table), so `...reply` and the request indexes `1 + reply.length` / `2 + reply.length`. That is 12
  shapes: `[ask]` and `[ask, sleep]` × the three replies × the request failing (Try again) or cut (an open and back). Pass
  (run): each write carries h-1, and Undo takes it back.
- **L2:** the docs round's L2 probe as tests: a typed line with a hand-over, plain text or a bare `sleep`, the
  one more request failing or cut. Pass (run): after the failure `owedHandover` is h-1, the write carries h-1, and Undo takes
  it back.
- **L1:** the docs round's L1 probe as tests, cap spent and the control × open and Stop, plus its L1w probe (open, Stop) and
  its L1n probe's three shapes. Pass (run):
  - Open: a paused line, then one request on return, carrying h-1.
  - Stop: the next line's write carries h-1, and Undo takes it back.
- **Silent twice:** the design check's silent-again probe as a test, plain text and a bare sleep: the
  write after Try again carries h-1, and `undoHandover(..., 'h-1')` takes it back.
- **The move case:** keep e17900f5's three (agent-owed's Kyoto move ×2, agent-transcript's R1 at the reader, the R2 half),
  and add R1 at the reader with the record (`endLogged: true`, a `turn.end` with `'h-0'`, then the move's `meanwhile` wake:
  null).
- **agent-turn-end.test.js, one row per way `#steps` ends** (§1's rows 1-14, with a hand-over h-1):
  - **Setup:** one Shiori, except row 5 (Koe, koe-relay's P5b shape) and row 6 (halves.test, below).
  - **Each row asserts:** what the log holds for the wake (`turn.end:<handover>`, `error:<kind>`, `paused`), what
    `Transcript.load(...)` gives for `unanswered`, `waiting` and `owedHandover`, and for rows 12 and 14 that the open takes
    it up once with h-1.
  - **Row 13:** `k.agent.on('event', …)` opens another conversation when the sleep's `tool.call` is logged. A tool that
    opens it from its own `run` won't do: `runTool` stops waiting at the abort, so that call comes back cut, which is row 12.
  - **Row 10's two variants:** the Stop landing on the sleep the same way (both records), and a Stop during a tool
    (`stopped` only).
  - **Row 7:** two hand-built kills, a plain-text reply and a paused one, both with `endLogged`: owed, `waiting` '', and on
    open one restart with "annai restarted before you answered" carrying h-1.
  - **Row 9:** budget, stuck, model failure, and the compaction case (§4, spec check 9).
  - Scratch probes drove rows 1-5, 7, 9 (model), 10, 12 and 13 and got the table's values.
- **The old-log reading:**
  - (a) A paused log (msg.user with h-1, a reply without the key `[read]`, its cut result, `paused`): not owed,
    `owedHandover` null, and opening runs nothing.
  - (b) A reply without the key, its results in: not owed.
  - (d) Killed with calls open, a reply without the key: taken up once, and its writes carry `null`.
  - (e) An old silent reply, then the `silent` card, then Try again: the write carries `null`.
  - A user's line after her last old reply: owed.
  - An old reply, then a turn of this version: read by the record.
  - Each test is named for the approved entry.
- **Koe's card:** halves.test.js's switch test (≈:1048) keeps its four rows (`again` 1 for words, 0 for the card), and
  asserts a `turn.end` with `half: 'koe'` in the conversation left for the two "in its call" rows.
- **The writes kept one version:** keep the tests that pin a stored `awake` (agent-owed "a sleep that gave way is stored as
  such…", agent-transcript :154).

## 7. Docs

- **Spec §6.2,** the paragraph after the steps:
  - Keep the loop's rule.
  - Take out the docs round's "but only while that twice is not spent: past it … a known gap in docs/limitations.md".
  - Replace "and the stored result says so too (`awake: true`) whatever else became of the sleep …, so the log's reader
    decides as the loop did" with this: the loop logs the turn's end (`turn.end`, with its wake and the hand-over it
    carried) where it ends by its own rule (in words, asleep, Koe after its cue with only Kokoro's notes left for annai to
    show, or once annai has taken Koe's owed notes to show them). A turn that ends in an error has that record, and may have
    both. One cut at its work has neither and is taken up, however often it went on. Each reply's record carries
    `endLogged: true`, and the log's reader takes her turn's end from these records, never from her reply's words.
- **Spec §6.7,** "Crash or reload mid-turn": "So does a turn the log holds no end for (§6.2), whatever her reply held: the
  hand-over it carried is still owed, so what she does when it is taken up is the hand-over's and its Undo takes it back. A
  reply without `endLogged` (written before this change) is read as its turn's end (docs/limitations.md). `awake` and `end`
  on results are still written for a page one version older (deferred)."
- **Spec §7.1:**
  - After "a card says 'Shiori didn't answer', with Try again" add: "Try again carries the hand-over that turn carried."
  - In the switch clause add: "a card of Kokoro's is shown once: the switch ends that turn of Koe's". The words' "said once
    more" stays.
- **docs/limitations.md:**
  - **Remove** the two Deferred entries this change fixes: "What she files after a hand-over's silent reply, when the one
    more request annai then makes fails or is cut…" (F2 with N1 and L2) and "A turn cut after two failed calls beside
    sleeps, in a reply that had spoken, is not taken up" (L1).
  - **Correct the approved "Opening another conversation can take up a turn she has already answered".** What the user
    sees is unchanged. In the parenthetical, the docs round's "until the turn has had two of those (past that … the
    deferred entry below…)" goes. The **Why** becomes: whether a cut turn still owes the user is decided where the loop
    ends it. A turn cut at its work has no end record and is taken up, whatever reached the user before; one whose last
    step talked to them or waited on them is let go. Telling a later step's notes from the work after the user's answer
    needs the loop to know whether the user's words came after her last line to them, and a repeat loses nothing, where
    the dropped rest did. The **Revisit-when** becomes: "…the fix then: the loop's let-go decision (`#lettingGo`,
    `#cutWaiting`) knows whether the user's words came after her last line to them".
  - **Widen the approved "An answer Shiori already gave can be said once more" (Q2).**
    - Add to What the user sees: "With her two halves, when Kokoro took that restart up (or Koe was live then), Koe's own
      turn stays unfinished until Koe next has a turn: a later open, with Kokoro owing nothing and Koe on a chat model, can
      have Koe take it up and say its answer once more, possibly much later."
    - Add to Why: "Koe's log has no end for a turn cut in its reply, and writing one where the restart is declined would
      settle the turn but not what Koe still owes."
    - Add to Approved: "The later open after a restart Kokoro or live Koe took: 2026-11-14, the user picked 'Accept, widen
      the entry (Recommended)'."
  - **Add (Q1):**

    > ### Turns the version before this update left unfinished are read as finished
    > - **Kind:** known limitation.
    > - **What the user sees:** once per update, and only in a conversation where it happened, in a turn of hers the
    >   previous version left unfinished when the update installed: (a) a turn left paused by opening another conversation
    >   ("She picks it up when you come back") and not yet returned to is not picked up, and they ask again; (b) the same for
    >   a turn annai closed after her calls had come back or during her next model call (no "picks it up" line there);
    >   (c) a hand-over in such a turn reads as answered, so what she files when they ask again is outside its Undo; (d) a
    >   turn killed while her calls were still running is picked up, but what she files in it is outside the hand-over's
    >   Undo; (e) Try again on a "Shiori didn't answer" card, or a model-failure card, left from before the update carries
    >   no hand-over, so what she files is outside its Undo. Undo never takes back too much here: it leaves a file, which can
    >   be deleted by hand. A line of theirs she never replied to is still answered.
    > - **Why:** this version logs a record where her turn ends and reads her turn's end only from it. A log the previous
    >   version wrote has none, so each of its replies is read as the end of its turn. Reading those replies by the old rules
    >   too would keep the word-reading this change removes, in the same function.
    > - **Revisit when:** a user reports a "She picks it up when you come back" line that was never picked up after an
    >   update, or an Undo after the update that left a file.
    > - **Approved:** 2026-11-14, the user picked "Treat as finished (Recommended)" for old logs, and "Approve the wider entry
    >   (Recommended)" for this entry with all five effects.
  - **Add (Deferred, by RULES: planned for the next version):**

    > ### Tool results still carry `end` and `awake`, which this version doesn't read
    > - **Kind:** deferred.
    > - **What the user sees:** nothing. Each tool result still stores `end: true` (her line's listening heard chatter) and,
    >   for a sleep that gave way, `awake: true` (also stamped by a restart's repair), as the version before this one reads
    >   them; this version reads her turn's end from its `turn.end` record.
    > - **Why:** a page one version older (a rollback, a tab not yet updated) reads her turn's end from them, and would
    >   misread a newer log without them.
    > - **Revisit when:** the next version, as its own change: drop `end` and `awake` from `#runCall`'s and `repair()`'s
    >   writes, and from the tests that pin them.
- **docs/lessons-full.md,** a new entry `## 2026-11-14 The loop logs when her turn ends`:
  - **Changed:** the event, the key and its name, where the event is written, what the reader dropped, and what is kept one
    version.
  - **Why we had to change:** nine findings in one night (R1, R2, F2, N1, L1, L2, the silent-card shape), each the reader
    re-learning a loop behaviour.
  - **Original design was wrong because:** the end of a turn was the one fact the loop knew and didn't write, so the reader
    guessed it from her words.
  - **Lesson:** the code that ends a step writes the end as a record; each record of the step carries a key named for "its
    end is logged", never for "it ended"; readers read the record, never the actor's words; older records are read by one
    stated rule.
- **docs/lessons.md:** no new line.
  - Add the short name to line 60's heading list.
  - Replace both of its clauses that this change overtakes ("in a field of the stored result too, so the log a reload reads
    decides the same" and "a reader that settles what a reply owed from its words … settles it only once the results say it
    ended her turn") with the lesson above in one sentence.
  - The file is already over the 20 KB RULES sets (Calls 6).
- **LESSONS.md:** no line. "When fixes keep finding new disagreements between two code paths…, remove a path" and "One
  field, one meaning … test for the key" already cover it.

## 8. The real-browser check: a reload and an open in the middle of a turn (in the build, before release)

`test/e2e/turn-end.spec.js`, on the config's `chromium` (Pixel 7) and `webkit` (iPhone 15) projects, with the model
stand-in (`startModelServer`, `sse`, `anthropicToolReply`, `modelSetUp`; the hand-over through "Give Shiori photos or files"
as hand-over.spec.js does it).

**Running it:** in Docker, with a memory cap:

```
docker run --rm --memory=16g --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/turn-end.spec.js test/e2e/hand-over.spec.js test/e2e/shiori.spec.js test/e2e/read-trip.spec.js test/e2e/conversation-lines.spec.js test/e2e/conversation-menu.spec.js test/e2e/moving.spec.js test/e2e/voice-talk.spec.js test/e2e/koe.spec.js --workers=16 --retries=2
```

The spec list is the re-review's, plus koe. Afterwards delete test-results/, playwright-report/ and core.*.

**Pass, on both projects:**
1. **Reload mid-turn at work:**
   - Hand over a PDF. Reply 1 is `[write /trip/notes/a.md]`. The stand-in holds request 2 (`delayMs`); reload once it has it.
   - After the reload: exactly one more request, its last user line the restart's ("in the middle of your turn").
   - Reply `[write b.md, speak, sleep]` shows once.
   - "Undo what Shiori did with these files" takes back a.md and b.md.
   - On chromium also as a kill (CDP `Page.crash`, then a new page), with the same pass. I haven't run `Page.crash` in
     that image; if it doesn't work there, say so and keep the reload.
2. **Reload after the turn ended:**
   - After `[speak, sleep]` shows, reload, then send "Thanks" and wait for her reply.
   - The stand-in gets exactly one more request, and its last user message is "Thanks" with no restart reason.
   - A restart would be queued at the open, ahead of the line, so no timer is needed.
3. **Open mid-turn at work:**
   - As 1, but open another trip while request 2 is held.
   - The conversation left shows "Shiori was in the middle of something. She picks it up when you come back."
   - On coming back, one restart request; Undo takes back both files.
4. **Open while her card waits:**
   - `[ask, sleep]`, the card up; open another trip and come back: no line, no request.
   - Typing "Yes" starts a turn whose write carries the hand-over, and Undo takes it back.
5. **Silent twice:** two bare `sleep` replies, then "Shiori didn't answer", then Try again, and she files: Undo takes it
   back.
6. **What she is sent:** in 1 and 3, the restart request's messages before its own new line equal request 2's, and no
   request body holds `turn.end` or `endLogged`.

**What she is sent, exactly.** Requests change in one way only: a restart wake is sent where none was before, with words
annai already sends (`#open`, loop.js:785-790; their wording comes from the real-model run's C1):
- a turn cut at its work after two failed calls beside sleeps (L1);
- a turn killed during a provider's pause continuation, or after a plain-text reply before the nudge decided (row 7);
- Koe's later open after a declined restart (Q2);
- a Koe or Kokoro reply with no end yet (the owed table's four rows), where an open after a kill already restarted it.

Koe sends one wake fewer after its cue exit (row 5). No request carries the record (check 6). So no real-model run is
needed.

## 9. Size

- **Src:** +34 −43 in the trial (transcript.js +16 −37, loop.js +16 −4, halves.js and fallback.js one line each). The
  design check's trial was +31 −46 against 5e7bca68.
- **Shipped size:** 3268.9 KiB against the 3270 budget (d84b9e39: 3269.6). Reword comments in place; don't add any. If the
  build goes over, cut comments; don't raise the budget for comments.
- **Tests:** about +350 −40 (§6.2 about 300 new, with the probes it carries over).
- **E2e:** about +150.
- **Docs:** about +40 −35.
- No new strings.

## 10. Build order and verify

1. The record and the reader (§1, §2) with §6.1's rewrites, in one commit with the spec, lessons and limitations (§7).
2. §6.2's tests, then §8's spec.
3. Run `node scripts/strings.mjs`, `npm run -s catalog`, then `npm run stamp` (after any src change). Then
   `systemd-run --scope --collect -q -p MemoryMax=16G -p MemorySwapMax=16G -- npm run check`. Then §8 in Docker, then §5's
   probe in scratch.
4. Fail first: run on d84b9e39 the new tests that assert the record or a fix, and say which fail there. They are the table's
   `turn.end` and hand-over columns, F2 with N1, L1, L2, the silent-card shape, and Koe's `turn.end` at the switch. The
   old-log, R1 and R2 tests pass on both.
5. Review and a Haiku second opinion after the build. No real-model run (§8).

## Calls to confirm

1. **The phone check is the user's, after release:** in a trip, ask something she looks up, lock the phone or switch away
   until iOS drops the page, and come back. She should pick it up once, and reopening after a turn she finished should do
   nothing. This is less than option A's "a real check on a phone … before release": before release the build runs real
   WebKit and Chromium with the model stand-in (§8). Tell the user.
2. **Behaviour that changes beyond the fixes:**
   - A paused reply no longer settles a hand-over (read).
   - Koe's turn after its cue with only notes owed ends, so reopening no longer has Koe say the note again (run).
   - Turns now taken up that weren't (§8's list), each with existing words. The kills after a plain-text reply or in a
     pause continuation were run at the reader and the open.
   - A Stop or a let-go leaves the turn's hand-over owed to the user's next line, as on main (run). A Stop landing after
     every call but the sleep answers it, as on main (run).
3. **A reading of an approved entry:** a kill in the few awaits between her last result and the record is taken up and may
   repeat. I read that as "An answer Shiori already gave can be said once more" ("killed while she is speaking"); the Q2
   widening doesn't name it. Tell the user, or add it to that entry's clause.
4. **The design check said Koe's end at the switch "ends both doubles": it ends only the card's** (run). The words' double
   stays as approved.
5. **Stored format:**
   - New: the `turn.end` event and `endLogged: true` on every reply. The name was chosen so that it doesn't read as "this
     reply ended the turn".
   - Kept one version: `end` and `awake`, with a Deferred entry for their removal.
   - Names: `#underway` (transcript.js) and `cutCall` (loop.js) avoid two names already taken.
6. **Approved entries reworded:**
   - "Opening another conversation can take up a turn she has already answered": its Why, Revisit-when and parenthetical;
     what the user sees is unchanged.
   - "An answer Shiori already gave can be said once more": the Q2 clause.
   - Tell the user both, with the design check's Call 7 (an earlier narrowing they haven't been told of).
   - docs/lessons.md is 22,439 bytes, over the 20 KB RULES sets. This change only merges into line 60; bringing the file
     under is its own change.
7. **Plan additions to the design check's trial:**
   - Koe's exit after its cue ends the turn; so does `#owing`, with `ended` declared before it.
   - The stand-in reply gets the new keys.
   - The reader tests for the key (`'endLogged' in d`).
   - `waiting` is '' after a reply with no calls.
   - `repair()` keeps its `awake` stamp, per the design check's §3 over its §2.
8. **The trial was one sitting in scratch, not reviewed:** its numbers are evidence of what the plan does, not a build.
