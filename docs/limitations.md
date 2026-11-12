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
- **Kind:** deferred.
- **What the user sees:** annai can tell a voice near the phone from music further away by how loud it is, but not one person from another. A passenger talking near the phone is treated as the user's speech, until Shiori's own judgement says otherwise.
- **Why:** telling voices apart would likely need a voice model downloaded to the phone, estimated at several MB and not researched, in an app that ships under 3 MB. The level check comes first, and may be enough.
- **Revisit when:** a drive shows the level check and the gate aren't enough, or the user asks.
- **Approved:** 2026-11-04, the user picked "Music check now, who later (Recommended)".

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

### The sleep note's "let go" path has no test
- **Kind:** deferred.
- **What the user sees:** nothing today. If that line broke, a dismissed verdict would lose Kokoro's sleep note, and where a held microphone run keeps the session open, music would keep a live session open and billing.
- **Why:** the path needs a verdict that lands with nothing going and nothing due while the detector's held run stops the quiet close. On every route tried the session closes in the same tick, so the right code and a mutant behave the same, and a click 0.1 to 0.5 s after the last turn didn't hold it open. The line's comment says what it must do.
- **Revisit when:** the sleep note's code next changes, or the test kit can hold `input.hearing` itself.

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

### A spoken yes to annai's card is heard late when no model listed can write speech down
- **Kind:** deferred.
- **What the user sees:** in one setup (Koe on a chat model that takes sound, Kokoro on a model that takes no audio, and no transcription model in the speech-in list, with the question typed), a "Yes" said to annai's card gets its words only when Koe's own turn ends: of 7 real-speech runs, 5 were granted 16 to 49 seconds after the word, 1 ended unanswered, and 1 was still waiting after 45 seconds. A tap on the card works at once. With a transcription model listed (for example either of Gemini's), the yes is granted about 4 seconds after the word, as elsewhere. The card that takes them into another trip ("Carry on in Kyoto?") hears its yes the same way, so that trip opens 16 to 49 seconds after the yes: from a conversation or Trips the screen changes long after the user's word, perhaps while they are looking at something else. Typing meanwhile ends the card instead. In this setup Koe also gets the yes, as a line of its own, and may answer it: with no words yet when it is heard, the card can't tell it is a yes.
- **Why:** the card's line is written down once, through the speech-in list for Kokoro's own model; with nothing there that takes the sound, only Koe's model can, and it writes a line down when its turn ends. Asking Koe's model for every such line was tried (2026-11-10) and taken back out: it made the usual setup's yes slower (4.1 s to 9.5 s), wrote lines down twice, and a slow write-down rested Koe's only model.
- **Revisit when:** the next version: the speech-in list first, and Koe · Chat's model only as the fallback when nothing listed can write the line down; the regression test "written down once, by the transcription model" stays as it is.

### Where annai hears while she speaks, her own echo can end annai's card unanswered
- **Kind:** deferred.
- **What the user sees:** on a route where annai listens while she speaks (a car's hands-free, headphones) and her voice comes back into the microphone late, her own words can be written down as a heard line; if Koe keeps that line, annai's card ends unanswered ("Not read") with nobody having spoken, and the user is asked again or taps. It never grants: across 9 real-speech runs on the test's car route, no echo alone granted a read, and 4 cards ended this way. Measured only on the test's own loop (her output fed back 6 dB quieter and 400 ms late); no real car, speakerphone or headphones were measured. The card that takes them into another trip ("Carry on in Kyoto?") hears the same way: her echo never opens a trip, and can end that card unanswered ("Not opened"), with nothing moved.
- **Why:** a line begun while she plays, or within 360 ms after (the half-duplex gate's own numbers: 300 ms echo tail plus 60 ms), counts as hers and neither arms nor ends the card; an echo 400 ms late outlasts that. The number was sized for a phone's own speaker.
- **Revisit when:** the next version: measure the loop on a real car's hands-free and on headphones, then size the tail from it (or end the card only on a line that wasn't begun inside the measured loop).

### Classic voice: a take-back said just after the 20 seconds isn't heard
- **Kind:** deferred.
- **What the user sees:** in classic voice (no live session), the microphone that listens for an answer to annai's card closes 20 seconds after the question. A "Yes" said in the last 3 of those seconds is still settling when it closes, so a "No, wait" said right after isn't recorded, and the trip is read. On the card that takes them into another trip ("Carry on in Kyoto?") that trip opens instead, despite the "No, wait": the files, lines and moves listed under "Someone else's "yes" within the 20 seconds answers annai's card", which Back doesn't undo. Live voice and a chat Koe keep hearing after the 20 seconds. Found by the final review (2026-11-10, run with the loop's clock); it needs a yes at the window's very end and a take-back within 3 seconds of it.
- **Why:** the window's end closes the microphone at once, whether or not a yes is waiting; keeping it open until the yes settles would also hear a second "Yes" said after the window, which is outside it and would then drop the first: what that one should do has to be decided first.
- **Revisit when:** the next version: the microphone stays open while a yes settles, and a line begun after the window can only take a yes back, never give one.
- **Approved:** for the card that moves them, until that fix: 2026-11-11, the user picked "Keep it, accept the misses".

### A rising "Yes?" is heard as a yes by annai's card
- **Kind:** known limitation.
- **What the user sees:** annai asks aloud "Read <trip>?"; the user answers with a questioning "Yes?" (as in "pardon?"), and the card takes it as a yes: Shiori reads that trip. Both Gemini Live and the speech-to-text server write a rising "Yes?" as "Yes." (0 of 8 written lines kept a question mark in the real-voice check, 2026-11-10; only "What?" kept it, and only in Gemini). Whatever the user says next within 3 seconds still takes the yes back, and a tap on Not now wins at any time. The read is of the user's own trip, and reading changes nothing. On the card that takes them into another trip ("Carry on in Kyoto?") the same "Yes?" opens that trip 3 seconds after its words unless anything is said meanwhile: the files, lines and moves listed under "Someone else's "yes" within the 20 seconds answers annai's card", which Back doesn't undo.
- **Why:** the card judges the words as the recogniser writes them, by annai's own word list; the tone is not in the text. A stricter rule (two words, or a tap for the first read) would cost every spoken yes.
- **Revisit when:** a recogniser annai uses marks questions in what it writes, or the user asks for a stricter spoken yes.
- **Approved:** 2026-11-10, the user picked "Accept as known limitation (Recommended)". For the card that moves them: 2026-11-11, the user picked "Keep it, accept the misses".

### Live voice: words that arrive after the next sentence has begun are taken as part of it
- **Kind:** known limitation.
- **What the user sees:** in live voice only, and only when the provider is late twice: the user says "Yes." to annai's card and then takes it back; if the words of the "Yes." reach annai after the take-back's turn has begun, they are written onto that turn's line, and if the take-back's own words then come more than 3 seconds after it ended, the trip is read. On the card that takes them into another trip ("Carry on in Kyoto?") the taken-back yes opens that trip instead: the files, lines and moves listed under "Someone else's "yes" within the 20 seconds answers annai's card", which Back doesn't undo. Not seen in about 500 real-speech runs (2026-11-10); found by reading the code. In the same way a late "Yes." can be lost (joined to the next line's words, or counted as outside the 20 seconds).
- **Why:** Gemini Live sends a turn's transcript as text with no mark of which turn it belongs to, so annai appends it to the turn going on; there is no way to tell on annai's side.
- **Revisit when:** the provider says which turn a transcript belongs to (Gemini's `finished` flag on transcripts isn't read yet: measure whether it settles this), or another live provider is added.
- **Approved:** 2026-11-10, the user picked "Accept as known limitation (Recommended)". For the card that moves them: 2026-11-11, the user picked "Keep it, accept the misses".

