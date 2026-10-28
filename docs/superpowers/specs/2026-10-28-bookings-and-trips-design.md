# Bookings and trips: hand Shiori your bookings, and she does the rest

Date: 2026-10-28. Status: approved by the user on 2026-10-28 ("Approve as written").

## Why

The user's first real trip setup on their iPhone (2026-10-28). They had flights and a hotel booked for a holiday trip, with the confirmations as PDFs and screenshots. What happened:

- They asked Shiori to start the trip. She couldn't (she has no tool for it) and sent them to the Trips screen.
- The Start a trip form demanded dates they didn't want to work out by hand.
- Adding the files meant finding a box at the bottom of the trip screen and choosing where each file goes.
- The flight then showed on the Plan as raw JSON ("Check this"). Its details were on a separate Bookings list, and they held little, not even the time.
- "Open the original" couldn't show the PDF, and Back went to the wrong screen.

In the user's words: "I wanted to import files / photos to have her figure out the trip timelines and details from the flight / lodging details. and I also should not need to specify where I want to put these files? I expect she should know? ( I should still able to manually do that but that should not be the only way )". And: "I think the files interactions needs to be rethink and redone..."

## Intent

Handing Shiori a booking should be like handing it to a good travel agent. She reads it, finds the trip it belongs to or starts one, puts it on its day, and tells you what she did. You can still do any of it by hand, and you can always see and open the file itself.

## Goals

1. **One way in: a + next to the text box.**
   - It picks photos or files (PDFs, screenshots, Wallet passes) and sends them to Shiori like a message, with or without words.
   - Pasting a confirmation email's text into the box works too.
   - The dock's camera button stays for taking a photo now.
2. **She works out what each thing is and where it goes, does it, then tells you.**
   - **What it is:** a flight, a stay, a car, a train, an event or a reservation, or just a photo of the trip.
   - **Where it goes:** the trip whose dates and places it fits; if none fits, a new trip she starts, named and dated from the bookings (for example "Anchorage · Nov 20–27").
   - **Then she says what she did,** with Undo.
   - She never asks where a file goes.
3. **A trip needs only a name.**
   - Starting a trip by hand asks for a name; dates are optional.
   - Shiori fills the dates in from the bookings, and can rename a trip or change its dates when asked.
