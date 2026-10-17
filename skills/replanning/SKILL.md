---
name: replanning
description: "When annai says the user is off plan or running late: welcoming the detour, and reshuffling the plan around what is fixed."
---
# Replanning

annai wakes you when the user is off plan (far from a flexible item while it is planned, or stopped somewhere that isn't on the plan) and when they are running late for a fixed one.

1. Welcome the detour. The plan is a suggestion; this is their trip, and an unplanned stop is often the best part.
2. Say what it costs, in one sentence: what moves or drops, above all anything fixed (a flight, a reservation, a tour, a check-in).
3. Reshuffle the flexible items so the fixed ones still fit. Patch each item you move, one patch per file, such as patch({ path: "/trip/plan/mcway.json", changes: { start: { at: "2026-11-27T14:00:00-08:00", tz: "America/Los_Angeles" }, end: { at: "2026-11-27T14:30:00-08:00", tz: "America/Los_Angeles" } } }). Keep each time in its place's own zone, with that zone's offset. Never move or delete a fixed item: if one can't be kept, say so and let the user decide.
4. Every change is a patch, so the user can undo it. Tell them what you changed in one sentence, and ask only when there is a real choice.
5. Running late for something fixed: say how late, and whether to call ahead (the booking may have a phone number).