### A yes said while annai is still asking isn't heard
- **Kind:** known limitation.
- **What the user sees:** annai says "Read <trip>?" aloud; a "Yes" begun before she has finished the question doesn't answer the card, on headphones too. The card stays, and a yes said after the question, or a tap, answers it. (3 of 3 runs each on the speaker and the headphones route in the real-voice check, 2026-11-10.) The same on the card that takes them into another trip ("Carry on in Kyoto?"): it stays, and nothing moves until a yes after the question or a tap.
- **Why:** the 20 seconds for a spoken answer start when her question ends, and nothing begun over annai's own voice can answer the card: her own sound must never be taken for the user's.
- **Revisit when:** the user asks for it on headphones, where there is no echo: it needs a sure way to know that no sound of hers reaches the microphone.
- **Approved:** 2026-11-10, the user picked "Accept as known limitation (Recommended)". For the card that moves them: 2026-11-11, the user picked "Keep it, accept the misses".

### A tap on the card in the instant a spoken yes takes effect is sent as a line
- **Kind:** known limitation.
- **What the user sees:** the user says yes aloud to annai's card ("Carry on in <trip>?" or "Read <trip>?") and also taps its button (Open, or Allow) just as the yes takes effect, about 3 seconds after the word; or they tap a button just after a line they typed has already ended the card. The tap arrives after the card has ended, so it is sent as an ordinary line of theirs. After a yes to "Carry on in <trip>?", "Open" appears in that trip beside their copied line, and Shiori answers it there; after a typed line, or on the reading card, it is in the chat, and she may answer it or ask again. Nothing is lost and nothing else moves. A double tap on the button itself isn't affected: the first tap ends the buttons.
- **Why:** the card's buttons end at a tap, or when the tool's result is written, and not when the card itself ends. The window is from the yes taking effect (or the typed line) until then: for the move, the file moves and the copy, tens to a few hundred milliseconds. Ending the buttons from the card itself is a change to the code both cards share.
- **Revisit when:** a phone test or a user shows it happening, or the next change to the card's code.
- **Approved:** 2026-11-11, the user picked "Accept it as a known limitation".

