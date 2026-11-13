# Known limitations and deferrals

Each entry here was approved by the user. Reviewers read this file first and don't raise these again. Anything not listed here is still an open finding.

### A loud, jumping room sends one noise turn as a voice session opens
- **Kind:** known limitation.
- **What the user sees:** in a loud room whose noise jumps suddenly (about -45 to -40 dBFS, with steps of about 4 dB), about 1.5 s of room sound goes to the live model as a turn, 1.1 to 1.5 s after the microphone opens. Shiori may answer it with nothing. If Koe was about to say a reminder, it can be cut: in probes, 4 of 36 cases, against 2 of 36 before this change. The version before this change sends its own false turn in those rooms anyway, about 2 s later. In traffic, the first false turn is 0.9 s longer than before.
- **Why:** the detector learns the room only once it has heard it. A short word said the instant a new microphone stops giving zeros must be heard (the user asked for that), so sound over a guessed floor is held, and after a second it is judged against the room. A room that jumps looks like speech at that point. Three cheaper variants didn't fix it, and two of them lost the short words again.
- **Measured:** 2 of 27 synthetic changing rooms (`probe-live2` in the detector-floor review); the other 25 behave exactly as before.
- **Revisit when:** a phone test (device-checklist-phase2 L6, the car and loud-room step) shows it, or the detector is redesigned.
- **Approved:** 2026-10-23, the user: "Accept".

### A microphone that dips below -90 dB without exact zeros
- **Kind:** known limitation.
- **What the user sees:** with a microphone that dips its signal below -90 dBFS without giving exact zeros, for about 60 ms every half second, in a room of about -50 dBFS or louder, annai sends back-to-back 15-second noise turns while the microphone is open, and a sentence said inside them is swallowed.
- **Why:** such dips make a young floor a guess, and the first dipped frame (filter ringing, about -66 dB) counts as the room. No device is known to do this. The iPhone trace's gate gives exact zeros, which are handled, and the version before this change breaks the same way with such a gate from the start. A proper fix, treating a frame far under the run's own frames as a gate, is not cheap.
- **Revisit when:** a phone trace shows a device that gates this way.
- **Approved:** 2026-10-23, the user: "Accept".

### A non-English value quoted in a developer's English is read in an English voice
- **Kind:** known limitation.
- **What the user sees:** with a screen reader on Japanese or Chinese screens, a developer's English error (a broken plugin's manifest, skill or package check; a Simulate itinerary error) is read in an English voice. A non-English value it quotes, such as a manifest's `"language": "日本語"`, a Japanese stop name in an itinerary, or a zip entry's name, is read in that English voice too. Before the errors were marked, the whole sentence was read in a Japanese voice.
- **Why:** the mark covers annai's English sentence as a whole. Marking each quoted value with its own language needs every error that quotes a value to carry it as a separate part, which is more moving parts for a rare case on a developer's message.
- **Revisit when:** a screen-reader user reports it.
- **Approved:** 2026-10-27, the user: "Accept as known limitation".

### A page on an older annai refuses plugins that need plugin API 2 until it restarts
- **Kind:** known limitation.
- **What the user sees:** a page still running release 7f0dc027 or older, before it restarts into the new annai, can't add or update the official plugins that say `api: 2`: OpenRouter, Custom provider, Gemini, the four backup kinds, the three search providers and Remote trace. Tapping Update says "was made for plugin API 2; this version of annai supports API 1", keeps the version it has, and offers it again at the next check. Other updates apply, nothing retries on its own, and a restart into the new annai fixes it.
- **Why:** these plugins use `annai.l10n`, which pre-L7 annai doesn't give, so an older annai has to refuse them rather than start them broken. A 7f0dc027 page has `annai.l10n` but predates API 2, and its words can't be changed now.
- **Revisit when:** a user reports being stuck, which shouldn't happen once the page restarts.
- **Approved:** 2026-10-27, the user: "Accept as known limitation".

### A skill on a site that hides its 404s can't be installed if its SKILL.md links to a missing file
- **Kind:** known limitation.
- **What the user sees:** installing a skill from an address whose SKILL.md links to a file that isn't there, on a site that sends its browser-access (CORS) header only on success (nginx `add_header` without `always`), fails with "annai couldn't read <file> from <site>, a file its SKILL.md names…". An installed skill from such a site fails its update check the same way.
- **Why:** a linked file is left out only when the site answers that it isn't there (404, 410, or 403). No answer fails the install, so a network blip can't silently drop a file and then offer the skill as changed. A site that hides its 404s looks like no answer. GitHub raw, GitHub Pages, jsDelivr and Hugging Face send the header on 404s, and are fine.
- **Revisit when:** a user meets it on a site they can't change.
- **Approved:** 2026-10-27, the user: "Accept as known limitation".

### PDF pages draws at most a PDF's first 10 pages for a model
- **Kind:** known limitation.
- **What the user sees:** when no model here reads PDFs and the PDF pages plugin shows a PDF to a model that sees photos, only its first 10 pages go, at 1600 px on the longest side. The model is told how many were left out ("pages 1–10 of 23; the rest weren't sent"), so Shiori can say so. A model that reads PDFs itself still gets the whole file.
- **Why:** each page is a picture of about 1,600 tokens, and a booking's facts are on its first pages. More pages would cost more and take longer on the phone, for pages a booking rarely needs.
- **Revisit when:** a booking needs more than its first 10 pages.
- **Approved:** 2026-10-28, the user: "Accept".

### JPEG 2000 and JBIG2 pictures in a PDF may come out blank in PDF pages
- **Kind:** known limitation.
- **What the user sees:** a picture inside a PDF that is stored as JPEG 2000 or JBIG2 (some scanned documents) may be left blank on the page PDF pages draws. The page's text still draws.
- **Why:** PDF.js imports the decoders for those two formats from inside its worker. Where the worker's own requests don't reach annai's service worker, which serves the installed plugin's files, the decoders can't load (docs/deps.md).
- **Revisit when:** a booking PDF the user gets shows it.
- **Approved:** 2026-10-28, the user: "Accept".

### PDF pages is untested on iOS 16.4 to 17.3
- **Kind:** known limitation.
- **What the user sees:** nothing known. PDF.js 6 is built for Safari 17.4 and later; on older iPhones annai adds the one missing piece we found (`Promise.withResolvers`) and runs PDF.js on the page. Where PDF.js still can't run, the plugin says so in words ("This browser can't run PDF.js…") instead of crashing, and Safari's own first-page preview of a PDF still works.
- **Why:** there is no iOS 16.4–17.3 device or engine to test on.
- **Revisit when:** someone on an older iPhone reports it.
- **Approved:** 2026-10-28, the user: "Accept".

### Claude stops getting its earlier thinking for the rest of a turn after a rare mid-turn change
- **Kind:** known limitation.
- **What the user sees:** nothing on screen. A few rare things change part of a request after Claude has thought about it: a photo past the model's photo limit (the oldest becomes a stub), a refused photo replaced by a smaller copy, a heard line whose words are written down after it was sent, or Koe's window moving on in the middle of its turn. Claude would refuse its earlier thinking then, so annai sends none for the rest of that turn, and Claude plans each remaining step from what it can see, as it did before. The Trace counts it on the request.
- **Why:** making each of these append-only too means more code in several places, for something that happens a few times a trip at most.
- **Revisit when:** the Trace shows thinking stopped this way often.
- **Approved:** 2026-10-29, the user: "Accept (Recommended)".

### A very long turn stops carrying Claude's thinking once it has sent about 360 KB of it
- **Kind:** known limitation.
- **What the user sees:** nothing on screen. Once a turn's requests have carried 360 KB of Claude's earlier thinking in all (as in a long voice exchange with Shiori as one half), annai stops sending it for the rest of that turn, and Claude plans each remaining step from what it can see, as before. That is about 24 steps of light thinking (1.3 KB a step) or 12 of heavy (5 KB).
- **Why:** each step's request carries all the turn's earlier thinking, so the upload grows with the square of the steps: at 1.3 KB a step (measured in the real check, 2026-10-30), a 50-step turn would add about 1.6 MB. Counting what the turn has sent, not what one request carries, keeps the extra near 360 KB whatever size the steps are.
- **Revisit when:** the Trace shows long turns stopping their thinking often, or long turns lose quality the user notices.
- **Approved:** 2026-10-29, the user: "Stop past 64 KB (Recommended)". The question said the figure would be set again from the real check's measurements, to keep a turn's extra upload near 360 KB. 2026-10-30, the user: "Limit the upload (Recommended)": the limit counts the turn's extra upload itself, 360 KB, whatever size Claude's steps are.

### A repeated note can be said twice in live voice
- **Kind:** known limitation.
- **What the user sees:** with Koe on a live (realtime) model, if Kokoro sends a second note that repeats the first while Koe is already speaking, Koe may say it twice.
- **Why:** live audio can't be cut and rerun the way a typed call can (Classic Koe's call is cut and rerun with both notes). The only guard in live voice is Koe's instruction to skip a note she has already said, which a weak model can ignore.
- **Revisit when:** it happens on the user's phone with a live model.
- **Approved:** 2026-10-28, the user: "Accept as known limitation".

### A page on the old annai deletes official plugins' translations if it applies their updates before restarting
- **Kind:** known limitation.
- **What the user sees:** once, at the release that moved official plugins' translations out of their packages. A phone still running the old annai sees the plugins' new versions before it restarts. If the user taps Update before Restart, the old code installs each new package and deletes the translation it doesn't contain. Those plugins show English for the rest of that session. After the restart, the first plugin check downloads their words again (a few KB).
- **Why:** the old code already on phones can't change. Releasing the new code first and moving the translations a release later would cost every user two update rounds instead of one.
- **Revisit when:** never needed; it heals by itself at the next restart plus one check.
- **Approved:** 2026-10-28, the user: "Accept as known limitation".

### A photo brought back after the photo limit dropped it makes the provider's prompt cache miss once
- **Kind:** known limitation.
- **What the user sees:** nothing on screen. A model takes at most so many pictures per request (often 100; fewer after a provider refuses for count). In a conversation holding more photos than that, the oldest are left out with a stub. When Shiori re-reads one of them, or the user sends it again, it goes back where it first appeared. The request then changes from that early message, so that one turn pays full input price and processing time for the conversation before it. Nothing is lost or wrong.
- **Why:** avoiding it needs annai to remember what each previous request sent, per model: more moving parts for a rare, one-turn cost.
- **Revisit when:** long trips with many photos get slow or expensive after a re-read.
- **Approved:** 2026-10-28, the user: "Accept as known limitation".

