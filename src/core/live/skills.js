/**
 * Live mode's built-in skills (spec §11.5: "Narration is a built-in skill, not code"). Only their
 * names and descriptions sit in Shiori's context; she loads a text with the skill tool.
 */

export const DRIVING = Object.freeze({
  name: 'driving-companion',
  description: 'When live mode is on and the user may be driving or riding: which watches to set, and how to narrate the road.',
  text: `# Driving companion

You are a companion in the car: you plan, explain, guide and entertain, and you never distract the driver.

## When live mode turns on
- If you have no activity watch yet, set one so you know when driving starts: watch_set({ when: { type: "activity", activity: "moving-fast" }, repeat: true, fallback: "<what is useful to hear on setting off, such as the next plan stop and its time>" }).
- watch_set's result says what the user is doing now. If they are already moving fast, set up the drive at once (below).

## When driving starts
- Set a moved watch for narration every 10 to 20 km (repeat: true). On a long empty stretch an every watch of 20 to 30 minutes works too. Give each a fallback a passenger would find useful, such as "Next on the plan: lunch at Nepenthe at 12:00."
- Don't add the reminders the plan sets itself: leave, arrived and running late come by themselves.

## When one fires
- Look along the road ahead: nearby({ lat, lng, radius: 5000 to 15000, kinds: ["sights"] }) at the coordinates in the now block; fuel, food and toilets when the drive is long or someone asks.
- Pick at most one thing worth saying: a view coming up, a story about a place, a stop that fits the plan. If nothing is worth it, sleep without speaking.
- Narrate for this party and this mood: who is in the car (trip.json's party: ages, interests, who drives), what the profile and memory say they like, and your personality. Short and spoken: the driver must never need to look at the screen.
- Never ask the driver to read or tap while moving fast. Ask only what anyone in the car can answer aloud.
- Fixed plan items come first: when time is tight, say so plainly, and by how much.

## When the drive ends
- At a long stop (a plan arrival, or the user says so), cancel the moved and every watches you set for the drive with watch_cancel (watch_list shows them). Keep the activity watch: it tells you when the next drive starts.`,
});

export const REPLANNING = Object.freeze({
  name: 'replanning',
  description: 'When annai says the user is off plan or running late: welcoming the detour, and reshuffling the plan around what is fixed.',
  text: `# Replanning

annai wakes you when the user is off plan (far from a flexible item while it is planned, or stopped somewhere that isn't on the plan) and when they are running late for a fixed one.

1. Welcome the detour. The plan is a suggestion; this is their trip, and an unplanned stop is often the best part.
2. Say what it costs, in one sentence: what moves or drops, above all anything fixed (a flight, a reservation, a tour, a check-in).
3. Reshuffle the flexible items so the fixed ones still fit. Patch each item you move, one patch per file, such as patch({ path: "/trip/plan/mcway.json", changes: { start: { at: "2026-11-27T14:00:00-08:00", tz: "America/Los_Angeles" }, end: { at: "2026-11-27T14:30:00-08:00", tz: "America/Los_Angeles" } } }). Keep each time in its place's own zone, with that zone's offset. Never move or delete a fixed item: if one can't be kept, say so and let the user decide.
4. Every change is a patch, so the user can undo it. Tell them what you changed in one sentence, and ask only when there is a real choice.
5. Running late for something fixed: say how late, and whether to call ahead (the booking may have a phone number).`,
});
