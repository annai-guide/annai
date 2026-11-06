# Timeline stage 7, Opening, `me` and the no-trip paths: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** annai opens by the new rule, every conversation belongs to a trip, `me`'s old lines are a read-only row, and the files waiting with Shiori move into one chat.

**Architecture:** `agent.open(null)` stays as "nothing open". `send` and `tap` then make a chat first, in `Halves`. One guard in the loop stops `me` taking turns. Then the no-trip paths have nothing left to do and go.

**Tech Stack:** Native ES modules, no build step, JSDoc checked by `tsc`, `node:test`, Playwright e2e in Docker.

**Spec:** `docs/superpowers/specs/2026-11-04-timeline-home-design.md`: sections The model (Existing data), Opening, What goes, Decided by the user.

## Global Constraints

- Picked: "Last chat if recent, else timeline (Recommended)"; "Read-only row (Recommended)". You can read it; talking starts a new chat.
- **Nothing stored is lost.** `me` keeps profile, memory, personalities and instructions. Its old lines stay readable. Waiting files survive a cut-off run.
- `moveFile` writes before it drops. A cut-off run resumes.
- Plain start only: a link, a share or a notification is never redirected.
- `main.js` still opens `activeTrip` whichever screen shows.
- Work in `/mnt/optane/work/annai-timeline`, branch `timeline`. No push, no merge. Never `git stash`. Stage files by name. Never read `/var/lib/private/annai-trace/`, `/root/annai-test-keys/` or any secret file.
- Each stored or API change gets its lessons entry in the same commit. `draft` rows for new words. `npm run stamp`.
- If the guard touches `live.js`, the routes in stage 2's Review Focus stay green with no edited assertion.
- Size: never print `scripts/size.mjs` line 4. **This stage expects about +1 KiB** net; lower `BUDGET` if it comes out less.
- The handoff ends with Calls to confirm. Commands as in the stage 1 plan.

**Where the code moved past the spec**
- `me`'s log is also written by `setLive`'s `state`, catch-ups, `remind`, `/me/` file writes and `composer`, as the spec says. Add `personalities.js:127`'s tuning wake, which must wait for the next conversation rather than be lost.
- `#/talk` and `#/plan` with nothing open still show their empty states: stage 3 kept them. Both now go home.
- Counted now: 5 e2e files and 19 unit files name no-trip paths (the spec says 6 and 30).

**This plan's calls**
- "Used" is `talked` on the record, under 12 hours, or `phaseOf` happening.
- The Start a trip form stays until stage 8, whose helper rewrite removes it.
- The waiting chat's id is kept in app settings, `waitingChat`, so a restored backup's files join the same chat while it exists.
- The old `annai.resume` key is removed once at start.
- A link in `me`'s old lines to `/waiting/…` shows as words if the file is gone.

## Stored

| What | Change | Old data |
|---|---|---|
| `me`'s log | no new turns; `remind`, `state` and wakes still log | reads as it is |
| `sys:waiting` | the scope stays, emptied at each start; an old archive may refill it | moved at the next start |
| `waitingChat` | new app setting | absent: made when first needed |
| `annai.resume` | localStorage key removed | ignored by old pages |

## Review Focus

1. **A run cut off mid-move, twice:** every file ends up once in the chat, none lost, its short name with it. Test in Task 3.
2. **An old `me` watch or owed restart at start:** logs, `remind` fires, no turn runs, nothing stays owed. Test in Task 2.
3. **Typing, a tap, a photo or `ui.shiori.send` with nothing open:** a chat is made and the words land there, in the order said. Test in Task 2.
4. **A plain start when `activeTrip` was removed, archived or a draft:** home. Test in Task 1.
5. **An Undo of a hand-over whose chat is gone:** the files go to the waiting chat, not nowhere. Test in Task 3.

---

### Task 1: The opening rule

**Files:** Modify `src/ui/resume.js`, `src/ui/shell.js` (`noteScreen`), `src/app/main.js`; test `test/unit/resume.test.js`, e2e.

