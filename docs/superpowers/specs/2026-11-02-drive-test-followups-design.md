# Drive-test follow-ups: design

The user drove home with live mode (GPS) and a live voice session on, as a test, on 2026-11-02, and checked last round's Files work
on the phone. This covers what they asked for after it. Live mic listening (an event wake opening the mic, music keeping it open) is
designed separately, once its questions are answered.

## The user's words

- "the tidy up button now is bit intrusive on the conversation pannel... is there some better place to put it / hide it?"
  Chosen: "⋯ menu by the title (Recommended)".
- "if events span multiple day, like the hotel bookings, also show them somewhat on the say it also spans to? maybe especially put the
  checkout as regular events. (so like know when to checkout, when to return the car etc)"
  Chosen: "Start, days between, end (Recommended)": stays get Check in, a "Staying at … · night 2 of 4" line each night, then Check out
  at its time; cars get Pick up, a quiet "Car · day 3 of 8" line each day, then Return at its time; anything else that ends on a later
  day gets its end as a row on that day.
- On the booking format: "so should we refuse field names we do not know? I guess it does not help if nothing reads it correctly...
  however maybe we should add some aliases for the names so models do not make the same mistake? these entries were added by the tiny
  3.5flash lite I think so it did not format the docuements correctly. although the times and stuff do all look correct but things like
  this can show capabilities... regardless, we do not control what model the user ues. so if we are refusing names we do not know (make
  sure that plugin can add acceptable fields if so), maybe adding the alias will reduce the calls the small model may need to do, just
  one call instead of getting rejected and call again with (potentially) the correct fields"
- GPS (typed after the drive): "I also turned gps on manually, but in ui it keeps on even when I reached home and is saying moving fast.
  maybe this is not intended?"
- Said to Shiori while driving (from the trace):
  - "I see the English transcript produced here by the voice mode is not exactly that accurate … tell them to not exactly trust the
    transcript produced if it's in the voice mode … close guess to other sound close words may be required to understand what the user
    is actually saying". And: it belongs in the base prompts for all users, not a personality.
  - "in the real-time conversation mode, I see the agent actually talks quite a bit and especially for cases that I don't really need to
    respond … it's definitely one request out, one request in … other times like staying silent is perfectly fine."
  - On saving a note: Koe answered vaguely before it knew Kokoro was saving it. "let's make Kokoro send information about it's doing
    something to Koe first. I don't know how to solve it". And: "maybe let Kokoro also read Koe's transcript, but I think it already
    does that. So maybe in the prompts, if Koe said something that's not intended, … correct that".

## 1. Tidy up moves to a ⋯ menu by the title

The Conversation screen's "Tidy up" control leaves the foot of the conversation (talk.js `tidyMenu`, placed after the list since
2026-10-28). A small ⋯ button sits at the right of the "Conversation" title; it opens the same two choices with the same explanations:
Summarize now and Start fresh. Nothing about what they do changes. The button has an accessible name ("Tidy up the conversation"), and
the menu opens below the button, inside the screen at phone width. The e2e tests that open Tidy up find it there.

## 2. Bookings and plan items over several days

Today (core/plan.js `planRows`): a stay booking with a good start and end gets a check-in row, a night line for each night between, and
a check-out row. Nothing else that runs over several days gets more than one row on its first day ("10:00–10:00 +7").

New, one rule for everything with a start and an end on a later day (in their own zones):

