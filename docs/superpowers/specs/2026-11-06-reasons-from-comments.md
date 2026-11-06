# Reasons moved out of code comments

The cleanup pass of 2026-11-06 cut comments to a line or two. These reasons need more room than a comment. Where the main spec ([the design](2026-10-15-annai-design.md)) has some of the figures, a section says so.

## Koe's hold on a pause ([src/core/koe/live.js](../../../src/core/koe/live.js), `HOLD_MS`)

A realtime check measured the pause clip's 1.74 s gap: it goes on about 1.05 s after the turn's end, and Gemini's first sound came a median of 0.9 s after it. The main spec (§10.8, Sound) has the 0.75 to 1.4 s range and the 1.74 s pause, but not these two numbers.

## What the position patterns leave ([src/core/archive.js](../../../src/core/archive.js), `pointPattern`)

Spec §12.2 lists what a Share without places removes, not all of what it leaves. Not matched: two numbers with only a space between and no hemisphere, degrees-minutes-seconds, a hemisphere written before its number, and a pair split over two lines. Some number pairs that aren't positions go too ("near 12.50, 14.00", a list "1.250, 3.500"): that is the price of catching the rest.

## A price schedule in `modelOf` ([src/core/llm/config.js](../../../src/core/llm/config.js))

A schedule the user made is left whole, because the Prices box takes the fields typed out of the schedule as they are typed. An emptied schedule can be `[]` or null, and older builds read null as the schedule removed, so both count as no schedule.

## The speech detector ([src/core/voice/detector.js](../../../src/core/voice/detector.js))

**The floor guess.** Before any floor, or under a young one (maybe a word's), a frame of near digital silence makes the floor a guess, `FLOOR_MIN_DB`, so a word said as a new microphone's zeros end is speech. Sound over a guess is held (`speechMs` 0) until the room is heard (a frame near it, or outside speech one too quiet to start speech: the floor), the run ends, or a second has passed: the floor is then its quietest frame (or steady sound's level), and the run is judged again.

**`minDb`.** A frame under the level check's minimum never starts speech, though a run going on is untouched. It applies only once the floor is learned: a guess, or a floor a second old, says nothing about the room. Such a frame is neither a blip nor the room as far as the floor goes: its quiet counts as quiet, and only steady sound (a second of it) moves the floor. `floorDb` exists because a new session's first second would otherwise have no minimum.

**Near-silent frames in speech** count as quiet because an iPhone's echo canceller gates the microphone to zeros: without this a turn once ran on for 29 s.

## The player ([src/plugins/voice-browser/player-worklet.js](../../../src/plugins/voice-browser/player-worklet.js))

**`PRE_MS`.** The figures come from a table of 255 past Gemini turns (the main spec's §10.8 has them too). With nothing held, a 100 ms stall in the connection would have left a hole in 85 of them; with 150 ms held, in 8. Her first sound comes later by a median of 0 ms and a p90 of 35 ms, because the 150 ms is mostly in already by her first word. 200 ms gains little more.

**How it plays.** It starts once `PRE_MS` of sound is in, the stream has ended, or `CAP_MS` have passed, and the same again after running dry. About to run dry, it fades out over the sound it still has, and fades in when it plays again, or back in if more came during the fade. 'stop' fades out over `STOP_MS`, or what is left if less, then it is silent and done. 'end' plays to the last sample, then it is done, unless it had already run dry and faded out with nothing since: then what was left of the fade is let go.

## Her eye ([src/ui/avatar.js](../../../src/ui/avatar.js), `OPEN`, `LASH`, `LIGHT`)

The front open eye differs from what [scripts/shiori-art/measure.mjs](../../../scripts/shiori-art/measure.mjs) prints, on purpose, so a re-run of the tool doesn't change her. `OPEN` is the tool's oval except its 8th and 9th points (by the lash's root), which come from an earlier measurement and are 1 to 3 units off; `LASH` was traced by hand from the master, along the lash's outer edge and back along its inner one, where the tool gives a different 13-point outline; `LIGHT` is round, where the tool measures 14.5 by 14.8.

## Back on a question ([src/ui/ask.js](../../../src/ui/ask.js))

Where the browser closes a modal dialog on Back itself (CloseWatcher, Chrome 120+), annai lets it; elsewhere (Chrome 113, Safari) opening adds a history entry, as the photo viewer does, and Back takes it. On Android without CloseWatcher the dialog is not modal, because Chrome 113 swallowed the first Back for a modal dialog, so it took two: annai draws its own backdrop, makes the rest of the page inert, and keeps focus in the question and Escape closing it. An iPhone has no Back button, and WebKit handles the modal with its history entry, so it keeps the modal. An answer takes the entry back before it resolves, so what the answer does next, such as a new screen, stays.
