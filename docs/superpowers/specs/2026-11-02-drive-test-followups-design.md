# Drive-test follow-ups: design

> **Names since changed (2026-11-17):** the "Tidy up" menu is the ⋯ by the conversation's name (**Conversation menu**: Summarize now, Start fresh). The text below keeps the names it was written with.

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
- **The end row** on its day, at its end time, a regular row (a link to the details, its place; as fixed as a plan item stored for it that ends there, ● or ○, and with no mark when nobody said, which changed on 2026-11-16 from "fixed ●"):
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

- **Revised 2026-11-02 after two review rounds (my call, RULES 1 and 7):** the first shape rewrote the whole merged record and compared
  aliases with stored fields; each fix brought new edge cases (a second note refused, a rebooked flight keeping its old times, a plugin's
  field moved). The rule now works on what this write says, never on what is stored:
- **Aliases rename this write's own keys, before the merge.** In the write tool (the whole value) and the patch tool (its changes, `+`
  forms included), a booking's keys are renamed from common other names to the format's own, so a small model's first try is stored right,
  in one call. Times to `start`/`end`; `name` to `title`; `location`/`address` and a pick-up's location to one `place`; a total with an
  amount and currency to `cost` (a comma only as a thousands group; anything else to `fields.total` as written); flights[] legs to
  `start`/`end` (first departure, last arrival) and kept as `fields.flights` (a lone leg, any value that isn't blank and isn't a list, is a
  list of one under `flights+`, and under `flights` in a whole write; a patch's `flights` is merged into the stored one, an object key by key,
  so its lone value may be part of a leg and is no leg, and moves no time; a blank one is none: booking-rest-next); common detail names the user's model wrote (notes, room,
  phone, guests, passengers, airline, company, seat, flight) to `fields.<name>`; a car's drop-off place to `fields.dropoff`, an
  arrival's to `fields.to` (where it arrives; booking-next: it was `fields.arrival`, which reads like its time). A key the booking schema in force lists is never renamed (a plugin's registered fields stay theirs).
  An end's place is read by what is booked and compared with nothing (booking-time-next, 2026-11-18, the booking time path's design
  check, its Option 1: the comparison with the place, made on the write alone with one of three values, drew a Drop-off line repeating a
  hotel and dropped an address): an end's place, a stay's check-out too, is filed whole, its name and its address joined ("Airport lot,
  9 Other Road"; an object name with no address of its own takes the address into it, so a car's Return row keeps its position), a part that
  isn't text as written; a blank name or address is not given, top-level ones too. Removing the alias (`dropoff: null`, `arrive: null`) removes
  the field it stands for and nothing it filed under `fields` (as it always did: a hand-written `fields.to` stays); one patch of the key
  itself removes that. Whether a drop-off names the booking's own place is answered by the readers, which see the whole stored record
  (`dropsAtPlace`): a car returned where it was picked up has no Drop-off line, its Return row is at its place with its position, and a
  check on its drop-off is the place's. A restaurant's or an event's arrival is its end, as it always was, alone too (docs/limitations.md,
  "written with only an arrival": a write can't tell what such a booking's start stands for, so it never guesses one).