- **The start row** on its day, at its start time, with no end in its time ("10:00", not "10:00–10:00 +7").
- **A quiet line on each day strictly between** (not a link, like today's night line):
  - lodging: "Staying at {name} · night {n} of {N}" (today's line, unchanged);
  - car: "{name} · day {n} of {N}" (N counts the pick-up and return days);
  - anything else: "{name} · day {n} of {N}".
- **The end row** on its day, at its end time, a regular row (a link to the details, fixed ●, its place):
  - lodging: "Check out · {name}" (today's);
  - car: "Return · {name}"; the start row reads "Pick up · {name}";
  - flight or rail: "Arrive · {name}";
  - anything else: "Ends · {name}".
- **One set per thing.** A booking with a good start and end draws its own set; a plan item that stands for it (`booking` set) adds no
  second set, even when the item has its own times over the same days. A booking with no good start or end, and a plan item that stands
  for it with a good start and end, draws the set from the item. A plan item with no booking draws its own.
- A plan item that stands for a booking on one of the set's days still replaces that day's booking row, as today (a check-out item leaves
  no second Check out row).
- Kinds and words: the booking's `kind`, else the plan item's `kind`. The 60-day cap on lines (`NIGHTS_MAX`) stays.
- Everywhere plan rows are shown follows: the Plan screen, and Now (`upcoming`) and Drive (`routeStrip`) through ui/trip-rows.js. An
  end row is a row like any other there; a quiet line is not an event. Koe's `<today>` (core/koe/context.js) reads the raw files, not
  `planRows`: it must also list today's end rows (a check-out, a return, an arrival) at their times; how is the builder's call (building
  it on `planRows` is fine if its size cap and order hold).
- Which item draws the set when a booking has no good times and several items stand for it: the one whose start and end span days,
  the earliest if more than one. That item's row loses its "–10:00 +7" (its end is its own row now): intended.
- Numbering (my call): a stay's N is its nights, lines n = 2…N (today's). A car's and anything else's N is its days, the pick-up and
  return days included, and the lines between are n = 2…N−1. "{name}" is the title, else the kind's word ("Car"), as today.
- Plan items' own reminders and watches (plan-watches.js) are not changed by this.

Why the user's trip shows none of this today: its bookings carry their times under names the Plan doesn't read (section 3), so each stay
and the car showed as one row with "+4" or "+7". The plan items standing for them have good times, so the rule above draws their days
from the items, without touching what is stored.

## 3. Booking format: aliases, then refuse what is still unknown

What happened: a small model (Gemini Flash Lite) wrote bookings with `checkin`/`checkout` strings, `pickup`/`dropoff` as
`{ location, at }`, a flight's legs as `flights[] { flight, origin, destination, departure, arrival }`, and `name`, `address`, `total` at
the top level. The booking schema (plugins/core-schemas `BOOKING_SCHEMA`) lists `start`, `end`, `place`, `title`, `cost` and `fields`
but does not refuse other keys, so the writes passed and nothing read their times.

New:

- **Aliases first.** Before the format check, a booking Shiori writes is rewritten from common other names to the format's own, so a
  small model's first try is stored right, in one call. At least the names above, and their obvious spellings (`check_in`, `checkIn`,
  `pick_up`, `drop_off`, `return`, `depart`/`departure`, `arrive`/`arrival`, `price`/`total`): times to `start`/`end`; `name` to `title`;
  `address`/`location` to `place`; a total with an amount and currency to `cost`. The builder writes the table, small and plain.
  - A time written as a string becomes `{ at, tz }` only when its zone is known: a `tz` beside it, else the trip's only time zone
    (trip.json `timezones` with exactly one). Otherwise it is refused, with words that say to write `{ at, tz }`.
  - A flight's `flights[]` legs: `start` is the first leg's departure and `end` the last's arrival, and the legs are kept in
    `fields.flights`, as written.
  - An alias never overwrites the format's own field when both are given; the alias is then refused as unknown.
- **Then refuse unknown keys, in Shiori's guard, not in the schema.** After the aliases, `shioriBooking` refuses a top-level key that the
  booking schema in force doesn't list in its `properties` (the one `schemaFor` returns for that path, so a plugin's registered booking
  schema with more properties is honoured). The error names that schema's fields and says anything else goes in `fields` (one line, in
  the tool result, as every format error today). The schema itself stays open, so the user's own edits, Undo, Restore and imports of
  bookings already stored work as before.
- **Plugins add fields** either inside `fields` (any key, no registration) or as top-level properties of a booking schema they register
  (the last registered for a path wins, as today). (My call; a call to confirm.)
- **An alias and its own field both present** (a stored `name` beside `title`): equal values, the alias is dropped quietly; different,
  refused, the error naming both and saying to remove one (write it as null in a patch).
- Mapping details (my calls): a car's pick-up location is `place`; a different drop-off location goes to `fields.dropoff`. A date with
  no time, or a time with neither `tz` nor the trip's only zone, is refused with words saying to write `{ at: "YYYY-MM-DDTHH:MM", tz }`.
  A string with an offset is a good `at`; its `tz` still comes from beside it or the trip's only zone. A `total`/`price` that is
  `{ amount, currency }` or "123.45 USD" becomes `cost`; anything else goes to `fields.total` as written. A flight's legs give no
  `place`.
