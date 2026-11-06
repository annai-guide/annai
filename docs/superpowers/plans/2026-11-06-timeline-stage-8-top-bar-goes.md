# Timeline stage 8, The top bar goes: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** annai is two places, a timeline and a conversation: the top bar, tabs and Now go, and the e2e suite stops leaning on them.

**Architecture:** Subtraction, and a test rewrite as its own task. Plan this stage in detail only then: **it happens after the user has said on a real phone that the timeline is right**, and what it removes depends on what they say.

**Tech Stack:** Native ES modules, no build step, JSDoc checked by `tsc`, `node:test`, Playwright e2e in Docker.

**Spec:** `docs/superpowers/specs/2026-11-04-timeline-home-design.md`: sections What goes, Plugins, Stages.

## Global Constraints

- Gate: the user's own OK after the phone test. "The tabs go only after they've said it's right."
- Plugin `api` stays. The slots' new homes are additive.
- Lessons entries in the same commit; `docs/plugins.md` and, if a design in another repo should change, a line in `agent-rules/LESSONS.md` as that file says.
- Lower `BUDGET` by what comes out, in whole KiB. Estimated about -25 KiB against the stages before it. Never print line 4 of `scripts/size.mjs`.
- House rules as in the stage 4 plan, commands as in the stage 1 plan.

## Review Focus

1. **`#/now`, `ui.go('#/now')`, old bookmarks:** today's Itinerary of the trip in play, else home, by `location.replace`.
2. **A plugin's `ui:screen` with `tab: true`:** reachable from home's quiet row.
3. **A plugin's `homeFor`:** the shell's take-over still runs, and its crumb goes home.
4. **Gear and Trace:** reachable from home's body, with a plugin's dock too.
5. **`--topbar-h`:** the sticky header and the cards sit right with no bar.

---

### Task 1: The shell

Remove the top bar, `SECTION`, `lastIn`, tabs, swipes and `swipeTabs` (about 95 lines of `shell.js`), and `renderNow`, `nowRow`. Move `planRowOf` to `plan.js`, `latestCard` and `eventCard` to `drive.js`. Add the gear and Trace to home's body, and plugins' `tab` screens as a quiet row of links. `#/now` redirects. `ext.js:44` and `sees.js`' crumbs go home. Drop stage 3's hidden h1 for the header's own. Remove the Start a trip form. Whichever of these the user wants otherwise after the phone test changes first.

### Task 2: The e2e rewrite

Its own task, by a builder who touches no shipped code. `startTrip`, used 130 times, becomes `createTrip` in the page. Measured 2026-11-06: 72 lines name top-bar links, 32 `Conversation` h1 lines, 64 `#/talk`, 7 `#/plan`, 22 `#/now`. The spec counted 133 `#/trips`, 98 h1 assertions and 43 nav clicks in 21 files; recount before starting. `openApp`'s default stays `#/trips`.

### Task 3: Also removable

`start_trip` in chats, if stage 6 showed it is unused. Check what stage 7 left of the `/waiting` branches.