- **This write wins.** A renamed key replaces the stored own field (a patch `{checkout: …}` moves the stored `end`; `{flights: legsB}`
  moves a flight's `start`/`end` too). The same write giving both an alias and its own field with different values is refused, naming both.
- **Times:** a string time becomes `{ at, tz }` only with a known zone: a `tz` beside it, else, for anything but a flight or train, the
  trip's only zone. An offset that the zone doesn't have at that instant, an impossible date (Nov 31) or a date with no time is refused
  with words saying what to write. An unknown zone is never compared, only stored as written.
- **Stored records are never touched.** Keys already stored, aliases or unknown, stay as they are and never block a patch or an edit. A
  whole write renames what it is given, copied stored keys included (so a copied `checkin` beside a `start` is the same time, or is
  refused with "write start as {...} in place of checkin"). In a patch, a renamed key also sets its own name to null, so a copy stored
  under it goes at once and the double state never forms (`+` forms append and never delete); a null alias deletes its own field and
  the stored alias key (`total: null` clears `cost` and `fields.total`). In a whole write a null is the same as no key, except
  `unsure`, which the format check refuses. An edit that adds an alias is refused naming the format's field. Legs appended with
  `flights+` move `end` to the last leg's arrival (booking-next: one with a time of arrival and no zone of its own is refused, as a whole
  `flights` write is). A flight's last leg whose arrival is no date with a time (none, an airport as an object, a clock alone, "HND", a date
  alone, a day that doesn't exist, a date and a time written in a form annai can't read; `written`, the one reading) gives no end: a whole
  write stores none, a patch removes the stored one, the legs are kept as written, and the write's result says what is wrong with the
  arrival and asks for `end` when she knows it (booking-time-next: such a leg left `end` at the leg before, a time out of date, and a whole
  `flights` write or text was refused). Unless the same write gives `end`. Only what carries the traveller (a flight, a train, a ferry, a bus,
  a coach) takes its start and end from legs: any other booking's (a stay, a car, a restaurant, an event, an `other` booking) are its own,
  so legs given to one (`flights+` or `flights`, with times or without) are kept as written and move nothing, and when a leg has a time
  the result says so and, when the booking has no start or end of its own, asks for them. A whole `flights` write whose first leg is text
  (no date and time annai reads as its departure) gives no start, and the result says so whatever else the write gives: "no start or end"
  when the last leg's arrival is a time that is left out with it (an end with no start is on no day of the Plan, so none is read from the
  last leg either), else "no start". A last leg with no arrival adds its own note, and an end the write gives itself (`end`, or an arrival
  alias) is kept; a start the write gives itself lets the last leg's arrival give the end. Appending (`x+`) to a stored value that is no list keeps that value as the first item.
  `unsure`'s names for a time are read where the marks are read, by the record (`checkOf`, booking-rest-next): `departure` or `depart`,
  `arrival` or `arrive`, a stay's `checkin` and `checkout`, a car's `pickup` and `return` mark the part they stand for (`fieldOf`: leaving
  is the start and arriving the end, a stay's arrival its check-in and its departure its check-out) when the booking has that part and no
  detail of that name (a blank one is none), however the time was written and whoever stored the booking, so the Departs or Arrives line
  and the others carry the check. Nothing is stored for it (the stored names are as written, and the write's own alias still renames a
  name beside it, as before); never `dropoff`, which is a place too; a restaurant's and an event's names are read as written (their arrival
  is the open Deferred entry).
- **One rule for the place.** In a patch the place aliases merge into `place` like a JSON merge patch: a location (or a pick-up's
  location) is `place.name`, an address (or a pick-up's) is `place.address`, lat/lng are `place.lat/lng`; `address: null` is the address
  null and `location: null` is no place. A `place` of its own (object) merges with them, and different values for one part, or
  `place: null` (or `location: null`) beside a non-null alias, are refused naming both. What is stale is decided in `shioriBooking`,
  which sees the stored booking and the merged one: if the merged place's name differs from the stored one and this patch does not give
  the address or lat/lng, they are the old place's and go; likewise a new address without lat/lng drops the old position. A name that was only a copy of the address is no real name: naming the place keeps its address, and a new address takes the copy along. An empty name or address in an alias says nothing. A place left with a name that is blank is named from its address (a drop-off
  at that same address is kept in `fields.dropoff`, and the readers read it as the place: `dropsAtPlace`).
- **Unknown keys:** only a top-level key this write introduces that the schema in force doesn't list is refused, with words naming the
  format's fields and `fields`. The schema stays open, so the user's own edits, Undo, Restore and imports work as before.
- **Plugins** add fields inside `fields` (any key) or as top-level properties of a booking schema they register.
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
- No fix for 2 minutes after a slow last speed reads as still (a parked phone hardly sends fixes). While moving fast, "slow" means below
  walking (3 m/s): a last speed of 3 to 5 m/s (slow traffic before a tunnel) keeps moving fast through a gap, as a fast one does. (My
  call, chosen to avoid a tunnel reading as a stop; the review's fix.) The GPS restart's "time off screen" reset happens only when
  annai comes back on screen, not when a plugin changes.
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
- **"On it" (Kokoro, user's first idea):** when Kokoro starts something the user waits for (saving a note, changing the plan), it first
  tells Koe in one short line what it is doing ("saving your note now"), so Koe can say it at once, then tells Koe when it is done. It
  sends that line only when the [Koe said] lines don't show Koe already saying it's on it, and not for a quick look-up. Koe, when the
  user asks for something Kokoro does, says it's on it, and claims nothing done until a note says so.
- **Kokoro corrects Koe (user's second idea):** Kokoro already checks Koe's claims. A false "done" gets an immediate note of what is
  actually happening; a vague answer about what Kokoro is doing is corrected with a normal (append) note.
- The user's own Shiori personality now has two sections Shiori added on the drive (transcripts, and "Silence is fine"). They stay the
  user's: annai doesn't edit a personality. The handoff tells the user they can take them out.

Exact words are the builder's, close to the above, short, and in the style of the files they go in.

## 6. Live mic: event wakes, noise, and sleep

The user's answers (2026-11-02), asked after a design pass over core/koe/live.js:
- Event wake: "For an urgent time sensitive event, like when to turn while driving, maybe she should say it immediatly. for when it is
  fine delaying a bit. I think current listen for a bit still make sense. we just want to improve our noise rejection methods"
- Never-quiet sound: "Exchanges + close on 30 s of noise (Recommended)": only real exchanges (her speaking, the user speaking to her
  and her answering, taps, typing) keep her listening; two turns in a row that end at the 15 s cap close the session.
- Sleep: "I think we should allow when I ask, or kokoro tells koe to go to sleep. often kokoro is much more capable than realtime models."

What the code does today (the design pass): an event that opens a closed session sets `#brief` (listen ~8 s for an answer) but opens the
mic at once; any detector "speech" (music is enough) clears `#brief`, may make `busy` true so the event's message waits behind a music
turn (up to 15 s), and can cut her turn; `#poke` re-arms the quiet spell on every audio chunk, turn edge and provider event, so with
music the session never closes. An immediate note that opens a closed session never sets `#brief`. Nothing remembers a tap-sleep.

New:
- **Events keep "listen for a bit".** Every open that isn't the user's tap or typing (a trigger, a note) is brief, decided in one place;
  an immediate note too.
- **Urgent says it now.** An urgent event (an immediate note from Kokoro; a fired watch that is time-critical, if watches carry such a
  mark; otherwise immediate notes only) is said at once: never held behind a user turn in progress, and not cut by sound the detector
  takes for speech until she has said it. A non-urgent one may wait for a turn in progress to end, as today (15 s at most). The mark is set as the urgent note comes (a session it opens lets nothing in before it); while it holds, the microphone is deaf and notes waiting hold behind it. It is a bound, not a match of her turns to the note: it ends once her voice that began after the note went in has played out and nothing more of her answer is to come (no turn of hers going on or waiting, no tool call running, the last not calling a tool she speaks after), or at a cap, whichever comes first: 8 s from the note if no sound of hers begins (the silence watchdog's figure), 20 s from the note however long she talks. A reply of hers the provider cuts off for an input it took after beginning that reply (a newer urgent note, or a line the user sends: the microphone is deaf meanwhile) counts as no sound: the answer to what cut it is still to come, so the mark waits for her next voice, 8 s from the cut at most and never past the 20 s from the note (a line the user sends late in her reply finds the mark held). Rare for a newer note: a reply of hers beginning within about a provider round trip after an urgent note goes in (real Gemini, 2026-11-12, 3 recordings: a reply whose first sound came 20 to 30 ms after a text went in was cut 40 to 60 ms later, and the answer's first sound came 0.97 to 1.09 s after the cut; two notes in the same tick gave one turn and no cut, 13 of 13, 2026-11-13); and every time for a line the user sends while she says the note (Gemini keeps her turn open until about 0.3 s after her sound ends, gen-complete-r2, so such a line is a cut). Before this, the cut ended the mark and the music took the answer. A tap, a close or a dropped connection ends it too; a newer urgent note replaces it. With no session to take the note (the open fails, or the session closes while the microphone opens) there is no mark, and the note is handed on as a closed session's are. So an answer with nothing or a silent tool frees the microphone at 8 s, and a provider that answers the cut user turn and the note as one turn (Gemini) frees it as her line ends. (The main session's call, fix pass 4: four rounds of matching "the turn that answers the note" each left a case where the mark never ended or ended early.) Notes waiting go in after the mark ends, not before.
- **Noise rejection: only exchanges keep her listening.** The quiet spell is re-armed by her sound, words or tool calls, text going in,
  taps and typing, and a heard turn she answers with words: not by audio chunks, turn edges or turns she dismisses. `#brief` clears only
  on a tap, typing, or a heard turn she answers (words, a card or a question, or asking Kokoro about it (fix pass 6); a tool call that answers nobody, such as already_told, doesn't, though words after it do). When the spell runs out while only a user turn (or its answer) is pending, that turn
  decides: an answer re-arms it, a dismissed turn closes the session unless the detector still holds speech.
- **Sound that never stops: Kokoro decides, annai never closes on it.** The user (2026-11-02): "for the close on 30s of noise, let's
  make sure we do not cutoff actual exchange, looping back to maybe only kokoro should able to determine that." When the quiet spell
  has run out (nothing exchanged for that long) and the sound goes on, that is sound that never stops (talk radio, people in the car,
  music with dips): once a user turn that began after the lapse is itself let go (she answers it with nothing, the next turn cuts her answer before
  a sound or a word of it, or it runs to the 15 s cap with no pause), annai wakes Kokoro once with an [annai] line saying the microphone has heard non-stop sound, with the speech
  recognition of that turn, as input she sees answered or not (never at the moment a turn begins: it may be the user asking). Kokoro
  reads it with the conversation and, if it is music, other people or noise and not the user talking to Shiori, tells Koe to sleep;
  otherwise it does nothing. Only a real exchange ends the stretch: she answers a heard turn (words, a card or a question, or asking
  Kokoro about it), or the user taps or types; a close (the note then opens no session) or the stretch's note going in ends it too (a
  later stretch may wake Kokoro again). A note with no words for the user (go to sleep, its
  final text) from a Kokoro turn woken for that alone (its first wake line; the line joining a turn something else woke doesn't count, and anything that joins it later, the user's words, a choice or a photo, Koe's question or another wake, makes it a turn of its own whose notes are never dropped)
  is for that stretch, and is nothing once the stretch is over. Otherwise it goes in on the urgent path (the microphone deaf until her
  answer has played, the 8 s / 20 s caps), so the next piece of music can't cut her sleep call; it is still never owed to the user.
  Her own turn or a tool call goes first. A user turn going on as it is ready, or one awaiting her verdict, may be the user talking to
  her: it waits for that verdict, but at most about 3 s after that turn ends (real time, as the provider's verdict comes). Answered,
  the stretch is over and it is dropped; dismissed, it goes in at once. At that bound a user turn is never cut: one going on is let
  end, and one going on or ended since then gets its own about 3 s for her verdict, once (answered drops the note; otherwise it goes
  in, and a turn going on then is cut as an urgent note cuts one). So talk radio ends one piece later; a piece that ran to the cap
  gives the next, begun at once, no such wait (steady music sleeps as before). (Fix pass 7: the bound ran from the piece the note
  waited on, so a question begun right after it was cut, or her answer to it pre-empted.) A verdict that comes while the user's next
  turn goes on is the turn before's, never marked on the one going on: a music turn's dismissal landing in the user's question must
  not stop her answer to it counting as an exchange, and her answer (words, a card or a question, asking Kokoro) to the turn before
  still ends the stretch. A session told to go (GoAway) takes the note once the next is ready, never the one being left. (Fix pass 6, the main session's call: fix 5 waited for the latest turn's
  verdict, which never came under talk radio whose every verdict lands in its next piece, and at a cap the next music turn cut her
  sleep call, so she never slept and Kokoro was woken again and again.) One with words for the user, or from a turn something else woke too, goes as ever. After the wake, the quiet spell can still
  close it: a turn she lets go in a pause closes it. A let-go turn that the spell's own look then closes on (a quiet gap) wakes nobody:
  there is no session left to decide about. The quiet spell running out, or a let-go turn, on a run the detector still holds
  looks again 250 ms later, so a run let go as no turn doesn't leave the session open for good.
  Nothing closes by itself on sound; a real quiet spell (no sound, or a turn she lets go in a pause) still closes as before. There is
  no `noise` close reason.
- **Sleep, when the user asks or Kokoro says so.** Live Koe gets `sleep` (reverses plan decision 29), described as: only when the user
  asks you to sleep or stop listening, or a note from Kokoro tells you to. It closes the session like a tap (`sleep`). Kokoro's part says
  it may tell Koe to sleep when the live session is only hearing music, other people or noise. Koe (non-live) already has `sleep`.
- New close reason in the trace: `sleep`. Plan decisions 12 and 29 get a line each saying what changed and why; a LESSONS.md
  entry for decision 29 (an API reversed) is the main session's, not the builder's.
- Not done: muting the mic while media plays (a web app can't see what the car stereo plays) and an on-phone music classifier (several
  MB, and sung lyrics still look like speech).

## 7. Urgent watches

The user (2026-11-03), asked whether watches should get an urgent mark: "Yes, after the mic fix (Recommended)". The question said:
Shiori sets it on time-critical watches (a turn coming up, leave now, last train); when an urgent watch fires, the alert is said at once,
never held behind music, and the mic stays shut until she's finished; other watches still wait up to 15 s for sound already playing.

- A watch may carry `urgent: true` (optional; absent is false). The watch tools' description tells Shiori to set it only for alerts that
  lose their point if late (a turn, leave now, a last train or ferry), never for routine reminders.
- When an urgent watch fires while live Koe is in charge, its alert goes into the live session the way an urgent note does (section 6's
  urgent mark: said at once over sound, the mic deaf until her line has played, 8 s / 20 s caps). A closed session opens for it as for
  any event (brief listening after). Without a live session nothing changes.
- Kokoro still hears of the fire as today; only the delivery to live Koe changes.

## Not in this change
- Geocoding road intersections by name (Nominatim failing): not asked for.

## Review focus

1. A booking with only a start, or an end before its start, or in a zone annai doesn't know: one row, as today, no lines.
2. A stay and a plan item for it with slightly different times (item 16:00, booking 15:00): one set, from the booking.
3. A red-eye flight: start row, then "Arrive" the next day, no between lines.
4. A string time with no zone, in a trip with two time zones: refused with words that say what to write, nothing stored.
5. GPS: a tunnel or a long red light while moving fast; a phone at walking pace that sends no fixes for a while.