### Someone else's "yes" within the 20 seconds answers annai's card
- **Kind:** known limitation.
- **What the user sees:** annai asks aloud "Read <trip>?" or "Carry on in <trip>?", and within the 20 seconds after the question a passenger, or a song, says "yes" (or another word on annai's list) loud enough to be heard as speech. The card takes it as the user's yes. Anything said within 3 seconds after the yes's words still takes it back, and a tap on Not now wins until the trip is read or opened. On "Read <trip>?" Shiori reads that trip, which changes nothing. On "Carry on in <trip>?" that trip opens, as on a real yes:
  - files the user handed over in that turn move to it (Undo, from either conversation, brings them back);
  - it gets the user's last line as theirs ("From <chat>"), her recap, and her answer, said aloud with voice on;
  - its row on Trips moves to now; if it is happening, play moves to it, and another happening trip's reminders wait until the user talks there;
  - the conversation they were in ends "Shiori moved this to <trip>.", and her turn there is let go, so they ask again.

  Back from that conversation goes to the screen before it (usually Trips), not to it; it is one tap away by "From <chat>" on the trip's first line. Back from Trips returns to Trips; from Details or Settings the screen doesn't move, but the open conversation is now the trip. Back undoes none of the changes above, and nothing is deleted. The other wrong yeses on this card ("A rising "Yes?"…", the late live transcript, classic voice's take-back after the 20 seconds) change the same.
- **Why:** the card judges the words the recogniser writes, by annai's own word list, and annai can't tell one voice from another ("Telling who is talking"). A tap only would end answering by voice; a stricter word list for moving would be more parts, for a rare miss that loses nothing.
- **Revisit when:** annai can tell the user's voice from another's, or the user meets it.
- **Approved:** for reading, 2026-11-05, the user picked "Yes, a strict word list (Recommended)", with "a passenger or song could grant, read-only" (the timeline design's decisions). For the card that moves them: 2026-11-11, the user picked "Keep it, accept the misses".

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
- **Kind:** deferred.
- **What the user sees:** Shiori moved a calendar to another trip, with the plan items made from its events, and the user taps Undo. If the page closes partway through Undo, the calendar can be back in the first trip while its events are still on the other trip's plan (or one event in each trip), and the other trip can remind for them. Undo is still offered, and a second tap finishes it.
- **Why:** the move itself is one transaction now, but Undo moves each file back along its own chain, one write at a time.
- **Revisit when:** the next version: the calendar's plan items move back with it.

### What follows a file's move is not part of the move
- **Kind:** deferred.
- **What the user sees:** if the page closes right after a file's move, or a write fails right after it, the file is in the new trip but Shiori there has not been told to read it, and the first conversation has no "moved" line (Undo, in the first conversation, still brings the file back; it shows there once she has written a line after the hand-over, before the user's next message). For a calendar that was waiting to be filed, its events are not planned yet either. After Open on annai's card that takes them into another trip, the same can happen when the page closes, or a write fails, between the files moving and the "moved" line in the conversation they were in: that trip doesn't open, its files are there but the user's last line and Shiori's recap are not, and the conversation may have no "moved" line. Each file moves in a write of its own, so with several files a failure partway leaves some moved and some not.
- **Why:** those steps are written by Shiori's own code after the move has been committed; only each file's move is one transaction, and where the files went, the "moved" line and the trip's copy of the line and recap are writes after it.
- **Revisit when:** the next version: a move's writes are one transaction.

### A page's end isn't kept when only the window's height changes
- **Kind:** known limitation.
- **What the user sees:** a page read to its end stays at its end when the phone is turned. When the window only gets shorter or taller (split screen, or a keyboard that resizes the window), the page stays where it was scrolled, which can be above its end; the user scrolls down again.
- **Why:** a browser tab's toolbar also changes the height as the user scrolls, and putting the page back then pinned it at its end against the user's own scroll. Only a change of width is surely a turn.
- **Revisit when:** the user meets it in split screen, or a way appears to tell a toolbar from a real resize.
- **Approved:** 2026-11-10, the user picked "Accept (Recommended)".

### A turn of the phone can put the page at its end when the user's last move wasn't a scroll the rule could read
- **Kind:** deferred.
- **What the user sees:** the page moves to its end when the phone is turned, though the user wasn't reading its end. Three ways there: with a page scrolled to its end, something opens below with no scroll (Archived trips on home), then the phone turns, and the page goes past what just opened; in a browser tab, a short drag up from the end while the toolbar shows, then a turn with no other scroll; and possibly (not verified on a phone) a scroll with the iPhone's keyboard up, then a turn. A scroll in between prevents the first, and Shiori speaking or the dock changing no longer moves the page at all.
- **Why:** when the phone turns, the page is already at its new size, so whether the user was at its end can't be read then and is remembered from their last scroll. A fold opened since is not a scroll, and a scroll that arrives at a new window height before that height's resize is skipped as the browser's own.
- **Revisit when:** the next version: skip a scroll only while a turn's resize is still to come (the width differs), read every other one, and let the remembered fact follow the page's height. It needs the WebKit turn test before it ships.

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
- **Kind:** deferred.
- **What the user sees:** two rare cases when the user opens another conversation while Shiori works on something they asked. In one reply she says something, runs a tool, and has more to say after it, and the open comes during the tool: the rest is never said, on coming back either, and no "picks it up" line shows (none of 320 requests in the real-model runs had a reply with two spoken lines). Or she has already answered, and the open comes while a later step of the same turn writes her notes: the conversation left says "Shiori was in the middle of something. She picks it up when you come back.", and on coming back she takes the turn up, an extra turn that may say her answer again. Both need a reply that ends in her sleep. One more shape of the same rule: she asks a question, the user answers it, and the same reply goes on to work and then sleeps: an open during that work drops the rest, and nothing is taken up.
- **Why:** whether a cut turn still owes the user is decided for her whole reply (did anything in it reach them, and was its last call the one waiting on them), not for each call in it.
- **Revisit when:** the next version: decide by each call: a cut call other than her sleep leaves the turn owed, and so does a cut hand-off between her halves. Taken by the call's name alone, that also takes up her notes written after an answer in the same reply (which isn't owed today), and still takes up the notes of a later step; telling those from the work after the user's answer needs the rule to know whether the user's words came after her last line to them, to be chosen first.

### Her turns start a little later in a chat she named, as its files grow
- **Kind:** deferred.
- **What the user sees:** nothing noticeable so far. In a conversation with no dates whose name or details Shiori changed last, each of her turns, and Koe's, begins by reading the conversation's whole history of file changes to find who gave it its name. That took 0.3 ms at 108 file changes, 3.7 ms at 2,023 and 24.5 ms at 10,053, on the test store; a phone's storage wasn't measured.
- **Why:** who named it is worked out again at every turn rather than kept, and at those sizes it is small next to a model's answer. Koe's turns don't use the answer.
- **Revisit when:** a phone's Trace or a real-model run shows her turns starting slowly in such a conversation: keep the answer per conversation, and skip it for Koe.

### A reminder set across a change of summer time can come an hour off what she said
- **Kind:** deferred.
- **What the user sees:** the user asks for a reminder on a date after the clocks change (in November, for March 19, say), and Shiori writes it with today's offset instead of that date's (-08:00 where March 19 is -07:00). Both her halves then say the time as written, "6 PM", and the reminder comes at 7 PM local time. Before this release Koe gave the time in the phone's zone, which showed the mistake, if confusingly. It needs the model to get the offset wrong; in the one real run of it, the model got it right.
- **Why:** both halves now read one set of words for a reminder's time, made from the offset she wrote, and nothing checks that offset against the zone's on that date.
- **Revisit when:** the next version: when the written offset doesn't match the conversation's zone at that moment, setting the reminder gives her the time in that zone too, so she sees her own mistake.

### Shiori on her own can't see what the user answered Koe
- **Kind:** deferred.
- **What the user sees:** with her two halves, Koe asks something ("What can I do?") and the user answers aloud ("When is check-in?"); Koe passes it to Kokoro, and another conversation is opened while she works. Then the user empties Koe in Models, so Shiori is one again, and comes back: she takes the turn up, but their question isn't among what she reads, so she may not answer it. The same for a tap on Koe's card, or a line typed while Koe waits.
- **Why:** answers to Koe's own questions are kept with Koe's calls, which Shiori on her own doesn't read.
- **Revisit when:** the next version: Shiori on her own reads Koe's notes and the user's answers to Koe, as Kokoro does.