### A booking's PDF shows a blank frame on Linux WebKit browsers
- **Kind:** known limitation.
- **What the user sees:** on a Linux browser built on WebKit (GNOME Web, and Playwright's WebKit), Open the original shows an empty frame where the PDF should be. Open and Download sit under it, and Download always gives the file. Chrome draws the PDF in the frame, and Safari on iPhone and Mac uses Apple's own viewer.
- **Why:** these browsers' PDF viewer is PDF.js running as a small page with inline script and style. A PDF shown from an object URL takes annai's security policy, which refuses inline script, so the viewer never starts. Serving the PDF from annai's offline worker under a looser policy would fix it, at the cost of one more moving part for very few users.
- **Revisit when:** an iPhone or Mac shows the frame blank too, or someone on GNOME Web asks.
- **Approved:** 2026-10-29, the user: "Known limitation (Recommended)".

### A Share without places can still name a place written in an unusual way
- **Kind:** known limitation.
- **What the user sees:** a Share with "Include where photos were taken and where you went" off carries nothing annai sensed (no GPS points, arrivals, conversation, watch files or photo places), and removes positions from the trip's text files (notes, memory, the recap; .md, .txt, .csv, .html) in every form annai itself writes (its position note, its maps links and its Wikipedia search) and in labelled, "near" and degree forms. Place names stay: the recap and notes still say where you went by name. A position written by hand in a rarer form can stay: degrees-minutes-seconds, a hemisphere before the number ("N 47.6, W 122.3"), two numbers with only a space between, a bare pair with two decimals, a pair split over two lines, a label inside quotes (`"lat": 47.6`, `data-lat="47.6"`), a position inside a JSON or calendar file Shiori wrote, any text file saved as UTF-16, a degree sign written in a Japanese or Chinese encoding other than UTF-8, or a position written straight after one of the rare four-byte characters of GB18030. It also removes some things that aren't positions: number pairs such as "near 12.50, 14.00 euros" or a European list "1.250, 3.500", and, in a Shift-JIS file, a half-width ｰ written right after a removed position.
- **Why:** free text has endless ways to write a position; a scrubber that caught all of them would also remove ordinary numbers.
- **Revisit when:** Shiori's place tools take "here" instead of numbers, so she never sees exact coordinates (fixing it at the source), or the user meets a form that slipped through.
- **Approved:** 2026-11-01, the user: "Common forms + limitation (Recommended)"; this exact wording, after the reviews: "Keep the wording (Recommended)".

### A deleted file that matches only an older version of another can't be deleted for good
- **Kind:** known limitation.
- **What the user sees:** Delete for good frees a deleted file together with its exact deleted copies. When a deleted file matches only an older version of another deleted file (a duplicate, then an updated file saved under the same name, all deleted), neither shows Delete for good: both stay under Deleted, restorable, until the trip is removed, which frees them.
- **Why:** freeing one would remove part of the other's history, which the user can still restore; telling the two apart safely needs more logic for a rare case.
- **Revisit when:** the user meets it.
- **Approved:** 2026-11-01, the user: "Yes, a limitation (Recommended)".

### Adding a flight leg to a booking saved before 2026-11-03 can split its legs
- **Kind:** known limitation.
- **What the user sees:** a flight booking Shiori saved before this update may keep its legs under an old top-level `flights` list. If she later appends a leg to it ("add the connecting flight"), the new leg goes under the booking's extra fields and the old ones stay where they were: the Plan keeps the flight's start, but its arrival may not move to the new last leg. Bookings saved from now on are not affected.
- **Why:** annai renames only what a save gives and never rewrites what is stored; moving old legs on an append would add a special case for old records only.
- **Revisit when:** the user meets it. Asking Shiori to rewrite the booking fixes it.
- **Approved:** 2026-11-03, the user: "Known limitation (Recommended)".

### Telling who is talking
- **Kind:** known limitation.
- **What the user sees:** annai can't tell one person from another. A passenger talking near the phone is treated as the user's speech, until Shiori's own judgement says otherwise. In live voice, annai tells a voice near the phone from music further away by how loud it is (the level check); classic voice has no level check.
- **Why:** telling voices apart would likely need a voice model downloaded to the phone, estimated at several MB and not researched: as much again as the whole app, or more (its JavaScript and CSS are about 3.2 MiB). The level check came first, and may be enough. No work on it is planned for the next version, so it is a limitation, not a deferral.
- **Revisit when:** a drive shows the level check and the gate aren't enough, or the user asks.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries. Before that, as a deferral: 2026-11-04, the user picked "Music check now, who later (Recommended)".

### A long slow traffic jam turns voice off
- **Kind:** known limitation.
- **What the user sees:** in a jam that never gets above about 7 mph, annai can't tell a crawl from a parked car. Voice goes off about 3 minutes in and comes back about 35 seconds after traffic clears. A tap on Shiori still talks, but a reminder meanwhile may arrive silently, and "moving fast starts" can fire again when it clears. Stop-and-go that reaches 7 mph isn't affected.
- **Why:** telling a crawl from walking away from a parked car needs more logic, and GPS speed alone can't always do it; holding voice longer would leave it on after really parking.
- **Revisit when:** it bothers the user on a commute; the drive log shows how often it happens.
- **With Voice set to On:** the jam also saves the setting as off, as a drive's end does, and the chip shows "Voice on · driving" when traffic clears.
- **Approved:** 2026-11-05, the user picked "Accept it for now (Recommended)".; the wider effect: 2026-11-05, the user ticked "Jam also saves Voice off".

### AirPods taken out with no mic open go unnoticed
- **Kind:** known limitation.
- **What the user sees:** voice turns itself off when a device disconnects only if the microphone is open on that device. Otherwise iOS may move her sound to the speaker with voice still on.
- **Why:** counting every device in the list gave false alarms, such as the phone's Receiver coming and going with the mic, or a watch going out of range.
- **Revisit when:** it happens to the user, or a device check shows what iOS reports.
- **Approved:** 2026-11-05, the user ticked "AirPods with no mic open".

### A refused mic with Live on says "Voice on" for a moment
- **Kind:** known limitation.
- **What the user sees:** with Voice off and Live on, a tap whose mic is refused shows a card that explains, but the chip says "Voice on" for up to 30 s until the session's quiet spell closes it. It fixes itself.
- **Why:** the hold lasts as long as the session does, and the card already says what happened.
- **Revisit when:** it confuses someone.
- **Approved:** 2026-11-05, the user ticked "Mic refused, Live on".

### A restored backup can fire a distance reminder once
- **Kind:** known limitation.
- **What the user sees:** restoring a backup onto a phone that has driven further can make a distance reminder that hasn't fired yet fire once on open, with too large a number. A reminder that already fired stays fired.
- **Why:** telling the two phones apart needs a device id on each reading. The user: "importing with an untriggered one may cause the reminder to trigger and that can be intentional so let it be I think."
- **Revisit when:** the user meets it.
- **Approved:** 2026-11-05, the user ticked "Restored backup, distance reminder", with that note.

### Detailed trace: gaps in what it keeps
- **Kind:** known limitation.
- **What the user sees:** clips wait in memory, so a reload or kill loses up to 16 MB waiting during no signal. A turn during a 3 s sample leaves a hole in that sample.
- **Why:** saving clips would store voices on the phone, and a hole in a sample doesn't harm tuning.
- **Revisit when:** clips are lost like this on a real drive.
- **Approved:** 2026-11-05, the user ticked "Heavier trace: gaps".

### Detailed trace: text in a box with its own scroll
- **Kind:** known limitation.
- **What the user sees:** with Detailed trace on, a screen copy also includes lines hidden inside a box that scrolls by itself, and text clipped by CSS. A sweep of 14 screens, with no trip data, found no private text in such boxes.
- **Why:** telling clipped text from visible text needs more logic for something off by default.
- **Revisit when:** private text turns up in such a box.
- **Approved:** 2026-11-05, the user ticked "Heavier trace: scrolled-box text".

### A rare wrong "moving fast starts" after annai is killed
- **Kind:** known limitation.
- **What the user sees:** after annai is killed on the road, stopping at a light and driving off 3 to 5 minutes later can fire one extra reminder, and so can a stop of over 60 s at the first reading after reopening, when annai takes that stop for the real one. Carrying on in someone else's car or on a flight can skip one.
- **Why:** with no fix while it was closed, annai can't tell these apart from the way speed alone.
- **Revisit when:** the drive log shows it happening.
- **Approved:** 2026-11-05, the user ticked "Rare wrong \"moving fast starts\"". The stop of over 60 s: 2026-11-06, the user picked "Accept, widen it (Recommended)".

### GPS that dies on the road reads as a stop
- **Kind:** known limitation.
- **What the user sees:** with GPS dead and annai open, moving fast holds for 5.5 minutes, then ends. Parked in a garage, a "when I stop" reminder comes on time. Still on the road with dead GPS, it's one false stop, and voice comes back at the next good reading.
- **Why:** silence can't tell a garage from a tunnel. Holding longer makes every true stop with no signal late; this is also the simpler code.
- **Revisit when:** a drive trace shows a false stop from dead GPS that the user minded.
- **Approved:** 2026-11-05, the user picked "Fire at 5.5 minutes (Recommended)".

### A stop right after reopening can fire "stops" early
- **Kind:** known limitation.
- **What the user sees:** annai was closed on the road and reopened on the road. A stop of over a minute right after that, such as a long light, can fire a one-time "when I stop" reminder, and voice is off at that point, so the reminder is shown, not spoken.
- **Why:** after a gap, annai fires the late "stops" once the first readings confirm a stop, so that a reminder missed by a closed app isn't lost. A long light reads the same as parking.
- **Revisit when:** a drive trace shows it. The user was told "a light of 30 to 60 s"; it now takes a stop of over 60 s, which is narrower than what they accepted.
- **Approved:** 2026-11-05, the user picked "Fire when you reopen (Recommended)".

### A voice-off is forgotten after a reload past the bound
- **Kind:** known limitation.
- **What the user sees:** voice turned off during a drive, then GPS gives out past the 5.5-minute bound, then the page reloads: voice-off is lost for this drive, and voice comes back on the road at the next good reading.
- **Why:** the drive has ended as far as annai can tell, and an ended drive holds no voice-off.
- **Revisit when:** it shows in a drive trace.
- **Approved:** 2026-11-05, the user accepted "Voice off forgotten".

### Voice comes back about 30 s late after a reload
- **Kind:** known limitation.
- **What the user sees:** after a reload past the bound, voice comes back about 30 s after the next good reading, not at it. "Moving fast starts" can also fire if that passes 5 minutes after the bound.
- **Why:** past the bound the drive has ended, so the road is a new start and takes the usual 30 s to settle.
- **Revisit when:** it shows in a drive trace.
- **Approved:** 2026-11-05, the user accepted "30 s late after reload".

### A false "starts" when GPS was dead over 5 minutes past the bound
- **Kind:** known limitation.
- **What the user sees:** still on the same drive, GPS dead for more than 5 minutes past the bound, then good readings: "moving fast starts" fires again, as if a new drive began.
- **Why:** over 5 minutes from the last evidence, annai can't tell the same drive from a new one.
- **Revisit when:** it shows in a drive trace.
- **Approved:** 2026-11-05, the user accepted "False "starts" after 5 min".

### A stop under a minute after a reopening reads as a light
- **Kind:** known limitation.
- **What the user sees:** the app was killed on the road, the user reopens it parked somewhere else and drives off within a minute, at about 2 to 14 km past the last reading an hour later. annai reads it all as one drive: no late "stops", no "starts", and a one-time "when I stop" reminder stays armed.
- **Why:** a stop under a minute looks exactly like a light. Reading it as a stop brings back a false "stops" and drive end at a 30 s light after a kill.
- **Revisit when:** it shows in a drive trace.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### A long lock reads as a stop at the unlock
- **Kind:** known limitation.
- **What the user sees:** the phone is locked for 5 minutes or more on a drive, then the user parks and unlocks it. annai treats the unlock as the moment they stopped: moving fast shows for 60 more seconds, voice stays on about 3 minutes, and driving off within 5 minutes gets no new "starts".
- **Why:** that's what a stop with the app on screen does, timed from the unlock. Dating it from before the lock fires a false drive end at a light after a lock.
- **Revisit when:** it bothers the user on a drive. Keeping when the wait ends separate from when the drive ended might do it; not tried.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### A light then readings with no speed can fire a false "stops"
- **Kind:** known limitation.
- **What the user sees:** on a drive with the app open, a light of about 37 to 44 s followed by a few GPS readings with no speed, while moving again, can fire one false "stops", and spend a one-time "when I stop" reminder early. About 1 in several hundred simulated city drives.
- **Why:** fixing it means more logic in the rule that has been hardest to get right, for a rare case that d1e93771 has too.
- **Revisit when:** it shows in a drive trace.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### Parking within 30 s of reopening says nothing
- **Kind:** known limitation.
- **What the user sees:** the app is killed on a drive and reopened while still moving on a stretch that looks slow in a straight line, then the user parks within 30 s. The real stop says nothing, and a one-time "when I stop" reminder waits until the end of the next drive.
- **Why:** in those 30 s annai can't tell a pull-in from a light, and reading it as a stop would likely fire a false "stops" at a light right after reopening.
- **Revisit when:** it shows in a drive trace.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### Voice off can carry into the next drive
- **Kind:** known limitation.
- **What the user sees:** voice is turned off on a drive, the drive ends silently, the page reloads within 30 seconds, and then no GPS reading comes for over 5 minutes with the page on screen, or annai is reopened several times under 5 minutes apart with no reading. On the next drive voice stays off until that drive's stop or a tap.
- **Why:** closing it needs a quiet timer that could read a tunnel as a stop, or a new stored field. It fails quiet, not loud.
- **Revisit when:** it shows in a drive trace.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### GPS noise right after a parked reopening reads as moving
- **Kind:** known limitation.
- **What the user sees:** in the first minute after reopening annai while parked, about 30 m or more of GPS noise across a quick app switch reads as the phone having moved. A true "moving fast starts" is lost, and a reminder set at the reopening fires while parked. A small step back from d1e93771.
- **Why:** the readings alone can't tell noise from real movement across a gap, and a stricter rule would trade this for late or missed stops.
- **Revisit when:** it shows in a drive trace.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### A "when I stop" set just after reopening can fire one stop late
- **Kind:** known limitation.
- **What the user sees:** a "when I stop" set in the first minute after reopening fires at the next real stop, not this one, if the car crawls with only 3 to 5 m/s readings, or loops back and parks within 0.5 m/s of the light it left. The reminder isn't used up. No worse than d1e93771.
- **Why:** a rule that catches a crawl risks false stops at lights.
- **Revisit when:** it shows in a drive trace.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### A false drive end at a light after a reload, with voice off
- **Kind:** known limitation.
- **What the user sees:** voice is off, a drive ends silently, then a light of 35 seconds or more, a reload of 200 seconds or more, and the first readings back are that light: annai tells a drive end while still on the road. About 1 in 2100 gaps in the fuzz test. Voice ends the same way as on d1e93771, and the saved voice mode doesn't change: a told end writes it only from `on`, and turning voice off has already written `off`.
- **Why:** those readings look the same as a real stop behind a gap.
- **Revisit when:** it shows in a drive trace.
- **Approved:** 2026-11-06, the user picked "Check it, then accept (Recommended)"; checked by reading `#driveEnded` in src/core/voice/voice.js.

### A turn stops when another conversation is tapped
- **Kind:** known limitation.
- **What the user sees:** tapping another conversation (a row on the timeline, or +) while Kokoro works stops her turn there. What comes of it depends on the turn. One the user started, or answered her in, that she was still working on: the conversation left says "Shiori was in the middle of something. She picks it up when you come back.", and she takes it up when they come back. One whose last step was talking to them (a line she was saying or had said, her question, a wait), or that waits on annai's card, whatever her reply holds after it: let go, with no line, and their next line there answers her. One annai started by itself (GPS turned on, a reminder or watch firing, a plugin's wake) that they didn't answer: let go too, and a reminder it hadn't yet given them shows at once as a Reminder card, said aloud if voice is on. Open on annai's card that takes them into another trip lets the turn that asked go: she answers them in that trip.
- **Why:** conversations don't run side by side, and `open` stops a turn. Only what the user asked is taken up again: their next line answers a question of hers, and annai's own turn would be stale by the time they come back.
- **Revisit when:** drives show it.
- **Approved:** 2026-11-05, the user picked "Stop until you come back (Recommended)". A turn annai started is let go: 2026-11-10, the user picked "No, let it go (Recommended)". A turn waiting on them is let go, with nothing said on return: 2026-11-10, the user picked "Nothing; I just answer (Recommended)".

