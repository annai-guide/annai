# Timeline stage 6, Moving into a trip: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user wants to carry on in another trip, Shiori moves them there: the trip gets her recap and their last line, and the chat stays.

**Architecture:** `open_trip` opens from an undated conversation. `openWhenDone` already opens once both halves are done. The moved line ends unanswered, so `#open` owes a turn and she answers in the trip.

**Tech Stack:** Native ES modules, no build step, JSDoc checked by `tsc`, `node:test`, Playwright e2e in Docker.

**Spec:** `docs/superpowers/specs/2026-11-04-timeline-home-design.md`: section Moving into a trip, and "After moving, the chat".

**Gate:** the spec says "Moving, cut by what stage 5 shows". Before building, the main session says what stage 5 showed. Anything it cuts comes out of this plan; the decisions below stay.

## Global Constraints

- Picked: "Move you into that trip (Recommended)"; after moving "It stays (Recommended)": the trip gets her recap and the user's last line only. So tiny, `removeTripNow`'s move and line carrying go from the design.
- Moving is for when the user wants to carry on there. Reading covers the rest.
- Work in `/mnt/optane/work/annai-timeline`, branch `timeline`. No push, no merge. Never `git stash`. Stage files by name. Never read `/var/lib/private/annai-trace/`, `/root/annai-test-keys/` or any secret file.
- Lessons entry in the same commit as the API change. `draft` rows for new words. `npm run stamp`.
- Size: never print `scripts/size.mjs` line 4. **This stage expects +3 KiB.**
- The handoff ends with Calls to confirm.
- Commands as in the stage 1 plan.

**Where the code moved past the spec**
- `writeInto` already takes a `recap`, and writes it into a `file` wake. Only the user's last line is new, not all of step 3.
- Stage 3's move rule already replaces the address when you're on that chat. Only home is left for step 6.
- `filesOf` returns `[]` whenever `call.trip` is set (line 97), which is what step 2 changes.

**This plan's calls**
- The chat's last line is a new entry, `conversation.moved` `{ to, title }`, not `handover.moved`: an old page would show that as "took 0 files". Old pages ignore the new one.
- A move with a live session running goes ahead: `open` closes it, as the spec's risk says, and voice comes back in the trip by the usual route. The test says whether it does.

## Review Focus

1. **The user taps another conversation while she finishes:** `openWhenDone` does nothing, and the moved line waits in the trip. Test in Task 2.
2. **The trip removed or archived between her call and the opening:** nothing is lost from the chat, and no address points at a gone trip. Test in Task 2.
3. **A live voice session mid-move:** on the fake realtime server, the session closes once, the trip opens, she answers there, and nothing is said twice. Test in Task 2.
4. **The move from a dated trip:** refused as today. Test in Task 1.
5. **Home showing when she moves:** the address follows; a Details or Settings screen stays where it is. Test in Task 3.

---

### Task 1: open_trip from a chat

**Files:** Modify `src/core/agent/trip-tools.js` (`OPEN`, `open_trip`, `filesOf`); test `test/unit/trip-tools.test.js`.

- [ ] Failing tests: `open_trip` works in an undated conversation and is refused in a dated one; with no files named it moves the hand-over's fresh `/trip/files/…`; with files named, those; an undated conversation with no hand-over moves nothing and still opens.
- [ ] Implement. The guard reads the conversation's `start`. `filesOf`: `const root = call.trip ? '/trip/files/' : '/waiting/files/'`, the same filter, reading the file from `call.trip ?? SYS_WAITING`. Change the tool's description.
- [ ] Lessons entry: `## 2026-11-06 open_trip works from an undated conversation`. Commit.

### Task 2: What goes across

**Files:** Modify `src/core/agent/trip-tools.js` (`writeInto`, `moved`), `src/core/agent/transcript.js` if the wake needs a label, `src/ui/screens/talk.js`, `src/core/agent/loop.js` only if `#open`'s owing needs it; test `test/unit/trip-tools.test.js`, `test/unit/halves*.test.js`, `test/unit/realtime-*.test.js`.

**Decided:** with no hand-over in this turn, `writeInto` finds the user's last line (`msg.user`, or `heard` not dismissed) in `call.scope` and writes it with `app.wake({ kind: 'user', text, handed: [], fromScope: call.scope, scope: to })`, then the existing `file` wake with the recap. The log there ends unanswered, so `#open` owes the turn. The chat ends with `conversation.moved`, shown with `movedWords`' new sibling: t`Shiori moved this to ${title}.`, with a link, or the "since removed" wording when the trip is gone.

- [ ] Failing tests: Review Focus 1, 2, 3; `talked` on the trip moves with the line; the trip gets exactly recap and last line, no other chat lines; the recap reaches her as what it is, never as the user's words.
- [ ] Implement. Run. Commit.

### Task 3: went, on home

**Files:** Modify `src/ui/shell.js`; test `test/e2e/moving.spec.js`.

- [ ] Failing test: Review Focus 5. In the `went` listener: `if (parseHash(location.hash).name === 'trips') location.replace(talkHref(trip)); else redraw();`.
- [ ] Extend stage 5's snapshot text: "move only if they want to carry on there".
- [ ] Run all, e2e whole, raise the budget, commit.

### Task 4: Check it on a real model

Hand back: does she move too soon, or when only asked a question? This is the spec's Judgement risk.