4. **A trip she starts while no trip is open, opens,** and the conversation carries on inside it.
   - **The trip's conversation starts with:**
     - the hand-over (the user's message and files);
     - her short recap of what the user had said about this trip before ("A long weekend in Testville with Sam").
   - **The no-trip conversation** keeps its own lines, plus one saying where they went.
   - **A booking for a trip that isn't open:** while the user is in another trip, she moves the file into that trip's Files and says so.
     - That trip's Shiori reads it and puts it on that Plan the next time the trip is opened. Its card on the Trips screen shows that a file is waiting to be read.
     - Trips stay walled off from each other. To choose a trip, she sees only the other trips' names, dates and places.
5. **Each booking is on its day on the Plan:**
   - a flight on the day it leaves, with times in each airport's own time zone;
   - a stay on its check-in and check-out days, plus a quiet "Staying at Hotel Aurora Test · night 2 of 3" line on the nights between;
   - a booking with no day of its own (an open ticket, a pass for the whole trip) at the top of the Plan, under "Not on a day".
6. **Tapping anything on the Plan opens its details first.**
   - **For a booking:**
     - what Shiori read (times, confirmation, seat, travellers, bags, and so on);
     - the file's preview, PDFs included, with **Open the original**, which shows the file itself;
     - **Ask Shiori about this**;
     - **Change it** (the raw form, as today).
   - **For any other event:** what it is, when, where, notes, and the file it came from, if any.
7. **Ask Shiori about this** opens the Conversation with the booking (and its file) attached as a chip in the type box.
   - The user then writes what's wrong or missing ("the return flight is missing", "the seat is 14D, check the PDF").
   - A one-tap **Read it again** suggestion sits under the chip.
   - The same button is on every event's details and on each file in the trip's Files section.
8. **A Files section on the trip** lists each file kept with it and what it became (a flight, a stay, a trip photo, or nothing yet).
   - From it you can add a file by hand, open one, or ask Shiori about one.
9. **The separate Bookings list at the bottom of the trip screen goes:** every booking is on its day and opens its own details.
10. **Each file gets a short name from Shiori.** File names are often not words ("IMG_3021.PNG", "Your flight is booked- TESTQ1 to Testville on 11:20:2026.pdf").
    - She names each file for what it is ("ANNAI AIR flight · Nov 20"), shown in Files and on chips.
    - The real file name is kept and shown on the file's own screen.
    - The user: "maybe let shiori also make a nick name for each file? as they can be not actual text".
11. **Whoever can read a file, reads it.** Kokoro reads files, as today. When none of Kokoro's models can read a PDF or a photo:
    1. a model of Koe's that can reads it;
    2. else a utility model that can reads it as a side task and hands back what it found (the role's existing "described by a model that can" rule, widened);
    3. else, for a PDF, a model that reads images reads the PDF's pages as images, through the plugin in goal 12.
    Only when nothing can read it does she say which setting fixes it.
    - The user: "if kokoro does not understand pdf but koe do, or if a util model do, shall we let it process it? ... and if none of them do, and a util model do, then we may launch an subagent to extract information?"
12. **An official plugin turns PDF pages into images** for models that read images but not PDFs.
    - It also gives every browser a first-page preview for the details screen.
    - The PDF library it needs lives in the plugin, not in annai's own code, so annai stays small for anyone who doesn't install it.
    - The user: "should we have a plugin for screenshoting the pdf for models that do not understand pdf?".

The mockups the user approved (screens 1, 2b and 3) are at https://claude.ai/artifact/84kVTb4vPnrMfbZGKRkcXf (private to the user). Screen 3's "Ask Shiori to read it again" became Ask Shiori about this (goal 7), and screen 1 shows the trip opened, per goal 4.

## Non-goals

- **An email address annai receives mail at.** annai is local-first, and that would need a server reading the user's mail.
- **annai in the iPhone's Share sheet.** A Home Screen web app can't be a share target on iOS. The routes are paste the email's text, or save its PDF to Files and pick it with +.
- **Reading files with annai's own code** (OCR, PDF text extraction). The user's models read them (goal 11).
- **A PDF library in annai's own code.** One lives only in the optional plugin (goal 12).

## Anti-goals (a failure even if it works)

- Asking the user where a file goes.
- A booking filed into the wrong trip, or dropped, without Shiori saying so.
- The user's files or their contents going anywhere but the models the user chose. Nothing new leaves the phone.
- A screen that shows raw JSON as the first thing a tap opens.

## Constraints

- **The platform:**
  - a browser-only, local-first PWA;
  - the iPhone's Safari as a Home Screen app is the main target, with Android Chrome and desktop browsers also supported;
  - Japanese, Chinese (Simplified, and soon Traditional) and English screens.
- **The records stay as they are** (spec §4.4), extended rather than replaced:
  - a booking keeps `status` (`unverified`/`confirmed`) and `source` (the path of the file it came from);
  - plan items keep their shape;
  - `trip.json`'s `start` and `end` become optional;
  - old trips and bookings keep working.
- **The import path of spec §7.3 stays:** the file is saved, Shiori is woken, she reads it and writes an `unverified` booking. This design adds where the file comes from, where it lands, and what the screens show.
- **The project's rules hold:**
  - store data, not words;
  - the three kinds of words (the user's words translated, a model's English, a developer's English);
  - every new user-facing message is translated in ja and zh-Hans;
  - fewer dependencies;
  - save data on the go;
  - accessible as built (real buttons, labels, focus, screen-reader order).
- **PDF preview without a new dependency in annai's own code.**
  - Safari draws a PDF's first page in an `<img>`.
  - Elsewhere, without the plugin of goal 12, the preview is a file card (an icon, the name, the page count when known).
  - **Open the original** uses the browser's own viewer for the file.
- **Models:** reading a PDF or a photo needs a model that can.
  - Claude models are being fixed to read both by default (phone-fixes-1).
  - When no model in the role can read a file, Shiori says so and names the setting that fixes it.

## What the user decided (2026-10-28)

| Question | The user's answer |
|---|---|
| A flight PDF arrives and no trip exists | "She does it, then tells me" |
| Where the thumb goes to hand something over | "A + where I type" |
| Where bookings come from | "Confirmation emails, PDFs in Files, Screenshots / photos" |
| Part 1 as played back (paste, camera stays, file kept and re-readable) | "Right as written" |
| A hotel stay on the Plan | "2b: a line on every night" |
| What a tap opens | "Right as drawn" (screen 3) |
| Part 2 as played back | changed: "maybe we instead do a 'reference this in the chat' button? so that we can say stuff not just simplely ask her to re-read it" |
| Ask Shiori about this, as shaped | "Yes, like that" (the chip plus a one-tap Read it again) |
| Where the files are listed | "A Files section on the trip" |
| A trip she starts while none is open | "Yes, open it" |
| Additions (mid-conversation) | a PDF-pages plugin; whoever can read a file reads it (Koe, a utility model as a side task); confirming in the flow, "more natual and less taps is better"; "let shiori also make a nick name for each file" |
| What the trip's conversation starts with | "The hand-over and a short recap" |
| A booking for a different trip, while in a trip | "Move the file there" |
| Confirming her reading | "No step; she asks only when unsure" |

## My calls (for the user to check)

1. **There is no confirming step** (the user's answer).
   - When a file is clear, she files the booking and says what she put where. Nothing waits for a tap.
   - Only a field she is unsure of gets a light "check" mark, and she asks about just that in the conversation. Correcting anything is just telling her.
   - This changes spec §7.3, where every new booking starts `unverified` and the Plan shows it as "Check this": a booking's uncertainty is now per field, kept as data.
   - The builder shapes the record. Old `unverified` bookings show with their whole booking marked, until the user tells her it's right.
2. **Undo** takes back exactly what Shiori wrote from that hand-over, and never anything of the user's.
   - It removes the bookings and plan items she made, and a trip she started.
   - If the user has since changed one of them, or added anything to the trip (a message, a note, a photo), Undo leaves that and says so. A trip with anything of the user's in it stays, emptied of her writes.
   - A trip removed this way is removed as Remove trip removes one (spec §4.9, its space given back), with no question: the user just asked for it by tapping Undo.
   - The files stay, in the trip's Files, or waiting with Shiori if the trip is gone.
   - Undo stays on her message until her next hand-over.
3. **Files given while no trip is open wait with Shiori,** in a space of their own, not in /me/.
   - So no trip sees them, and moving one into a trip gives its space back.
   - While any wait, the Trips screen shows "Waiting with Shiori" with each file: open it, ask about it, or delete it.
   - She moves each into its trip's Files when she files it.
4. **A photo that isn't a booking** (a view, a meal) goes to the trip's photos, as photos do today. Photos are not listed in Files.
5. **The trip screen's list of every file by folder stays,** folded under "All files" below the Files section.
   - Notes, the trip's memory, the raw records and the box that adds a file by path are still reached there.
   - Files is the everyday list; All files is the full one.
6. **Pasted text that reads as a booking** is kept as a text file in the trip's Files. It can then be opened and asked about like a PDF.
7. **Dates the user typed by hand** can still be changed by Shiori, who says so (it follows "she does it, then tells me"). Undo covers it.
8. **A booking she can't place with confidence** goes into the open trip, or starts a trip if none is open, and she says what she was unsure of. She doesn't ask first.
9. **With no trip open, a booking that fits a trip that exists** opens that trip, as goal 4 does for one she starts, and she files it there.

## Left to the builder

- Shiori's tools for starting a trip, opening a trip, renaming it and changing its dates, and moving a file into a trip: their names, shapes and limits. They follow the spec's tool conventions (§7.2), and a model's words stay English.
- How the + reaches the agent loop: attachments on the user's message, the wake's shape, and where the files are written first.
- How the "night 2 of 3" lines and "Not on a day" are derived from bookings, and how the Plan orders them against plan items.
- The details screen's layout for each kind of booking and for plain plan items, within screen 3's pattern.
- What a file in the Files section says it "became", and how that link is kept, as data not words.
- The migration of existing trips: start/end optional, and old bookings without the new fields.
- Tests and their split between unit and e2e.

## Order

This builds on phone-fixes-1 once it is merged (Back from the original, Claude reading PDFs by default, the Language section), since both touch the dock, the router and the booking screen.

## Out of scope here

- The bug fixes from the same session (Claude's thinking blocks, model labels, the updates card, dragging on iPhone, Back navigation, the Language section). Those are batch phone-fixes-1.
- Traditional Chinese, a batch of its own.

## Done looks like

The user's evening, done again:
1. On the Trips screen, with no trip open, they tap + and pick the flight PDF and the hotel screenshot.
2. Shiori says she started "Anchorage · Nov 20–27", and the trip opens.
3. The Plan has the flight on Nov 20 with Seattle and Anchorage times, and the stay with its check-in, its nights and its check-out.
4. Tapping the flight shows its details and the PDF's first page.
5. Open the original shows the PDF, and Back returns to the details.
6. Nothing asked where a file goes.
7. Ask Shiori about this, with "the seat is 14D", fixes the seat.