### Only the trip in play reminds
- **Kind:** known limitation.
- **What the user sees:** with two trips happening at once, the other's itinerary and location reminders wait until the user talks in it, and anything whose moment passes meanwhile doesn't come later. Opening it isn't enough. Time watches fire for both, and copies already at the relay still push. A stop changed meanwhile loses its copy, and has no reminder until they talk in that trip.
- **Why:** one plan is followed at a time.
- **Revisit when:** someone misses one.
- **Approved:** 2026-11-05, the user picked "Only the one in play (Recommended)". The wider wording: 2026-11-06, the user picked "Yes, widen it (Recommended)". Until they talk in it, not until it's opened: 2026-11-06, the user picked "Talking moves it". A changed stop's copy goes: 2026-11-06, the user picked "Call it off (Recommended)".

### A turn cut by a failed open doesn't resume on its own
- **Kind:** known limitation.
- **What the user sees:** a conversation fails to open while Shiori is mid-turn on something the user asked. The turn stops, and the note says "She picks it up when you come back" though they never left. She answers with their next line, which carries both, and the microphone closes; a tap reopens it. A turn that was waiting on them, or that annai started by itself, is let go with no note, as at any open ("A turn stops when another conversation is tapped").
- **Why:** a restart there adds a wake when the store is probably failing anyway; the released copy cuts the turn the same way.
- **Revisit when:** a failed open shows up in real use.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### An answer to a reminder goes to the trip left open, and moves play there
- **Kind:** known limitation.
- **What the user sees:** two trips are happening, A is in play, and B was left open after a look. A's itinerary reminder is said, the user taps Shiori and answers. The line goes to B's conversation and moves play to B: A's itinerary and location reminders stop, and Driving shows B, until they talk in A.
- **Why:** annai can't tell an answer to A's reminder from a new line about B, and a timing rule for it would go into the hardest logic here.
- **Revisit when:** a user reports it, or overlapping trips get common.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### The language changes while a reminder waits at the relay for a trip not in play
- **Kind:** known limitation.
- **What the user sees:** two trips are happening, one is in play, and the other's reminder already waits at the relay. The screens' language changes. The reminder arrives in the old language, or mixed ("a leave soon" in the old one, a "coming up" with the old words and the minutes left in the new).
- **Why:** changing it means calling a good reminder off, or a trip not in play sending.
- **Revisit when:** anyone reports it.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### The trip is renamed while a reminder waits at the relay for it, and it is not in play
- **Kind:** known limitation.
- **What the user sees:** the notification's title shows the old trip name. The stop's words are right.
- **Why:** calling them off would lose every waiting reminder of that trip over a name.
- **Revisit when:** anyone reports it.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### A stop is added before a "leave soon" stop while its trip waits at the relay, not in play
- **Kind:** known limitation.
- **What the user sees:** the "leave soon" reminder keeps its old time and can come late. Its words are right. Talking in that trip corrects it.
- **Why:** a leave time is an estimate, a waiting reminder doesn't follow the GPS either, and calling it off loses a reminder for a stop nobody touched.
- **Revisit when:** anyone reports it.
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)".

### `item.says ??= hash` in the push mirror can go
- **Kind:** deferred.
- **What the user sees:** nothing. A copy sent before copies carried `says` takes the plan's digest at its first sync, once; the line that does it stays in the code.
- **Why:** a copy waits at the relay 29 days at most, so after 30 days from the release that added `says` no such copy is left.
- **Revisit when:** 30 days after this release ships: remove the line in `#wanted` and its adoption tests.