- The guard runs synchronously inside the write's lock; the trip's zones are read before the write (the files plugin) and handed to it.
  `writeMany` takes no guard: if any Shiori booking write goes through it, the builder routes the aliases there too.
- **Bookings already stored** are not rewritten. They read as before. Shiori's next write of one goes through the aliases, so she fixes
  it in one call when she touches it.
- The plan-item format gets no aliases (no model has written it wrong).

## 4. GPS: "moving fast" after arriving

Cause (from the trace): after parking, the phone sent three fixes in two minutes, at 0.8 to 1.5 m/s. Leaving moving fast needs the slower
speed to hold for 60 s (`LEAVE_FAST_MS`), and `ActivityTracker.feed` only decides on a new fix, so with no fix after the hold the activity
stayed "moving fast"; the stop, arrived and dwell watches that wait for it never fired. Live mode stayed on because the user turned it on
by hand: that is intended.

New:
- A held change completes on time, not only on the next fix: the tracker is also asked when live.js's existing recheck runs
  (`RECHECK_MS` through `#schedule`), sooner while a change is pending, and the last speed seen counts as still holding. In the drive's
  case it reads "walking" a minute after the slow fixes began.
- No fix for 2 minutes after a last speed below moving fast reads as still (a parked phone hardly sends fixes). A last speed that was
  moving fast keeps moving fast through a gap (a tunnel). (My call, chosen to avoid a tunnel reading as a stop.)
- The UI shows the activity the tracker has now.
- Note: the drive's arrived (3 min) and dwell (5 min) watches could not fire anyway: the user turned live mode off about 2 minutes after
  parking. Nothing to change there; the builder checks that arrived and dwell are also evaluated on the recheck, not only on new fixes.

## 5. Prompts: transcripts, silence, and Koe and Kokoro in step

Base prompts (core/koe/instructions.js for Koe, its live form, and Kokoro's part; core/agent/instructions.js for Shiori when one model
does both), for every user. "Keep them stable": each change restarts their caches once, which a release does anyway.

- **Voice transcripts can be wrong** (Koe, Koe live, Kokoro, Shiori): "[heard] lines are speech recognition and often swap in words
  that sound alike, most of all names of places, people and this app. Take what the user most likely meant from the trip and the
  conversation; when another reading would change what you do, ask."
- **Silence is fine** (Koe live): "Not every line needs an answer. When the user only acknowledges (okay, cool, thanks) or thinks aloud,
  say nothing. Answer when they ask, tell you something, or need something." The live rule "speak first … even a short acknowledgement"
  applies to requests, not to everything the user says.
- **"On it" (Kokoro, user's first idea):** when Kokoro starts something that takes more than a moment for the user (saving a note,
  looking something up), it first tells Koe in one short line what it is doing ("saving your note now"), so Koe can say it at once, then
  tells Koe when it is done. Koe, when the user asks for something Kokoro does, says it's on it, and claims nothing done until a note says
  so.
- **Kokoro corrects Koe (user's second idea):** Kokoro already checks Koe's claims. It also corrects Koe when Koe answered vaguely or
  said something was done that isn't, with an immediate note of what is actually happening.
- The user's own Shiori personality now has two sections Shiori added on the drive (transcripts, and "Silence is fine"). They stay the
  user's: annai doesn't edit a personality. The handoff tells the user they can take them out.

Exact words are the builder's, close to the above, short, and in the style of the files they go in.

## Not in this change

- Live mic listening: an event wake that opens the mic fully, listening that never ends with music or road noise, and whether Shiori
  can pause listening herself. Its own design, next.
- Geocoding road intersections by name (Nominatim failing): not asked for.

## Review focus

1. A booking with only a start, or an end before its start, or in a zone annai doesn't know: one row, as today, no lines.
2. A stay and a plan item for it with slightly different times (item 16:00, booking 15:00): one set, from the booking.
3. A red-eye flight: start row, then "Arrive" the next day, no between lines.
4. A string time with no zone, in a trip with two time zones: refused with words that say what to write, nothing stored.
5. GPS: a tunnel or a long red light while moving fast; a phone at walking pace that sends no fixes for a while.