**Interface:** `screenToResume({ ws, store }, at, { now = Date.now(), zone = deviceZone() } = {}) -> Promise<string | null>`: `talkHref(activeTrip)` when plain start, the trip is active and no draft, and `talked` is under 12 hours old or it is happening; else `null`, which is home.

- [ ] Failing tests at 11:59 and 12:01 of hours, happening with an old `talked`, each line of Review Focus 4, a link not redirected. Implement. Delete `noteScreen`, `KEY`, `OF_TRIP`. Commit.

### Task 2: `me` read-only

**Files:** Modify `src/core/agent/halves.js` (`send`, `tap`), `src/core/agent/loop.js` (`wake`, `#open`, `remind` stays), `src/ui/router.js` (`redirectOf`), `src/ui/screens/talk.js`, `trips.js`, `src/app/main.js`, `src/core/chats.js`; test `test/unit/halves*.test.js`, `loop*.test.js`, e2e.

**Interfaces:** `agent.chatFor: () => string | null`, set in `main.js` to `chats.ready`, as `agent.next` is. `Halves.send` and `tap` with `target === null` call `open(chatFor())` first, synchronously. Route `#/talk/me`: `renderTalk` reads `ME`'s log with no composer and never calls `open`. `redirectOf`: `#/talk` and `#/plan` with nothing open go to `#/trips`; `#/talk/me` is never redirected.

The guard, in the loop: with target null, a wake logs and `remind` fires, with no turn and nothing owed. One place.

- [ ] Failing tests: Review Focus 2 and 3; `#/talk/me` shows old lines, and typing from there starts a new chat; the timeline's row "Shiori, no trip" appears only if `me` has lines, sits by its last line, and opens `#/talk/me`; `me` in a notification opens home (stage 3 holds); the tuning wake waits.
- [ ] Implement. Lessons entry: `## 2026-11-06 me takes no more turns`. Commit.

### Task 3: The waiting move

**Files:** Create in `src/core/waiting.js`: `moveWaitingToChat(ws, wake) -> Promise<string | null>`. Modify `src/app/main.js`, `src/core/archive.js` (after an import), `src/core/handover.js:340`; test `test/unit/waiting.test.js`.

- [ ] Failing tests: no files, nothing made; files move into one chat titled t`Waiting with Shiori`, with short names and a `file` wake so she reads them on opening; Review Focus 1 and 5; a restored backup's files join it; the chat removed, a new one.
- [ ] Implement. Keep `waitingChat` before the first move. A file already in the chat by hash is dropped from waiting, not copied again.
- [ ] Commit.

### Task 4: The no-trip paths go

**Files, from the spec's What goes:** `src/core/agent/tools.js` (the `/waiting` root), `src/core/agent/loop.js` (`waitingMedia`, lines 143 and 2365), `src/core/reach.js` (its `me` clause), `src/core/handover.js` (the waiting text, and Undo back to waiting), `src/ui/composer.js` (`handOver`'s `SYS_WAITING` branch), `src/ui/dock.js:152-155`, `src/core/agent/context.js:77`, `src/ui/screens/trips.js` (no-trip card, Waiting panel), `src/ui/screens/file.js` (`waiting-file`), `src/ui/format.js` (`waitingHref`), `src/ui/router.js`, `src/core/agent/trip-tools.js` (`filesOf`'s waiting branch, `start_trip`'s no-trip text), `src/ui/screens/import.js`, the files plugin and `names.js`.

- [ ] Remove them, a group at a time, each with its tests: `grep -rln "SYS_WAITING\|waitingMedia\|No trip is open\|open(null)" test`. A test of a behaviour that still matters moves to a chat; one of a removed path goes. `SYS_WAITING` and `waitingFiles` stay for the move.
- [ ] `dock.js`'s camera: with nothing open, `open(chatFor())` first.
- [ ] Run all, e2e whole. Lower or raise the budget by what it says. Commit.