### An edit or a new reminder can miss the relay if annai closes right after a failed read
- **Kind:** known limitation.
- **What the user sees:** reads are failing, and annai is closed before the retry. An edit to a stop in any trip, the one in play too, can leave its old words at the relay, and they can arrive until annai next opens. A reminder just set may not reach the relay at all, so it doesn't arrive while annai is closed. One failed read of any trip stops the whole sync, which is why the trip in play and a new reminder are caught too. A locked phone may count as closed; that is traced in the code, not tried on a phone.
- **Why:** nothing runs while annai is closed, and calling off on doubt would lose good reminders to one failed read. It corrects itself when annai next opens.
- **Revisit when:** the Trace shows reads failing (an `error` entry of kind `read` in the device's log, under the Errors kind).
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)", for an edit in a trip that isn't in play. Widened: 2026-11-06, the user picked "Yes, widen it (Recommended)": it covers the trip in play too. Then, 2026-11-06, the user picked "Yes, widen it (Recommended)", told: "With reads failing and annai then closed, an edit in any trip can leave old words at the relay, and a reminder you've just set may not reach the relay at all, so it wouldn't arrive while annai is closed. A locked phone may count as closed; that's traced in the code, not tried on a phone."

### A stop deleted or changed just before reads fail can be said once from the old plan
- **Kind:** known limitation.
- **What the user sees:** a stop is deleted, or moved or changed, the reload and its retry both fail, and the stop's old moment comes while reads are still failing: its reminder is said once, at the old time and in the old words. It stops once reads work.
- **Why:** while reads are failing annai keeps the plan it has. Pausing the plan while behind would hold back every good reminder during any failure.
- **Revisit when:** the Trace shows it (an `error` entry of kind `read` in the device's log).
- **Approved:** 2026-11-06, the user picked "Accept for now (Recommended)", for a deleted stop. Widened: 2026-11-06, the user picked "Yes, widen it (Recommended)": a stop moved or changed, with its reload and retry failing, is said once at the old time, in the old words, if reads are still failing then.

### Live starts with GPS off when its settings can't be read at start
- **Kind:** known limitation.
- **What the user sees:** the phone's storage fails to read annai's settings at the moment Live starts, past the store's own retry: Live starts with GPS off for that page load, even if it was on, and runs as it does with GPS off. A reload, or turning GPS on, brings it back. Nothing writes the "off" back: the saved setting stays as it was.
- **Why:** a failed read says nothing of the setting. Before, the same failure left no Live at all for that page load; starting with GPS off keeps everything else running.
- **Revisit when:** the Trace shows it (an `error` entry of kind `read` in the device's log), or the user meets it.
- **Approved:** 2026-11-07, the user picked "Accept for now (Recommended)".

### A failed Trace line can wait forever after a fast simulation
- **Kind:** deferred.
- **What the user sees:** only in a "fast" simulation: a read fails past the retry, the Trace line's own write fails too, and the run ends. The line is never written, because its retry waits on the simulation's clock, which nothing advances after the run.
- **Why:** it needs a simulation and two failures at once, and the line is developer-facing.
- **Revisit when:** the next change to Live's Trace lines: set the retry on `this.#sim?.clock ?? this.clock`.

### Back shows Trips once more when a trip removed elsewhere had only Trips before it
- **Kind:** known limitation.
- **What the user sees:** annai opened on Trips, the user opened a trip, then came back to Trips, and the trip was removed somewhere other than its own screen (in a second annai tab, for example). Back on Trips passes the trip's entries and shows Trips once more, in place; the next Back leaves annai.
- **Why:** the first entry is Trips, and a page can't close itself or step back past its first entry, so the last Back has to land on something.
- **Revisit when:** browsers let a page leave its own first entry, or a user reports it.
- **Approved:** 2026-11-07, the user picked "Accept for now (Recommended)".

### A chat whose first sentence ends on a one- or two-letter word is named with the next sentence too
- **Kind:** known limitation.
- **What the user sees:** a chat is named from its first line's first sentence. A full stop after a word of one or two letters (Mt., St., Dr.) doesn't end it, so "Mt. Fuji on Tuesday. Then lunch" is named "Mt. Fuji on Tuesday." The cost: a first sentence that really ends on a short word ("We land in LA. Then…") runs on into the next one, and the name is cut at 40 characters as long names are. A word of three letters (Mrs.), and `?`, `!`, `。` and a new line, still end it. The user can rename the chat.
- **Why:** the browser's sentence breaker has no list of English abbreviations (it breaks after "Mt."), and a list of our own would need every language's abbreviations. The rule is one line in `chats.js`.
- **Revisit when:** a user finds a name that reads worse than before.
- **Approved:** 2026-11-08, the user chose "English rule" (a full stop after a word of one or two letters doesn't end the sentence).

### In landscape, an opened stack is read by scrolling inside a short box
- **Kind:** known limitation.
- **What the user sees:** on a phone turned on its side (740 x 360), Show on a stuck stack opens it in a box of about 152 px, half the room under the top bar. A card of 168 to 193 px doesn't show whole: its title and Dismiss show, and its middle scrolls under the Dismiss; while a card's top is in the lower part of the box, its own Dismiss covers its title for a moment. In portrait every card shows whole.
- **Why:** every stuck box on home is at most half the room under the bar, so the page never moves (the user's "Cap every box at half" and "Opens in place"); a short screen leaves a short box.
- **Revisit when:** the user's phone check finds it in the way, or a landscape layout for home is designed.
- **Approved:** 2026-11-09, the user chose "Known limitation".

### Details says "trip" on a chat, and Welcome and import say "the timeline" where the screen says "Trips"
- **Kind:** deferred.
- **What the user sees:** Details of a chat says "Remove trip", "Archive trip" and "This trip so far", though a chat isn't a trip (the spec's anti-goal: no "trip" on small chats). Welcome and the import screen say "the timeline" where the screen and the top bar say "Trips".
- **Why:** both are words on screens that change shape with the Start a trip form's going, so they change once, in every language.
- **Revisit when:** stage 8.

### read_trip reads a long text file only up to its result's cut
- **Kind:** deferred.
- **What the user sees:** Shiori reads a text file in another trip (a saved booking email, a long note) with read_trip and gets its first 40,000 characters, the limit on any tool's result (`RESULT_MAX`), told how many more were cut. She can't read on from there: an answer from the rest of the file, the end of a long email say, needs a move to that trip, where `read` has `from`.
- **Why:** read_trip's `path` gives a file whole, and the result's own cut is all that bounds it; `from` was left out of stage 5's tool (found in the build's review, finding 11).
- **Revisit when:** the next version: read_trip takes `from`, as `read` does.

### annai's card's question is answered by tap only
- **Kind:** known limitation.
- **What the user sees:** annai's card ("Read <trip>?", "Carry on in <trip>?") is answered by its buttons (Allow or Always for my trips, Open, Not now), in the car too. With voice on annai still says the question aloud; then the card waits for a tap, and nothing listens for a spoken yes. With one Shiori (no Koe model) the microphone stays closed after the question, so a "yes" said then isn't heard, and the card waits. Where a microphone does hear (Koe set up, whose microphone hears on; or a tap on Shiori, which opens her ordinary microphone for 8 seconds), a spoken "no" still declines, and any other line Shiori keeps, a "yes" included, ends the card unanswered ("Not read", "Not opened"): Shiori is told that the card is closed and that only a tap answers it; she says so and, when they meant yes, asks again with a new card (its buttons work; the closed card's go grey); Koe may answer the line ("Okay."). Nothing is read or opened by voice. Before 2026-11-13 a yes in the 20 seconds after the question said aloud answered the card (8 of 8 in live voice, 10 of 10 in classic voice, in real runs).
- **Why:** the plain case worked, but every part built to make the spoken yes work in one more case drew a wrong grant in its next review, and the last review found one more on the live code: with one Shiori, "Yes." and, within its 3 seconds, a reminder annai says itself; the reminder closed the microphone, the "No, wait" said after it wasn't heard, and the trip was read 2.8 seconds after the listening had ended (the review of 2026-11-13, probe C1). That tripped the user's stop rule. A tap can't be mistaken. The card's listening code stays in place, unused for a yes, until the user decides whether to remove it.
- **Revisit when:** the user asks for the spoken yes back.
- **Approved:** 2026-11-13, under the user's stop rule: "No more fix rounds on the spoken yes: turn it off (about 5 lines) and the card takes taps only."; and, with the pick "Remove the exception (Recommended)", "Stop rule stays: any further wrong grant switches the spoken yes off, no question asked."

### Where annai hears while she speaks, her own echo can end annai's card unanswered
- **Kind:** known limitation.
- **What the user sees:** on a route where annai listens while she speaks (a car's hands-free, headphones) and her voice comes back into the microphone late, her own words can be written down as a heard line; if Koe keeps that line, annai's card ends unanswered ("Not read") with nobody having spoken, and the user is asked again or taps. It never grants: across 9 real-speech runs on the test's car route, no echo alone granted a read, and 4 cards ended this way. Measured only on the test's own loop (her output fed back 6 dB quieter and 400 ms late); no real car, speakerphone or headphones were measured. The card that takes them into another trip ("Carry on in Kyoto?") hears the same way: her echo never opens a trip, and can end that card unanswered ("Not opened"), with nothing moved.
- **Why:** a line begun while she plays, or within 360 ms after (the half-duplex gate's own numbers: 300 ms echo tail plus 60 ms), counts as hers and neither arms nor ends the card; an echo 400 ms late outlasts that. The number was sized for a phone's own speaker. A longer tail would be a guess until a real car's hands-free and headphones are measured, and the miss fails safe: it ends the card unanswered, never grants, and the user is asked again or taps.
- **Revisit when:** a measurement of the loop on a real car's hands-free and on headphones; then size the tail from it (or end the card only on a line that wasn't begun inside the measured loop).
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### On the phone's speaker, a word begun just before her voice is talked over
- **Kind:** known limitation.
- **What the user sees:** in live voice where annai doesn't hear while she speaks (the phone's speaker, a route annai can't name, or headphones or the car with "Cut her off by speaking" off in Settings → Voice), a word the user begins less than about a quarter second before her voice starts doesn't cut her: she says her answer, or Kokoro's note, whole, and what they say over it isn't heard, as anything said over her isn't (going on past her end, it is let go until they pause). In a noisy room, a car's included, she starts at once, so all of that quarter second counts; in a quiet one she waits while the microphone hears someone begin, so only a word begun just as her wait runs out. Begun longer before her voice, it is their turn and cuts her, as before, with one case apart: when her sound runs dry mid-answer and her voice starts again within about a third of a second, talk begun in that gap is dropped as her voice begins, however long it has gone on, as talk begun over her is let go at her end. A tap always cuts her. Headphones and a car's hands-free, with "Cut her off by speaking" on, are unchanged.
- **Why:** a sound counts as speech once 250 ms of it is in (the detector's minimum: a click or a door has less), and a shorter one in that instant is as likely a bump: in drive 3 a bump begun 150 ms before her voice was taken for the user's turn, her voice stopped after 58 ms, and a note was heard without its first words (1 of 47 notes). The first instant of a word and a bump can't be told apart in less sound than that.
- **Revisit when:** a drive shows a word of the user's lost this way (the Trace has a `live.turn` line ending "dropped" for each run dropped as her voice begins, with how much speech it had; a sound begun about 50 ms or less before her first frame isn't held yet and leaves no line, so a missing line isn't proof that nothing happened; her own echo held in a hole of her stream leaves the same kind of line as a user's sound), or annai can tell a word's start from a bump in less than a quarter second.
- **Approved:** 2026-11-11, the user picked "Yes, as its own change (Recommended)".

### A tap on the card in the instant a line ends it is sent as a line
- **Kind:** known limitation.
- **What the user sees:** the user taps a button on annai's card ("Carry on in <trip>?" or "Read <trip>?") just after a line of theirs has already ended it: a line they typed, or, with Koe set up, a spoken line Koe kept, which ends the card unanswered 3 seconds after it was said. The tap arrives after the card has ended, so it is sent as an ordinary line of theirs: it is in the chat, and she may answer it or ask again. Nothing is lost and nothing moves. A double tap on the button itself isn't affected: the first tap ends the buttons.
- **Why:** the card's buttons end at a tap, or when the tool's result is written, and not when the card itself ends. The window is from the line ending the card until then (no files move after an unanswered card). Ending the buttons from the card itself is a change to the code both cards share.
- **Revisit when:** a phone test or a user shows it happening.
- **Approved:** 2026-11-11, the user picked "Accept it as a known limitation". 2026-11-12, for the revisit line, the user picked "Keep it; revisit on a sighting (Recommended)". 2026-11-13: its case of a tap as a spoken yes took effect went with the spoken yes (the user's stop rule; see "annai's card's question is answered by tap only").

### A reminder can be said while a microphone the user opened by a tap listens for annai's card
- **Kind:** known limitation.
- **What the user sees:** with one Shiori (no Koe model, or Koe unable to speak) and voice on, annai's card ("Read <trip>?", "Carry on in <trip>?") or a question of hers with buttons waits unanswered (the card once its question has been said; her question once its own listening is over). A reminder that comes due then is shown and said by annai itself. If the user has tapped Shiori to talk and that microphone is still open when the reminder comes due, annai says it over the open microphone: it can talk over what they were about to say, and if the phone hears her voice, the reminder's words are written down as a line of theirs: begun while she plays, they no longer end the card (since 2026-11-12 a line begun over her voice arms nothing), but they are passed on to Shiori as the user's words, and with phone dictation, whose words are timed by when they arrive, an echo whose words arrive after her voice stops can still end the card unanswered ("Not read"; she asks again or they tap). Nothing is granted by it. The reminders annai already says by itself (quiet hours, the hourly limit, another conversation's, offline) can be said into an open microphone the same way.
- **Why:** annai takes a reminder from behind a question once nothing listens for its answer by itself (a mark set once: when annai's card's question has been said, which since 2026-11-13 opens no listening; when the 8 seconds after her question end), and a tap on Shiori afterwards opens a microphone that hears for the card again. Holding the reminder while any microphone is open would bring back reading the microphone's state at the moment a reminder happens to arrive, which showed reminders silently in two earlier builds.
- **Revisit when:** a phone test shows annai's own voice written down as a heard line, or a user is talked over by a reminder.
- **Approved:** 2026-11-11, the user picked "Keep it; accept the gap (Recommended)".

### A line can still be said aloud when voice goes off in the instant before she starts it
- **Kind:** known limitation.
- **What the user sees:** voice goes off (the voice chip, a setting, headphones taken out) in the few milliseconds between Shiori deciding to say a line or a question aloud and her voice starting. The line is still said aloud, on the phone's speaker if the headphones just went; after it she doesn't listen, and the line is on the screen as always. Once her voice has started, voice going off stops it mid-word, as before.
- **Why:** whether a turn speaks is read once, when the line is written down, and not again as her voice begins. The window is a few milliseconds, and the line is on screen as always.
- **Revisit when:** it happens to the user; the fix then: the turn's voice is read again just before her voice begins, and the line is shown instead.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### With Koe busy, a no to annai's card can show before the line said before it
- **Kind:** known limitation.
- **What the user sees:** Koe is busy in a turn and holds an earlier line of the user's for its next one ("Hmm, let me think."); they then say "No." to annai's card. In the conversation the no shows before the earlier line. The card and both halves act as they should. (Until 2026-11-13 a spoken yes did the same; the card is answered by tap only since.)
- **Why:** the card writes a line down as it takes it; Koe writes a line it holds only when its turn takes it. Holding the card's line until Koe has written the ones before it would be a new wait between the halves.
- **Revisit when:** a user is confused by the order.
- **Approved:** 2026-11-11, the user picked "Known limitation (Recommended)".

### Undo leaves a twice-moved file in its last trip when the clock went back and the middle trip is gone
- **Kind:** known limitation.
- **What the user sees:** Shiori moved a file the user handed over from one trip to a second and later on to a third; the phone's clock was set back between those two moves; the user then removed the second trip by hand and tapped Undo on the hand-over. The file stays in the third trip and doesn't come back. Nothing is lost.
- **Why:** with the middle trip removed, Undo can link the two moves only by their times, and the clock made those wrong. Linking them surely needs a new stored field on every move, naming the move that brought the file in.
- **Revisit when:** moves get a stored link for another reason, or someone hits it.
- **Approved:** 2026-11-10, the user picked "Accept as known limitation (Recommended)".

### Remove's question names the backup for an empty chat too
- **Kind:** known limitation.
- **What the user sees:** Remove asks once. For a chat or trip that was never backed up, or changed since its last backup, the question also says "It hasn't been backed up since it last changed." An empty chat (a + never used, or one only named or dated in Details) gets that sentence too, though it holds nothing to lose.
- **Why:** that sentence is the only warning left in a one-question Remove, and a wrong "nothing to lose" would hide it; the cost of keeping it is one true sentence nobody needed.
- **Revisit when:** the user asks, or annai gets a sure test for an empty conversation for another reason.
- **Approved:** 2026-11-10, the user picked "Keep the sentence (Recommended)".

### Undo of a calendar's move goes file by file
- **Kind:** known limitation.
- **What the user sees:** Shiori moved a calendar to another trip, with the plan items made from its events, and the user taps Undo. If the page closes partway through Undo, the calendar can be back in the first trip while its events are still on the other trip's plan (or one event in each trip), and the other trip can remind for them. Undo is still offered, and a second tap finishes it.
- **Why:** the move itself is one transaction now, but Undo moves each file back along its own chain, one write at a time. Making Undo one transaction means reworking how it walks each file's moves (`src/core/handover.js`), for a page that closes partway through Undo, which a second tap finishes.
- **Revisit when:** it happens to the user; the fix then: the calendar's plan items move back with it.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### What follows a file's move is not part of the move
- **Kind:** known limitation.
- **What the user sees:** if the page closes right after a file's move, or a write fails right after it, the file is in the new trip but Shiori there has not been told to read it, and the first conversation has no "moved" line (Undo, in the first conversation, still brings the file back; it shows there once she has written a line after the hand-over, before the user's next message). For a calendar that was waiting to be filed, its events are not planned yet either. After Open on annai's card that takes them into another trip, the same can happen when the page closes, or a write fails, between the files moving and the "moved" line in the conversation they were in: that trip doesn't open, its files are there but the user's last line and Shiori's recap are not, and the conversation may have no "moved" line. Each file moves in a write of its own, so with several files a failure partway leaves some moved and some not.
- **Why:** those steps are written by Shiori's own code after the move has been committed; only each file's move is one transaction, and where the files went, the "moved" line and the trip's copy of the line and recap are writes after it. Putting all of a move's writes in one transaction is a large change, for a close or a failed write in the moment right after a move.
- **Revisit when:** it happens to the user; the fix then: a move's writes are one transaction.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### A page's end isn't kept when only the window's height changes
- **Kind:** known limitation.
- **What the user sees:** a page read to its end stays at its end when the phone is turned. When the window only gets shorter or taller (split screen, or a keyboard that resizes the window), the page stays where it was scrolled, which can be above its end; the user scrolls down again.
- **Why:** a browser tab's toolbar also changes the height as the user scrolls, and putting the page back then pinned it at its end against the user's own scroll. Only a change of width is surely a turn.
- **Revisit when:** the user meets it in split screen, or a way appears to tell a toolbar from a real resize.
- **Approved:** 2026-11-10, the user picked "Accept (Recommended)".

### A turn of the phone can put the page at its end when the user's last move wasn't a scroll the rule could read
- **Kind:** known limitation.
- **What the user sees:** the page moves to its end when the phone is turned, though the user wasn't reading its end. Three ways there: with a page scrolled to its end, something opens below with no scroll (Archived trips on home), then the phone turns, and the page goes past what just opened; in a browser tab, a short drag up from the end while the toolbar shows, then a turn with no other scroll; and possibly (not verified on a phone) a scroll with the iPhone's keyboard up, then a turn. A scroll in between prevents the first, and Shiori speaking or the dock changing no longer moves the page at all. The user scrolls back to where they were.
- **Why:** when the phone turns, the page is already at its new size, so whether the user was at its end can't be read then and is remembered from their last scroll. A fold opened since is not a scroll, and a scroll that arrives at a new window height before that height's resize is skipped as the browser's own. The fix changes a subtle rule about which scrolls count, and needs the WebKit turn test before it ships, for three rare sequences.
- **Revisit when:** the user meets it on the phone; the fix then: skip a scroll only while a turn's resize is still to come (the width differs), read every other one, and let the remembered fact follow the page's height, with the WebKit turn test before it ships.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries, and "Known limitation (Recommended)" for this entry, which replaces, for this case, the user's rule of 2026-11-06 that a screen jump no user would want is fixed rather than accepted as a limitation.

### Online, `nearby` rarely gets OpenStreetMap's places
- **Kind:** deferred.
- **What the user sees:** away from an offline pack, asking what is around often brings only Wikipedia's articles, with "OpenStreetMap didn't answer", after a wait of up to 25 s. In the recorded drives, none of three online calls got places: the main public Overpass server answered at 24.6 to 24.8 s, too late to be read under the 25 s limit, or not at all, and the second server never answered.
- **Why:** both public servers are now asked at once, which shortens the wait but not their answer time. The query asks for every kind of place within the radius in one request, and the 25 s limit (Overpass's own 20 s for the query plus 5 s to connect) is about what the servers take when busy.
- **Revisit when:** the next version: measure the request times from a phone (the Trace's `net.request` lines have them), then make the query lighter (fewer kinds per request, a smaller first radius), size its limits from those times, or add another source.

### An answer Shiori already gave can be said once more
- **Kind:** known limitation.
- **What the user sees:** Shiori says again something she has already told them, in two rare ways. With her two halves, Koe (who talks) asks Kokoro (who thinks) again something she has already answered, and the user opens another conversation in the moment before Kokoro is idle (usually a few milliseconds as her turn ends): on coming back, Kokoro takes Koe's question up and may give the old answer again, which Koe says. And when annai is reloaded or killed while she is speaking, the turn is taken up the next time that conversation opens, as before this release, and she may say that line again.
- **Why:** that Kokoro has already answered is written down only once she is idle, because that record settles everything before it; written sooner, it would also settle what she still owes (a line typed meanwhile, a turn the open cut). A record that names only the questions it settles would close the gap, as a new stored shape. After a kill annai can't tell what ran (a line cut in its playback, a call after it that never ran), and not taking the turn up would lose a second sentence, or a reminder she had just announced.
- **Revisit when:** the user hears an answer repeated after coming back to a conversation or after a reload, or what a conversation still owes comes to be recorded line by line for another reason.
- **Approved:** 2026-11-10, the user picked "Accept as known limitation".

### A conversation from before the update can get one unasked turn after Koe was emptied
- **Kind:** known limitation.
- **What the user sees:** they used annai with a model set for Koe, and have since emptied Koe. A conversation stored before this update whose last record is a note from Koe that Kokoro had left alone on purpose gets one turn nobody asked for the first time it is opened after the update, and she may repeat her last answer. Once per such conversation; after that it is settled. With Koe still set nothing changes, and conversations written since the update are not affected.
- **Why:** the app now writes a record when Kokoro leaves a note of Koe's alone on purpose, and Shiori as one reads a note without it as owed. Conversations stored before the update have no such record. Not owing them at all would also drop a question Koe passed on that Kokoro never reached.
- **Revisit when:** a user reports old conversations answering by themselves after the update.
- **Approved:** 2026-11-11, option picked: "Accept as a known limitation".

### A reload in the middle of annai's own turn is finished later
- **Kind:** known limitation.
- **What the user sees:** annai is closed or killed (the phone locks and the system ends the page, or a reload) while Shiori is in a turn annai started by itself (GPS turned on, a reminder or watch firing, a plugin's wake). The next time that conversation opens, she takes the turn up and finishes it, possibly hours later: a reaction to GPS that is stale by then, or a reminder she hadn't said yet, said late, by her, not shown as a card. Opening another conversation instead lets such a turn go at once, and shows its reminder as a card.
- **Why:** after a kill annai can't know what ran (a line cut in its playback, a call after it that never ran), so a reload takes every unfinished turn up. Letting annai's own turns go on a reload too would need the rule for what is owed to know from the log who started each turn and whether the user answered in it, the reminder's text stored with its wake, and an exception in opening: about 15 to 20 lines in the hardest logic, and a kill during the model call would still look like a wake kept for later.
- **Revisit when:** real use shows late answers after a reload that the user didn't want, or wakes come to keep their reminder text in the log for another reason.
- **Approved:** 2026-11-11, the user picked "Finish it; known limitation".

### Opening another conversation can drop the rest of her reply, or take up a turn already answered
- **Kind:** known limitation.
- **What the user sees:** two rare cases when the user opens another conversation while Shiori works on something they asked. In one reply she says something, runs a tool, and has more to say after it, and the open comes during the tool: the rest is never said, on coming back either, and no "picks it up" line shows (none of 320 requests in the real-model runs had a reply with two spoken lines). Or she has already answered, and the open comes while a later step of the same turn writes her notes: the conversation left says "Shiori was in the middle of something. She picks it up when you come back.", and on coming back she takes the turn up, an extra turn that may say her answer again. Both need a reply that ends in her sleep. One more shape of the same rule: she asks a question, the user answers it, and the same reply goes on to work and then sleeps: an open during that work drops the rest, and nothing is taken up.
- **Why:** whether a cut turn still owes the user is decided for her whole reply (did anything in it reach them, and was its last call the one waiting on them), not for each call in it. Deciding by each call changes the rule for what a cut turn owes, and needs a decision first (below), for two rare cases (none of 320 real-model requests had a reply with two spoken lines).
- **Revisit when:** the user hears a reply cut or repeated this way; the fix then: decide by each call: a cut call other than her sleep leaves the turn owed, and so does a cut hand-off between her halves. Taken by the call's name alone, that also takes up her notes written after an answer in the same reply (which isn't owed today), and still takes up the notes of a later step; telling those from the work after the user's answer needs the rule to know whether the user's words came after her last line to them, to be chosen first.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### A reminder set across a change of summer time can come an hour off what she said
- **Kind:** deferred.
- **What the user sees:** the user asks for a reminder on a date after the clocks change (in November, for March 19, say), and Shiori writes it with today's offset instead of that date's (-08:00 where March 19 is -07:00). Both her halves then say the time as written, "6 PM", and the reminder comes at 7 PM local time. Before this release Koe gave the time in the phone's zone, which showed the mistake, if confusingly. It needs the model to get the offset wrong; in the one real run of it, the model got it right.
- **Why:** both halves now read one set of words for a reminder's time, made from the offset she wrote, and nothing checks that offset against the zone's on that date.
- **Revisit when:** the next version: when the written offset doesn't match the conversation's zone at that moment, setting the reminder gives her the time in that zone too, so she sees her own mistake.

### Shiori on her own can't see what the user answered Koe
- **Kind:** known limitation.
- **What the user sees:** with her two halves, Koe asks something ("What can I do?") and the user answers aloud ("When is check-in?"); Koe passes it to Kokoro, and another conversation is opened while she works. Then the user empties Koe in Models, so Shiori is one again, and comes back: she takes the turn up, but their question isn't among what she reads, so she may not answer it, and they ask again. The same for a tap on Koe's card, or a line typed while Koe waits.
- **Why:** answers to Koe's own questions are kept with Koe's calls, which Shiori on her own doesn't read. It takes three rare steps in a row (an open while she works on their answer, emptying Koe in Models, coming back), and the fix changes what Shiori on her own reads.
- **Revisit when:** it happens to the user; the fix then: Shiori on her own reads Koe's notes and the user's answers to Koe, as Kokoro does.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### Kokoro's immediate note replaces the note she was saying
- **Kind:** known limitation.
- **What the user sees:** in live voice, Kokoro has told Shiori one thing, and before she has finished saying it (or begun to) Kokoro sends something urgent (an immediate note), which cuts her off. They hear the urgent line at once; the rest of the first, or all of it if she had not begun, is neither finished nor shown, and neither is any other note of Kokoro's still waiting to be said (a real run, 2026-11-12: a waiting plan note said after Kokoro's own correction gave the user the old time again). When Kokoro forgets to put into the urgent line something of the first that still mattered, that part is lost. (Only Kokoro's own note is replaced: a reminder of annai's that she was saying is shown on a silent card, as for annai's own urgent reminder.)
- **Why:** an immediate note is most often a correction of the very note she was saying (`tell_koe`'s description keeps it for "a wrong claim"), so a card for the first would most often show the claim being corrected. `tell_koe`'s description tells Kokoro that its immediate note cuts off any earlier note of its own that Koe has not finished saying, begun or not, so it puts in it whatever still matters. Kokoro never saw annai's reminder, so it could not carry that.
- **Revisit when:** a real run shows Kokoro sending immediate with a note in flight and leaving out something that mattered (the next real run checks the sentence, as it is model-facing).
- **Approved:** 2026-11-12, the user picked "Urgent replaces it (Recommended)"; widened to Kokoro's notes still waiting on 2026-11-12, the user picked "Accept it (Recommended)".

### An urgent correction sent before she starts the note it corrects can go unsaid
- **Kind:** known limitation.
- **What the user sees:** in live voice, Kokoro sends a note, and before Shiori has begun saying it, sends an urgent (immediate) correction. Sometimes she says only the first note's words, annai takes that line as her answer to the correction, and the correction is neither said nor shown: the user hears the first note, not what corrected it. Seen only when forced (3 of 6 sessions with a stand-in Kokoro sending the correction right behind the note, real Gemini, 2026-11-13; the same on the build before, 3 of 7); never with a real Kokoro (0 of 18 urgent corrections, each said).
- **Why:** the first note is already in the provider's hands when the correction comes, and annai can't tell which note a line of hers says (one input at a time). Fixing it means changing how live Koe hands the provider a correction while the first note is with it: not small, for a case not seen in use.
- **Revisit when:** it is seen with a real Kokoro, or on a drive.
- **Approved:** 2026-11-13, the user picked "Known limitation (Recommended)".

### Speaking in the quiet after "Checking your notes." shows the note, and she usually says it too
- **Kind:** known limitation.
- **What the user sees:** in live voice, Shiori says "Checking your notes." and looks something up before telling them Kokoro's note. If they speak in that pause, the note appears on a card as they start, and she usually still says it after answering them (12 of 13 times on real Gemini): they see it and hear it. It is never lost. The same holds when they type or tap a choice in that pause.
- **Why:** annai can't tell her continuation, which says the note, from her answer to what the user said, and a question of theirs can make Gemini drop the continuation; without the card the note would then be neither said nor shown (about 1 time in 13). The dock says "Thinking" in that pause, which should make speaking there rarer.
- **Revisit when:** a provider marks which input a reply answers, or a real run shows the double often enough to matter.
- **Approved:** 2026-11-12, the user picked "Card, and she says it too (Recommended)" for speaking in that pause, and "Same limitation" for typing or tapping a choice there.

### A continuation that comes after the ask once more can say the note twice
- **Kind:** known limitation.
- **What the user sees:** in live voice, Shiori says "Checking your notes.", looks something up, and then says nothing for 8 seconds after annai's answer; annai asks her once more for the note. If her late continuation comes after that, she may say the note in it and again in answer to the ask: heard twice. Not seen for real: her next sound came within 6.4 s of the last input in 123 of 123 real calls.
- **Why:** the 8 seconds is annai's bound on a continuation that never comes (2 of 124 real calls had none, and no turnComplete either); annai can't know a late one is still coming.
- **Revisit when:** a real run shows a continuation later than 8 s, or the bound comes down (the real run records the delay with nothing going in).
- **Approved:** 2026-11-12, the user picked "Known limitation (Recommended)".

### With Koe on OpenAI Realtime, the plugin's clock-based end can split her continuation into two lines
- **Kind:** known limitation.
- **What the user sees:** with Koe on OpenAI Realtime (no OpenAI key is in use, so nobody has run it for real), she says a few words and calls a tool she speaks after; annai answers at once, and her continuation's sound begins before the first response's words would have finished playing. The plugin ends the first response's turn by its playback clock (`complete`), which then lands inside the continuation and ends that turn early: her line is written in two parts. All of it is played, and the note is passed on.
- **Why:** OpenAI Realtime's server sends no turn end that follows playback, so the plugin times one; since annai ends the calling turn itself once it is all made and its call answered, that late end can only hit the next turn. No OpenAI key is in use, so neither the case nor a fix can be run for real, and nothing is lost: the line shows in two parts.
- **Revisit when:** before an OpenAI key is in use, at the latest; the fix then: a fix at source of about three lines in the plugin (a response's first sound ends the turn before it).
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### One note said across two of her turns, the second cut, is neither said whole nor shown
- **Kind:** known limitation.
- **What the user sees:** in live voice, Kokoro's note goes in and she answers it in two turns: a whole first line ("Sure."), then the note in a second. If the user speaks or taps in the second, or a drop cuts it, the note is neither heard whole nor shown: the first line already passed it on. Not seen for real: 0 of the 7 real continuations with nothing else going in were split in two.
- **Why:** annai can't tell which of her lines says a note; it takes the first whole line begun after the note went in. Keeping the note owed until her whole answer to it has ended needs a mark of which turn passed it, read by every cut path (the user's start, a tap, a line they send, an urgent reminder, a close, a drop): a new state of the kind this design removed, for a shape not measured.
- **Revisit when:** a real run shows split answers; the fix then: a note passed on by a whole line stays owed until her answer has ended (#idle finds nothing of hers going on), and a cut of a later turn of that answer shows it, a double rather than a loss (the main session's call, 2026-11-12).
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### A short plan item that crosses midnight stays on the Next line for up to half an hour after it ended
- **Kind:** known limitation.
- **What the user sees:** a plan item shorter than 30 minutes that starts on one day and ends on the next, in its own time zone (23:55 to 00:09, say), keeps showing on the conversation's "Next:" line after it is over: its start for up to 30 minutes after it began, then "Ends · <item>" until 30 minutes after its end. Then the line moves on or hides. Items within one day hide at their end. The same rows feed Now, Drive's strip and the timeline card's Next.
- **Why:** an item that ends on a later day than it starts is drawn as two rows, its start and its end, and a row with no end of its own lasts half an hour (the drive-test follow-ups design of 2026-11-02: "an end row is a row like any other").
- **Revisit when:** a user is misled by it; the change is for the start row to carry the item's end.
- **Approved:** 2026-11-11, the user picked "Accept as a known limitation".

### With Koe on OpenAI Realtime, after a Stop, a line said to live Koe can be refused when its words arrive after her call
- **Kind:** known limitation.
- **What the user sees:** in live voice on OpenAI Realtime, they press Stop, then say something to Shiori. If the provider sends Koe's call to Kokoro before it sends the words of what they said, the call is refused as if they hadn't spoken: she says she can't check that now, and they have to ask again. When the words come first, it goes through. On the test stand-in, words 6 seconds late are refused. Real Gemini Live never sends them in that order: in 121 turns where Koe called `tell_kokoro`, the user's words came 0.5 to 14 s before the call every time (2026-11-12), so with Gemini this doesn't happen. OpenAI Realtime's order isn't measured (no key in use).
- **Why:** a Stop's hold ends when a line of the user's is written, and a live line is written when its words arrive. Changing that for a provider whose order is unmeasured, while Gemini never needs it, adds a rule nothing has shown is needed.
- **Revisit when:** a real OpenAI Realtime run or a drive shows the call before the words; then either the heard line is written before a tool call even with no words yet, or a turn that a tool call answers counts as the user's line.
- **Approved:** 2026-11-12, the user picked "Limitation, OpenAI only (Recommended)".

### A reminder can be written into both conversations when a switch lands while the live session connects
- **Kind:** known limitation.
- **What the user sees:** in live voice, a reminder comes due while Koe's live session is still connecting (the moment after voice goes on, or the page comes back), and the user opens another conversation in that moment. The conversation left gets a silent copy of it; the conversation opened gets it shown and said aloud, once, as if it belonged to that trip, with one card on screen. Nothing is lost, but the reminder is filed in two places and is heard under the wrong trip. (Reproduced on the test stand-in with the connection held 100 ms; the same in the version before this one. With the page going out of view instead of a switch it shows once, from reading the code: the close doesn't hand a copy on, and the failed open's fallback shows it where it is.)
- **Why:** at the switch the session's copy of the wake goes to the conversation left, and the failed open's fallback then shows the original in the conversation opened; nothing tells the fallback that a close already handed its copy on. It needs a reminder due and a switch both in the moment the live session connects, nothing is lost, and the fix adds a mark on the reminder for the fallback to read.
- **Revisit when:** it happens to the user; the fix then: the fallback skips what a close already handed on (the session's copy of the wake keeps a reference to the original, the code that writes the unsaid notes marks that original as shown, and the fallback checks the mark before it reminds, as it does before it shows a note).
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### With two halves, Kokoro's words held in Koe's running turn may be lost, or said on coming back, when another conversation opens
- **Kind:** deferred.
- **What the user sees:** Koe on a chat model (classic voice, two halves). Kokoro's note with words for the user has reached Koe, Koe's next model call with it is running, and the user opens another conversation. A note with words for them is written nowhere: not in the conversation left, not in the one opened, and then either nothing shows when they come back (lost), or Koe takes the note up on coming back and says it (said on coming back). A card Kokoro made that Koe hadn't passed on is not shown in the conversation left either; coming back, Koe takes it up again and says it. Start fresh does not lose them: it shows them above its divider. (Reproduced on the test stand-in; the same in the version before this one. Which of the two happens depends on timing: the words were lost in a run under light load, and in the second review's 5 of 5 runs under load, at each of six builds of this version (9e016446, 84269f45, f165f2e2, 050eab4d, f22180ef, c3d637b3), Koe took them up and said them on coming back.)
- **Why:** a turn that opening another conversation cuts skips both the path that shows what a turn never passed on and the one that writes what a switch leaves unsaid; opening a conversation doesn't hand Koe's owed notes to the code that shows them in the conversation left, as Start fresh does.
- **Revisit when:** the next version: opening hands Koe's owed notes to that code before Kokoro's conversation moves, as Start fresh does. Decide first what Koe does on coming back: its log still holds the note as unread, so it may also take it up then, and the user would get it shown and said.

### One Shiori's wait tool holds a reminder for as long as it waits
- **Kind:** deferred.
- **What the user sees:** with one Shiori (no Koe model), or Kokoro while Koe is down, a reminder comes due while her wait tool waits for the user: with voice off for typing, with voice on listening, for the seconds she asked, at most 600. The reminder's card and voice come only when the wait ends, up to 10 minutes late. The same reminder behind annai's card is shown once the card's question has been said (at once with voice off), and behind her own question when its listening ends. Koe's own wait on a chat model ends for it, and Koe says it at once (2026-11-12).
- **Why:** only Koe's wait tool ends for a reminder (a chat Koe's, `#cameDue`). One Shiori's wait has nothing for annai to take a reminder from behind (no mark that only a tap or typing answers), and a reminder that ended it would need words of its own for her model.
- **Revisit when:** the next version (what may be said while annai's card listens was settled on 2026-11-12, and a reminder now ends a chat Koe's wait): a reminder ends one Shiori's wait (and Kokoro's, with Koe down), with words of its own, which needs a lessons entry; or a voice-off wait is marked as waiting for a tap, so annai shows the reminder at once, which covers voice off only.

### A Stop as the microphone opens for the listening after her line leaves that listening open
- **Kind:** deferred.
- **What the user sees:** Shiori has just said a line, and the microphone is opening for the listening she does after it (20 seconds by default); the user presses Stop in that moment. Her turn stops, but the dock says "Listening" and the microphone stays open until that listening's silence limit; a tap closes it, and what they say into it starts a turn that is answered. Nothing is lost, but it looks as if the Stop did not take. (Reproduced on the test stand-in with one Shiori; not reproduced with her two halves. The version before this one did the same.)
- **Why:** the listening after her line is opened as the turn ends, from what the turn did (she spoke aloud and did not sleep), and a Stop in that moment is not among what it looks at.
- **Revisit when:** the next version: the listening after her line is not opened when the user stopped the turn (`listens` in `#afterTurn`, `src/core/agent/loop.js`, false when `#userStop`). It changes what a Stop does, so it needs the user's OK first.

### Live Koe's tool calls in flight when another conversation opens are written into the conversation opened
- **Kind:** known limitation.
- **What the user sees:** in live voice, one of Koe's tool calls is still running (or its first write is waiting behind the other conversation's opening) when the user opens another conversation. The call is written in the conversation left, but its result lands in the conversation opened, as a result with no call, and the conversation left keeps a call with no result. When the call is Koe's `tell_kokoro`, the note itself lands in the conversation opened and wakes Kokoro there, which answers a question about the trip left, in the trip opened. Koe's spoken and heard lines are not affected: they are written where she spoke. (Reproduced on the test stand-in with a tool held while the switch ran; the version before this one did the same.)
- **Why:** a call's writes (`tool.call`, `tool.result`, and the note through the channel) go into whichever conversation is open when they are written, and the switch changes it meanwhile; the note's delivery wakes Kokoro in the open conversation. Binding the writes to the session's conversation, as her lines are, is a small change (pass it from the session's call through `liveCall` into `#runCall`), but it leaves what the note for a conversation no longer open should do (not wake Kokoro there; be kept for when the user comes back, or dropped), and a call that starts after the switch, which runs against the conversation opened. Those are decisions, not a pass-through, for a switch while one of Koe's calls runs.
- **Revisit when:** it happens to the user; the fix then: the session's conversation is bound to its calls' writes, after deciding what a note to Kokoro for a conversation that is no longer open does, and what a call that starts after the switch does.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### A live session taking the microphone while someone speaks into a tap's listening for her question leaves it marked listening
- **Kind:** known limitation.
- **What the user sees:** voice is off, her question shows its buttons, the user taps Shiori and begins to speak into phone dictation, and then a live session takes the microphone (Koe's live voice opening) before they finish. The dock keeps saying "Hearing you" (still so 30 seconds later on the test stand-in) and Kokoro's notes for the user are held behind the question until the user taps a button or types. With nothing said yet, or with recording instead of phone dictation, the listening ends as it should, at its 8 seconds or with the line. (Reproduced on the test stand-in by handing the microphone over directly; that a live session opens in those 8 seconds, with someone speaking, is not confirmed. The version before this one did the same.)
- **Why:** speech holds the listening's silence limit, and dictation closed under it ends with no end of that speech and no words, so nothing starts the limit again. `#voiceChanged` handles the same case (it starts the limit again, closes the listening and lets the note rule look again), and `Agent.release()`, which a live session's opening calls on both halves, doesn't. That this order can happen is not confirmed, and the fix touches every live listening start.
- **Revisit when:** it is seen, or the next change to how a closed microphone ends a listening; the fix then: one helper for "the microphone closed under a listening" (listening off, the limit started again, the dock's waiting words, `#noted`), used by `#voiceChanged` and `release()`, and by `#earFailed` for the entry below. It needs tests of its own, because `release()` runs at every live listening start (`src/core/koe/live.js`).
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### A microphone failure during a tapped question ends the question, though it still stands
- **Kind:** known limitation.
- **What the user sees:** voice is off, her question shows its buttons, the user taps Shiori, and the microphone stops (another app takes it: a phone call, dictation failing). A "Listening stopped" card says why, but the question's buttons end and the model is told "annai couldn't listen: … The user may type.", and the question is over, though the user has not answered it; they can type their answer. (From reading the code and the review's probes. The version before this one closed the question too, and wrote an empty line of the user's and told the model "The user wrote: undefined".) Her question said aloud does the same in the by-hand phase after its 8 seconds.
- **Why:** `#earFailed` resolves a pending that is marked listening with the failure, whatever it was waiting for, and a question that waits by hand is also marked listening for as long as a tap's microphone is open. It is rare (another app taking the microphone while the user answers her question by a tap), the card says why, and the fix is best made with the helper of the entry above.
- **Revisit when:** it happens to the user; the fix then: `#earFailed` leaves a question that waits by hand (`byHand`) waiting, as `#voiceChanged` does (the listening ends, the dock says it waits, `#noted` looks again), and gives the failure as the result only to a listening that has no other way to be answered.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### The tap's own window, with no turn running, starts its 8 seconds again on every noise
- **Kind:** known limitation.
- **What the user sees:** the user taps Shiori while she is idle (with voice off, the tap holds voice on and opens the same window); in a noisy room a short sound (a click, a cough, a door) at least every 8 seconds keeps the microphone open and the dock saying "Listening", where a quiet room closes it after 8 seconds. Nothing is held behind it, because no turn is running: the cost is a microphone open for longer. (From reading the code, `#speechStopped` then `#armQuiet`; the version before this one did the same.)
- **Why:** `#armQuiet` counts the 8 seconds from the last noise. A tap's listening for her question now counts them from the tap (`#limitTap`), as her question aloud (`#listenFor`) does, and noise neither ends it nor restarts it. The tap's own window fails open, not wrong: nothing waits behind it, and the dock says "Listening" while the microphone is open. The fix adds a deadline to `#armQuiet`, which every tap to talk goes through.
- **Revisit when:** a drive shows the dock stuck on "Listening" after a tap; the fix then: `#armQuiet` keeps a deadline from the tap, so every tap's listening follows one rule.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### A second tap while a tap's microphone is opening, with her question waiting, closes the microphone and nothing listens
- **Kind:** known limitation.
- **What the user sees:** voice is on and her question waits for a tap or typing (its 8 seconds of listening are over). The user taps Shiori twice within the moment the microphone takes to open. The microphone opens and closes at once, nothing listens, and the dock says "Waiting for your OK" throughout; a third tap listens. (Reproduced on the test stand-in: two taps in a row, the microphone's log shows it open and closed with nothing said. With nothing waiting, the dock says "One moment…" while the microphone opens, and there the second tap is meant to stop it. The lines involved are unchanged by this version.) (Reproduced again on this version's stand-in, 2026-11-12.) With voice off it doesn't happen: a second tap while the first is still starting is let go, and the first's microphone listens.
- **Why:** `#tapListen` closes the microphone it opened when a later tap has taken its place. While her turn is busy the dock doesn't say "One moment…", so a second tap in that moment reads as a wish to listen, and acts as a stop. Nothing is wrong or lost: the dock says "Waiting for your OK", not that it listens, and a third tap listens.
- **Revisit when:** it happens to the user; the fix then: a tap that finds a tap's microphone already opening, with her turn busy, keeps that microphone and starts its limit, instead of closing it (`#tapListen`, `src/core/agent/loop.js`).
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### A connection that drops for good while she says a note shows the note and lets her say it too
- **Kind:** known limitation.
- **What the user sees:** in live voice, the session closes for good (a refused key, a model not found, or a fourth drop with no reply between) while she is saying a reply that carries a note, after it is all made and played past her last loud sound. annai hands the note on (a card, or Koe · Chat saying it) and the reply's audio says it too: heard and shown twice. Rare. (From reading the code, the second opinion of 2026-11-12's final review; the version before this one did the same in that order.)
- **Why:** the drop cuts the reply and closes the session before the reply's own end has run, so the note is handed on first; the reply's end then finds it gone and passes nothing. A double is the safe side: deciding that a cut reply was heard whole risks losing the note instead.
- **Revisit when:** the doubles bother the user; the fix then: a close for good passes the notes of a turn that counts as heard whole before it hands the rest on, as a tap and a page going out of view already do.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### A note she says she already told is shown on a card too
- **Kind:** known limitation.
- **What the user sees:** in live voice, or with Koe on a chat model, Kokoro's note says something Shiori has already told them, and she rightly answers it with nothing but her `already_told` (or the session was made again in that turn, and the note went in again): annai shows the note on a silent card, so they see what they heard. It is never said again by annai. Not seen as a repeat for real; the case that made it: with three notes at once, she told the first, then called `already_told` for the second, which she had not said, and it was lost (1 of 63 notes, 2026-11-12).
- **Why:** her word that the user has it doesn't say which note she means, and annai can't tell: a card too many costs the user a glance, a note lost costs them what Kokoro found. (A note she had said nothing about and called already_told for is what the version before lost.)
- **Revisit when:** the cards for told notes bother the user, or a provider marks which note a reply answers.
- **Approved:** 2026-11-12, the user picked "Show it silently (Recommended)".

### A note she answers with an instruction word is asked for once more, after the user heard the word
- **Kind:** known limitation.
- **What the user sees:** in live voice, Gemini sometimes says one of annai's own words to it aloud as its whole answer to a note ("silent" was seen: 1 in 63 notes, 2026-11-12). The user hears the word; annai takes the line as no answer, asks her once more, and she says the note (up to 8 seconds later). If she answers the ask the same way, annai shows the note and says it in its own voice. The same holds for a whole line that is only a bracketed stage direction such as "(No speech)" (1 of 563 real lines).
- **Why:** a word spoken can't be taken back, and what counts is what she said: annai catches only a whole line that is exactly one of its own words to her (the tools she calls without speaking, and `silent`), a strict match, so a sentence that holds one is an answer. The list is built from what annai's instructions and tool answers tell her.
- **Revisit when:** a real run shows another stray word as her whole line, which then joins the list.
- **Approved:** 2026-11-12, the user picked "Count it as no answer (Recommended)"; bracketed stage directions added on 2026-11-12, the user picked "Keep it (Recommended)".

### After a tap, the next note waits 4 to 8 seconds, not about 2
- **Kind:** known limitation.
- **What the user sees:** in live voice, the user taps to stop her, and Kokoro's next note comes 0.5 seconds later. It is said 4 to 8 seconds after the tap, not at the 2 seconds the hold is meant to give (23 of 23 such runs, real Gemini, 2026-11-12). If the user speaks first, it comes 1.5 to 3.4 seconds after they finish, after her answer to them. Nothing is lost: all 23 were said once.
- **Why:** the provider keeps making the reply the tap stopped, with no one hearing it, for about 7 seconds (median 7.2 s), and annai holds the note until that reply ends, so that one input is in flight at a time. Ending it at the tap means closing the live session and opening a new one at every tap.
- **Revisit when:** the wait bothers the user on a drive.
- **Approved:** 2026-11-12, the user picked "Known limitation (Recommended)".

### With Koe on a chat model, a note can be lost when Koe says one note and calls already_told for another
- **Kind:** known limitation.
- **What the user sees:** Kokoro has sent two notes for the user in one turn of Koe's, and Koe says the first, then calls `already_told` for the second, which it did not say. The second is lost: no card, not said. Traced in the code, never seen in a run.
- **Why:** the chat Koe takes all its notes in one call, and `settle()` (`loop.js`) settles every note of the turn as soon as Koe has reached the user at all, so the `already_told` finds nothing left to show. Changing that changes how the chat Koe takes its notes.
- **Revisit when:** it is seen in a real run or on a drive.
- **Approved:** 2026-11-12, the user picked "Known limitation (Recommended)".

### Live Koe's whole reply to a typed line that is only one of annai's instruction words makes the user type it again
- **Kind:** known limitation.
- **What the user sees:** in live voice, the user types a line and Koe's whole reply is one of annai's own words to it ("silent", say) or a bracketed stage direction ("(No speech)"). annai takes that as her answer, does not send the line again, and the user has no answer to it: they type it again. Not seen: 0 of 563 real lines.
- **Why:** the rule that such a line is no answer covers Kokoro's notes; extending it to the user's typed lines touches the other wait path (the 8-second wait for an answer to a text turn).
- **Revisit when:** it is seen in a real run.
- **Approved:** 2026-11-12, the user picked "Known limitation (Recommended)".
